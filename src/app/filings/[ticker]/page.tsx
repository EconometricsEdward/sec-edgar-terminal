import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import FilingsClient from "./FilingsClient";
import { buildPageMetadata, SITE_URL } from "../../../utils/siteMetadata";
import { getOperatingTicker } from "../../../utils/tickerMap.js";
import { validTicker } from "../../../utils/researchWorkspace.js";
import { normalizeCikIdentifier } from "../../../utils/siteRoutes.js";
import { loadFilingsCompany } from "../../../utils/filingsResearchServer.js";
import { loadBrokerDealerResearch } from "../../../utils/brokerDealerResearch.js";
import styles from "../filings.module.css";

export const revalidate = 3600;
type PageProps = { params: Promise<{ ticker: string }> };

// Metadata and the visible source directory share one bounded submission-history
// lookup. This path never fetches annual-report PDFs or starts text extraction.
const readFilerMetadata = cache(async (cik: string) => {
  try { return await loadBrokerDealerResearch(cik, { metadataOnly: true }); }
  catch {
    try { return { status: "unavailable", company: await loadFilingsCompany(cik), filings: [], coverage: null }; }
    catch { return null; }
  }
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const raw = (await params).ticker.trim().toUpperCase();
  const cik = normalizeCikIdentifier(raw);
  const ticker = cik || raw;
  let name = ticker;
  let brokerDealer = false;
  if (cik) {
    const discovery = await readFilerMetadata(cik);
    name = discovery?.company?.name || ticker;
    brokerDealer = discovery?.status === "available";
  } else if (validTicker(ticker)) {
    try {
      const entry = await getOperatingTicker(ticker);
      name = entry?.name || ticker;
    } catch {
      /* The explorer reports retriable SEC lookup failures. */
    }
  }
  return buildPageMetadata({
    title: brokerDealer ? `${name} — X-17A-5 Broker-Dealer Annual Reports` : `${name} (${cik ? "CIK " : ""}${ticker}) — SEC Filings`,
    description: brokerDealer
      ? `Find ${name} public broker-dealer annual reports by SEC CIK ${cik}. Open X-17A-5 financial-statement PDFs, inspect available figures and follow original SEC sources.`
      : `Search ${name} SEC filings, inspect archive coverage, compare reports, and collect source-linked evidence in your filing review workspace.`,
    path: `/filings/${encodeURIComponent(ticker)}`,
  });
}

function annualReportPath(cik: string, filing: any) {
  const query = new URLSearchParams({ accession: filing.accession, view: "analytics" });
  if (filing.archive) query.set("archive", filing.archive);
  if (filing.filingDate) query.set("filed", filing.filingDate);
  return `/filings/${cik}?${query}`;
}

export default async function FilingsTickerPage({ params }: PageProps) {
  const raw = (await params).ticker.trim().toUpperCase();
  const cik = normalizeCikIdentifier(raw);
  const ticker = cik || raw;
  const discovery: any = cik ? await readFilerMetadata(cik) : null;
  const reports: any[] = discovery?.status === "available" ? discovery.filings.slice(0, 8) : [];
  const canonical = `${SITE_URL}/filings/${ticker}`;
  const company = discovery?.company;
  return <>
    {cik && reports.length > 0 && <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", "@id": `${canonical}#registrant`, name: company.name,
            identifier: { "@type": "PropertyValue", propertyID: "SEC CIK", value: cik },
            sameAs: [`https://www.sec.gov/edgar/browse/?CIK=${cik}`] },
          { "@type": "ItemList", "@id": `${canonical}#annual-reports`, name: `${company.name} public X-17A-5 annual reports`,
            url: canonical, numberOfItems: reports.length, itemListOrder: "https://schema.org/ItemListOrderDescending",
            itemListElement: reports.map((filing, index) => ({ "@type": "ListItem", position: index + 1,
              item: { "@type": "Report", name: `${company.name} ${filing.form} — filed ${filing.filingDate}`,
                identifier: filing.accession, datePublished: filing.filingDate,
                ...(filing.reportDate ? { temporalCoverage: filing.reportDate } : {}),
                about: { "@id": `${canonical}#registrant` }, url: filing.indexUrl,
                description: "Public broker-dealer annual-report filing. Financial-statement coverage depends on the documents disclosed." },
            })),
          },
        ],
      }).replace(/</g, "\\u003c") }} />
      <section className={styles.sourceBrief} aria-label="Public broker-dealer annual report sources">
        <div><span>Public X-17A-5 annual reports · CIK {cik}</span><Link href={`/analysis/${cik}`} prefetch={false}>Explore financial analysis ↗</Link></div>
        <details><summary>Recent annual-report sources for {company.name}</summary>
          <p>The SEC submission history identifies these public annual reports for this exact legal entity. Open a filing to select its financial-statement PDF and inspect supported financial figures. Confidential FOCUS submissions are not included.</p>
          <ul>{reports.map(filing => <li key={filing.accession}>
            <Link href={annualReportPath(cik, filing)} prefetch={false}>{filing.form} · {filing.reportDate ? `Period ${filing.reportDate}` : "Period not supplied"} · Filed {filing.filingDate}</Link>
            <a href={filing.indexUrl} target="_blank" rel="noopener noreferrer">SEC filing &amp; exhibits ↗</a>
          </li>)}</ul>
          <p>Showing {reports.length} of {discovery.filings.length} annual filings identified in the checked submission history. {discovery.coverage?.complete === false ? "History coverage is incomplete; additional reports may be available in older archives." : "Load older archives in the filing workspace to extend the visible history."}</p>
        </details>
      </section>
    </>}
    <FilingsClient key={ticker} ticker={ticker} />
  </>;
}
