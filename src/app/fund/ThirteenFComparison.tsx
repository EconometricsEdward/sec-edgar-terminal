"use client";

import { useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Layers3, Plus, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { useSecFilerSearch } from "../../utils/useSecFilerSearch.js";
import { exactFilerMatch, filerCik } from "../../utils/secFilerSearch.js";
import s from "./ThirteenFComparison.module.css";

const MarketConnections = dynamic(() => import("./ThirteenFComparisonMarkets"), { loading: () => <p role="status">Opening shared market research…</p> });
const POPULAR = [{ cik: "0001350694", name: "Bridgewater" }, { cik: "0001067983", name: "Berkshire Hathaway" }, { cik: "0001037389", name: "Renaissance" }, { cik: "0001747057", name: "D1 Capital" }];
const COLORS = ["#65d9c5", "#92b6f7", "#c5adef", "#f6c865"];
const CACHE = new Map<string, { data: Comparison; until: number }>();
const MAX_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 12;
const QUARTER = /^\d{4}-(03-31|06-30|09-30|12-31)$/;
type Props = { managerCiks: string[]; period: string; onChange: (patch: { managerCiks?: string[]; period?: string }) => void; onOpenManager: (cik: string, period: string) => void };
type Manager = { cik: string; name: string; period: string; status: string; complete: boolean; percentagesAvailable: boolean; totalValueUsd: number | null; positionCount: number | null; observedPositionCount: number | null; top10Pct: number | null; largestWeightPct: number | null; observedAt: string | null; filings: any[]; reason: string | null; scopeNote: string | null };
type Cell = { cik: string; status: "reported" | "not-reported" | "unknown"; issuer: string | null; classTitle: string | null; valueUsd: number | null; sharePct: number | null; quantity: number | null };
type Holding = { key: string; cusip: string; issuer: string; classTitle: string; putCall: string | null; quantityType: string; cells: Cell[]; managerCount: number; anchorCik?: string; anchorHolding?: any };
type Pair = { key: string; leftCik: string; rightCik: string; complete: boolean; sharedCount: number | null; observedSharedCount: number | null; overlapPct: number | null; leftCommonSharePct: number | null; rightCommonSharePct: number | null; reason: string | null; sharedHoldings?: Holding[]; sharedHoldingsTruncated?: boolean };
type Finding = { id: string; kind: string; title: string; text: string; pairKey?: string; holdingKey?: string; metric: { name: string; value: number; unit: string } };
type Comparison = { schemaVersion: string; selectedPeriod: string; period: string; availablePeriods: string[]; managers: Manager[]; pairs: Pair[]; sharedHoldings: Holding[]; totalSharedHoldings: number; sharedHoldingsTruncated: boolean; findings: Finding[]; notes: string[]; coverage: { completeManagers: number; requestedManagers: number; allComplete: boolean }; snapshot: { latestObservedAt: string | null; earliestObservedAt: string | null; basis: string }; cache?: { status: string; stale: boolean; checkedAt: string; freshUntil: string | null; message?: string }; selection?: { automatic: boolean; aligned: boolean; commonQuarter: boolean; alignmentScope: string; note: string | null; managerCiks: string[] } };
type Remote = { key: string; loading: boolean; data: Comparison | null; error: string };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const money = (value: unknown) => finite(value) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value) : "—";
const count = (value: unknown) => finite(value) ? value.toLocaleString("en-US") : "—";
const percent = (value: unknown) => finite(value) ? value > 0 && value < .01 ? "<0.01%" : `${value.toFixed(value > 0 && value < 1 ? 2 : 1)}%` : "—";
const quarter = (value: string) => QUARTER.test(value) ? `Q${Math.ceil(Number(value.slice(5, 7)) / 3)} ${value.slice(0, 4)}` : "Reporting quarter";
function date(value: string | null | undefined, time = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unavailable";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", ...(time ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" as const } : {}), timeZone: "UTC" });
}
function name(cik: string, manager?: Manager) {
  return POPULAR.find(item => item.cik === cik)?.name || manager?.name || `CIK ${cik}`;
}
function secUrl(value: unknown) {
  try { const url = new URL(typeof value === "string" ? value : ""); return url.protocol === "https:" && ["www.sec.gov", "sec.gov", "data.sec.gov"].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : null; } catch { return null; }
}
function validResponse(data: any, ciks: string[], period: string): data is Comparison {
  return data?.schemaVersion === "edgar.13f-comparison.v1" && QUARTER.test(data.selectedPeriod) && data.period === data.selectedPeriod && (!period || data.selectedPeriod === period)
    && Array.isArray(data.managers) && data.managers.length === ciks.length && new Set(data.managers.map((item: any) => item?.cik)).size === ciks.length
    && data.managers.every((item: any) => ciks.includes(item?.cik) && item.period === data.selectedPeriod && typeof item.name === "string" && Array.isArray(item.filings))
    && Array.isArray(data.pairs) && data.pairs.length <= 6 && data.pairs.every((pair: any) => ciks.includes(pair?.leftCik) && ciks.includes(pair?.rightCik) && pair.leftCik !== pair.rightCik && (!pair.sharedHoldings || (Array.isArray(pair.sharedHoldings) && pair.sharedHoldings.length <= 200)))
    && Array.isArray(data.sharedHoldings) && data.sharedHoldings.length <= 200 && Array.isArray(data.findings) && data.findings.length <= 20
    && Array.isArray(data.notes) && Array.isArray(data.availablePeriods) && data.availablePeriods.length <= 100 && data.availablePeriods.every((item: any) => QUARTER.test(item))
    && !!data.coverage && !!data.snapshot;
}
async function fetchComparison(ciks: string[], period: string, signal: AbortSignal, force: boolean) {
  const key = `${ciks.join(",")}:${period}`;
  if (force) CACHE.delete(key);
  const saved = CACHE.get(key);
  if (!force && saved && saved.until > Date.now()) return saved.data;
  const query = new URLSearchParams({ ciks: ciks.join(",") });
  if (period) query.set("period", period);
  if (force) query.set("refresh", "1");
  const response = await fetch(`/api/fund-13f/compare?${query}`, { signal, ...(force ? { cache: "no-store" as const } : {}) });
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("This comparison is too large to open. Try two managers.");
  const reader = response.body?.getReader();
  let raw = "", bytes = 0;
  if (reader) {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error("This comparison is too large to open. Try two managers."); }
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
  } else { raw = await response.text(); bytes = new TextEncoder().encode(raw).length; }
  signal.throwIfAborted();
  if (bytes > MAX_BYTES) throw new Error("This comparison is too large to open. Try two managers.");
  let data: any;
  try { data = JSON.parse(raw); } catch { throw new Error("The comparison could not be opened. Please retry."); }
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "SEC comparison data is temporarily unavailable. Please retry.");
  if (!validResponse(data, ciks, period)) throw new Error("The comparison could not be verified against the selected managers and quarter. Please retry.");
  if (data.coverage.allComplete && !data.cache?.stale) {
    CACHE.delete(key);
    while (CACHE.size >= 4) CACHE.delete(CACHE.keys().next().value!);
    const freshness = Date.parse(data.cache?.freshUntil ?? "");
    CACHE.set(key, { data, until: Math.min(Date.now() + 300000, Number.isFinite(freshness) ? freshness : Date.now() + 60000) });
  }
  return data;
}

