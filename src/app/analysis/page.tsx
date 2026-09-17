import { Activity, ArrowDown, FileCheck2, GitCompareArrows, Layers3 } from "lucide-react";
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
  description: "Search companies, explore SEC financial statements, understand growth and cash flow, and test ratios and scenarios. Browse a small sample of companies by sector and industry.",
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
          <p className={styles.searchHint}>Search the SEC ticker directory · No account required</p>
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
        <span><Layers3 size={18} aria-hidden="true" /> Financial statements</span>
        <span><Activity size={18} aria-hidden="true" /> Growth &amp; cash flow</span>
        <span><GitCompareArrows size={18} aria-hidden="true" /> Ratios &amp; scenarios</span>
        {cftcEnabled && <span><ArrowDown size={18} aria-hidden="true" /> CFTC market context</span>}
      </div>
      <AnalysisDirectory sectors={sectors} />
    </div>
  );
}
