import { notFound } from 'next/navigation';
import { cache } from 'react';
import { buildPageMetadata, SITE_URL } from '../../../../utils/siteMetadata';
import { bankScopeStore } from '../../../../utils/bank/scopeStore.js';
import { bankPageOptions } from '../../../../utils/bank/viewModel.js';
import { bankPageSeo } from '../../../../utils/bank/seo.js';
import BankWorkspace from '../BankWorkspace';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Metadata and the page share one read per request, including selected peers.
// This is request memoization, not a cross-request cache of financial figures.
const readPage = cache(async (selection) => {
  try { return { state: await bankScopeStore('read', { rssds: selection.split(',') }), error: false }; }
  catch { return { state: { banks: [], reports: [], jobs: [], periods: [] }, error: true }; }
});
export async function generateMetadata({ params, searchParams }) {
  const { rssd } = await params;
  if (!/^[1-9]\d{0,9}$/.test(rssd)) notFound();
  const options = bankPageOptions(rssd, await searchParams);
  const { state, error } = await readPage([rssd, ...options.peers].join(','));
  const { index, ...input } = bankPageSeo(rssd, state, error);
  return { ...buildPageMetadata(input), ...(!index ? { robots: { index: false, follow: true } } : {}) };
}
export default async function BankPage({ params, searchParams }) {
  const { rssd } = await params;
  if (!/^[1-9]\d{0,9}$/.test(rssd)) notFound();
  const options = bankPageOptions(rssd, await searchParams);
  const selection = [rssd, ...options.peers].join(',');
  const { state, error } = await readPage(selection);
  if (!error && !state?.banks?.some(b => String(b.id_rssd) === rssd)) notFound();
  const bank = state.banks.find(b => String(b.id_rssd) === rssd);
  const breadcrumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Analysis', item: `${SITE_URL}/analysis` },
    { '@type': 'ListItem', position: 2, name: 'BankScope', item: `${SITE_URL}/analysis/banks` },
    { '@type': 'ListItem', position: 3, name: bank?.legal_name || `RSSD ${rssd}`, item: `${SITE_URL}/analysis/banks/${rssd}` },
  ] };
  return <>{bank && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbs).replace(/</g, '\\u003c') }} />}<BankWorkspace key={selection} initialState={state} rssd={rssd} options={options} error={error} /></>;
}
