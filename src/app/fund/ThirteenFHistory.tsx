"use client";

import { useId, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Clock3, FileText, History, RefreshCw, Search } from "lucide-react";
import { get13FHoldingHistory } from "../../utils/thirteenFHistory.js";
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
function secUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) ? url.href : null; } catch { return null; }
}
function niceMaximum(values: (number | null)[]) {
  const max = Math.max(0, ...values.filter(isNumber));
  if (max <= 0) return 1;
  const scale = 10 ** Math.floor(Math.log10(max));
  const rounded = [1, 2, 2.5, 5, 10].find(step => step * scale >= max) || 10;
  return rounded * scale;
}
function SparkChart({ points, selectedPeriod, onSelect, label, color, mode, tall = false, fixedPercentScale = false }: { points: Point[]; selectedPeriod: string; onSelect: (period: string) => void; label: string; color: string; mode: "percent" | "count" | "money"; tall?: boolean; fixedPercentScale?: boolean }) {
  const descriptionId = useId();
  const [focused, setFocused] = useState(false);
  const width = 600, height = tall ? 240 : 192, left = 62, right = 18, top = 18, bottom = 36;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = mode === "percent" && fixedPercentScale ? 100 : niceMaximum(points.map(point => point.value));
  const x = (index: number) => left + (points.length <= 1 ? plotWidth / 2 : index / (points.length - 1) * plotWidth);
  const y = (value: number) => top + plotHeight - Math.min(maximum, Math.max(0, value)) / maximum * plotHeight;
  const active = Math.max(0, points.findIndex(point => point.period === selectedPeriod));
  const tickCount = Math.min(4, points.length);
  const tickIndexes = Array.from({ length: tickCount }, (_, index) => Math.round(index * (points.length - 1) / Math.max(1, tickCount - 1)));
  const path = points.map((point, index) => {
    if (!isNumber(point.value)) return "";
    return `${index > 0 && isNumber(points[index - 1].value) ? "L" : "M"}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`;
  }).join(" ");
  const axisValue = (value: number) => mode === "percent" ? `${value.toLocaleString("en-US", { maximumFractionDigits: Math.min(8, Math.max(0, 1 - Math.floor(Math.log10(maximum)))) })}%` : mode === "money" ? dollars.format(value) : compact.format(value);
  return <div className={`${s.chart} ${tall ? s.tallChart : ""}`} tabIndex={0} role="group" aria-label={label} aria-describedby={descriptionId} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !points.length) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.min(points.length - 1, Math.max(0, active + (event.key === "ArrowLeft" ? -1 : 1)));
      onSelect(points[index].period);
    }}
    onPointerMove={event => {
      if (!points.length) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const local = (event.clientX - rect.left) / Math.max(1, rect.width) * width;
      const index = Math.min(points.length - 1, Math.max(0, Math.round((local - left) / plotWidth * (points.length - 1))));
      onSelect(points[index].period);
    }}>
    <span id={descriptionId} className={s.srOnly}>Use the left and right arrow keys to inspect quarters. Missing observations break the line. Exact values are available in the history tables below.</span>
    <span className={s.srOnly} aria-live={focused ? "polite" : "off"} aria-atomic="true">{points[active] ? `${quarter(points[active].period)}: ${isNumber(points[active].value) ? mode === "percent" ? percent(points[active].value) : mode === "money" ? fullDollars.format(points[active].value) : number(points[active].value) : "Observation unavailable"}.` : "No observations loaded."}</span>
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {[0, .5, 1].map(fraction => <g key={fraction}><line className={s.gridLine} x1={left} x2={width - right} y1={y(maximum * fraction)} y2={y(maximum * fraction)} /><text className={s.axisLabel} x={left - 12} y={y(maximum * fraction) + 4} textAnchor="end">{axisValue(maximum * fraction)}</text></g>)}
      {points.length ? <line className={s.activeLine} x1={x(active)} x2={x(active)} y1={top} y2={height - bottom} /> : null}
      <path d={path} fill="none" stroke={color} strokeWidth="2.7" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((point, index) => isNumber(point.value) ? <g key={point.period}>{index === active ? <circle cx={x(index)} cy={y(point.value)} r="8" fill={color} opacity=".14" /> : null}<circle cx={x(index)} cy={y(point.value)} r={index === active ? 4.5 : 2.8} fill={index === active ? color : "var(--fund-panel)"} stroke={color} strokeWidth="1.8" /></g> : null)}
      {tickIndexes.map(index => <text className={s.axisLabel} key={points[index].period} x={x(index)} y={height - 10} textAnchor={points.length === 1 ? "middle" : index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{quarter(points[index].period)}</text>)}
    </svg>
    {!points.some(point => isNumber(point.value)) ? <span className={s.chartEmpty}>Waiting for a complete observation</span> : null}
  </div>;
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
  const holdings: Holding[] = data.portfolio?.holdings || EMPTY_HOLDINGS;
  const ranked = useMemo(() => [...holdings].sort((a, b) => (isNumber(b.valueUsd) ? b.valueUsd : 0) - (isNumber(a.valueUsd) ? a.valueUsd : 0)), [holdings]);
  const selectedHolding = ranked.find(holding => holding.key === chosenKey) || ranked[0];
  const selectedKey = selectedHolding?.key || "";
  const remote = use13FHistory(data, { count, holdingKey: selectedKey });
  const history: any = remote.history;
  const quarters: any[] = history?.quarters || [];
  const activePeriod = quarters.some(item => item.period === inspectedPeriod) ? inspectedPeriod : data.selectedPeriod;
  const active = quarters.find(item => item.period === activePeriod);
  const position: any = useMemo(() => selectedKey && history?.quarters ? get13FHoldingHistory(history, selectedKey) : null, [history, selectedKey]);
  const observations: any[] = position?.observations || [];
  const activePosition = observations.find(item => item.period === activePeriod);
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
  const chartPoints = (key: string): Point[] => quarters.map(item => ({ period: item.period, value: item.complete && isNumber(item[key]) ? item[key] : null }));
  const holdingPoints: Point[] = observations.map(item => ({ period: item.period, value: item.complete && item.status !== "unknown" && isNumber(item[metric]) ? item[metric] : null }));

  return <div className={s.history}>
    <header className={s.heading}><div><span className={s.eyebrow}><History size={14} />A longer view</span><h3>The reported portfolio, over time</h3><p>Follow concentration and individual positions across quarter-end disclosures.</p></div><div className={s.windowControl} role="group" aria-label="History window">{([4, 8, 12] as const).map(value => <button type="button" aria-pressed={count === value} key={value} onClick={() => setCount(value)}>{value}<span> quarters</span></button>)}</div></header>
    <div className={s.progressRow} role="status" aria-live="polite"><div>{remote.loading ? <RefreshCw size={13} className={s.spin} /> : <Check size={13} />}<span>{remote.loading ? `Reading SEC snapshots · ${completed} of ${remote.total} checked` : `${completeCount} complete public snapshots across ${quarters.length} quarters`}</span></div>{remote.loading ? <progress aria-label="Quarterly snapshots checked" value={completed} max={Math.max(1, remote.total)} /> : unavailable.length ? <button type="button" onClick={() => remote.retry()}><RefreshCw size={12} />Retry missing snapshots</button> : <span className={s.subtle}>Ending {quarter(data.selectedPeriod)}</span>}</div>

    <section aria-label="Portfolio history charts" className={s.chartGrid}>
      <article className={s.chartCard}><div className={s.chartHeading}><span>Concentration</span><div className={s.smallToggle} role="group" aria-label="Concentration measure"><button type="button" aria-pressed={concentration === "top10Pct"} onClick={() => setConcentration("top10Pct")}>Top 10</button><button type="button" aria-pressed={concentration === "top5Pct"} onClick={() => setConcentration("top5Pct")}>Top 5</button></div></div><strong className={s.chartValue}>{active?.complete ? percent(active[concentration]) : "—"}</strong><span className={s.chartValueNote}>{quarter(activePeriod)} · share of reported value</span><SparkChart points={chartPoints(concentration)} selectedPeriod={activePeriod} onSelect={setInspectedPeriod} label={`${concentration === "top10Pct" ? "Top 10" : "Top 5"} position concentration history`} color="var(--fund-green)" mode="percent" fixedPercentScale /></article>
      <article className={s.chartCard}><div className={s.chartHeading}><span>Reported positions</span><span className={s.unitTag}>Count</span></div><strong className={s.chartValue}>{active?.complete ? number(active.positionCount) : "—"}</strong><span className={s.chartValueNote}>{quarter(activePeriod)} · security classes kept separate</span><SparkChart points={chartPoints("positionCount")} selectedPeriod={activePeriod} onSelect={setInspectedPeriod} label="Reported position count history" color="var(--manager-blue, #8baef5)" mode="count" /></article>
      <article className={s.chartCard}><div className={s.chartHeading}><span>Total reported value</span><span className={s.unitTag}>USD</span></div><strong className={s.chartValue} title={active?.complete && isNumber(active.totalValueUsd) ? fullDollars.format(active.totalValueUsd) : undefined}>{active?.complete ? money(active.totalValueUsd) : "—"}</strong><span className={s.chartValueNote}>{quarter(activePeriod)} · disclosed securities</span><SparkChart points={chartPoints("totalValueUsd")} selectedPeriod={activePeriod} onSelect={setInspectedPeriod} label="Total disclosed value history, not assets under management or investment returns" color="var(--fund-gold)" mode="money" /></article>
    </section>

    <div className={s.inspection}><div className={s.quarterRail} role="group" aria-label="Inspect a reporting quarter">{quarters.map(item => <button type="button" key={item.period} aria-pressed={activePeriod === item.period} title={`${quarter(item.period)} · ${item.complete ? "Complete public snapshot" : item.reason || "Snapshot not yet complete"}`} onClick={() => setInspectedPeriod(item.period)}><i className={item.complete ? s.readyDot : s.missingDot} />{quarter(item.period)}</button>)}</div><div className={s.inspectedDetail}><span><strong>{date(activePeriod)}</strong>{active ? <QuarterState item={active} /> : null}</span><button type="button" onClick={() => onSelectPeriod(activePeriod)} disabled={!active?.complete || activePeriod === data.selectedPeriod}>Open this snapshot<ArrowRight size={13} /></button></div></div>
    <p className={s.caption}>Hover over a chart or select a quarter to inspect all three measures. Gaps remain visible. Changes in disclosed value reflect prices, quantities, and reporting scope; this is not a performance or assets-under-management chart.</p>

    <section className={s.positionPanel} aria-labelledby="holding-history-heading"><div className={s.panelHeading}><div><span className={s.eyebrow}>Follow a position</span><h3 id="holding-history-heading">A holding’s path through the reports</h3></div>{selectedHolding ? <button type="button" onClick={() => onOpenHolding(selectedHolding)}>Company research<ArrowUpRight size={14} /></button> : null}</div>
      <div className={s.holdingControls}><label className={s.searchLabel}><span>Find a disclosed holding</span><div><Search size={15} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Issuer, CUSIP, or class" maxLength={150} /></div></label><label className={s.selectLabel}><span>Track a position</span><select value={selectedKey} disabled={!ranked.length} onChange={event => setChosenKey(event.target.value)}>{selectOptions.map(holding => <option key={holding.key} value={holding.key}>{holding.issuer} · {holding.classTitle}{holding.putCall ? ` · ${holding.putCall}` : ""} · {holding.cusip}{holding.quantityType === "PRN" ? " · Principal" : ""}</option>)}</select></label></div>
      {query.trim() ? <p className={s.searchNote}>{options.matches ? `${number(options.matches)} matching positions${options.matches > 200 ? "; refine the search to see more than the first 200" : ""}.` : "No current positions match. Your tracked holding stays selected."}</p> : ranked.length > 200 ? <p className={s.searchNote}>Showing the largest 200 positions in the selector. Search to find any of the {number(ranked.length)} disclosed positions.</p> : null}
      {selectedHolding ? <>
        <div className={s.positionTitle}><div><h4>{selectedHolding.issuer}</h4><span>{selectedHolding.classTitle}{selectedHolding.putCall ? <b>{selectedHolding.putCall}</b> : null}<code>{selectedHolding.cusip}</code><span>{quantityLabel}</span></span></div><div className={s.metricToggle} role="group" aria-label="Holding history measure">{([{ value: "weightPct", label: "Report share" }, { value: "quantity", label: "Quantity" }, { value: "valueUsd", label: "Value" }] as const).map(item => <button type="button" aria-pressed={metric === item.value} key={item.value} onClick={() => setMetric(item.value)}>{item.label}</button>)}</div></div>
        <div className={s.positionChartWrap}><div className={s.positionReadout}><span>{metricLabel}</span><strong>{formatMetric(activePosition?.complete ? activePosition[metric] : null)}</strong><small>{quarter(activePeriod)} · {activePosition?.status === "reported" ? activePosition.complete ? "Reported position" : "Incomplete snapshot · chart withheld" : activePosition?.status === "not-reported" ? "Not in this complete public snapshot" : "Observation unavailable"}</small></div><SparkChart points={holdingPoints} selectedPeriod={activePeriod} onSelect={setInspectedPeriod} label={`${selectedHolding.issuer} ${metricLabel} history`} color="var(--fund-green)" mode={metric === "weightPct" ? "percent" : metric === "quantity" ? "count" : "money"} tall /></div>
        <div className={s.positionStats}><article><span>First observed in this window</span><strong>{persistence.firstObservedPeriod ? quarter(persistence.firstObservedPeriod) : "—"}</strong><small>{persistence.observedAtWindowStart ? "Already present at the window’s start; it may have been held earlier." : "First appearance among the snapshots loaded here, not a purchase date."}</small></article><article><span>Quarters reporting this position</span><strong>{number(persistence.observedQuarters)}<em> / {quarters.length}</em></strong><small>{number(persistence.consecutiveObservedQuarters)} consecutive quarters through the selected reporting quarter.</small></article><article><span>Quantity changes between quarters</span><strong><span className={s.increase}>{number(changes.increased)} higher</span><span className={s.decrease}>{number(changes.decreased)} lower</span></strong><small>{number(changes.comparablePairs)} comparable adjacent pairs.{isNumber(changes.increaseStreak) && changes.increaseStreak >= 2 ? ` Higher in the last ${changes.increaseStreak} comparisons.` : isNumber(changes.decreaseStreak) && changes.decreaseStreak >= 2 ? ` Lower in the last ${changes.decreaseStreak} comparisons.` : " Gaps interrupt the sequence."}</small></article></div>
        <p className={s.caption}>The position chart uses a zero-based scale fitted to this holding. Each security is matched by CUSIP, option type, and quantity units. New identifiers are separate histories. Repeated quantity changes can reflect corporate actions or reporting changes as well as trading.{selectedHolding.putCall ? " Option values and quantities describe the underlying securities; they do not measure premiums or net directional exposure." : ""}</p>
        <details className={s.detail} key={`observations-${selectedKey}`}><summary>Quarter-by-quarter position detail<ChevronDown size={15} /></summary><div className={s.tableScroll} tabIndex={0} role="region" aria-label="Individual position history table"><table><thead><tr><th scope="col">Quarter</th><th scope="col">Public observation</th><th scope="col">{quantityLabel}</th><th scope="col">Quantity change</th><th scope="col">Report share</th><th scope="col">Reported value</th></tr></thead><tbody>{observations.map(item => <tr key={item.period}><th scope="row">{quarter(item.period)}</th><td>{item.status === "reported" ? item.complete ? "Reported" : "Reported · incomplete snapshot" : item.status === "not-reported" ? "Not reported" : "Unknown"}{item.reason ? <small>{item.reason}</small> : null}</td><td>{number(item.quantity)}</td><td>{signedNumber(item.quantityChange)}{isNumber(item.quantityChangePct) ? <small>{item.quantityChangePct > 0 ? "+" : ""}{item.quantityChangePct.toFixed(1)}%</small> : null}</td><td>{percent(item.weightPct)}</td><td>{isNumber(item.valueUsd) ? fullDollars.format(item.valueUsd) : "—"}</td></tr>)}</tbody></table></div>{position?.notes?.length ? <ul className={s.notes}>{position.notes.map((note: string, index: number) => <li key={index}>{note}</li>)}</ul> : null}</details>
      </> : <div className={s.empty}>No positions are available to track in this selected report.</div>}
    </section>

    <details className={s.detail}><summary><span><FileText size={15} />Snapshot values and SEC evidence</span><span>{completeCount} / {quarters.length} complete<ChevronDown size={15} /></span></summary><div className={s.tableScroll} tabIndex={0} role="region" aria-label="Portfolio history values and source filings"><table><thead><tr><th scope="col">Quarter end</th><th scope="col">Coverage</th><th scope="col">Positions</th><th scope="col">Top 10</th><th scope="col">Reported value</th><th scope="col">Source filings</th></tr></thead><tbody>{quarters.map(item => <tr key={item.period}><th scope="row">{date(item.period)}</th><td><QuarterState item={item} />{item.reason ? <small>{item.reason}</small> : null}{!item.complete && !["loading", "pending"].includes(item.status) ? item.period === data.selectedPeriod ? <small>Use Refresh above to reload the selected report.</small> : <button type="button" className={s.retryButton} onClick={() => remote.retry(item.period)}><RefreshCw size={12} />Retry quarter</button> : null}</td><td>{item.complete ? number(item.positionCount) : "—"}</td><td>{item.complete ? percent(item.top10Pct) : "—"}</td><td>{item.complete && isNumber(item.totalValueUsd) ? fullDollars.format(item.totalValueUsd) : "—"}</td><td><div className={s.sources}>{(item.filings || []).map((filing: any, index: number) => { const href = secUrl(filing.filingUrl || filing.indexUrl || filing.primaryUrl || filing.url); return href ? <a key={filing.accessionNumber || index} href={href} target="_blank" rel="noopener noreferrer">{filing.form || "SEC filing"} · {date(filing.filingDate)}<ArrowUpRight size={11} /></a> : <span key={filing.accessionNumber || index}>{filing.form || "SEC filing"} · {date(filing.filingDate)}</span>; })}{!item.filings?.length ? <span>No verified source loaded</span> : null}</div></td></tr>)}</tbody></table></div><div className={s.methodology}><p>Each quarter incorporates the original filing and applicable amendments available when loaded. It is the currently available public record for that quarter, not necessarily what was public on the quarter-end date.</p><p>A missing report, incomplete information table, or unverified amendment produces a gap. Confidential omissions and notices can prevent reliable absence or quantity comparisons. A position is never assumed to be zero because its report failed to load.</p><p>Reported value is standardized to US dollars using the applicable SEC form version. Cash, short positions, and other assets outside Form 13F are not added to these charts.</p></div></details>
    <div className={s.bottomNote}><Clock3 size={14} /><p>These are quarter-end disclosures with a filing delay. To inspect positions that have disappeared from the latest report, open an earlier snapshot and return to History.</p></div>
  </div>;
}