function ManagerPicker({ selected: initialSelected, managers, onChange, onClose }: { selected: string[]; managers: Manager[]; onChange: (ciks: string[]) => void; onClose: () => void }) {
  const [selected, setSelected] = useState(initialSelected);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const inputId = useId();
  const cik = filerCik(query.replace(/^CIK\s*/i, ""));
  const search = useSecFilerSearch(query, query.trim().length >= 2 && !cik);
  function add(value: string) {
    if (selected.includes(value)) { setMessage("This manager is already in the comparison."); return; }
    if (selected.length >= 4) { setMessage("Remove a manager first to compare up to four."); return; }
    setQuery(""); setMessage(""); setSelected([...selected, value]);
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (cik) { add(cik); return; }
    const exact = exactFilerMatch(query, search.results, { truncated: search.truncated, warning: search.warning });
    if (exact) { add(exact.cik); return; }
    setMessage(query.trim().length < 2 ? "Enter a manager’s name or SEC CIK." : "Choose the reporting manager from the SEC results below.");
  }
  return <section className={s.picker} aria-label="Choose comparison managers">
    <div className={s.sectionHeading}><div><h2>Choose your managers</h2><p>Compare two to four institutional managers.</p></div><button type="button" onClick={onClose} aria-label="Close manager selection"><X size={17} /></button></div>
    <div className={s.selectedManagers}>{selected.map(value => <span key={value}><span>{name(value, managers.find(item => item.cik === value))}</span><button type="button" disabled={selected.length <= 2} onClick={() => setSelected(selected.filter(item => item !== value))} aria-label={`Remove ${name(value, managers.find(item => item.cik === value))}`} title={selected.length <= 2 ? "Keep at least two managers" : "Remove manager"}><X size={13} /></button></span>)}</div>
    <form onSubmit={submit} role="search" aria-label="Find a manager to compare"><label htmlFor={inputId}>Add an institutional manager</label><div className={s.searchField}><Search size={16} aria-hidden="true" /><input id={inputId} type="search" placeholder="Manager name or CIK" value={query} maxLength={160} autoComplete="off" onChange={event => { setQuery(event.target.value); setMessage(""); }} /><button type="submit" disabled={selected.length >= 4}><Plus size={15} />Add</button></div></form>
    {message ? <p role="status">{message}</p> : null}
    {selected.length >= 4 ? <p>All four places are filled. Remove a manager to add another.</p> : null}
    {query.trim().length >= 2 && !cik ? <div className={s.searchResults}>
      {search.status === "loading" ? <p role="status">Searching SEC filer records…</p> : null}
      {search.status === "error" ? <p role="alert">{search.error} <button type="button" onClick={search.retry}>Retry</button></p> : null}
      {search.results.map((result: any) => <button type="button" key={result.cik} disabled={selected.includes(result.cik) || selected.length >= 4} onClick={() => add(result.cik)}><span><strong>{result.name}</strong><small>CIK {result.cik} · {result.formTypes?.some((form: string) => form.startsWith("13F")) ? "13F filer" : "SEC filer"}</small></span>{selected.includes(result.cik) ? <Check size={15} /> : <Plus size={15} />}</button>)}
      {search.status === "ready" && !search.results.length ? <p>No SEC entity matched. Try its full legal name or CIK.</p> : null}
      {search.warning ? <p>{search.warning}</p> : null}
      {search.truncated ? <p>Results are limited. Refine the name or use the manager’s CIK.</p> : null}
    </div> : null}
    <div className={s.presets}><span>Popular managers</span>{POPULAR.filter(item => !selected.includes(item.cik)).map(item => <button type="button" key={item.cik} disabled={selected.length >= 4} onClick={() => add(item.cik)}>{item.name}<Plus size={12} /></button>)}<button type="button" onClick={() => { setSelected(POPULAR.map(item => item.cik)); setQuery(""); setMessage(""); }}>Reset to popular managers</button></div>
    <div className={s.pickerActions}><span>{selected.length} managers selected</span><button type="button" onClick={onClose}>Cancel</button><button type="button" className={s.apply} disabled={selected.join(",") === initialSelected.join(",")} onClick={() => { onChange(selected); onClose(); }}>Apply comparison<ArrowRight size={14} /></button></div>
  </section>;
}

