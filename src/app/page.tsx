import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight, ArrowUpRight, Activity, BarChart3, BookOpen,
  FileSearch, FileText, GitCompareArrows, Globe2, Layers3, ShieldCheck,
} from "lucide-react";
import HomeResearch from "../components/site/HomeResearch";
import ResearchWorkflow from "../components/site/ResearchWorkflow";
import HomeStructuredData from "../components/site/HomeStructuredData";
import { isCftcEnabled } from "../utils/cftcFeature.js";
import { buildPageMetadata } from "../utils/siteMetadata";
import styles from "./home.module.css";

export const metadata: Metadata = buildPageMetadata({
  title: "Free SEC Filings, Financial Analysis & 13F Research",
  description: isCftcEnabled()
    ? "Research SEC filings, company financials, 13F fund holdings, sectors and CFTC positioning. Free tools with source links. No account required."
    : "Research SEC filings, company financials, 13F fund holdings and sector fundamentals. Free tools with source links. No account required.",
  path: "/",
});

const tools = [
  { title: "SEC Filings", icon: FileText, href: "/filings", text: "Go straight to the original 10-K, 10-Q or 8-K." },
  { title: "Financial Analysis", icon: BarChart3, href: "/analysis", text: "Connect statements, financial changes and scenarios." },
  { title: "Risk", icon: ShieldCheck, href: "/risk", text: "Examine credit, liquidity, capital and earnings." },
  { title: "Compare", icon: GitCompareArrows, href: "/compare", text: "Put up to 12 companies on a comparable footing." },
  { title: "Disclosures", icon: FileSearch, href: "/disclosures", text: "Find the language behind the reported numbers." },
  { title: "CFTC Positioning", icon: Activity, href: "/market?tab=positioning", text: "Explore futures positioning by participant and contract." },
];

