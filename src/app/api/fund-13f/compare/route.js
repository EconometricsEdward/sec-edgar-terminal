import { loadThirteenFComparison, normalize13FComparisonRequest } from '../../../../utils/thirteenFComparisonServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request) {
  const startedAt = performance.now();
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['ciks', 'period', 'refresh'].includes(key))
      || ['ciks', 'period', 'refresh'].some(key => params.getAll(key).length > 1)
      || params.has('refresh') && params.get('refresh') !== '1') {
      return Response.json({ error: 'Use two to four SEC CIKs, an optional report quarter, and refresh=1 to recheck the comparison.', code: 'INVALID_REQUEST' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
    }
    const { ciks, period } = normalize13FComparisonRequest(params.has('ciks') ? params.get('ciks') : undefined, params.get('period'));
    const limit = await checkRateLimit({ key: `rl:fund-13f-compare:${getClientIp(request)}`, windowMs: 60000, max: 12 });
    if (!limit.allowed) {
      const response = rateLimitedResponse(limit);
      response.headers.set('Cache-Control', 'private, no-store');
      return response;
    }
    const refresh = params.get('refresh') === '1';
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55000)]);
    const data = await loadThirteenFComparison(ciks, { period, refresh, signal });
    const freshSeconds = Math.max(0, Math.min(300, Math.floor((Date.parse(data.cache?.freshUntil) - Date.now()) / 1000))) || 0;
    return Response.json(data, { headers: {
      'X-13F-Cache': data.cache?.status || 'source',
      'Server-Timing': `comparison;dur=${Math.round(performance.now() - startedAt)}`,
      'Cache-Control': refresh || data.cache?.stale || !data.coverage.allComplete || !freshSeconds
        ? 'private, no-store' : `public, max-age=0, s-maxage=${freshSeconds}`,
    } });
  } catch (error) {
    return Response.json({
      error: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'The SEC comparison timed out. Retry; verified reports already prepared can be reused.'
        : error.message || 'The SEC comparison is temporarily unavailable. Retry this request.',
      code: typeof error.code === 'string' ? error.code : 'SEC_13F_COMPARISON_UNAVAILABLE',
    }, { status: Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502,
      headers: { 'Cache-Control': 'private, no-store' } });
  }
}