function ManagerCards({ managers, loading, onOpen }: { managers: Manager[]; loading: boolean; onOpen: (cik: string, period: string) => void }) {
  return <div className={s.managerGrid} style={{ "--manager-count": managers.length } as React.CSSProperties}>{managers.map((manager, index) => <article key={manager.cik} className={s.managerCard} style={{ "--manager-color": COLORS[index] } as React.CSSProperties}>
    <div className={s.managerName}><span className={s.colorDot} /><button type="button" onClick={() => onOpen(manager.cik, manager.period)} title={manager.name}>{name(manager.cik, manager)}<ArrowUpRight size={13} /></button></div>
    <strong className={s.managerValue}>{money(manager.totalValueUsd)}</strong><span className={s.metricCaption}>disclosed value</span>
    <div className={s.cardDetail}><span>Reported positions</span><strong>{count(manager.positionCount)}</strong></div>
    <div className={s.cardDetail}><span>Top ten share</span><strong>{percent(manager.top10Pct)}</strong></div><div className={s.track} aria-hidden="true"><span style={{ width: `${finite(manager.top10Pct) ? Math.min(100, manager.top10Pct) : 0}%` }} /></div>
    <div className={`${s.cardStatus} ${manager.complete ? s.complete : s.partial}`}>{manager.complete ? <Check size={12} /> : <Clock3 size={12} />}{manager.complete ? "Complete public table" : loading ? "Loading this quarter" : manager.status === "unavailable" ? "Report unavailable" : "Partial table"}</div>
    {manager.reason ? <p className={s.cardReason}>{manager.reason}</p> : null}
  </article>)}</div>;
}

