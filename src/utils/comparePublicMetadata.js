import { MAX_COMPARE_COMPANIES } from "./compareLimits.js";

// Keep discovery finite: other peer selections remain shareable and have a
// stable canonical URL without creating an index of every possible combination.
export const FEATURED_COMPARE_GROUPS = Object.freeze([
  { label: "Large technology companies", tickers: "AAPL,MSFT,GOOGL,META,AMZN" },
  { label: "Major U.S. banks", tickers: "JPM,BAC,WFC,C,GS" },
  { label: "Semiconductor companies", tickers: "NVDA,AMD,INTC,AVGO,QCOM" },
]);

export const COMPARE_DESCRIPTION = `Compare up to ${MAX_COMPARE_COMPANIES} public companies using aligned annual, quarterly, and trailing-year SEC financials. Inspect industry-aware metrics, peer benchmarks, trends, reporting dates, and original filings. Coverage varies by company and metric.`;

/** Route validation must not silently discard malformed or excess peers. */
export function comparePageSelection(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 300) return null;
  // Next can pass the page an encoded path segment while metadata receives its
  // decoded value. Decode once before validating; encoded slashes and double
  // encodings still fail the ticker grammar below.
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  const tokens = decoded.split(",").map(value => value.trim().toUpperCase());
  if (tokens.some(value => !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(value) || !/[A-Z]/.test(value))) return null;
  const tickers = [...new Set(tokens)];
  if (tickers.length > MAX_COMPARE_COMPANIES) return null;
  const joined = tickers.join(",");
  return {
    tickers,
    path: `/compare/${joined}`,
    featured: FEATURED_COMPARE_GROUPS.some(group => group.tickers === joined),
  };
}

export function comparePageMetadata(selection, searchParams = {}) {
  if (!selection) return {
    title: "Comparison selection unavailable",
    description: COMPARE_DESCRIPTION,
    path: "/compare",
    index: false,
  };
  const label = selection.tickers.length > 5
    ? `${selection.tickers.slice(0, 4).join(", ")} + ${selection.tickers.length - 4} peers`
    : selection.tickers.join(" vs ");
  return {
    title: `${label} — SEC Financial Comparison`,
    description: `Compare ${selection.tickers.join(", ")} using aligned SEC financial statements, company-appropriate ratios, peer benchmarks, and original filing sources. Available history and metric coverage vary by company.`,
    path: selection.path,
    index: selection.featured && Object.keys(searchParams).length === 0,
  };
}
