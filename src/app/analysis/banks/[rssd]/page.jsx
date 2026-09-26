import { notFound } from 'next/navigation';
import { buildPageMetadata } from '../../../../utils/siteMetadata';
import { bankScopeStore } from '../../../../utils/bank/scopeStore.js';
import { bankPageOptions } from '../../../../utils/bank/viewModel.js';
import BankWorkspace from '../BankWorkspace';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function generateMetadata({ params }) {
  const { rssd } = await params;
  return buildPageMetadata({ title: `BankScope · RSSD ${/^[1-9]\d{0,9}$/.test(rssd) ? rssd : 'Bank'} — FFIEC Research`, description: 'Source-linked bank financials, credit and funding exposures, securities valuation, FFIEC peer comparisons and quarterly trends.', path: `/analysis/banks/${rssd}` });
}
export default async function BankPage({ params, searchParams }) {
  const { rssd } = await params;
  if (!/^[1-9]\d{0,9}$/.test(rssd)) notFound();
  const options = bankPageOptions(rssd, await searchParams);
  let state, error = false;
  try { state = await bankScopeStore('read', { rssds: [rssd, ...options.peers] }); } catch { error = true; }
  if (!error && !state?.banks?.some(b => String(b.id_rssd) === rssd)) notFound();
  return <BankWorkspace initialState={state || { banks: [], reports: [], jobs: [], periods: [] }} rssd={rssd} options={options} error={error} />;
}
