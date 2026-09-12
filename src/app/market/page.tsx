import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import MarketOverviewClient from './MarketOverviewClient';
import { buildPageMetadata } from '../../utils/siteMetadata';
import { readMarketOverview } from '../../utils/marketOverviewServer.js';
import { isCftcEnabled } from '../../utils/cftcFeature.js';
import { marketViewForCftcAvailability, marketViewPath, parseMarketView } from '../../utils/marketResearch.js';
import type { MarketData } from './marketTypes';

export const revalidate = 900;
// ISR caches the rendered page; Redis holds the compressed overview. Avoid a
// second Next data-cache object, whose 2 MB item limit is too small at this scale.
async function readCachedMarket() { try { return await readMarketOverview(); } catch { return null; } }

export const metadata: Metadata = buildPageMetadata({
  title: isCftcEnabled() ? 'Market Research — SEC Fundamentals & CFTC Positioning' : 'Market Research — SEC Fundamentals',
  description: isCftcEnabled() ? 'Explore SEC filing breadth, sectors, companies and Fundamental Lab alongside separate official CFTC futures positioning.' : 'Explore SEC filing breadth, sectors, companies and the SEC-only Fundamental Lab.',
  path: '/market',
});

export default async function MarketOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // The page and API share a compact projection of the scheduled Quant atlas.
  // Independent CFTC/Fundamental views do not need the overview projection.
  const raw = await searchParams;
  const query = new URLSearchParams(Object.entries(raw).flatMap(([key, value]) => Array.isArray(value) ? value.map(item => [key, item]) : value == null ? [] : [[key, value]])).toString();
  const requestedTab = new URLSearchParams(query).get('tab');
  const cftcEnabled = isCftcEnabled();
  if (!cftcEnabled && requestedTab === 'positioning') {
    redirect(marketViewPath(marketViewForCftcAvailability(parseMarketView(query), false)));
  }
  const independent = ['positioning', 'fundamentals', 'factors'].includes(requestedTab || '');
  return <MarketOverviewClient initialData={independent ? null : await readCachedMarket() as MarketData | null} initialQuery={query} cftcEnabled={cftcEnabled} />;
}
