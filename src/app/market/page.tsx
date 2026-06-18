import type { Metadata } from 'next';
import MarketOverviewClient from './MarketOverviewClient';
import { buildPageMetadata } from '../../utils/siteMetadata';

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: 'Market Overview — SEC Market Risk Atlas',
    description:
      'A research-grade SEC filing market map with trade-book exposure, market-risk weather, asset-class exposure indexes, and derivatives exposure signals across public-company filings.',
    path: '/market',
  }),
};

export default function MarketOverviewPage() {
  return <MarketOverviewClient />;
}
