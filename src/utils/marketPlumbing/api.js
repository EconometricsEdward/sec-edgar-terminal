import { getMarketResearch } from './server.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../rateLimit.js';
export function createMarketResearchApi({ read = getMarketResearch, rateLimit = checkRateLimit } = {}) {
  return async request => {
    const params = new URL(request.url).searchParams;
    const kind = params.get('view');
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' };
    if (!['funding', 'derivatives'].includes(kind) || [...params.keys()].some(k => k !== 'view' || params.getAll(k).length !== 1)) return Response.json({ error: 'Choose funding or derivatives.' }, { status: 400, headers });
    try {
      const limit = await rateLimit({ key: `rl:market-plumbing:${getClientIp(request)}`, max: 60, windowMs: 60000 });
      if (!limit.allowed) return rateLimitedResponse(limit);
      const data = await read(kind);
      return Response.json(data, { headers: { ...headers, 'Cache-Control': 'public, max-age=60, s-maxage=900, stale-while-revalidate=3600' } });
    } catch { return Response.json({ error: 'Market research is temporarily unavailable.' }, { status: 503, headers }); }
  };
}
