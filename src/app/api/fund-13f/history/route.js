import { load13FHistoryQuarter, normalize13FHistoryRequest } from '../../../../utils/thirteenFHistoryServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    if (['cik', 'period', 'keys'].some(key => params.getAll(key).length !== 1) || [...params.keys()].some(key => !['cik', 'period', 'keys'].includes(key))) {
      return Response.json({ error: 'Use one manager CIK, reporting quarter, and security-key list.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
    }
    const query = normalize13FHistoryRequest(params.get('cik'), params.get('period'), params.get('keys'));
    const limit = await checkRateLimit({ key: `rl:fund-13f-history:${getClientIp(request)}`, windowMs: 60000, max: 60 });
    if (!limit.allowed) { const response = rateLimitedResponse(limit); response.headers.set('Cache-Control', 'private, no-store'); return response; }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55000)]);
    const data = await load13FHistoryQuarter(query.cik, { ...query, signal });
    return Response.json(data, { headers: { 'Cache-Control': data.status === 'ready' && data.projection?.complete && data.coverage?.selectedPeriodComplete && !data.cache?.stale ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' : 'private, no-store' } });
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
    return Response.json({ error: status === 400 ? error.message : error.code === 'PERIOD_NOT_FOUND' ? 'No public 13F report was found for this quarter in the SEC history checked.' : 'This SEC quarter could not be loaded. Retry it to fill the gap.', code: typeof error.code === 'string' ? error.code : 'SEC_13F_HISTORY_UNAVAILABLE' }, { status, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
