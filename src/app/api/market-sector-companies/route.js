import { readMarketServingView } from '../../../utils/marketBriefingServer.js';
import { pageMarketSectorCompanies, parseMarketSectorCompaniesQuery } from '../../../utils/marketSectorCompanies.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  let selection;
  try { selection = parseMarketSectorCompaniesQuery(new URL(request.url).searchParams); }
  catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } }); }
  const limit = await checkRateLimit({ key: `rl:market-sector-companies:${getClientIp(request)}`, windowMs: 60000, max: 90, cost: 1 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const snapshot = await readMarketServingView('sectorCompanies');
    const page = pageMarketSectorCompanies(snapshot, selection);
    return Response.json(page, { headers: {
      'Cache-Control': 'public, max-age=60, s-maxage=900, stale-while-revalidate=3600, stale-if-error=86400',
      'X-Market-Coverage': String(page.sectorTotal), 'X-SEC-Snapshot-At': snapshot.generatedAt,
    } });
  } catch (error) {
    return Response.json({ error: error.message || 'Sector company data is temporarily unavailable.' }, { status: error.status || 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
