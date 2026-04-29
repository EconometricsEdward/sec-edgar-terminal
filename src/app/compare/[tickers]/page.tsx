import type { Metadata } from 'next';
import CompareClient, { type PreloadedCompany } from './CompareClient';

// ============================================================================
// Route configuration
//
// Hourly revalidation. Submissions data updates throughout the day, but the
// company name + CIK is essentially static. Hourly is plenty fresh.
// ============================================================================
export const revalidate = 3600;

const MAX_COMPANIES = 5;

// ============================================================================
// Types
// ============================================================================
interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

interface CompanyTickersFile {
  [key: string]: CompanyTickerEntry;
}

interface SECSubmissionsLite {
  name: string;
  cik: string;
  sicDescription?: string;
}

interface PageProps {
  params: Promise<{ tickers: string }>;
}

// ============================================================================
// Parse comma-delimited tickers from the URL
//
// Handles both literal commas and percent-encoded commas (%2C). Caps at
// MAX_COMPANIES, filters empties, normalizes to upper case.
// ============================================================================
function parseTickers(raw: string): string[] {
  const decoded = decodeURIComponent(raw || '');
  return decoded
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, MAX_COMPANIES);
}

// ============================================================================
// Server-side ticker map fetch (cached at the CDN for 1 day)
// ============================================================================
async function getTickerMap(): Promise<Map<string, { cik: string; name: string }>> {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) return new Map();

  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': userAgent },
      next: { revalidate: 86400 },
    });
    if (!res.ok) return new Map();
    const data = (await res.json()) as CompanyTickersFile;
    const map = new Map<string, { cik: string; name: string }>();
    for (const entry of Object.values(data)) {
      if (entry?.ticker && entry.cik_str) {
        map.set(entry.ticker.toUpperCase(), {
          cik: String(entry.cik_str).padStart(10, '0'),
          name: entry.title,
        });
      }
    }
    return map;
  } catch (err) {
    console.error('[compare/[tickers]] ticker-map fetch failed:', err);
    return new Map();
  }
}

// ============================================================================
// Resolve each requested ticker to a company name + CIK. Used for both
// metadata and to pre-populate the client with name/cik so the client
// doesn't have to wait for the ticker map before rendering.
// ============================================================================
async function resolveCompanies(tickers: string[]): Promise<PreloadedCompany[]> {
  if (tickers.length === 0) return [];
  const map = await getTickerMap();
  return tickers
    .map((ticker) => {
      const entry = map.get(ticker);
      if (!entry) return null;
      return { ticker, cik: entry.cik, name: entry.name };
    })
    .filter((c): c is PreloadedCompany => c !== null);
}

// ============================================================================
// generateMetadata — per-comparison title, description, canonical
// ============================================================================
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { tickers: rawTickers } = await params;
  const tickers = parseTickers(rawTickers);

  if (tickers.length === 0) {
    return {
      title: 'Peer Comparison — Compare SEC Filings & Financials',
      description:
        'Compare up to 5 public companies side-by-side. 10 years of financial data from SEC XBRL filings.',
    };
  }

  const tickersVsLabel = tickers.join(' vs ');
  const tickersPath = tickers.join(',');

  // Try to enrich the description with company names if they resolve, but
  // don't block the response if SEC is slow — fall back to ticker symbols.
  const companies = await resolveCompanies(tickers);
  const namedDescription =
    companies.length > 0
      ? `Compare ${companies.map((c) => c.name).join(', ')} (${tickersVsLabel}) side-by-side across 10 fiscal years. Revenue, net income, margins, ROE, ROA, and growth rates from SEC XBRL filings.`
      : `Compare ${tickersVsLabel} side-by-side across 10 fiscal years. Revenue, net income, margins, ROE, ROA, and growth rates from SEC XBRL filings.`;

  const title = `${tickersVsLabel} — Side-by-Side Financial Comparison`;
  const canonical = `https://secedgarterminal.com/compare/${tickersPath}`;

  return {
    title,
    description: namedDescription,
    alternates: { canonical },
    openGraph: {
      title,
      description: namedDescription,
      url: canonical,
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: namedDescription,
    },
  };
}

// ============================================================================
// Page component — server-rendered shell + client island
// ============================================================================
export default async function CompareTickersPage({ params }: PageProps) {
  const { tickers: rawTickers } = await params;
  const tickers = parseTickers(rawTickers);
  const preloadedCompanies = await resolveCompanies(tickers);

  return (
    <CompareClient
      initialTickers={tickers}
      preloadedCompanies={preloadedCompanies}
    />
  );
}
