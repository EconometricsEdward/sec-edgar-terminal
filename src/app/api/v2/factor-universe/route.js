import { FUNDAMENTAL_UNIVERSE_CACHE, readUniverseSnapshot } from '../../../../utils/marketUniverseServer.js';
import { UNIVERSE_VERSION, UNIVERSE_METHOD } from '../../../../utils/marketUniverse.js';
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Schema-Version, X-Methodology-Version, X-SEC-Snapshot-At, X-Cache-Source, X-Data-Stale, Retry-After, Link' };
export const factorUniverseRateLimitKey = ip => `rl:fundamental-universe-v2:${FUNDAMENTAL_UNIVERSE_CACHE}:${ip}`;

export async function GET(request) {
  const limit = await checkRateLimit({ key: factorUniverseRateLimitKey(getClientIp(request)), windowMs: 600000, max: 120, cost: 1 });
  if (!limit.allowed) return rateLimitedResponse(limit, cors);
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== 'basis') || params.getAll('basis').length > 1 || params.has('basis') && !['ttm', 'annual'].includes(params.get('basis'))) throw Object.assign(new Error('Use only basis=ttm or basis=annual, once.'), { status: 400, code: 'INVALID_QUERY' });
    const result = await readUniverseSnapshot(params.get('basis') || 'ttm');
    const stale = result.status === 'stale';
    return Response.json(result, { headers: { ...cors, ...rateLimitHeaders(limit), 'Cache-Control': stale ? 'public, max-age=0, s-maxage=60, stale-if-error=86400' : result.status === 'ready' ? 'public, max-age=60, s-maxage=900, stale-while-revalidate=300' : 'public, max-age=0, s-maxage=60', 'X-Schema-Version': UNIVERSE_VERSION, 'X-Methodology-Version': UNIVERSE_METHOD, 'X-SEC-Snapshot-At': result.sec_snapshot_at, 'X-Cache-Source': result.cache_status, 'X-Data-Stale': stale ? '1' : '0', Link: '</schemas/factor-universe-v2.schema.json>; rel="describedby"; type="application/schema+json"' } });
  } catch (error) {
    return Response.json({ schema_version: UNIVERSE_VERSION, error: error.message, code: error.code || 'FUNDAMENTAL_UNIVERSE_UNAVAILABLE', retryable: error.status !== 400 }, { status: error.status || 503, headers: { ...cors, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store', ...(error.status !== 400 ? { 'Retry-After': '300' } : {}) } });
  }
}
export function OPTIONS() { return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
