"use client";

import { memo, useMemo } from "react";
import { ArrowUpRight } from "lucide-react";
import { researchMetricComparison } from "../../../utils/compareBenchmarks.js";
import { comparisonOverviewScale } from "../../../utils/compareOverview.js";
import { COLORS, displayDelta, displayValue, type CompareEvidence, type CompareSettings } from "../compareTypes";
import CompareTable from "./CompareTable";
import styles from "./CompareOverview.module.css";

function CompareOverview({ entries, metrics, settings, inspect, update }: {
  entries: any[];
  metrics: any[];
  settings: CompareSettings;
  inspect: (evidence: CompareEvidence) => void;
  update: (patch: Partial<CompareSettings>) => void;
}) {
  const metric = metrics.find((item) => item.key === settings.metric) || metrics[0];
  const comparison = useMemo(
    () => metric ? researchMetricComparison(entries, metric.key, settings) : null,
    [entries, metric, settings],
  );
  const scale = useMemo(() => comparison ? comparisonOverviewScale(comparison) : null, [comparison]);
  if (!metric || !comparison || !scale) return null;
  const benchmarkLabel = settings.benchmark === "median" ? "Peer median"
    : settings.benchmark === "peers" ? `Median excluding ${comparison.focusTicker}` : settings.benchmark;
  const needsReview = comparison.definitionNote || comparison.reason || comparison.excludedCount;

  return <div className={styles.overview}>
    <section className={styles.spotlight} aria-labelledby="compare-glance-title">
      <div className={styles.spotlightHead}>
        <div>
          <span className={styles.kicker}>At a glance</span>
          <h2 id="compare-glance-title">{metric.label}</h2>
          <p>{metric.format === "currency" ? "Reported in USD" : "Reported and calculated from SEC filings"} · Choose a value to see its source.</p>
        </div>
        <label className={styles.metricChooser}>
          Compare a metric
          <select value={metric.key} onChange={(event) => update({ metric: event.target.value })}>
            {metrics.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <div className={styles.plot} role="group" aria-label={`${metric.label} by company`}>
        {comparison.cells.map((cell, index) => {
          const entry = entries.find((item) => item.ticker === cell.ticker);
          const color = entry?.color || COLORS[index % COLORS.length];
          const plotted = scale.plottedTickers.has(cell.ticker);
          const pointPosition = plotted ? scale.position(cell.point.value) : scale.zero;
          return <div className={styles.plotRow} key={cell.ticker}>
            <div className={styles.companyLabel}>
              <span><i style={{ background: color }} aria-hidden="true" />{cell.ticker}</span>
              <small>{cell.period?.end || (cell.status === "loading" ? "Loading…" : "No matching period")}</small>
            </div>
            <div className={styles.track} aria-hidden="true">
              <span className={styles.baseline} style={{ left: `${scale.zero}%` }} />
              {scale.guide != null && <span className={styles.guide} style={{ left: `${scale.position(scale.guide)}%` }} />}
              {plotted ? <>
                <span className={styles.bar} style={{ left: `${Math.min(scale.zero, pointPosition)}%`, width: `${Math.abs(pointPosition - scale.zero)}%`, background: color }} />
                <span className={styles.barEnd} style={{ left: `${pointPosition}%`, background: color }} />
              </> : <span className={styles.plotUnavailable}>{Number.isFinite(cell.point?.value) ? "Review inputs" : cell.status === "loading" ? "Loading" : "Unavailable"}</span>}
            </div>
            <div className={styles.plotValue}>
              <button type="button" className={styles.inspectValue} onClick={() => inspect({ cell, metric })} aria-label={`Inspect ${cell.ticker} ${metric.label}: ${displayValue(cell.point?.value, metric.format)} overview`}>
                <strong>{displayValue(cell.point?.value, metric.format)}</strong><ArrowUpRight size={13} aria-hidden="true" />
              </button>
              <small>{cell.delta != null ? `${displayDelta(cell.delta, metric.format)} vs ${settings.benchmark === "median" ? "median" : settings.benchmark === "peers" ? "other peers" : settings.benchmark}` : Number.isFinite(cell.point?.value) && !cell.quality?.valid ? "Excluded from benchmark" : ""}</small>
            </div>
          </div>;
        })}
      </div>
      <div className={styles.plotFooter}>
        <span>{scale.guide != null ? <><i className={styles.guideKey} aria-hidden="true" />{benchmarkLabel} <strong>{displayValue(scale.guide, metric.format)}</strong></> : "Benchmark unavailable for this selection"}</span>
        <details className={needsReview ? styles.review : styles.notes}>
          <summary>{comparison.reason ? "Check reporting periods / inputs" : comparison.definitionNote ? "Source definitions differ" : comparison.excludedCount ? "Some inputs need review" : "Benchmark details"}</summary>
          <div>
            {comparison.reason && <p>{comparison.reason}</p>}
            {comparison.definitionNote && <p>{comparison.definitionNote}</p>}
            <p>{scale.guide != null ? `Benchmark sample: ${comparison.benchmarkMembers.join(", ")}.` : "Original reported observations remain available; no benchmark guide is drawn."}</p>
            <p>One observation per SEC issuer. Benchmarks require compatible reporting dates and inputs. Higher values are not necessarily better.</p>
            {comparison.cells.filter((cell) => !cell.quality?.valid).map((cell) => <p key={cell.ticker}><strong>{cell.ticker}:</strong> {cell.quality?.reason || cell.status}</p>)}
          </div>
        </details>
      </div>
    </section>
    <CompareTable entries={entries} metrics={metrics} settings={settings} inspect={inspect} />
  </div>;
}

export default memo(CompareOverview);
