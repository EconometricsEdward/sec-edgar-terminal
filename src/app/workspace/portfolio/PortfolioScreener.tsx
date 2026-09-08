"use client";

import { useId, useMemo, useState } from "react";
import {
  buildPortfolioScreen,
  portfolioScreenCsv,
  PORTFOLIO_SCREEN_PRESETS,
} from "../../../utils/portfolioScreening.js";
import { downloadText } from "../../../utils/download.js";
import styles from "./PortfolioScreener.module.css";

type Rule = { metricId: string; min: string; max: string };
type Props = {
  report: any;
  companies?: any[];
  onInspectCompany: (rowId: string) => void;
};
const EMPTY_COMPANIES: any[] = [];
const format = (value: number | null, unit = "") =>
  value === null || !Number.isFinite(value)
    ? "Unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: 2 }) + unit;

export default function PortfolioScreener({
  report,
  companies = EMPTY_COMPANIES,
  onInspectCompany,
}: Props) {
  const id = useId();
  const [rules, setRules] = useState<Rule[]>(() =>
    PORTFOLIO_SCREEN_PRESETS[0].rules.map((rule) => ({ ...rule })),
  );
  const [industry, setIndustry] = useState("");
  const [sortBy, setSortBy] = useState("name");
  const [direction, setDirection] = useState("asc");
  const [showAll, setShowAll] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState("");
  const result = useMemo(
    () =>
      buildPortfolioScreen(report, companies, rules, {
        industry,
        sortBy,
        direction,
      }),
    [report, companies, rules, industry, sortBy, direction],
  );
  const selectedMetrics = [...new Set(rules.map((rule) => rule.metricId))]
    .map((metricId) =>
      report.metrics.find((metric: any) => metric.id === metricId),
    )
    .filter(Boolean);
  const visibleMatches = showAll ? result.matches : result.matches.slice(0, 20);

  function changeRule(index: number, patch: Partial<Rule>) {
    setRules((current) =>
      current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    );
    setShowAll(false);
    setDownloadMessage("");
  }
  function applyPreset(index: number) {
    setRules(
      PORTFOLIO_SCREEN_PRESETS[index].rules.map((rule) => ({ ...rule })),
    );
    setSortBy("name");
    setShowAll(false);
    setDownloadMessage("");
  }
  function download() {
    try {
      downloadText(
        "portfolio-screen-results.csv",
        portfolioScreenCsv(result),
        "text/csv;charset=utf-8",
      );
      setDownloadMessage(
        "CSV prepared with " +
          result.matches.length +
          " matching issuers and their reporting dates and SEC sources.",
      );
    } catch {
      setDownloadMessage(
        "The CSV could not be prepared. Check the rules and try again.",
      );
    }
  }

  return (
    <section className={styles.screener} aria-labelledby={id + "-title"}>
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>Company screener</span>
          <h3 id={id + "-title"}>Turn a research question into a shortlist.</h3>
          <p>
            Combine up to four financial rules. Every rule must pass, using one
            observation per resolved issuer. Select a company to inspect its
            evidence.
          </p>
        </div>
        <span className={styles.badge}>AND rules · inclusive bounds</span>
      </div>
      <div className={styles.presets} aria-label="Research screen presets">
        <span>Start with a screen</span>
        {PORTFOLIO_SCREEN_PRESETS.map((preset, index) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => applyPreset(index)}
            title={preset.description}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <p className={styles.note}>
        These are editable research screens. They describe reported financial
        measures and do not recommend buying or selling. Different business
        models use different measures.
      </p>
      <div className={styles.rules}>
        {rules.map((rule, index) => {
          const metric = report.metrics.find(
            (item: any) => item.id === rule.metricId,
          );
          return (
            <fieldset className={styles.rule} key={index}>
              <legend>
                Rule {index + 1}
                {index > 0 ? " · AND" : ""}
              </legend>
              <label>
                Financial measure
                <select
                  value={rule.metricId}
                  onChange={(event) => {
                    changeRule(index, {
                      metricId: event.target.value,
                      min: "",
                      max: "",
                    });
                    setSortBy("name");
                  }}
                >
                  {report.metrics.map((item: any) => (
                    <option key={item.id} value={item.id}>
                      {item.label} ({item.unit})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Minimum ({metric?.unit || "value"})
                <input
                  type="text"
                  inputMode="decimal"
                  value={rule.min}
                  placeholder="No minimum"
                  aria-describedby={id + "-bounds"}
                  aria-invalid={result.errors.some((error: string) =>
                    error.startsWith("Rule " + (index + 1) + ":"),
                  )}
                  onChange={(event) =>
                    changeRule(index, { min: event.target.value })
                  }
                />
              </label>
              <label>
                Maximum ({metric?.unit || "value"})
                <input
                  type="text"
                  inputMode="decimal"
                  value={rule.max}
                  placeholder="No maximum"
                  aria-describedby={id + "-bounds"}
                  aria-invalid={result.errors.some((error: string) =>
                    error.startsWith("Rule " + (index + 1) + ":"),
                  )}
                  onChange={(event) =>
                    changeRule(index, { max: event.target.value })
                  }
                />
              </label>
              <button
                type="button"
                className={styles.remove}
                aria-label={"Remove rule " + (index + 1)}
                disabled={rules.length === 1}
                onClick={() => {
                  setRules((current) => current.filter((_, i) => i !== index));
                  setSortBy("name");
                  setDownloadMessage("");
                }}
              >
                Remove
              </button>
            </fieldset>
          );
        })}
        <div className={styles.ruleFooter}>
          <button
            type="button"
            disabled={rules.length >= 4}
            onClick={() =>
              setRules((current) => [
                ...current,
                {
                  metricId: report.metrics[0]?.id || "revenueGrowth",
                  min: "0",
                  max: "",
                },
              ])
            }
          >
            + Add rule ({rules.length}/4)
          </button>
          <p id={id + "-bounds"}>
            Use at least one bound per rule. Enter 10 for 10%, or 1 for a 1×
            ratio. The minimum and maximum are included.
          </p>
        </div>
      </div>
      <div className={styles.controls}>
        <label>
          SEC industry scope
          <select
            value={industry}
            onChange={(event) => {
              setIndustry(event.target.value);
              setShowAll(false);
              setDownloadMessage("");
            }}
          >
            <option value="">All SEC industries</option>
            {result.industries.map((item: string) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort matching issuers
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value)}
          >
            <option value="name">Company name</option>
            {report.weighted ? (
              <option value="weight">Known original weight</option>
            ) : null}
            {selectedMetrics.map((metric: any) => (
              <option key={metric.id} value={metric.id}>
                {metric.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort direction
          <select
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
      </div>
      {!result.valid ? (
        <div className={styles.error} role="alert">
          <strong>Complete the rules to see results.</strong>
          <ul>
            {result.errors.map((error: string) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <div className={styles.stats} aria-live="polite" aria-atomic="true">
            <div>
              <span>Matching issuers</span>
              <strong>{result.matchCount}</strong>
              <small>of {result.measuredCount} fully measured</small>
            </div>
            <div>
              <span>Eligible for every rule</span>
              <strong>{result.eligibleCount}</strong>
              <small>of {result.scopeCount} in this scope</small>
            </div>
            <div>
              <span>Missing a required value</span>
              <strong>{result.missingCount}</strong>
              <small>Eligible, but cannot be assessed</small>
            </div>
            <div>
              <span>At least one rule does not apply</span>
              <strong>{result.notApplicableCount}</strong>
              <small>Excluded from the eligible denominator</small>
            </div>
          </div>
          {report.weighted ? (
            <p className={styles.notice}>
              <strong>
                Known matched weight:{" "}
                {format(result.knownMatchedWeightPct, "%")}.
              </strong>{" "}
              Original portfolio weights are retained.{" "}
              {result.incompleteMatchedWeightCount > 0
                ? result.incompleteMatchedWeightCount +
                  " matching issuers have incomplete weights; this is a known subtotal."
                : "The shortlist is not reweighted to 100%."}
            </p>
          ) : (
            <p className={styles.note}>
              This is a company-count screen. A ticker list does not imply
              portfolio weights.
            </p>
          )}
          <div className={styles.tableHeading}>
            <div>
              <h4>Matching companies</h4>
              <p>
                {result.matchCount === 0
                  ? "No measured companies satisfy every rule. Broaden a bound or industry scope to continue."
                  : "Showing " +
                    visibleMatches.length +
                    " of " +
                    result.matchCount +
                    " matches. Values use the captured reporting periods shown below."}
              </p>
            </div>
            <button
              type="button"
              disabled={!result.matches.length}
              onClick={download}
            >
              Download matching CSV
            </button>
          </div>
          {result.matches.length ? (
            <div
              className={styles.tableWrap}
              role="region"
              aria-label="Matching issuer financial measures"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Company / SEC industry</th>
                    {selectedMetrics.map((metric: any) => (
                      <th scope="col" key={metric.id}>
                        {metric.label}
                      </th>
                    ))}
                    {report.weighted ? <th scope="col">Known weight</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visibleMatches.map((row: any) => (
                    <tr key={row.cik}>
                      <th scope="row">
                        <button
                          type="button"
                          className={styles.company}
                          disabled={!row.rowId}
                          onClick={() => onInspectCompany(row.rowId)}
                        >
                          {row.tickers.join(" / ") || row.name}
                        </button>
                        <span>{row.name}</span>
                        <small>{row.industry}</small>
                      </th>
                      {selectedMetrics.map((metric: any) => {
                        const cell = row.cells.find(
                          (item: any) => item.metricId === metric.id,
                        );
                        return (
                          <td key={metric.id}>
                            <strong>{format(cell.value, cell.unit)}</strong>
                            <span>
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
                              <small>No direct source link</small>
                            )}
                          </td>
                        );
                      })}
                      {report.weighted ? (
                        <td>
                          {format(row.weightPct, "%")}
                          {!row.weightComplete ? (
                            <small>Known subtotal</small>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {result.matches.length > 20 ? (
            <button
              type="button"
              className={styles.showMore}
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll
                ? "Show first 20 matches"
                : "Show all " + result.matches.length + " matches"}
            </button>
          ) : null}
          {result.missing.length || result.notApplicable.length ? (
            <details className={styles.exclusions}>
              <summary>
                Why {result.missing.length + result.notApplicable.length}{" "}
                issuers could not be screened
              </summary>
              <p>
                Missing values never pass a rule. If any rule does not apply to
                an issuer, that issuer is counted only in “does not apply,” even
                when another measure is missing.
              </p>
              <ul>
                {[...result.missing, ...result.notApplicable].map(
                  (row: any) => (
                    <li key={row.cik}>
                      <button
                        type="button"
                        disabled={!row.rowId}
                        onClick={() => onInspectCompany(row.rowId)}
                      >
                        {row.tickers.join(" / ") || row.name}
                      </button>
                      <span>
                        {row.cells
                          .filter((cell: any) => cell.status !== "available")
                          .map(
                            (cell: any) =>
                              cell.label +
                              ": " +
                              (cell.status === "missing"
                                ? "missing"
                                : "not applicable"),
                          )
                          .join(" · ")}
                      </span>
                    </li>
                  ),
                )}
              </ul>
            </details>
          ) : null}
        </>
      )}
      {downloadMessage ? <p role="status">{downloadMessage}</p> : null}
      <p className={styles.note}>
        Scope: resolved issuers in this portfolio; share classes are combined.{" "}
        {result.unresolvedCount
          ? result.unresolvedCount +
            " unresolved positions are excluded until their identity is resolved. "
          : ""}
        Reporting dates may differ across companies and measures. Screens use
        captured data and do not fetch live prices.
      </p>
    </section>
  );
}
