import { CFTC_HISTORY_WINDOWS, CFTC_SCHEMA_VERSION, cftcDate, cftcGroup, isCftcContractCode, isCftcFamily } from '../../../../../utils/cftc.js';
import { isCftcEnabled } from '../../../../../utils/cftcFeature.js';
import { CFTC_CACHE_NAMESPACE, isCftcPublicReportDate, loadCftcHistory } from '../../../../../utils/cftcServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from '../../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Schema-Version, X-Report-Date, X-Cache-Source, X-Data-Stale, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-RateLimit-Remaining, Retry-After, Link', 'X-Schema-Version': CFTC_SCHEMA_VERSION };

function readRequest(url) {
  const params = new URL(url).searchParams;
  for (const key of params.keys()) {
    if (!['family', 'contract', 'group', 'date', 'window'].includes(key)) throw Object.assign(new Error(`Unknown query parameter: ${key}`), { status: 400, code: 'UNKNOWN_QUERY_PARAMETER' });
    if (params.getAll(key).length > 1) throw Object.assign(new Error(`Query parameter may appear only once: ${key}`), { status: 400, code: 'DUPLICATE_QUERY_PARAMETER' });
  }
  const family = params.get('family') || 'tff', code = (params.get('contract') || '').toUpperCase(), group = params.get('group') || (family === 'tff' ? 'leveraged-funds' : 'managed-money'), reportDate = params.get('date') || 'latest', window = params.get('window') || '5y';
  if (!isCftcFamily(family)) throw Object.assign(new Error('Use family=tff or family=disaggregated.'), { status: 400, code: 'INVALID_REPORT_FAMILY' });
  if (!isCftcContractCode(code)) throw Object.assign(new Error('Use a verified CFTC contract code.'), { status: 400, code: 'INVALID_CONTRACT' });
  if (!cftcGroup(family, group)) throw Object.assign(new Error('Use a trader group from the selected report family.'), { status: 400, code: 'INVALID_TRADER_GROUP' });
  if (reportDate !== 'latest' && (cftcDate(reportDate) !== reportDate || !isCftcPublicReportDate(reportDate))) throw Object.assign(new Error('Use date=latest or a YYYY-MM-DD date within the retained six-year CFTC range.'), { status: 400, code: 'INVALID_REPORT_DATE' });
  if (!Object.hasOwn(CFTC_HISTORY_WINDOWS, window)) throw Object.assign(new Error('Use window=1y, 3y, or 5y.'), { status: 400, code: 'INVALID_HISTORY_WINDOW' });
  return { family, code, group, reportDate, window };
}

export async function GET(request) {
  if (!isCftcEnabled()) return Response.json({ schema_version: CFTC_SCHEMA_VERSION, status: 'disabled', error: 'CFTC positioning is disabled for provider-free rollback.', code: 'CFTC_DISABLED', retryable: false }, { status: 503, headers: { ...CORS, 'Cache-Control': 'private, no-store' } });
  const limit = await checkRateLimit({ key: `rl:cftc-history:${CFTC_CACHE_NAMESPACE}:${getClientIp(request)}`, windowMs: 10 * 60_000, max: 40, cost: 2 });
  if (!limit.allowed) return rateLimitedResponse(limit, CORS);
  try {
    const result = await loadCftcHistory({ ...readRequest(request.url), signal: request.signal });
    const degraded = result.status !== 'ready' || result.freshness.source_currency === 'aged' || String(result.freshness.cache_status).startsWith('stale');
    return Response.json(result, { headers: { ...CORS, ...rateLimitHeaders(limit), 'Cache-Control': degraded ? 'public, max-age=0, s-maxage=60' : 'public, max-age=300, s-maxage=14400, stale-while-revalidate=3600', 'X-Schema-Version': CFTC_SCHEMA_VERSION, 'X-Report-Date': result.selected.reportDate, 'X-Cache-Source': result.freshness.cache_status, 'X-Data-Stale': degraded ? '1' : '0', Link: '</schemas/cftc-history-v1.schema.json>; rel="describedby"; type="application/schema+json"' } });
  } catch (error) {
    return Response.json({ schema_version: CFTC_SCHEMA_VERSION, error: error.message || 'CFTC history is temporarily unavailable.', code: error.code || 'CFTC_UNAVAILABLE', retryable: !error.status || error.status >= 500 }, { status: error.status || 503, headers: { ...CORS, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store', ...(error.retryAfter ? { 'Retry-After': String(Math.ceil(error.retryAfter / 1000)) } : {}) } });
  }
}

export function OPTIONS() { return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
