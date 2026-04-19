/**
 * SEC EDGAR proxy — Next.js route handler.
 *
 * The browser cannot call SEC.gov directly because:
 *   (1) SEC requires a descriptive User-Agent header identifying the requester.
 *       Browsers don't let JavaScript override this header.
 *   (2) SEC doesn't send CORS headers, so cross-origin browser requests are blocked.
 *
 * This function runs on Vercel's Node runtime and acts as a server-side proxy:
 *   - Client calls /api/sec?path=/submissions/CIK0001318605.json
 *   - Server forwards to data.sec.gov/submissions/CIK0001318605.json with proper UA
 *   - Response is cached for 1 hour to reduce load on SEC servers.
 *
 * Two endpoints are supported:
 *   /api/sec?host=data&path=/submissions/CIK...   -> data.sec.gov
 *   /api/sec?host=www&path=/files/company_tickers.json -> www.sec.gov
 *
 * In-memory rate limiting protects against a single abusive client eating our
 * global SEC quota. For a production-hardened setup you'd move this to a
 * durable store like Upstash Redis, but in-memory is sufficient at this scale.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEC_USER_AGENT = process.env.SEC_USER_AGENT;

// ---------- In-memory rate limiter ----------
// Keyed by client IP. Resets every minute. Tuned to stay well under SEC's 10 req/sec.
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 60 }; // 60 req/min per IP = 1 rps avg, bursts allowed
const buckets = new Map();

function checkRate(ip) {
  const now = Date.now();
  const bucket = buckets.get(ip) || { count: 0, resetAt: now + RATE_LIMIT.windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT.windowMs;
  }
  bucket.count += 1;
  buckets.set(ip, bucket);
  return bucket.count <= RATE_LIMIT.maxRequests;
}

// Clean up stale buckets occasionally so the Map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now > b.resetAt + 60_000) buckets.delete(ip);
}, 300_000).unref?.();

// ---------- Main handler ----------
export async function GET(request) {
  if (!SEC_USER_AGENT) {
    return Response.json(
      { error: 'Server misconfigured: SEC_USER_AGENT environment variable is not set.' },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(request.url);
  const host = searchParams.get('host') || 'data';
  const path = searchParams.get('path') || '';

  if (!path || typeof path !== 'string') {
    return Response.json({ error: 'Missing "path" query parameter.' }, { status: 400 });
  }

  // Whitelist host options
  const hostMap = { data: 'https://data.sec.gov', www: 'https://www.sec.gov' };
  const baseUrl = hostMap[host];
  if (!baseUrl) {
    return Response.json({ error: 'Invalid "host". Must be "data" or "www".' }, { status: 400 });
  }

  // Sanitize path — only allow SEC-style paths, no traversal or query injection beyond ? params
  if (!/^\/[\w./\-]+(\?[\w=&.\-]+)?$/.test(path)) {
    return Response.json({ error: 'Invalid path format.' }, { status: 400 });
  }

  // Rate limit per IP
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';
  if (!checkRate(ip)) {
    return Response.json(
      { error: 'Rate limit exceeded. Please wait a minute before retrying.' },
      { status: 429 }
    );
  }

  const targetUrl = baseUrl + path;

  try {
    const secRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': SEC_USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate',
        Host: new URL(baseUrl).host,
      },
    });

    if (!secRes.ok) {
      return Response.json(
        { error: `SEC returned ${secRes.status}`, path },
        { status: secRes.status }
      );
    }

    const body = await secRes.text();

    // Cache aggressively — filings and financial facts change at most once a day per company.
    // 1 hour client cache, 6 hour CDN cache, 24 hour stale-while-revalidate.
    return new Response(body, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400',
        'Content-Type': secRes.headers.get('content-type') || 'application/json',
      },
    });
  } catch (err) {
    return Response.json(
      { error: `Upstream fetch failed: ${err.message}` },
      { status: 502 }
    );
  }
}
