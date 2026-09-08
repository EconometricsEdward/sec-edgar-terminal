"use client";

import { useMemo, useState } from "react";
import { comparePortfolioResearch } from "../../../utils/portfolioChanges.js";
import styles from "./PortfolioChanges.module.css";

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
  snapshot: any;
  rows: any[];
  onInspectCompany: (rowId: string) => void;
  onCreateBrief: (draft: any) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
};

export default function PortfolioChanges({
  baseline,
  snapshot,
  rows,
  onInspectCompany,
  onCreateBrief,
  onRefresh,
  refreshing = false,
}: Props) {
  const comparison = useMemo(
    () => comparePortfolioResearch(baseline, snapshot, rows),
    [baseline, snapshot, rows],
  );
  const [kind, setKind] = useState("all");
  const [company, setCompany] = useState("all");
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
  const changes = comparison.changes.filter(
    (change: any) =>
      (kind === "all" || change.kind === kind) &&
      (company === "all" || change.cik === company),
  );
  const startingPoint =
    comparison.baselineAt === comparison.capturedAt &&
    !comparison.changes.length;

  function createBrief(change: any) {
    onCreateBrief({
      title: `${change.ticker || change.companyName}: ${change.title}`,
      ticker: change.ticker,
      cik: change.cik,
      question: `What explains this observed evidence change, and does it alter the research thesis?\n\n${change.title}. ${change.description}\n\nEarlier capture (${date(comparison.baselineAt)}): ${observation(change.before, change.kind)}\nCurrent capture (${date(comparison.capturedAt)}): ${observation(change.after, change.kind)}\n\nVerify the source documents before drawing a conclusion.`,
      sources: [
        ...change.beforeSources.map((url: string) => ({
          url,
          label: `${change.ticker || change.companyName}: earlier capture`,
          capturedAt: comparison.baselineAt,
          origin: "portfolio-change",
        })),
        ...change.afterSources.map((url: string) => ({
          url,
          label: `${change.ticker || change.companyName}: current capture`,
          capturedAt: comparison.capturedAt,
          origin: "portfolio-change",
        })),
      ],
    });
  }

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
              {comparison.checkedIssuers} issuer
              {comparison.checkedIssuers === 1 ? "" : "s"} checked
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
            <span className={styles.resultCount} aria-live="polite">
              {changes.length} observation{changes.length === 1 ? "" : "s"}
            </span>
          </div>
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
              {changes.map((change: any) => (
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
                                {entry.links.length > 1 ? ` ${index + 1}` : ""}{" "}
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
                    <button
                      className={styles.button}
                      type="button"
                      onClick={() => createBrief(change)}
                    >
                      Create follow-up brief
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className={styles.method}>
            One observation per issuer, even when multiple share classes are
            selected. Filing comparisons use the captured recent filing lists.
            Coverage changes describe the evidence available to this workspace.
          </p>
        </>
      )}
    </section>
  );
}
