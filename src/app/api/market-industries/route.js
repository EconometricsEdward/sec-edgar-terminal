import { readMarketServingView } from '../../../utils/marketBriefingServer.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const sector = params.get('sector'), basis = params.get('basis') || 'ttm';
  if ([...params.keys()].some(key => !['sector', 'basis'].includes(key))
    || params.getAll('sector').length !== 1 || params.getAll('basis').length > 1
    || !/^sector-[a-z0-9-]{1,70}$/.test(sector || '') || !['annual', 'ttm'].includes(basis)) {
    return Response.json({ error: 'Choose a sector and reporting basis.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
  }
  try {
    const value = await readMarketServingView('industries');
    const row = value.bases[basis].find(row => row.id === sector);
    if (!row) return Response.json({ error: 'This sector is not present in the prepared snapshot.' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    return Response.json({ version: value.version, generatedAt: value.generatedAt, sector, basis,
      industries: row.industries, missingIndustryCount: row.missingIndustryCount }, { headers: {
      'Cache-Control': 'public, max-age=60, s-maxage=900, stale-while-revalidate=3600, stale-if-error=86400',
      'X-SEC-Snapshot-At': value.generatedAt,
    } });
  } catch (error) {
    return Response.json({ error: error.message || 'Industry data is temporarily unavailable.' }, { status: error.status || 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
