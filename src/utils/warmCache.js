/**
 * Warm cache — shared key/value storage in Vercel KV (Upstash under the hood).
 *
 * This is what the pre-warmer writes to, and what the API routes read from
 * when the CDN cache misses. The layering is:
 *
 *   Request -> Vercel edge CDN (60s-24h) -> API route -> warm cache (Vercel KV)
 *                                                    -> upstream (SEC/Yahoo/etc)
 *
 * The CDN is the fastest layer and handles the bulk of traffic for popular
 * tickers. The warm cache catches cold-CDN requests (e.g. after expiry, or
 * for a brand-new ticker that was just added to the popular list) and keeps
 * them from having to hit upstream.
 *
 * Keys are namespaced: `warm:<type>:<ticker>` so multiple data types for the
 * same ticker don't collide.
 *
 * Vercel KV env vars — Vercel KV is Upstash Redis with Vercel-branded env var
 * names. We support both naming schemes so this code works whether you:
 *   - Use Vercel KV (which injects KV_REST_API_URL / KV_REST_API_TOKEN)
 *   - Use direct Upstash (which uses UPSTASH_REDIS_REST_URL / _TOKEN)
 *
 * If neither is set, reads return null and writes are swallowed — API routes
 * keep working, we just lose the warm layer.
 */

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ENABLED = !!(REST_URL && REST_TOKEN);

function key(type, id) {
  return `warm:${type}:${String(id).toUpperCase()}`;
}

/**
 * Read a value from the warm cache. Returns parsed JSON or null on miss/error.
 */
export async function warmGet(type, id) {
  if (!ENABLED) return null;
  try {
    const res = await fetch(`${REST_URL}/get/${encodeURIComponent(key(type, id))}`, {
      headers: { Authorization: `Bearer ${REST_TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.result;
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // If it doesn't parse, it's corrupt — treat as miss.
      return null;
    }
  } catch (err) {
    // Fail-open: cache miss on any error. API route will fall through to upstream.
    console.warn(`[warmCache] read failed for ${type}/${id}: ${err.message}`);
    return null;
  }
}

/**
 * Write a value to the warm cache with a TTL.
 *
 * Default TTL is 25 hours — slightly longer than the daily cron interval so
 * there's always overlap: the new cron run writes fresh values before the
 * old ones expire, avoiding "dead windows" where readers would see misses.
 *
 * When the project upgrades to Pro + 6-hour crons, callers can override
 * this to a shorter TTL if desired, but 25h still works fine — the values
 * just get refreshed more often than they expire.
 */
export async function warmSet(type, id, value, ttlSeconds = 25 * 3600) {
  if (!ENABLED) return false;
  try {
    const body = JSON.stringify(value);
    // Size sanity check — KV REST has a ~1MB per-value limit. Anything big
    // is probably a bug (or needs a different caching strategy). Skip
    // rather than fail the whole pre-warm run.
    if (body.length > 900_000) {
      console.warn(
        `[warmCache] skipping ${type}/${id}: payload ${body.length} bytes exceeds 900KB limit`
      );
      return false;
    }

    const url = `${REST_URL}/set/${encodeURIComponent(key(type, id))}?EX=${ttlSeconds}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err) {
    console.warn(`[warmCache] write failed for ${type}/${id}: ${err.message}`);
    return false;
  }
}

/**
 * Check if warm cache is wired up — useful for health checks / debug endpoints.
 */
export function warmCacheEnabled() {
  return ENABLED;
}
