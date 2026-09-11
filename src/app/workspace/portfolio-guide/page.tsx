import Link from "next/link";
import { buildPageMetadata } from "../../../utils/siteMetadata";
import CopyExample from "./CopyExample";
import styles from "./portfolio-guide.module.css";

export const metadata = buildPageMetadata({
  title: "Portfolio Research — File Format & Batch API",
  description:
    "Prepare a company list, review portfolio assumptions, and retrieve bounded SEC research batches with source evidence. CSV, XLSX and versioned JSON formats.",
  path: "/workspace/portfolio-guide",
});

const example = JSON.stringify(
  {
    schema_version: "edgar.portfolio.v1",
    name: "Example company research universe",
    holdings: [{ ticker: "AAPL" }, { ticker: "MSFT" }],
    allocation: { basis: "none", normalize: false },
    research: { basis: "annual" },
  },
  null,
  2,
);
const request = `curl --request POST \\\n  'https://secedgarterminal.com/api/v1/portfolio-research' \\\n  --header 'Content-Type: application/json' \\\n  --data '{"schema_version":"edgar.portfolio.v1","action":"research","holdings":[{"ticker":"AAPL"}],"allocation":{"basis":"none","normalize":false},"research":{"basis":"annual"}}'`;
const responseExample = JSON.stringify(
  {
    schema_version: "edgar.portfolio.v1",
    generated_at: "2026-09-07T16:00:00.000Z",
    basis: "annual",
    action: "research",
    rows: [
      {
        id: "example-row",
        input: { ticker: "UNKNOWN_EXAMPLE" },
        resolution: { status: "unresolved", ticker: null, cik: null },
      },
    ],
    companies: [],
    coverage: {
      inputRows: 1,
      resolvedRows: 0,
      uniqueIssuers: 0,
      researchedIssuers: 0,
    },
    allocation: { mode: "universe", basis: "none" },
  },
  null,
  2,
);
const fields = [
  ["ticker", "Company/security ticker. Tickers alone are sufficient."],
  [
    "company_name",
    "Company name. Ambiguous names remain available for review; they are not guessed.",
  ],
  ["cik", "Exact SEC company identifier. Use text to preserve leading zeroes."],
  [
    "exchange",
    "Optional identification context; conflicting identifiers require review.",
  ],
  ["weight_pct", "Optional percentage points: 12.5 means 12.5%."],
  ["market_value", "Optional total position value, not a single share price."],
  ["shares", "Optional quantity. Shares alone do not imply weights."],
  ["currency", "Currency of the supplied position value, for example USD."],
  ["as_of_date", "Date represented by the holding or allocation, YYYY-MM-DD."],
  [
    "notes",
    "Optional user text. Private notes stay local in the browser workflow and are excluded from research exports by default.",
  ],
];

