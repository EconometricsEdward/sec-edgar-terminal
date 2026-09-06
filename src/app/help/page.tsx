import Link from "next/link";
import {
  ArrowUpRight,
  BookOpen,
  Database,
  FolderOpen,
  Keyboard,
  ShieldCheck,
} from "lucide-react";
import { buildPageMetadata } from "../../utils/siteMetadata";
import styles from "./help.module.css";

export const metadata = buildPageMetadata({
  title: "Research Guide — Sources, Coverage & Your Workspace",
  description:
    "Understand EDGAR Terminal data sources, reporting dates, document coverage, saved research, browser backups, and keyboard navigation.",
  path: "/help",
});

const TOOLS = [
  [
    "Filings",
    "/filings",
    "Find a report, read the original context, and compare supported reporting periods.",
  ],
  [
    "Analysis",
    "/analysis",
    "Inspect company financials, reporting bases, formulas, and source facts.",
  ],
  [
    "Risk",
    "/risk",
    "Review industry-aware indicators and the financial evidence behind them.",
  ],
  [
    "Market",
    "/market",
    "Explore the available company sample, sector fundamentals, and screener.",
  ],
  [
    "Compare",
    "/compare",
    "Check peer differences alongside period and metric compatibility.",
  ],
  [
    "Funds",
    "/fund",
    "Inspect reported portfolios, holdings changes, and fund source coverage.",
  ],
  [
    "Disclosures",
    "/disclosures",
    "Search filing language, read passages, and assemble evidence.",
  ],
  [
    "Workspace",
    "/workspace",
    "Return to saved research, check followed companies, and manage backups.",
  ],
];

