import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import Link from "next/link";
import { Suspense } from "react";
import { TrendingUp } from "lucide-react";
import { Providers } from "./providers";
import NavTabs from "../components/NavTabs";
import HeaderSearchWrapper from "../components/HeaderSearchWrapper";
import CompanyContext from "../components/site/CompanyContext";
import ServiceStatus from "../components/site/ServiceStatus";
import ReadingPreferences from "../components/site/ReadingPreferences";
import { READING_BOOTSTRAP_SCRIPT } from "../utils/readingPreferences.js";
import styles from "../components/site/SiteShell.module.css";
import "./globals.css";
import "./reading-preferences.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://secedgarterminal.com"),
  title: {
    default: "EDGAR Terminal - SEC Filings & Financial Data Explorer",
    template: "%s | EDGAR Terminal",
  },
  description:
    "Explore SEC filings, source-linked financials, company risks, peers, and fund holdings. Keep evidence and notes in a connected research workspace. No account required.",
  keywords: [
    "SEC filings",
    "10-K",
    "10-Q",
    "XBRL",
    "EDGAR",
    "financial analysis",
    "insider trading",
    "Form 4",
    "peer comparison",
    "stock analysis",
    "public company data",
  ],
  authors: [{ name: "EDGAR Terminal" }],
  manifest: "/manifest.webmanifest",
  robots: {
    index: true,
    follow: true,
  },
  alternates: {
    canonical: "https://secedgarterminal.com/",
  },
  openGraph: {
    type: "website",
    url: "https://secedgarterminal.com/",
    title: "EDGAR Terminal - SEC Filings & Financial Data Explorer",
    description:
      "Explore SEC filings and source-linked financial data, compare companies, and keep your research evidence connected.",
    siteName: "EDGAR Terminal",
    locale: "en_US",
    images: [
      {
        url: "https://secedgarterminal.com/og-image.png",
        width: 1200,
        height: 630,
        alt: "EDGAR Terminal - professional SEC filings research terminal interface",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "EDGAR Terminal - SEC Filings & Financial Data Explorer",
    description:
      "Free, source-linked explorer for SEC filings, XBRL financials, insider trading, and peer comparisons.",
    images: ["https://secedgarterminal.com/og-image.png"],
  },
  icons: {
    icon: [
      {
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%23070a12'/%3E%3Cpath d='M21 73V51h10v22H21Zm16 0V39h10v34H37Zm16 0V28h10v45H53Zm16 0V18h10v55H69Z' fill='%23f59e0b'/%3E%3C/svg%3E",
        type: "image/svg+xml",
      },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1.0,
  themeColor: "#070a12",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "EDGAR Terminal",
  alternateName: "SEC EDGAR Terminal",
  url: "https://secedgarterminal.com/",
  description:
    "Free, source-linked explorer for SEC filings, XBRL financial data, insider trading, and peer comparisons.",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Any (web-based)",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  featureList: [
    "SEC filings browser with archive coverage, integrated reader, and report comparisons",
    "Source-linked financial statements, period comparisons, and transparent calculations",
    "Industry-specific credit, liquidity, capital, and earnings risk analysis",
    "Peer comparisons for up to five public companies",
    "Disclosure queries, passage comparisons, and evidence collections",
    "Historical reported fund holdings and portfolio comparisons",
    "Connected watchlists, research notes, evidence search, and portable backups",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme-tone="14" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: READING_BOOTSTRAP_SCRIPT }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        <Providers>
          <div className={styles.shell}>
            <a href="#main-content" className={styles.skipLink}>
              Skip to main content
            </a>
            <header className={styles.header} data-site-header>
              <div className={styles.headerInner}>
                <div className={styles.headerTop}>
                  <Link
                    href="/"
                    className={styles.brand}
                    aria-label="EDGAR Terminal home"
                  >
                    <span className={styles.brandMark}>
                      <TrendingUp
                        size={20}
                        strokeWidth={2.8}
                        aria-hidden="true"
                      />
                    </span>
                    <span>
                      <span className={styles.brandName}>
                        EDGAR<span>/</span>Terminal
                      </span>
                      <span className={styles.brandCaption}>
                        Public data. Traceable research.
                      </span>
                    </span>
                  </Link>
                  <div className={styles.search}>
                    <HeaderSearchWrapper />
                  </div>
                  <div className={styles.utilities}>
                    <ServiceStatus />
                    <ReadingPreferences />
                  </div>
                </div>
                <Suspense fallback={<div style={{ height: 47 }} />}>
                  <NavTabs />
                </Suspense>
              </div>
            </header>
            <main id="main-content" tabIndex={-1} className={styles.main}>
              <Suspense fallback={null}>
                <CompanyContext />
              </Suspense>
              {children}
            </main>
            <footer className={styles.footer}>
              <div className={styles.footerContent}>
                <div>
                  SEC.gov sources · Public EDGAR APIs · XBRL financial facts
                  <br />
                  Free access · No account required · Research use only
                </div>
                <nav aria-label="Footer navigation">
                  <Link href="/workspace" prefetch={false}>
                    Research Hub
                  </Link>
                  <Link href="/help" prefetch={false}>
                    Research guide
                  </Link>
                  <Link href="/about" prefetch={false}>
                    About &amp; methodology
                  </Link>
                  <a
                    href="https://www.sec.gov/edgar/search/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    SEC EDGAR ↗
                  </a>
                </nav>
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
