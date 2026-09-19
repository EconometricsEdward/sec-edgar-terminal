import { parseReportSearch, searchReports } from '../../../../utils/reportSearchServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request) {
  try {
    const input = parseReportSearch(new URL(request.url).searchParams);
    const limit = await checkRateLimit({ key: `rl:report-search:${getClientIp(request)}`, windowMs: 60000, max: 40 });
    if (!limit.allowed) return rateLimitedResponse(limit);
    const result = await searchReports(input);
    return Response.json(result, { headers: { 'Cache-Control': result.warning ? 'private, no-store' : 'public, max-age=30, s-maxage=300', 'X-Robots-Tag': 'noindex, nofollow' } });
  } catch (failure) {
    const status = [400, 404, 429, 502, 503].includes(failure.status) ? failure.status : 502;
    return Response.json({ error: status === 400 || status === 404 ? failure.message : 'SEC report search is temporarily unavailable. Retry or use an exact ticker or CIK.' },
      { status, headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', ...(status === 503 ? { 'Retry-After': '10' } : {}) } });
  }
}
