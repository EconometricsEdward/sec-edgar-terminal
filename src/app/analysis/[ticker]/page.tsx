import type { Metadata } from 'next';
import AnalysisClient from './AnalysisClient';

// ============================================================================
// Route configuration
//
// Submissions data updates throughout the day, but the company name + CIK
// (which is all we need server-side) is essentially static. Hourly is plenty
// fresh and keeps the Vercel CDN layer effective.
// ============================================================================
export const revalidate = 3600;

// ============================================================================
// Types
// ============================================================================
interface SECSubmissionsLite {
  name: string;
  cik: string;
  sicDescription?: string;
  exchanges?: string[];
}

interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

interface CompanyTickersFile {
  [key: string]: CompanyTickerEntry;
}

interface PageProps {
  params: Promise<{ ticker: string }>;
}

interface CompanyMeta {
  ticker: string;
  cik: string;
  name: string;
  sicDescription: string | null;
  exchange: string | null;
}

// ============================================================================
// Server-side ticker → CIK lookup
//
// Per our B+C strategy: we fetch just enough server-side to make the
// metadata useful (company name + CIK). The bulk of the financial data
// continues to load client-side from the existing /api/sec proxy.
// ============================================================================
async function getCikForTicker(ticker: string): Promise<string | null> {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) {
    console.error('[analysis/[ticker]] SEC_USER_AGENT env var is not set');
    return null;
  }

  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': userAgent },
      next: { revalidate: 86400 },
    });
    if (!res.ok) {
      console.error(`[analysis/[ticker]] ticker-map fetch returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as CompanyTickersFile;
    const upper = ticker.toUpperCase();
    for (const entry of Object.values(data)) {
      if (entry?.ticker?.toUpperCase() === upper) {
        return String(entry.cik_str).padStart(10, '0');
      }
    }
    return null;
  } catch (err) {
    console.error('[analysis/[ticker]] ticker-map fetch failed:', err);
    return null;
  }
}

// ============================================================================
// Server-side submissions fetch (lightweight — just the top-level metadata)
// ============================================================================
async function getCompanyMeta(ticker: string): Promise<CompanyMeta | null> {
  const upper = ticker.toUpperCase();
  const cik = await getCikForTicker(upper);
  if (!cik) return null;

  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) return null;

  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': userAgent },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SECSubmissionsLite;

    return {
      ticker: upper,
      cik,
      name: data.name || upper,
      sicDescription: data.sicDescription || null,
      exchange: data.exchanges?.[0] || null,
    };
  } catch (err) {
    console.error('[analysis/[ticker]] submissions fetch failed:', err);
    return null;
  }
}

// ============================================================================
// generateMetadata — the SEO payoff. Per-page title/description/canonical
// renders server-side so Googlebot sees correct metadata before any JS runs.
// ============================================================================
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { ticker } = await params;
  const upper = ticker.toUpperCase();
  const meta = await getCompanyMeta(upper);

  if (!meta) {
    return {
      title: `${upper} — Financial Analysis`,
      description: `Financial analysis for ticker ${upper}.`,
    };
  }

  const title = `${meta.name} (${upper}) — Financial Analysis & Ratios`;
  const description = `10-year financial analysis for ${meta.name} (${upper}). Revenue, net income, operating margin, ROE, ROA, and industry-specific ratios sourced directly from SEC XBRL filings. Includes stock chart with filing markers, insider trading, and institutional holders.`;
  const canonical = `https://secedgarterminal.com/analysis/${upper}`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

// ============================================================================
// JSON-LD Schema.org markup
//
// Adds structured-data block describing the company so Google can render
// rich SERP results. Per our B+C strategy: server-rendered, real values
// (not generic boilerplate). Each company gets a unique payload.
// ============================================================================
function buildJsonLd(meta: CompanyMeta): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Corporation',
    name: meta.name,
    tickerSymbol: meta.ticker,
    identifier: {
      '@type': 'PropertyValue',
      propertyID: 'SEC CIK',
      value: meta.cik,
    },
    ...(meta.sicDescription && { industry: meta.sicDescription }),
    url: `https://secedgarterminal.com/analysis/${meta.ticker}`,
    sameAs: [`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${meta.cik}`],
    subjectOf: {
      '@type': 'WebPage',
      '@id': `https://secedgarterminal.com/analysis/${meta.ticker}`,
      name: `${meta.name} Financial Analysis`,
      description: `SEC XBRL financial data and analysis for ${meta.name}`,
    },
  };
}

// ============================================================================
// Page component — server-rendered shell + client island
//
// We pass the resolved ticker and CIK as props rather than re-fetching
// client-side. This shaves one network round-trip off the client load and
// guarantees the client and server agree on the company identity.
// ============================================================================
export default async function AnalysisTickerPage({ params }: PageProps) {
  const { ticker } = await params;
  const upper = ticker.toUpperCase();
  const meta = await getCompanyMeta(upper);

  // If the ticker doesn't resolve at all, render the client with no preload
  // and let it surface its own "not found" error message. This keeps error
  // UX consistent with the old client-side behavior.
  if (!meta) {
    return (
      <AnalysisClient
        urlTicker={upper}
        preloadedCik={null}
        preloadedCompanyName={null}
        preloadedSicDescription={null}
      />
    );
  }

  const jsonLd = buildJsonLd(meta);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <AnalysisClient
        urlTicker={upper}
        preloadedCik={meta.cik}
        preloadedCompanyName={meta.name}
        preloadedSicDescription={meta.sicDescription}
      />
    </>
  );
}
