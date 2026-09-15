import { loadThirteenFCompanyResearch, normalize13FCompanyRequest } from '../../../../utils/thirteenFCompanyResearchServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['cik', 'period', 'key'].includes(key)) || ['cik', 'period', 'key'].some(key => params.getAll(key).length !== 1))
      return Response.json({ error: 'Use one manager CIK, report quarter and holding key.', code: 'INVALID_REQUEST' }, { status: 400, headers });
    const { cik, period, key } = normalize13FCompanyRequest(params.get('cik'), params.get('period'), params.get('key'));
    const limit = await checkRateLimit({ key: `rl:fund-13f-company:${getClientIp(request)}`, windowMs: 60000, max: 45 });
    if (!limit.allowed) {
      const response = rateLimitedResponse(limit);
      response.headers.set('Cache-Control', 'private, no-store');
      return response;
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55000)]);
    const data = await loadThirteenFCompanyResearch(cik, { period, key, signal });
    return Response.json(data, { headers });
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
    const message = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'SEC company research took too long to respond. Retry this holding.'
      : status < 500 ? error.message : 'SEC company research is temporarily unavailable. Retry this holding.';
    return Response.json({ error: message, code: typeof error.code === 'string' ? error.code : 'SEC_COMPANY_RESEARCH_UNAVAILABLE' }, { status, headers });
  }
}
