import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import Link from 'next/link';
import { Database, ShieldCheck, TrendingUp } from 'lucide-react';
import { Providers } from './providers';
import NavTabs from '../components/NavTabs';
import HeaderSearchWrapper from '../components/HeaderSearchWrapper';
import ThemeToneSlider from '../components/ThemeToneSlider';
import FloatingNavRail from '../components/FloatingNavRail';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://secedgarterminal.com'),
  title: {
    default: 'EDGAR Terminal - SEC Filings & Financial Data Explorer',
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
  manifest: '/manifest.webmanifest',
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
    title: 'EDGAR Terminal - SEC Filings & Financial Data Explorer',
    description:
      'Free, source-linked explorer for SEC filings, XBRL financials, insider trading, and peer comparisons. Every number cites its SEC source.',
    siteName: 'EDGAR Terminal',
    locale: 'en_US',
    images: [
      {
        url: 'https://secedgarterminal.com/og-image.png',
        width: 1200,
        height: 630,
        alt: 'EDGAR Terminal - professional SEC filings research terminal interface',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'EDGAR Terminal - SEC Filings & Financial Data Explorer',
    description:
      'Free, source-linked explorer for SEC filings, XBRL financials, insider trading, and peer comparisons.',
    images: ['https://secedgarterminal.com/og-image.png'],
  },
  icons: {
    icon: [
      {
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%23070a12'/%3E%3Cpath d='M21 73V51h10v22H21Zm16 0V39h10v34H37Zm16 0V28h10v45H53Zm16 0V18h10v55H69Z' fill='%23f59e0b'/%3E%3C/svg%3E",
        type: 'image/svg+xml',
      },
    ],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1.0,
  themeColor: '#070a12',
};

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
    'SEC filings browser with source-linked filing pulse, 10-K, 10-Q, 8-K, Form 4, and proxy support',
    'XBRL financial statements (income, balance sheet, cash flow)',
    'Industry-specific ratio calculations',
    '10-year stock price history with filing markers',
    'Form 4 insider trading activity',
    'Peer comparison with up to 5 companies',
    'Disclosure keyword search with source-linked SEC excerpts, EDGAR index source windows, and filer concentration',
    'Source-linked data - every number traces to SEC.gov',
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme-tone="14">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        <Providers>
          <div className="min-h-screen overflow-x-hidden bg-[#070a12] text-slate-100 antialiased">
            <div className="pointer-events-none fixed inset-0 -z-10">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.16),transparent_32rem),radial-gradient(circle_at_top_right,rgba(59,130,246,0.12),transparent_30rem),linear-gradient(180deg,#070a12_0%,#0b1020_48%,#070a12_100%)]" />
              <div className="absolute inset-0 opacity-[0.05] [background-image:linear-gradient(rgba(255,255,255,.8)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.8)_1px,transparent_1px)] [background-size:56px_56px]" />
            </div>

            <header className="sticky top-0 z-40 border-b border-white/10 bg-[#070a12]/88 backdrop-blur-2xl">
              <div className="mx-auto max-w-[1480px] px-4 py-3 sm:px-6 lg:px-8">
                <div className="grid gap-3 xl:grid-cols-[minmax(260px,380px)_minmax(360px,680px)_auto] xl:items-center xl:gap-5">
                  <div className="flex min-w-0 items-center justify-between gap-4">
                    <Link href="/" className="group flex min-w-0 items-center gap-3">
                      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-amber-300/30 bg-amber-400 text-slate-950 shadow-lg shadow-amber-950/40 transition-transform duration-300 group-hover:-translate-y-0.5">
                        <TrendingUp className="h-5 w-5" strokeWidth={3} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-base font-black tracking-tight text-white sm:text-lg">
                          EDGAR<span className="text-amber-300">/</span>Terminal
                        </div>
                        <div className="hidden text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 sm:block">
                          SEC research OS · Source-linked public-company data
                        </div>
                      </div>
                    </Link>

                    <div className="hidden items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-200 md:flex xl:hidden">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,.9)]" />
                      Live SEC data
                    </div>
                  </div>

                  <div className="order-3 w-full xl:order-2">
                    <HeaderSearchWrapper />
                  </div>

                  <div className="order-2 flex flex-wrap items-center justify-start gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 sm:justify-end xl:order-3 xl:flex-nowrap">
                                        <ThemeToneSlider />
                    <div className="hidden rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-emerald-200 xl:block">
                      <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,.9)]" />
                      Live SEC data
                    </div>
                    <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-2">
                      <Database className="mr-1.5 inline h-3.5 w-3.5 text-amber-300" />
                      data.sec.gov
                    </div>
                    <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-2">
                      <ShieldCheck className="mr-1.5 inline h-3.5 w-3.5 text-sky-300" />
                      Source-linked
                    </div>
                  </div>
                </div>

                <NavTabs />
              </div>
            </header>

            <FloatingNavRail />

            <main className="mx-auto max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
              {children}
            </main>

            <footer className="mx-auto max-w-[1480px] px-4 pb-10 sm:px-6 lg:px-8">
              <div className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-white/[0.025] px-5 py-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                <span>Data via SEC.gov Â· Public EDGAR APIs Â· XBRL Financial Facts</span>
                <span>Research use only Â· Not investment advice</span>
                <span>Free Â· No account required</span>
              </div>
            </footer>
          </div>
        </Providers>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}



