import { NextResponse } from 'next/server';
import { loadMarketAtlas, loadMarketCompany, marketTickers } from '../../../utils/marketResearchServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';
import { MARKET_VERSION } from '../../../utils/marketResearch.js';
import { projectMarketAtlasForClient } from '../../../utils/marketClientProjection.js';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const allowed = new Set(['ticker', 'v', 'projection']);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) return NextResponse.json({ error: `Unknown query parameter: ${key}` }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
    if (searchParams.getAll(key).length > 1) return NextResponse.json({ error: `Query parameter may appear only once: ${key}` }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
  }
  const ticker = searchParams.get('ticker')?.trim().toUpperCase();
  const version = searchParams.get('v');
  const projection = searchParams.get('projection');
  if (version && version !== MARKET_VERSION) return NextResponse.json({ error: 'Unsupported Market snapshot version.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
  if (projection && projection !== 'client') return NextResponse.json({ error: 'Unsupported Market projection.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
  if (ticker && projection) return NextResponse.json({ error: 'projection is only supported for the Market atlas.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
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
    const raw = ticker ? await loadMarketCompany(ticker) : await loadMarketAtlas();
    const data = !ticker && projection === 'client' ? projectMarketAtlasForClient(raw) : raw;
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
