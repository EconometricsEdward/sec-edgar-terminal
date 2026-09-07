"use client";
import { useEffect, useRef, useState } from "react";
import { BookmarkPlus, Copy, ExternalLink, Link2, X } from "lucide-react";
import { buildSourceUrl } from "../../../utils/xbrlParser.js";
import {
  compareEvidenceCitation,
  makeCompareEvidenceUrl,
  comparisonSourceFingerprint,
  safeCompareSourceUrl,
} from "../../../utils/compareEvidenceLinks.js";
import { displayValue, type CompareEvidence } from "../compareTypes";
import styles from "../compare.module.css";
import extra from "./CompareInspector.module.css";

const definitions: Record<string, string> = {
  totalAssets:
    "Reported total assets at the observation’s balance-sheet endpoint. It includes the issuer’s consolidated assets under the selected SEC concept.",
  stockholdersEquity:
    "Reported stockholders’ equity at the balance-sheet endpoint. The selected concept can include noncontrolling interests; inspect its tag before comparing issuer definitions.",
  netIncome:
    "Reported net income or profit for the exact duration shown below. A standalone quarter may be calculated from cumulative reported amounts; all original inputs are retained.",
  revenue:
    "Reported revenue for the selected duration. Revenue recognition and gross-versus-net presentation can differ across issuers; the original SEC concept identifies the value used.",
  operatingIncome:
    "Reported operating income or loss over the exact reporting duration. The source concept and filing determine which operating items the issuer includes.",
  cash: "Reported cash or cash and cash equivalents at the balance-sheet endpoint. For banking issuers the source may be cash and due from banks. This is not a measure of all available liquidity.",
  operatingCashFlow:
    "Reported cash provided by or used in operating activities over the selected duration. Standalone quarters may be calculated from cumulative cash-flow reports.",
  netInterestIncome:
    "Reported net interest income before credit loss provision over the selected duration. This differs from gross interest income.",
  noninterestIncome:
    "Reported noninterest income over the selected reporting duration, using the issuer’s available SEC XBRL concept.",
  deposits:
    "Reported deposits at the balance-sheet endpoint. Review the selected concept and filing for the issuer’s deposit coverage.",
  loans:
    "Reported net loans or financing receivables at the balance-sheet endpoint, after the allowance under the selected concept. This is not automatically equivalent to gross loans.",
  premiumsEarned:
    "Reported net premiums earned over the selected duration. It is not a substitute for an insurer’s complete revenue or total-income measure.",
  investmentIncome:
    "Reported investment income over the selected duration, using the selected SEC concept. It is not the value of the investment portfolio.",
};
const exact = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : value == null
      ? "Unavailable"
      : String(value);
