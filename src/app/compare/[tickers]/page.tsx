import type { Metadata } from "next";
import { normalizeCompareTickers } from "../../../utils/compareNotebook.js";
import { getOperatingTickers } from "../../../utils/tickerMap.js";
import CompareClient, { type PreloadedCompany } from "./CompareClient";
import { buildPageMetadata } from "../../../utils/siteMetadata";

// ============================================================================
// Route configuration
//
// Hourly revalidation. Submissions data updates throughout the day, but the
// company name + CIK is essentially static. Hourly is plenty fresh.
// ============================================================================
export const revalidate = 3600;

interface PageProps {
  params: Promise<{ tickers: string }>;
}
function parseTickers(raw: string): string[] {
  return normalizeCompareTickers(raw);
}
// ============================================================================
// Resolve each requested ticker to a company name + CIK. Used for both
// metadata and to pre-populate the client with name/cik so the client
// doesn't have to wait for the ticker map before rendering.
// ============================================================================
async function resolveCompanies(
  tickers: string[],
): Promise<PreloadedCompany[]> {
  if (tickers.length === 0) return [];
  let entries: Record<string, { cik: string; name: string }> = {};
  try {
    entries = (await getOperatingTickers(tickers)) as Record<
      string,
      { cik: string; name: string }
    >;
  } catch {
    /* The client can retry an unavailable SEC directory. */
  }
  return tickers
    .map((ticker) => {
      const entry = entries[ticker];
      if (!entry) return null;
      return { ticker, cik: entry.cik, name: entry.name };
    })
    .filter((c): c is PreloadedCompany => c !== null);
}

// ============================================================================
// generateMetadata — per-comparison title, description, canonical
// ============================================================================
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { tickers: rawTickers } = await params;
  const tickers = parseTickers(rawTickers);

  if (tickers.length === 0) {
    return buildPageMetadata({
      title: "Peer Comparison — Compare SEC Filings & Financials",
      description:
        "Compare up to 5 public companies side-by-side. 10 years of financial data from SEC XBRL filings.",
      path: "/compare",
    });
  }

  const tickersVsLabel = tickers.join(" vs ");
  const tickersPath = tickers.join(",");

  // Try to enrich the description with company names if they resolve, but
  // don't block the response if SEC is slow — fall back to ticker symbols.
  const companies = await resolveCompanies(tickers);
  const namedDescription =
    companies.length > 0
      ? `Compare ${companies.map((c) => c.name).join(", ")} (${tickersVsLabel}) side-by-side across 10 fiscal years. Aligned annual, quarterly, and trailing-year financials, industry-aware metrics, peer benchmarks, and original SEC filing evidence.`
      : `Compare ${tickersVsLabel} side-by-side across 10 fiscal years. Aligned annual, quarterly, and trailing-year financials, industry-aware metrics, peer benchmarks, and original SEC filing evidence.`;

  const title = `${tickersVsLabel} — Side-by-Side Financial Comparison`;
  return buildPageMetadata({
    title,
    description: namedDescription,
    path: `/compare/${tickersPath}`,
  });
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
