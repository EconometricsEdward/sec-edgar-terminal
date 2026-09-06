import type { Metadata } from "next";
import CompareClient from "./[tickers]/CompareClient";
import { buildPageMetadata } from "../../utils/siteMetadata";

// ============================================================================
// Metadata — static, since this page has no ticker list yet
// ============================================================================
export const metadata: Metadata = {
  ...buildPageMetadata({
    title: "Peer Comparison — Compare SEC Filings & Financials",
    description:
      "Compare five public companies using aligned annual, quarterly, and trailing-year financials, industry-aware metrics, peer medians, trends, source evidence, and exportable research.",
    path: "/compare",
  }),
};

// ============================================================================
// /compare with no tickers — render the same client component with empty
// initial list. The client handles the peer-group picker, ticker input, and
// URL syncing as users add companies.
// ============================================================================
export default function CompareIndexPage() {
  return <CompareClient initialTickers={[]} preloadedCompanies={[]} />;
}
