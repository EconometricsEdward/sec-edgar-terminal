import { readMarketBriefing } from '../../../utils/marketBriefingServer.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  if (new URL(request.url).search) return Response.json({ error: 'The Market briefing has no query parameters.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
  try {
    const value = await readMarketBriefing();
    return Response.json(value, { headers: {
      'Cache-Control': 'public, max-age=60, s-maxage=900, stale-while-revalidate=3600, stale-if-error=86400',
      'X-Market-Coverage': String(value.summaries.ttm.companyCount), 'X-SEC-Snapshot-At': value.generatedAt,
      ...(value.cache?.status === 'stale' ? { 'X-Data-Stale': '1' } : {}),
    } });
  } catch (error) {
    return Response.json({ error: error.message || 'Market data is temporarily unavailable.' }, { status: error.status || 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
