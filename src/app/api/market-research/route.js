import { NextResponse } from 'next/server';
import { loadMarketCompany } from '../../../utils/marketResearchServer.js';
import { readMarketOverview } from '../../../utils/marketOverviewServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const ticker = new URL(request.url).searchParams.get('ticker')?.trim().toUpperCase();
  if (ticker !== undefined && !/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker)) return NextResponse.json({ error: 'Choose a company from the Market research universe.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
  const limit = await checkRateLimit({
    key: `rl:market-research:${getClientIp(request)}`,
    windowMs: 10 * 60_000,
    max: 60,
    // The shared SEC gate and distributed atlas lease account for upstream
    // work. This quota protects the route without penalizing warm-cache hits.
    cost: ticker ? 1 : 5,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const overview = await readMarketOverview();
    const company = ticker ? overview.companies.find(c => c.ticker === ticker) : null;
    if (ticker && !company) return NextResponse.json({ error: 'Choose a company from the published Market research universe.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
    const data = ticker ? await loadMarketCompany(ticker, { cik: company.cik, name: company.name }, { signal: AbortSignal.timeout(45000) }) : overview;
    const stale = data?.cache?.status === 'stale';
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': stale
          ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600, stale-if-error=604800'
          : 'public, max-age=60, s-maxage=900, stale-while-revalidate=300, stale-if-error=604800',
        'X-Market-Coverage': String(overview.companies.length),
        'X-SEC-Snapshot-At': overview.generatedAt,
        ...(stale ? { Warning: '110 - "Response is stale"', 'X-Data-Stale': '1' } : {}),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || 'Market research is temporarily unavailable. Please retry.' },
      { status: error.status || 502, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}
