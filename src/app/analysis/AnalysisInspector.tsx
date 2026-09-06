"use client";
import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, BookmarkPlus } from "lucide-react";
import { analysisValue } from "../../utils/analysisNotebook.js";
import {
  analysisCollectionSettings,
  analysisComparisonIndex,
  analysisEvidenceComparison,
  analysisSecUrl,
  analysisSourceCoherence,
  uniqueAnalysisSources,
} from "../../utils/analysisSources.js";
import styles from "./analysis.module.css";
import sourceStyles from "./AnalysisSources.module.css";

function ComparisonFigure({ title, point, format, settings }: any) {
  const sources = uniqueAnalysisSources(point);
  const instant =
    sources.length > 0 && sources.every((source) => !source.start);
  const coherence = analysisSourceCoherence(point, settings?.asOf);
  return (
    <article className={sourceStyles.comparisonCard}>
      <span>{title}</span>
      <strong>{analysisValue(point?.value, format, settings?.units)}</strong>
      <small>{point?.classification || "Unavailable"}</small>
      <p className={sourceStyles.dates}>
        {instant
          ? "As of"
          : `${point?.period?.kind || "Period"} · ${point?.period?.start || "Start unavailable"} →`}{" "}
        {point?.period?.end}
      </p>
      <small>{coherence.status}</small>
      <small>
        Filed {coherence.earliestFiled || "date unavailable"}
        {coherence.latestFiled !== coherence.earliestFiled
          ? ` → ${coherence.latestFiled}`
          : ""}
      </small>
      {point?.reason && (
        <p className={sourceStyles.comparisonNote}>{point.reason}</p>
      )}
      {sources.length > 0 && (
        <details>
          <summary>Reported inputs ({sources.length})</summary>
          <ul>
            {sources.map((source, sourceIndex) => (
              <li key={sourceIndex}>
                <strong>{source.label || source.tag}</strong>
                <code>
                  {source.taxonomy}:{source.tag}
                </code>
                <span>
                  {source.value?.toLocaleString("en-US", {
                    maximumFractionDigits: 6,
                  })}{" "}
                  {source.unit}
                </span>
                <small>
                  {source.start || "Instant"} → {source.end}
                </small>
                <small>
                  Filed {source.filed || "date unavailable"} · {source.form}
                </small>
                <code>{source.accession || "Accession unavailable"}</code>
                {analysisSecUrl(source.documentUrl) && (
                  <a
                    href={analysisSecUrl(source.documentUrl)!}
                    target="_blank"
                    rel="noreferrer"
                  >
                    SEC source <ExternalLink size={10} aria-hidden="true" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

function comparisonDelta(change: any, format: string, units: string) {
  if (change.delta == null) return "Change unavailable";
  const sign = change.delta > 0 ? "+" : change.delta < 0 ? "−" : "";
  const absolute = Math.abs(change.delta);
  if (format === "percent")
    return `${sign}${absolute.toFixed(2)} percentage points`;
  if (format === "decimal") return `${sign}${absolute.toFixed(2)}×`;
  return `${sign}${analysisValue(absolute, format, units)}`;
}

export default function AnalysisInspector({
  selection,
  data,
  settings = {},
  index = 0,
  close,
  save,
  status,
}: any) {
  const { definition, point, label } = selection;
  const instant =
    point?.sources?.length > 0 && point.sources.every((s) => !s.start);
  const [notes, setNotes] = useState(() =>
    typeof selection.notes === "string" ? selection.notes : "",
  );
  const [compareIndex, setCompareIndex] = useState(() =>
    analysisComparisonIndex(data, point, index, settings.baseline),
  );
  const comparison = analysisEvidenceComparison(data, selection, compareIndex);
  const currentCollectionSettings = analysisCollectionSettings(
    selection,
    data,
    settings,
    point,
  );
  const comparisonCollectionSettings = comparison
    ? analysisCollectionSettings(
        selection,
        data,
        settings,
        comparison.before,
        true,
      )
    : null;
  const comparablePeriods = (data?.periods || [])
    .map((period, periodIndex) => ({ period, index: periodIndex }))
    .filter(({ period }) => period.end < point?.period?.end);
  const canCompare = data?.definitions?.some(
    (item) => item.key === definition.key,
  );
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
      {canCompare && (
        <section
          className={sourceStyles.comparison}
          aria-labelledby="analysis-evidence-comparison"
        >
          <h3 id="analysis-evidence-comparison">Compare period evidence</h3>
          {comparablePeriods.length > 0 ? (
            <>
              <label>
                Comparison period
                <select
                  value={compareIndex}
                  onChange={(event) =>
                    setCompareIndex(Number(event.target.value))
                  }
                >
                  <option value={-1}>Choose an earlier period</option>
                  {comparablePeriods.map(({ period, index: periodIndex }) => (
                    <option key={period.end} value={periodIndex}>
                      {period.label || period.kind} · {period.end}
                    </option>
                  ))}
                </select>
              </label>
              {comparison ? (
                <>
                  <div className={sourceStyles.comparisonCards}>
                    <ComparisonFigure
                      title="Selected figure"
                      point={point}
                      format={definition.format}
                      settings={{
                        ...settings,
                        asOf: currentCollectionSettings?.asOf,
                      }}
                    />
                    <ComparisonFigure
                      title="Comparison figure"
                      point={comparison.before}
                      format={definition.format}
                      settings={{
                        ...settings,
                        asOf: comparisonCollectionSettings?.asOf,
                      }}
                    />
                  </div>
                  <div className={sourceStyles.delta} aria-live="polite">
                    <strong>
                      {comparisonDelta(
                        comparison.change,
                        definition.format,
                        settings.units,
                      )}
                    </strong>
                    <p>
                      Selected figure minus comparison figure.
                      {comparison.change.percent != null &&
                        ` ${comparison.change.percent >= 0 ? "+" : ""}${comparison.change.percent.toFixed(2)}% relative change.`}
                    </p>
                    {comparison.change.reason && (
                      <p>{comparison.change.reason}</p>
                    )}
                    {comparison.sourceTagsChanged && (
                      <p>
                        The SEC concepts or units used differ between these
                        figures. Review both input lists before attributing the
                        change to business performance.
                      </p>
                    )}
                    {comparison.common && (
                      <p>
                        Both figures use the same common-size denominator rule
                        for their own period.
                      </p>
                    )}
                  </div>
                  <p className={sourceStyles.comparisonNote}>
                    Selected evidence cutoff:{" "}
                    {currentCollectionSettings
                      ? currentCollectionSettings.asOf ||
                        "latest available when observed"
                      : "not recorded"}
                    . Comparison cutoff:{" "}
                    {comparisonCollectionSettings?.asOf ||
                      "latest available in this loaded extract"}
                    . Later filings may update earlier-period values. This is a
                    comparison of financial observations, not two versions of
                    one filing.
                  </p>
                  {(!currentCollectionSettings ||
                    currentCollectionSettings.asOf !==
                      comparisonCollectionSettings?.asOf) && (
                    <p className={sourceStyles.comparisonNote}>
                      The filing cutoffs differ or the original cutoff is
                      unknown. Differences may include later reporting
                      revisions.
                    </p>
                  )}
                </>
              ) : (
                <p className={sourceStyles.comparisonNote}>
                  No automatic comparable baseline was found. Choose a period to
                  inspect both figures; changes are withheld when reporting
                  durations differ.
                </p>
              )}
            </>
          ) : (
            <p className={sourceStyles.comparisonNote}>
              No earlier period is available in this extract. The selected
              source evidence remains available below.
            </p>
          )}
        </section>
      )}
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
          {analysisSecUrl(s.documentUrl) && (
            <a
              href={analysisSecUrl(s.documentUrl)!}
              target="_blank"
              rel="noreferrer"
            >
              Open original SEC source <ExternalLink size={12} />
            </a>
          )}
          {s.revised && (
            <details>
              <summary>Different filed values for this context</summary>
              <p className={styles.small}>
                A revision can reflect a restatement, reclassification, or
                another reporting change. Up to 12 value changes are retained
                within the filing cutoff; earlier history may be omitted. Review
                the filings before interpreting it.
              </p>
              <ol>
                {(s.revisions || []).map((r, j) => (
                  <li key={j}>
                    {r.filed}: {r.value?.toLocaleString("en-US")} {s.unit} ·{" "}
                    {analysisSecUrl(r.documentUrl) ? (
                      <a
                        href={analysisSecUrl(r.documentUrl)!}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.form} · {r.accession}
                      </a>
                    ) : (
                      <span>
                        {r.form} · {r.accession}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </article>
      ))}
      <label>
        Evidence note for the figure you collect
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
            analysisSettings: currentCollectionSettings,
          })
        }
      >
        <BookmarkPlus size={16} />
        Collect this evidence
      </button>
      {comparison && (
        <button
          className={sourceStyles.comparisonCollect}
          disabled={!Number.isFinite(comparison.before?.value)}
          onClick={() =>
            save({
              label: label || definition.label,
              format: definition.format,
              point: comparison.before,
              notes,
              analysisSettings: comparisonCollectionSettings,
            })
          }
        >
          <BookmarkPlus size={14} aria-hidden="true" />
          Collect comparison figure · {comparison.before?.period?.end}
        </button>
      )}
      {status && <p role="status">{status}</p>}
    </aside>
  );
}