function Overlap({ data, selectedKey, onSelect }: { data: Comparison; selectedKey: string; onSelect: (key: string) => void }) {
  const pairs = data.pairs;
  const selected = pairs.find(pair => pair.key === selectedKey) || pairs.filter(pair => finite(pair.overlapPct)).sort((left, right) => (right.overlapPct ?? 0) - (left.overlapPct ?? 0))[0] || pairs[0];
  const byCik = new Map(data.managers.map(manager => [manager.cik, manager]));
  const pairName = (cik: string) => name(cik, byCik.get(cik));
  const maxOverlap = Math.max(1, ...pairs.map(pair => pair.overlapPct ?? 0));
  return <section className={s.overlapPanel} aria-labelledby="comparison-overlap-heading"><div className={s.sectionHeading}><div><span className={s.eyebrow}>Common ground</span><h2 id="comparison-overlap-heading">How much do their holdings overlap?</h2><p>The same security, compared at each manager’s disclosed-value share.</p></div></div>
    <div className={s.overlapLayout}><div className={s.matrixWrap}><table className={s.matrix}><caption className={s.srOnly}>Weighted overlap by manager pair. Select a percentage to inspect shared holdings.</caption><thead><tr><th scope="col"><span className={s.srOnly}>Manager</span></th>{data.managers.map((manager, index) => <th key={manager.cik} scope="col"><span className={s.columnDot} style={{ background: COLORS[index] }} />{name(manager.cik, manager)}</th>)}</tr></thead><tbody>{data.managers.map((left, index) => <tr key={left.cik}><th scope="row"><span className={s.columnDot} style={{ background: COLORS[index] }} />{name(left.cik, left)}</th>{data.managers.map(right => {
      const pair = pairs.find(item => (item.leftCik === left.cik && item.rightCik === right.cik) || (item.rightCik === left.cik && item.leftCik === right.cik));
      if (left.cik === right.cik) return <td key={right.cik} className={s.diagonal}><span aria-label="Same manager">—</span></td>;
      return <td key={right.cik}><button type="button" onClick={() => pair && onSelect(pair.key)} aria-pressed={pair?.key === selected?.key} aria-label={`${pairName(left.cik)} and ${pairName(right.cik)}: ${finite(pair?.overlapPct) ? `${percent(pair?.overlapPct)} weighted overlap` : "comparison unavailable"}`} style={{ "--cell-strength": finite(pair?.overlapPct) ? `${7 + (pair!.overlapPct! / maxOverlap) * 21}%` : "0%" } as React.CSSProperties}><strong>{percent(pair?.overlapPct)}</strong><span>{finite(pair?.sharedCount) ? `${count(pair?.sharedCount)} shared` : "Incomplete"}</span></button></td>;
    })}</tr>)}</tbody></table><div className={s.matrixLegend}><span>Lower overlap</span><i aria-hidden="true" /><span>Higher overlap within this group</span></div></div>
      {selected ? <div className={s.pairDetail}><span className={s.eyebrow}>Selected pair</span><h3>{pairName(selected.leftCik)} <span>&</span> {pairName(selected.rightCik)}</h3><div className={s.pairStats}><div><strong>{percent(selected.overlapPct)}</strong><span>weighted overlap</span></div><div><strong>{count(selected.sharedCount ?? selected.observedSharedCount)}</strong><span>{selected.complete ? "shared positions" : "observed matches"}</span></div></div><p>Share of each manager’s disclosed value in their common holdings</p><div className={s.commonBars}>{[{ cik: selected.leftCik, value: selected.leftCommonSharePct }, { cik: selected.rightCik, value: selected.rightCommonSharePct }].map(item => <div key={item.cik} style={{ "--manager-color": COLORS[data.managers.findIndex(manager => manager.cik === item.cik)] } as React.CSSProperties}><div><span>{pairName(item.cik)}</span><strong>{percent(item.value)}</strong></div><div className={s.track}><span style={{ width: `${finite(item.value) ? Math.min(100, item.value) : 0}%` }} /></div></div>)}</div>{selected.reason ? <p className={s.partial}>{selected.reason}</p> : null}<a href="#comparison-shared-holdings" onClick={() => onSelect(selected.key)}>Inspect shared holdings<ArrowRight size={14} /></a></div> : null}
    </div><details className={s.explainer}><summary><CircleHelp size={14} />How to read this<ChevronDown size={14} /></summary><p>Weighted overlap adds the smaller disclosed-value percentage for every matching position. For example, a security reported at 8% by one manager and 3% by another contributes 3 percentage points. Zero means no matching value in complete public tables. A dash means the data cannot support the calculation.</p><p>All weights use the full reported table. Share classes, puts, calls, and principal units remain separate. The result describes disclosed composition; it does not measure economic exposure, correlations, or future returns.</p></details>
  </section>;
}

