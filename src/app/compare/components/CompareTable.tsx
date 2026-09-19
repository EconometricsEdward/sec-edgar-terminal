"use client";
import { memo, useMemo } from "react";
import { researchMetricComparison } from "../../../utils/compareBenchmarks.js";
import { ArrowUpRight, Search } from "lucide-react";
import { historicGrowth } from "../../../utils/compareResearch.js";
import {
  displayValue,
  COLORS,
  type CompareSettings,
  type CompareEvidence,
} from "../compareTypes";
import styles from "../compare.module.css";
import overview from "./CompareOverview.module.css";

function CompareTable({ entries, metrics, settings, inspect }: {
  entries: any[];
  metrics: any[];
  settings: CompareSettings;
  inspect: (e: CompareEvidence) => void;
}) {
  const comparisons = useMemo(() => metrics.map((metric) => ({
    metric, comparison: researchMetricComparison(entries, metric.key, settings),
  })), [entries, metrics, settings]);
  return (
    <section className={overview.tableSection} aria-labelledby="comparison-table-title">
      <div className={overview.tableHead}>
        <h2 id="comparison-table-title">Side by side</h2>
        <p>SEC financials · Select any value to inspect its source.</p>
      </div>
      <div className={overview.tableScroll} tabIndex={0} role="region" aria-label="Financial comparison table, scroll horizontally for all peers">
        <table className={overview.table}>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {entries.map((company, index) => (
                <th key={company.ticker} scope="col">
                  <span className={overview.companyDot} style={{ background: company.color || COLORS[index % COLORS.length] }} aria-hidden="true" />
                  {company.ticker}
                  <small>{company.period?.end || (company.error ? "Fetch failed" : company.loading ? "Loading…" : "No matching period")}</small>
                </th>
              ))}
              <th scope="col">
                Peer median
                <small>{settings.benchmark === "peers" ? `Excludes ${settings.focus || entries[0]?.ticker || "focus"}` : "Selected issuers"}</small>
              </th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map(({ metric, comparison }) => {
              const review = comparison.definitionNote || comparison.reason || comparison.excludedCount;
              return <tr key={metric.key}>
                <th scope="row">
                  {metric.label}
                  <details className={overview.rowNotes} data-review={Boolean(review)}>
                    <summary aria-label={`${metric.label}: coverage and comparability`}>
                      {comparison.count}/{comparison.total} values{comparison.definitionNote ? " · Definitions differ" : comparison.reason ? " · Benchmark paused" : comparison.excludedCount ? " · Review inputs" : " · Details"}
                    </summary>
                    <div>
                      {comparison.definitionNote && <p>{comparison.definitionNote}</p>}
                      {comparison.reason && <p>{comparison.reason}</p>}
                      <p>{comparison.peerMedian == null ? "No median is shown for this selection." : `Median sample (${comparison.benchmarkCount}): ${comparison.benchmarkMembers.join(", ")}.`}</p>
                      {comparison.cells.filter((cell) => !cell.quality?.valid).map((cell) => <p key={cell.ticker}><strong>{cell.ticker}:</strong> {cell.quality?.reason || cell.status}</p>)}
                    </div>
                  </details>
                </th>
                {entries.map((entry) => {
                  const cell = comparison.cells.find((item) => item.ticker === entry.ticker);
                  if (!cell) return <td key={entry.ticker}><span aria-label="Same SEC issuer, counted once">—</span><small>Same issuer</small></td>;
                  return <td key={cell.ticker}>
                    <button type="button" className={overview.inspectValue} onClick={() => inspect({ cell, metric })} aria-label={`Inspect ${cell.ticker} ${metric.label}: ${displayValue(cell.point?.value, metric.format)}`}>
                      <strong>{displayValue(cell.point?.value, metric.format)}</strong><Search size={11} aria-hidden="true" />
                    </button>
                    {cell.point?.value == null ? <small>{cell.status === "reviewed" ? "Unavailable" : cell.status}</small> : !cell.quality?.valid && <small className={overview.qualityMark}>Review inputs</small>}
                  </td>;
                })}
                <td>
                  <strong>{displayValue(comparison.peerMedian, metric.format)}</strong>
                  <small>{comparison.peerMedian == null ? "Unavailable" : `${comparison.benchmarkCount} issuers`}</small>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      <p className={overview.tableFoot}>Missing inputs stay unavailable. Open a metric’s details for definitions and the companies included in its median.</p>
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

export default memo(CompareTable);
