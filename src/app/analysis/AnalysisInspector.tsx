"use client";
import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, BookmarkPlus } from "lucide-react";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./analysis.module.css";
export default function AnalysisInspector({
  selection,
  close,
  save,
  status,
}: any) {
  const { definition, point, label } = selection;
  const instant =
    point?.sources?.length > 0 && point.sources.every((s) => !s.start);
  const [notes, setNotes] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <aside
      className={styles.inspector}
      aria-label="Financial evidence"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className={styles.sectionHeading}>
        <p className={styles.eyebrow}>Evidence inspector</p>
        <button onClick={close} aria-label="Close evidence inspector">
          <X size={18} />
        </button>
      </div>
      <h2 ref={heading} tabIndex={-1}>
        {label || definition.label}
      </h2>
      <strong className={styles.bigValue}>
        {analysisValue(point?.value, definition.format)}
      </strong>
      <p className={styles.muted}>
        {instant
          ? "As of"
          : `${point?.period?.kind} · ${point?.period?.start || "Start unavailable"} →`}{" "}
        {point?.period?.end}
      </p>
      <span className={styles.badge}>
        {point?.classification || "Unavailable"}
      </span>
      {point?.reason && <p className={styles.notice}>{point.reason}</p>}
      {point?.formula && (
        <div className={styles.formula}>
          <strong>Calculation</strong>
          <p>{point.formula}</p>
        </div>
      )}
      {point?.note && <p className={styles.muted}>{point.note}</p>}
      {(point?.calculations || []).length > 0 && (
        <details>
          <summary>
            Intermediate calculations ({point.calculations.length})
          </summary>
          {point.calculations.map((c, i) => (
            <p key={i} className={styles.small}>
              {c.start || "Instant"} → {c.end}:{" "}
              {c.value?.toLocaleString("en-US")} {c.unit || ""} = {c.formula}
            </p>
          ))}
        </details>
      )}
      <h3>Reported inputs ({point?.sources?.length || 0})</h3>
      {(point?.sources || []).map((s, i) => (
        <article className={styles.source} key={i}>
          <strong>{s.label || s.tag}</strong>
          <code>
            {s.taxonomy}:{s.tag}
          </code>
          <p>
            {s.value?.toLocaleString("en-US", { maximumFractionDigits: 6 })}{" "}
            {s.unit}
          </p>
          <dl>
            <dt>Period</dt>
            <dd>
              {s.start || "Instant"} → {s.end}
            </dd>
            <dt>Filed</dt>
            <dd>
              {s.filed} · {s.form}
            </dd>
            <dt>Accession</dt>
            <dd>{s.accession}</dd>
          </dl>
          {s.documentUrl && (
            <a href={s.documentUrl} target="_blank" rel="noreferrer">
              Open original SEC source <ExternalLink size={12} />
            </a>
          )}
          {s.revised && (
            <details>
              <summary>Different filed values for this context</summary>
              <p className={styles.small}>
                A revision can reflect a restatement, reclassification, or
                another reporting change. Review the filings before interpreting
                it.
              </p>
              <ol>
                {(s.revisions || []).map((r, j) => (
                  <li key={j}>
                    {r.filed}: {r.value?.toLocaleString("en-US")} {s.unit} ·{" "}
                    <a href={r.documentUrl} target="_blank" rel="noreferrer">
                      {r.form}
                    </a>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </article>
      ))}
      <label>
        Evidence note
        <textarea
          rows={3}
          maxLength={5000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Why this figure matters…"
        />
      </label>
      <button
        className={styles.primary}
        disabled={point?.value == null}
        onClick={() =>
          save({
            label: label || definition.label,
            format: definition.format,
            point,
            notes,
          })
        }
      >
        <BookmarkPlus size={16} />
        Collect this evidence
      </button>
      {status && <p role="status">{status}</p>}
    </aside>
  );
}
