import { NextResponse } from 'next/server';
import { loadMarketAtlas, loadMarketCompany, marketTickers } from '../../../utils/marketResearchServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const ticker = new URL(request.url).searchParams.get('ticker')?.trim().toUpperCase();
  if (ticker !== undefined && !marketTickers.includes(ticker)) return NextResponse.json({ error: 'Choose a company from the Market research universe.' }, { status: 400 });
  const limit = await checkRateLimit({ key: `rl:market-research:${getClientIp(request)}`, windowMs: 60000, max: 30 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const data = ticker ? await loadMarketCompany(ticker) : await loadMarketAtlas();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' } });
  } catch (error) {
    return NextResponse.json({ error: error.message || 'Market research is temporarily unavailable. Please retry.' }, { status: 502 });
  }
}
