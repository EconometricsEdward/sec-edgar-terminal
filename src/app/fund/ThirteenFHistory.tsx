"use client";

import { useId, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Clock3, Download, FileText, History, RefreshCw, Search } from "lucide-react";
import { get13FHoldingHistory } from "../../utils/thirteenFHistory.js";
import { create13FHistoryCsv, get13FHoldingQuarterComparison, get13FQuarterComparison } from "../../utils/thirteenFHistoryInsights.js";
import { use13FHistory } from "./use13FHistory";
import s from "./ThirteenFHistory.module.css";

type Holding = { key: string; issuer: string; cusip: string; classTitle: string; putCall?: string | null; quantityType: string; valueUsd?: number | null; [key: string]: unknown };
type Point = { period: string; value: number | null };
type Metric = "weightPct" | "quantity" | "valueUsd";
type Props = { data: any; onOpenHolding: (holding: any) => void; onSelectPeriod: (period: string) => void; initialHoldingKey?: string };
const EMPTY_HOLDINGS: Holding[] = [];
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const fullDollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const number = (value: unknown) => isNumber(value) ? integer.format(value) : "—";
const money = (value: unknown) => isNumber(value) ? dollars.format(value) : "—";
const percent = (value: unknown) => !isNumber(value) ? "—" : value > 0 && value < .001 ? "<0.001%" : `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: value > 0 && value < 1 ? 3 : 1 })}%`;
const signedNumber = (value: unknown) => isNumber(value) ? `${value > 0 ? "+" : ""}${number(value)}` : "—";
function quarter(period: string) { return /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(period) ? `Q${Math.ceil(Number(period.slice(5, 7)) / 3)} ${period.slice(0, 4)}` : period; }
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return "Not available";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Not available";
}
function checkedTime(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? `${parsed.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC` : null;
}
function secUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) ? url.href : null; } catch { return null; }
}
function niceMaximum(values: (number | null)[]) {
  const max = Math.max(0, ...values.filter(isNumber));
  if (max <= 0) return 1;
  const scale = 10 ** Math.floor(Math.log10(max));
  const rounded = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(step => step * scale >= max) || 10;
  return rounded * scale;
}
function SparkChart({ points, selectedPeriod, onSelect, onPreview, label, color, mode, tall = false }: { points: Point[]; selectedPeriod: string; onSelect: (period: string) => void; onPreview: (period: string | null) => void; label: string; color: string; mode: "percent" | "count" | "money"; tall?: boolean }) {
  const descriptionId = useId();
  const gradientId = useId();
  const [focused, setFocused] = useState(false);
  const width = tall ? 700 : 420, height = tall ? 260 : 250, left = 58, right = 18, top = 20, bottom = 37;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = mode === "percent" ? Math.min(100, niceMaximum(points.map(point => point.value))) : niceMaximum(points.map(point => point.value));
  const x = (index: number) => left + (points.length <= 1 ? plotWidth / 2 : index / (points.length - 1) * plotWidth);
  const y = (value: number) => top + plotHeight - Math.min(maximum, Math.max(0, value)) / maximum * plotHeight;
  const active = Math.max(0, points.findIndex(point => point.period === selectedPeriod));
  const tickCount = Math.min(3, points.length);
  const tickIndexes = Array.from({ length: tickCount }, (_, index) => Math.round(index * (points.length - 1) / Math.max(1, tickCount - 1)));
  const segments: { index: number; value: number }[][] = [];
  points.forEach((point, index) => {
    if (!isNumber(point.value)) return;
    if (index === 0 || !isNumber(points[index - 1].value)) segments.push([]);
    segments.at(-1)!.push({ index, value: point.value });
  });
  const linePath = (segment: { index: number; value: number }[]) => segment.map((point, index) => `${index ? "L" : "M"}${x(point.index).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  const axisValue = (value: number) => mode === "percent" ? `${value.toLocaleString("en-US", { maximumFractionDigits: Math.min(8, Math.max(0, 1 - Math.floor(Math.log10(maximum)))) })}%` : mode === "money" ? dollars.format(value) : compact.format(value);
  const periodAtPointer = (event: { clientX: number; currentTarget: HTMLDivElement }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const local = (event.clientX - rect.left) / Math.max(1, rect.width) * width;
    const index = Math.min(points.length - 1, Math.max(0, Math.round((local - left) / plotWidth * (points.length - 1))));
    return points[index]?.period;
  };
  return <div className={`${s.chart} ${tall ? s.tallChart : ""}`} tabIndex={0} role="group" aria-label={label} aria-describedby={descriptionId} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); onPreview(null); }}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !points.length) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.min(points.length - 1, Math.max(0, active + (event.key === "ArrowLeft" ? -1 : 1)));
      onSelect(points[index].period);
    }}
    onPointerMove={event => { if (event.pointerType !== "touch") onPreview(periodAtPointer(event) || null); }}
    onPointerLeave={() => onPreview(null)}
    onClick={event => { const period = periodAtPointer(event); if (period) onSelect(period); }}>
    <span id={descriptionId} className={s.srOnly}>Hover to preview a quarter. Click, tap, or use left and right arrow keys to keep it selected. The scale starts at zero and fits the loaded values. Missing observations break the line. Exact values are in the tables below.</span>
    <span className={s.srOnly} aria-live={focused ? "polite" : "off"} aria-atomic="true">{points[active] ? `${quarter(points[active].period)}: ${isNumber(points[active].value) ? mode === "percent" ? percent(points[active].value) : mode === "money" ? fullDollars.format(points[active].value) : number(points[active].value) : "Observation unavailable"}.` : "No observations loaded."}</span>
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".18" /><stop offset="100%" stopColor={color} stopOpacity=".015" /></linearGradient></defs>
      {[0, .5, 1].map(fraction => <g key={fraction}><line className={s.gridLine} x1={left} x2={width - right} y1={y(maximum * fraction)} y2={y(maximum * fraction)} /><text className={s.axisLabel} x={left - 10} y={y(maximum * fraction) + 4} textAnchor="end">{axisValue(maximum * fraction)}</text></g>)}
      {segments.map((segment, index) => <g key={index}>{segment.length > 1 ? <path d={`${linePath(segment)} L${x(segment.at(-1)!.index)},${y(0)} L${x(segment[0].index)},${y(0)} Z`} fill={`url(#${gradientId})`} /> : null}<path d={linePath(segment)} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" /></g>)}
      {points.length ? <line className={s.activeLine} x1={x(active)} x2={x(active)} y1={top} y2={height - bottom} /> : null}
      {points.map((point, index) => isNumber(point.value) ? <g key={point.period}>{index === active ? <circle cx={x(index)} cy={y(point.value)} r="8" fill={color} opacity=".16" /> : null}<circle cx={x(index)} cy={y(point.value)} r={index === active ? 4.5 : 2.8} fill={index === active ? color : "var(--fund-panel)"} stroke={color} strokeWidth="1.8" /></g> : <circle key={point.period} cx={x(index)} cy={y(0)} r="3" className={s.gapDot} />)}
      {tickIndexes.map(index => <text className={s.axisLabel} key={points[index].period} x={x(index)} y={height - 10} textAnchor={points.length === 1 ? "middle" : index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{quarter(points[index].period)}</text>)}
    </svg>
    {!points.some(point => isNumber(point.value)) ? <span className={s.chartEmpty}>No complete observation loaded</span> : null}
  </div>;
}
function Delta({ comparison, field, mode }: { comparison: any; field: string; mode: "points" | "count" | "money" }) {
  const delta = comparison?.deltas?.[field];
  if (!comparison?.available || !isNumber(delta?.change)) return <span className={s.deltaUnavailable}>Quarterly comparison unavailable</span>;
  const change = delta.change;
  const amount = mode === "points" ? `${Math.abs(change).toFixed(1)} percentage points` : mode === "money" ? money(Math.abs(change)) : number(Math.abs(change));
  return <div className={s.delta}><strong>{change > 0 ? "+" : change < 0 ? "−" : ""}{amount}</strong>{mode === "money" && isNumber(delta.changePct) ? <span>({delta.changePct > 0 ? "+" : ""}{delta.changePct.toFixed(1)}%)</span> : null}<span>vs {quarter(comparison.baselinePeriod)}</span></div>;
}
function QuarterState({ item }: { item: any }) {
  if (item.status === "loading" || item.status === "pending") return <span className={s.pending}><RefreshCw size={12} className={s.spin} />Loading</span>;
  if (item.complete) return <span className={s.complete}><Check size={12} />{item.comparable === false ? "Public snapshot · limited comparison" : "Complete public snapshot"}</span>;
  return <span className={s.pending}>{item.status === "error" ? "Could not load" : item.status === "unavailable" || item.status === "missing" ? "No complete snapshot" : "Incomplete snapshot"}</span>;
}

export default function ThirteenFHistory({ data, onOpenHolding, onSelectPeriod, initialHoldingKey = "" }: Props) {
  const [count, setCount] = useState<4 | 8 | 12>(8);
  const [chosenKey, setChosenKey] = useState(initialHoldingKey);
  const [query, setQuery] = useState("");
  const [metric, setMetric] = useState<Metric>("weightPct");
  const [concentration, setConcentration] = useState<"top10Pct" | "top5Pct">("top10Pct");
  const [inspectedPeriod, setInspectedPeriod] = useState("");
  const [previewPeriod, setPreviewPeriod] = useState<string | null>(null);
  const holdings: Holding[] = data.portfolio?.holdings || EMPTY_HOLDINGS;
  const ranked = useMemo(() => [...holdings].sort((a, b) => (isNumber(b.valueUsd) ? b.valueUsd : 0) - (isNumber(a.valueUsd) ? a.valueUsd : 0)), [holdings]);
  const selectedHolding = ranked.find(holding => holding.key === chosenKey) || ranked[0];
  const selectedKey = selectedHolding?.key || "";
  const remote = use13FHistory(data, { count, holdingKey: selectedKey });
  const history: any = remote.history;
  const quarters: any[] = history?.quarters || [];
  const pinnedPeriod = quarters.some(item => item.period === inspectedPeriod) ? inspectedPeriod : data.selectedPeriod;
  const activePeriod = quarters.some(item => item.period === previewPeriod) ? previewPeriod! : pinnedPeriod;
  const inspectPeriod = (period: string) => { setInspectedPeriod(period); setPreviewPeriod(null); };
  const active = quarters.find(item => item.period === activePeriod);
  const position: any = useMemo(() => selectedKey && history?.quarters ? get13FHoldingHistory(history, selectedKey) : null, [history, selectedKey]);
  const observations: any[] = position?.observations || [];
  const activePosition = observations.find(item => item.period === activePeriod);
  const comparison: any = useMemo(() => history ? get13FQuarterComparison(history, activePeriod) : null, [history, activePeriod]);
  const holdingComparison: any = useMemo(() => history && selectedKey ? get13FHoldingQuarterComparison(history, selectedKey, activePeriod) : null, [history, selectedKey, activePeriod]);
  const csvHref = useMemo(() => history ? `data:text/csv;charset=utf-8,${encodeURIComponent(create13FHistoryCsv(history))}` : "", [history]);
  const options = useMemo(() => {
    const term = query.trim().toUpperCase();
    const results = ranked.filter(holding => !term || `${holding.issuer} ${holding.cusip} ${holding.classTitle} ${holding.putCall || ""}`.toUpperCase().includes(term));
    return { matches: results.length, shown: results.slice(0, 200) };
  }, [ranked, query]);
  const selectOptions = selectedHolding && !options.shown.some(holding => holding.key === selectedKey) ? [selectedHolding, ...options.shown] : options.shown;
  const completeCount = quarters.filter(item => item.complete).length;
  const unavailable = quarters.filter(item => item.period !== data.selectedPeriod && !item.complete && !["loading", "pending"].includes(item.status));
  const completed = Math.min(remote.total, remote.completed);
  const persistence = position?.persistence || {};
  const changes = position?.quantityChanges || {};
  const quantityLabel = selectedHolding?.quantityType === "PRN" ? "Principal amount" : "Shares";
  const metricLabel = metric === "weightPct" ? "Share of reported value" : metric === "quantity" ? `Reported quantity · ${quantityLabel.toLowerCase()}` : "Reported value";
  const formatMetric = metric === "weightPct" ? percent : metric === "quantity" ? number : money;
  const positionLoading = remote.positionLoading;
  const positionErrors = remote.positionErrors || [];
  const lastChecked = checkedTime(active?.checkedAt || active?.observedAt);
  const chartPoints = (key: string): Point[] => quarters.map(item => ({ period: item.period, value: item.complete && isNumber(item[key]) ? item[key] : null }));
  const holdingPoints: Point[] = observations.map(item => ({ period: item.period, value: item.complete && item.status !== "unknown" && isNumber(item[metric]) ? item[metric] : null }));

  return <div className={s.history}>
    <header className={s.heading}><div><span className={s.eyebrow}><History size={14} />Portfolio history</span><h3>How the reported portfolio evolves</h3><p>Explore concentration, portfolio size, and individual holdings across quarterly disclosures.</p></div><div className={s.headerTools}><div className={s.windowControl} role="group" aria-label="History window">{([4, 8, 12] as const).map(value => <button type="button" aria-pressed={count === value} key={value} onClick={() => { setCount(value); setPreviewPeriod(null); }}>{value}<span> quarters</span></button>)}</div>{history ? <a className={s.exportLink} href={csvHref} download={`13f-${data.manager?.cik}-${data.selectedPeriod}-${count}-quarters.csv`} title="Download quarterly values, coverage, and source filings as CSV"><Download size={13} />Export quarters</a> : null}</div></header>
    <div className={s.progressRow} role="status" aria-live="polite"><div>{remote.loading ? <RefreshCw size={13} className={s.spin} /> : completeCount === quarters.length ? <Check size={13} /> : <Clock3 size={13} />}<span>{remote.loading ? `Loading quarterly snapshots · ${completed} of ${remote.total} checked` : `${completeCount} of ${quarters.length} quarters have complete public snapshots`}</span></div>{remote.loading ? <progress aria-label="Quarterly snapshots checked" value={completed} max={Math.max(1, remote.total)} /> : unavailable.length ? <button type="button" onClick={() => remote.retry()}><RefreshCw size={12} />Retry {unavailable.length} missing {unavailable.length === 1 ? "quarter" : "quarters"}</button> : <span className={s.subtle}>Ending {quarter(data.selectedPeriod)}</span>}</div>

    <div className={s.inspection}><div className={s.inspectedDetail}><div><span className={s.inspectedLabel}>{previewPeriod ? "Previewing quarter" : "Selected quarter"}</span><strong>{quarter(activePeriod)}</strong><span>{date(activePeriod)}{active ? <QuarterState item={active} /> : null}</span>{lastChecked || active?.stale ? <small className={s.freshness}>{active?.stale ? "Saved snapshot · source refresh pending" : "Source last checked"}{lastChecked ? ` · ${lastChecked}` : ""}</small> : null}</div><button type="button" onClick={() => onSelectPeriod(activePeriod)} disabled={!active?.complete || activePeriod === data.selectedPeriod}>{activePeriod === data.selectedPeriod ? "Current snapshot" : "Open this snapshot"}<ArrowRight size={13} /></button></div><div className={s.quarterRail} role="group" aria-label="Inspect a reporting quarter">{quarters.map(item => <button type="button" key={item.period} aria-pressed={pinnedPeriod === item.period} data-preview={previewPeriod === item.period || undefined} title={`${quarter(item.period)} · ${item.complete ? "Complete public snapshot" : item.reason || "Snapshot not yet complete"}`} onClick={() => inspectPeriod(item.period)}><i className={item.complete ? s.readyDot : s.missingDot} />{quarter(item.period)}</button>)}</div></div>
    {active && !active.complete ? <div className={s.coverageNotice} role="status"><div><strong>{["loading", "pending"].includes(active.status) ? `Loading ${quarter(activePeriod)}` : `A complete ${quarter(activePeriod)} snapshot is unavailable`}</strong><p>{active.reason || "This quarter remains a gap until its public holdings can be verified."} Missing values are not treated as zero.</p></div>{!["loading", "pending"].includes(active.status) && activePeriod !== data.selectedPeriod ? <button type="button" onClick={() => remote.retry(activePeriod)}><RefreshCw size={13} />Retry this quarter</button> : null}</div> : null}

    <section aria-label="Portfolio history charts" className={s.chartGrid}>
      <article className={s.chartCard}><div className={s.chartHeading}><span>Concentration</span><div className={s.smallToggle} role="group" aria-label="Concentration measure"><button type="button" aria-pressed={concentration === "top10Pct"} onClick={() => setConcentration("top10Pct")}>Top 10</button><button type="button" aria-pressed={concentration === "top5Pct"} onClick={() => setConcentration("top5Pct")}>Top 5</button></div></div><strong className={s.chartValue}>{active?.complete ? percent(active[concentration]) : "—"}</strong><span className={s.chartValueNote}>Share of disclosed value in the largest {concentration === "top10Pct" ? "10" : "5"} positions</span><Delta comparison={comparison} field={concentration} mode="points" /><SparkChart points={chartPoints(concentration)} selectedPeriod={activePeriod} onSelect={inspectPeriod} onPreview={setPreviewPeriod} label={`${concentration === "top10Pct" ? "Top 10" : "Top 5"} position concentration history`} color="var(--fund-green)" mode="percent" /></article>
      <article className={s.chartCard}><div className={s.chartHeading}><span>Reported positions</span><span className={s.unitTag}>Count</span></div><strong className={s.chartValue}>{active?.complete ? number(active.positionCount) : "—"}</strong><span className={s.chartValueNote}>Distinct securities, with security classes kept separate</span><Delta comparison={comparison} field="positionCount" mode="count" /><SparkChart points={chartPoints("positionCount")} selectedPeriod={activePeriod} onSelect={inspectPeriod} onPreview={setPreviewPeriod} label="Reported position count history" color="var(--manager-blue, #8baef5)" mode="count" /></article>
      <article className={s.chartCard}><div className={s.chartHeading}><span>Total reported value</span><span className={s.unitTag}>USD</span></div><strong className={s.chartValue} title={active?.complete && isNumber(active.totalValueUsd) ? fullDollars.format(active.totalValueUsd) : undefined}>{active?.complete ? money(active.totalValueUsd) : "—"}</strong><span className={s.chartValueNote}>Quarter-end value of disclosed securities</span><Delta comparison={comparison} field="totalValueUsd" mode="money" /><SparkChart points={chartPoints("totalValueUsd")} selectedPeriod={activePeriod} onSelect={inspectPeriod} onPreview={setPreviewPeriod} label="Total disclosed value history, not assets under management or investment returns" color="var(--fund-gold)" mode="money" /></article>
    </section>
    <div className={s.chartGuidance}><p>Hover to preview. Click a point or quarter to keep it selected. All charts start at zero and fit their own values; missing quarters remain gaps.</p>{active?.complete && !comparison?.available ? <p>{comparison?.reason || "An adjacent, comparable quarter is needed to calculate changes."}</p> : null}<p>Value changes reflect prices, quantities, and reporting scope. They do not measure investment returns or assets under management.</p></div>

    <section className={s.positionPanel} aria-labelledby="holding-history-heading"><div className={s.panelHeading}><div><span className={s.eyebrow}>Follow a position</span><h3 id="holding-history-heading">A holding’s path through the reports</h3></div>{selectedHolding ? <button type="button" onClick={() => onOpenHolding(selectedHolding)}>Company research<ArrowUpRight size={14} /></button> : null}</div>
      <div className={s.holdingControls}><label className={s.searchLabel}><span>Find a disclosed holding</span><div><Search size={15} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Issuer, CUSIP, or class" maxLength={150} /></div></label><label className={s.selectLabel}><span>Track a position</span><select value={selectedKey} disabled={!ranked.length} onChange={event => setChosenKey(event.target.value)}>{selectOptions.map(holding => <option key={holding.key} value={holding.key}>{holding.issuer} · {holding.classTitle}{holding.putCall ? ` · ${holding.putCall}` : ""} · {holding.cusip}{holding.quantityType === "PRN" ? " · Principal" : ""}</option>)}</select></label></div>
      {query.trim() ? <p className={s.searchNote}>{options.matches ? `${number(options.matches)} matching positions${options.matches > 200 ? "; refine the search to see more than the first 200" : ""}.` : "No current positions match. Your tracked holding stays selected."}</p> : ranked.length > 200 ? <p className={s.searchNote}>Showing the largest 200 positions in the selector. Search to find any of the {number(ranked.length)} disclosed positions.</p> : null}
      {!query.trim() && ranked.length > 1 ? <div className={s.quickPicks} role="group" aria-label="Largest positions in the selected report"><span>Largest positions</span>{ranked.slice(0, 5).map(holding => <button type="button" key={holding.key} aria-pressed={selectedKey === holding.key} aria-label={`Track ${holding.issuer}, ${holding.classTitle}, CUSIP ${holding.cusip}${holding.putCall ? `, ${holding.putCall}` : ""}`} title={`${holding.issuer} · ${holding.classTitle} · ${holding.cusip}${holding.putCall ? ` · ${holding.putCall}` : ""}`} onClick={() => setChosenKey(holding.key)}>{holding.issuer}{holding.putCall ? ` · ${holding.putCall}` : ""}</button>)}</div> : null}
      {selectedHolding ? <>
        <div className={s.positionTitle}><div><h4>{selectedHolding.issuer}</h4><span>{selectedHolding.classTitle}{selectedHolding.putCall ? <b>{selectedHolding.putCall}</b> : null}<code>{selectedHolding.cusip}</code><span>{quantityLabel}</span></span></div><div className={s.metricToggle} role="group" aria-label="Holding history measure">{([{ value: "weightPct", label: "Report share" }, { value: "quantity", label: "Quantity" }, { value: "valueUsd", label: "Value" }] as const).map(item => <button type="button" aria-pressed={metric === item.value} key={item.value} onClick={() => setMetric(item.value)}>{item.label}</button>)}</div></div>
        {positionLoading && !remote.loading ? <div className={s.positionProgress} role="status"><RefreshCw size={12} className={s.spin} />Loading this position’s earlier observations. Portfolio totals stay available.</div> : null}
        {positionErrors.length ? <div className={s.positionError} role="status"><span>{positionErrors.length} {positionErrors.length === 1 ? "earlier position observation is" : "earlier position observations are"} unavailable. These remain gaps; portfolio totals are still available.</span><button type="button" onClick={() => remote.retry()} disabled={positionLoading}><RefreshCw size={12} />Retry position history</button></div> : null}
        <div className={s.positionChartWrap}><div className={s.positionReadout}><span>{metricLabel}</span><strong>{formatMetric(activePosition?.complete ? activePosition[metric] : null)}</strong><small>{quarter(activePeriod)} · {activePosition?.status === "reported" ? activePosition.complete ? "Reported position" : "Incomplete snapshot · chart withheld" : activePosition?.status === "not-reported" ? "Not in this complete public snapshot" : "Observation unavailable"}</small></div><SparkChart points={holdingPoints} selectedPeriod={activePeriod} onSelect={inspectPeriod} onPreview={setPreviewPeriod} label={`${selectedHolding.issuer} ${metricLabel} history`} color="var(--fund-green)" mode={metric === "weightPct" ? "percent" : metric === "quantity" ? "count" : "money"} tall /></div>
        <div className={s.positionChange}><span>{quarter(activePeriod)} · position change</span>{holdingComparison?.available ? <><strong>{holdingComparison.changeStatus === "newly-reported" ? "Newly reported in the public table" : holdingComparison.changeStatus === "no-longer-reported" ? "No longer reported in the public table" : holdingComparison.changeStatus === "unchanged" ? "Reported quantity unchanged" : holdingComparison.changeStatus === "not-reported" ? "Not reported in either quarter" : `${signedNumber(holdingComparison.deltas.quantity.change)} ${quantityLabel.toLowerCase()}${isNumber(holdingComparison.deltas.quantity.changePct) ? ` (${holdingComparison.deltas.quantity.changePct > 0 ? "+" : ""}${holdingComparison.deltas.quantity.changePct.toFixed(1)}%)` : ""}`}</strong><span>vs {quarter(holdingComparison.baselinePeriod)}{isNumber(holdingComparison.deltas.weightPct.change) ? ` · Report share ${holdingComparison.deltas.weightPct.change > 0 ? "+" : ""}${holdingComparison.deltas.weightPct.change.toFixed(2)} percentage points` : ""}</span></> : <span>{holdingComparison?.reason || "A complete, comparable pair of quarters is needed."}</span>}</div>
        <div className={s.positionStats}><article><span>First observed in this window</span><strong>{persistence.firstObservedPeriod ? quarter(persistence.firstObservedPeriod) : "—"}</strong><small>{persistence.observedAtWindowStart ? "Already present at the window’s start; it may have been held earlier." : "First appearance among the snapshots loaded here, not a purchase date."}</small></article><article><span>Quarters reporting this position</span><strong>{number(persistence.observedQuarters)}<em> / {quarters.length}</em></strong><small>{number(persistence.consecutiveObservedQuarters)} consecutive quarters through {quarter(data.selectedPeriod)}.</small></article><article><span>Quantity changes between quarters</span><strong><span className={s.increase}>{number(changes.increased)} higher</span><span className={s.decrease}>{number(changes.decreased)} lower</span></strong><small>{number(changes.comparablePairs)} comparable adjacent pairs.{isNumber(changes.increaseStreak) && changes.increaseStreak >= 2 ? ` Higher in the last ${changes.increaseStreak} comparisons.` : isNumber(changes.decreaseStreak) && changes.decreaseStreak >= 2 ? ` Lower in the last ${changes.decreaseStreak} comparisons.` : " Gaps interrupt the sequence."}</small></article></div>
        <p className={s.caption}>The position chart uses a zero-based scale fitted to this holding. Each security is matched by CUSIP, option type, and quantity units. New identifiers are separate histories. Repeated quantity changes can reflect corporate actions or reporting changes as well as trading.{selectedHolding.putCall ? " Option values and quantities describe the underlying securities; they do not measure premiums or net directional exposure." : ""}</p>
        <details className={s.detail} key={`observations-${selectedKey}`}><summary>Quarter-by-quarter position detail<ChevronDown size={15} /></summary><div className={s.tableScroll} tabIndex={0} role="region" aria-label="Individual position history table"><table><thead><tr><th scope="col">Quarter</th><th scope="col">Public observation</th><th scope="col">{quantityLabel}</th><th scope="col">Quantity change</th><th scope="col">Report share</th><th scope="col">Reported value</th></tr></thead><tbody>{observations.map(item => <tr key={item.period}><th scope="row">{quarter(item.period)}</th><td>{item.status === "reported" ? item.complete ? "Reported" : "Reported · incomplete snapshot" : item.status === "not-reported" ? "Not reported" : "Unknown"}{item.reason ? <small>{item.reason}</small> : null}</td><td>{number(item.quantity)}</td><td>{signedNumber(item.quantityChange)}{isNumber(item.quantityChangePct) ? <small>{item.quantityChangePct > 0 ? "+" : ""}{item.quantityChangePct.toFixed(1)}%</small> : null}</td><td>{percent(item.weightPct)}</td><td>{isNumber(item.valueUsd) ? fullDollars.format(item.valueUsd) : "—"}</td></tr>)}</tbody></table></div>{position?.notes?.length ? <ul className={s.notes}>{position.notes.map((note: string, index: number) => <li key={index}>{note}</li>)}</ul> : null}</details>
      </> : <div className={s.empty}>No positions are available to track in this selected report.</div>}
    </section>

    <details className={s.detail}><summary><span><FileText size={15} />Snapshot values and SEC evidence</span><span>{completeCount} / {quarters.length} complete<ChevronDown size={15} /></span></summary><div className={s.tableScroll} tabIndex={0} role="region" aria-label="Portfolio history values and source filings"><table><thead><tr><th scope="col">Quarter end</th><th scope="col">Coverage</th><th scope="col">Positions</th><th scope="col">Top 10</th><th scope="col">Reported value</th><th scope="col">Source filings</th></tr></thead><tbody>{quarters.map(item => <tr key={item.period}><th scope="row">{date(item.period)}</th><td><QuarterState item={item} />{item.stale ? <small>Saved snapshot · source refresh pending</small> : null}{checkedTime(item.checkedAt || item.observedAt) ? <small>Source checked {checkedTime(item.checkedAt || item.observedAt)}</small> : null}{item.reason ? <small>{item.reason}</small> : null}{!item.complete && !["loading", "pending"].includes(item.status) ? item.period === data.selectedPeriod ? <small>Use Refresh above to reload the selected report.</small> : <button type="button" className={s.retryButton} onClick={() => remote.retry(item.period)}><RefreshCw size={12} />Retry quarter</button> : null}</td><td>{item.complete ? number(item.positionCount) : "—"}</td><td>{item.complete ? percent(item.top10Pct) : "—"}</td><td>{item.complete && isNumber(item.totalValueUsd) ? fullDollars.format(item.totalValueUsd) : "—"}</td><td><div className={s.sources}>{(item.filings || []).map((filing: any, index: number) => { const href = secUrl(filing.filingUrl || filing.indexUrl || filing.primaryUrl || filing.url); return href ? <a key={filing.accessionNumber || index} href={href} target="_blank" rel="noopener noreferrer">{filing.form || "SEC filing"} · {date(filing.filingDate)}<ArrowUpRight size={11} /></a> : <span key={filing.accessionNumber || index}>{filing.form || "SEC filing"} · {date(filing.filingDate)}</span>; })}{!item.filings?.length ? <span>No verified source loaded</span> : null}</div></td></tr>)}</tbody></table></div><div className={s.methodology}><p>Each quarter incorporates the original filing and applicable amendments available when loaded. It is the currently available public record for that quarter, not necessarily what was public on the quarter-end date.</p><p>A missing report, incomplete information table, or unverified amendment produces a gap. Confidential omissions and notices can prevent reliable absence or quantity comparisons. A position is never assumed to be zero because its report failed to load.</p><p>Reported value is standardized to US dollars using the applicable SEC form version. Cash, short positions, and other assets outside Form 13F are not added to these charts.</p></div></details>
    <div className={s.bottomNote}><Clock3 size={14} /><p>These are quarter-end disclosures with a filing delay. To inspect positions that have disappeared from the latest report, open an earlier snapshot and return to History.</p></div>
  </div>;
}
