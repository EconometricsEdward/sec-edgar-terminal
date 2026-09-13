import { COMPANY_CFTC_SCHEMA_VERSION, parseCompanyCftcRequest } from '../../../../../utils/companyCftc.js';
import { COMPANY_CFTC_CACHE_NAMESPACE, loadCompanyCftcContext } from '../../../../../utils/companyCftcServer.js';
import { isCftcEnabled } from '../../../../../utils/cftcFeature.js';
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from '../../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Schema-Version, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After', 'X-Schema-Version': COMPANY_CFTC_SCHEMA_VERSION };

export async function GET(request) {
  if (!isCftcEnabled()) return Response.json({ schemaVersion: COMPANY_CFTC_SCHEMA_VERSION, status: 'disabled', error: 'CFTC context is disabled.', code: 'CFTC_DISABLED', retryable: false }, { status: 503, headers: { ...CORS, 'Cache-Control': 'private, no-store' } });
  const limit = await checkRateLimit({ key: `rl:company-cftc:${COMPANY_CFTC_CACHE_NAMESPACE}:${getClientIp(request)}`, windowMs: 10 * 60_000, max: 30 });
  if (!limit.allowed) return rateLimitedResponse(limit, CORS);
  try {
    const selection = parseCompanyCftcRequest(request.url);
    const result = await loadCompanyCftcContext(selection, { signal: request.signal });
    const unavailable = result.status === 'unavailable';
    return Response.json(unavailable ? { ...result, error: result.message } : result, { status: unavailable ? 503 : 200, headers: { ...CORS, ...rateLimitHeaders(limit),
      'Cache-Control': unavailable ? 'private, no-store' : 'public, max-age=60, s-maxage=900, stale-while-revalidate=300',
      ...(unavailable ? { 'Retry-After': '30' } : {}),
    } });
  } catch (cause) {
    return Response.json({ schemaVersion: COMPANY_CFTC_SCHEMA_VERSION, status: 'unavailable', error: cause.message || 'Company market context is unavailable.', code: cause.code || 'COMPANY_CFTC_UNAVAILABLE', retryable: !cause.status || cause.status >= 500 },
      { status: cause.status || 503, headers: { ...CORS, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store' } });
  }
}

export function OPTIONS() { return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