export default function HomePage() {
  const cftcEnabled = isCftcEnabled();
  const availableTools = tools.filter(
    (tool) => cftcEnabled || tool.href !== "/market?tab=positioning",
  );
  return (
    <div className={styles.page}>
      <HomeStructuredData cftcEnabled={cftcEnabled} />
      <section className={styles.hero} aria-labelledby="home-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Independent research. Public data.</p>
          <h1 id="home-title">See the numbers.<br /><span>Find the story.</span></h1>
          <p className={styles.lead}>
            SEC filings are just the beginning. Connect company financials,
            institutional holdings and the wider market in one free research platform.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primary} href="/analysis" prefetch={false}>
              Research a company <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <Link className={styles.secondary} href="/workspace/demo" prefetch={false}>
              Explore the demo <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
          </div>
          <div className={styles.trust}>
            <span><ShieldCheck size={15} aria-hidden="true" /> Source-linked research</span>
            <span>Free access</span><span>No account required</span>
          </div>
        </div>
        <ResearchWorkflow />
      </section>

      <nav className={styles.sourceStrip} aria-label="Explore public datasets">
        <span className={styles.sourceStripLabel}>Public records.<br /><strong>A connected perspective.</strong></span>
        <Link href="/filings" prefetch={false}><span>SEC EDGAR</span><strong>Company filings</strong><ArrowUpRight size={15} aria-hidden="true" /></Link>
        <Link href="/fund?view=13f" prefetch={false}><span>FORM 13F</span><strong>Manager holdings</strong><ArrowUpRight size={15} aria-hidden="true" /></Link>
        <Link href="/fund" prefetch={false}><span>N-PORT</span><strong>Fund portfolios</strong><ArrowUpRight size={15} aria-hidden="true" /></Link>
        {cftcEnabled && <Link href="/market?tab=positioning" prefetch={false}><span>CFTC COT</span><strong>Futures positioning</strong><ArrowUpRight size={15} aria-hidden="true" /></Link>}
      </nav>

      <section aria-labelledby="explore-title">
        <div className={styles.sectionHeading}>
          <div><p className={styles.eyebrow}>Widen your perspective</p><h2 id="explore-title">A company never tells the whole story.</h2></div>
          <Link href="/help" prefetch={false}>Find your starting point <ArrowUpRight size={16} aria-hidden="true" /></Link>
        </div>
        <div className={styles.featureGrid}>
          <article className={`${styles.feature} ${styles.marketFeature}`}>
            <div className={styles.featureTop}><Globe2 size={24} strokeWidth={1.5} aria-hidden="true" /><span>01 / THE BIGGER PICTURE</span></div>
            <h3>Read the market.<br /><span>Beyond the headlines.</span></h3>
            <p>{cftcEnabled ? "Connect sector fundamentals with official futures positioning. See where growth, profitability and market participation diverge." : "Compare growth, profitability and cash generation across the SEC reporting universe. See where sectors and industries diverge."}</p>
            <div className={styles.marketLenses}>
              <Link href="/market?tab=sectors" prefetch={false}><BarChart3 size={18} aria-hidden="true" /><span><strong>Sector Performance</strong><small>Growth · Margins · Cash flow</small></span><ArrowUpRight size={16} aria-hidden="true" /></Link>
              {cftcEnabled && <Link href="/market?tab=positioning" prefetch={false}><Activity size={18} aria-hidden="true" /><span><strong>CFTC Positioning</strong><small>Contracts · Participants · Changes</small></span><ArrowUpRight size={16} aria-hidden="true" /></Link>}
            </div>
            <Link className={styles.featureLink} href="/market" prefetch={false}>Open Market Briefing <ArrowRight size={18} aria-hidden="true" /></Link>
          </article>

          <article className={`${styles.feature} ${styles.fundFeature}`}>
            <div className={styles.featureTop}><Layers3 size={24} strokeWidth={1.5} aria-hidden="true" /><span>02 / THE OWNERSHIP</span></div>
            <h3>Follow the<br />reported holdings.</h3>
            <p>Look inside institutional portfolios. Compare managers, shared positions and quarterly changes through SEC 13F reports.</p>
            <div className={styles.managerLinks}>
              <Link href="/fund/manager/0001067983" prefetch={false}><span>Berkshire Hathaway</span><ArrowUpRight size={15} aria-hidden="true" /></Link>
              <Link href="/fund/manager/0001350694" prefetch={false}><span>Bridgewater Associates</span><ArrowUpRight size={15} aria-hidden="true" /></Link>
            </div>
            <Link className={styles.featureLink} href="/fund?view=13f" prefetch={false}>Explore 13F funds <ArrowRight size={18} aria-hidden="true" /></Link>
          </article>

          <article className={`${styles.feature} ${styles.portfolioFeature}`}>
            <div className={styles.featureTop}><GitCompareArrows size={24} strokeWidth={1.5} aria-hidden="true" /><span>03 / YOUR PERSPECTIVE</span></div>
            <h3>Bring the<br />pieces together.</h3>
            <p>Understand portfolio concentration, compare financial profiles and investigate what changed across your companies.</p>
            <div className={styles.portfolioLinks}>
              <Link href="/workspace/demo" prefetch={false}><span>Explore the example portfolio</span><ArrowUpRight size={15} aria-hidden="true" /></Link>
              <Link href="/workspace/demo/changes" prefetch={false}><span>See what changed</span><ArrowUpRight size={15} aria-hidden="true" /></Link>
            </div>
            <Link className={styles.featureLink} href="/workspace" prefetch={false}>Open your Portfolio <ArrowRight size={18} aria-hidden="true" /></Link>
          </article>
        </div>
      </section>

      <section className={styles.toolSection} aria-labelledby="tools-title">
        <div className={styles.toolIntro}><p className={styles.eyebrow}>Go deeper</p><h2 id="tools-title">Follow a question.<br />Find the evidence.</h2><p>Every tool connects back to the public records behind the research.</p><Link href="/analysis/scenarios" prefetch={false}>Explore financial scenarios <ArrowUpRight size={16} aria-hidden="true" /></Link></div>
        <div className={styles.tools}>
          {availableTools.map((tool) => <Link href={tool.href} key={tool.title} prefetch={false} className={styles.tool}><tool.icon size={21} strokeWidth={1.6} aria-hidden="true" /><div><h3>{tool.title}</h3><p>{tool.text}</p></div><ArrowUpRight className={styles.toolArrow} size={16} aria-hidden="true" /></Link>)}
        </div>
      </section>

      <HomeResearch cftcEnabled={cftcEnabled} />

      <section className={styles.sourceNote} aria-labelledby="sources-title">
        <BookOpen size={27} strokeWidth={1.5} aria-hidden="true" />
        <div><h2 id="sources-title">Good research keeps the source in view.</h2><p>Financials and filings come from SEC records. Fund holdings reflect historical reporting dates{cftcEnabled && "; CFTC data describes futures positioning"}. Sector performance here means reported business fundamentals, not stock returns. Sources, dates and coverage matter.</p></div>
        <Link href="/help#coverage" prefetch={false}>How the data works <ArrowUpRight size={16} aria-hidden="true" /></Link>
      </section>
    </div>
  );
}
