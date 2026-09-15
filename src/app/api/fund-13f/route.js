import { loadThirteenF, normalize13FRequest } from '../../../utils/thirteenFServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['cik', 'period'].includes(key)) || params.getAll('cik').length !== 1 || params.getAll('period').length > 1) {
      return Response.json({ error: 'Use one SEC CIK and an optional report quarter.', code: 'INVALID_REQUEST' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
    }
    const { cik, period } = normalize13FRequest(params.get('cik'), params.get('period'));
    const limit = await checkRateLimit({ key: `rl:fund-13f:${getClientIp(request)}`, windowMs: 60000, max: 30 });
    if (!limit.allowed) {
      const response = rateLimitedResponse(limit);
      response.headers.set('Cache-Control', 'private, no-store');
      return response;
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55000)]);
    const data = await loadThirteenF(cik, { period, signal });
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': (!data.coverage.selectedPeriodComplete || data.portfolio && !data.portfolio.complete) ? 'private, no-store'
      : period ? 'public, max-age=60, s-maxage=3600, stale-while-revalidate=3600'
        : 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' };
    if (bytes.length < 3500000) return new Response(bytes, { headers });
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 32768));
      offset += 32768;
    } }), { headers });
  } catch (error) {
    return Response.json({ error: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'The SEC 13F request timed out. Retry this report.' : error.message || 'SEC 13F research is temporarily unavailable. Retry this request.',
      code: typeof error.code === 'string' ? error.code : 'SEC_13F_UNAVAILABLE' }, { status: Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
