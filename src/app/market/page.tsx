import type { Metadata } from 'next';
import MarketOverviewClient from './MarketOverviewClient';
import { buildPageMetadata } from '../../utils/siteMetadata';
import { readMarketOverview } from '../../utils/marketOverviewServer.js';
import type { MarketData } from './marketTypes';

export const revalidate = 900;
// ISR caches the rendered page; Redis holds the compressed overview. Avoid a
// second Next data-cache object, whose 2 MB item limit is too small at this scale.
async function readCachedMarket() { try { return await readMarketOverview(); } catch { return null; } }

export const metadata: Metadata = buildPageMetadata({
  title: 'Market Overview — SEC Breadth, Sector Heatmap & Quant Lab',
  description: 'Screen the same broad SEC research universe across the Market briefing, sector heatmap, company screener and Quant Lab. Explore fundamentals, coverage and source filings.',
  path: '/market',
});

export default async function MarketOverviewPage() {
  // The page and API share a compact projection of the scheduled Quant atlas.
  // No page request initiates a SEC or price-provider universe refresh.
  return <MarketOverviewClient initialData={await readCachedMarket() as MarketData | null} />;
}
