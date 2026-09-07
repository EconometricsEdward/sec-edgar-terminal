"use client";
import { useState } from "react";
import { Download, RefreshCw, ArrowDown, Play } from "lucide-react";
import {
  disclosureCoverageRows,
  exportDisclosureCoverage,
} from "../../utils/disclosureCoverage.js";
import { companyInputs } from "./disclosureTypes";
import { downloadText } from "../../utils/download.js";
import s from "./disclosures.module.css";
import styles from "./DisclosureCoverageDesk.module.css";

export default function DisclosureCoverageDesk({
  settings,
  companies,
  aliases,
  busy,
  onResume,
  onRetry,
  onMore,
  onRetryFiling,
  restoredAt,
}: any) {
  const [expanded, setExpanded] = useState(false);
  const rows: any[] = disclosureCoverageRows(
    companyInputs(settings.tickers),
    aliases,
    companies,
  );
  const pending = rows.filter((r) =>
    ["not-reviewed", "failed"].includes(r.state),
  );
  const reviewed = rows.reduce((n, r) => n + r.reviewed, 0);
  const failures = rows.reduce(
    (n, r) => n + r.fetchFailed + r.sectionUnavailable + r.comparisonFailed,
    0,
  );
  return (
    <section
      className={`${s.panel} ${styles.desk}`}
      aria-labelledby="disclosure-coverage-heading"
    >
      <div className={s.panelHeading}>
        <div>
          <span className={s.eyebrow}>
            Know what the search actually covered
          </span>
          <h2 id="disclosure-coverage-heading">Coverage desk</h2>
        </div>
        <div className={s.actions}>
          <button disabled={busy || !pending.length} onClick={onResume}>
            <Play size={14} /> Resume {pending.length} companies
          </button>
          <button
            onClick={() =>
              downloadText(
                "disclosure-search-coverage.csv",
                exportDisclosureCoverage(rows, settings),
                "text/csv",
              )
            }
          >
            <Download size={14} /> Coverage CSV
          </button>
        </div>
      </div>
      <p className={s.muted}>
        {reviewed} documents successfully searched · {pending.length} companies
        still need a completed scan · {failures} document or comparison gaps. A
        reviewed filing without a match is different from a filing that could
        not be searched.
      </p>
      {restoredAt && (
        <p className={s.notice}>
          Results restored from this browser tab, saved{" "}
          {new Date(restoredAt).toLocaleString()}. They have not been refreshed
          automatically. Resume unfinished companies or start a new search to
          refresh the full sample.
        </p>
      )}
      <button
        aria-expanded={expanded}
        className={styles.toggle}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "Collapse" : "Review"} company coverage and recovery actions
      </button>
      {expanded && (
        <div className={styles.rows}>
          {rows.map((row) => (
            <article key={row.ticker} className={styles.company}>
              <div className={s.panelHeading}>
                <div>
                  <h3>
                    {row.ticker}{" "}
                    {row.companyName && <small>{row.companyName}</small>}
                  </h3>
                  <span className={styles[row.state]}>
                    {
                      {
                        "not-reviewed": "Not reviewed",
                        failed: "Scan failed",
                        partial: "Partial coverage",
                        reviewed: "Selected sample reviewed",
                      }[row.state]
                    }
                  </span>
                </div>
                <div className={s.actions}>
                  {["not-reviewed", "failed"].includes(row.state) && (
                    <button disabled={busy} onClick={() => onRetry(row.ticker)}>
                      <RefreshCw size={13} /> Review {row.ticker}
                    </button>
                  )}
                  {row.nextCursor && (
                    <button disabled={busy} onClick={() => onMore(row.company)}>
                      <ArrowDown size={13} /> Review next{" "}
                      {Math.min(
                        settings.depth,
                        row.remaining || settings.depth,
                      )}{" "}
                      older filings
                    </button>
                  )}
                </div>
              </div>
              {row.company && (
                <p>
                  {row.reviewed} reviewed / {row.selected} attempted ·{" "}
                  {row.matched} query matches · {row.eligible ?? "Unknown"}{" "}
                  eligible in inspected history
                  {row.cik ? ` · CIK ${row.cik}` : ""}
                </p>
              )}
              {row.error && <p className={s.error}>{row.error}</p>}
              {row.historyLimited && (
                <p className={s.warning}>
                  Historical submissions remain bounded. Reviewing another batch
                  does not establish complete SEC history.
                </p>
              )}
              {row.company && (
                <p className={s.muted}>
                  First observed within this search:{" "}
                  {row.firstObserved || "No verified match"}. This is not a
                  claim about the company’s first-ever disclosure.
                </p>
              )}
              {row.filings
                ?.filter((f) => f.status !== "reviewed" || f.comparisonError)
                .map((f) => (
                  <div
                    className={styles.gap}
                    key={`${f.accession}:${f.primaryDoc}`}
                  >
                    <span>
                      {f.form} · {f.filingDate} ·{" "}
                      {f.reason || f.comparisonError || f.status}
                    </span>
                    <button disabled={busy} onClick={() => onRetryFiling(f)}>
                      <RefreshCw size={13} /> Retry this document
                    </button>
                  </div>
                ))}
              {row.historyIssues?.map((issue, i) => (
                <p key={i} className={s.muted}>
                  {issue}
                </p>
              ))}
            </article>
          ))}
        </div>
      )}
      <p className={s.muted}>
        Each batch keeps the original query, dates, section and comparison
        strategy. Earlier results are retained; repeated filings and company
        aliases are counted once. Completed company results are retained on
        reload in this browser tab when storage permits.
      </p>
    </section>
  );
}
