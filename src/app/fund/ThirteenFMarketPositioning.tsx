"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, RefreshCw } from "lucide-react";
import { clearPreparedCftc, fetchPreparedCftc } from "../../utils/cftcClient.js";
import { scenarioMarketHistory } from "../../utils/portfolioScenarioMarket.js";
import s from "./ThirteenFMarketPositioning.module.css";

type Props = { market: any; active: boolean; initialData?: any };
type Request = { path: string; status: "loading" | "ready" | "error"; data: any };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const number = (value: unknown, digits = 0, signed = false) => finite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: signed ? "exceptZero" : "auto" }) : "—";
const percent = (value: unknown, digits = 1) => finite(value) ? `${number(value, digits)}%` : "—";

/** Only the selected market mounts a request and an interactive chart. */
export default function ThirteenFMarketPositioning({ market, active, initialData }: Props) {
  if (!active || !market) return null;
  return <Positioning key={`${market.family}:${market.contract}:${market.group}`} market={market} initialData={initialData} />;
}

function Positioning({ market, initialData }: { market: any; initialData?: any }) {
  const id = useId();
  const path = `/api/v1/cftc/history?${new URLSearchParams({ family: market.family, contract: market.contract, group: market.group, window: "1y", date: "latest" })}`;
  // The snapshot may carry only its first chart. Validate the complete market
  // selection before reusing it for a selected market or skipping a request.
  const prepared = useMemo(() => initialData?.selection?.history_window === "1y" && scenarioMarketHistory(initialData, market) ? initialData : null, [initialData, market]);
  const [request, setRequest] = useState<Request>(() => ({ path, status: prepared ? "ready" : "loading", data: prepared }));
  const [retry, setRetry] = useState(0);
  const [inspectedDate, setInspectedDate] = useState("");
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (prepared && !retry) { setRequest({ path, status: "ready", data: prepared }); return; }
    const controller = new AbortController();
    fetchPreparedCftc(path, { signal: controller.signal, timeoutMs: 46_000 })
      .then(data => { if (!controller.signal.aborted) setRequest({ path, status: "ready", data }); })
      .catch(() => { if (!controller.signal.aborted) setRequest({ path, status: "error", data: null }); });
    return () => controller.abort();
  }, [path, retry, prepared]);
  const raw = request.path === path ? request.data : null;
  const history: any = useMemo(() => raw?.selection?.history_window === "1y" ? scenarioMarketHistory(raw, market) : null, [raw, market]);
  const pending = request.path !== path || request.status === "loading";
  const chart = history?.chart;
  const dots: any[] = chart?.dots || [];
  const point = dots.find(row => row.date === inspectedDate) || dots.at(-1);
  const observation = history?.points?.find((row: any) => row.reportDate === point?.date);
  const groupLabel = market.groupLabel || (market.group === "leveraged-funds" ? "Leveraged funds" : "Managed money");
  const refresh = () => { clearPreparedCftc(path); setRequest({ path, status: "loading", data: null }); setRetry(value => value + 1); };

  return <section className={s.positioning} aria-labelledby={`${id}-heading`}>
    <div className={s.heading}><div><span className={s.eyebrow}>CFTC · Market context</span><h4 id={`${id}-heading`}>How futures traders are positioned</h4></div><span className={s.basis}>{groupLabel}<span>Futures only</span></span></div>
    {pending ? <div className={s.loading} role="status"><RefreshCw size={17} className={s.spin} /><p>Loading this market’s weekly observations…<small>The SEC connections remain available below.</small></p></div> : !history ? <div className={s.unavailable} role="status"><p>The selected CFTC history is temporarily unavailable. Company disclosures are still available below.</p><button type="button" onClick={refresh}><RefreshCw size={13} />Retry market data</button></div> : <>
      <div className={s.metrics}><div><span>Net / open interest</span><strong>{percent(history.current?.netPctOi)}</strong><small>{number(history.current?.net, 0, true)} net contracts</small></div><div><span>Weekly change</span><strong>{number(history.weekly?.available ? history.weekly.netPctChange : null, 1, true)}<em>{finite(history.weekly?.available ? history.weekly.netPctChange : null) ? " pts" : ""}</em></strong><small>Change in net / open interest</small></div><div><span>Positions as of</span><strong className={s.observationDate}>{history.reportDate}</strong><small>Latest available observation</small></div></div>
      {(history.stale || history.incomplete) && <p className={s.notice}>{history.stale ? "This market snapshot is older or retained from the last successful refresh. " : "Some weekly observations are unavailable or were excluded. "}Gaps stay visible; missing values are not zero.</p>}
      {chart ? <figure className={s.figure}>
        <figcaption><span>Net positioning · % of total open interest</span><span>52-week window · {number(chart.count)} observations</span></figcaption>
        <div className={s.chart} role="group" tabIndex={0} aria-label={`${market.label} weekly net positioning chart`} aria-describedby={`${id}-instructions`} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !dots.length) return;
          event.preventDefault();
          const index = Math.max(0, dots.findIndex(row => row.date === point?.date));
          const next = event.key === "Home" ? 0 : event.key === "End" ? dots.length - 1 : Math.max(0, Math.min(dots.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
          setInspectedDate(dots[next].date);
        }} onPointerMove={event => {
          if (!dots.length) return;
          const box = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - box.left) / box.width * 680;
          const closest = dots.reduce((best, row) => Math.abs(row.x - x) < Math.abs(best.x - x) ? row : best, dots[0]);
          setInspectedDate(closest.date);
        }}>
          <svg viewBox="0 0 680 210" aria-hidden="true">
            {[38, 104, 170].map(y => <line key={y} className={s.gridLine} x1="48" x2="640" y1={y} y2={y} />)}
            <line className={s.zeroLine} x1="48" x2="640" y1={chart.zeroY} y2={chart.zeroY} />
            {point && <line className={s.cursor} x1={point.x} x2={point.x} y1="32" y2="176" />}
            {chart.paths.map((line: string, index: number) => <path key={index} className={s.line} d={line} />)}
            {dots.map(row => <circle key={row.date} className={s.dot} cx={row.x} cy={row.y} r="1.7" />)}
            {point && <g><circle className={s.halo} cx={point.x} cy={point.y} r="9" /><circle className={s.activeDot} cx={point.x} cy={point.y} r="4" /></g>}
            <text className={s.axis} x="1" y="42">{percent(chart.max)}</text><text className={s.axis} x="1" y="174">{percent(chart.min)}</text>
            <text className={s.axis} x="48" y="204">{chart.start}</text><text className={s.axis} x="640" y="204" textAnchor="end">{chart.end}</text>
          </svg>
        </div>
        <div className={s.readout} aria-live={focused ? "polite" : "off"} aria-atomic="true"><span>{point?.date || "No observation selected"}</span><strong>{percent(point?.value, 2)}</strong><span>{number(observation?.net, 0, true)} net contracts</span></div>
        <p id={`${id}-instructions`} className={s.chartInstructions}>Hover to inspect a week. With the chart focused, use the arrow keys.</p>
      </figure> : <p className={s.notice}>At least two compatible observations are needed to draw a history chart.</p>}
      <p className={s.scope}>Aggregate futures positions describe this market’s trader group. They do not identify the manager’s or a company’s positions, hedges, or sensitivity.</p>
      <div className={s.links}><a href={history.marketPath} target="_blank" rel="noopener noreferrer">Explore the market<ArrowUpRight size={13} /></a><button type="button" onClick={refresh}><RefreshCw size={12} />Refresh</button></div>
      <details className={s.detail}><summary>Exact observations & CFTC source<ChevronDown size={14} /></summary><div className={s.method}><p><a href={history.sourceUrl} target="_blank" rel="noopener noreferrer">Official CFTC data<ArrowUpRight size={12} /></a> · {market.family === "tff" ? "Traders in Financial Futures" : "Disaggregated"} · Contract {market.contract} · {groupLabel} · Futures only.</p><p>Net / open interest = 100 × (long − short) / total market open interest for each observation date. Positive values mean more longs than shorts in this trader group; negative values mean more shorts than longs. This is positioning, not a price series or a price forecast.</p><p>{history.weekly?.available ? history.weekly.explanation : history.weekly?.reason} Report dates are position observation dates; publication times are not verified here.</p></div><div className={s.tableScroll} role="region" tabIndex={0} aria-label={`${market.label} exact weekly observations`}><table><thead><tr><th scope="col">Positions as of</th><th scope="col">Long</th><th scope="col">Short</th><th scope="col">Open interest</th><th scope="col">Net / OI</th></tr></thead><tbody>{[...(history.points || [])].reverse().map((row: any) => <tr key={row.reportDate}><th scope="row">{row.reportDate}</th><td>{number(row.long)}</td><td>{number(row.short)}</td><td>{number(row.openInterest)}</td><td>{percent(row.netPctOi, 2)}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
}
