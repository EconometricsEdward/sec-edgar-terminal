import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import MarketOverviewClient from './MarketOverviewClient';
import { buildPageMetadata } from '../../utils/siteMetadata';
import { readMarketOverview } from '../../utils/marketOverviewServer.js';
import { isCftcEnabled } from '../../utils/cftcFeature.js';
import { marketViewForCftcAvailability, marketViewPath, parseMarketView } from '../../utils/marketResearch.js';
import type { MarketData } from './marketTypes';

export const revalidate = 900;
// Redis holds the prepared overview shared by this request and the API. Avoid
// a second Next data-cache object, whose 2 MB item limit is too small at this scale.
async function readCachedMarket() { try { return await readMarketOverview(); } catch { return null; } }

export const metadata: Metadata = buildPageMetadata({
  title: isCftcEnabled() ? 'Market Briefing — CFTC Positioning & Sector Performance' : 'Market Briefing — Sector Performance',
  description: isCftcEnabled() ? 'Read the macro picture through sector growth, profitability, cash generation, and official CFTC futures positioning. Explore sector and industry coverage.' : 'Explore sector growth, profitability, cash generation, and investment across the SEC reporting universe.',
  path: '/market',
});

export default async function MarketOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // The page and API share a compact projection of the scheduled Quant atlas.
  // The CFTC view can render before the independent SEC coverage snapshot.
  const raw = await searchParams;
  const query = new URLSearchParams(Object.entries(raw).flatMap(([key, value]) => Array.isArray(value) ? value.map(item => [key, item]) : value == null ? [] : [[key, value]])).toString();
  const requestedTab = new URLSearchParams(query).get('tab');
  const cftcEnabled = isCftcEnabled();
  // Resolve retired Market views before reading the snapshot or hydrating the
  // client. Bookmarks from the former company-detail panel remain usable.
  if (requestedTab && !['overview', 'positioning', 'sectors'].includes(requestedTab)) {
    redirect(marketViewPath(marketViewForCftcAvailability(parseMarketView(query), cftcEnabled)));
  }
  if (!cftcEnabled && requestedTab === 'positioning') {
    redirect(marketViewPath(marketViewForCftcAvailability(parseMarketView(query), false)));
  }
  const independent = requestedTab === 'positioning';
  return <MarketOverviewClient initialData={independent ? null : await readCachedMarket() as MarketData | null} initialQuery={query} cftcEnabled={cftcEnabled} />;
}
