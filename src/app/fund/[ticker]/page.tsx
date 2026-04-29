import type { Metadata } from 'next';
import FundClient from './FundClient';

// ============================================================================
// Route configuration
//
// Hourly revalidation. Fund metadata changes rarely; holdings updates are
// quarterly. Hourly is more than enough for the metadata layer.
// ============================================================================
export const revalidate = 3600;

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

interface CompanyTickerMfEntry {
  cik: number;
  seriesId: string;
  classId: string;
  symbol: string;
}

// SEC's company_tickers_mf.json has a different shape than company_tickers.json
// It uses a "data" array with rows: [cik, seriesId, classId, symbol]
interface CompanyTickersMfFile {
  fields: string[];
  data: [number, string, string, string][];
}

interface PageProps {
  params: Promise<{ ticker: string }>;
}

interface ResolvedFund {
  ticker: string;
  cik: string;
  name: string;
  isLikelyFund: boolean;
}

// ============================================================================
// Server-side ticker → CIK + name resolution
//
// Tries SEC's mutual fund file first (company_tickers_mf.json), then falls
// back to the standard company file (company_tickers.json). The mutual fund
// file is the authoritative source for known mutual funds; ETFs are split
// across both files inconsistently.
// ============================================================================
async function resolveFund(ticker: string): Promise<ResolvedFund | null> {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) return null;
  const upper = ticker.toUpperCase();

  // Try mutual fund file first
  try {
    const mfRes = await fetch('https://www.sec.gov/files/company_tickers_mf.json', {
      headers: { 'User-Agent': userAgent },
      next: { revalidate: 86400 },
    });
    if (mfRes.ok) {
      const mfData = (await mfRes.json()) as CompanyTickersMfFile;
      for (const row of mfData.data || []) {
        const [cik, , , symbol] = row;
        if (symbol?.toUpperCase() === upper) {
          // Mutual fund file doesn't include the company name — fetch from
          // submissions endpoint to get it. This is rare enough that we
          // don't sweat the extra round-trip.
          const padded = String(cik).padStart(10, '0');
          const subRes = await fetch(`https://data.sec.gov/submissions/CIK${padded}.json`, {
            headers: { 'User-Agent': userAgent },
            next: { revalidate: 3600 },
          });
          const name = subRes.ok ? (await subRes.json())?.name || upper : upper;
          return { ticker: upper, cik: padded, name, isLikelyFund: true };
        }
      }
    }
  } catch (err) {
    console.error('[fund/[ticker]] mf-file fetch failed:', err);
  }

  // Fall back to standard ticker file (catches ETFs not in the MF file)
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': userAgent },
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CompanyTickersFile;
    for (const entry of Object.values(data)) {
      if (entry?.ticker?.toUpperCase() === upper) {
        return {
          ticker: upper,
          cik: String(entry.cik_str).padStart(10, '0'),
          name: entry.title,
          // Not necessarily a fund — could be an operating company. The
          // client will use checkIsFund() to verify on mount.
          isLikelyFund: false,
        };
      }
    }
    return null;
  } catch (err) {
    console.error('[fund/[ticker]] ticker-file fetch failed:', err);
    return null;
  }
}

// ============================================================================
// generateMetadata — per-fund title + description
// ============================================================================
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { ticker } = await params;
  const upper = ticker.toUpperCase();
  const resolved = await resolveFund(upper);

  if (!resolved) {
    return {
      title: `${upper} — Fund Holdings`,
      description: `Fund holdings and net assets for ticker ${upper}.`,
    };
  }

  const title = `${resolved.name} (${upper}) — Holdings & Net Assets`;
  const description = `Latest holdings, net assets (AUM), and SEC N-PORT filings for ${resolved.name} (${upper}). Top positions, asset class breakdown, and fund family data.`;
  const canonical = `https://secedgarterminal.com/fund/${upper}`;

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
// Page component — server-rendered shell + client island
// ============================================================================
export default async function FundTickerPage({ params }: PageProps) {
  const { ticker } = await params;
  const upper = ticker.toUpperCase();
  const resolved = await resolveFund(upper);

  return (
    <FundClient
      urlTicker={upper}
      preloadedName={resolved?.name ?? null}
      preloadedCik={resolved?.cik ?? null}
    />
  );
}
