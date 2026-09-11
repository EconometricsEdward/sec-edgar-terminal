"use client";

import { useMemo, useState } from "react";
import { comparePortfolioResearch } from "../../../utils/portfolioChanges.js";
import styles from "./PortfolioChanges.module.css";
import {
  analyzeRevisions,
  analysisRowsCsv,
} from "../../../utils/portfolioEnrichment.js";
import { downloadText } from "../../../utils/download.js";
import { number } from "./PortfolioInsightTools";

const KINDS = [
  ["filing", "Newly observed filings"],
  ["period", "Reporting periods"],
  ["revision", "Same-period revisions"],
  ["coverage", "Evidence coverage"],
] as const;

function date(value: string | null) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "No capture yet";
}
function observation(value: string, kind: string) {
  if (kind !== "period") return value;
  try {
    const period = JSON.parse(value);
    return (
      [
        period.kind?.toUpperCase(),
        period.start && `from ${period.start}`,
        period.end && `ending ${period.end}`,
      ]
        .filter(Boolean)
        .join(" · ") || "Period unavailable"
    );
  } catch {
    return value;
  }
}

type Props = {
  baseline: any;
  allocation?: any;
  snapshot: any;
  rows: any[];
  onInspectCompany: (rowId: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
};

export default function PortfolioChanges({
  baseline,
  allocation,
  snapshot,
  rows,
  onInspectCompany,
  onRefresh,
  refreshing = false,
}: Props) {
  const comparison = useMemo(
    () => comparePortfolioResearch(baseline, snapshot, rows),
    [baseline, snapshot, rows],
  );
  const [kind, setKind] = useState("all");
  const [company, setCompany] = useState("all");
  const [unit, setUnit] = useState("");
  const [minimum, setMinimum] = useState("0");
  const [sortBy, setSortBy] = useState("company");
  const [limit, setLimit] = useState(20);
  const [exportMessage, setExportMessage] = useState("");
  const companies = useMemo(
    () =>
      [
        ...new Map(
          comparison.changes.map((change: any) => [
            change.cik,
            { cik: change.cik, name: change.ticker || change.companyName },
          ]),
        ).values(),
      ] as { cik: string; name: string }[],
    [comparison],
  );
  const revisionAnalysis = useMemo(
    () =>
      analyzeRevisions(comparison.changes, {
        kind,
        company,
        unit,
        minimum,
        sortBy,
        weights:
          allocation?.basis && allocation.basis !== "none"
            ? Object.fromEntries(
                allocation.issuers.map((row: any) => [row.cik, row.weightPct]),
              )
            : {},
      }),
    [comparison, kind, company, unit, minimum, sortBy, allocation],
  );
  const changes = revisionAnalysis.rows;
  function exportChanges() {
    try {
      downloadText(
        "portfolio-research-changes.csv",
        analysisRowsCsv(changes, {
          earlier_capture: comparison.baselineAt,
          current_capture: comparison.capturedAt,
          kind,
          company,
          revision_unit: unit,
          minimum_absolute_revision: minimum,
          sort_by: sortBy,
        }),
        "text/csv;charset=utf-8",
      );
      setExportMessage(
        `CSV prepared for ${changes.length} observations with both source sets.`,
      );
    } catch {
      setExportMessage("Export could not be prepared. Please try again.");
    }
  }
  const startingPoint =
    comparison.baselineAt === comparison.capturedAt &&
    !comparison.changes.length;

  return (
    <section
      className={styles.root}
      aria-labelledby="portfolio-changes-heading"
    >
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>THE RESEARCH DELTA</p>
          <h3 id="portfolio-changes-heading">What changed?</h3>
          <p>
            See what deserves another look since the earlier successful research
            capture.
          </p>
        </div>
        {onRefresh && (
          <button
            type="button"
            className={styles.button}
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Research in progress…" : "Refresh all research"}
          </button>
        )}
      </header>

      {comparison.state === "needs_baseline" ? (
        <div className={styles.empty}>
          <span className={styles.emptySymbol} aria-hidden="true">
            ↻
          </span>
          <div>
            <h4>Your next capture starts the comparison.</h4>
            <p>
              {snapshot
                ? "Complete a full refresh to compare this captured research with newly retrieved evidence."
                : "Run research to capture the starting point. After the next successful full refresh, newly observed filings, reporting periods, and comparable metric revisions appear here."}
            </p>
            <p>
              Each change keeps its source links. Different reporting periods
              are shown separately from same-period value revisions.
            </p>
          </div>
        </div>
      ) : comparison.state === "incompatible" ? (
        <div className={styles.warning} role="status">
          {comparison.warnings.join(" ")}
        </div>
      ) : (
        <>
          <div className={styles.captureBar}>
            <span>
              <small>EARLIER CAPTURE</small>
              <strong>{date(comparison.baselineAt)}</strong>
            </span>
            <span aria-hidden="true">→</span>
            <span>
              <small>CURRENT CAPTURE</small>
              <strong>{date(comparison.capturedAt)}</strong>
            </span>
            <span className={styles.checked}>
              {comparison.checkedIssuers}{" "}
              {comparison.checkedIssuers === 1 ? "holding" : "holdings"} checked
              {comparison.uncheckedIssuers
                ? ` · ${comparison.uncheckedIssuers} need a check`
                : ""}
            </span>
          </div>
          <div className={styles.stats} aria-label="Change categories">
            {KINDS.map(([key, label]) => (
              <button
                type="button"
                key={key}
                className={`${styles.stat} ${kind === key ? styles.active : ""}`}
                aria-pressed={kind === key}
                onClick={() => setKind(kind === key ? "all" : key)}
              >
                <strong>{comparison.counts[key]}</strong>
                <span>{label}</span>
              </button>
            ))}
          </div>
          {!!comparison.warnings.length && (
            <div className={styles.warning} role="status">
              {comparison.warnings.map((warning: string) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          )}
          <div className={styles.filters}>
            <label>
              Change type
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="all">All change types</option>
                {KINDS.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Company
              <select
                value={company}
                onChange={(event) => setCompany(event.target.value)}
              >
                <option value="all">All companies</option>
                {companies.map((entry) => (
                  <option key={entry.cik} value={entry.cik}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Revision unit
              <select
                value={unit}
                onChange={(event) => {
                  setUnit(event.target.value);
                  setMinimum("0");
                }}
              >
                <option value="">All observations</option>
                {revisionAnalysis.units.map((value: string) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            {unit && (
              <label>
                Minimum absolute revision ({unit})
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={minimum}
                  onChange={(event) => setMinimum(event.target.value)}
                />
              </label>
            )}
            <label>
              Sort observations
              <select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value)}
              >
                <option value="company">Group by company</option>
                {allocation?.basis && allocation.basis !== "none" && (
                  <option value="weight">Largest known allocation</option>
                )}
                {unit && (
                  <option value="magnitude">Largest absolute revision</option>
                )}
              </select>
            </label>
            <button
              type="button"
              className={styles.button}
              disabled={!changes.length || Boolean(revisionAnalysis.error)}
              onClick={exportChanges}
            >
              Export filtered changes
            </button>
            <span className={styles.resultCount} aria-live="polite">
              {changes.length} observation{changes.length === 1 ? "" : "s"}
            </span>
          </div>
          {revisionAnalysis.error && (
            <p role="alert">{revisionAnalysis.error}</p>
          )}
          {exportMessage && <p role="status">{exportMessage}</p>}
          {unit && (
            <p>
              Numeric differences are verified same-period revisions. Percentage
              measures change in percentage points; they are not growth rates.
            </p>
          )}
          {!changes.length ? (
            <div className={styles.empty}>
              <div>
                <h4>
                  {comparison.changes.length
                    ? "No observations match these filters."
                    : startingPoint
                      ? "Your starting point is captured."
                      : "No comparable changes observed."}
                </h4>
                <p>
                  {comparison.changes.length
                    ? "Choose another company or change type to continue reviewing."
                    : startingPoint
                      ? "After the next successful full refresh, this starting point will show what changed in the available evidence."
                      : "The captured evidence matches within the available filing lists and financial fields. This does not rule out changes outside the data covered here."}
                </p>
                {(kind !== "all" || company !== "all") && (
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => {
                      setKind("all");
                      setCompany("all");
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </div>
          ) : (
            <ol className={styles.list}>
              {changes.slice(0, limit).map((change: any) => (
                <li key={change.id} className={styles.change}>
                  <div className={styles.changeHeader}>
                    <span className={styles.company}>
                      {change.ticker || change.companyName}
                    </span>
                    <span className={styles.badge}>
                      {KINDS.find(([key]) => key === change.kind)?.[1]}
                    </span>
                    {!change.fresh && (
                      <span className={styles.unchecked}>Needs a check</span>
                    )}
                  </div>
                  <h4>{change.title}</h4>
                  {change.knownWeightPct !== null && (
                    <p>
                      Known allocation: {number(change.knownWeightPct, "%")}
                    </p>
                  )}
                  {change.delta !== null && (
                    <p>
                      <strong>
                        Revision: {number(change.delta, change.deltaUnit)}
                      </strong>
                    </p>
                  )}
                  <p>{change.description}</p>
                  <div className={styles.comparison}>
                    {[
                      {
                        label: "Earlier",
                        value: change.before,
                        links: change.beforeSources,
                      },
                      {
                        label: "Current",
                        value: change.after,
                        links: change.afterSources,
                      },
                    ].map((entry) => (
                      <div key={entry.label}>
                        <small>{entry.label}</small>
                        <strong>{observation(entry.value, change.kind)}</strong>
                        <div className={styles.sources}>
                          {entry.links.length ? (
                            entry.links.map((url: string, index: number) => (
                              <a
                                key={url}
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                SEC source
                                {entry.links.length > 1
                                  ? ` ${index + 1}`
                                  : ""}{" "}
                                ↗
                              </a>
                            ))
                          ) : (
                            <span>No linked source in this capture</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className={styles.actions}>
                    <button
                      className={styles.button}
                      type="button"
                      onClick={() => onInspectCompany(change.rowId)}
                    >
                      Inspect company
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {changes.length > 20 && (
            <button
              type="button"
              className={styles.button}
              onClick={() =>
                setLimit(limit >= changes.length ? 20 : limit + 20)
              }
            >
              {limit >= changes.length
                ? "Show first 20 observations"
                : `Show more (${Math.min(limit, changes.length)} of ${changes.length})`}
            </button>
          )}
          <p className={styles.method}>
            One observation per company, even when multiple share classes are
            selected. Filing comparisons use the captured recent filing lists.
            Coverage changes describe the evidence available to this workspace.
          </p>
        </>
      )}
    </section>
  );
}
