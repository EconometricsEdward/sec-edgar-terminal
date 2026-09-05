import type { Metadata } from 'next';
import MarketOverviewClient from './MarketOverviewClient';
import { buildPageMetadata } from '../../utils/siteMetadata';

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: 'Market Overview — SEC Fundamentals, Sector Heatmap & Company Screener',
    description:
      'Explore SEC company fundamentals with a market briefing, sector heatmap, company screener, peer comparisons, source-linked financial history, and saved research views.',
    path: '/market',
  }),
};

export default function MarketOverviewPage() {
  return <MarketOverviewClient />;
}
