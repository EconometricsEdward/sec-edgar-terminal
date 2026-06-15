import type { Metadata } from 'next';
import RiskClient from './RiskClient';
import { buildPageMetadata } from '../../utils/siteMetadata';

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: 'Company Risk Profile — Credit, Liquidity, Capital & Earnings Risk from SEC Filings',
    description:
      "Multi-pillar risk profile built from SEC XBRL data: Altman Z''-Score, interest coverage, leverage, and liquidity for operating companies — and a dedicated bank credit lens (reserve coverage, provisions, capital, loans/deposits) for financial institutions. Plus a credit-language scan of the latest 10-K. Every number links to its SEC source.",
    path: '/risk',
  }),
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export default async function RiskPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const initialTicker = firstParam(params.ticker) || firstParam(params.symbol);

  return <RiskClient initialTicker={initialTicker.toUpperCase()} />;
}
