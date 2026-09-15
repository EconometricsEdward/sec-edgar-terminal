import { loadThirteenFMarketConnections, normalize13FMarketConnectionsRequest, THIRTEEN_F_MARKET_CONNECTIONS_SCHEMA_VERSION } from '../../../../utils/thirteenFMarketConnectionsServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store', 'X-Schema-Version': THIRTEEN_F_MARKET_CONNECTIONS_SCHEMA_VERSION };

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['cik', 'period', 'key'].includes(key)) || ['cik', 'period', 'key'].some(key => params.getAll(key).length !== 1))
      return Response.json({ error: 'Use one manager CIK, report quarter and holding key.', code: 'INVALID_REQUEST' }, { status: 400, headers });
    const { cik, period, key } = normalize13FMarketConnectionsRequest(params.get('cik'), params.get('period'), params.get('key'));
    const limit = await checkRateLimit({ key: `rl:fund-13f-market-connections:${getClientIp(request)}`, windowMs: 60000, max: 45 });
    if (!limit.allowed) {
      const response = rateLimitedResponse(limit);
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55000)]);
    const data = await loadThirteenFMarketConnections(cik, { period, key, signal });
    // A source outage still has useful verified issuer/source coverage. Keep
    // that envelope readable; retryable and discovery.status describe its gaps.
    return Response.json(data, { headers });
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
    const message = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'SEC market connections took too long to respond. Retry this holding.'
      : status < 500 ? error.message : error.code === 'CFTC_DISABLED' ? 'CFTC market connection research is disabled.' : 'SEC market connections are temporarily unavailable. Retry this holding.';
    return Response.json({ schemaVersion: THIRTEEN_F_MARKET_CONNECTIONS_SCHEMA_VERSION, status: 'unavailable', error: message,
      code: typeof error.code === 'string' ? error.code : 'SEC_MARKET_CONNECTIONS_UNAVAILABLE', retryable: status >= 500 && error.code !== 'CFTC_DISABLED' }, { status, headers });
  }
}
