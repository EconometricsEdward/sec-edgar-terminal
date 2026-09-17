import base from "./analysis.module.css";
import s from "./AnalysisResearchBrief.module.css";

const basisNames: Record<string, string> = { annual: "Annual", quarter: "Standalone quarter", ytd: "Year to date", ttm: "Trailing twelve months" };
function value(number: number | null, unit: string) {
  if (number == null || !Number.isFinite(number)) return "Unavailable";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: unit === "USD" || unit === "shares" ? 0 : 2 }).format(number)} ${unit}`;
}
function date(at: string | null | undefined) {
  if (!at || !Number.isFinite(Date.parse(at))) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(at)) + " UTC";
}
export default function AnalysisResearchBrief({ summary, selection, hidden = false }: { summary: any; selection: any; hidden?: boolean }) {
  const query = new URLSearchParams();
  if (selection.basis !== "annual") query.set("basis", selection.basis);
  if (selection.end) query.set("end", selection.end);
  if (selection.asOf) query.set("asOf", selection.asOf);
  const jsonUrl = `/api/v1/analysis/${selection.ticker}${query.size ? `?${query}` : ""}`;
  const sources: any[] = [...new Map<string, any>((summary.sourceCatalog || []).filter((source: any) => source.url).map((source: any) => [source.url, source])).values()];
  return <section id="analysis-public-brief" hidden={hidden} data-ticker={selection.ticker} data-basis={selection.basis}
    data-end={selection.end || "latest"} data-asof={selection.asOf || ""} data-baseline="year"
    className={`${base.page} ${s.brief}`} aria-labelledby="analysis-brief-title">
    <details className={s.disclosure}>
      <summary className={s.toggle}>
        <span className={s.summaryText}>
          <span id="analysis-brief-title" className={s.summaryTitle}>{summary.name || selection.ticker} — financial highlights</span>
          <span className={s.summaryMeta}>{selection.ticker} · {basisNames[summary.basis || selection.basis]}
            {summary.period?.end && <> · Period ending <time dateTime={summary.period.end}>{summary.period.end}</time></>}
          </span>
        </span>
        <span className={s.summaryAside}>
          <span className={s.status} data-state={summary.status === "ready" ? summary.stale ? "stale" : "ready" : "unavailable"}>
            {summary.status === "ready" ? summary.stale ? "Refresh due" : "Prepared research" : "Summary unavailable"}
          </span>
          <span className={s.toggleLabel} aria-hidden="true"><span className={s.closedLabel}>View highlights</span><span className={s.openLabel}>Close highlights</span><span className={s.chevron} /></span>
        </span>
      </summary>
      <div id="analysis-brief-content" className={s.content}>
      <nav className={s.links} aria-label="Financial summary links"><a href="#analysis-workspace">Full analysis workspace</a><a href={jsonUrl}>Compact JSON</a><a href={`/filings/${selection.ticker}`}>Company filings</a></nav>
    {summary.status === "ready" ? <>
      <p><strong>{basisNames[summary.basis]}</strong> · {summary.period?.start ? `${summary.period.start} → ` : "Period ending "}<time dateTime={summary.period?.end}>{summary.period?.end}</time>
        {summary.period?.fiscalYear ? ` · Fiscal ${summary.period.fiscalYear} ${summary.period.fiscalPeriod || ""}` : ""}. Balance-sheet inputs are point-in-time values.</p>
      <p className={s.freshness}><strong>{summary.stale ? "Refresh due" : "Prepared research"}</strong> · Sources checked <time dateTime={summary.checkedAt || undefined}>{date(summary.checkedAt)}</time> · Calculated {date(summary.calculatedAt)}</p>
      <div className={s.tableWrap}><table><caption>Latest filed values for this reporting period; comparison with the same period last year. Values use the units shown.</caption>
        <thead><tr><th scope="col">Metric</th><th scope="col">{summary.period?.end}</th><th scope="col">{summary.comparisonPeriod?.end || "Prior period unavailable"}</th><th scope="col">Basis & evidence</th></tr></thead>
        <tbody>{summary.metrics.map((metric: any) => <tr key={metric.key}><th scope="row">{metric.label}</th><td>{value(metric.value, metric.unit)}</td>
          <td>{value(metric.previous?.value, metric.unit)}</td><td><span>{metric.classification}</span>{metric.formula && <small>{metric.formula}</small>}
            {(metric.sourceIds || []).length > 0 && <a href="#analysis-summary-sources">SEC sources</a>}</td></tr>)}</tbody></table></div>
      <details className={s.evidence}><summary>Source filings, coverage & interpretation</summary>
        <div id="analysis-summary-sources" className={s.sourceContent}>
        <ul>{sources.map((source: any) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.form || "SEC filing"} · {source.filed || source.accession}</a> · {source.accession}</li>)}</ul>
        <ul>{(summary.limitations || []).map((text: string) => <li key={text}>{text}</li>)}</ul>
        <p>The JSON includes the XBRL concepts, source values and periods used by these metrics. Open Sources & checks in the workspace for the full evidence history.</p>
        </div>
      </details>
    </> : <p className={s.unavailable}>{summary.reason || "A verified summary for this selection is not prepared."} Missing prepared research does not mean the company has no financial data.</p>}
      </div>
    </details>
  </section>;
}
