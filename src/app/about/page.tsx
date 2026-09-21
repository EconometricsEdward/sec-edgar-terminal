import Link from "next/link";
import { ArrowRight, ArrowUpRight, FileText, Landmark } from "lucide-react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import styles from "./about.module.css";

export const metadata = buildPageMetadata({
  title: "About EDGAR Terminal — Purpose, Origins & Public Data Sources",
  description: "Explore EDGAR Terminal’s public sources and methodology: SEC company filings, broker-dealer annual reports, fund holdings and CFTC market reports.",
  path: "/about",
});

const AUDIENCES = [
  { name: "Analysts", description: "Investigate earnings, cash flow, funding and business exposures, with a path back to the reported inputs." },
  { name: "Investors", description: "Compare companies, understand fund holdings and explore the businesses behind a portfolio." },
  { name: "Students & educators", description: "Connect financial concepts to real statements, reporting periods and company disclosures." },
  { name: "Journalists & curious readers", description: "Find what a company reported, examine changes and check the original document." },
];

export default function AboutPage() {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>About EDGAR Terminal</p>
        <h1>Public information.<br /><span>A clearer view.</span></h1>
        <div className={styles.intro}>
          <p>EDGAR Terminal is a free financial research platform that brings company filings, public broker-dealer annual reports, financial statements, portfolio holdings and futures market context into one place.</p>
          <p>The goal is simple: make public information easier to find, compare and understand, while keeping the original sources close at hand.</p>
        </div>
        <div className={styles.heroFooter}>
          <Link href="/analysis" prefetch={false}>Explore company research <ArrowRight size={18} aria-hidden="true" /></Link>
          <p>Free research <span aria-hidden="true">/</span> No account needed for research <span aria-hidden="true">/</span> Public sources</p>
        </div>
      </header>

      <section className={styles.purpose} aria-labelledby="purpose-title" id="tools">
        <div><p className={styles.eyebrow}>Why it exists</p><h2 id="purpose-title">Less time gathering.<br />More time understanding.</h2></div>
        <div className={styles.prose}>
          <p>Public filings contain a wealth of information, but answering a question often means moving between reports, reconciling dates and rebuilding the same comparisons. EDGAR Terminal brings that work together in a connected research workspace.</p>
          <p>Use it to read financial statements, compare peers, search disclosure language, explore company risk and look inside reported fund portfolios. Portfolio tools connect those company insights to a group of holdings; CFTC data adds relevant market context.</p>
          <p>The site helps you investigate a question and form your own judgment. Financial figures, calculations and passages stay connected to their reporting context and source documents.</p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="audience-title">
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>Who it is for</p><h2 id="audience-title">For anyone who wants to look closer.</h2><p>You do not need an institutional terminal to begin asking better questions.</p></div>
        <div className={styles.audiences}>{AUDIENCES.map(item => <article key={item.name}><h3>{item.name}</h3><p>{item.description}</p></article>)}</div>
      </section>

      <section className={styles.origin} aria-labelledby="origin-title">
        <div className={styles.date}><p className={styles.eyebrow}>The beginning</p><span>April</span><strong>2026</strong><p>First recorded version<br /><time dateTime="2026-04-18">April 18, 2026</time></p></div>
        <div className={styles.prose}><h2 id="origin-title">Built from a question about access.</h2><p>How can public financial data become easier to use for everyday research?</p><p>The project’s recorded history begins on April 18, 2026, with company filings and financial analysis. It has since expanded into peer comparisons, disclosure search, portfolio research, fund holdings and CFTC market context.</p><p>Development continues around the same priorities: useful analysis, clearer presentation, reliable data mapping and free access to public information.</p><a className={styles.textLink} href="https://github.com/EconometricsEdward/sec-edgar-terminal/commit/346786e4c4231787dae0a336c0e1794234808e7e" target="_blank" rel="noopener noreferrer">View the first recorded version <ArrowUpRight size={15} aria-hidden="true" /></a></div>
      </section>

      <section id="sources" className={styles.section} aria-labelledby="sources-title">
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>Where the data comes from</p><h2 id="sources-title">Public records. Original sources.</h2><p>The core data comes from the U.S. Securities and Exchange Commission and the U.S. Commodity Futures Trading Commission.</p></div>
        <div className={styles.sourceRow}>
          <div className={styles.sourceIdentity}><FileText size={24} aria-hidden="true" /><h3>SEC EDGAR</h3><p>Company disclosures<br />& reported holdings</p></div>
          <div className={styles.sourceBody}>
            <div><h4>Filings & financial facts</h4><p>SEC submission records, structured XBRL financial data and filing documents supply company statements, reporting history and disclosure text, including annual, quarterly and current reports.</p></div>
            <div><h4>Broker-dealer annual reports</h4><p>Public Form X-17A-5 annual reports connect a broker-dealer’s legal filer name and CIK to its original financial-statement PDFs. Filings provides document access and available extracted text; Analysis presents available disclosed financial metrics with their source coverage. A parent company and its broker-dealer subsidiary can have different SEC identities. Coverage depends on the public documents and readable disclosures in each filing.</p><p><Link href="/filings?form=X-17A-5" prefetch={false}>Find a broker-dealer annual report <ArrowRight size={14} aria-hidden="true" /></Link></p></div>
            <div><h4>Funds & institutional managers</h4><p>Public N-PORT filings supply fund portfolio snapshots. Form 13F filings supply institutional managers’ holdings of reportable securities. These describe historical positions with their own reporting dates and coverage.</p></div>
            <div className={styles.sourceLinks}><a href="https://www.sec.gov/search-filings/edgar-application-programming-interfaces" target="_blank" rel="noopener noreferrer">SEC data APIs <ArrowUpRight size={14} aria-hidden="true" /></a><a href="https://www.sec.gov/edgar/search/" target="_blank" rel="noopener noreferrer">Original SEC filings <ArrowUpRight size={14} aria-hidden="true" /></a></div>
          </div>
        </div>
        <div className={styles.sourceRow}>
          <div className={styles.sourceIdentity}><Landmark size={24} aria-hidden="true" /><h3>CFTC</h3><p>Futures positioning<br />& broker financial reports</p></div>
          <div className={styles.sourceBody}>
            <div><h4>Commitments of Traders</h4><p>Official futures-only Traders in Financial Futures and Disaggregated reports show positioning by participant group. The site uses these as dated market context, keeping the report categories distinct.</p></div>
            <div><h4>Futures broker financial data</h4><p>CFTC financial reports provide reported capital and customer-funds information for the futures broker capital view. These firm-level financial reports are separate from market-wide positioning.</p></div>
            <div className={styles.sourceLinks}><a href="https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm" target="_blank" rel="noopener noreferrer">CFTC positioning reports <ArrowUpRight size={14} aria-hidden="true" /></a><a href="https://www.cftc.gov/MarketReports/financialfcmdata/index.htm" target="_blank" rel="noopener noreferrer">CFTC financial reports <ArrowUpRight size={14} aria-hidden="true" /></a></div>
          </div>
        </div>
      </section>

      <section id="coverage" className={styles.section} aria-labelledby="method-title">
        <div className={styles.sectionHeader}><p className={styles.eyebrow}>What the site adds</p><h2 id="method-title">From reported inputs to useful context.</h2></div>
        <div className={styles.methods}>
          <article><span>01</span><h3>Organize</h3><p>Connect companies, broker-dealers and funds to their SEC identities, filings, reporting periods and supported data fields.</p></article>
          <article><span>02</span><h3>Calculate & compare</h3><p>Turn reported inputs into ratios, growth measures, peer comparisons and portfolio summaries, with formulas and source context available.</p></article>
          <article><span>03</span><h3>Keep the context</h3><p>Show reporting dates, distinguish reported figures from calculations, and leave unsupported or incompatible inputs unavailable.</p></article>
        </div>
        <p className={styles.contextNote}>Reporting periods, filing dates and retrieval times mean different things. Company definitions can differ, fund holdings are historical, and CFTC positioning does not reveal an individual company’s exposure. The original record remains the place to verify a consequential figure or claim.</p>
      </section>

      <section className={styles.detailsSection} aria-label="Access, storage and support" id="workspace">
        <span id="keyboard" className={styles.anchor} />
        <details><summary>Free access & browser storage</summary><div><p>Public research is free and does not require an account.</p><p>Saved portfolios and preferences use this browser profile and do not automatically sync across devices. Share links preserve supported page selections, while an export provides a separate record of the results. Export local work before clearing site data.</p><p>Research requests are sent to the application to retrieve public data. Vercel Analytics and Speed Insights measure page usage and performance. Read the <Link href="/privacy" prefetch={false}>privacy notice</Link> and <Link href="/terms" prefetch={false}>service terms</Link>.</p></div></details>
        <details id="recovery"><summary>Availability & research limitations</summary><div><p>Coverage depends on the company, filing, reporting period and supported data fields. A missing value is not zero, and an empty search result does not establish that an event or exposure is absent. Retry failed requests and check dates and source coverage when something does not load.</p><p>EDGAR Terminal is an independent research and educational project, not an SEC or CFTC service. Its calculations and scenarios support research and do not constitute investment advice.</p></div></details>
      </section>

      <footer className={styles.closing}><div><p className={styles.eyebrow}>Public data. Traceable research.</p><h2>Bring your next question.</h2></div><div><Link href="/" prefetch={false}>Explore EDGAR Terminal <ArrowRight size={17} aria-hidden="true" /></Link><a href="https://github.com/EconometricsEdward/sec-edgar-terminal" target="_blank" rel="noopener noreferrer">View the project on GitHub <ArrowUpRight size={15} aria-hidden="true" /></a></div></footer>
    </div>
  );
}
