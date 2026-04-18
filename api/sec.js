/**
 * SEC EDGAR proxy — Vercel serverless function.
 *
 * The browser cannot call SEC.gov directly because:
 *   (1) SEC requires a descriptive User-Agent header identifying the requester.
 *       Browsers don't let JavaScript override this header.
 *   (2) SEC doesn't send CORS headers, so cross-origin browser requests are blocked.
 *
 * This function runs on Vercel's edge and acts as a server-side proxy:
 *   - Client calls /api/sec?path=/submissions/CIK0001318605.json
 *   - Server forwards to data.sec.gov/submissions/CIK0001318605.json with proper UA
 *   - Response is cached for 1 hour to reduce load on SEC servers.
 *
 * Two endpoints are supported:
 *   /api/sec?host=data&path=/submissions/CIK...   -> data.sec.gov
 *   /api/sec?host=www&path=/files/company_tickers.json -> www.sec.gov
 *
 * In-memory rate limiting is included to protect against a single abusive client
 * eating our global SEC quota. For a production-hardened setup you'd move this to
 * a durable store like Upstash Redis, but in-memory is sufficient at this scale.
 */

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
export default async function handler(req, res) {
  if (!SEC_USER_AGENT) {
    return res.status(500).json({
      error: 'Server misconfigured: SEC_USER_AGENT environment variable is not set.',
    });
  }

  const { host = 'data', path = '' } = req.query;
  if (!path || typeof path !== 'string') {
    return res.status(400).json({ error: 'Missing "path" query parameter.' });
  }

  // Whitelist host options
  const hostMap = { data: 'https://data.sec.gov', www: 'https://www.sec.gov' };
  const baseUrl = hostMap[host];
  if (!baseUrl) {
    return res.status(400).json({ error: 'Invalid "host". Must be "data" or "www".' });
  }

  // Sanitize path — only allow SEC-style paths, no traversal or query injection beyond ? params
  if (!/^\/[\w./\-]+(\?[\w=&.\-]+)?$/.test(path)) {
    return res.status(400).json({ error: 'Invalid path format.' });
  }

  // Rate limit per IP
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    'unknown';
  if (!checkRate(ip)) {
    return res.status(429).json({
      error: 'Rate limit exceeded. Please wait a minute before retrying.',
    });
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
      return res.status(secRes.status).json({
        error: `SEC returned ${secRes.status}`,
        path,
      });
    }

    const body = await secRes.text();

    // Cache aggressively — filings and financial facts change at most once a day per company.
    // 1 hour client cache, 6 hour CDN cache, 24 hour stale-while-revalidate.
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400');
    res.setHeader('Content-Type', secRes.headers.get('content-type') || 'application/json');
    return res.status(200).send(body);
  } catch (err) {
    return res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
  }
}
