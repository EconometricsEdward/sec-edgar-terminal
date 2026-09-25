import { Activity, ArrowDown, FileCheck2, GitCompareArrows, Layers3 } from "lucide-react";
import Link from "next/link";
import { buildPageMetadata } from "../../utils/siteMetadata";
import CompanySearch from "./CompanySearch";
import AnalysisDirectory from "./AnalysisDirectory";
import { isCftcEnabled } from "../../utils/cftcFeature.js";
import base from "./analysis.module.css";
import styles from "./AnalysisLanding.module.css";
import { getActiveSecCoverageCompanies, loadSecCoverageRegistry } from "../../utils/secCoverageRegistry.js";
import { buildAnalysisDirectory } from "../../utils/analysisDirectory.js";

export const revalidate = 3600;
export const metadata = buildPageMetadata({
  title: "Financial Analysis — SEC Company Research",
  description: "Analyze SEC company statements and public broker-dealer X-17A-5 filings. Search by name, ticker or CIK for financial ratios and original filing evidence.",
  path: "/analysis",
});

export default async function AnalysisIndexPage() {
  const cftcEnabled = isCftcEnabled();
  await loadSecCoverageRegistry();
  const sectors = buildAnalysisDirectory(getActiveSecCoverageCompanies());
  return (
    <div className={`${base.page} ${styles.page}`}>
      <section className={styles.hero} aria-labelledby="analysis-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span aria-hidden="true" /> SEC / Company analysis</p>
          <h1 id="analysis-title">Understand the company.<br /><span>Follow the evidence.</span></h1>
          <p className={styles.intro}>A clearer view of the business, from financial statements to the forces behind them. Start with a company.</p>
          <div className={styles.searchArea}><CompanySearch /></div>
          <p className={styles.searchHint}>Company tickers and broker-dealer filings · Search exact SEC registrants by CIK</p>
        </div>
        <div className={styles.evidenceVisual} aria-hidden="true">
          <div className={styles.visualOrbit} />
          <div className={`${styles.document} ${styles.documentBack}`}><span>03 / Cash flow</span><div /><div /><div /></div>
          <div className={`${styles.document} ${styles.documentMiddle}`}><span>02 / Balance sheet</span><div /><div /><div /></div>
          <div className={`${styles.document} ${styles.documentFront}`}><FileCheck2 size={28} /><span>01 / Income statement</span><strong>Every figure.<br />A source to follow.</strong><div /><div /><p>SEC filings <span>↗</span></p></div>
          <span className={styles.visualCaption}>PUBLIC DATA. TRACEABLE RESEARCH.</span>
        </div>
      </section>
      <div className={styles.capabilities} aria-label="Available company analysis tools">
        <Link href="/analysis/banks"><Layers3 size={18} aria-hidden="true" /> BankScope · FFIEC <span aria-hidden="true">↗</span></Link>
        <span><Layers3 size={18} aria-hidden="true" /> Financial statements</span>
        <span><Activity size={18} aria-hidden="true" /> Growth &amp; cash flow</span>
        <Link href="/analysis/scenarios" prefetch={false}><GitCompareArrows size={18} aria-hidden="true" /> Scenario methodology <span aria-hidden="true">↗</span></Link>
        {cftcEnabled && <span><ArrowDown size={18} aria-hidden="true" /> CFTC market context</span>}
      </div>
      <AnalysisDirectory sectors={sectors} />
    </div>
  );
}
