import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import FilingsClient, { type FilingEntry, type CompanyInfo } from './FilingsClient';

// ============================================================================
// Route configuration
//
// Revalidate the cache hourly. SEC filings update throughout the day, but
// companies typically file a handful of documents per week — hourly is more
// than fresh enough, and it keeps the Vercel CDN layer effective.
// ============================================================================
export const revalidate = 3600;

// ============================================================================
// Types — mirror what's on SEC's /submissions endpoint
// ============================================================================
interface SECSubmissions {
  name: string;
  cik: string;
  sic?: string;
  sicDescription?: string;
  exchanges?: string[];
  tickers?: string[];
  fiscalYearEnd?: string;
  stateOfIncorporation?: string;
  ein?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription?: string[];
      size?: number[];
      items?: string[];
    };
  };
}

interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

interface CompanyTickersFile {
  [key: string]: CompanyTickerEntry;
}

// ============================================================================
// Server-side ticker → CIK lookup
//
// We fetch SEC's public ticker file directly, server-side. This is much simpler
// than trying to reuse the client-side tickerMapLoader (which uses the /api/sec
// proxy, intended for browser requests). On the server, we go straight to
// www.sec.gov with a proper User-Agent.
//
// Next.js's fetch() layer caches this automatically at the CDN, so after the
// first request, subsequent requests across all tickers reuse the same data.
// ============================================================================
async function getCikForTicker(ticker: string): Promise<string | null> {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) {
    console.error('[filings/[ticker]] SEC_USER_AGENT env var is not set');
    return null;
  }

  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': userAgent },
      // Cache the ticker list for a day — it changes rarely
      next: { revalidate: 86400 },
    });
    if (!res.ok) {
      console.error(`[filings/[ticker]] ticker-map fetch returned ${res.status}`);
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
    console.error('[filings/[ticker]] ticker-map fetch failed:', err);
    return null;
  }
}

// ============================================================================
// Server-side submissions fetch
// ============================================================================
async function getSubmissions(cik: string): Promise<SECSubmissions | null> {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) return null;

  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': userAgent },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as SECSubmissions;
  } catch (err) {
    console.error('[filings/[ticker]] submissions fetch failed:', err);
    return null;
  }
}

// ============================================================================
// Transform raw SEC data into flat filing array (same shape as old code)
// ============================================================================
function flattenFilings(
  submissions: SECSubmissions,
  cik: string
): FilingEntry[] {
  const recent = submissions.filings?.recent;
  if (!recent) return [];

  const cikNumber = parseInt(cik, 10);

  return recent.accessionNumber.map((acc, i) => {
    const filingDate = recent.filingDate[i];
    const date = new Date(filingDate);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const quarter = `Q${Math.ceil(month / 3)}`;
    const accessionClean = acc.replace(/-/g, '');
    const primaryDoc = recent.primaryDocument[i];

    return {
      accession: acc,
      form: recent.form[i],
      filingDate,
      reportDate: recent.reportDate[i],
      year,
      quarter,
      primaryDoc,
      primaryDescription: recent.primaryDocDescription?.[i] || '',
      size: recent.size?.[i],
      items: recent.items?.[i] || '',
      documentUrl: `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accessionClean}/${primaryDoc}`,
    };
  });
}

// ============================================================================
// Page props — Next.js 15+ async params pattern
// ============================================================================
interface PageProps {
  params: Promise<{ ticker: string }>;
}

// ============================================================================
// generateMetadata — this is the SEO payoff. Runs server-side, sets per-page
// title/description/og so Google indexes each company's filings page
// distinctly. Replaces the old client-side <SEO> component.
// ============================================================================
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { ticker } = await params;
  const upper = ticker.toUpperCase();

  const cik = await getCikForTicker(upper);
  if (!cik) {
    return {
      title: `${upper} — SEC Filings`,
      description: `SEC filings for ticker ${upper}.`,
    };
  }

  const submissions = await getSubmissions(cik);
  const companyName = submissions?.name || upper;

  const title = `${companyName} (${upper}) — SEC Filings`;
  const description = `Complete SEC filing history for ${companyName} (${upper}). Browse 10-Ks, 10-Qs, 8-Ks, Form 4s, and proxy statements. Direct links to original documents on SEC.gov.`;

  return {
    title,
    description,
    alternates: {
      canonical: `https://secedgarterminal.com/filings/${upper}`,
    },
    openGraph: {
      title,
      description,
      url: `https://secedgarterminal.com/filings/${upper}`,
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
// Page component — server-rendered shell + client island
// ============================================================================
export default async function FilingsTickerPage({ params }: PageProps) {
  const { ticker } = await params;
  const upper = ticker.toUpperCase();

  const cik = await getCikForTicker(upper);
  if (!cik) {
    // Render the "not recognized" error inline rather than a hard 404 — the
    // user is probably on the right track, just typo'd the ticker. This
    // matches the old FilingsPage behavior.
    return (
      <FilingsClient
        ticker={upper}
        company={null}
        filings={[]}
        errorMessage={`No SEC registrant found for "${upper}".`}
      />
    );
  }

  const submissions = await getSubmissions(cik);
  if (!submissions) {
    return (
      <FilingsClient
        ticker={upper}
        company={null}
        filings={[]}
        errorMessage={`Could not fetch SEC data for ${upper}.`}
      />
    );
  }

  const company: CompanyInfo = {
    name: submissions.name,
    cik,
    sic: submissions.sicDescription,
    exchanges: submissions.exchanges?.join(', ') || 'N/A',
    tickers: submissions.tickers?.join(', ') || upper,
    fiscalYearEnd: submissions.fiscalYearEnd,
    stateOfIncorporation: submissions.stateOfIncorporation,
    ein: submissions.ein,
  };

  const filings = flattenFilings(submissions, cik);

  return (
    <FilingsClient
      ticker={upper}
      company={company}
      filings={filings}
      errorMessage={null}
    />
  );
}
