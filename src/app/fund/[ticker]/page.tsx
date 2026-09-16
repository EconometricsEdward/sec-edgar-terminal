import type { Metadata } from "next";
import { cache, Suspense } from "react";
import { notFound } from "next/navigation";
import { unstable_cache } from "next/cache";
import { buildPageMetadata, SITE_URL } from "../../../utils/siteMetadata";
import { FUND_CATALOG } from "../../../utils/fundResearch";
import { publicFundSelection } from "../../../utils/fundPublicSelectors.js";
import { readPublicFundSummary } from "../../../utils/fundPublicResearch.js";
import FundResearchBrief, { type PublicFundSummary } from "../FundResearchBrief";
import FundClient from "./FundClient";
export const runtime = "nodejs";
export const maxDuration = 15;
// Metadata and visible research share one read, including temporary misses.
const readSummary = cache(unstable_cache(
  async (ticker: string, accession: string) => {
    const summary = await readPublicFundSummary(ticker, accession) as PublicFundSummary | null;
    // Do not retain an empty result after the interactive loader prepares it.
    if (summary?.status !== "ready") throw new Error("Fund summary is not prepared");
    return summary;
  },
  ["public-nport-fund-summary-v1"], { revalidate: 60 },
));
interface Props {
  params: Promise<{ ticker: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}
async function selection({ params, searchParams }: Props) {
  const [{ ticker }, query] = await Promise.all([params, searchParams]);
  if (Array.isArray(query?.accession)) return null;
  return publicFundSelection(ticker, query?.accession ?? "");
}
export async function generateMetadata(props: Props): Promise<Metadata> {
  const selected = await selection(props);
  if (!selected) return { title: "Fund report unavailable", robots: { index: false } };
  const { ticker, accession } = selected;
  const summary = await readSummary(ticker, accession).catch(() => null);
  const name = summary?.name || FUND_CATALOG.find((f) => f.ticker === ticker)?.name || ticker;
  const reportDate = summary?.reportDate;
  const metadata = buildPageMetadata({
    title: `${name} (${ticker}) — Holdings${reportDate ? `, ${reportDate}` : " & Portfolio Research"}`,
    description: `${ticker} SEC N-PORT fund portfolio${reportDate ? ` as of ${reportDate}` : ""}: reported positions, net assets, concentration and original source filings. Holdings cover the reported fund series.`,
    path: `/fund/${ticker}${accession ? `?accession=${accession}` : ""}`,
  });
  return { ...metadata,
    alternates: { ...metadata.alternates, types: { "application/json": `${SITE_URL}/api/v1/funds/${ticker}${accession ? `?accession=${accession}` : ""}` } },
    ...((accession || !FUND_CATALOG.some(fund => fund.ticker === ticker)) && summary?.status !== "ready" ? { robots: { index: false } } : {}) };
}
export default async function FundPage(props: Props) {
  const selected = await selection(props);
  if (!selected) notFound();
  const { ticker, accession } = selected;
  const result = await readSummary(ticker, accession).catch(() => null);
  const summary: PublicFundSummary = result || {
    kind: "nport", status: "unavailable", ticker,
    name: FUND_CATALOG.find(fund => fund.ticker === ticker)?.name || ticker,
    stale: false, valueLabel: "Net assets", topHoldings: [], sources: [],
    limitations: ["N-PORT coverage depends on the fund’s legal structure and public SEC reporting. A missing prepared report is not a finding that the fund has no positions."],
    reason: accession ? `A prepared summary for accession ${accession} is not available.` : "A verified summary is not currently available.",
    interactiveUrl: "#fund-workspace", summaryUrl: `/fund/${ticker}${accession ? `?accession=${accession}` : ""}`,
  };
  return (
    <>
      <FundResearchBrief summary={{ ...summary, interactiveUrl: "#fund-workspace" }} canonicalPath={`/fund/${ticker}${accession ? `?accession=${accession}` : ""}`} jsonUrl={`/api/v1/funds/${ticker}${accession ? `?accession=${accession}` : ""}`} />
      <div id="fund-workspace">
        <Suspense fallback={<p role="status">Opening fund research…</p>}>
          <FundClient key={ticker} urlTicker={ticker} selectedAccession={accession} preparedSummaryReady={summary.status === "ready"} />
        </Suspense>
      </div>
    </>
  );
}
