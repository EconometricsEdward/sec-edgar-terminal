import { readMarketDirectory } from '../../../utils/marketBriefingServer.js';
import { pageMarketDirectory, parseMarketDirectoryQuery } from '../../../utils/marketBriefing.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  let selection;
  try { selection = parseMarketDirectoryQuery(new URL(request.url).searchParams); }
  catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } }); }
  const limit = await checkRateLimit({ key: `rl:market-directory:${getClientIp(request)}`, windowMs: 60000, max: 90, cost: 1 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const directory = await readMarketDirectory();
    return Response.json(pageMarketDirectory(directory, selection), { headers: {
      'Cache-Control': 'public, max-age=60, s-maxage=900, stale-while-revalidate=3600, stale-if-error=86400',
      'X-Market-Coverage': String(directory.companies.length), 'X-SEC-Snapshot-At': directory.generatedAt,
    } });
  } catch (error) {
    return Response.json({ error: error.message || 'The company directory is temporarily unavailable.' }, { status: error.status || 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