export default function HelpPage() {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Research guide</p>
        <h1>
          Understand the evidence.
          <br />
          <span>Keep the context.</span>
        </h1>
        <p>
          Use this guide to check where a result came from, what was actually
          covered, and how to keep your research available.
        </p>
        <nav
          className={styles.sectionLinks}
          aria-label="Research guide sections"
        >
          <a href="#sources">Sources & dates</a>
          <a href="#coverage">Coverage</a>
          <a href="#workspace">Saved research</a>
          <a href="#keyboard">Keyboard</a>
          <a href="#recovery">Troubleshooting</a>
        </nav>
      </header>
      <section id="sources" className={styles.section}>
        <div className={styles.sectionTitle}>
          <Database size={23} aria-hidden="true" />
          <h2>Different sources answer different questions</h2>
        </div>
        <p className={styles.lead}>
          A reporting period, a filing date, and a retrieval time are different
          dates. A successful service check does not make the underlying data
          current.
        </p>
        <div
          className={styles.tableWrap}
          tabIndex={0}
          role="region"
          aria-label="Data sources and date meanings"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Evidence</th>
                <th scope="col">What it represents</th>
                <th scope="col">What to check</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">SEC financial facts</th>
                <td>
                  Structured XBRL values reported by a company. Ratios and
                  derived periods are calculations by EDGAR Terminal.
                </td>
                <td>
                  Unit, fiscal period, annual or quarterly basis, source
                  accession, and whether a value was derived or restated.
                </td>
              </tr>
              <tr>
                <th scope="row">SEC filing text</th>
                <td>
                  Text extracted from a source document. Search excerpts and
                  change comparisons are bounded views of that document.
                </td>
                <td>
                  Filing date, reporting period, section, amendment status, and
                  the original SEC document for tables and formatting.
                </td>
              </tr>
              <tr>
                <th scope="row">Fund N-PORT reports</th>
                <td>
                  A historical portfolio snapshot in a public filing.
                  Availability varies by fund and report.
                </td>
                <td>
                  Portfolio as-of date separately from filing and retrieval
                  dates. Reported series assets can cover multiple share
                  classes; holdings are not a live portfolio.
                </td>
              </tr>
              <tr>
                <th scope="row">Market prices</th>
                <td>
                  Historical third-party price data, where displayed, from Yahoo
                  Finance or a Stooq fallback.
                </td>
                <td>
                  Provider, date range, adjustment basis, and missing history.
                  SEC financial facts and market prices have different sources.
                </td>
              </tr>
              <tr>
                <th scope="row">Market aggregates</th>
                <td>
                  Calculations over the available company sample and selected
                  metrics.
                </td>
                <td>
                  Sample size, successful company coverage, reporting periods,
                  and excluded or unavailable values. A selected cohort does not
                  represent the entire market.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Read a number or passage with its source link open when it matters to
          your conclusion. Company-specific tagging, missing facts, and filing
          amendments can affect comparability.
        </p>
      </section>
      <section id="coverage" className={styles.section}>
        <div className={styles.sectionTitle}>
          <ShieldCheck size={23} aria-hidden="true" />
          <h2>Read coverage before interpreting a pattern</h2>
        </div>
        <div className={styles.cards}>
          <article>
            <h3>Not found ≠ not searched</h3>
            <p>
              A successfully reviewed document with no match differs from a
              failed fetch, an unsupported report, or an archive that has not
              been loaded. Keep those categories separate.
            </p>
          </article>
          <article>
            <h3>First observed within this search</h3>
            <p>
              A term’s earliest match in a bounded search is not necessarily the
              company’s first disclosure. Widen the date range or load older
              filings to investigate further.
            </p>
          </article>
          <article>
            <h3>Change comparisons have a scope</h3>
            <p>
              Check both source periods and the sections compared. A changed
              excerpt is evidence to review; unchanged or omitted text is not
              proof that the company’s situation is unchanged.
            </p>
          </article>
          <article>
            <h3>Relevance is not a risk score</h3>
            <p>
              Repeated keywords and hypothetical risk language are not reported
              events. Read surrounding paragraphs and verify concrete claims
              against the source.
            </p>
          </article>
        </div>
      </section>
      <section id="workspace" className={styles.section}>
        <div className={styles.sectionTitle}>
          <FolderOpen size={23} aria-hidden="true" />
          <h2>Your research stays with this browser</h2>
        </div>
        <div className={styles.twoColumns}>
          <div>
            <h3>A reusable review workflow</h3>
            <ol>
              <li>
                Save a company or research view, then keep the passages and
                notes that support your work.
              </li>
              <li>
                Use the Workspace to return to research and manually check
                followed companies for new filings.
              </li>
              <li>
                Mark work reviewed after inspecting it. A successful data check
                is separate from your review baseline.
              </li>
              <li>
                Export a backup before switching browsers, clearing site data,
                or making substantial changes.
              </li>
            </ol>
            <Link className={styles.actionLink} href="/workspace">
              Open research workspace{" "}
              <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          </div>
          <div>
            <h3>Storage and privacy</h3>
            <p>
              Saved searches, evidence, notes, and preferences use this
              browser’s storage. They do not automatically synchronize across
              devices or browser profiles. Private browsing, storage limits, or
              clearing site data can remove them.
            </p>
            <p>
              Research requests are sent to the application to retrieve public
              data. Page usage and performance are measured with Vercel
              Analytics and Speed Insights. Your notebook is not an account or a
              cloud backup.
            </p>
            <p>
              Workspace checks run when you request them. They do not send
              email, schedule background monitoring, or run while the site is
              closed. Review an import before confirming it and retain your
              backup file.
            </p>
          </div>
        </div>
      </section>
      <section id="keyboard" className={styles.section}>
        <div className={styles.sectionTitle}>
          <Keyboard size={23} aria-hidden="true" />
          <h2>Move through your research with the keyboard</h2>
        </div>
        <dl className={styles.shortcuts}>
          <div>
            <dt>
              <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd>
            </dt>
            <dd>Focus the site search.</dd>
          </div>
          <div>
            <dt>
              <kbd>↑</kbd> <kbd>↓</kbd> · <kbd>Enter</kbd>
            </dt>
            <dd>Navigate search suggestions and open a choice.</dd>
          </div>
          <div>
            <dt>
              <kbd>Escape</kbd>
            </dt>
            <dd>Close search suggestions or the expanded service panel.</dd>
          </div>
          <div>
            <dt>
              <kbd>Tab</kbd> · <kbd>Shift</kbd> + <kbd>Tab</kbd>
            </dt>
            <dd>
              Move between controls. The first skip link takes you to the main
              content.
            </dd>
          </div>
        </dl>
        <p>
          Every tool also works with visible controls. Choose your appearance in
          the header; reduced-motion preferences are respected for decorative
          movement.
        </p>
      </section>
      <section id="recovery" className={styles.section}>
        <div className={styles.sectionTitle}>
          <BookOpen size={23} aria-hidden="true" />
          <h2>If something does not load</h2>
        </div>
        <div className={styles.cards}>
          <article>
            <h3>A page or data request failed</h3>
            <p>
              Retry the current request. Check the company, date filters, and
              source coverage if results are empty. A source may be temporarily
              unavailable even when the application service responds.
            </p>
          </article>
          <article>
            <h3>Saving is unavailable</h3>
            <p>
              Keep the page open and export your work where possible. Check
              browser storage permissions and available space. Do not clear site
              data until your notes and evidence are backed up.
            </p>
          </article>
        </div>
        <p>
          The service indicator in the header checks application response and
          configuration only. Open it to see the last check and retry; it is not
          an SEC uptime monitor.
        </p>
      </section>
      <section className={styles.section} aria-labelledby="tools-title">
        <h2 id="tools-title">Choose the tool for your next question</h2>
        <div className={styles.tools}>
          {TOOLS.map(([name, href, description]) => (
            <Link key={href} href={href}>
              <h3>
                {name}
                <ArrowUpRight size={15} aria-hidden="true" />
              </h3>
              <p>{description}</p>
            </Link>
          ))}
        </div>
        <p>
          For the project’s purpose and methodology, see{" "}
          <Link href="/about">About EDGAR Terminal</Link>.
        </p>
      </section>
    </div>
  );
}
