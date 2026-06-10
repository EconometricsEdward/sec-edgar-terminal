import type { Metadata } from 'next';
import DisclosureSearchClient from './DisclosureSearchClient';

export const metadata: Metadata = {
  title: 'SEC Disclosure Keyword Search',
  description:
    'Search the SEC EDGAR full-text index with date, form, and result-count filters or scan recent company filings for any word or phrase. Every result links to the source filing on SEC.gov.',
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
  return <DisclosureSearchClient initialQuery={initialQuery} />;
}
