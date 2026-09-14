import { CFTC_CONCENTRATION_SCHEMA_VERSION } from '../../../../../utils/cftcConcentration.js';
import { loadCftcConcentration, validateConcentrationRequest } from '../../../../../utils/cftcConcentrationServer.js';
import { isCftcEnabled } from '../../../../../utils/cftcFeature.js';
import { CFTC_CACHE_NAMESPACE } from '../../../../../utils/cftcServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from '../../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Schema-Version, X-Report-Date, X-Cache-Source, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-RateLimit-Remaining, Retry-After', 'X-Schema-Version': CFTC_CONCENTRATION_SCHEMA_VERSION };

function readRequest(url) {
  const params = new URL(url).searchParams;
  for (const key of params.keys()) {
    if (!['family', 'contract', 'date'].includes(key)) throw Object.assign(new Error(`Unknown query parameter: ${key}`), { status: 400, code: 'UNKNOWN_QUERY_PARAMETER' });
    if (params.getAll(key).length > 1) throw Object.assign(new Error(`Query parameter may appear only once: ${key}`), { status: 400, code: 'DUPLICATE_QUERY_PARAMETER' });
  }
  return validateConcentrationRequest({ family: params.get('family'), code: (params.get('contract') || '').toUpperCase(), reportDate: params.get('date') });
}

export async function GET(request) {
  if (!isCftcEnabled()) return Response.json({ schema_version: CFTC_CONCENTRATION_SCHEMA_VERSION, status: 'disabled', error: 'CFTC data is currently disabled.', code: 'CFTC_DISABLED', retryable: false }, { status: 503, headers: { ...CORS, 'Cache-Control': 'private, no-store' } });
  const limit = await checkRateLimit({ key: `rl:cftc-concentration:${CFTC_CACHE_NAMESPACE}:${getClientIp(request)}`, windowMs: 10 * 60_000, max: 40, cost: 2 });
  if (!limit.allowed) return rateLimitedResponse(limit, CORS);
  try {
    const result = await loadCftcConcentration({ ...readRequest(request.url), signal: request.signal });
    return Response.json(result, { headers: { ...CORS, ...rateLimitHeaders(limit), 'Cache-Control': result.status === 'ready' ? 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600' : 'public, max-age=0, s-maxage=60', 'X-Report-Date': result.report_date, 'X-Cache-Source': result.freshness.cache_status } });
  } catch (error) {
    return Response.json({ schema_version: CFTC_CONCENTRATION_SCHEMA_VERSION, error: error.status ? error.message : 'CFTC concentration is temporarily unavailable.', code: error.code || 'CFTC_CONCENTRATION_UNAVAILABLE', retryable: !error.status || error.status >= 500 }, { status: error.status || 503, headers: { ...CORS, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store', ...(error.retryAfter ? { 'Retry-After': String(Math.ceil(error.retryAfter / 1000)) } : {}) } });
  }
}

export function OPTIONS() { return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
