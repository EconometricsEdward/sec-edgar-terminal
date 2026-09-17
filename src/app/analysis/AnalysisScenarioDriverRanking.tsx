"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, SlidersHorizontal } from "lucide-react";
import { buildScenarioDriverRanking } from "../../utils/analysisScenarioDriverRanking.js";
import { normalizeScenarioSettings } from "../../utils/analysisScenarios.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./AnalysisScenarioDriverRanking.module.css";

const assumption = (value: number, unit: string) => `${value.toLocaleString("en-US", { maximumFractionDigits: 3 })}${unit === "pp" ? " pp" : "%"}`;

export default function AnalysisScenarioDriverRanking(props: any) {
  const context = JSON.stringify([props.data.ticker, props.data.lens, props.data.periods?.[props.index], props.data.asOf, normalizeScenarioSettings(props.settings)]);
  return <RankingExplorer key={context} {...props} />;
}

function RankingExplorer({ data, settings, index, onInspect }: any) {
  const [exercise, setExercise] = useState(settings.scenarioCashMode === "connected" && data.lens === "corporate" ? "connected" : data.lens === "corporate" ? "operating" : "balance");
  const [outcome, setOutcome] = useState("");
  const [ranges, setRanges] = useState<Record<string, { low: number; high: number }>>({});
  const [drafts, setDrafts] = useState<Record<string, { low?: string; high?: string }>>({});
  const [rangeError, setRangeError] = useState("");
  const ranking = useMemo(() => buildScenarioDriverRanking(data, settings, index, { exercise, outcome, ranges }), [data, settings, index, exercise, outcome, ranges]);
  const value = (n: any) => Number.isFinite(n) ? analysisValue(n, ranking.outcome.format, settings.units) : "Unavailable";
  const delta = (n: any) => Number.isFinite(n) ? `${n > 0 ? "+" : ""}${analysisValue(n, ranking.outcome.format === "percent" ? "percentagePoints" : "currency", settings.units)}` : "Unavailable";
  const extent = ranking.maximum || 1;
  const position = (n: number) => 50 + (n / extent) * 48;
  const updateRanges = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = { ...ranges };
    for (const driver of ranking.drivers) {
      const draft = drafts[driver.key];
      if (!draft) continue;
      const rawLow = draft.low ?? String(driver.low), rawHigh = draft.high ?? String(driver.high);
      const low = rawLow.trim() ? Number(rawLow) : NaN, high = rawHigh.trim() ? Number(rawHigh) : NaN;
      if (!Number.isFinite(low) || !Number.isFinite(high) || low < driver.min || high > driver.max || low > driver.current || high < driver.current || low >= high) {
        setRangeError(`${driver.label}: choose distinct values between ${driver.min} and ${driver.max} ${driver.unit} that span the committed value (${driver.current} ${driver.unit}).`);
        return;
      }
      next[driver.key] = { low, high };
    }
    setRanges(next); setDrafts({}); setRangeError("");
  };
  return <section className={styles.panel} aria-labelledby="scenario-driver-ranking-heading">
    <div className={styles.heading}><div><p className={styles.eyebrow}><SlidersHorizontal size={14} aria-hidden="true" /> Test what matters</p><h3 id="scenario-driver-ranking-heading">Which assumptions move the result?</h3></div><span className={styles.badge}>One driver at a time</span></div>
    <p className={styles.description}>Compare changes around your committed case. Each row tests the low and high assumption shown, with every other input held fixed.</p>
    <div className={styles.controls}>
      {ranking.exercises.length > 1 && <label>Driver model<select value={ranking.exercise} onChange={(e) => { setExercise(e.target.value); setOutcome(""); setDrafts({}); setRangeError(""); }}>
        {ranking.exercises.map((item: any) => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select></label>}
      <label>Driver outcome<select value={ranking.outcome.key} onChange={(e) => setOutcome(e.target.value)}>{ranking.outcomes.map((item: any) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      <div className={styles.current}><span>Committed {ranking.outcome.label.toLowerCase()}</span><strong>{value(ranking.current.value)}</strong></div>
    </div>
    {ranking.current.reason && <p className={styles.notice}>{ranking.current.reason} Endpoint changes cannot be ranked without an available committed outcome.</p>}
    <div className={styles.legend}><span><i className={styles.lowDot} />Low assumption</span><span><i className={styles.highDot} />High assumption</span><span>Bars show outcome change, not likelihood.</span></div>
    <ol className={styles.chart}>
      {ranking.drivers.map((driver: any) => <li key={driver.key} className={styles.driver}>
        <div className={styles.driverLabel}><strong>{driver.label}</strong><span>{assumption(driver.low, driver.unit)} → {assumption(driver.high, driver.unit)} · current {assumption(driver.current, driver.unit)}</span><span>{driver.basis}</span></div>
        <div className={styles.track} aria-hidden="true"><span className={styles.zero} />
          {driver.magnitude !== null && [driver.lower, driver.upper].map((endpoint: any, i) => <span key={i} className={i ? styles.highBar : styles.lowBar} style={{ left: `${Math.min(50, position(endpoint.delta))}%`, width: `${Math.max(0.4, Math.abs(position(endpoint.delta) - 50))}%` }} />)}
        </div>
        <div className={styles.driverValues}><span className={styles.lowValue}>Low: {delta(driver.lower.delta)}</span><span className={styles.highValue}>High: {delta(driver.upper.delta)}</span></div>
        {driver.reason && <p className={styles.unavailable}>{driver.reason} This driver is not ranked.</p>}
      </li>)}
    </ol>
    <details className={styles.details}><summary>Adjust tested ranges</summary><p>Enter low and high assumptions that span each committed value. Bounds follow the model. Updates change this comparison only; they do not change your case.</p>
      <form onSubmit={updateRanges}>
        <div className={styles.rangeGrid}>{ranking.drivers.map((driver: any) => <fieldset key={driver.key}><legend>{driver.label} ({driver.unit})</legend><span>{driver.basis}. Current {assumption(driver.current, driver.unit)} · bounds {driver.min} to {driver.max}</span>
          <div>{(["low", "high"] as const).map((side) => <label key={side}>{side === "low" ? "Low" : "High"}<input type="text" inputMode="decimal" aria-label={`${driver.label} ${side} assumption`} value={drafts[driver.key]?.[side] ?? String(driver[side])} onChange={(e) => setDrafts((current) => ({ ...current, [driver.key]: { ...current[driver.key], [side]: e.target.value } }))} /></label>)}</div>
        </fieldset>)}</div>
        {rangeError && <p className={styles.notice} role="alert">{rangeError}</p>}
        <div className={styles.actions}><button type="submit">Update tested ranges</button><button type="button" onClick={() => { setRanges({}); setDrafts({}); setRangeError(""); }}>Reset ranges</button>{Object.keys(drafts).length > 0 && <span>Range edits have not been applied.</span>}</div>
      </form>
    </details>
    <details className={styles.details}><summary>Exact outcomes &amp; source calculations</summary><div className={styles.tableScroll}><table><caption>{ranking.outcome.label}. Changes are relative to the committed case.</caption><thead><tr><th scope="col">Driver</th><th scope="col">Assumption</th><th scope="col">Outcome</th><th scope="col">Change</th></tr></thead><tbody>
      {ranking.drivers.flatMap((driver: any) => [driver.lower, driver.upper].map((endpoint: any, i) => <tr key={`${driver.key}-${i}`}><th scope="row">{driver.label} · {i ? "high" : "low"}</th><td>{assumption(endpoint.assumption, driver.unit)}</td><td>{endpoint.selection ? <button type="button" onClick={() => onInspect(endpoint.selection)} aria-label={`Inspect ${driver.label.toLowerCase()} ${i ? "high" : "low"} driver outcome`}>{value(endpoint.value)}<ArrowUpRight size={12} aria-hidden="true" /></button> : endpoint.reason}</td><td>{delta(endpoint.delta)}</td></tr>))}
    </tbody></table></div></details>
    <p className={styles.method}>{ranking.note}</p>
  </section>;
}
