import { readMarketServingView } from './marketBriefingServer.js';
import { isMarketSectorCompanies } from './marketResearchValidation.js';
import { buildRiskPeers, parseRiskPeerRequest } from './riskPeers.js';
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from './rateLimit.js';

export function createRiskPeersRoute({ read = () => readMarketServingView('sectorCompanies'), limit = checkRateLimit, now = Date.now } = {}) {
  return async function GET(request) {
    let selection;
    try { selection = parseRiskPeerRequest(request.url); }
    catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } }); }
    const budget = await limit({ key: `rl:risk-peers:${getClientIp(request)}`, windowMs: 600000, max: 90, cost: 1 });
    if (!budget.allowed) return rateLimitedResponse(budget);
    try {
      const snapshot = await read();
      if (!isMarketSectorCompanies(snapshot)) throw new Error('The prepared peer snapshot could not be verified.');
      const body = buildRiskPeers(snapshot, selection, now());
      return Response.json(body, { headers: { ...rateLimitHeaders(budget), 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': body.stale ? 'public, max-age=0, s-maxage=30' : 'public, max-age=60, s-maxage=300, stale-while-revalidate=60' } });
    } catch {
      return Response.json({ error: 'Prepared peer benchmarks are temporarily unavailable. Try again shortly.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
    }
  };
}
