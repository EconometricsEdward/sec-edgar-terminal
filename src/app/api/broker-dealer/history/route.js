import { brokerDealerHistorySettings, loadBrokerDealerHistory } from '../../../../utils/brokerDealerHistory.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };

export async function GET(request) {
  let settings;
  try { settings = brokerDealerHistorySettings(new URL(request.url).searchParams); }
  catch (error) { return Response.json({ error: error.message }, { status: 400, headers: privateHeaders }); }
  const limit = await checkRateLimit({ key: `rl:broker-dealer-history:${getClientIp(request)}`, windowMs: 60000, max: 60 });
  if (!limit.allowed) {
    const response = rateLimitedResponse(limit);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Robots-Tag', 'noindex');
    return response;
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
    const result = await loadBrokerDealerHistory(settings.identifier, { ...settings, signal });
    const headers = result.coverage.selectionComplete
      ? { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600', 'X-Robots-Tag': 'noindex' }
      : privateHeaders;
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ error: error.message || 'Broker-dealer filing history could not be loaded.' }, { status: error.status || 502, headers: privateHeaders });
  }
}
