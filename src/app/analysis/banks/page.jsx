import { buildPageMetadata } from '../../../utils/siteMetadata';
import { connection } from 'next/server';
import { getBankDirectory } from '../../../utils/bank/directoryStore.js';
import BankDirectory from './BankDirectory';
export const runtime = 'nodejs';
export const metadata = buildPageMetadata({ title: 'BankScope — FFIEC Bank Analysis, Comparisons & Trends', description: 'Search banks by name, RSSD or FDIC certificate. Compare capital, credit, funding and earnings using source-linked FFIEC Call Reports. Connect legal banks to regulatory parent organizations and SEC research.', path: '/analysis/banks' });
export default async function BanksPage() {
  // Keep runtime workload identity out of prerendering without disabling the
  // shared directory cache (force-dynamic also forces cache reads off).
  await connection();
  let directory;
  try { directory = await getBankDirectory(); } catch { directory = { banks: [], unavailable: true }; }
  return <BankDirectory directory={directory} />;
}
