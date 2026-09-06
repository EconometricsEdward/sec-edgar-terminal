"use client";
import { ArrowUpRight, Search } from "lucide-react";
import {
  metricComparison,
  historicGrowth,
} from "../../../utils/compareResearch.js";
import {
  displayValue,
  displayDelta,
  COLORS,
  type CompareSettings,
  type CompareEvidence,
} from "../compareTypes";
import styles from "../compare.module.css";

export default function CompareTable({
  entries,
  metrics,
  settings,
  inspect,
}: {
  entries: any[];
  metrics: any[];
  settings: CompareSettings;
  inspect: (e: CompareEvidence) => void;
}) {
  return (
    <section className={styles.panel} aria-labelledby="comparison-table-title">
      <div className={styles.sectionHead}>
        <div>
          <span className={styles.eyebrow}>01 / Financial comparison</span>
          <h2 id="comparison-table-title">The numbers, in context.</h2>
          <p>
            Choose a value to inspect its evidence. Differences are against{" "}
            {settings.benchmark === "median"
              ? "the selected-issuer median"
              : settings.benchmark}
            .
          </p>
        </div>
        <span className={styles.badge}>USD · SEC XBRL</span>
      </div>
      <div
        className={styles.tableScroll}
        tabIndex={0}
        role="region"
        aria-label="Financial comparison table, scroll horizontally for all peers"
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Metric / coverage</th>
              {entries.map((c, i) => (
                <th key={c.ticker} scope="col">
                  <span
                    className={styles.dot}
                    style={{ background: c.color || COLORS[i % COLORS.length] }}
                  />
                  {c.ticker}
                  <small>{c.period?.end || "No matching period"}</small>
                  <small>
                    {c.period
                      ? `${c.period.fp} · ${c.period.kind}`
                      : c.error
                        ? "Fetch failed"
                        : c.loading
                          ? "Loading"
                          : "Unavailable"}
                  </small>
                </th>
              ))}
              <th scope="col">
                Peer median<small>Includes selected issuers</small>
              </th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => {
              const comparison = metricComparison(
                entries,
                metric.key,
                settings.benchmark,
              );
              return (
                <tr key={metric.key}>
                  <th scope="row">
                    <span>{metric.label}</span>
                    <small>
                      {metric.category} · {comparison.count}/{comparison.total}{" "}
                      values
                    </small>
                    {comparison.reason && (
                      <small className={styles.warning}>
                        {comparison.reason}
                      </small>
                    )}
                  </th>
                  {comparison.cells.map((cell) => (
                    <td key={cell.ticker}>
                      <button
                        className={styles.valueButton}
                        onClick={() => inspect({ cell, metric })}
                        aria-label={`Inspect ${cell.ticker} ${metric.label}`}
                      >
                        <strong>
                          {displayValue(cell.point?.value, metric.format)}
                        </strong>
                        <Search size={12} />
                      </button>
                      <small>
                        {cell.point?.value != null
                          ? cell.point.classification
                          : cell.status === "reviewed"
                            ? "Input unavailable"
                            : cell.status}
                      </small>
                      {cell.delta != null && (
                        <small className={styles.difference}>
                          {displayDelta(cell.delta, metric.format)} vs{" "}
                          {settings.benchmark === "median"
                            ? "median"
                            : settings.benchmark}
                        </small>
                      )}
                      {cell.rank != null && (
                        <small>
                          Numeric rank {cell.rank}/{comparison.count}
                        </small>
                      )}
                    </td>
                  ))}
                  <td>
                    <strong>
                      {displayValue(comparison.peerMedian, metric.format)}
                    </strong>
                    <small>
                      {comparison.peerMedian == null
                        ? "Comparison paused"
                        : `${comparison.count} comparable issuers`}
                    </small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={styles.panelFoot}>
        Ranks show largest to smallest values, including ties. They do not
        identify the best company or imply a risk score. Benchmarks require two
        issuers, reporting ends within 45 days, and duration differences within
        14 days.
      </div>
    </section>
  );
}

export function GrowthTable({
  entries,
  metric,
  inspect,
}: {
  entries: any[];
  metric: any;
  inspect: (e: CompareEvidence) => void;
}) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption>Growth and changes · {metric.label}</caption>
        <thead>
          <tr>
            <th>Company</th>
            <th>Current period</th>
            <th>Year-over-year change</th>
            <th>3-year CAGR</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {entries
            .filter((c) => c.data)
            .map((c) => {
              const growth = historicGrowth(c.data, metric.key, c.index);
              const point = c.data.metrics[metric.key]?.[c.index];
              const cell = {
                ticker: c.ticker,
                cik: c.data.cik,
                name: c.data.name,
                period: c.period,
                point,
              };
              return (
                <tr key={c.ticker}>
                  <th scope="row">{c.ticker}</th>
                  <td>
                    {displayValue(point?.value, metric.format)}
                    <small>{c.period?.end || "Unavailable"}</small>
                  </td>
                  <td>
                    {growth.yoy.value == null
                      ? "—"
                      : `${growth.yoy.value > 0 ? "+" : ""}${growth.yoy.value.toFixed(2)} ${growth.yoy.unit}`}
                    <small>
                      {growth.prior
                        ? `Compared with ${growth.prior.period.end}`
                        : "No comparable year-earlier observation"}
                    </small>
                    {growth.yoy.reason && <small>{growth.yoy.reason}</small>}
                  </td>
                  <td>
                    {growth.cagr == null ? "—" : `${growth.cagr.toFixed(2)}%`}
                    <small>
                      {metric.format !== "currency"
                        ? "CAGR does not apply to ratios"
                        : growth.cagr == null
                          ? "Requires positive values about three years apart"
                          : `From ${growth.start.period.end}`}
                    </small>
                  </td>
                  <td>
                    <button
                      disabled={!point}
                      onClick={() => inspect({ cell, metric })}
                    >
                      Current <ArrowUpRight size={12} />
                    </button>
                    {growth.prior && (
                      <button
                        onClick={() =>
                          inspect({
                            cell: {
                              ...cell,
                              point: growth.prior,
                              period: growth.prior.period,
                            },
                            metric,
                          })
                        }
                      >
                        Year-earlier input
                      </button>
                    )}
                    {growth.start && growth.cagr != null && (
                      <button
                        onClick={() =>
                          inspect({
                            cell: {
                              ...cell,
                              point: growth.start,
                              period: growth.start.period,
                            },
                            metric,
                          })
                        }
                      >
                        CAGR starting input
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
