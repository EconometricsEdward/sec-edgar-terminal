import { ArrowUpRight, FileText } from "lucide-react";
import styles from "./BrokerDealerAnalytics.module.css";

type Source = { url?: string; page?: number; text?: string };
type Measure = { id: string; label: string; value: number | null; unit?: string; format?: string; periodEnd?: string; source?: Source; sources?: Source[]; formula?: string; confidence?: string };
export type BrokerDealerAnalysis = {
  status?: string;
  metrics?: Measure[];
  ratios?: Measure[];
  findings?: Array<{ id?: string; title?: string; text?: string; severity?: string; source?: Source }>;
  limitations?: string[];
  coverage?: { availableMetrics?: string[]; missingMetrics?: string[]; disclosedStatements?: string[]; pagesWithText?: number; totalPages?: number; caveats?: string[] };
};

function sourceHref(source?: Source) {
  if (!source?.url) return undefined;
  try {
    const url = new URL(source.url);
    if (url.protocol !== "https:" || !["www.sec.gov", "sec.gov", "archives.sec.gov"].includes(url.hostname)) return undefined;
    if (Number.isInteger(source.page) && source.page! > 0) url.hash = `page=${source.page}`;
    return url.href;
  } catch { return undefined; }
}
function formatValue(metric: Measure) {
  if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) return "Not available";
  if (metric.format === "percent") return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 }).format(metric.value);
  if (metric.unit === "ratio" || metric.format === "multiple") return `${metric.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}×`;
  if (metric.unit === "USD") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(metric.value);
  return metric.value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function Evidence({ metric }: { metric: Measure }) {
  const sources = metric.sources?.length ? metric.sources : metric.source ? [metric.source] : [];
  return <details className={styles.evidence}>
    <summary>Source{sources.length > 1 ? "s" : ""}{metric.source?.page ? ` · p. ${metric.source.page}` : ""}</summary>
    {metric.formula && <p><strong>Calculation:</strong> {metric.formula}</p>}
    {sources.map((source, index) => <div key={`${source.url}:${source.page}:${index}`}>
      {sourceHref(source) && <a href={sourceHref(source)} target="_blank" rel="noopener noreferrer">SEC document{source.page ? ` · page ${source.page}` : ""} <ArrowUpRight size={12} aria-hidden="true" /></a>}
      {source.text && <blockquote>{source.text}</blockquote>}
    </div>)}
    {!sources.length && <p>Source detail was not supplied. Review the original filing.</p>}
    {metric.confidence === "medium" && <p>Review the extracted label, period and amount against the source.</p>}
  </details>;
}

export default function BrokerDealerAnalytics({ analysis, filing, compact = false }: { analysis?: BrokerDealerAnalysis | null; filing?: { reportDate?: string; filingDate?: string; form?: string; documentUrl?: string }; compact?: boolean }) {
  const metrics = (analysis?.metrics || []).filter(metric => typeof metric.value === "number" && Number.isFinite(metric.value));
  const ratios = (analysis?.ratios || []).filter(metric => typeof metric.value === "number" && Number.isFinite(metric.value));
  const coverage = analysis?.coverage;
  const limits = [...new Set([...(analysis?.limitations || []), ...(coverage?.caveats || [])])];
  const statements = coverage?.disclosedStatements?.map(value => ({ "financial-condition": "financial condition", income: "income statement", "net-capital": "net capital" })[value] || value);
  return <section className={`${styles.analysis} ${compact ? styles.compact : ""}`} aria-label="Broker-dealer financial analysis">
    <header className={styles.heading}><div><p className={styles.eyebrow}>Public annual report · X-17A-5</p><h2>Broker-dealer financials</h2></div><span className={styles.status}>{metrics.length ? analysis?.status === "ready" ? "Extracted figures" : "Partial coverage" : "Figures unavailable"}</span></header>
    <p className={styles.intro}>Financial figures from the selected public filing. Dollar values are normalized to USD; calculations retain their disclosed inputs. Check the source labels and reporting dates before relying on a figure.</p>
    {filing?.reportDate && <p className={styles.period}>Reporting period end <strong>{filing.reportDate}</strong>{filing.filingDate ? ` · Filed ${filing.filingDate}` : ""}</p>}
    {!metrics.length ? <div className={styles.empty}><FileText size={22} aria-hidden="true" /><div><h3>No supported figures extracted</h3><p>The selected document may contain only a cover, scanned pages or a statement layout that cannot be mapped reliably. Open the financial-statement PDF and review it directly. Missing figures are not zero.</p></div></div> : <>
      <div className={styles.tableWrap}><table><caption>Disclosed financial figures</caption><thead><tr><th scope="col">Measure</th><th scope="col">USD</th><th scope="col">Evidence</th></tr></thead><tbody>{metrics.map(metric => <tr key={metric.id}><th scope="row">{metric.label}{metric.periodEnd && <small>{metric.periodEnd}</small>}</th><td className={styles.value}>{formatValue(metric)}</td><td><Evidence metric={metric} /></td></tr>)}</tbody></table></div>
      {ratios.length > 0 && <div className={styles.tableWrap}><table><caption>Calculated ratios</caption><thead><tr><th scope="col">Measure</th><th scope="col">Value</th><th scope="col">Inputs</th></tr></thead><tbody>{ratios.map(metric => <tr key={metric.id}><th scope="row">{metric.label}</th><td className={styles.value}>{formatValue(metric)}</td><td><Evidence metric={metric} /></td></tr>)}</tbody></table><p className={styles.note}>Ratios use available compatible inputs. They are research measures, not credit ratings or a regulatory compliance determination.</p></div>}
    </>}
    {!!analysis?.findings?.length && <div className={styles.findings}><h3>What the filing supports</h3>{analysis.findings.map((finding, index) => <article key={finding.id || index}><h4>{finding.title}</h4><p>{finding.text}</p>{sourceHref(finding.source) && <a href={sourceHref(finding.source)} target="_blank" rel="noopener noreferrer">Review source{finding.source?.page ? ` · p. ${finding.source.page}` : ""} <ArrowUpRight size={12} aria-hidden="true" /></a>}</article>)}</div>}
    <details className={styles.coverage} open={!metrics.length || !!limits.length}><summary>Coverage and extraction limits</summary>
      {statements?.length ? <p>Statement evidence identified: {statements.join(", ")}.</p> : <p>Statement coverage depends on what the selected public document discloses.</p>}
      {typeof coverage?.pagesWithText === "number" && <p>{coverage.pagesWithText} pages with readable text{typeof coverage.totalPages === "number" ? ` out of ${coverage.totalPages} document pages` : ""}. Text extraction is not an audit or a complete review of the filing.</p>}
      {limits.length > 0 && <ul>{limits.map(limit => <li key={limit}>{limit}</li>)}</ul>}
      <p>Only publicly filed annual-report material is available here. Confidential FOCUS submissions are not included. Public filings may omit income statements, net-capital schedules or other information needed for a full review.</p>
    </details>
  </section>;
}
