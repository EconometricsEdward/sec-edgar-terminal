import type { Metadata } from 'next';
import RiskClient from './RiskClient';
import { buildPageMetadata } from '../../utils/siteMetadata';

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: 'Company Risk Profile — Credit, Liquidity, Capital & Earnings Risk from SEC Filings',
    description:
      'Explore current SEC risk signals with quarterly balances, trailing twelve-month financials, auditable trend charts, source filing inputs, and interactive bank funding and credit-loss scenarios. Includes annual research models and risk-language excerpts.',

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
