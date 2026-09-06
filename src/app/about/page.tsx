import Link from "next/link";
import { ArrowUpRight, Database, FileCheck, FolderOpen } from "lucide-react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import styles from "../help/help.module.css";

export const metadata = buildPageMetadata({
  title: "About EDGAR Terminal — Purpose & Methodology",
  description:
    "Source-linked SEC filing research, financial calculations, market data distinctions, and browser-local research tools. Understand how EDGAR Terminal presents evidence.",
  path: "/about",
});

export default function AboutPage() {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>About EDGAR Terminal</p>
        <h1>
          Research that leads
          <br />
          <span>back to the filing.</span>
        </h1>
        <p>
          EDGAR Terminal is a free tool for exploring public SEC filings and
          financial data. It helps analysts, students, journalists, and curious
          investors connect a question to the evidence behind it.
        </p>
        <nav className={styles.sectionLinks} aria-label="About navigation">
          <Link href="/help">Read the research guide</Link>
          <Link href="/workspace">Open your workspace</Link>
          <a
            href="https://github.com/EconometricsEdward/sec-edgar-terminal"
            target="_blank"
            rel="noopener noreferrer"
          >
            View the source code ↗
          </a>
        </nav>
      </header>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>
          <Database size={23} aria-hidden="true" />
          <h2>Primary evidence, with calculations made explicit</h2>
        </div>
        <div className={styles.cards}>
          <article>
            <h3>SEC financial facts and documents</h3>
            <p>
              Company submissions, structured XBRL facts, and public filing
              documents supply the financial and disclosure evidence. The site
              parses source documents and calculates metrics, comparisons, and
              summaries. Those calculations are the application’s interpretation
              of the reported inputs.
            </p>
          </article>
          <article>
            <h3>Separate market price sources</h3>
            <p>
              Historical price views, where present, use Yahoo Finance with a
              Stooq fallback. Prices do not come from the SEC. Provider
              availability, adjustment conventions, and date coverage can differ
              from the financial reporting data.
            </p>
          </article>
          <article>
            <h3>Period and industry context</h3>
            <p>
              A ratio is only useful with its units, formula, and reporting
              basis. Financial views expose period and source context,
              distinguish missing values, and adapt supported metrics to the
              company’s industry. A classification or model does not replace a
              review of the company.
            </p>
          </article>
          <article>
            <h3>Visible coverage limits</h3>
            <p>
              Recent submission feeds, older archives, searchable document
              sections, and supported public fund reports have different scopes.
              The relevant tool reports its available coverage. A missing result
              is not evidence that no filing, exposure, or event exists.
            </p>
          </article>
        </div>
        <p>
          <Link href="/help#sources">
            Learn how reporting dates, filing dates, and retrieval times differ.
          </Link>
        </p>
      </section>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>
          <FileCheck size={23} aria-hidden="true" />
          <h2>From discovery to a reviewable conclusion</h2>
        </div>
        <div className={styles.twoColumns}>
          <div>
            <h3>Discover and investigate</h3>
            <p>
              <Link href="/market">Market</Link> provides a company screener and
              sector fundamentals across the available sample.{" "}
              <Link href="/analysis">Analysis</Link>,{" "}
              <Link href="/risk">Risk</Link>, and{" "}
              <Link href="/compare">Compare</Link> connect financial questions
              to reported inputs and peer context.
            </p>
            <p>
              <Link href="/filings">Filings</Link> and{" "}
              <Link href="/disclosures">Disclosures</Link> let you find
              documents, inspect relevant language, and compare supported
              periods. <Link href="/fund">Funds</Link> explores historical
              portfolio snapshots and holdings from public N-PORT reports.
            </p>
          </div>
          <div>
            <h3>Keep sources with your notes</h3>
            <p>
              Evidence collections, saved views, review queues, and exports help
              preserve the source accession, period, and quotation beside your
              interpretation. Keyword relevance and model indicators are prompts
              for further review, not a recommendation to buy or sell a
              security.
            </p>
            <p>
              Verify consequential figures and excerpts against the original SEC
              document. Extracted text can lose table structure, and
              company-specific tagging or restatements can affect comparisons.
            </p>
          </div>
        </div>
      </section>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>
          <FolderOpen size={23} aria-hidden="true" />
          <h2>Free to use. Your research in your browser.</h2>
        </div>
        <p>
          No account is required. Saved research and preferences use browser
          storage; they do not automatically synchronize across devices. The
          Workspace brings saved work together and provides backup controls.
          Keep an export before clearing site data.
        </p>
        <p>
          Research requests go to the application to retrieve public data.
          Vercel Analytics and Speed Insights measure page usage and
          performance. Workspace filing checks run on request and do not send
          background notifications or emails.
        </p>
        <Link href="/help#workspace" className={styles.actionLink}>
          Read the storage and review guide{" "}
          <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </section>
      <section className={styles.section}>
        <h2>Source documentation</h2>
        <div className={styles.tools}>
          <a
            href="https://www.sec.gov/search-filings/edgar-application-programming-interfaces"
            target="_blank"
            rel="noopener noreferrer"
          >
            <h3>
              SEC EDGAR APIs <ArrowUpRight size={15} aria-hidden="true" />
            </h3>
            <p>Submissions and structured financial facts.</p>
          </a>
          <a
            href="https://www.sec.gov/structureddata"
            target="_blank"
            rel="noopener noreferrer"
          >
            <h3>
              SEC structured data <ArrowUpRight size={15} aria-hidden="true" />
            </h3>
            <p>Reporting formats and structured data resources.</p>
          </a>
        </div>
        <p>
          EDGAR Terminal is a research and educational tool, not investment
          advice. No guarantee is made about the completeness, accuracy, or
          timeliness of displayed data.
        </p>
      </section>
    </div>
  );
}
