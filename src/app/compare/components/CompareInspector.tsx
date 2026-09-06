"use client";
import { useEffect, useRef } from "react";
import { BookmarkPlus, ExternalLink, X } from "lucide-react";
import { buildSourceUrl } from "../../../utils/xbrlParser.js";
import { displayValue, type CompareEvidence } from "../compareTypes";
import styles from "../compare.module.css";

export default function CompareInspector({
  evidence,
  close,
  save,
}: {
  evidence: CompareEvidence;
  close: () => void;
  save: () => void;
}) {
  const { cell, metric } = evidence;
  const point = cell.point,
    sources = point?.sources || [];
  const ref = useRef<HTMLElement>(null);
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
  return (
    <aside
      ref={ref}
      className={styles.inspector}
      tabIndex={-1}
      aria-label="Financial evidence inspector"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
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
      <dl className={styles.metadata}>
        <dt>Reporting period</dt>
        <dd>
          {cell.period
            ? `${cell.period.start || "Balance at"} → ${cell.period.end}`
            : "Unavailable"}
        </dd>
        <dt>Basis</dt>
        <dd>{cell.period?.kind || "No selected period"}</dd>
        <dt>Classification</dt>
        <dd>{point?.classification || cell.status || "Unavailable"}</dd>
        <dt>CIK</dt>
        <dd>{cell.cik || "Not resolved"}</dd>
        <dt>Filing cutoff</dt>
        <dd>{cell.period?.asOf || "Latest available filings"}</dd>
      </dl>
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
      {!!point?.calculations?.length && (
        <details className={styles.details}>
          <summary>
            Intermediate calculations ({point.calculations.length})
          </summary>
          {point.calculations.map((c: any, i: number) => (
            <div key={i} className={styles.source}>
              <p>{c.formula}</p>
              <code>
                {c.value?.toLocaleString("en-US")} {c.unit || "USD"}
              </code>
              <small>
                {c.start} → {c.end}
              </small>
            </div>
          ))}
        </details>
      )}
      <h3 className={styles.sourceTitle}>
        Original reported inputs <small>{sources.length}</small>
      </h3>
      {sources.map((s: any, i: number) => (
        <article
          key={`${s.accession}-${s.tag}-${s.start}-${i}`}
          className={styles.source}
        >
          <strong>{s.label || s.tag}</strong>
          <code>{s.tag}</code>
          <p>
            {Number(s.value).toLocaleString("en-US", {
              maximumFractionDigits: 6,
            })}{" "}
            {s.unit}
          </p>
          <small>
            {s.start || "Balance at"} → {s.end}
            <br />
            {s.form} · Filed {s.filed}
            <br />
            Accession {s.accession}
          </small>
          {s.revised && (
            <p className={styles.warning}>
              This context has different values in other filings. Review the
              sources before attributing the change to a restatement.
            </p>
          )}
          <div className={styles.actions}>
            {s.documentUrl && (
              <a href={s.documentUrl} target="_blank" rel="noopener noreferrer">
                Original SEC filing <ExternalLink size={12} />
              </a>
            )}
            {buildSourceUrl(cell.cik, s) && (
              <a
                href={buildSourceUrl(cell.cik, s) || undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                XBRL concept
              </a>
            )}
          </div>
        </article>
      ))}
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
