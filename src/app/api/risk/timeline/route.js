import { readRiskTimeline } from '../../../../utils/riskTimelineEvidenceServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const ticker = (params.get('ticker') || '').trim().toUpperCase();
  const mode = params.get('mode') || 'annual';
  if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker) || !['annual', 'quarterly'].includes(mode)
    || [...params.keys()].some(key => !['ticker', 'mode', 'include'].includes(key) || params.getAll(key).length !== 1)
    || params.has('include') && params.get('include') !== 'text')
    return Response.json({ error: 'Choose a valid ticker and annual or quarterly reports.' }, { status: 400 });
  const limit = await checkRateLimit({ key: `rl:risk-timeline:${getClientIp(request)}`, windowMs: 600_000, max: 16 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const data = await readRiskTimeline(ticker, { mode, includeText: params.get('include') === 'text' });
    return Response.json(data, { headers: { 'Cache-Control': data.status === 'partial' ? 'private, no-store' : 'public, max-age=0, s-maxage=300' } });
  } catch (error) {
    return Response.json({ error: error.message || 'Filing comparisons could not be loaded.' }, { status: error.status || 502,
      headers: { 'Cache-Control': 'private, no-store' } });
  }
}
