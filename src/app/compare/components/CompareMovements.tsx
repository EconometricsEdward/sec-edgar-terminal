"use client";
import { ArrowRight, Search } from "lucide-react";
import {
  movementBuckets,
  movementComparison,
} from "../../../utils/compareMovements.js";
import {
  displayValue,
  displayDelta,
  type CompareSettings,
  type CompareEvidence,
} from "../compareTypes";
import shared from "../compare.module.css";
import styles from "./CompareMovements.module.css";

export default function CompareMovements({
  entries,
  metrics,
  settings,
  update,
  inspect,
}: {
  companies?: any[];
  entries: any[];
  metrics: any[];
  settings: CompareSettings;
  update: (change: Partial<CompareSettings>) => void;
  inspect: (evidence: CompareEvidence) => void;
}) {
  const metric =
    metrics.find((item) => item.key === settings.movementMetric) || metrics[0];
  if (!metric)
    return (
      <section className={shared.panel}>
        <h2>What changed?</h2>
        <p>Select at least one metric to compare reporting periods.</p>
      </section>
    );
  const comparison = movementComparison(entries, metric.key, settings);
  const buckets = movementBuckets(entries, settings.basis);
  const baselineLabel =
    settings.basis === "quarter"
      ? "Previous standalone quarter"
      : "Same reporting season, prior year";
  const inspectPoint = (cell: any, side: "current" | "prior") =>
    inspect({
      cell: {
        ticker: cell.ticker,
        cik: cell.cik,
        name: cell.name,
        period: cell[`${side}Period`],
        point: cell[side],
        status: cell.reason || "reviewed",
      },
      metric,
    });
  return (
    <section className={shared.panel} aria-labelledby="compare-movements-title">
      <div className={shared.sectionHead}>
        <div>
          <span className={shared.eyebrow}>
            Change analysis / matched observations
          </span>
          <h2 id="compare-movements-title">What changed—and for whom?</h2>
          <p>
            Compare two reported periods with both inputs visible. Peer
            summaries keep the same companies on each side.
          </p>
        </div>
      </div>
      <div className={styles.controls}>
        <label>
          Movement metric
          <select
            value={metric.key}
            onChange={(event) => update({ movementMetric: event.target.value })}
          >
            {metrics.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Earlier reporting bucket
          <select
            value={settings.movementFrom || "previous"}
            onChange={(event) => update({ movementFrom: event.target.value })}
          >
            <option value="previous">{baselineLabel}</option>
            {!buckets.includes(settings.movementFrom) &&
              settings.movementFrom &&
              settings.movementFrom !== "previous" && (
                <option value={settings.movementFrom}>
                  {settings.movementFrom} · unavailable
                </option>
              )}
            {buckets.map((bucket) => (
              <option key={bucket} value={bucket}>
                {bucket}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.current}>
          <span>Current period</span>
          <strong>
            {settings.period === "latest"
              ? settings.alignment === "common"
                ? "Latest shared reporting bucket"
                : "Each issuer’s latest report"
              : settings.period}
          </strong>
          <small>Uses the period and filing cutoff selected above.</small>
        </div>
      </div>
      <p className={styles.explanation}>
        {settings.basis === "quarter"
          ? "Automatic comparisons use the previous standalone quarter. Select an earlier bucket for year-over-year or longer comparisons."
          : "Automatic comparisons use the same reporting season one year earlier. This keeps cumulative and trailing-year windows comparable."}{" "}
        Changes require matching source definitions and reporting durations.
        Missing periods remain gaps.
      </p>
      <div className={styles.summary} aria-label="Paired company summary">
        <div>
          <small>Paired issuer sample</small>
          <strong>
            {comparison.pairedCount} / {comparison.total}
          </strong>
          <span>{comparison.members.join(", ") || "No complete pairs"}</span>
        </div>
        <div>
          <small>Prior-period median</small>
          <strong>{displayValue(comparison.priorMedian, metric.format)}</strong>
          <span>Same paired issuers</span>
        </div>
        <div>
          <small>Current-period median</small>
          <strong>
            {displayValue(comparison.currentMedian, metric.format)}
          </strong>
          <span>Same paired issuers</span>
        </div>
        <div>
          <small>Median issuer change</small>
          <strong>
            {displayDelta(comparison.medianChange, metric.format)}
          </strong>
          <span>
            {comparison.medianRate != null
              ? `${displayDelta(comparison.medianRate, "percent").replace(" pp", "%")} median percentage change`
              : "Median of individual changes"}
          </span>
        </div>
      </div>
      {(comparison.reason || comparison.rateReason) && (
        <p className={shared.notice} role="status">
          {comparison.reason || comparison.rateReason}
        </p>
      )}
      <div
        className={shared.tableScroll}
        role="region"
        aria-label="Company reporting-period changes, scroll horizontally for all columns"
        tabIndex={0}
      >
        <table className={shared.table}>
          <caption className={styles.caption}>
            {metric.label} · current selection versus earlier reported period
          </caption>
          <thead>
            <tr>
              <th scope="col">Issuer / coverage</th>
              <th scope="col">Prior observation</th>
              <th scope="col">Current observation</th>
              <th scope="col">Absolute change</th>
              <th scope="col">
                {metric.format === "currency"
                  ? "Percentage change"
                  : "Change interpretation"}
              </th>
            </tr>
          </thead>
          <tbody>
            {comparison.cells.map((cell) => (
              <tr key={cell.ticker}>
                <th scope="row">
                  {cell.ticker}
                  <small>{cell.name}</small>
                  <small>
                    {cell.valid
                      ? "Complete, compatible pair"
                      : "Comparison unavailable"}
                  </small>
                </th>
                {(["prior", "current"] as const).map((side) => (
                  <td key={side}>
                    <button
                      className={shared.valueButton}
                      onClick={() => inspectPoint(cell, side)}
                      aria-label={`Inspect ${cell.ticker} ${side} ${metric.label}`}
                    >
                      <strong>
                        {displayValue(cell[side]?.value, metric.format)}
                      </strong>
                      <Search size={12} />
                    </button>
                    <small>
                      {cell[`${side}Period`]?.start || "Balance / period"}{" "}
                      <ArrowRight size={10} aria-hidden="true" />{" "}
                      {cell[`${side}Period`]?.end || "Unavailable"}
                    </small>
                    {!cell[`${side}Quality`].valid && (
                      <small className={shared.warning}>
                        {cell[`${side}Quality`].reason}
                      </small>
                    )}
                  </td>
                ))}
                <td>
                  <strong>{displayDelta(cell.absolute, metric.format)}</strong>
                  {cell.reason && (
                    <small className={shared.warning}>{cell.reason}</small>
                  )}
                </td>
                <td>
                  {metric.format === "currency" ? (
                    <>
                      <strong>
                        {cell.rate == null
                          ? "—"
                          : `${cell.rate > 0 ? "+" : ""}${cell.rate.toFixed(2)}%`}
                      </strong>
                      {cell.rateReason && <small>{cell.rateReason}</small>}
                    </>
                  ) : (
                    <small>
                      {metric.format === "percent"
                        ? "Difference in percentage points; not percentage growth."
                        : "Difference in ratio multiples."}
                    </small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={shared.panelFoot}>
        The median issuer change is the median of paired differences, not the
        difference of two medians. Peer summaries require at least two valid
        pairs, reporting endpoints within 45 days on both sides, and flow
        durations within 14 days. Changes use the selected filing cutoff and can
        reflect revised historical presentations.
      </div>
    </section>
  );
}
