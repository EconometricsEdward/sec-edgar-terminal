import type { Metadata } from "next";
import { cache, Suspense } from "react";
import { unstable_cache } from "next/cache";
import { notFound } from "next/navigation";
import AnalysisWorkspace from "./AnalysisWorkspace";
import AnalysisResearchBrief from "../AnalysisResearchBrief";
import { buildPageMetadata } from "../../../utils/siteMetadata";
import { isCftcEnabled } from "../../../utils/cftcFeature.js";
import { ANALYSIS_VERSION, ANALYSIS_MAPPING_VERSION } from "../../../utils/analysisVersion.js";
import { publicAnalysisSelection, readPublicAnalysis } from "../../../utils/analysisPublicResearch.js";
import { readAnalysisSettings } from "../../../utils/analysisNotebook.js";
import { getActiveSecCoverageCompany, loadSecCoverageRegistry } from "../../../utils/secCoverageRegistry.js";
import { loadBrokerDealerResearch } from "../../../utils/brokerDealerResearch.js";
import BrokerDealerWorkspace from "../../../components/broker-dealer/BrokerDealerWorkspace";
import { brokerDealerResearchPayload } from "../../../utils/brokerDealerPayload.js";
import CompanySearch from "../CompanySearch";
import base from "../analysis.module.css";

export const runtime = "nodejs";
export const maxDuration = 300;

const cikIdentifier = (value: string) => /^(?!0+$)\d{1,10}$/.test(value) ? value.padStart(10, "0") : null;
const readBrokerMetadata = cache(async (cik: string, accession: string, archive: string, filed: string, document: string) => {
  try { return await loadBrokerDealerResearch(cik, { metadataOnly: true, accession, archive, filed, document }); }
  catch (error: any) { return { status: "unavailable", company: null, error: error?.status === 404 ? "This filing could not be verified for the selected SEC registrant." : "SEC annual-report discovery is temporarily unavailable. Retry or open the original filings." }; }
});
const readBrokerResearch = cache(async (cik: string, accession: string, archive: string, filed: string, document: string) => {
  try { return await loadBrokerDealerResearch(cik, { accession, archive, filed, document }); }
  catch { return null; }
});

