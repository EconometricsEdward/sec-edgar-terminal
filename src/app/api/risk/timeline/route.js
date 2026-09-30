import { loadRiskTimeline, parseRiskTimelineRequest } from '../../../../utils/riskTimelineServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request) {
  let selection;
  try { selection = parseRiskTimelineRequest(request.url); }
  catch (error) { return Response.json({ error: error.message }, { status: 400, headers }); }
  const limit = await checkRateLimit({ key: `rl:risk-timeline:${getClientIp(request)}`, windowMs: 600_000, max: 20, cost: 2 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try { return Response.json(await loadRiskTimeline(selection, { signal: request.signal }), { headers }); }
  catch (error) {
    return Response.json({ error: request.signal?.aborted ? 'Filing comparison cancelled.' : error.message || 'The bounded SEC filing comparison is unavailable.',
      code: error.code || 'RISK_TIMELINE_UNAVAILABLE' }, { status: request.signal?.aborted ? 499 : error.status || 503, headers });
  }
}
