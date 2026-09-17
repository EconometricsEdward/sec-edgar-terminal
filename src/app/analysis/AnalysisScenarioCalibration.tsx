"use client";

import { ArrowUpRight } from "lucide-react";
import styles from "./AnalysisScenarioCalibration.module.css";

const number = (value: number, unit: string) =>
  `${value > 0 ? "+" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}${unit === "pp" ? " pp" : "%"}`;

export default function AnalysisScenarioCalibration({ metric, assumption, onInspect }: any) {
  if (!metric) return null;
  const parsed = typeof assumption === "string" && !assumption.trim() ? NaN : Number(assumption);
  const outside = metric.count > 0 && Number.isFinite(parsed) && (parsed < metric.min || parsed > metric.max);
  const span = metric.max - metric.min;
  const marker = Number.isFinite(parsed) && metric.count
    ? span > 0 ? Math.max(0, Math.min(100, ((parsed - metric.min) / span) * 100)) : 50
    : null;
  return (
    <div className={styles.calibration}>
      <div className={styles.heading}><strong>Reported history</strong><span>{metric.count} comparable changes</span></div>
      {metric.count ? <>
        <div className={styles.scale} aria-hidden="true">
          <span className={styles.median} style={{ left: `${span > 0 ? ((metric.median - metric.min) / span) * 100 : 50}%` }} />
          {marker !== null && <span className={styles.assumption} data-outside={outside || undefined} style={{ left: `${marker}%` }} />}
        </div>
        <div className={styles.numbers}><span>{number(metric.min, metric.unit)}</span><span>Median <b>{number(metric.median, metric.unit)}</b></span><span>{number(metric.max, metric.unit)}</span></div>
        <p className={styles.context}>{Number.isFinite(parsed) ? `Your assumption: ${number(parsed, metric.unit)} · ${outside ? "outside" : "within"} this observed range.` : "Enter an assumption to locate it in the observed range."} Historical ranges are not limits or forecasts.</p>
      </> : <p className={styles.context}>{metric.reason}</p>}
      <details className={styles.details}>
        <summary>{metric.label} · dates &amp; sources{metric.omitted > 0 ? ` · ${metric.omitted} omitted` : ""}</summary>
        <p>Prior annual or same-season observations only. Revenue uses percentage change; margin uses percentage-point change. Restatements follow the selected filing cutoff.</p>
        {metric.observations.map((row: any) => <div className={styles.observation} key={row.period.end}>
          <span>{row.before?.end || "Missing prior period"} → {row.period.end}</span>
          {Number.isFinite(row.value) && !row.reason ? <button type="button" onClick={() => onInspect(row.selection)} aria-label={`Inspect ${metric.label.toLowerCase()} ${row.period.end}`}>
            {number(row.value, metric.unit)}<ArrowUpRight size={12} aria-hidden="true" />
          </button> : <small>{row.reason || "Unavailable"}</small>}
        </div>)}
        {metric.boundaryReason && <p>{metric.boundaryReason}</p>}
      </details>
    </div>
  );
}
