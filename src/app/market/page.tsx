import type { Metadata } from 'next';
import MarketOverviewClient from './MarketOverviewClient';
import { buildPageMetadata } from '../../utils/siteMetadata';
import { unstable_cache } from 'next/cache';
import { warmGet } from '../../utils/warmCache.js';
import { MARKET_VERSION } from '../../utils/marketResearch.js';
import { isMarketAtlas } from '../../utils/marketResearchValidation.js';
import type { MarketData } from './marketTypes';

export const revalidate = 3600;

const readCachedMarket = unstable_cache(
  async () => {
    const candidate = (await warmGet(MARKET_VERSION, 'atlas'))
      || (await warmGet(MARKET_VERSION, 'atlas-last-good'));
    if (!isMarketAtlas(candidate, MARKET_VERSION)) return null;
    const age = Date.now() - Date.parse(candidate.generatedAt);
    return Number.isFinite(age) && age < 6 * 60 * 60 * 1000
      ? candidate
      : {
          ...candidate,
          cache: {
            status: 'stale',
            warning: 'This is the last completed Market snapshot while a newer SEC refresh is pending.',
          },
        };
  },
  ['market-page-atlas-v2'],
  { revalidate: 3600 },
);

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: 'Market Overview — SEC Fundamentals, Sector Heatmap & Company Screener',
    description:
      'Explore SEC company fundamentals with a market briefing, sector heatmap, company screener, peer comparisons, source-linked financial history, and saved research views.',
    path: '/market',
  }),
};

export default async function MarketOverviewPage() {
  // Cache-only SSR: a crawler or page request never starts a 163-company SEC
  // rebuild. The client route remains responsible for bounded refreshes.
  const candidate = await readCachedMarket();
  const initialData = isMarketAtlas(candidate, MARKET_VERSION)
    ? candidate as MarketData
    : null;
  return <MarketOverviewClient initialData={initialData} />;
}
