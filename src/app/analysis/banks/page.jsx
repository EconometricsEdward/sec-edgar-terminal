import { buildPageMetadata } from '../../../utils/siteMetadata';
import { bankScopeStore } from '../../../utils/bank/scopeStore.js';
import BankDirectory from './BankDirectory';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = buildPageMetadata({ title: 'BankScope — FFIEC Bank Analysis, Comparisons & Trends', description: 'Search banks by name, RSSD or FDIC certificate. Compare capital, credit, funding and earnings using source-linked FFIEC Call Reports. Connect legal banks to regulatory parent organizations and SEC research.', path: '/analysis/banks' });
export default async function BanksPage() {
  let directory;
  try { directory = await bankScopeStore('search', { query: '' }); } catch { directory = { banks: [], unavailable: true }; }
  return <BankDirectory directory={directory} />;
}
