"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Building2, ChevronDown, Clock3, FileText, History, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import s from "./ThirteenFCompanyPanel.module.css";

type Period = { end: string; start?: string; label?: string; kind?: string; fp?: string };
type Source = { url?: string; documentUrl?: string; form?: string; filed?: string; accession?: string; taxonomy?: string; tag?: string; unit?: string };
type Point = { period: Period; value: number | null; classification?: string; formula?: string; reason?: string | null; sources: Source[] };
type Metric = { key: string; label: string; format: string; points: Point[] };
type Holding = { key: string; issuer: string; cusip: string; classTitle?: string; putCall?: string | null; valueUsd?: number | null; quantity?: number | null; quantityType?: string; weightPct?: number | null };
type Research = {
  status: "ready" | "unresolved";
  manager: { cik: string; name: string };
  selectedPeriod: string;
  holding: Holding;
  identity: { status: string; issuer?: { cik: string; name: string; tickers?: string[]; kind?: string; submissionsUrl?: string } | null; evidence?: { url: string; sourceUrl?: string; form?: string; filingDate?: string; cusips?: string[]; classTitle?: string }[]; reason?: string; securityType?: string; coverage?: unknown };
  financials: { status: string; lens?: string | null; basis: string; asOf?: string; periods: Period[]; metrics: Metric[]; note?: string };
  filings: { form: string; filingDate?: string; reportDate?: string; accession?: string; documentUrl?: string }[];
  observedAt?: string;
  issues?: string[];
};
type Remote = { key: string; status: "loading" | "ready" | "error"; data: Research | null; error: string };
const MAX_BYTES = 4 * 1024 * 1024;
const cache = new Map<string, { expires: number; data: Research; bytes: number }>();
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const fullCurrency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const numeric = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const money = (value: unknown) => finite(value) ? currency.format(value) : "Unavailable";
const quarter = (value: string) => /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(value) ? `Q${Math.ceil(Number(value.slice(5, 7)) / 3)} ${value.slice(0, 4)}` : value;
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return "Date unavailable";
  const stamp = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(stamp.getTime()) ? stamp.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Date unavailable";
}
function format(value: unknown, kind = "currency", exact = false) {
  if (!finite(value)) return "Unavailable";
  if (kind === "currency") return (exact ? fullCurrency : currency).format(value);
  if (kind === "percent") return `${value.toFixed(1)}%`;
  if (kind === "decimal") return `${value.toFixed(2)}×`;
  return numeric.format(value);
}
function secUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) ? url.href : null; } catch { return null; }
}
function SecLink({ href, children }: { href: unknown; children: React.ReactNode }) {
  const url = secUrl(href);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={13} aria-hidden="true" /></a> : null;
}
async function fetchResearch(cik: string, period: string, holdingKey: string, signal: AbortSignal, force: boolean) {
  const key = `${cik}:${period}:${holdingKey}`;
  const stored = cache.get(key);
  if (!force && stored && stored.expires > Date.now()) return stored.data;
  const response = await fetch(`/api/fund-13f/company?${new URLSearchParams({ cik, period, key: holdingKey })}`, { signal });
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("Company research exceeds the panel size limit. Its SEC sources remain available below.");
  const reader = response.body?.getReader();
  let raw = "", bytes = 0;
  if (reader) {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error("Company research exceeds the panel size limit. Open its SEC source instead."); }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
  } else { raw = await response.text(); bytes = raw.length * 2; }
  signal.throwIfAborted();
  if (bytes > MAX_BYTES) throw new Error("Company research exceeds the panel size limit.");
  let result: Research;
  try { result = JSON.parse(raw); } catch { throw new Error("Company research could not be opened. Please retry."); }
  if (!response.ok) throw new Error(typeof (result as any)?.error === "string" ? (result as any).error : "SEC company research is temporarily unavailable. Please retry.");
  if (!["ready", "unresolved"].includes(result?.status) || result.manager?.cik !== cik || result.selectedPeriod !== period || result.holding?.key !== holdingKey || !result.identity || !Array.isArray(result.identity.evidence) || result.identity.evidence.length > 32 || result.identity.evidence.some(evidence => !evidence || typeof evidence.url !== "string") || !result.financials || !Array.isArray(result.financials.periods) || result.financials.periods.length > 8 || result.financials.periods.some(period => !period || typeof period.end !== "string") || !Array.isArray(result.financials.metrics) || result.financials.metrics.length > 12 || result.financials.metrics.some(metric => !metric || typeof metric.key !== "string" || typeof metric.label !== "string" || !Array.isArray(metric.points) || metric.points.length > 8 || metric.points.some(point => typeof point?.period?.end !== "string" || !Array.isArray(point.sources) || point.sources.length > 32 || point.sources.some(source => !source))) || !Array.isArray(result.filings) || result.filings.length > 24 || result.filings.some(filing => !filing || typeof filing.form !== "string") || result.issues != null && (!Array.isArray(result.issues) || result.issues.some(issue => typeof issue !== "string")) || result.status === "ready" && (result.identity.status !== "resolved" || !/^\d{10}$/.test(result.identity.issuer?.cik || "") || typeof result.identity.issuer?.name !== "string" || !Array.isArray(result.identity.issuer.tickers) || result.identity.issuer.tickers.some(ticker => typeof ticker !== "string"))) throw new Error("The company response could not be verified against this holding. Please retry.");
  if (result.status === "ready" && result.financials.status === "ready") {
    cache.delete(key);
    let size = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (cache.size && (cache.size >= 12 || size + bytes > MAX_BYTES * 2)) {
      const oldest = cache.keys().next().value as string;
      size -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    cache.set(key, { data: result, bytes, expires: Date.now() + 300000 });
  }
  return result;
}
function MetricChart({ metric, id }: { metric: Metric; id: string }) {
  const points = [...metric.points].sort((a, b) => a.period.end.localeCompare(b.period.end));
  const values = points.map(point => point.value).filter(finite);
  const low = Math.min(0, ...values), high = Math.max(0, ...values);
  const range = high - low || 1;
  const width = 560, left = 16, right = 16, top = 34, bottom = 170;
  const y = (value: number) => top + (high - value) / range * (bottom - top);
  const zero = y(0), step = (width - left - right) / Math.max(1, points.length);
  const barWidth = Math.min(62, step * .5);
  return <div className={s.chartBlock}>
    <div className={s.chartHeading}><div><span className={s.eyebrow}>Annual financial history</span><h4>{metric.label}</h4></div><span>{metric.format === "currency" ? "USD · fiscal years" : "Fiscal years"}</span></div>
    {values.length ? <figure className={s.chart}><svg viewBox={`0 0 ${width} 221`} role="img" aria-labelledby={`${id}-chart-title ${id}-chart-desc`}><title id={`${id}-chart-title`}>{metric.label}, annual reported values</title><desc id={`${id}-chart-desc`}>{points.map(point => `${date(point.period.end)}: ${format(point.value, metric.format, true)}`).join(". ")}. Bars share a zero baseline. Exact values and sources follow the chart.</desc><line x1={left} x2={width - right} y1={zero} y2={zero} className={s.zeroLine} /><text x={left} y={zero > top + 16 ? zero - 7 : zero + 15} className={s.zeroLabel}>0</text>{points.map((point, index) => {
      const x = left + step * (index + .5);
      const available = finite(point.value);
      const valueY = available ? y(point.value as number) : zero;
      const negative = available && (point.value as number) < 0;
      return <g key={point.period.end}>
        {available ? <><rect x={x - barWidth / 2} y={Math.min(zero, valueY)} width={barWidth} height={Math.max(point.value === 0 ? 2 : 0, Math.abs(zero - valueY))} rx={3} className={negative ? s.negativeBar : s.positiveBar}><title>{date(point.period.end)}: {format(point.value, metric.format, true)}</title></rect><text x={x} y={negative ? valueY + 18 : valueY - 10} textAnchor="middle" className={s.barValue}>{format(point.value, metric.format)}</text></> : <text x={x} y={top + (bottom - top) / 2} textAnchor="middle" className={s.missingValue}>Unavailable</text>}
        <text x={x} y={208} textAnchor="middle" className={s.yearLabel}>{point.period.end.slice(0, 7)}</text>
      </g>;
    })}</svg><figcaption>Fiscal years end on the dates below. Missing values are left unplotted.</figcaption></figure> : <p className={s.noChart}>A comparable annual series is unavailable for this measure. Review the reasons and SEC filings below.</p>}
    <details className={s.chartSources}><summary>Exact values &amp; SEC sources<ChevronDown size={15} aria-hidden="true" /></summary><div className={s.valuesScroll} tabIndex={0} role="region" aria-label={`${metric.label} values and sources`}><table><thead><tr><th scope="col">Fiscal period ended</th><th scope="col">{metric.label}</th><th scope="col">Evidence</th></tr></thead><tbody>{points.map(point => <tr key={point.period.end}><th scope="row">{date(point.period.end)}{point.period.start ? <small>From {date(point.period.start)}</small> : null}</th><td>{format(point.value, metric.format, true)}{point.reason ? <small>{point.reason}</small> : null}{point.formula ? <small>Derived: {point.formula}</small> : null}</td><td>{point.sources.length ? point.sources.map((source, index) => <div key={`${source.url || source.documentUrl}:${index}`}><SecLink href={source.url || source.documentUrl}>{source.form || "SEC filing"}{source.filed ? ` · ${date(source.filed)}` : ""}</SecLink>{source.tag ? <small>{source.taxonomy ? `${source.taxonomy}:` : ""}{source.tag}</small> : null}</div>) : <small>No verified source for this value.</small>}</td></tr>)}</tbody></table></div></details>
  </div>;
}
function FinancialResearch({ research, id }: { research: Research; id: string }) {
  const [requestedMetric, setRequestedMetric] = useState("");
  const financials = research.financials;
  const metrics = financials.metrics;
  const selected = metrics.find(metric => metric.key === requestedMetric) || metrics.find(metric => metric.points.some(point => finite(point.value))) || metrics[0];
  const latestPeriod = [...financials.periods].sort((a, b) => b.end.localeCompare(a.end))[0];
  return <section className={s.financialSection} aria-labelledby={`${id}-financials`}>
    <div className={s.sectionHeading}><div><span className={s.eyebrow}>Current company research</span><h3 id={`${id}-financials`}>Inside the business</h3></div><span className={s.dateBadge}><Clock3 size={13} aria-hidden="true" />SEC evidence through {date(financials.asOf || research.observedAt)}</span></div>
    <p className={s.caption}>These are the issuer’s latest available annual financials, separate from the manager’s {quarter(research.selectedPeriod)} holding. {financials.lens === "banking" ? "Bank measures reflect lending, deposits, and capital." : financials.lens === "insurance" ? "Insurance measures reflect underwriting and the balance sheet." : "Select a measure to explore its history."}</p>
    {financials.status === "ready" && metrics.length ? <><div className={s.metrics} role="group" aria-label="Choose a company financial measure">{metrics.map(metric => {
      const latest = [...metric.points].sort((a, b) => b.period.end.localeCompare(a.period.end))[0];
      return <button type="button" key={metric.key} className={s.metricButton} aria-pressed={selected?.key === metric.key} onClick={() => setRequestedMetric(metric.key)}><span>{metric.label}</span><strong title={format(latest?.value, metric.format, true)}>{format(latest?.value, metric.format)}</strong><small>{latest?.period?.end ? `FY ended ${date(latest.period.end)}` : latestPeriod ? `FY ended ${date(latestPeriod.end)}` : "Period unavailable"}</small></button>;
    })}</div>{selected ? <MetricChart metric={selected} id={id} /> : null}</> : <div className={s.quietState}><FileText size={22} aria-hidden="true" /><div><h4>Financial facts are unavailable</h4><p>{financials.note || "The issuer is verified, but a reliable comparable annual financial series is not available. Its SEC filings remain available below."}</p></div></div>}
    {financials.status === "ready" && financials.note ? <p className={s.caption}>{financials.note}</p> : null}
  </section>;
}

