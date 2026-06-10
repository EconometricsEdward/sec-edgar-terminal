import type { Metadata } from 'next';
import DisclosureSearchClient from './DisclosureSearchClient';

export const metadata: Metadata = {
  title: 'SEC Disclosure Keyword Search',
  description:
    'Search recent SEC filings for any word or phrase across companies, curated sector universes, or a bounded cross-sector Market Map. Every result links to the source filing on SEC.gov.',
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