export default function CompareInspector({
  evidence,
  close,
  save,
  tickers = [],
}: {
  evidence: CompareEvidence;
  close: () => void;
  save: () => void;
  tickers?: string[];
}) {
  const { cell, metric } = evidence;
  const point = cell.point,
    period = point?.period || cell.period,
    sources = point?.sources || [];
  const ref = useRef<HTMLElement>(null);
  const [feedback, setFeedback] = useState({
    key: "",
    message: "",
    manual: "",
  });
  const key = `${cell.cik}:${metric.key}:${comparisonSourceFingerprint(point)}`;
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [evidence]);
  const query =
    metric.category === "Credit"
      ? '"credit losses" OR "loan quality" OR "provision"'
      : metric.category === "Liquidity" || metric.category === "Funding"
        ? "liquidity OR funding OR deposits"
        : metric.category === "Capital"
          ? '"capital allocation" OR leverage OR repurchase'
          : "profitability OR pricing OR expenses";
  const unit =
    metric.format === "percent"
      ? "%"
      : metric.format === "decimal"
        ? "times"
        : metric.format === "currency"
          ? "USD"
          : metric.format;
  const definition =
    metric.definition ||
    definitions[metric.key] ||
    point?.formula ||
    metric.formula ||
    `Reported ${metric.label.toLowerCase()} using the SEC concepts and reporting contexts listed below.`;
  const citation = compareEvidenceCitation({
    ...evidence,
    metric: { ...metric, definition },
  });
  const link = makeCompareEvidenceUrl(evidence, { tickers });
  const copy = async (value: string, description: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback({ key, message: `${description} copied.`, manual: "" });
    } catch {
      setFeedback({
        key,
        message:
          "Clipboard access is unavailable. Select and copy the text below.",
        manual: value,
      });
    }
  };
  return (
    <aside
      ref={ref}
      className={styles.inspector}
      tabIndex={-1}
      aria-label="Financial evidence inspector"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <div className={styles.inspectorHead}>
        <span className={styles.eyebrow}>SEC evidence / {cell.ticker}</span>
        <button aria-label="Close evidence inspector" onClick={close}>
          <X size={16} />
        </button>
      </div>
      <h2>{metric.label}</h2>
      <strong className={styles.evidenceValue}>
        {displayValue(point?.value, metric.format)}
      </strong>
      <p>{cell.name || cell.ticker}</p>
      <div className={extra.precision}>
        <span>Unrounded observation</span>
        <code>
          {exact(point?.value)} {unit}
        </code>
        <small>
          Full numeric precision available from the SEC data and calculation,
          before display rounding.
        </small>
      </div>
      <dl className={styles.metadata}>
        <dt>Reporting period</dt>
        <dd>
          {period
            ? `${period.start || "Balance at"} → ${period.end}`
            : "Unavailable"}
        </dd>
        <dt>Basis</dt>
        <dd>{period?.kind || "No selected period"}</dd>
        <dt>Classification</dt>
        <dd>{point?.classification || cell.status || "Unavailable"}</dd>
        <dt>CIK</dt>
        <dd>{cell.cik || "Not resolved"}</dd>
        <dt>Filing cutoff</dt>
        <dd>
          {evidence.settings?.asOf ||
            period?.asOf ||
            "Latest available filings"}
        </dd>
        {period?.fp && (
          <>
            <dt>Fiscal period</dt>
            <dd>
              {period.fy ? `FY${period.fy} · ` : ""}
              {period.fp}
            </dd>
          </>
        )}
        {evidence.capturedAt && (
          <>
            <dt>Snapshot</dt>
            <dd>
              {evidence.snapshotName || "Saved research checkpoint"}
              <br />
              Captured {new Date(evidence.capturedAt).toLocaleString()}
            </dd>
          </>
        )}
      </dl>
      {evidence.capturedAt && (
        <p className={extra.notice}>
          This is the frozen observation captured in the snapshot. Its values
          and filing cutoff are preserved when you save evidence.
        </p>
      )}
      <h3>Metric definition</h3>
      <p>{definition}</p>
      {metric.inputs?.length > 0 && (
        <small>Required inputs: {metric.inputs.join(", ")}</small>
      )}
      {point?.value == null ? (
        <p className={styles.notice}>
          {point?.reason ||
            (cell.status === "fetch failed"
              ? "This issuer could not be loaded. Retry it before interpreting its coverage."
              : "No compatible observation exists for the selected reporting period.")}
        </p>
      ) : (
        <>
          <h3>{point.formula ? "Calculation" : "Reported observation"}</h3>
          <p className={styles.formula}>
            {point.formula ||
              "Direct reported SEC XBRL value, with its original context below."}
          </p>
          {point.note && <p>{point.note}</p>}
          <button className={styles.primary} onClick={save}>
            <BookmarkPlus size={15} /> Save evidence to collection
          </button>
        </>
      )}
      <div className={extra.share}>
        <button onClick={() => copy(citation, "Source citation")}>
          <Copy size={14} /> Copy source citation
        </button>
        {link ? (
          <>
            <button
              onClick={() =>
                copy(
                  new URL(link, window.location.origin).href,
                  "Exact observation link",
                )
              }
            >
              <Link2 size={14} /> Copy observation link
            </button>
            <a href={link} target="_blank" rel="noopener noreferrer">
              Open observation link <ExternalLink size={12} />
            </a>
          </>
        ) : (
          <small>
            An exact observation link requires a resolved issuer, reporting
            period and original comparison settings.
          </small>
        )}
      </div>
      {link && (
        <small>
          Observation links verify the original input fingerprint when reopened.
          If later SEC data differs, the link reports the mismatch. Private
          notes and snapshot names are excluded from the URL.
        </small>
      )}
      {feedback.key === key && (
        <div className={extra.feedback}>
          <p role="status">{feedback.message}</p>
          {feedback.manual && (
            <textarea
              aria-label="Text to copy manually"
              readOnly
              value={feedback.manual}
              onFocus={(event) => event.currentTarget.select()}
              rows={7}
            />
          )}
        </div>
      )}
      {!!point?.calculations?.length && (
        <details className={styles.details}>
          <summary>
            Intermediate calculations ({point.calculations.length})
          </summary>
          {point.calculations.map((calculation: any, index: number) => (
            <div key={index} className={styles.source}>
              <p>{calculation.formula}</p>
              <code>
                {exact(calculation.value)} {calculation.unit || "USD"}
              </code>
              <small>
                {calculation.start || "Balance at"} →{" "}
                {calculation.end || "See original inputs"}
              </small>
            </div>
          ))}
        </details>
      )}
      <h3 className={styles.sourceTitle}>
        Original reported inputs <small>{sources.length}</small>
      </h3>
      {sources.map((source: any, index: number) => {
        const sourceUrl = safeCompareSourceUrl(source.documentUrl),
          conceptUrl = safeCompareSourceUrl(buildSourceUrl(cell.cik, source));
        return (
          <article
            key={`${source.accession}-${source.tag}-${source.start}-${index}`}
            className={styles.source}
          >
            <strong>{source.label || source.tag}</strong>
            <code>
              {source.taxonomy ? `${source.taxonomy}:` : ""}
              {source.tag}
            </code>
            <p className={extra.sourceValue}>
              {exact(source.value)} {source.unit}
            </p>
            <small>
              {source.start || "Balance at"} → {source.end}
              <br />
              {source.form || "Form unavailable"} · Filed{" "}
              {source.filed || "Date unavailable"}
              <br />
              Accession {source.accession || "Unavailable"}
              {source.frame && (
                <>
                  <br />
                  Frame {source.frame}
                </>
              )}
              {source.fp && (
                <>
                  <br />
                  Fiscal period {source.fy ? `${source.fy} ` : ""}
                  {source.fp}
                </>
              )}
            </small>
            {source.revised && (
              <p className={styles.warning}>
                This context has different values in other filings. Review the
                sources before attributing the change to a restatement.
              </p>
            )}
            <div className={styles.actions}>
              {sourceUrl && (
                <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
                  Original SEC filing <ExternalLink size={12} />
                </a>
              )}
              {conceptUrl && (
                <a href={conceptUrl} target="_blank" rel="noopener noreferrer">
                  XBRL concept
                </a>
              )}
            </div>
          </article>
        );
      })}
      {evidence.settings && (
        <details className={styles.details}>
          <summary>Original comparison settings</summary>
          <dl className={styles.metadata}>
            {Object.entries(evidence.settings).map(([setting, value]) => (
              <div className={extra.setting} key={setting}>
                <dt>{setting}</dt>
                <dd>
                  {Array.isArray(value)
                    ? value.join(", ") || "None"
                    : String(value || "Default / latest")}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <div className={styles.researchLinks}>
        <a href={`/analysis/${encodeURIComponent(cell.ticker)}`}>
          Company analysis <ExternalLink size={13} />
        </a>
        <a href={`/risk?ticker=${encodeURIComponent(cell.ticker)}`}>
          Company risk profile <ExternalLink size={13} />
        </a>
        <a
          href={`/disclosures?${new URLSearchParams({ query, focus: cell.ticker, scope: "paragraph" })}`}
        >
          Investigate related disclosures <ExternalLink size={13} />
        </a>
      </div>
      <small>
        Sources can come from later comparative filings. A selected filing
        cutoff limits the facts to what had been filed by that date.
      </small>
    </aside>
  );
}
