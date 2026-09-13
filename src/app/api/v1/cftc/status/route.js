import { CFTC_SCHEMA_VERSION } from '../../../../../utils/cftc.js';
import { isCftcEnabled } from '../../../../../utils/cftcFeature.js';
import { CFTC_CACHE_NAMESPACE, readCftcCacheStatus } from '../../../../../utils/cftcServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from '../../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const commonHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Schema-Version, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-RateLimit-Remaining, Retry-After', 'X-Schema-Version': CFTC_SCHEMA_VERSION };

export async function GET(request) {
  if (!isCftcEnabled()) return Response.json({ schema_version: CFTC_SCHEMA_VERSION, status: 'disabled', checked_at: new Date().toISOString(), families: [], error: 'CFTC positioning is disabled for provider-free rollback.', code: 'CFTC_DISABLED', retryable: false }, { status: 503, headers: { ...commonHeaders, 'Cache-Control': 'private, no-store' } });
  const limit = await checkRateLimit({ key: `rl:cftc-status:${CFTC_CACHE_NAMESPACE}:${getClientIp(request)}`, windowMs: 10 * 60_000, max: 120 });
  if (!limit.allowed) return rateLimitedResponse(limit, commonHeaders);
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].length) {
      return Response.json({ schema_version: CFTC_SCHEMA_VERSION, error: 'The CFTC status route does not accept query parameters.', code: 'UNKNOWN_QUERY_PARAMETER', retryable: false }, { status: 400, headers: { ...commonHeaders, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store' } });
    }
    const result = await readCftcCacheStatus();
    const usable = ['ready', 'degraded'].includes(result.status);
    return Response.json(result, { status: usable ? 200 : 503, headers: { ...commonHeaders, ...rateLimitHeaders(limit), 'Cache-Control': usable ? 'public, max-age=0, s-maxage=30, stale-while-revalidate=30' : 'private, no-store' } });
  } catch (error) {
    return Response.json({ schema_version: CFTC_SCHEMA_VERSION, status: 'unavailable', checked_at: new Date().toISOString(), families: [], error: error.message || 'CFTC cache status is unavailable.' }, { status: 503, headers: { ...commonHeaders, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store' } });
  }
}

export function OPTIONS() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