// Only current selections enter the Next cache: one concise result per issuer
// and basis. Personal tool settings and historical dates never create entries.
const readLatest = unstable_cache(async (ticker: string, basis: string) => {
  const result = await readPublicAnalysis({ ticker, basis, end: "", asOf: "" });
  if (result.status !== "ready") throw new Error("Analysis summary is not prepared");
  return result;
}, ["public-analysis-summary-v1", ANALYSIS_VERSION, ANALYSIS_MAPPING_VERSION], { revalidate: 60 });
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
  if (["basis", "end", "asOf", "accession", "archive", "filed", "document"].some(key => Array.isArray(query[key]))) return null;
  const selected = publicAnalysisSelection({ ticker, basis: query.basis || "annual", end: query.end || "", asOf: query.asOf || "" });
  if (!selected) return null;
  if (/^\d+$/.test(selected.ticker) && !cikIdentifier(selected.ticker)) return null;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (typeof value === "string") search.set(key, value);
  return { selected, settings: readAnalysisSettings(search), custom: Object.keys(query).some(key => key !== "basis"),
    brokerSelectors: [query.accession || "", query.archive || "", query.filed || "", query.document || ""] as [string, string, string, string] };
}
export async function generateMetadata(props: Props): Promise<Metadata> {
  const choice = await selection(props);
  if (!choice) return { title: "Analysis selection unavailable", robots: { index: false } };
  const { selected, custom } = choice;
  const cik = cikIdentifier(selected.ticker);
  if (cik) {
    const discovery: any = await readBrokerMetadata(cik, ...choice.brokerSelectors);
    const available = discovery?.status === "available";
    return { ...buildPageMetadata({
      title: `${discovery?.company?.name || `CIK ${cik}`} — Broker-Dealer Annual Report Analysis`,
      description: "Explore public SEC X-17A-5 broker-dealer statements, five-period financial trends, capital and funding ratios, peer comparisons and dated CFTC market context with original sources.",
      path: `/analysis/${cik}`,
    }), ...(!available || custom || selected.basis !== "annual" ? { robots: { index: false, follow: true } } : {}) };
  }
  // HTML-only research agents receive metadata and the same request-memoized
  // brief together. Analysis has no ancestor loading boundary, so the brief
  // remains visible HTML while the interactive workspace can stream separately.
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
  const cik = cikIdentifier(selected.ticker);
  if (cik) {
    const discovery: any = await readBrokerMetadata(cik, ...choice.brokerSelectors);
    const unsupported = selected.basis !== "annual" || selected.end || selected.asOf;
    const research: any = !unsupported && discovery?.status === "available"
      ? await readBrokerResearch(cik, ...choice.brokerSelectors) : null;
    const company = discovery?.company;
    const filing = research?.filing || discovery?.filing;
    const canonical = `https://secedgarterminal.com/analysis/${cik}`;
    return <div className={base.page} id="analysis-workspace">
      {company && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
        "@context": "https://schema.org", "@graph": [{ "@type": "Organization", "@id": `${canonical}#registrant`, name: company.name,
          identifier: { "@type": "PropertyValue", propertyID: "SEC CIK", value: cik }, url: canonical,
          sameAs: [`https://www.sec.gov/edgar/browse/?CIK=${cik}`] },
        ...(filing ? [{ "@type": "Report", name: `${company.name} — ${filing.form || "X-17A-5"} annual report`,
          about: { "@id": `${canonical}#registrant` }, datePublished: filing.filingDate,
          ...(filing.reportDate ? { temporalCoverage: filing.reportDate } : {}),
          identifier: filing.accessionNumber || filing.accession,
          url: research?.selectedDocument?.url || filing.documentUrl || canonical,
          description: "Public broker-dealer annual-report disclosures and source-linked financial analysis." }] : [])],
      }).replace(/</g, "\\u003c") }} />}
      <header className={base.companyHeader}><div><p className={base.eyebrow}>SEC / Broker-dealer annual reports</p>
        <h1>{company?.name || `SEC registrant ${cik}`}</h1><p className={base.muted}>CIK {cik} · Public X-17A-5 financial statements</p></div><CompanySearch compact /></header>
      <nav className={base.inline} aria-label="Broker-dealer research links"><a href={`/filings/${cik}`}>All SEC filings</a><a href={`/reports?q=${cik}`}>Prepare latest PDF or Excel report</a>
        {!choice.custom && selected.basis === "annual" && <a href={`/api/v1/analysis/${cik}`}>Source-linked JSON</a>}
        <a href={`https://www.sec.gov/edgar/browse/?CIK=${cik}`} target="_blank" rel="noreferrer">Original SEC registrant</a></nav>
      {unsupported ? <p className={base.notice}>Public X-17A-5 analysis uses annual reports. Quarterly, trailing-twelve-month and historical-cutoff figures are not inferred from these statements. <a href={`/analysis/${cik}`}>Open annual-report analysis</a>.</p>
        : discovery?.status !== "available" ? <p className={base.notice}>{discovery?.error || "No public X-17A-5 annual report was found in the SEC submission history checked for this exact registrant. Other company filings may still be available."} <a href={`/filings/${cik}`}>Inspect SEC filings</a>.</p>
          : <>
            {!research && <p className={base.notice}>The annual report is available, but its document could not be analyzed at this time. Retry or open the original SEC filing.</p>}
            <BrokerDealerWorkspace key={`${cik}:${choice.brokerSelectors.join(":")}`} cik={cik} explicitSelection={!!choice.brokerSelectors[0]} initialResearch={brokerDealerResearchPayload(research)} discovery={{
              status: discovery.status, company: company ? { cik: company.cik, name: company.name, ticker: company.ticker } : null,
              filing: discovery.filing, filings: discovery.filings || [], coverage: discovery.coverage,
            }} />
            {discovery.coverage?.complete === false && <p className={base.muted}>The checked SEC submission history is bounded. Older reports may be available in the registrant’s full filing history.</p>}
          </>}
    </div>;
  }
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
    <Suspense fallback={<p role="status">Opening the financial analysis workspace…</p>}>
    <AnalysisWorkspace urlTicker={selected.ticker} preloadedCik={company?.cik || ("cik" in summary ? summary.cik : null)}
      preloadedCompanyName={company?.name || summary.name || null} preloadedSicDescription={null}
      initialSettings={settings} cftcEnabled={isCftcEnabled()} />
    </Suspense>
  </>;
}
