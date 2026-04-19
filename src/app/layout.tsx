import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';

// ============================================================================
// Metadata — ports the <meta> tags from index.html
//
// Next.js 16 renders these server-side, so scrapers (Google, Twitter, LinkedIn,
// Discord, Slack) see them in the raw HTML before any JavaScript runs.
//
// Page-specific overrides come later (Day 2) via generateMetadata exports on
// each route's page.jsx. For Day 1, every URL gets these defaults — which is
// identical to current behavior.
// ============================================================================
export const metadata: Metadata = {
  metadataBase: new URL('https://secedgarterminal.com'),
  title: {
    default: 'EDGAR Terminal — SEC Filings & Financial Data Explorer',
    template: '%s | EDGAR Terminal',
  },
  description:
    'Free, source-linked explorer for SEC filings, XBRL financials, insider trading, and peer comparisons. Every number cites its source on SEC.gov. No account required.',
  keywords: [
    'SEC filings',
    '10-K',
    '10-Q',
    'XBRL',
    'EDGAR',
    'financial analysis',
    'insider trading',
    'Form 4',
    'peer comparison',
    'stock analysis',
    'public company data',
  ],
  authors: [{ name: 'EDGAR Terminal' }],
  robots: {
    index: true,
    follow: true,
  },
  alternates: {
    canonical: 'https://secedgarterminal.com/',
  },
  openGraph: {
    type: 'website',
    url: 'https://secedgarterminal.com/',
    title: 'EDGAR Terminal — SEC Filings & Financial Data Explorer',
    description:
      'Free, source-linked explorer for SEC filings, XBRL financials, insider trading, and peer comparisons. Every number cites its SEC source.',
    siteName: 'EDGAR Terminal',
    locale: 'en_US',
    images: [
      {
        url: 'https://secedgarterminal.com/og-image.png',
        width: 1200,
        height: 630,
        alt: 'EDGAR Terminal — dark interface showing financial analysis with amber charts',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'EDGAR Terminal — SEC Filings & Financial Data Explorer',
    description:
      'Free, source-linked explorer for SEC filings, XBRL financials, insider trading, and peer comparisons.',
    images: ['https://secedgarterminal.com/og-image.png'],
  },
  icons: {
    // Inline SVG favicon — matches index.html, no extra HTTP request
    icon: [
      {
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%231c1917'/%3E%3Crect x='15' y='60' width='14' height='25' fill='%23fbbf24'/%3E%3Crect x='35' y='45' width='14' height='40' fill='%23fbbf24'/%3E%3Crect x='55' y='30' width='14' height='55' fill='%23fbbf24'/%3E%3Crect x='75' y='15' width='14' height='70' fill='%23fbbf24'/%3E%3C/svg%3E",
        type: 'image/svg+xml',
      },
    ],
  },
};

// ============================================================================
// Viewport — Next.js 16 requires theme-color and viewport config separately
// from metadata. This is a breaking change from Next.js 14 that was flagged
// in the Next.js 15 release notes.
// ============================================================================
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1.0,
  themeColor: '#1c1917',
};

// ============================================================================
// JSON-LD Structured Data — Schema.org WebApplication markup
// Matches the <script type="application/ld+json"> block from index.html
// verbatim. Helps Google render rich results for the homepage.
// ============================================================================
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'EDGAR Terminal',
  alternateName: 'SEC EDGAR Terminal',
  url: 'https://secedgarterminal.com/',
  description:
    'Free, source-linked explorer for SEC filings, XBRL financial data, insider trading, and peer comparisons.',
  applicationCategory: 'FinanceApplication',
  operatingSystem: 'Any (web-based)',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
  featureList: [
    'SEC filings browser with 10-K, 10-Q, 8-K, Form 4, and proxy support',
    'XBRL financial statements (income, balance sheet, cash flow)',
    'Industry-specific ratio calculations',
    '10-year stock price history with filing markers',
    'Form 4 insider trading activity',
    'Peer comparison with up to 5 companies',
    'Source-linked data — every number traces to SEC.gov',
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Inline JSON-LD for Schema.org structured data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="bg-stone-950">
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
