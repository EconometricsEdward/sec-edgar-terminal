"use client";

import { ArrowUpRight, BookOpen } from "lucide-react";
import {
  analysisDisclosureHandoff,
  analysisMetricGuide,
} from "../../utils/analysisMetricGuide.js";
import styles from "./AnalysisMetricGuide.module.css";

export default function AnalysisMetricGuide({
  definition,
  point,
  data,
  asOf,
}: any) {
  const guide = analysisMetricGuide(definition, point, data?.lens);
  const handoff = analysisDisclosureHandoff({
    ticker: data?.ticker,
    cik: data?.cik,
    query: guide.query,
    section: guide.section,
    asOf,
  });
  return (
    <details className={styles.guide}>
      <summary>
        <BookOpen size={15} aria-hidden="true" /> Understand this figure{" "}
        <span>
          {guide.known ? "Meaning & research prompts" : "Methodology guide"}
        </span>
      </summary>
      <div className={styles.body}>
        <dl>
          <dt>What it measures</dt>
          <dd>{guide.meaning}</dd>
          <dt>What to investigate</dt>
          <dd>{guide.movement}</dd>
          <dt>Limits of this figure</dt>
          <dd>{guide.caution}</dd>
        </dl>
        {guide.scopeNotes.length > 0 && (
          <ul className={styles.scope}>
            {guide.scopeNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <p className={styles.education}>
          These are reading prompts, not a finding about this company. The
          original inputs below remain the evidence for the number.
        </p>
        {handoff ? (
          <a
            className={styles.action}
            href={handoff}
            target="_blank"
            rel="noreferrer"
          >
            Research this in {data?.ticker || data?.cik} disclosures{" "}
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        ) : (
          <p className={styles.education}>
            A verified company ticker or CIK is needed to open a
            company-specific disclosure search.
          </p>
        )}
        {handoff && (
          <p className={styles.education}>
            Opens a prepared{" "}
            {guide.section === "mda"
              ? "MD&A"
              : guide.section === "notes"
                ? "financial notes"
                : "all-sections"}{" "}
            search in a new tab
            {asOf ? ` through the ${asOf} filing cutoff` : ""}. Review and run
            the search; matching narrative has not yet been verified.
          </p>
        )}
        <a
          className={styles.reading}
          href={guide.reading.url}
          target="_blank"
          rel="noreferrer"
        >
          {guide.reading.title} <ArrowUpRight size={11} aria-hidden="true" />
        </a>
      </div>
    </details>
  );
}
