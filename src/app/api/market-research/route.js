import { NextResponse } from 'next/server';
import { loadMarketAtlas, loadMarketCompany, marketTickers } from '../../../utils/marketResearchServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const ticker = new URL(request.url).searchParams.get('ticker')?.trim().toUpperCase();
  if (ticker !== undefined && !marketTickers.includes(ticker)) return NextResponse.json({ error: 'Choose a company from the Market research universe.' }, { status: 400 });
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
    const data = ticker ? await loadMarketCompany(ticker) : await loadMarketAtlas();
    const stale = data?.cache?.status === 'stale';
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': stale
          ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600, stale-if-error=604800'
          : 'public, max-age=300, s-maxage=3600, stale-while-revalidate=21600, stale-if-error=604800',
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
