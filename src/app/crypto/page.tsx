import type { Metadata } from 'next';
import CryptoClient from './CryptoClient';

// ============================================================================
// Metadata — static page (no params), but the client component handles
// live data refresh and scanner state
// ============================================================================
export const metadata: Metadata = {
  title: 'Crypto Filings Scanner & SEC Crypto Disclosures',
  description:
    "Scan any public company's SEC filings (10-K, 10-Q, 8-K) for mentions of bitcoin, cryptocurrency, and digital assets. Every match links to the source filing. Compare multiple companies side-by-side. Plus live coin prices.",
  alternates: {
    canonical: 'https://secedgarterminal.com/crypto',
  },
};

export default function CryptoPage() {
  return <CryptoClient />;
}
