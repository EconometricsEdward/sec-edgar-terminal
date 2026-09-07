import type { Metadata } from "next";
import { Suspense } from "react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import FundsWorkspace from "./FundsWorkspace";
export const metadata: Metadata = buildPageMetadata({
  title: "Mutual Funds & ETFs — Portfolio Research Workspace",
  description:
    "Screen SEC fund portfolios, find shared securities, compare reporting dates, model fund allocations, track holdings changes, and save research with its source evidence.",
  path: "/fund",
});
export default function FundIndexPage() {
  return (
    <Suspense fallback={<p role="status">Opening fund research…</p>}>
      <FundsWorkspace />
    </Suspense>
  );
}
