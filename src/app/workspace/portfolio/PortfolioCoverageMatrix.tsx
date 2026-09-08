"use client";

import { useId, useMemo, useState } from "react";
import {
  buildPortfolioCoverageMatrix,
  portfolioCoverageCsv,
} from "../../../utils/portfolioScreening.js";
import { downloadText } from "../../../utils/download.js";
import styles from "./PortfolioCoverageMatrix.module.css";

type Props = {
  report: any;
  companies?: any[];
  onInspectCompany: (rowId: string) => void;
};
const EMPTY_COMPANIES: any[] = [];
const SHORT_LABELS: Record<string, string> = {
  revenueGrowth: "Revenue growth",
  netMargin: "Net margin",
  operatingMargin: "Operating margin",
  roe: "Return on equity",
  roa: "Return on assets",
  debtAssets: "Debt / assets",
  currentRatio: "Current ratio",
  loanDeposits: "Loans / deposits",
};
const format = (value: number, unit: string) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 }) + unit;

export default function PortfolioCoverageMatrix({
  report,
  companies = EMPTY_COMPANIES,
  onInspectCompany,
}: Props) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [industry, setIndustry] = useState("");
  const [metricId, setMetricId] = useState("");
  const [gapsOnly, setGapsOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState("");
  const matrix = useMemo(
    () =>
      buildPortfolioCoverageMatrix(report, companies, {
        query,
        industry,
        metricId,
        gapsOnly,
      }),
    [report, companies, query, industry, metricId, gapsOnly],
  );
  const visibleRows = showAll ? matrix.rows : matrix.rows.slice(0, 20);
  const filtered = Boolean(query || industry || metricId || gapsOnly);
  function clearFilters() {
    setQuery("");
    setIndustry("");
    setMetricId("");
    setGapsOnly(false);
    setShowAll(false);
    setDownloadMessage("");
  }
  function download() {
    try {
      downloadText(
        "portfolio-evidence-coverage.csv",
        portfolioCoverageCsv(matrix),
        "text/csv;charset=utf-8",
      );
      setDownloadMessage(
        "CSV prepared for all " +
          matrix.rows.length +
          " filtered issuers, including each measure's status, period and source.",
      );
    } catch {
      setDownloadMessage("The CSV could not be prepared. Please try again.");
    }
  }

  return (
    <section className={styles.matrix} aria-labelledby={id + "-title"}>
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>Evidence matrix</span>
          <h3 id={id + "-title"}>See exactly which evidence is available.</h3>
          <p>
            Read across an issuer to compare its financial measures. Missing
            evidence and measures that do not apply have separate labels;
            neither is treated as zero.
          </p>
        </div>
        <button type="button" onClick={download} disabled={!matrix.rows.length}>
          Download filtered coverage CSV
        </button>
      </div>
      <div className={styles.controls}>
        <label>
          Find an issuer
          <input
            type="search"
            placeholder="Company, ticker or CIK"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShowAll(false);
              setDownloadMessage("");
            }}
          />
        </label>
        <label>
          SEC industry
          <select
            value={industry}
            onChange={(event) => {
              setIndustry(event.target.value);
              setShowAll(false);
              setDownloadMessage("");
            }}
          >
            <option value="">All SEC industries</option>
            {matrix.industries.map((value: string) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Financial measure
          <select
            value={metricId}
            onChange={(event) => {
              setMetricId(event.target.value);
              setShowAll(false);
              setDownloadMessage("");
            }}
          >
            <option value="">All financial measures</option>
            {report.metrics.map((metric: any) => (
              <option key={metric.id} value={metric.id}>
                {metric.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.filterRow}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={gapsOnly}
            onChange={(event) => {
              setGapsOnly(event.target.checked);
              setShowAll(false);
              setDownloadMessage("");
            }}
          />
          Only issuers with missing selected measures
        </label>
        {filtered ? (
          <button type="button" onClick={clearFilters}>
            Clear matrix filters
          </button>
        ) : null}
      </div>
      <div className={styles.summary} aria-live="polite" aria-atomic="true">
        <span>
          <strong>{matrix.visibleIssuerCount}</strong> issuers in view
        </span>
        <span className={styles.available}>
          <strong>{matrix.availableCount}</strong> available measures
        </span>
        <span className={styles.missing}>
          <strong>{matrix.missingCount}</strong> missing measures
        </span>
        <span>
          <strong>{matrix.notApplicableCount}</strong> not applicable
        </span>
      </div>
      <p className={styles.note}>
        Counts describe the {matrix.metrics.length} selected{" "}
        {matrix.metrics.length === 1 ? "measure" : "measures"} across all{" "}
        {matrix.visibleIssuerCount} filtered issuers. “Not applicable” includes
        funds and incompatible financial business models.{" "}
        {gapsOnly
          ? "Issuers with the most missing selected measures appear first."
          : "Issuers are sorted by company name."}
      </p>
      {matrix.rows.length ? (
        <div
          className={styles.tableWrap}
          role="region"
          aria-label="Issuer by financial measure evidence coverage"
          tabIndex={0}
        >
          <table>
            <caption className={styles.srOnly}>
              Available values, reporting periods and SEC sources by issuer.
              Missing values can be inspected through the company evidence
              panel.
            </caption>
            <thead>
              <tr>
                <th scope="col">Issuer / coverage</th>
                {matrix.metrics.map((metric: any) => (
                  <th key={metric.id} scope="col" title={metric.description}>
                    {SHORT_LABELS[metric.id] || metric.label}
                    <small>{metric.unit}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row: any) => (
                <tr key={row.cik}>
                  <th scope="row">
                    <button
                      type="button"
                      className={styles.company}
                      disabled={!row.rowId}
                      onClick={() => onInspectCompany(row.rowId)}
                      aria-label={"Inspect " + row.name}
                    >
                      {row.tickers.join(" / ") || row.name}
                    </button>
                    <span>{row.name}</span>
                    <small>
                      {row.availableCount} / {row.eligibleCount} applicable
                      measures available
                    </small>
                    {row.missingCount ? (
                      <small className={styles.missing}>
                        {row.missingCount} missing
                      </small>
                    ) : null}
                  </th>
                  {row.cells.map((cell: any) => (
                    <td
                      key={cell.metricId}
                      className={
                        cell.status === "available"
                          ? styles.availableCell
                          : cell.status === "missing"
                            ? styles.missingCell
                            : styles.naCell
                      }
                    >
                      {cell.status === "available" ? (
                        <>
                          <span className={styles.cellLabel}>
                            <span aria-hidden="true">✓ </span>Available
                          </span>
                          <strong>{format(cell.value, cell.unit)}</strong>
                          <span className={styles.date}>
                            {cell.periodEnd || "Period unavailable"}
                          </span>
                          {cell.sourceUrl ? (
                            <a
                              href={cell.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={
                                row.name + ": " + cell.label + " SEC source"
                              }
                            >
                              SEC source ↗
                            </a>
                          ) : (
                            <span className={styles.date}>
                              No direct source link
                            </span>
                          )}
                        </>
                      ) : cell.status === "missing" ? (
                        <>
                          <span className={styles.cellLabel}>Missing</span>
                          <button
                            type="button"
                            className={styles.inspect}
                            disabled={!row.rowId}
                            onClick={() => onInspectCompany(row.rowId)}
                            aria-label={
                              "Inspect missing " +
                              cell.label +
                              " evidence for " +
                              row.name
                            }
                          >
                            Inspect evidence
                          </button>
                        </>
                      ) : (
                        <>
                          <span className={styles.cellLabel}>
                            Not applicable
                          </span>
                          <span className={styles.date}>
                            Excluded from coverage denominator
                          </span>
                        </>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.empty}>
          <strong>
            {gapsOnly
              ? "No missing selected measures in this scope."
              : "No issuers match these filters."}
          </strong>
          <p>
            {gapsOnly
              ? "Not-applicable measures are excluded from the gap count. Clear filters to review all available evidence."
              : "Try another company name, ticker, CIK or SEC industry."}
          </p>
          {filtered ? (
            <button type="button" onClick={clearFilters}>
              Show all issuers and measures
            </button>
          ) : null}
        </div>
      )}
      {matrix.rows.length > 20 ? (
        <div className={styles.footer}>
          <p>
            Showing {visibleRows.length} of {matrix.rows.length} filtered
            issuers. The CSV includes all filtered issuers.
          </p>
          <button
            type="button"
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll
              ? "Show first 20 issuers"
              : "Show all " + matrix.rows.length + " issuers"}
          </button>
        </div>
      ) : null}
      {downloadMessage ? <p role="status">{downloadMessage}</p> : null}
      <p className={styles.note}>
        Each resolved issuer appears once, with share classes combined.{" "}
        {matrix.unresolvedCount
          ? matrix.unresolvedCount +
            " unresolved positions are excluded from this issuer matrix. "
          : ""}
        Each value keeps its own reporting date and source; dates can differ
        across columns. Selecting a company opens the captured evidence.
      </p>
    </section>
  );
}
