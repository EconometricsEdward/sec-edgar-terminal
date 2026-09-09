/**
 * SEC EDGAR proxy — Next.js route handler.
 *
 * Request flow with all caching layers:
 *
 *   User request
 *     → Vercel edge CDN (Cache-Control, 6h)
 *     → this function
 *       → warm cache (Upstash, populated by /api/cron/prewarm)
 *       → upstream data.sec.gov / www.sec.gov
 *
 * The browser cannot call SEC.gov directly because:
 *   (1) SEC requires a descriptive User-Agent header identifying the requester.
 *       Browsers don't let JavaScript override this header.
 *   (2) SEC doesn't send CORS headers, so cross-origin browser requests are blocked.
 *
 * Rate limiting is done via shared Upstash Redis so it works correctly across
 * serverless instances (the old in-memory Map pattern was per-instance and
 * easily bypassed — see utils/rateLimit.js).
 */

import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';
import { warmGet, warmSet } from '../../../utils/warmCache.js';
import { isValidSecUserAgent, secFetch } from '../../../utils/secClient.js';

export const runtime = 'nodejs';

const SEC_USER_AGENT = process.env.SEC_USER_AGENT;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;

function cacheControlFor(host, path) {
  if (host === 'www' && /^\/files\/company_tickers(?:_mf)?\.json$/.test(path)) {
    return 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800';
  }
  return 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400, stale-if-error=604800';
}

/**
 * Extract CIK from a submissions-style path. Returns null if not a submissions
 * request, so we know whether the warm cache might have a hit.
 *
 * Examples that match: "/submissions/CIK0000320193.json"
 * Example that doesn't: "/files/company_tickers.json"
 */
function extractSubmissionsCik(path) {
  const m = path.match(/^\/submissions\/CIK(\d{10})\.json$/);
  return m ? m[1] : null;
}

export async function GET(request) {
  if (!isValidSecUserAgent(SEC_USER_AGENT)) {
    return Response.json(
      { error: 'Server misconfigured: SEC_USER_AGENT must include valid contact information.' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  const { searchParams } = new URL(request.url);
  const host = searchParams.get('host') || 'data';
  const path = searchParams.get('path') || '';

  if (!path || typeof path !== 'string') {
    return Response.json({ error: 'Missing "path" query parameter.' }, { status: 400 });
  }

  const hostMap = { data: 'https://data.sec.gov', www: 'https://www.sec.gov' };
  const baseUrl = hostMap[host];
  if (!baseUrl) {
    return Response.json({ error: 'Invalid "host". Must be "data" or "www".' }, { status: 400 });
  }

  if (!/^\/[\w./\-]+(\?[\w=&.\-]+)?$/.test(path)) {
    return Response.json({ error: 'Invalid path format.' }, { status: 400 });
  }

  const ip = getClientIp(request);
  const limit = await checkRateLimit({
    key: `rl:sec:${ip}`,
    windowMs: RATE_WINDOW_MS,
    max: RATE_MAX,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);

  // ------- Warm cache check (only for paths we actually pre-warm) ----------
  // The pre-warmer stores submissions by CIK under 'submissions-cik:<CIK>'.
  // If this request is a submissions lookup and we have a warm hit, we skip
  // the SEC call entirely — big win during rate-limit-tight moments.
  const cik = host === 'data' ? extractSubmissionsCik(path) : null;
  const cacheControl = cacheControlFor(host, path);
  if (cik) {
    const warm = await warmGet('submissions-cik', cik);
    if (warm) {
      return Response.json(warm, {
        headers: {
          'Cache-Control': cacheControl,
          'X-Cache-Source': 'warm',
        },
      });
    }
  }

  // ------- Fall through to upstream ----------------------------------------
  const targetUrl = baseUrl + path;

  try {
    const secRes = await secFetch(targetUrl, {
      headers: {
        'User-Agent': SEC_USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate',
      },
      signal: request.signal,
      timeoutMs: 10_000,
      retries: 2,
    });

    if (!secRes.ok) {
      return Response.json(
        { error: `SEC returned ${secRes.status}`, path },
        {
          status: secRes.status,
          headers: {
            'Cache-Control': 'private, no-store',
            ...(secRes.headers.get('retry-after')
              ? { 'Retry-After': secRes.headers.get('retry-after') }
              : {}),
          },
        }
      );
    }

    const body = await secRes.text();
    if (cik) {
      try {
        await warmSet('submissions-cik', cik, JSON.parse(body), 25 * 3600);
      } catch {
        // A malformed payload must never be written over a good cache entry.
      }
    }

    return new Response(body, {
      status: 200,
      headers: {
        'Cache-Control': cacheControl,
        'Content-Type': secRes.headers.get('content-type') || 'application/json',
        'X-Cache-Source': 'upstream',
      },
    });
  } catch (err) {
    return Response.json(
      { error: `Upstream fetch failed: ${err.message}` },
      { status: err.status || 502, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
}
