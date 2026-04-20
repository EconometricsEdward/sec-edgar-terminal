/**
 * Serverless-safe rate limiter.
 *
 * Problem: the previous `const buckets = new Map()` pattern does NOT work on
 * serverless. Each function instance has its own Map; an abuser hitting warm
 * instance A and instance B effectively gets two quotas. Instances also die
 * and respawn, so the limiter resets unpredictably. Worse, Map.set never
 * evicts on its own, so a long-lived instance can leak memory.
 *
 * Solution: use Vercel KV (Upstash Redis under the hood) as the shared
 * counter store. The REST API has sub-10ms latency from Vercel Functions
 * and its free tier covers 10k commands/day.
 *
 * If KV env vars are missing (e.g. local dev without KV set up), we fall
 * back to the in-memory behavior with a one-time warning — this keeps
 * local dev working without setup.
 *
 * The REST path uses atomic INCR + EXPIRE. The fallback path is best-effort
 * and clearly labeled.
 */

// Support both Vercel KV's native naming and direct Upstash naming.
// Whichever is set in the environment will be used.
const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ENABLED = !!(REST_URL && REST_TOKEN);

let warnedAboutFallback = false;
function warnFallbackOnce() {
  if (warnedAboutFallback) return;
  warnedAboutFallback = true;
  console.warn(
    '[rateLimit] KV/Upstash env vars not set — using in-memory fallback. ' +
    'Rate limits will NOT be enforced correctly across serverless instances. ' +
    'Set KV_REST_API_URL/TOKEN (or UPSTASH_REDIS_REST_URL/TOKEN) for production.'
  );
}

// ---------- In-memory fallback (dev only) ----------
const localBuckets = new Map();
function localCheck(key, windowMs, max) {
  const now = Date.now();
  let b = localBuckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    localBuckets.set(key, b);
  }
  b.count += 1;
  // Opportunistic cleanup: every ~100 checks, purge expired buckets.
  // (Avoids setInterval, which is unreliable on serverless.)
  if (Math.random() < 0.01) {
    for (const [k, v] of localBuckets) {
      if (now > v.resetAt + windowMs) localBuckets.delete(k);
    }
  }
  return {
    allowed: b.count <= max,
    remaining: Math.max(0, max - b.count),
    resetAt: b.resetAt,
  };
}

// ---------- Upstash REST path ----------
async function remoteCheck(key, windowMs, max) {
  // Fixed window using INCR + conditional EXPIRE. Good enough for our
  // protection goals and avoids sorted-set complexity.
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));

  // Pipeline: INCR then EXPIRE (NX = only set TTL if no TTL exists).
  // Two commands, one round trip.
  const res = await fetch(`${REST_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, windowSec, 'NX'],
    ]),
    // Don't hang forever if KV is having a bad day — fail open.
    signal: AbortSignal.timeout(2000),
  });

  if (!res.ok) throw new Error(`KV HTTP ${res.status}`);
  const results = await res.json();
  // Pipeline response: [{ result: <value> }, { result: <value> }]
  const count = Number(results?.[0]?.result ?? 0);
  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    // We don't know exact reset without another round trip; approximate.
    resetAt: Date.now() + windowMs,
  };
}

/**
 * Check and increment a rate limit counter.
 *
 * Fail-open: on KV errors we allow the request through but log the issue.
 * This prevents a KV outage from taking the whole app down, at the cost
 * of temporarily disabling rate limiting. For most abuse patterns this
 * is the right tradeoff.
 */
export async function checkRateLimit({ key, windowMs, max }) {
  if (!ENABLED) {
    warnFallbackOnce();
    return localCheck(key, windowMs, max);
  }

  try {
    return await remoteCheck(key, windowMs, max);
  } catch (err) {
    console.warn(`[rateLimit] remote check failed, failing open: ${err.message}`);
    return { allowed: true, remaining: max, resetAt: Date.now() + windowMs };
  }
}

/**
 * Extract the client IP from a Next.js request. Handles Vercel's proxy headers.
 */
export function getClientIp(request) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

/**
 * Convenience helper: build a 429 response with proper headers.
 */
export function rateLimitedResponse(info) {
  return Response.json(
    { error: 'Rate limit exceeded. Please wait a moment before retrying.' },
    {
      status: 429,
      headers: {
        'Retry-After': String(Math.max(1, Math.ceil((info.resetAt - Date.now()) / 1000))),
        'X-RateLimit-Remaining': String(info.remaining),
      },
    }
  );
}
