import { COMPANY_EXPOSURE_SCHEMA_VERSION } from '../../../../../utils/companyExposure.js';
import { COMPANY_EXPOSURE_CACHE_NAMESPACE, loadCompanyExposures, parseCompanyExposureRequest } from '../../../../../utils/companyExposureServer.js';
import { isCftcEnabled } from '../../../../../utils/cftcFeature.js';
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from '../../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Schema-Version, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After', 'X-Schema-Version': COMPANY_EXPOSURE_SCHEMA_VERSION };

export async function GET(request) {
  if (!isCftcEnabled()) return Response.json({ schemaVersion: COMPANY_EXPOSURE_SCHEMA_VERSION, status: 'disabled', error: 'CFTC company exposure research is disabled.', code: 'CFTC_DISABLED', retryable: false }, { status: 503, headers: { ...CORS, 'Cache-Control': 'private, no-store' } });
  const limit = await checkRateLimit({ key: `rl:company-exposure:${COMPANY_EXPOSURE_CACHE_NAMESPACE}:${getClientIp(request)}`, windowMs: 10 * 60_000, max: 30 });
  if (!limit.allowed) return rateLimitedResponse(limit, CORS);
  try {
    const result = await loadCompanyExposures(parseCompanyExposureRequest(request.url), { signal: request.signal });
    const unavailable = result.status === 'unavailable', incomplete = unavailable || result.status === 'partial';
    return Response.json(unavailable ? { ...result, error: result.message } : result, { status: unavailable ? 503 : 200, headers: {
      ...CORS, ...rateLimitHeaders(limit),
      'Cache-Control': incomplete ? 'private, no-store' : 'public, max-age=60, s-maxage=900',
      ...(incomplete ? { 'Retry-After': '30' } : {}),
    } });
  } catch (cause) {
    return Response.json({ schemaVersion: COMPANY_EXPOSURE_SCHEMA_VERSION, status: 'unavailable', error: cause.message || 'Company exposure evidence is unavailable.', code: cause.code || 'COMPANY_EXPOSURE_UNAVAILABLE', retryable: !cause.status || cause.status >= 500 },
      { status: cause.status || 503, headers: { ...CORS, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store' } });
  }
}

export function OPTIONS() { return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
