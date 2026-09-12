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
import { isCftcEnabled } from "../utils/cftcFeature.js";
import styles from "../components/site/SiteShell.module.css";
import "./globals.css";
import "./reading-preferences.css";

const cftcMetadataEnabled = isCftcEnabled();

export const metadata: Metadata = {
  metadataBase: new URL("https://secedgarterminal.com"),
  title: {
    default: cftcMetadataEnabled ? "EDGAR Terminal - SEC Research & CFTC Positioning" : "EDGAR Terminal - Source-Linked SEC Research",
    template: "%s | EDGAR Terminal",
  },
  description:
    cftcMetadataEnabled ? "Explore SEC filings, source-linked financials, official CFTC futures positioning, company risks, peers, and fund holdings. No account required." : "Explore SEC filings, source-linked financials, company risks, peers, and fund holdings. No account required.",
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
    ...(cftcMetadataEnabled ? ["CFTC Commitments of Traders"] : []),
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
    title: cftcMetadataEnabled ? "EDGAR Terminal - SEC Research & CFTC Positioning" : "EDGAR Terminal - Source-Linked SEC Research",
    description:
      cftcMetadataEnabled ? "Explore SEC filings, source-linked financial data, and official CFTC futures positioning while keeping research evidence connected." : "Explore SEC filings and source-linked financial data while keeping research evidence connected.",
    siteName: "EDGAR Terminal",
    locale: "en_US",
    images: [
      {
        url: "https://secedgarterminal.com/opengraph-image",
        width: 1200,
        height: 630,
        alt: cftcMetadataEnabled ? "EDGAR Terminal - source-linked SEC research and separate official CFTC positioning" : "EDGAR Terminal - source-linked SEC research",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: cftcMetadataEnabled ? "EDGAR Terminal - SEC Research & CFTC Positioning" : "EDGAR Terminal - Source-Linked SEC Research",
    description:
      cftcMetadataEnabled ? "Free, source-linked SEC research with separate official CFTC Commitments of Traders positioning." : "Free, source-linked SEC filing and financial research.",
    images: ["https://secedgarterminal.com/opengraph-image"],
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
    "Free, source-linked explorer for SEC filings, XBRL financial data, official CFTC futures positioning, and peer comparisons.",
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
    "Peer comparisons for up to 12 public companies",
    "Disclosure queries, passage comparisons, and evidence collections",
    "Historical reported fund holdings and portfolio comparisons",
    "Portfolio research, company comparisons, SEC evidence, and research exports",
    "Official futures-only CFTC Commitments of Traders positioning with report-family, contract, date, and formula provenance",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cftcEnabled = isCftcEnabled();
  return (
    <html lang="en" data-theme-tone="14" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: READING_BOOTSTRAP_SCRIPT }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(cftcEnabled ? jsonLd : { ...jsonLd, description: "Free, source-linked explorer for SEC filings, XBRL financial data, and peer comparisons.", featureList: jsonLd.featureList.filter(item => !item.startsWith("Official futures-only CFTC")) }) }}
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
                    <HeaderSearchWrapper cftcEnabled={cftcEnabled} />
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
            <footer className={styles.footer} data-site-footer>
              <div className={styles.footerContent}>
                <div>
                  SEC.gov sources · Public EDGAR APIs{cftcEnabled && " · Official CFTC COT data"}
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
                  <a
                    href="https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    CFTC COT ↗
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
