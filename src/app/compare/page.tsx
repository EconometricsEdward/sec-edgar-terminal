import type { Metadata } from 'next';
import CompareClient from './[tickers]/CompareClient';

// ============================================================================
// Metadata — static, since this page has no ticker list yet
// ============================================================================
export const metadata: Metadata = {
  title: 'Peer Comparison — Compare SEC Filings & Financials',
  description:
    'Compare up to 5 public companies side-by-side. 10 years of financial data, head-to-head snapshot tables, industry-aware ratios from SEC XBRL filings.',
  alternates: {
    canonical: 'https://secedgarterminal.com/compare',
  },
};

// ============================================================================
// /compare with no tickers — render the same client component with empty
// initial list. The client handles the peer-group picker, ticker input, and
// URL syncing as users add companies.
// ============================================================================
export default function CompareIndexPage() {
  return <CompareClient initialTickers={[]} preloadedCompanies={[]} />;
}
