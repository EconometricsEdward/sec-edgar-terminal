"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, ChartNoAxesCombined, FileText, Layers3, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { useSecFilerSearch } from "../../utils/useSecFilerSearch.js";
import { exactFilerMatch, filerCik } from "../../utils/secFilerSearch.js";
import { compare13FPortfolios } from "../../utils/thirteenF.js";
import s from "./ThirteenFWorkspace.module.css";

const ThirteenFHistory = dynamic(() => import("./ThirteenFHistory"), { loading: () => <p role="status">Opening portfolio history…</p> });
const ThirteenFCompanyPanel = dynamic(() => import("./ThirteenFCompanyPanel"), { ssr: false });
const HoldingActionContext = createContext<((holding: any) => void) | null>(null);

type Holding = { key: string; cusip: string; issuer: string; classTitle: string; putCall: "PUT" | "CALL" | null; quantity: number | null; quantityType: string; valueUsd: number | null; weightPct: number | null; investmentDiscretion?: string; sourceRowCount?: number };
type Report = { period: string; filingCount: number; latestFiled: string; forms: string[] };
type Response = { status: "ready" | "unavailable"; manager: { cik: string; name: string; submissionsUrl?: string }; reports: Report[]; selectedPeriod: string | null; portfolio: any; summary: any; coverage: any; observedAt: string };
type Remote = { key: string; status: "idle" | "loading" | "ready" | "error"; data: Response | null; error: string };
const cache = new Map<string, { data: Response; expires: number; bytes: number }>();
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const PAGE_SIZE = 25;
const empty: Remote = { key: "", status: "idle", data: null, error: "" };
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compactMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const exactMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const money = (v: unknown) => finite(v) ? compactMoney.format(v) : "Unavailable";
const number = (v: unknown) => finite(v) ? whole.format(v) : "—";
const percent = (v: unknown) => finite(v) ? `${v.toFixed(1)}%` : "—";
const signed = (v: unknown, suffix = "") => finite(v) ? `${v > 0 ? "+" : ""}${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}${suffix}` : "—";
const safeSecUrl = (value: unknown) => {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && ["www.sec.gov", "sec.gov", "data.sec.gov"].includes(url.hostname) ? url.href : null; } catch { return null; }
};
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return "Not available";
  const stamp = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(stamp.getTime()) ? stamp.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Not available";
}
function quarter(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `Q${Math.ceil(Number(value.slice(5, 7)) / 3)} ${value.slice(0, 4)}` : value;
}
function priorQuarter(period: string) {
  if (!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(period)) return "";
  const year = Number(period.slice(0, 4));
  const previous: Record<string, string> = { "03-31": `${year - 1}-12-31`, "06-30": `${year}-03-31`, "09-30": `${year}-06-30`, "12-31": `${year}-09-30` };
  return previous[period.slice(5)] || "";
}
async function fetchReport(cik: string, period: string, signal: AbortSignal, force: boolean) {
  const key = `${cik}:${period}`;
  const stored = cache.get(key);
  if (!force && stored && stored.expires > Date.now()) return stored.data;
  const query = new URLSearchParams({ cik });
  if (period) query.set("period", period);
  const response = await fetch(`/api/fund-13f?${query}`, { signal });
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) throw new Error("This report is too large to open here. Use the SEC filings link to inspect its source tables.");
  const reader = response.body?.getReader();
  let raw = "", bytes = 0;
  if (reader) {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("This report exceeds the workspace size limit. Its source tables remain available in SEC filings."); }
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
  } else { raw = await response.text(); bytes = raw.length * 2; }
  signal.throwIfAborted();
  if (bytes > MAX_RESPONSE_BYTES) throw new Error("This report exceeds the workspace size limit. Open its SEC information tables instead.");
  let data: Response;
  try { data = JSON.parse(raw); } catch { throw new Error("The SEC report could not be opened. Please retry."); }
  if (!response.ok) throw new Error(typeof (data as any)?.error === "string" ? (data as any).error : "SEC report data is temporarily unavailable. Please retry.");
  if (!["ready", "unavailable"].includes(data?.status) || data.manager?.cik !== cik || typeof data.manager.name !== "string" || !data.manager.name.trim() || !Array.isArray(data.reports) || data.reports.length > 100 || data.reports.some(report => !report || !/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(report.period) || !Array.isArray(report.forms)) || (period && data.selectedPeriod !== period) || (data.status === "ready" && (!data.portfolio || data.portfolio.cik !== cik || data.portfolio.period !== data.selectedPeriod || !Array.isArray(data.portfolio.filings) || !Array.isArray(data.portfolio.issues) || !Array.isArray(data.portfolio.holdings) || data.portfolio.holdings.length > 20000))) throw new Error("This response could not be verified against the selected manager and reporting period. Please retry.");
  if (bytes <= MAX_CACHE_BYTES && data.status === "ready" && data.portfolio?.complete && data.coverage?.selectedPeriodComplete) {
    cache.delete(key);
    let total = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (cache.size && (cache.size >= 4 || total + bytes > MAX_CACHE_BYTES)) {
      const oldest = cache.keys().next().value as string;
      total -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    cache.set(key, { data, bytes, expires: Date.now() + 300000 });
  }
  return data;
}
function useReport(cik: string, period: string, enabled: boolean, attempt: number) {
  const key = `${cik}:${period}`;
  const [state, setState] = useState<Remote>(empty);
  useEffect(() => {
    if (!enabled || !cik) return;
    const controller = new AbortController();
    let disposed = false;
    const deadline = setTimeout(() => controller.abort(), 90000);
    setState({ key, status: "loading", data: null, error: "" });
    fetchReport(cik, period, controller.signal, attempt > 0).then(data => {
      if (!disposed) setState({ key, status: "ready", data, error: "" });
    }).catch(error => {
      if (!disposed) setState({ key, status: "error", data: null, error: controller.signal.aborted ? "The SEC request took too long. Retry to continue loading this report." : error.message });
    }).finally(() => clearTimeout(deadline));
    return () => { disposed = true; clearTimeout(deadline); controller.abort(); };
  }, [cik, period, key, enabled, attempt]);
  return enabled && cik ? state.key === key ? state : { ...empty, key, status: "loading" as const } : empty;
}
function csvCell(value: unknown) {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
function downloadCsv(filename: string, rows: unknown[][]) {
  const blob = new Blob(["\ufeff", rows.map(row => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function SecLink({ href, children }: { href: unknown; children: React.ReactNode }) {
  const url = safeSecUrl(href);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={13} aria-hidden="true" /></a> : null;
}
function Pagination({ page, pages, count, onPage }: { page: number; pages: number; count: number; onPage: (page: number) => void }) {
  return <div className={s.pagination}><span>{count ? `${number(page * PAGE_SIZE + 1)}–${number(Math.min((page + 1) * PAGE_SIZE, count))} of ${number(count)}` : "No matching positions"}</span><div><button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)}><ChevronLeft size={16} /></button><span>Page {page + 1} of {Math.max(1, pages)}</span><button type="button" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}><ChevronRight size={16} /></button></div></div>;
}
function PositionName({ holding }: { holding: any }) {
  const onOpen = useContext(HoldingActionContext);
  return <div className={s.positionName}>{onOpen ? <button type="button" className={s.positionButton} onClick={() => onOpen(holding)} aria-label={`Research ${holding.issuer || holding.cusip}`}><strong>{holding.issuer || "Issuer not supplied"}</strong><ArrowUpRight size={12} aria-hidden="true" /></button> : <strong>{holding.issuer || "Issuer not supplied"}</strong>}<span>{holding.classTitle || "Class not supplied"}{holding.putCall ? <b className={s.option}>{holding.putCall}</b> : null}</span></div>;
}
function ManagerSearch({ onChoose, compact = false }: { onChoose: (cik: string) => void; compact?: boolean }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const cik = filerCik(query.replace(/^CIK\s*/i, ""));
  const search = useSecFilerSearch(query, open && !cik);
  function choose(value: string) { setOpen(false); setQuery(""); setMessage(""); onChoose(value); }
  function submit(event: React.FormEvent) {
    event.preventDefault(); setMessage("");
    if (cik) { choose(cik); return; }
    const exact = exactFilerMatch(query, search.results, { truncated: search.truncated, warning: search.warning });
    if (exact) { choose(exact.cik); return; }
    setOpen(true);
    setMessage(query.trim().length < 2 ? "Enter a manager’s legal name or SEC CIK." : search.status === "loading" ? "Searching the SEC. Select the correct legal entity when results arrive." : "Select a matching SEC entity below, or enter its CIK.");
  }
  return <div className={`${s.search} ${compact ? s.compactSearch : ""}`}>
    <form onSubmit={submit} role="search" aria-label="Find a 13F manager">
      <label htmlFor={compact ? "manager-search-compact" : "manager-search"}>{compact ? "Change manager" : "Find an institutional investment manager"}</label>
      <div className={s.searchField}><Search size={19} aria-hidden="true" /><input ref={input} id={compact ? "manager-search-compact" : "manager-search"} type="search" value={query} maxLength={160} placeholder="Manager name or CIK · e.g. D1 Capital" autoComplete="off" onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); setMessage(""); }} onKeyDown={event => { if (event.key === "Escape") setOpen(false); }} /><button type="submit" className={s.primary}>Explore<ArrowRight size={16} aria-hidden="true" /></button></div>
    </form>
    {message ? <p className={s.searchMessage} role="status">{message}</p> : null}
    {open && query.trim().length >= 2 && !cik ? <div className={s.results}>
      <div className={s.resultsHeading}><span>SEC legal entities</span><button type="button" aria-label="Close manager results" onClick={() => { input.current?.focus(); setOpen(false); }}><X size={15} /></button></div>
      {search.status === "loading" ? <p role="status"><RefreshCw className={s.spin} size={15} />Searching SEC filer records…</p> : null}
      {search.status === "error" ? <div className={s.searchError} role="alert"><p>{search.error}</p><button type="button" onClick={search.retry}>Retry search</button></div> : null}
      {search.results.length ? <ul>{search.results.map((result: any) => <li key={result.cik}><button type="button" onClick={() => choose(result.cik)}><div><strong>{result.name}</strong><span>CIK {result.cik}</span></div><span className={s.resultBadge}>{result.formTypes?.some((form: string) => form.startsWith("13F")) ? "13F filer" : "SEC filer"}<ArrowRight size={14} /></span></button></li>)}</ul> : null}
      {search.status === "ready" && !search.results.length ? <p>No matching entity was returned. Try its full legal name or CIK.</p> : null}
      {search.warning ? <p role="status">{search.warning} <button type="button" onClick={search.retry}>Retry</button></p> : null}
      {search.truncated ? <p>SEC name results are limited. Refine the legal name or use a CIK.</p> : null}
      {search.results.length ? <p>Choose the reporting manager. Related funds can have different CIKs; 13F availability is checked when opened.</p> : null}
    </div> : null}
  </div>;
}
function Landing({ onChoose }: { onChoose: (cik: string) => void }) {
  return <div className={s.landing}>
    <div className={s.landingHero}><div><span className={s.eyebrow}><Building2 size={15} /> Institutional holdings · SEC Form 13F</span><h1>Follow the holdings.<br /><em>Understand the changes.</em></h1><p className={s.lead}>Explore what an investment manager disclosed, how concentrated its reported positions are, and what changed between quarters.</p></div><div className={s.heroMark} aria-hidden="true"><div className={s.markBars}><i /><i /><i /><i /><i /></div><span>13F</span><small>REPORTED. TRACEABLE.</small></div></div>
    <ManagerSearch onChoose={onChoose} />
    <div className={s.examples}><span>Explore a manager</span>{[{ name: "D1 Capital", cik: "0001747057" }, { name: "Bridgewater", cik: "0001350694" }, { name: "Berkshire Hathaway", cik: "0001067983" }, { name: "Renaissance", cik: "0001037389" }].map(manager => <button type="button" key={manager.cik} onClick={() => onChoose(manager.cik)}>{manager.name}<ArrowUpRight size={13} /></button>)}</div>
    <div className={s.featureGrid}><article><span>01</span><Layers3 size={22} /><h3>See the reported portfolio</h3><p>Inspect position sizes, share classes, options, and the weight of the largest disclosed holdings.</p></article><article><span>02</span><RefreshCw size={22} /><h3>Compare quarter to quarter</h3><p>Separate newly reported positions from quantity changes and shifts in reported portfolio share.</p></article><article><span>03</span><ShieldCheck size={22} /><h3>Go back to the evidence</h3><p>Trace every snapshot to its SEC information tables, original filing, and applicable amendments.</p></article></div>
    <div className={s.scopeStrip}><Clock3 size={18} /><p><strong>A reported snapshot, with a reporting delay.</strong> Form 13F generally arrives up to 45 days after quarter end. It covers reportable securities, not a manager’s complete assets, cash, short positions, or investment performance.</p><SecLink href="https://www.sec.gov/divisions/investment/13ffaq">About Form 13F</SecLink></div>
  </div>;
}
function Overview({ data, onView }: { data: Response; onView: (view: string) => void }) {
  const portfolio = data.portfolio;
  const summary = data.summary || {};
  const holdings: Holding[] = portfolio.holdings;
  const top = useMemo(() => [...holdings].filter(h => finite(h.valueUsd)).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 10), [holdings]);
  const max = Math.max(0, ...top.map(h => h.valueUsd || 0));
  const top10 = finite(summary.top10Pct) ? Math.min(100, Math.max(0, summary.top10Pct)) : null;
  const top5 = summary.top5Pct;
  const mix = [
    { label: "Shares · non-option", value: summary.ordinaryValueUsd, className: s.mixOrdinary },
    { label: "Principal-amount securities", value: summary.principalValueUsd, className: s.mixPrincipal },
    { label: "Calls · underlying value", value: summary.callValueUsd, className: s.mixCalls },
    { label: "Puts · underlying value", value: summary.putValueUsd, className: s.mixPuts },
  ].filter(item => finite(item.value) && item.value > 0);
  return <div className={s.overview}>
    <section className={s.rankPanel} aria-labelledby="largest-positions-heading"><div className={s.panelHeading}><div><span className={s.eyebrow}>Where the reported value sits</span><h3 id="largest-positions-heading">Largest disclosed positions</h3></div><button type="button" onClick={() => onView("holdings")}>All holdings<ArrowRight size={15} /></button></div><p className={s.caption}>{portfolio.complete ? "Share of the total value in this 13F snapshot. Separate share classes and options remain separate positions." : "Captured reported values. Portfolio percentages are withheld while coverage is incomplete."}</p>
      {top.length ? <div className={s.rankList}>{top.map((holding, index) => <div className={s.rankRow} key={holding.key}><span className={s.rankNumber}>{String(index + 1).padStart(2, "0")}</span><div className={s.rankContent}><div><PositionName holding={holding} /><span className={s.rankValue} title={finite(holding.valueUsd) ? exactMoney.format(holding.valueUsd) : undefined}>{money(holding.valueUsd)}<small>{percent(holding.weightPct)}</small></span></div><div className={s.track}><span style={{ width: `${max ? (holding.valueUsd || 0) / max * 100 : 0}%` }} /></div></div></div>)}</div> : <p className={s.empty}>No position values are available in this report.</p>}
    </section>
    <div className={s.overviewAside}><section className={s.concentration} aria-labelledby="concentration-heading"><span className={s.eyebrow}>Concentration</span><h3 id="concentration-heading">How much sits in the top 10?</h3><div className={s.ring} role="img" aria-label={top10 === null ? "Top 10 share unavailable because complete reported value is not verified" : `Top 10 positions account for ${top10.toFixed(1)} percent of reported value`} style={{ background: top10 === null ? "var(--fund-line)" : `conic-gradient(var(--fund-green) ${top10}%, var(--fund-line) 0)` }}><div><strong>{percent(top10)}</strong><span>of reported value</span></div></div><div className={s.concentrationDetails}><div><span>Top 5 positions</span><strong>{percent(top5)}</strong></div><div><span>Outside the top 10</span><strong>{top10 === null ? "—" : percent(100 - top10)}</strong></div></div><p className={s.caption}>This is concentration within the 13F report. It is not the manager’s total portfolio allocation.</p></section>
      <section className={s.mixPanel}><span className={s.eyebrow}>Read the composition</span><h3>What the values represent</h3>{mix.length ? <><div className={s.mixBar} aria-hidden="true">{mix.map(item => <span key={item.label} className={item.className} style={{ flex: item.value }} />)}</div><div className={s.mixLegend}>{mix.map(item => <div key={item.label}><span><i className={item.className} />{item.label}</span><strong>{money(item.value)}</strong></div>)}</div></> : <p className={s.caption}>Composition is unavailable for this report.</p>}{finite(summary.principalValueUsd) && summary.principalValueUsd > 0 ? <p className={s.caption}>{money(summary.principalValueUsd)} is reported with principal-amount units.</p> : null}<p className={s.caption}>Options are shown separately. Their reported values reflect underlying securities, not option premiums or directional exposure.</p></section>
      <button type="button" className={s.nextCard} onClick={() => onView("changes")}><div><span className={s.eyebrow}>Next question</span><strong>What changed this quarter?</strong><span>Compare the reported positions.</span></div><ArrowRight size={22} /></button>
    </div>
  </div>;
}
function Holdings({ data }: { data: Response }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [sort, setSort] = useState("value");
  const [requestedPage, setPage] = useState(0);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data.portfolio.holdings as Holding[]).filter(row => (!needle || `${row.issuer} ${row.cusip} ${row.classTitle}`.toLowerCase().includes(needle)) && (type === "all" || type === "ordinary" && !row.putCall || type === "principal" && row.quantityType === "PRN" || row.putCall === type)).sort((a, b) => sort === "name" ? a.issuer.localeCompare(b.issuer) : sort === "quantity" ? (b.quantity ?? -Infinity) - (a.quantity ?? -Infinity) : (b.valueUsd ?? -Infinity) - (a.valueUsd ?? -Infinity));
  }, [data.portfolio.holdings, query, type, sort]);
  const pages = Math.ceil(rows.length / PAGE_SIZE), page = Math.min(requestedPage, Math.max(0, pages - 1));
  function exportRows() {
    const filings = data.portfolio.filings || [];
    downloadCsv(`13f-${data.manager.cik}-${data.selectedPeriod}-holdings.csv`, [["Manager", "CIK", "Report period", "Coverage complete", "Issuer", "CUSIP", "Share class", "Put/call", "Quantity", "Quantity type", "Reported value USD", "Share of reported value %", "Investment discretion", "Source rows", "Source accessions", "SEC filing indexes", "SEC information tables"], ...rows.map(row => [data.manager.name, data.manager.cik, data.selectedPeriod, data.portfolio.complete, row.issuer, row.cusip, row.classTitle, row.putCall || "", row.quantity, row.quantityType, row.valueUsd, row.weightPct, row.investmentDiscretion, row.sourceRowCount, filings.map((f: any) => f.accession).join("; "), filings.map((f: any) => f.indexUrl).join("; "), filings.flatMap((f: any) => f.tableUrls || []).join("; ")])]);
  }
  return <section className={s.tablePanel}><div className={s.panelHeading}><div><span className={s.eyebrow}>The disclosed positions</span><h3>Holdings detail</h3></div><button type="button" onClick={exportRows} disabled={!rows.length}><ArrowDownToLine size={15} />Export {rows.length === data.portfolio.holdings.length ? "holdings" : "filtered rows"}</button></div><div className={s.filters}><label className={s.filterSearch}>Find a position<input type="search" value={query} placeholder="Issuer, CUSIP, or share class" onChange={e => { setQuery(e.target.value); setPage(0); }} /></label><label>Security type<select value={type} onChange={e => { setType(e.target.value); setPage(0); }}><option value="all">All reported securities</option><option value="ordinary">Non-option securities</option><option value="CALL">Calls</option><option value="PUT">Puts</option><option value="principal">Principal-amount units</option></select></label><label>Sort by<select value={sort} onChange={e => { setSort(e.target.value); setPage(0); }}><option value="value">Reported value · largest first</option><option value="name">Issuer · A to Z</option><option value="quantity">Quantity · largest first</option></select></label></div>
    <div className={s.tableScroll} tabIndex={0} role="region" aria-label="13F holdings table, scroll horizontally for all columns"><table className={s.table}><thead><tr><th scope="col">Issuer / share class</th><th scope="col">CUSIP</th><th scope="col" className={s.numeric}>Reported value</th><th scope="col" className={s.numeric}>Report share</th><th scope="col" className={s.numeric}>Quantity</th><th scope="col">Units</th></tr></thead><tbody>{rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row => <tr key={row.key}><td><PositionName holding={row} /></td><td className={s.identifier}>{row.cusip || "Not supplied"}</td><td className={s.numeric} title={finite(row.valueUsd) ? exactMoney.format(row.valueUsd) : undefined}>{money(row.valueUsd)}</td><td className={s.numeric}><div className={s.weightCell}><span>{percent(row.weightPct)}</span>{finite(row.weightPct) ? <i style={{ width: `${Math.min(100, Math.max(0, row.weightPct))}%` }} /> : null}</div></td><td className={s.numeric}>{number(row.quantity)}</td><td className={s.units}>{row.quantityType === "PRN" ? "Principal" : row.quantityType === "SH" ? "Shares" : "Not supplied"}</td></tr>)}</tbody></table>{!rows.length ? <p className={s.empty}>No positions match these filters.</p> : null}</div><Pagination page={page} pages={pages} count={rows.length} onPage={setPage} /><p className={s.caption}>Positions are identified by CUSIP, option type, and quantity units. CUSIP identifies the security class. Quantities across different securities or units are not directly comparable. Report share uses total disclosed value; it is not fund weight or net asset value.</p></section>;
}
function Changes({ data, before, onRetry }: { data: Response; before: Remote; onRetry: () => void }) {
  const [status, setStatus] = useState("all");
  const [measure, setMeasure] = useState("weight");
  const [requestedPage, setPage] = useState(0);
  const comparison: any = useMemo(() => before.data?.portfolio ? compare13FPortfolios(before.data.portfolio, data.portfolio) : null, [before.data, data.portfolio]);
  const rows = useMemo(() => {
    if (!comparison?.available) return [];
    return comparison.changes.filter((row: any) => status === "all" ? row.status !== "unchanged" || row.weightChangePp !== 0 || row.valueChangeUsd !== 0 : row.status === status).sort((a: any, b: any) => {
      const field = measure === "weight" ? "weightChangePp" : measure === "value" ? "valueChangeUsd" : "quantityChangePct";
      return Math.abs(b[field] || 0) - Math.abs(a[field] || 0);
    });
  }, [comparison, status, measure]);
  const pages = Math.ceil(rows.length / PAGE_SIZE), page = Math.min(requestedPage, Math.max(0, pages - 1));
  const chart = rows.filter((row: any) => finite(row.weightChangePp) && row.weightChangePp !== 0).slice(0, 8);
  const chartMax = Math.max(0.01, ...chart.map((row: any) => Math.abs(row.weightChangePp)));
  const labels: Record<string, string> = { "newly-reported": "Newly reported", "no-longer-reported": "No longer reported", increased: "Quantity increased", decreased: "Quantity decreased", unchanged: "Quantity unchanged", unavailable: "Not comparable" };
  if (before.status === "loading") return <div className={s.loading} role="status"><RefreshCw className={s.spin} size={25} /><h3>Opening the previous quarter</h3><p>Reading its information tables and amendments before comparing positions.</p></div>;
  if (before.status === "error") return <div className={s.emptyPanel} role="alert"><h3>The previous report could not be loaded</h3><p>{before.error}</p><button type="button" onClick={onRetry}><RefreshCw size={15} />Retry previous quarter</button></div>;
  if (!comparison?.available) return <div className={s.emptyPanel}><Layers3 size={27} /><h3>A reliable comparison needs two complete quarters</h3><p>{comparison?.reason || (data.portfolio?.comparable === false ? "The current snapshot does not support a complete quarter comparison. Review its filing coverage and confidential-treatment notes." : "The immediately preceding quarter is not available in the loaded SEC history. Select another reporting period or inspect the source filings.")}</p><p className={s.caption}>Missing positions are not treated as zero. Notices, incomplete tables, unresolved amendments, and confidential omissions can prevent a comparable public snapshot.</p></div>;
  const counts = comparison.counts || {};
  function exportRows() {
    downloadCsv(`13f-${data.manager.cik}-${comparison.beforePeriod}-to-${comparison.afterPeriod}-changes.csv`, [["Manager", "CIK", "Previous period", "Current period", "Issuer", "CUSIP", "Share class", "Put/call", "Units", "Status", "Previous quantity", "Current quantity", "Quantity change", "Quantity change %", "Previous reported value USD", "Current reported value USD", "Reported value change USD", "Previous report share %", "Current report share %", "Report share change percentage points"], ...rows.map((row: any) => [data.manager.name, data.manager.cik, comparison.beforePeriod, comparison.afterPeriod, row.issuer, row.cusip, row.classTitle, row.putCall, row.quantityType, labels[row.status] || row.status, row.beforeQuantity, row.afterQuantity, row.quantityChange, row.quantityChangePct, row.beforeValueUsd, row.afterValueUsd, row.valueChangeUsd, row.beforeWeightPct, row.afterWeightPct, row.weightChangePp])]);
  }
  return <div className={s.changes}><div className={s.comparisonHeading}><div><span className={s.eyebrow}>Two reported snapshots</span><h3>{quarter(comparison.beforePeriod)}<ArrowRight size={20} />{quarter(comparison.afterPeriod)}</h3><p>{date(comparison.beforePeriod)} to {date(comparison.afterPeriod)}</p></div><button type="button" disabled={!rows.length} onClick={exportRows}><ArrowDownToLine size={15} />Export changes</button></div>
    <div className={s.changeStats}>{[{ label: "Newly reported", value: counts.newlyReported, type: "newly-reported", detail: "Not present in the prior public snapshot" }, { label: "No longer reported", value: counts.noLongerReported, type: "no-longer-reported", detail: "Not present in the current public snapshot" }, { label: "Quantity increased", value: counts.increased, type: "increased", detail: "Matching security and units" }, { label: "Quantity decreased", value: counts.decreased, type: "decreased", detail: "Matching security and units" }].map(item => <button type="button" key={item.type} aria-pressed={status === item.type} onClick={() => { setStatus(status === item.type ? "all" : item.type); setPage(0); }}><span>{item.label}</span><strong>{number(item.value)}</strong><small>{item.detail}</small></button>)}</div>
    <section className={s.changeChartPanel}><div className={s.panelHeading}><div><span className={s.eyebrow}>Shift in the reported mix</span><h3>Which positions took more or less of the report?</h3></div><div className={s.chartLegend}><span><i />Lower share</span><span><i />Higher share</span></div></div><p className={s.caption}>Change in percentage points of disclosed value. Values move with security prices, quantities, and the report’s denominator; these are not trading returns.</p>{chart.length ? <div className={s.changeChart} role="figure" aria-label="Change in each position’s share of reported value, in percentage points">{chart.map((row: any) => <div className={s.changeBarRow} key={row.key}><PositionName holding={row} /><div className={s.signedTrack}><span className={row.weightChangePp >= 0 ? s.positiveBar : s.negativeBar} style={{ width: `${Math.abs(row.weightChangePp) / chartMax * 48}%` }} /><i /></div><strong className={row.weightChangePp >= 0 ? s.positive : s.negative}>{signed(row.weightChangePp, " pp")}</strong></div>)}</div> : <p className={s.empty}>No change in reported portfolio share matches this selection.</p>}</section>
    <section className={s.tablePanel}><div className={s.filters}><label>Position change<select value={status} onChange={e => { setStatus(e.target.value); setPage(0); }}><option value="all">All reported changes</option><option value="newly-reported">Newly reported</option><option value="no-longer-reported">No longer reported</option><option value="increased">Quantity increased</option><option value="decreased">Quantity decreased</option><option value="unchanged">Quantity unchanged</option></select></label><label>Rank by magnitude<select value={measure} onChange={e => { setMeasure(e.target.value); setPage(0); }}><option value="weight">Report-share change</option><option value="quantity">Quantity change %</option><option value="value">Reported-value change</option></select></label><p className={s.filterHint}>Matching uses CUSIP, option type, and quantity units. CUSIP identifies the security class.</p></div><div className={s.tableScroll} tabIndex={0} role="region" aria-label="Quarterly 13F changes table, scroll horizontally for all columns"><table className={s.table}><thead><tr><th scope="col">Issuer / share class</th><th scope="col">Observed change</th><th scope="col" className={s.numeric}>Prior quantity</th><th scope="col" className={s.numeric}>Current quantity</th><th scope="col" className={s.numeric}>Quantity change</th><th scope="col" className={s.numeric}>Report share</th><th scope="col" className={s.numeric}>Value change</th></tr></thead><tbody>{rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row: any) => <tr key={row.key}><td><PositionName holding={row} /><small className={s.identifier}>{row.cusip} · {row.quantityType === "PRN" ? "Principal" : "Shares"}</small></td><td><span className={s.changeBadge}>{labels[row.status] || row.status}</span></td><td className={s.numeric}>{number(row.beforeQuantity)}</td><td className={s.numeric}>{number(row.afterQuantity)}</td><td className={s.numeric}>{signed(row.quantityChange)}<small>{finite(row.quantityChangePct) ? signed(row.quantityChangePct, "%") : "No percentage base"}</small></td><td className={s.numeric}>{signed(row.weightChangePp, " pp")}<small>{percent(row.beforeWeightPct)} → {percent(row.afterWeightPct)}</small></td><td className={s.numeric} title={finite(row.valueChangeUsd) ? exactMoney.format(row.valueChangeUsd) : undefined}>{finite(row.valueChangeUsd) && row.valueChangeUsd > 0 ? "+" : ""}{money(row.valueChangeUsd)}</td></tr>)}</tbody></table>{!rows.length ? <p className={s.empty}>No positions match this selection.</p> : null}</div><Pagination page={page} pages={pages} count={rows.length} onPage={setPage} /></section>
    <div className={s.scopeStrip}><FileText size={18} /><p><strong>Reported changes are research leads.</strong> A new or absent row does not prove a purchase or sale. Corporate actions, manager reporting changes, and security reclassification can also change quantities. Options reflect underlying values; do not interpret them as net directional bets.</p></div>{comparison.issues?.length ? <details className={s.evidenceNotes}><summary>Comparison notes<ChevronDown size={15} /></summary><ul>{comparison.issues.map((issue: string, i: number) => <li key={i}>{issue}</li>)}</ul></details> : null}
  </div>;
}
function Filings({ data, onChoose }: { data: Response; onChoose: (cik: string) => void }) {
  const filings: any[] = data.portfolio?.filings || [];
  return <section className={s.evidencePanel}><div className={s.panelHeading}><div><span className={s.eyebrow}>From filing to finding</span><h3>Evidence for this snapshot</h3></div><Link href={`/filings/${data.manager.cik}`}>All SEC filings<ArrowUpRight size={15} /></Link></div><p className={s.caption}>Original filings and amendments are reconciled for the selected reporting period. A restatement replaces an earlier table; an additions amendment contributes newly reported entries only when the source chain can be verified.</p><div className={s.sourceTimeline}>{filings.map((filing, i) => <article key={filing.accession || i} className={s.sourceCard}><span className={s.sourceDot}><FileText size={16} /></span><div><div className={s.sourceTitle}><h4>{filing.form || "13F filing"}</h4><span>{filing.isAmendment ? filing.amendmentType || "Amendment" : "Original filing"}</span>{filing.superseded ? <span className={s.superseded}>Superseded by restatement</span> : <span className={s.currentSource}>Current filing sequence</span>}</div><p>Filed {date(filing.filingDate)} · Report period {date(filing.reportDate || data.selectedPeriod)}</p><code>{filing.accession}</code><div className={s.sourceLinks}><SecLink href={filing.indexUrl}>SEC filing index</SecLink><SecLink href={filing.primaryUrl}>Cover report</SecLink>{(filing.tableUrls || []).map((url: string, index: number) => <SecLink key={url} href={url}>Information table{filing.tableUrls.length > 1 ? ` ${index + 1}` : ""}</SecLink>)}</div></div></article>)}</div>{!filings.length ? <p className={s.empty}>No filing documents were assembled for this snapshot. Open the manager’s SEC filings for the available source history.</p> : null}{data.portfolio?.otherManagers?.length ? <div className={s.referencedManagers}><h4>Managers referenced in this report</h4><p className={s.caption}>A reference can indicate shared investment discretion or holdings reported elsewhere. Check the cover report for the relationship.</p><div className={s.noticeManagers}>{data.portfolio.otherManagers.map((manager: any, index: number) => filerCik(manager.cik) ? <button type="button" key={manager.cik + ":" + index} onClick={() => onChoose(filerCik(manager.cik)!)}>{manager.name || `CIK ${manager.cik}`}<ArrowRight size={14} /></button> : <span key={index}>{manager.name || "Reporting manager not named"}{manager.fileNumber ? ` · Form 13F file ${manager.fileNumber}` : ""}</span>)}</div></div> : null}<div className={s.evidenceFacts}><div><span>Public table coverage</span><strong>{data.portfolio?.complete ? "Reconciled" : "Incomplete"}</strong></div><div><span>Amendments considered</span><strong>{number(data.portfolio?.amendmentCount)}</strong></div><div><span>Confidential omissions disclosed</span><strong>{data.portfolio?.confidentialOmitted ? "Yes" : "None flagged in cover report"}</strong></div><div><span>Retrieved</span><strong>{date(data.observedAt)}</strong></div></div><div className={s.methodology}><h4>What this workspace does with the source</h4><p>Reported monetary values are normalized to U.S. dollars using the form’s applicable units. Matching positions are grouped by security identity while retaining share classes, option types, and share or principal units. Percentages use only the reconciled public information table.</p><p>Form 13F is manager-level reporting, which may combine accounts or funds. It is not an individual fund’s net asset value, a complete portfolio, or a record of transactions.</p><SecLink href="https://www.sec.gov/divisions/investment/13ffaq">SEC Form 13F guidance</SecLink></div></section>;
}
export default function ThirteenFWorkspace({ settings, onPatch }: { settings: any; onPatch: (patch: any) => void }) {
  const cik = filerCik(settings.managerCik) || "";
  const period = settings.managerPeriod || "";
  const view = ["overview", "holdings", "changes", "history", "filings"].includes(settings.managerView) ? settings.managerView : "overview";
  const [attempt, setAttempt] = useState(0);
  const [priorAttempt, setPriorAttempt] = useState(0);
  const [panel, setPanel] = useState<{ anchor: Response; data: Response; holding: Holding } | null>(null);
  const [historyHolding, setHistoryHolding] = useState<{ cik: string; period: string; key: string } | null>(null);
  const current = useReport(cik, period, !!cik, attempt);
  const data = current.data;
  const previousPeriod = data?.selectedPeriod ? priorQuarter(data.selectedPeriod) : "";
  const before = useReport(cik, previousPeriod, view === "changes" && current.status === "ready" && !!previousPeriod && data?.portfolio?.comparable === true, priorAttempt);
  function openHolding(holding: any) {
    const source = data?.portfolio?.holdings?.some((row: Holding) => row.key === holding.key) ? data : before.data?.portfolio?.holdings?.some((row: Holding) => row.key === holding.key) ? before.data : null;
    const actual = source?.portfolio?.holdings?.find((row: Holding) => row.key === holding.key);
    if (source && actual && data) setPanel({ anchor: data, data: source, holding: actual });
  }
  function viewHoldingHistory(key: string) {
    if (panel && panel.anchor !== data) { setPanel(null); return; }
    const source = panel?.data || data;
    if (!source?.selectedPeriod) return;
    setHistoryHolding({ cik, period: source.selectedPeriod, key });
    setPanel(null);
    onPatch({ managerView: "history", managerPeriod: source.selectedPeriod });
  }
  function chooseManager(managerCik: string) { setPanel(null); onPatch({ managerCik, managerPeriod: "", managerView: "overview" }); }
  function chooseView(managerView: string) { setPanel(null); onPatch({ managerView }); }
  if (!cik) return <div className={s.workspace}><Landing onChoose={chooseManager} /></div>;
  const portfolio = data?.portfolio;
  const report = data?.reports.find(item => item.period === data.selectedPeriod);
  const lag = report?.latestFiled && data?.selectedPeriod ? Math.round((Date.parse(`${report.latestFiled.slice(0, 10)}T00:00:00Z`) - Date.parse(`${data.selectedPeriod}T00:00:00Z`)) / 86400000) : null;
  const hasHoldings = !!portfolio?.holdings?.length;
  const issues = [...new Set<string>([...(portfolio?.issues || []), ...(data?.coverage?.note ? [data.coverage.note] : [])])];
  return <HoldingActionContext.Provider value={openHolding}><div className={s.workspace}>
    <div className={s.managerTop}><button type="button" onClick={() => onPatch({ managerCik: "", managerPeriod: "", managerView: "overview" })}><ChevronLeft size={15} />Explore managers</button><Link href={`/filings/${cik}`}>All SEC filings<ArrowUpRight size={14} /></Link></div>
    <header className={s.managerHeader}><div><span className={s.eyebrow}><Building2 size={15} />Institutional holdings · Form 13F</span><h1>{data?.manager.name || `SEC manager ${cik}`}</h1><div className={s.managerMeta}><span>CIK {cik}</span>{data?.selectedPeriod ? <><span>Snapshot {date(data.selectedPeriod)}</span><span>Latest filing {date(report?.latestFiled)}</span></> : null}</div></div><ManagerSearch compact onChoose={chooseManager} /></header>
    {current.status === "loading" ? <section className={s.loading} role="status"><RefreshCw className={s.spin} size={26} /><h3>Opening the manager’s SEC reports</h3><p>Checking report history, reading the information tables, and reconciling amendments.</p><div className={s.skeleton}><i /><i /><i /></div><small>Larger managers and historical reports can take longer to load.</small></section> : null}
    {current.status === "error" ? <section className={s.emptyPanel} role="alert"><h3>The 13F report could not be opened</h3><p>{current.error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} />Retry SEC report</button><Link href={`/filings/${cik}`}>Browse this filer’s SEC documents<ArrowUpRight size={14} /></Link></section> : null}
    {data?.status === "unavailable" ? <section className={s.emptyPanel}><FileText size={28} /><h3>No 13F report was found in the loaded history</h3><p>This SEC entity may be a related fund or a different reporting entity. Search for the investment manager’s legal name or open the filer’s documents to investigate.</p>{data.coverage?.note ? <p className={s.caption}>{data.coverage.note}</p> : null}<Link href={`/filings/${cik}`}>Inspect SEC filings<ArrowUpRight size={14} /></Link></section> : null}
    {data?.status === "ready" ? <>
      <div className={s.reportControls}><label>Reporting quarter<select value={data.selectedPeriod || ""} onChange={event => onPatch({ managerPeriod: event.target.value })}>{data.reports.map(item => <option key={item.period} value={item.period}>{quarter(item.period)} · {date(item.period)}{item.filingCount > 1 ? ` · ${item.filingCount} filings` : ""}</option>)}</select></label><div className={s.reportStatus}><span className={portfolio?.complete ? s.verified : s.partial}>{portfolio?.complete ? <Check size={14} /> : <Clock3 size={14} />}{portfolio?.complete ? "Public table reconciled" : "Coverage needs review"}</span><button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} />Refresh</button></div></div>
      {view !== "history" && (hasHoldings || portfolio?.complete) ? <div className={s.metrics}><article className={s.featuredMetric}><span>Reported value</span><strong title={finite(portfolio.totalValueUsd) ? exactMoney.format(portfolio.totalValueUsd) : undefined}>{money(portfolio.totalValueUsd)}</strong><small>{portfolio.complete ? "Total disclosed information-table value" : "Total withheld until coverage is verified"}</small></article><article><span>Disclosed positions</span><strong>{number(portfolio.positionCount)}</strong><small>{number(portfolio.entryCount)} source table rows</small></article><article><span>Largest position</span><strong>{percent(data.summary?.largestPosition?.weightPct)}</strong><small>{data.summary?.largestPosition?.issuer || "Share unavailable"}</small></article><article><span>Reporting lag</span><strong>{finite(lag) && lag >= 0 ? <>{number(lag)}<em> days</em></> : "—"}</strong><small>Quarter end to latest filing</small></article></div> : null}
      {!portfolio?.complete || portfolio?.confidentialOmitted || !data.coverage?.selectedPeriodComplete ? <div className={s.coverageNotice} role="status"><ShieldCheck size={17} /><p><strong>{portfolio?.confidentialOmitted ? "Some holdings were omitted under confidential treatment." : "This snapshot has a coverage limitation."}</strong> {portfolio?.complete ? "The public table can be inspected; quarter comparisons may be unavailable." : "Captured rows remain visible. Totals, concentration, and comparisons are shown only when supported by complete evidence."}</p><button type="button" onClick={() => chooseView("filings")}>Review evidence<ArrowRight size={14} /></button></div> : null}
      {issues.length ? <details className={s.evidenceNotes}><summary>{issues.length === 1 ? "Report coverage note" : `${issues.length} report coverage notes`}<ChevronDown size={15} /></summary><ul>{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details> : null}
      <nav className={s.tabs} aria-label="13F research views">{[{ key: "overview", label: "Overview", icon: Layers3 }, { key: "holdings", label: "Holdings", icon: Building2 }, { key: "changes", label: "Quarterly changes", icon: RefreshCw }, { key: "history", label: "Portfolio history", icon: ChartNoAxesCombined }, { key: "filings", label: "Filings & evidence", icon: FileText }].map(tab => <button key={tab.key} type="button" aria-current={view === tab.key ? "page" : undefined} onClick={() => chooseView(tab.key)}><tab.icon size={16} />{tab.label}{tab.key === "holdings" && hasHoldings ? <span>{number(portfolio.positionCount)}</span> : null}</button>)}</nav>
      {view === "filings" ? <Filings data={data} onChoose={chooseManager} /> : view === "history" ? <ThirteenFHistory key={`${cik}:${data.selectedPeriod}`} data={data} onOpenHolding={openHolding} onSelectPeriod={(managerPeriod: string) => onPatch({ managerPeriod })} initialHoldingKey={historyHolding?.cik === cik && historyHolding.period === data.selectedPeriod ? historyHolding.key : undefined} /> : !hasHoldings && view !== "changes" ? <section className={s.emptyPanel}><FileText size={28} /><h3>{portfolio?.complete ? "No reportable holdings were disclosed for this quarter" : String(portfolio?.reportType || "").toUpperCase().includes("NOTICE") ? "This filing is a notice, not a holdings table" : "No verified holdings table is available for this period"}</h3><p>{portfolio?.complete ? "The complete public information table reports zero entries. This does not establish that the manager holds no other assets." : String(portfolio?.reportType || "").toUpperCase().includes("NOTICE") ? "A Form 13F notice can indicate that another manager reports the holdings. Inspect the cover report and included manager references to find the reporting entity." : "The source chain does not currently provide a complete usable holdings table. Review the report coverage notes and SEC documents for the available evidence."}</p>{portfolio?.otherManagers?.length ? <div className={s.noticeManagers}>{portfolio.otherManagers.map((manager: any, index: number) => filerCik(manager.cik) ? <button type="button" key={manager.cik + ":" + index} onClick={() => chooseManager(filerCik(manager.cik)!)}>{manager.name || `CIK ${manager.cik}`}<ArrowRight size={14} /></button> : <span key={index}>{manager.name || "Reporting manager not named"}{manager.fileNumber ? ` · Form 13F file ${manager.fileNumber}` : ""}</span>)}</div> : null}<button type="button" onClick={() => chooseView("filings")}>Inspect filing evidence<ArrowRight size={15} /></button></section> : view === "holdings" ? <Holdings key={`${cik}:${data.selectedPeriod}`} data={data} /> : view === "changes" ? <Changes key={`${cik}:${data.selectedPeriod}`} data={data} before={before} onRetry={() => setPriorAttempt(value => value + 1)} /> : <Overview data={data} onView={chooseView} />}
      <footer className={s.workspaceFooter}><span><ShieldCheck size={14} />SEC source evidence · Retrieved {date(data.observedAt)}</span><p>13F reports are delayed public disclosures. They exclude many assets and short positions; they do not measure current holdings or investment returns.</p></footer>
    </> : null}
    {panel && current.status === "ready" && panel.anchor === data ? <ThirteenFCompanyPanel key={`${panel.data.manager.cik}:${panel.data.selectedPeriod}:${panel.holding.key}`} holding={panel.holding} data={panel.data} onClose={() => setPanel(null)} onViewHistory={viewHoldingHistory} /> : null}
  </div></HoldingActionContext.Provider>;
}
