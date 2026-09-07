"use client";
import { researchMetricComparison } from "../../../utils/compareBenchmarks.js";
import { useMemo, useState } from "react";
import { Download, Search } from "lucide-react";
import {
  displayValue,
  downloadFile,
  type CompareSettings,
  type CompareEvidence,
} from "../compareTypes";
import styles from "./CompareQualityDesk.module.css";

export default function CompareQualityDesk({
  entries,
  metrics,
  settings,
  inspect,
}: {
  entries: any[];
  metrics: any[];
  settings: CompareSettings;
  inspect: (evidence: CompareEvidence) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [company, setCompany] = useState("all");
  const rows = useMemo(
    () =>
      metrics.map((metric) => ({
        ...researchMetricComparison(entries, metric.key, settings),
        metric,
      })),
    [entries, metrics, settings],
  );
  const allCells = rows.flatMap((row) => row.cells);
  const usable = allCells.filter((cell) => cell.quality.valid).length;
  const withValues = allCells.filter((cell) =>
    Number.isFinite(cell.point?.value),
  ).length;
  const visibleRows = rows
    .map((row) => ({
      ...row,
      cells: row.cells.filter(
        (cell) =>
          (company === "all" || cell.ticker === company) &&
          (filter === "all" ||
            (filter === "missing"
              ? !Number.isFinite(cell.point?.value)
              : filter === "usable"
                ? cell.quality.valid
                : !cell.quality.valid ||
                  cell.quality.issues.length > 0 ||
                  row.definitionsDiffer ||
                  row.reason)),
      ),
    }))
    .filter((row) => row.cells.length > 0);
  const exportCoverage = () => {
    const cell = (value: unknown) => {
      const text = String(value ?? "");
      return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
    };
    const rows = [
      [
        "metric",
        "ticker",
        "value",
        "unit",
        "status",
        "eligible",
        "reason",
        "period_start",
        "period_end",
        "duration_days",
        "source_concepts",
        "comparison_note",
        "settings",
      ],
      ...visibleRows.flatMap((row) =>
        row.cells.map((item) => [
          row.metric.label,
          item.ticker,
          item.point?.value,
          row.metric.format,
          item.status,
          item.quality.valid,
          item.quality.reason || item.quality.issues.join(" "),
          item.period?.start,
          item.period?.end,
          item.quality.durationDays,
          item.quality.concepts.join(" | "),
          row.reason || row.definitionNote || "",
          JSON.stringify(settings),
        ]),
      ),
    ];
    downloadFile(
      "peer-comparison-coverage.csv",
      "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n"),
      "text/csv;charset=utf-8",
    );
  };
  return (
    <section className={styles.desk} aria-labelledby="compare-quality-title">
      <div className={styles.head}>
        <div>
          <span className={styles.eyebrow}>Coverage & comparability</span>
          <h2 id="compare-quality-title">Know what supports the comparison.</h2>
          <p>
            Review missing inputs, actual reporting durations, and source
            definitions before relying on a peer benchmark.
          </p>
        </div>
        <button onClick={exportCoverage} disabled={!visibleRows.length}>
          <Download size={15} /> Export visible coverage
        </button>
      </div>
      <div className={styles.summary}>
        <span>
          <strong>
            {withValues}/{allCells.length}
          </strong>{" "}
          values available
        </span>
        <span>
          <strong>{usable}</strong> individually compatible values
        </span>
        <span>
          <strong>{withValues - usable}</strong> values withheld for
          incompatible inputs
        </span>
        <span>
          <strong>{allCells.length - withValues}</strong> missing observations
        </span>
      </div>
      <p className={styles.note}>
        Compatibility checks dates, durations, currency, and evidence. It does
        not establish identical accounting definitions. Values with incompatible
        inputs stay visible, while their benchmark contributions are withheld.
        Source revision flags remain reviewable even when dates and durations
        are compatible.
      </p>
      <div className={styles.controls}>
        <label>
          Coverage filter
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All observations</option>
            <option value="review">Needs review</option>
            <option value="missing">Missing values</option>
            <option value="usable">Individually compatible</option>
          </select>
        </label>
        <label>
          Coverage company
          <select
            value={company}
            onChange={(event) => setCompany(event.target.value)}
          >
            <option value="all">All selected issuers</option>
            {entries.map((entry) => (
              <option key={entry.ticker} value={entry.ticker}>
                {entry.ticker}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!visibleRows.length && (
        <p className={styles.empty}>
          No observations match these coverage filters.
        </p>
      )}
      {visibleRows.map((row) => (
        <details key={row.metric.key} className={styles.metric}>
          <summary>
            <span>
              {row.metric.label}
              <small>
                {row.count}/{row.total} available · {row.benchmarkCount} in
                benchmark sample
              </small>
            </span>
            <span className={styles.tag}>
              {row.reason
                ? "Benchmark paused"
                : row.definitionsDiffer ||
                    row.excludedCount ||
                    row.cells.some((cell) => cell.quality.issues.length > 0)
                  ? "Review definitions / inputs"
                  : "Inspect coverage"}
            </span>
          </summary>
          {(row.reason || row.definitionNote) && (
            <p className={styles.alert}>
              {[row.reason, row.definitionNote].filter(Boolean).join(" ")}
            </p>
          )}
          <div
            className={styles.scroll}
            tabIndex={0}
            role="region"
            aria-label={`${row.metric.label} coverage details`}
          >
            <table>
              <thead>
                <tr>
                  <th>Issuer & value</th>
                  <th>Reporting scope</th>
                  <th>Evidence assessment</th>
                  <th>Reported concepts</th>
                </tr>
              </thead>
              <tbody>
                {row.cells.map((cell) => (
                  <tr key={cell.ticker}>
                    <th scope="row">
                      <button
                        className={styles.inspect}
                        onClick={() => inspect({ cell, metric: row.metric })}
                        aria-label={`Inspect coverage ${cell.ticker} ${row.metric.label}`}
                      >
                        {cell.ticker} <Search size={13} />
                        <strong>
                          {displayValue(cell.point?.value, row.metric.format)}
                        </strong>
                      </button>
                      <small>{cell.status}</small>
                    </th>
                    <td>
                      {cell.quality.flow
                        ? cell.period?.start || "Unknown start"
                        : "Balance at"}{" "}
                      → {cell.period?.end || "No selected period"}
                      <small>
                        {cell.period?.kind || "Unavailable"}
                        {cell.quality.durationDays != null
                          ? ` · ${cell.quality.durationDays} days`
                          : ""}
                      </small>
                    </td>
                    <td>
                      <strong>
                        {cell.quality.valid
                          ? "Individually compatible"
                          : "Withheld from benchmarks"}
                      </strong>
                      <p>
                        {cell.quality.reason ||
                          "The selected source scope is supported."}
                      </p>
                      {cell.quality.issues.map((issue: string) => (
                        <small key={issue}>{issue}</small>
                      ))}
                    </td>
                    <td>
                      {cell.quality.concepts.length ? (
                        cell.quality.concepts.map((concept: string) => (
                          <code key={concept}>{concept}</code>
                        ))
                      ) : (
                        <span>No source concepts available</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
      {entries.some(
        (entry) => entry.data?.businessModel === "broker-dealer",
      ) && (
        <p className={styles.alert}>
          Securities brokers use common financials by default. Their business
          model is not assumed to match deposit-taking banks.
        </p>
      )}
    </section>
  );
}
