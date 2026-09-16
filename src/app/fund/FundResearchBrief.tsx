import Link from "next/link";
import { SITE_URL } from "../../utils/siteMetadata";
import { publicPortfolioStructuredData, serializeResearchJsonLd } from "../../utils/fundPublicMetadata.js";
import base from "./fund.module.css";
import s from "./FundResearchBrief.module.css";

export type PublicFundSummary = {
  schemaVersion?: string;
  kind: "nport" | "13f";
  status: "ready" | "unavailable";
  ticker?: string;
  cik?: string;
  name: string;
  seriesId?: string | null;
  classId?: string | null;
  reportDate?: string;
  filingDate?: string;
  retrievedAt?: string;
  checkedAt?: string;
  freshUntil?: string;
  stale: boolean;
  positionCount?: number | null;
  totalValueUsd?: number | null;
  top10WeightPct?: number | null;
  valueLabel: string;
  topHoldings: Array<{ name: string; identifier: string; valueUsd: number | null; weightPct: number | null; weightSource?: string; putCall?: string | null; quantityType?: string | null }>;
  sources: Array<{ label: string; url: string }>;
  limitations: string[];
  reason?: string;
  interactiveUrl: string;
  summaryUrl: string;
};

function date(value?: string, withTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC", ...(withTime ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short" } as const : {}) }).format(new Date(value));
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const money = (value: unknown) => finite(value) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value) : "Not available";
const percent = (value: unknown) => finite(value) ? `${value.toFixed(2)}%` : "Not available";
const count = (value: unknown) => finite(value) ? value.toLocaleString("en-US") : "Not available";
function SourceDate({ value, withTime = false }: { value?: string; withTime?: boolean }) { return value ? <time dateTime={value}>{date(value, withTime)}</time> : <>Not available</>; }
function safeSource(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && ["www.sec.gov", "sec.gov", "data.sec.gov"].includes(url.hostname) ? url.href : null; } catch { return null; }
}

export default function FundResearchBrief({ summary, standalone = false, jsonUrl, canonicalPath }: { summary: PublicFundSummary; standalone?: boolean; jsonUrl: string; canonicalPath: string }) {
  const ready = summary.status === "ready";
  const nport = summary.kind === "nport";
  const title = nport ? `${summary.ticker} · ${summary.name}` : summary.name;
  const holdings = summary.topHoldings.slice(0, 10);
  const Heading = standalone ? "h1" : "h2";
  const structuredData = publicPortfolioStructuredData(summary, {
    pageUrl: `${SITE_URL}${canonicalPath}`, jsonUrl: `${SITE_URL}${jsonUrl}`, siteUrl: SITE_URL,
  });
  return (
    <section className={`${base.page} ${s.brief}`} aria-label="Public portfolio research brief">
      <script id="reported-portfolio-data" type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeResearchJsonLd(structuredData) }} />
      <header className={s.header}>
        <div><p className={s.eyebrow}>{nport ? "N-PORT fund portfolio" : "13F institutional manager"} · Research brief</p><Heading>{title}</Heading></div>
        <div className={s.actions}>
          <Link href={summary.interactiveUrl} prefetch={false}>{standalone ? "Open interactive manager research" : "Explore the full portfolio"} →</Link>
          <a href={jsonUrl}>Structured summary (JSON)</a>
        </div>
      </header>
      <p className={s.scope}>{nport ? "A source-dated fund portfolio reported to the SEC. Holdings and net assets cover all share classes in the reported series, not only this ticker’s share class. Portfolio weights refer to the reporting period below." : "Manager-level public holdings reported to the SEC. The reported value is not the manager’s complete assets under management or an individual fund’s net asset value."}</p>
      {ready ? <>
        <dl className={s.metrics}>
          <div><dt>Portfolio as of</dt><dd><SourceDate value={summary.reportDate} /></dd></div>
          <div><dt>{summary.valueLabel}</dt><dd>{money(summary.totalValueUsd)}</dd></div>
          <div><dt>Disclosed positions</dt><dd>{count(summary.positionCount)}</dd></div>
          <div><dt>{nport ? "Top 10 positive weights" : "Top 10 weight"}</dt><dd>{percent(summary.top10WeightPct)}</dd></div>
        </dl>
        <div className={s.freshness} data-research-status={summary.stale ? "stale" : "ready"}>
          <strong>{summary.stale ? "Refresh due" : "Prepared report"}</strong>
          <span>Latest source filing: <SourceDate value={summary.filingDate} />. Checked: <SourceDate value={summary.checkedAt || summary.retrievedAt} withTime />.</span>
          {summary.stale && <span>Showing previously prepared research; a newer filing or amendment may be missing.</span>}
        </div>
      </> : <p className={s.unavailable}><strong>Prepared portfolio unavailable.</strong> {summary.reason || "A verified summary is not available. Open the interactive workspace to request the report."} Missing coverage does not establish that no holdings exist.</p>}
      <details className={s.details} open={standalone}>
        <summary>{ready ? "Largest positions, source filings & coverage" : "Sources & reporting coverage"}</summary>
        {ready && <div className={s.tableWrap}>
          <table><caption>{holdings.length ? `Largest ${holdings.length} disclosed positions by reported USD value. ${nport ? "Weights are percentages of net assets and may be reported or calculated." : "Weights are percentages of the reconciled public 13F table, not total assets under management."}` : "No positions are available in this prepared summary."}</caption>
            <thead><tr><th scope="col">Security</th><th scope="col">Identifier / type</th><th scope="col">Reported value (USD)</th><th scope="col">Weight</th></tr></thead>
            <tbody>{holdings.map((holding, index) => <tr key={`${holding.identifier}:${holding.putCall || "security"}:${index}`}><th scope="row">{holding.name}</th><td>{holding.identifier || "Not available"}{holding.putCall ? ` · ${holding.putCall}` : ""}{holding.quantityType === "PRN" ? " · Principal units" : ""}</td><td>{money(holding.valueUsd)}</td><td>{percent(holding.weightPct)}{nport && holding.weightSource && <small className={s.weightSource}>{holding.weightSource}</small>}</td></tr>)}</tbody>
          </table>
        </div>}
        <div className={s.evidence}>
          <div><h3>Source filings</h3><ul>{summary.sources.slice(0, 32).map((source, index) => {
            const url = safeSource(source.url);
            return url ? <li key={`${url}:${index}`}><a href={url}>{source.label} ↗</a></li> : null;
          })}</ul>{!summary.sources.length && <p>No verified source filing is attached to this summary.</p>}
            {summary.cik && <p>SEC CIK {summary.cik}{summary.seriesId ? ` · Series ${summary.seriesId}` : ""}{summary.classId ? ` · Class ${summary.classId}` : ""}</p>}
            {summary.retrievedAt && <p>Source retrieved <SourceDate value={summary.retrievedAt} withTime />.</p>}
          </div>
          <div><h3>What this report covers</h3><ul>{summary.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul><p>The reporting date, filing date and last source check represent different points in time.</p></div>
        </div>
      </details>
    </section>
  );
}
