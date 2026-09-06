"use client";

import { useMemo, useState } from "react";
import { Download, FileText, RotateCcw } from "lucide-react";
import {
  BRIEF_SECTIONS,
  briefMetricKeys,
  briefSectionKeys,
  buildAnalysisBrief,
  analysisBriefHtml,
  analysisBriefCsv,
} from "../../utils/analysisBrief.js";
import { downloadText } from "../../utils/download.js";
import styles from "./AnalysisBriefComposer.module.css";

export default function AnalysisBriefComposer({
  data,
  settings,
  index,
  notes,
  evidence = [],
  onPatch,
}: any) {
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState(false);
  const metrics = briefMetricKeys(data, settings);
  const sections = briefSectionKeys(settings);
  const report = useMemo(
    () => buildAnalysisBrief(data, settings, index, notes, evidence),
    [data, settings, index, notes, evidence],
  );
  const html = useMemo(
    () => (preview ? analysisBriefHtml(report) : ""),
    [preview, report],
  );
  const available = data.definitions.filter((d) =>
    `${d.label} ${d.category}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const patch = (update) => {
    setStatus("");
    onPatch(update);
  };
  const download = (type: "html" | "csv") => {
    try {
      downloadText(
        `${data.ticker}-research-brief-${data.periods[index].end}.${type}`,
        type === "html" ? analysisBriefHtml(report) : analysisBriefCsv(report),
        type === "html" ? "text/html" : "text/csv",
      );
      setStatus(
        type === "html"
          ? "HTML download started. Open it in your browser and choose Print → Save as PDF for a printable brief."
          : "Selected-data CSV download started, including raw values and source provenance.",
      );
    } catch {
      setStatus(
        "The export could not start. Try again using a browser that permits downloads.",
      );
    }
  };
  return (
    <section
      className={styles.composer}
      aria-labelledby="analysis-brief-heading"
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>
            From research to a shareable document
          </p>
          <h3 id="analysis-brief-heading">
            <FileText size={19} /> Compose your financial brief
          </h3>
        </div>
        <span className={styles.count}>
          {metrics.length} metrics · {sections.length} sections
        </span>
      </div>
      <p className={styles.description}>
        Choose the figures and evidence that belong in your review. Preview the
        exact report, export a standalone document, or take the selected data
        into a spreadsheet.
      </p>
      <label className={styles.title}>
        Report title
        <input
          maxLength={160}
          value={settings.briefTitle || ""}
          onChange={(event) => patch({ briefTitle: event.target.value })}
          placeholder={`${data.ticker} financial research brief`}
        />
      </label>
      <div className={styles.configuration}>
        <fieldset>
          <legend>Report sections</legend>
          <div className={styles.sectionList}>
            {BRIEF_SECTIONS.map((section) => (
              <label key={section.key} className={styles.option}>
                <input
                  type="checkbox"
                  checked={sections.includes(section.key)}
                  onChange={() =>
                    patch({
                      briefSections: sections.includes(section.key)
                        ? sections.filter((key) => key !== section.key)
                        : [...sections, section.key],
                    })
                  }
                />
                <span>
                  <strong>{section.label}</strong>
                  <small>{section.description}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Choose 1–24 metrics</legend>
          <div className={styles.metricTools}>
            <label>
              Find a metric
              <input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Income, capital, cash…"
              />
            </label>
            <button type="button" onClick={() => patch({ briefMetrics: [] })}>
              <RotateCcw size={13} /> Use highlights
            </button>
          </div>
          <div className={styles.metricList}>
            {available.map((definition) => (
              <label key={definition.key} className={styles.option}>
                <input
                  type="checkbox"
                  checked={metrics.includes(definition.key)}
                  disabled={
                    metrics.includes(definition.key)
                      ? metrics.length === 1
                      : metrics.length >= 24
                  }
                  onChange={() =>
                    patch({
                      briefMetrics: metrics.includes(definition.key)
                        ? metrics.filter((key) => key !== definition.key)
                        : [...metrics, definition.key],
                    })
                  }
                />
                <span>
                  {definition.label}
                  <small>
                    {definition.category.replace("cashflow", "Cash flow")}
                  </small>
                </span>
              </label>
            ))}
            {!available.length && <p>No metrics match this search.</p>}
          </div>
        </fieldset>
      </div>
      <p className={styles.description}>
        The history table includes up to four periods ending{" "}
        {data.periods[index].end}. Compact citations always retain SEC tags,
        values, filing dates and accessions. Notes and saved evidence are
        included only when their sections are selected.
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          disabled={!sections.length}
          onClick={() => setPreview(!preview)}
          aria-expanded={preview}
          aria-controls="analysis-brief-preview"
        >
          <FileText size={15} />
          {preview ? "Hide preview" : "Preview report"}
        </button>
        <button
          type="button"
          disabled={!sections.length}
          onClick={() => download("html")}
        >
          <Download size={15} />
          Export HTML / printable PDF
        </button>
        <button
          type="button"
          disabled={
            !sections.some((key) =>
              [
                "summary",
                "metrics",
                "history",
                "coverage",
                "evidence",
              ].includes(key),
            )
          }
          onClick={() => download("csv")}
        >
          Selected-data CSV
        </button>
      </div>
      {!sections.length && (
        <p className={styles.description}>
          Select at least one section to preview or export a brief.
        </p>
      )}
      {status && (
        <p role="status" className={styles.status}>
          {status}
        </p>
      )}
      {preview && (
        <div id="analysis-brief-preview" className={styles.preview}>
          <p>
            Preview updates as you change the report. The exported document
            contains the same content.
          </p>
          <iframe
            title={`${data.ticker} financial brief preview`}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={html}
          />
        </div>
      )}
    </section>
  );
}
