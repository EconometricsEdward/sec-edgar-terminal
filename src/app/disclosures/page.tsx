import type { Metadata } from "next";
import DisclosureSearchClient from "./DisclosureSearchClient";
import { buildPageMetadata } from "../../utils/siteMetadata";

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: "SEC Disclosure Search — Company Filings & Original Passages",
    description:
      "Search SEC filings by company, ticker, topic, or exact phrase. Read matching passages in context, compare wording, and trace results to original SEC sources.",
    path: "/disclosures",
  }),
};

// The landing page does not fetch research. Serve its real search form from
// the CDN; the browser restores URL filters and linked passages after hydration.
export const revalidate = 3600;

export default function DisclosuresPage() {
  // Serialize the render date so cached HTML and the first browser render agree,
  // even across UTC midnight. The client refreshes default dates on mount.
  const initialToday = new Date().toISOString().slice(0, 10);
  return <DisclosureSearchClient initialToday={initialToday} />;
}