export default function PortfolioGuidePage() {
  return (
    <article className={styles.page}>
      <header>
        <Link href="/workspace">← Research Hub</Link>
        <p className={styles.eyebrow}>Portfolio Research · Format version 1</p>
        <h1>A company list, ready for research.</h1>
        <p>
          Enter tickers, review the matches, and collect source-backed SEC
          research in one workspace. Company identifiers are enough. Add
          optional allocation information only when you want to analyze a
          weighted portfolio.
        </p>
        <nav className={styles.links} aria-label="Portfolio guide sections">
          <a href="#templates">Templates</a>
          <a href="#format">Input format</a>
          <a href="#allocation">Allocation choices</a>
          <a href="#analytics">Portfolio analytics</a>
          <a href="#api">Batch API</a>
          <a href="#exports">Exports & privacy</a>
        </nav>
      </header>

      <section id="templates">
        <h2>Start with a template or a short list</h2>
        <p>
          In Portfolio Research, upload a file, paste tickers separated by
          commas, spaces or newlines. Review and correct individual rows before
          starting research, then save the portfolio.
        </p>
        <div className={styles.downloads}>
          <a href="/portfolio/portfolio-template.csv" download>
            Blank CSV template ↓
          </a>
          <a href="/portfolio/portfolio-template.xlsx" download>
            Blank Excel template ↓
          </a>
          <a href="/portfolio/portfolio-example.csv" download>
            Fictional allocation example ↓
          </a>
        </div>
        <p>
          The example uses sample allocations for demonstrating the format. It
          is not a recommended portfolio or a record of your holdings. The Excel
          template includes a separate Instructions sheet.
        </p>
        <h3>Try the prefilled 100-company demo</h3>
        <p>
          Explore 100 companies with hypothetical weights totaling 100%, then
          switch to equal weights or company counts. The demo shows
          concentration, scenarios, company metrics, reporting periods, SEC
          filing links and allocation coverage.
        </p>
        <div className={styles.downloads}>
          <a href="/portfolio/portfolio-demo-100.csv" download>
            Hypothetical weighted CSV ↓
          </a>
          <a href="/portfolio/portfolio-demo-100.xlsx" download>
            Hypothetical weighted Excel ↓
          </a>
          <a href="/portfolio/portfolio-demo-100.json" download>
            Hypothetical weighted JSON ↓
          </a>
          <Link href="/workspace/demo" prefetch={false}>
            Preview example results →
          </Link>
        </div>
        <p>
          The fixed weights are educational inputs, not actual holdings or
          investment recommendations. After importing CSV or Excel, select
          supplied weight percentages in Allocation settings; JSON preserves
          this setting. Results are a dated capture of public SEC evidence; each
          company retains its reporting and retrieval dates. Refreshing later
          may produce different figures, filings, or coverage. The preview can
          be opened as a separate saved example in your workspace.
        </p>
        <p>
          The supported workflow contains up to <strong>100 rows</strong>.
          File-size limits are shown in the importer. Research runs in smaller
          company batches, with partial results, cancellation and retries.
          Unsupported or unresolved entries remain visible so you can correct or
          exclude them while researching valid companies.
        </p>
      </section>

      <section id="format">
        <h2>The same fields in every format</h2>
        <div className={styles.tableWrap}>
          <table>
            <caption>
              Only a company identifier is needed; every allocation field is
              optional.
            </caption>
            <thead>
              <tr>
                <th scope="col">Column</th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {fields.map(([key, description]) => (
                <tr key={key}>
                  <th scope="row">
                    <code>{key}</code>
                  </th>
                  <td>{description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>JSON for an AI-prepared file</h3>
        <p>
          An AI can prepare this format, and the upload follows the same
          validation as a human-created file. Check the identifiers and remove
          private information you do not want to share with that AI.
        </p>
        <CopyExample value={example} label="Copy JSON example" />
        <div className={styles.links}>
          <a href="/portfolio/portfolio-schema.json" download>
            Download JSON schema
          </a>
          <a href="/portfolio/portfolio-example.json" download>
            Download sample JSON
          </a>
        </div>
        <p>
          <code>schema_version</code> must be <code>edgar.portfolio.v1</code>.
          The <code>holdings</code> array uses the fields above. Exact CIKs
          identify companies; share classes remain separate positions even when
          they retrieve the same company data. Duplicates, conflicting
          identifiers and uncertain name matches require explicit review.
        </p>
      </section>

      <section id="allocation">
        <h2>Choose what the list represents</h2>
        <ul>
          <li>
            <strong>Research universe:</strong> company counts, evidence and
            coverage. No economic exposure is invented.
          </li>
          <li>
            <strong>Supplied weights:</strong> use percentage points and show
            the supplied total. Normalization is an explicit choice; original
            weights are preserved. An unspecified balance is not called cash.
          </li>
          <li>
            <strong>Position values:</strong> derive weights only from
            comparable values in one common currency. Mixed currencies or
            incompatible dates require review; there is no automatic currency
            conversion.
          </li>
          <li>
            <strong>Equal-weight model:</strong> available only when explicitly
            selected and labeled as an assumption. Shares alone stay as metadata
            because this workflow does not price them.
          </li>
        </ul>
        <p>
          The initial model is long-only. Negative values and quantities require
          correction. Multiple share classes retain their own position rows and
          combine at company level for concentration. SEC SIC-derived industry
          classifications are labeled accurately. Missing research does not
          cause the covered subset to be silently reweighted.
        </p>
        <p>
          Annual and supported trailing-twelve-month research can have different
          company period ends. Values retain their units, periods,
          reported/calculated status and source inputs. Funds are directed to
          fund research instead of receiving ordinary operating-company ratios.
          No returns, Sharpe ratio, volatility or investment recommendations are
          generated from a ticker list.
        </p>
      </section>

      <section id="deep-portfolio-research">
        <h2>Bring the research tools to your own portfolio</h2>
        <p>
          The Metrics &amp; rankings view includes the Analysis page’s
          statement, cash-flow, profitability, banking and accounting-check
          catalog. Filter by business model, SEC industry and full reporting
          period; sort any measure and select up to six companies with up to ten
          comparison measures. Every value opens its explanation, formula,
          reporting dates and SEC sources. Refresh older portfolio captures to
          populate the expanded catalog.
        </p>
        <p>
          Connected findings identify cash use above operating cash generation,
          growth alongside losses, deposit funding of loans, and the drivers of
          return on equity. These use eligible company counts and compatible
          observations. They are prompts to investigate; company cash flows are
          not summed as portfolio cash flows.
        </p>
        <p>
          The Filing library starts with the saved references, then loads full
          recent submissions and historical archives on request. Disclosure
          search applies an explicit query, date range, forms and section to up
          to 100 portfolio companies. Work proceeds in paced batches, retains
          completed results when stopped, and provides retries and older-filing
          continuation. No match in reviewed filings is not evidence that a
          topic is absent.
        </p>
        <p>
          Fund ownership discovers reporting funds holding a selected portfolio
          company. The percentage of fund net assets is that fund’s allocation,
          not your portfolio exposure or market ownership. Fund dates, verified
          series, unavailable reports and remaining candidates stay visible.
        </p>
        <p>
          Download the complete portfolio report for all captured metrics,
          connected findings, SEC evidence, filing references, disclosure
          previews and collected passages, and fund results. The standalone HTML
          can be printed or saved as PDF. Structured JSON includes the same
          additional research. Source searches remain in the current session;
          financial captures remain browser-local and use shared evidence
          catalogs to preserve sources within the existing 4 MiB storage budget.
        </p>
      </section>

      <section id="hub-comparisons">
        <h2>Choose a question and compare saved portfolios</h2>
        <p>
          The Research Hub overview links directly to concentration, financial
          profiles, screening and evidence coverage for your last active
          portfolio. Filter saved portfolios by name, research status or
          coverage, and search saved evidence by type or recency. Analysis-area
          links reopen the selected tool; your research data and private notes
          remain in this browser.
        </p>
        <p>
          Choose “Compare saved portfolios” to inspect two local snapshots side
          by side. Company overlap counts share classes once and does not look
          through funds. Allocation overlap adds the smaller saved weight for
          each shared company; both portfolios require complete, resolved
          allocations totaling 100%. Explicit normalization remains labeled.
          Missing weights are never assumed to be zero.
        </p>
        <p>
          Whole-list financial medians describe their own covered samples.
          Matched differences require the same company, metric definition, unit,
          accounting basis and full reporting period. A difference for the same
          period may be a revision; it is not later growth. Exclusion reasons
          and snapshot dates remain visible. Export the comparison as JSON with
          your selected measure, company filter, all results and matched SEC
          links.
        </p>
      </section>

      <section id="analytics">
        <h2>Understand the list as a whole</h2>
        <p>
          Open Portfolio analytics in your saved portfolio, or explore the{" "}
          <Link href="/workspace/demo">100-company example</Link>. Every chart
          uses your included rows and the captured SEC evidence. Company links
          open the financial measures, reporting periods and source filings.
        </p>
        <ul>
          <li>
            <strong>Portfolio briefing:</strong> start with the largest known
            exposures, financial conditions and evidence gaps. Each finding
            leads to a relevant view or company. Counts describe identified
            companies; a ticker list does not imply invested weights.
          </li>
          <li>
            <strong>Cash backing of earnings:</strong> the briefing compares
            positive versus non-positive net income and operating cash flow for
            operating companies with aligned full annual or TTM periods and USD
            measures. Financial-company lenses and SIC 6798 REITs are excluded.
            Zero is non-positive. The headline uses profitable paired companies
            as its denominator; the four cells use all paired companies. Working
            capital and non-cash items can explain differences. Select a cell to
            inspect its companies or export the values, full periods and SEC
            source links. This is a statement-reading diagnostic, not a quality
            score.
          </li>
          <li>
            <strong>Concentration:</strong> see combined holding exposure across
            share classes and the SEC industry mix. Top-holding percentages use
            known original weights. Complete, reviewed allocations totaling 100%
            also show an effective holding count: 1 divided by the sum of
            squared holding weight fractions. Ten equally weighted holdings
            produce 10; one holding produces 1. This measures allocation
            concentration and does not account for correlations or fund
            holdings. Set your own holding and industry limits, inspect
            breaches, and trace cumulative allocation across the largest
            holdings. Limit settings are research assumptions. Incomplete
            weights cannot establish that exposure is within a limit. HHI
            contributions use squared holding weights only when allocation is
            complete.
          </li>
          <li>
            <strong>Financial profile:</strong> compare company medians, the
            middle 50% of observations and distributions for growth, margins,
            leverage and selected banking measures. Each company counts once.
            Medians describe companies with supported evidence, rather than an
            investment return or an ownership share of company earnings. Missing
            and not-applicable observations stay separate.
          </li>
          <li>
            <strong>Peer benchmarks and relationships:</strong> choose a SEC
            industry and reporting dates to compare a relevant group. Percentile
            ranks describe position within the measured group; a higher rank is
            not necessarily better. Two-metric charts use only companies with
            both measures, show their reporting dates, and can require matching
            period ends. These are financial relationships, not return
            correlations or forecasts.
          </li>
          <li>
            <strong>Company comparisons:</strong> select up to four companies
            and compare supported measures, reporting periods and SEC sources
            side by side. Missing values remain visible. Industry filters do not
            change the saved portfolio or its weight denominator.
          </li>
          <li>
            <strong>Company screener:</strong> combine up to four financial
            rules and inspect companies meeting all of them. A company needs
            supported evidence for every rule to qualify. Presets are editable
            research questions. Download the matching observations with their
            coverage and sources.
          </li>
          <li>
            <strong>Scenario lab:</strong> apply hypothetical price changes to
            all holdings, a company or a SEC industry. A 60% holding falling
            20%, with the remaining 40% unchanged, contributes −12 percentage
            points to modeled portfolio value. Scenarios require complete
            reviewed allocations, or your explicit choice to try a temporary
            equal-weight model. The temporary model does not edit saved weights.
            Sensitivity tables vary the target and other holdings&apos; price
            changes. The loss-target tool solves the target price change needed
            to produce your specified portfolio loss, holding the other
            assumptions fixed; it reports when that change is outside the
            supported range. Compare up to four named sets of assumptions and
            download the comparison. Cases remain available while you switch
            research tabs. Reloading, editing rows or opening another portfolio
            clears them; download the comparison to keep it.
          </li>
          <li>
            <strong>Evidence coverage:</strong> inspect metric coverage,
            reporting-date differences and the companies that need attention.
            Missing financial evidence never becomes a zero value. Reported
            periods can differ across companies, including in the same chart.
            The company-by-metric matrix makes every supported, missing and
            not-applicable measure visible, with inspection and CSV download.
          </li>
        </ul>
        <p>
          Scenario price changes are your assumptions. The calculation does not
          estimate their likelihood, correlations, spillovers, trading costs or
          liquidity. It is separate from historical SEC fundamentals. Download a
          scenario CSV to retain its inputs and contributions.
        </p>
      </section>

      <section id="api">
        <h2>A bounded API for connected research tools</h2>
        <p>
          <code>POST /api/v1/portfolio-research</code> accepts the documented
          JSON object with <code>Content-Type: application/json</code>. Add{" "}
          <code>action: &quot;resolve&quot;</code> for identification and
          validation, or <code>action: &quot;research&quot;</code> for financial
          evidence. Research is the default.
        </p>
        <CopyExample value={request} label="Copy API request" />
        <div className={styles.tableWrap}>
          <table>
            <caption>Enforced request limits</caption>
            <thead>
              <tr>
                <th scope="col">Limit</th>
                <th scope="col">Supported request</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Resolve</th>
                <td>Up to 100 input rows</td>
              </tr>
              <tr>
                <th scope="row">Research</th>
                <td>
                  Up to 5 distinct resolved companies per request; up to 100
                  position rows
                </td>
              </tr>
              <tr>
                <th scope="row">Body and cells</th>
                <td>256 KiB JSON body; 2,000 characters per cell</td>
              </tr>
              <tr>
                <th scope="row">Rate</th>
                <td>
                  60 requests per minute per IP using the existing limiter;
                  respect Retry-After on HTTP 429
                </td>
              </tr>
              <tr>
                <th scope="row">Execution</th>
                <td>
                  Synchronous bounded requests; server maximum duration 120
                  seconds; no background job IDs
                </td>
              </tr>
              <tr>
                <th scope="row">Filing feed</th>
                <td>
                  Up to 30 relevant filings per company from recent SEC
                  submissions; older archive files are not scanned
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <h3>Combine batches carefully</h3>
        <p>
          Resolve the full input, then retrieve batches of at most five distinct
          companies serially. Use <code>basis: &quot;none&quot;</code> for
          retrieval batches. Combine company results by CIK and calculate
          allocation and coverage once over the full original position list.
          Never combine batch percentages or silently reweight companies with
          missing research. Share-class rows remain separate from deduplicated
          company evidence.
        </p>
        <p>
          Responses include <code>schema_version</code>,{" "}
          <code>generated_at</code>, <code>basis</code>, <code>rows</code>,{" "}
          <code>companies</code>, <code>coverage</code> and{" "}
          <code>allocation</code>. Each company reports ready, partial, failed
          or unsupported status. Metric points include value or null, units,
          period, classification, sources and calculation details. Source
          records identify filing accessions, SEC URLs, input values and
          reporting dates.
        </p>
        <p>
          This abbreviated response illustrates an unresolved input. It is a
          format example, not live research. Successful company entries include
          their metrics and source records.
        </p>
        <CopyExample value={responseExample} label="Copy response example" />
        <p>
          Invalid requests return HTTP 400; oversized bodies 413; wrong content
          types 415; rate limits 429; and unavailable required upstream services
          502. Individual unresolved or failed companies can appear in HTTP 200
          responses: inspect their statuses and coverage before using results.
        </p>
        <p>
          An AI application needs an appropriate tool connection to call this
          endpoint. This feature does not make every LLM discover or use the
          site automatically.
        </p>
      </section>

      <section id="exports">
        <h2>Keep sources and assumptions with the result</h2>
        <p>
          Export the selected company table to CSV, or a captured research
          package to XLSX, JSON or Markdown. The workbook separates Holdings,
          Company research, Portfolio summary, Sources, Coverage &amp;
          methodology, Analytics, and Metric observations. The last sheet keeps
          each company&apos;s supported values, reporting dates and source links
          alongside explicit missing and not-applicable states. An analytics CSV
          summarizes the full portfolio; full JSON and Markdown packages include
          those calculations too. Selected-row exports omit portfolio-wide
          analytics to keep the selected scope and original weights clear. Copy
          research context produces the same source-backed brief for another
          research tool without calling a model.
        </p>
        <p>
          Research packages use <code>edgar.portfolio.research.v1</code>,
          distinct from the input format. They preserve generation time,
          retrieval times, basis, company evidence, calculation inputs,
          exclusions and coverage. Exporting a subset keeps weights from the
          full saved document. It does not recalculate the subset to 100%.
          Downloaded snapshots do not update themselves.
        </p>
        <p>
          <strong>Private notes are excluded by default.</strong> Enable them
          only if you intend to share them. The export controls state when
          sensitive allocations are included; turn that option off to share
          company research without supplied weights, position values,
          quantities, currencies or holding dates.
        </p>
        <p>
          Saved portfolios remain in this browser. Export your portfolio to keep
          a copy; portfolios do not synchronize automatically across devices. The interactive research client sends only company
          identifiers needed for public-data retrieval; notes and allocation
          calculations stay local. Programmatic clients transmit whatever fields
          they send, but request-specific allocations and notes are not put in
          shared caches or routine application logs.
        </p>
        <p>
          Shared caches contain public company data. Results identify fresh,
          cached or stale evidence and its retrieval time; cached data can be
          used for five minutes, with a labeled snapshot up to 24 hours old
          available if refresh fails. Filings appear &quot;new since your last
          check&quot; only when a previous check exists. Checks run on request,
          with no unattended emails or notifications.
        </p>
        <Link href="/workspace">Open Portfolio Research →</Link>
      </section>
    </article>
  );
}
