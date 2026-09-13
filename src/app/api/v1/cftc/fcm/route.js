import { CFTC_FCM_SCHEMA_VERSION, CftcFcmError } from '../../../../../utils/cftcFcm.js';
import { CFTC_FCM_CACHE_NAMESPACE, loadCftcFcm } from '../../../../../utils/cftcFcmServer.js';
import { isCftcEnabled } from '../../../../../utils/cftcFeature.js';
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from '../../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Schema-Version, X-Report-Date, X-Cache-Source, X-Data-Stale, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After', 'X-Schema-Version': CFTC_FCM_SCHEMA_VERSION };

export function readFcmSelection(url) {
  const params = new URL(url).searchParams;
  for (const key of params.keys()) {
    if (key !== 'entity') throw new CftcFcmError(`Unknown query parameter: ${key}`, { code: 'UNKNOWN_QUERY_PARAMETER', status: 400 });
    if (params.getAll(key).length > 1) throw new CftcFcmError(`Query parameter may appear only once: ${key}`, { code: 'DUPLICATE_QUERY_PARAMETER', status: 400 });
  }
  const entity = params.get('entity');
  if (entity != null && !/^fcm-[a-f0-9]{24}$/.test(entity)) throw new CftcFcmError('Choose an entity identifier published by this CFTC FCM endpoint.', { code: 'INVALID_FCM_ENTITY', status: 400 });
  return entity;
}

export async function GET(request) {
  if (!isCftcEnabled()) return Response.json({ schema_version: CFTC_FCM_SCHEMA_VERSION, status: 'disabled', error: 'CFTC data is currently disabled.', code: 'CFTC_DISABLED', retryable: false }, { status: 503, headers: { ...CORS, 'Cache-Control': 'private, no-store' } });
  const limit = await checkRateLimit({ key: `rl:cftc-fcm:${CFTC_FCM_CACHE_NAMESPACE}:${getClientIp(request)}`, windowMs: 10 * 60_000, max: 60 });
  if (!limit.allowed) return rateLimitedResponse(limit, CORS);
  try {
    const entity = readFcmSelection(request.url), snapshot = await loadCftcFcm({ signal: request.signal });
    const firms = entity ? snapshot.firms.filter(firm => firm.id === entity) : snapshot.firms;
    if (!firms.length) throw new CftcFcmError('The selected legal entity is not present in the latest CFTC FCM report.', { code: 'FCM_ENTITY_NOT_FOUND', status: 404 });
    const result = { ...snapshot, firms }, degraded = result.status !== 'ready';
    return Response.json(result, { headers: {
      ...CORS, ...rateLimitHeaders(limit),
      'Cache-Control': degraded ? 'public, max-age=0, s-maxage=60' : 'public, max-age=300, s-maxage=3600, stale-while-revalidate=300',
      'X-Report-Date': result.reportDate, 'X-Cache-Source': result.freshness.cacheStatus, 'X-Data-Stale': degraded ? '1' : '0',
    } });
  } catch (error) {
    const status = error.status || 503;
    return Response.json({ schema_version: CFTC_FCM_SCHEMA_VERSION, status: 'unavailable', error: error.message || 'CFTC FCM financial data is temporarily unavailable.', code: error.code || 'CFTC_FCM_UNAVAILABLE', retryable: status >= 500 }, { status, headers: { ...CORS, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store', ...(status >= 500 ? { 'Retry-After': '60' } : {}) } });
  }
}

export function OPTIONS() { return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
