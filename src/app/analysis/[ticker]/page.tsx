import type { Metadata } from "next";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { notFound } from "next/navigation";
import AnalysisWorkspace from "./AnalysisWorkspace";
import AnalysisResearchBrief from "../AnalysisResearchBrief";
import { buildPageMetadata } from "../../../utils/siteMetadata";
import { isCftcEnabled } from "../../../utils/cftcFeature.js";
import { publicAnalysisSelection, readPublicAnalysis } from "../../../utils/analysisPublicResearch.js";
import { readAnalysisSettings } from "../../../utils/analysisNotebook.js";
import { getActiveSecCoverageCompany, loadSecCoverageRegistry } from "../../../utils/secCoverageRegistry.js";

export const runtime = "nodejs";
export const maxDuration = 30;

// Only current selections enter the Next cache: one concise result per issuer
// and basis. Personal tool settings and historical dates never create entries.
const readLatest = unstable_cache(async (ticker: string, basis: string) => {
  const result = await readPublicAnalysis({ ticker, basis, end: "", asOf: "" });
  if (result.status !== "ready") throw new Error("Analysis summary is not prepared");
  return result;
}, ["public-analysis-summary-v1"], { revalidate: 60 });
const readSummary = cache(async (ticker: string, basis: string, end: string, asOf: string) => {
  if (end || asOf) return readPublicAnalysis({ ticker, basis, end, asOf });
  return readLatest(ticker, basis).catch(() => null);
});
interface Props {
  params: Promise<{ ticker: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}
async function selection({ params, searchParams }: Props) {
  const [{ ticker }, query] = await Promise.all([params, searchParams]);
  if (["basis", "end", "asOf"].some(key => Array.isArray(query[key]))) return null;
  const selected = publicAnalysisSelection({ ticker, basis: query.basis || "annual", end: query.end || "", asOf: query.asOf || "" });
  if (!selected) return null;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (typeof value === "string") search.set(key, value);
  return { selected, settings: readAnalysisSettings(search), custom: Object.keys(query).some(key => key !== "basis") };
}
export async function generateMetadata(props: Props): Promise<Metadata> {
  const choice = await selection(props);
  if (!choice) return { title: "Analysis selection unavailable", robots: { index: false } };
  const { selected, custom } = choice;
  // For HTML-only research agents, blocking metadata holds the initial shell
  // until this same request-memoized brief is ready. Otherwise the root loading
  // boundary can place financial text in a hidden, JS-completed stream chunk.
  await Promise.all([
    loadSecCoverageRegistry(),
    readSummary(selected.ticker, selected.basis, selected.end, selected.asOf).catch(() => null),
  ]);
  const company = getActiveSecCoverageCompany(selected.ticker);
  const path = `/analysis/${selected.ticker}${selected.basis !== "annual" ? `?basis=${selected.basis}` : ""}` as `/${string}`;
  return { ...buildPageMetadata({
    title: `${company?.name || selected.ticker} (${selected.ticker}) — Financial Analysis & SEC Sources`,
    description: "Read dated SEC financial highlights, reported and calculated metrics, comparable prior periods and original filings. Explore the complete financial analysis workspace.",
    path,
  }), ...(!company || custom ? { robots: { index: false, follow: true } } : {}) };
}
export default async function AnalysisTickerPage(props: Props) {
  const choice = await selection(props);
  if (!choice) notFound();
  const { selected, settings } = choice;
  const [result] = await Promise.all([
    readSummary(selected.ticker, selected.basis, selected.end, selected.asOf).catch(() => null),
    loadSecCoverageRegistry(),
  ]);
  const company = getActiveSecCoverageCompany(selected.ticker);
  const summary = result || { status: "not-prepared", ticker: selected.ticker, name: company?.name || selected.ticker,
    basis: selected.basis, asOf: selected.asOf, selectedEnd: selected.end,
    reason: "A verified financial summary is temporarily unavailable. The full workspace can still load research.",
    metrics: [], sourceCatalog: [], limitations: [] };
  return <>
    {company && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
      "@context": "https://schema.org", "@type": "Corporation", name: company.name, tickerSymbol: selected.ticker,
      identifier: { "@type": "PropertyValue", propertyID: "SEC CIK", value: company.cik },
      url: `https://secedgarterminal.com/analysis/${selected.ticker}`,
      sameAs: [`https://www.sec.gov/edgar/browse/?CIK=${company.cik}`],
    }).replace(/</g, "\\u003c") }} />}
    <AnalysisResearchBrief summary={summary} selection={selected} hidden={settings.baseline !== "year"} />
    <AnalysisWorkspace urlTicker={selected.ticker} preloadedCik={company?.cik || ("cik" in summary ? summary.cik : null)}
      preloadedCompanyName={company?.name || summary.name || null} preloadedSicDescription={null}
      initialSettings={settings} cftcEnabled={isCftcEnabled()} />
  </>;
}
