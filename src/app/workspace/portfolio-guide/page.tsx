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
    "Issuer name. Ambiguous names remain available for review; they are not guessed.",
  ],
  ["cik", "Exact SEC issuer identifier. Use text to preserve leading zeroes."],
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
    <main className={styles.page}>
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
          <a href="#api">Batch API</a>
          <a href="#exports">Exports & privacy</a>
        </nav>
      </header>

      <section id="templates">
        <h2>Start with a template or a short list</h2>
        <p>
          In Portfolio Research, upload a file, paste tickers separated by
          commas, spaces or newlines, or use your existing watchlist. Review and
          correct individual rows before starting research. Importing creates a
          separate saved universe and does not replace your watchlist.
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
          Download a ready-to-import list of 100 tickers, then preview the
          research captured for those companies. The demo shows company metrics,
          reporting periods, SEC filing links, and coverage so you can see what
          to expect before running your own research.
        </p>
        <div className={styles.downloads}>
          <a href="/portfolio/portfolio-demo-100.csv" download>
            Prefilled 100-ticker CSV ↓
          </a>
          <a href="/portfolio/portfolio-demo-100.xlsx" download>
            Prefilled 100-ticker Excel ↓
          </a>
          <Link href="/workspace/demo" prefetch={false}>
            Preview example results →
          </Link>
        </div>
        <p>
          This is a company research universe with no supplied or assumed
          allocations. It demonstrates the workflow, not an investment
          recommendation. Results are a dated capture of public SEC evidence;
          each company retains its reporting and retrieval dates. Refreshing
          later may produce different figures, filings, or coverage. The preview
          can be opened as a separate saved example in your workspace.
        </p>
        <p>
          The supported workflow contains up to <strong>100 rows</strong>.
          File-size limits are shown in the importer. Research runs in smaller
          issuer batches, with partial results, cancellation and retries.
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
          identify issuers; share classes remain separate positions even when
          they retrieve the same issuer data. Duplicates, conflicting
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
          combine at issuer level for concentration. SEC SIC-derived industry
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
                  Up to 5 distinct resolved issuers per request; up to 100
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
                  Up to 30 relevant filings per issuer from recent SEC
                  submissions; older archive files are not scanned
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <h3>Combine batches carefully</h3>
        <p>
          Resolve the full input, then retrieve batches of at most five distinct
          issuers serially. Use <code>basis: &quot;none&quot;</code> for
          retrieval batches. Combine company results by CIK and calculate
          allocation and coverage once over the full original position list.
          Never combine batch percentages or silently reweight companies with
          missing research. Share-class rows remain separate from deduplicated
          issuer evidence.
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
          Export the selected issuer table to CSV, or a captured research
          package to XLSX, JSON or Markdown. The workbook separates Holdings,
          Company research, Portfolio summary, Sources, and Coverage &amp;
          methodology. Copy research context produces the same source-backed
          brief for another research tool without calling a model.
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
          Saved portfolios remain in this browser and can be included in
          Research Hub backup/restore. They do not synchronize automatically
          across devices. The interactive research client sends only company
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
    </main>
  );
}
