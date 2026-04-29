import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import Link from 'next/link';
import { TrendingUp } from 'lucide-react';
import { Providers } from './providers';
import NavTabs from '../components/NavTabs';
import HeaderSearchWrapper from '../components/HeaderSearchWrapper';
import './globals.css';

// ============================================================================
// Metadata — unchanged from the previous layout.tsx. Per-page overrides will
// come later via generateMetadata on each app/<route>/page.tsx.
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
    // Inline SVG favicon — matches original, no extra HTTP request
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
// Helps Google render rich results for the homepage.
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

// ============================================================================
// Root layout
//
// Renders the site chrome (background grid, header with logo + nav + optional
// search, main content, footer) around every page. This is the server
// component; client interactivity (nav active state, search) is delegated to
// small client-component children (NavTabs, HeaderSearchWrapper).
//
// The old App.jsx rendered this same chrome inside a BrowserRouter. Now that
// Next.js owns routing, the chrome moves up to the layout so every route
// inherits it automatically and the server can render it for SEO.
// ============================================================================
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
        <Providers>
          <div className="min-h-screen bg-stone-950 text-stone-100 font-mono">
            {/* Background grid — decorative, pointer-events-none so it doesn't block clicks */}
            <div
              className="fixed inset-0 opacity-[0.03] pointer-events-none"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
                backgroundSize: '40px 40px',
              }}
            />

            <div className="relative max-w-6xl mx-auto px-6 py-10">
              {/* Header */}
              <header className="border-b-2 border-stone-800 pb-6 mb-8">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <Link href="/" className="group">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-10 h-10 bg-amber-500 flex items-center justify-center group-hover:bg-amber-400 transition-colors">
                        <TrendingUp className="w-6 h-6 text-stone-950" strokeWidth={3} />
                      </div>
                      <h1 className="text-3xl md:text-4xl font-black tracking-tight uppercase">
                        EDGAR<span className="text-amber-500">/</span>Terminal
                      </h1>
                    </div>
                    <p className="text-xs text-stone-400 uppercase tracking-[0.2em]">
                      SEC Public Filings Explorer · Live Data · Direct Source
                    </p>
                  </Link>
                  <div className="text-right text-[10px] text-stone-500 uppercase tracking-widest">
                    <div>Source: data.sec.gov</div>
                    <div>Rate: 10 req/sec max</div>
                  </div>
                </div>

                <NavTabs />

                {/* Global search — hidden on landing, shown everywhere else */}
                <HeaderSearchWrapper />
              </header>

              {/* Page content */}
              {children}

              {/* Footer */}
              <footer className="mt-12 pt-6 border-t-2 border-stone-800 text-[10px] uppercase tracking-widest text-stone-500 flex flex-wrap justify-between gap-2">
                <span>Data via SEC.gov · Public EDGAR APIs · XBRL Financial Facts</span>
                <span>For research use only · Not investment advice</span>
              </footer>
            </div>
          </div>
        </Providers>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