export default function ThirteenFCompanyPanel({ holding, data, onClose, onViewHistory }: { holding: Holding; data: any; onClose: () => void; onViewHistory: (key: string) => void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Remote>({ key: "", status: "loading", data: null, error: "" });
  const cik = String(data.manager.cik), period = String(data.selectedPeriod), holdingKey = holding.key;
  const requestKey = `${cik}:${period}:${holdingKey}`;
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    if (element && !element.open) element.showModal();
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    return () => { element?.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 75000);
    setState({ key: requestKey, status: "loading", data: null, error: "" });
    fetchResearch(cik, period, holdingKey, controller.signal, attempt > 0).then(result => {
      if (!disposed) setState({ key: requestKey, status: "ready", data: result, error: "" });
    }).catch(error => {
      if (!disposed) setState({ key: requestKey, status: "error", data: null, error: controller.signal.aborted ? "The SEC lookup took too long. Retry to continue verifying this holding." : error.message });
    }).finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [cik, period, holdingKey, requestKey, attempt]);
  const current = state.key === requestKey ? state : { ...state, status: "loading", data: null };
  const research = current.data;
  const resolved = research?.status === "ready" && research.identity.status === "resolved";
  const issuer = resolved ? research.identity.issuer : null;
  const verifiedHolding = research?.holding || holding;
  const filings = Array.isArray(data.portfolio?.filings) ? data.portfolio.filings : [];
  const sourceFilings = filings.filter((filing: any) => !filing.superseded);
  const managerSource = [...sourceFilings].reverse().find((filing: any) => secUrl(filing.primaryUrl || filing.indexUrl)) || filings[0];
  return <dialog ref={dialog} className={s.panel} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); onCloseRef.current(); }} onClick={event => { if (event.target !== event.currentTarget) return; const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onCloseRef.current(); }}>
    <header className={s.header}><div><span className={s.eyebrow}><Building2 size={14} aria-hidden="true" />Holding research</span><h2 id={`${id}-title`}>{holding.issuer || "Reported security"}</h2><p id={`${id}-description`}>{holding.classTitle || "Class not supplied"}{holding.putCall ? <b>{holding.putCall}</b> : null}<span>CUSIP {holding.cusip || "not supplied"}</span></p></div><button ref={closeButton} type="button" className={s.closeButton} aria-label="Close company research" onClick={onClose}><X size={21} /></button></header>
    <div className={s.body}>
      <section className={s.holdingContext} aria-labelledby={`${id}-holding`}><div className={s.contextHeading}><div><span className={s.eyebrow}>Manager disclosure</span><h3 id={`${id}-holding`}>{quarter(period)} position</h3></div><span className={s.quarterBadge}>{date(period)}</span></div><p className={s.managerName}>{data.manager.name}</p><div className={s.contextMetrics}><div><span>{holding.putCall ? "Underlying reported value" : "Reported value"}</span><strong title={finite(verifiedHolding.valueUsd) ? fullCurrency.format(verifiedHolding.valueUsd) : undefined}>{money(verifiedHolding.valueUsd)}</strong></div><div><span>Share of this 13F</span><strong>{finite(verifiedHolding.weightPct) ? `${verifiedHolding.weightPct.toFixed(2)}%` : "Unavailable"}</strong></div><div><span>{holding.quantityType === "PRN" ? "Principal amount" : holding.putCall ? "Underlying shares" : "Reported shares"}</span><strong>{finite(verifiedHolding.quantity) ? numeric.format(verifiedHolding.quantity) : "Unavailable"}</strong></div></div><div className={s.contextFooter}><SecLink href={managerSource?.primaryUrl || managerSource?.indexUrl}>Latest 13F filing{managerSource?.filingDate ? ` · filed ${date(managerSource.filingDate)}` : ""}</SecLink><button type="button" onClick={() => onViewHistory(holdingKey)}><History size={14} aria-hidden="true" />Holding history<ArrowRight size={14} aria-hidden="true" /></button></div>{sourceFilings.length ? <details className={s.holdingEvidence}><summary>13F source chain · {sourceFilings.length} filing{sourceFilings.length === 1 ? "" : "s"}<ChevronDown size={15} aria-hidden="true" /></summary><div><p>These filings and information tables form the selected snapshot. Amendments can add holdings or replace an earlier report.</p>{sourceFilings.map((filing: any, index: number) => <div key={filing.accession || index}><SecLink href={filing.primaryUrl || filing.indexUrl}>{filing.form || "13F"} · filed {date(filing.filingDate)}</SecLink>{Array.isArray(filing.tableUrls) ? filing.tableUrls.map((url: string, tableIndex: number) => <SecLink key={url} href={url}>Information table{filing.tableUrls.length > 1 ? ` ${tableIndex + 1}` : ""}</SecLink>) : null}</div>)}</div></details> : null}{holding.putCall ? <p className={s.contextNote}>The 13F value relates to the option’s underlying security. It does not measure the option premium, delta, or the manager’s net exposure.</p> : null}</section>
      {current.status === "loading" ? <div className={s.loading} role="status"><div className={s.lookupHeading}><Search size={19} aria-hidden="true" /><div><strong>Following the SEC evidence</strong><p>Verifying the security’s issuer, then loading its financial facts and filings.</p></div></div><div className={s.skeletonGrid} aria-hidden="true"><i /><i /><i /><i /></div><div className={s.skeletonChart} aria-hidden="true"><i /><i /><i /><i /></div></div> : null}
      {current.status === "error" ? <div className={s.quietState} role="alert"><RefreshCw size={23} aria-hidden="true" /><div><h3>Company research could not load</h3><p>{current.error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />Retry company research</button></div></div> : null}
      {research && !resolved ? <section className={s.unresolved} aria-labelledby={`${id}-unresolved`}><span className={s.statusBadge}><Search size={14} aria-hidden="true" />Issuer link unverified</span><h3 id={`${id}-unresolved`}>Keep the security’s identity clear.</h3><p>{research.identity.reason || "The available SEC evidence does not establish a unique operating-company issuer for this security."}</p><p className={s.caption}>The manager’s reported holding is available above. Company financials will appear only when SEC evidence connects this exact CUSIP to an issuer. You can still explore the holding’s reported history.</p><div className={s.securityDetails}><div><span>Reported issuer</span><strong>{holding.issuer}</strong></div><div><span>Security identifier</span><strong>{holding.cusip}</strong></div><div><span>Reported class</span><strong>{holding.classTitle || "Not supplied"}</strong></div></div><button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />Recheck SEC evidence</button></section> : null}
      {research && resolved && issuer ? <><section className={s.identity} aria-labelledby={`${id}-issuer`}><div className={s.identityTop}><span className={s.statusBadge}><ShieldCheck size={14} aria-hidden="true" />SEC issuer link verified</span><span className={s.cik}>CIK {issuer.cik}</span></div><h3 id={`${id}-issuer`}>{issuer.name}</h3>{issuer.tickers?.length ? <p className={s.tickers}><span>Issuer ticker{issuer.tickers.length === 1 ? "" : "s"}</span>{issuer.tickers.slice(0, 8).map(ticker => <b key={ticker}>{ticker}</b>)}</p> : null}<p className={s.caption}>Company-level research for the verified issuer. Ticker aliases identify the issuer; the CUSIP identifies the reported security class.{holding.putCall ? " Financial statements describe the underlying business, not the option contract." : ""}{research.identity.securityType === "depositary_receipt" ? ` ${research.identity.reason || "This security is a depositary receipt. Issuer reporting currency and receipt terms may differ."}` : ""}</p><details className={s.identityEvidence}><summary>How this security was matched<ChevronDown size={15} aria-hidden="true" /></summary><div><p>SEC ownership disclosures explicitly connect CUSIP {holding.cusip} to issuer CIK {issuer.cik}.</p>{research.identity.evidence?.map((evidence, index) => <div key={`${evidence.url}:${index}`}><SecLink href={evidence.sourceUrl || evidence.url}>{evidence.form || "SEC ownership disclosure"}{evidence.filingDate ? ` · ${date(evidence.filingDate)}` : ""}</SecLink>{evidence.classTitle ? <small>{evidence.classTitle}</small> : null}</div>)}<SecLink href={issuer.submissionsUrl || `https://data.sec.gov/submissions/CIK${issuer.cik}.json`}>SEC issuer record</SecLink></div></details></section><FinancialResearch key={requestKey} research={research} id={id} /><section className={s.filingsSection} aria-labelledby={`${id}-filings`}><div className={s.sectionHeading}><div><span className={s.eyebrow}>Back to the evidence</span><h3 id={`${id}-filings`}>Recent company filings</h3></div><FileText size={20} aria-hidden="true" /></div>{research.filings.length ? <ul className={s.filingList}>{research.filings.slice(0, 6).map((filing, index) => <li key={filing.accession || `${filing.form}:${index}`}><div><span className={s.formBadge}>{filing.form}</span><div><strong>Filed {date(filing.filingDate)}</strong><small>{filing.reportDate ? `Report period ${date(filing.reportDate)}` : "SEC company filing"}</small></div></div><SecLink href={filing.documentUrl}>Open filing</SecLink></li>)}</ul> : <p className={s.caption}>Recent filing links are temporarily unavailable. Open the SEC issuer record to inspect the filing history.</p>}<SecLink href={`https://www.sec.gov/edgar/browse/?CIK=${issuer.cik}&owner=exclude`}>All issuer filings at the SEC</SecLink></section></> : null}
      {research && resolved ? <div className={s.refreshResearch}><p>{research.financials.status !== "ready" || !research.filings.length ? "Some company research is unavailable. Retry the current SEC evidence." : "Refresh the verified issuer’s latest SEC evidence."}</p><button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />Refresh company research</button></div> : null}
      {research?.issues?.length ? <details className={s.coverage}><summary>Research coverage notes<ChevronDown size={15} aria-hidden="true" /></summary><ul>{research.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details> : null}
      <p className={s.footerNote}>13F reports are delayed disclosures of reportable securities. Report share is a percentage of disclosed value, not the manager’s full portfolio allocation or a measure of conviction.</p>
    </div>
  </dialog>;
}
