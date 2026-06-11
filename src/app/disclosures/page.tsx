import type { Metadata } from 'next';
import DisclosureSearchClient from './DisclosureSearchClient';

export const metadata: Metadata = {
  title: 'SEC Disclosure Keyword Search',
  description:
    'Search the SEC EDGAR full-text index with analyst playbooks, any-term or all-terms matching, source-window, filer-concentration, company-focus, date, form, and result-count filters. Every result links to the source filing on SEC.gov.',
  alternates: {
    canonical: 'https://secedgarterminal.com/disclosures',
  },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export default async function DisclosuresPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const initialQuery = firstParam(params.query) || firstParam(params.keywords);
  const initialFocus = firstParam(params.focus) || firstParam(params.ticker) || firstParam(params.cik) || firstParam(params.company);
  const initialTickers = firstParam(params.tickers);
  const initialMode = firstParam(params.mode);
  const initialMatchMode = firstParam(params.match) || firstParam(params.matchMode);

  return (
    <DisclosureSearchClient
      initialQuery={initialQuery}
      initialFocus={initialFocus}
      initialTickers={initialTickers}
      initialMode={initialMode}
      initialMatchMode={initialMatchMode}
    />
  );
}