function SharedHoldings({ data, pairKey, onPair }: { data: Comparison; pairKey: string; onPair: (key: string) => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const pair = data.pairs.find(item => item.key === pairKey);
  const visibleManagers = pair ? data.managers.filter(item => [pair.leftCik, pair.rightCik].includes(item.cik)) : data.managers;
  const source = pair ? pair.sharedHoldings ?? data.sharedHoldings.filter(holding => [pair.leftCik, pair.rightCik].every(cik => holding.cells.some(cell => cell.cik === cik && cell.status === "reported"))) : data.sharedHoldings;
  const filtered = source.filter(holding => `${holding.issuer} ${holding.classTitle} ${holding.cusip} ${holding.putCall || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(0, pageCount - 1));
  const rows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const total = pair ? pair.sharedCount ?? pair.observedSharedCount : data.totalSharedHoldings;
  const truncated = pair ? pair.sharedHoldingsTruncated || source.length < (total ?? 0) : data.sharedHoldingsTruncated;
  return <section className={s.holdingsPanel} id="comparison-shared-holdings" aria-labelledby="shared-holdings-heading"><div className={s.sectionHeading}><div><span className={s.eyebrow}>Security by security</span><h2 id="shared-holdings-heading">Shared holdings</h2><p>{pair ? `${name(pair.leftCik, data.managers.find(item => item.cik === pair.leftCik))} + ${name(pair.rightCik, data.managers.find(item => item.cik === pair.rightCik))}` : "Positions reported by at least two selected managers"}</p></div>{pair ? <button type="button" onClick={() => { onPair(""); setPage(0); }}>View all managers<X size={13} /></button> : <span className={s.resultCount}>{count(total)} shared positions</span>}</div>
    <div className={s.tableTools}><label className={s.tableSearch}><Search size={15} /><span className={s.srOnly}>Search displayed shared holdings</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Find a company or CUSIP" maxLength={160} /></label><span>Values below show each manager’s share of disclosed value.</span></div>
    <div className={s.tableScroll}><table className={s.holdingsTable}><thead><tr><th scope="col">Reported security</th>{visibleManagers.map(manager => <th key={manager.cik} scope="col"><span className={s.columnDot} style={{ background: COLORS[data.managers.indexOf(manager)] }} />{name(manager.cik, manager)}</th>)}</tr></thead><tbody>{rows.map(holding => <tr key={holding.key}><th scope="row"><strong>{holding.issuer || holding.cusip}</strong><span>{holding.classTitle || "Class not supplied"}{holding.putCall ? <b>{holding.putCall}</b> : null}</span><small>{holding.cusip} · {holding.quantityType === "PRN" ? "Principal units" : "Share units"}</small></th>{visibleManagers.map(manager => {
      const cell = holding.cells.find(item => item.cik === manager.cik);
      return <td key={manager.cik}>{cell?.status === "reported" ? <div className={s.holdingCell} style={{ "--manager-color": COLORS[data.managers.indexOf(manager)] } as React.CSSProperties}><div><strong>{percent(cell.sharePct)}</strong><span>{money(cell.valueUsd)}</span></div><div className={s.track} aria-hidden="true"><span style={{ width: `${finite(cell.sharePct) ? Math.min(100, cell.sharePct) : 0}%` }} /></div>{!finite(cell.sharePct) ? <small>Share unavailable</small> : null}</div> : <span className={s.absent}>{cell?.status === "not-reported" ? "Not reported" : "Unknown"}</span>}</td>;
    })}</tr>)}</tbody></table></div>
    {!rows.length ? <p className={s.empty}>{query ? "No match in the displayed shared holdings. Try a company name or CUSIP." : total === 0 ? "No identical reported securities were found in these public tables." : "Shared holdings are unavailable until at least two reports can be read."}</p> : null}
    <div className={s.tableFooter}><span>{filtered.length ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length} displayed` : "No displayed matches"}{truncated ? ` · Selected from ${count(total)} shared positions` : ""}</span>{pageCount > 1 ? <div><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="Previous shared holdings page"><ChevronLeft size={16} /></button><span>{currentPage + 1} / {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} aria-label="Next shared holdings page"><ChevronRight size={16} /></button></div> : null}</div><p className={s.tableNote}>{pair ? "Leading shared positions are ranked by their contribution to this pair’s weighted overlap." : "Leading shared positions are ranked by the number of managers reporting them, then their disclosed-value shares."} Each percentage uses the manager’s entire reconciled public table. Holdings inside ETFs and other funds are not expanded.</p>
  </section>;
}

export default function ThirteenFComparison({ managerCiks, period, onChange, onOpenManager }: Props) {
  const ciks = managerCiks.length >= 2 && managerCiks.length <= 4 ? managerCiks : POPULAR.map(item => item.cik);
  const key = `${ciks.join(",")}:${period}`;
  const cikKey = ciks.join(",");
  const [remote, setRemote] = useState<Remote>({ key: "", loading: true, data: null, error: "" });
  const [refresh, setRefresh] = useState({ key: "", nonce: 0 });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pairSelection, setPairSelection] = useState({ key: "", pair: "" });
  const consumedRefresh = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const deadline = setTimeout(() => controller.abort(), 90000);
    setRemote(previous => ({ key, loading: true, data: previous.key === key ? previous.data : null, error: "" }));
    const force = refresh.key === key && refresh.nonce > consumedRefresh.current;
    if (force) consumedRefresh.current = refresh.nonce;
    fetchComparison(cikKey.split(","), period, controller.signal, force).then(data => {
      if (!disposed) setRemote({ key, loading: false, data, error: "" });
    }).catch(error => {
      if (!disposed) setRemote(previous => ({ key, loading: false, data: previous.key === key ? previous.data : null, error: controller.signal.aborted ? "The SEC comparison took too long. Retry to continue; completed reports can be reused." : error.message }));
    }).finally(() => clearTimeout(deadline));
    return () => { disposed = true; clearTimeout(deadline); controller.abort(); };
  }, [key, cikKey, period, refresh.key, refresh.nonce]);
  const active = remote.key === key ? remote : { key, loading: true, data: null, error: "" };
  const data = active.data;
  const selectedPeriod = data?.selectedPeriod || period;
  const pairKey = pairSelection.key === key ? pairSelection.pair : "";
  const setPair = (pair: string) => setPairSelection({ key, pair });
  function retry() { setRefresh(previous => ({ key, nonce: previous.nonce + 1 })); }
  return <div className={s.comparison}>
    <header className={s.header}><div><span className={s.eyebrow}><Layers3 size={14} /> Manager comparison · SEC Form 13F</span><h1>Find the common ground.</h1><p>See where institutional managers share holdings—and how differently they size them.</p></div><button type="button" onClick={() => setPickerOpen(value => !value)} aria-expanded={pickerOpen}><SlidersHorizontal size={15} />Change managers</button></header>
    {pickerOpen ? <ManagerPicker selected={ciks} managers={data?.managers || []} onChange={managerCiks => { onChange({ managerCiks }); setPair(""); }} onClose={() => setPickerOpen(false)} /> : null}
    <div className={s.controls}><label>Reporting quarter<select value={period} onChange={event => onChange({ period: event.target.value })}><option value="">Automatic quarter{data && !period ? ` · ${quarter(data.selectedPeriod)}` : ""}</option>{[...new Set([...(period ? [period] : []), ...(data?.availablePeriods || [])])].sort().reverse().map(value => <option key={value} value={value}>{quarter(value)} · {date(value)}</option>)}</select></label><div className={s.reportStatus}>{selectedPeriod ? <span className={s.quarterBadge}>{quarter(selectedPeriod)}<span>{date(selectedPeriod)}</span></span> : null}<span>{data ? `${data.coverage.completeManagers} of ${data.coverage.requestedManagers} public tables complete` : `${ciks.length} managers selected`}{data?.cache?.checkedAt ? <small>Checked {date(data.cache.checkedAt, true)}</small> : null}</span><button type="button" onClick={retry} disabled={active.loading}><RefreshCw size={14} className={active.loading ? s.spin : ""} />{active.loading && data ? "Refreshing…" : "Refresh"}</button></div></div>
    {data?.selection?.note ? <p className={s.alignmentNote}>{data.selection.note}</p> : data?.selection?.automatic && data.selection.commonQuarter ? <p className={s.alignmentNote}>Aligned to the latest quarter reported by all selected managers.</p> : null}
    {active.error ? <div className={s.notice} role="alert"><div><strong>{data ? "The displayed comparison could not be refreshed." : "The comparison could not be loaded."}</strong><p>{active.error}</p></div><button type="button" onClick={retry}>Retry</button></div> : null}
    {data?.cache?.stale ? <div className={s.notice} role="status"><Clock3 size={17} /><div><strong>Showing the last available comparison</strong><p>{data.cache.message || "A newer SEC check was unavailable. The original report check times are shown below; later filings may revise these holdings."}</p></div></div> : null}
    {data && !data.coverage.allComplete ? <div className={s.notice} role="status"><Clock3 size={17} /><div><strong>Some reports are unavailable or incomplete for {quarter(data.selectedPeriod)}.</strong><p>Available reports remain visible. Missing data is marked unknown, and percentages are withheld where a complete table cannot be verified.</p></div><button type="button" onClick={retry} disabled={active.loading}>Retry missing reports</button></div> : null}
    {active.loading && !data ? <div className={s.loading} role="status" aria-live="polite"><div><RefreshCw size={23} className={s.spin} /><h2>Aligning the reported portfolios</h2><p>Finding a common quarter and preparing each SEC table. Large reports can take longer on their first load; prepared filings are reused.</p></div><div className={s.loadingManagers}>{ciks.map((cik, index) => <span key={cik}><i style={{ background: COLORS[index] }} />{name(cik)}</span>)}</div><div className={s.skeletonGrid} aria-hidden="true">{ciks.map(cik => <div key={cik}><i /><i /><i /></div>)}</div></div> : null}
    {data ? <>
      <ManagerCards managers={data.managers} loading={active.loading} onOpen={onOpenManager} />
      <Overlap data={data} selectedKey={pairKey} onSelect={setPair} />
      {data.findings.length ? <section className={s.findings} aria-label="What stands out">{data.findings.slice(0, 3).map((finding, index) => <article key={finding.id}><span className={s.findingNumber}>0{index + 1}</span><h3>{finding.title}</h3><p>{finding.text}</p>{finding.pairKey ? <button type="button" onClick={() => setPair(finding.pairKey!)}>Explore this pair<ArrowRight size={13} /></button> : null}</article>)}</section> : null}
      <SharedHoldings data={data} pairKey={pairKey} onPair={setPair} />
      <MarketConnections comparison={data} />
      <details className={s.sources}><summary><span>Sources, freshness & methodology</span><span>{date(data.snapshot.latestObservedAt)}<ChevronDown size={14} /></span></summary><div><p>{data.snapshot.basis}</p><div className={s.sourceGrid}>{data.managers.map(manager => <article key={manager.cik}><h3>{name(manager.cik, manager)}</h3><p>Report captured {date(manager.observedAt, true)}</p><p>CIK {manager.cik} · {quarter(data.selectedPeriod)}</p>{manager.scopeNote ? <p>{manager.scopeNote}</p> : null}{manager.filings.filter(filing => !filing.superseded).map(filing => {
        const url = secUrl(filing.indexUrl || filing.primaryUrl);
        return url ? <a key={filing.accession} href={url} target="_blank" rel="noopener noreferrer">{filing.form || "13F"} · Filed {date(filing.filingDate)}<ArrowUpRight size={12} /></a> : null;
      })}</article>)}</div><ul>{data.notes.map(note => <li key={note}>{note}</li>)}</ul><p>Prepared filings are cached for faster loading. Refresh checks SEC submissions for new filings and amendments; unchanged information tables are reused. A new filing or amendment changes the comparison’s source snapshot.</p><a href="https://www.sec.gov/divisions/investment/13ffaq" target="_blank" rel="noopener noreferrer">SEC Form 13F guidance<ArrowUpRight size={12} /></a></div></details>
    </> : null}
  </div>;
}
