import type { Metadata } from 'next';
import MarketOverviewClient from './MarketOverviewClient';
import { buildPageMetadata } from '../../utils/siteMetadata';
import { unstable_cache } from 'next/cache';
import { warmGet } from '../../utils/warmCache.js';
import { MARKET_ATLAS_FRESH_MS, MARKET_VERSION } from '../../utils/marketResearch.js';
import { isMarketAtlas } from '../../utils/marketResearchValidation.js';
import type { MarketData } from './marketTypes';

export const revalidate = 3600;

const readCachedMarket = unstable_cache(
  async () => {
    const candidate = (await warmGet(MARKET_VERSION, 'atlas'))
      || (await warmGet(MARKET_VERSION, 'atlas-last-good'));
    if (!isMarketAtlas(candidate, MARKET_VERSION)) return null;
    const age = Date.now() - Date.parse(candidate.generatedAt);
    return Number.isFinite(age) && age >= 0 && age < MARKET_ATLAS_FRESH_MS
      ? candidate
      : {
          ...candidate,
          cache: {
            status: 'stale',
            warning: 'This is the last completed Market snapshot while a newer SEC refresh is pending.',
          },
        };
  },
  ['market-page-atlas-v3'],
  { revalidate: 3600 },
);

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: 'Market Overview — SEC Fundamentals, Betas & Factor Lab',
    description:
      'Explore SEC fundamentals, sector heatmaps, company screening, regression betas, filing-event response, and the EDGAR Evidence Gap with source-aware research outputs.',
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
