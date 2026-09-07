"use client";
import { Search } from "lucide-react";
import {
  commonSizeCell,
  commonSizeDenominator,
  commonSizeMetrics,
} from "../../../utils/compareCommonSize.js";
import { METRIC_BY_KEY } from "../../../utils/compareResearch.js";
import {
  displayValue,
  type CompareSettings,
  type CompareEvidence,
} from "../compareTypes";
import shared from "../compare.module.css";
import styles from "./CompareCommonSize.module.css";

export default function CompareCommonSize({
  entries,
  settings,
  update,
  inspect,
}: {
  entries: any[];
  metrics?: any[];
  settings: CompareSettings;
  update: (change: Partial<CompareSettings>) => void;
  inspect: (evidence: CompareEvidence) => void;
}) {
  const mode = settings.commonSize === "income" ? "income" : "balance";
  const metrics = commonSizeMetrics(entries, mode);
  const denominatorTypes = [
    ...new Set(
      entries
        .map((entry) => commonSizeDenominator(entry, mode).key)
        .filter(Boolean),
    ),
  ];
  const cellEvidence = (cell: any, point: any, metric: any) =>
    inspect({ cell: { ...cell, point }, metric });
  return (
    <section
      className={shared.panel}
      aria-labelledby="compare-common-size-title"
    >
      <div className={shared.sectionHead}>
        <div>
          <span className={shared.eyebrow}>
            Statement structure / size-adjusted
          </span>
          <h2 id="compare-common-size-title">
            Compare how the business is built.
          </h2>
          <p>
            Put selected statement lines on a common scale while keeping every
            numerator and denominator inspectable.
          </p>
        </div>
        <label className={styles.mode}>
          Common-size statement
          <select
            value={mode}
            onChange={(event) => update({ commonSize: event.target.value })}
          >
            <option value="balance">Balance sheet · % of assets</option>
            <option value="income">
              Income statement · % of revenue / bank income
            </option>
          </select>
        </label>
      </div>
      <p className={styles.description}>
        {mode === "balance"
          ? "Each line is divided by that issuer’s total assets at the same endpoint. Deposits and net loans apply to banking issuers; current-ratio and cash-flow measures are excluded."
          : "Corporate lines use revenue. Banking lines use net interest income before provision plus noninterest income for the same duration. A compatible total-income denominator is not currently available for insurance issuers."}
      </p>
      {denominatorTypes.length > 1 && (
        <p className={shared.notice}>
          This selection uses different income definitions. Percentages remain
          visible with their denominator labels; they are not pooled into a peer
          median.
        </p>
      )}
      <div
        className={shared.tableScroll}
        role="region"
        aria-label="Common-size statement, scroll horizontally for all peers"
        tabIndex={0}
      >
        <table className={shared.table}>
          <thead>
            <tr>
              <th scope="col">Statement line</th>
              {entries.map((entry) => {
                const denominator = commonSizeDenominator(entry, mode);
                const point =
                  entry.index >= 0 && denominator.key
                    ? entry.data?.metrics?.[denominator.key]?.[entry.index]
                    : null;
                return (
                  <th key={entry.ticker} scope="col">
                    {entry.ticker}
                    <small>{entry.period?.end || "Period unavailable"}</small>
                    <small>Denominator: {denominator.label}</small>
                    {denominator.key && (
                      <button
                        className={shared.valueButton}
                        onClick={() =>
                          inspect({
                            cell: {
                              ticker: entry.ticker,
                              name: entry.data?.name,
                              cik: entry.data?.cik,
                              period: entry.period,
                              point,
                            },
                            metric: METRIC_BY_KEY[denominator.key],
                          })
                        }
                        aria-label={`Inspect ${entry.ticker} common-size denominator`}
                      >
                        <strong>{displayValue(point?.value)}</strong>
                        <Search size={12} />
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => (
              <tr key={metric.key}>
                <th scope="row">
                  {metric.label}
                  <small>
                    {mode === "balance"
                      ? "% of total assets"
                      : "% of the issuer’s stated income denominator"}
                  </small>
                </th>
                {entries.map((entry) => {
                  const cell = commonSizeCell(entry, metric.key, mode);
                  return (
                    <td key={entry.ticker}>
                      <button
                        className={shared.valueButton}
                        aria-label={`Inspect ${entry.ticker} ${metric.label} common-size calculation`}
                        onClick={() =>
                          cellEvidence(cell, cell.calculatedPoint, {
                            ...metric,
                            key: `${metric.key}CommonSize${mode}`,
                            label: `${metric.label} / ${cell.denominator.label}`,
                            format: "percent",
                          })
                        }
                      >
                        <strong>{displayValue(cell.value, "percent")}</strong>
                        <Search size={12} />
                      </button>
                      {cell.value != null && (
                        <div className={styles.track} aria-hidden="true">
                          <span
                            style={{
                              width: `${Math.min(Math.abs(cell.value), 100)}%`,
                            }}
                            className={cell.value < 0 ? styles.negative : ""}
                          />
                        </div>
                      )}
                      <button
                        className={styles.raw}
                        aria-label={`Inspect ${entry.ticker} raw ${metric.label}`}
                        onClick={() => cellEvidence(cell, cell.point, metric)}
                      >
                        Raw: {displayValue(cell.point?.value)}{" "}
                        <Search size={10} />
                      </button>
                      {cell.reason && (
                        <small className={shared.warning}>{cell.reason}</small>
                      )}
                      {cell.issues.length > 0 && !cell.reason && (
                        <small>
                          Source presentation needs review; inspect the
                          underlying observations.
                        </small>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className={styles.definitions}>
        <summary>Denominator definitions and reported concepts</summary>
        <div className={styles.definitionGrid}>
          {entries.map((entry) => {
            const denominator = commonSizeDenominator(entry, mode);
            const point =
              entry.index >= 0 && denominator.key
                ? entry.data?.metrics?.[denominator.key]?.[entry.index]
                : null;
            const concepts = [
              ...new Set(
                (point?.sources || []).map(
                  (source: any) =>
                    `${source.taxonomy || "taxonomy unavailable"}:${source.tag || "concept unavailable"}`,
                ),
              ),
            ];
            return (
              <div key={entry.ticker}>
                <h3>
                  {entry.ticker} · {denominator.label}
                </h3>
                <p>{denominator.definition}</p>
                <small>
                  {concepts.join(" · ") ||
                    "No reported source concepts available for this denominator."}
                </small>
              </div>
            );
          })}
        </div>
      </details>
      <div className={shared.panelFoot}>
        These are selected statement lines, not a complete accounting statement.
        Rows can overlap and do not add to 100%. Bars show magnitude, cap
        visually at 100%, and do not indicate better or worse performance.
        Negative numerators remain negative; zero or negative denominators are
        withheld. Review actual dates and source definitions before drawing
        comparisons.
      </div>
    </section>
  );
}
