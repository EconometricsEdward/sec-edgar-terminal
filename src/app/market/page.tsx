import type { Metadata } from 'next';
import MarketOverviewClient from './MarketOverviewClient';
import { buildPageMetadata } from '../../utils/siteMetadata';
import { isCftcEnabled } from '../../utils/cftcFeature.js';

// The shared page shell is static. SEC aggregates and the paged company directory
// use independent CDN-cached endpoints; a visitor never starts a universe rebuild.
export const dynamic = 'force-static';

export const metadata: Metadata = buildPageMetadata({
  title: isCftcEnabled() ? 'Market Briefing — CFTC Positioning & Sector Performance' : 'Market Briefing — Sector Performance',
  description: isCftcEnabled() ? 'Read the macro picture through sector growth, profitability, cash generation, and official CFTC futures positioning. Explore sector and industry coverage.' : 'Explore sector growth, profitability, cash generation, and investment across the SEC reporting universe.',
  path: '/market',
});

export default function MarketPage() {
  return <MarketOverviewClient cftcEnabled={isCftcEnabled()} />;
}
