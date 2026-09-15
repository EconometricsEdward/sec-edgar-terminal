import type { Metadata } from "next";
import { Suspense } from "react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import FundsWorkspace from "./FundsWorkspace";
export const metadata: Metadata = buildPageMetadata({
  title: "Funds & Institutional Managers — N-PORT and 13F Research",
  description:
    "Explore SEC 13F manager holdings and N-PORT fund portfolios. See concentration, compare quarterly reported positions, and follow the source filings behind every snapshot.",
  path: "/fund",
});
export default function FundIndexPage() {
  return (
    <Suspense fallback={<p role="status">Opening fund research…</p>}>
      <FundsWorkspace />
    </Suspense>
  );
}
