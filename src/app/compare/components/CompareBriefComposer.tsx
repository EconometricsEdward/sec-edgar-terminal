"use client";
import { useMemo, useState } from "react";
import { Download, Eye, Printer } from "lucide-react";
import {
  buildCompareBrief,
  compareBriefCsv,
  compareBriefHtml,
} from "../../../utils/compareBrief.js";
import {
  compareBriefDefaults,
  saveCompareBrief,
} from "../../../utils/compareLibrary.js";
import { downloadFile } from "../compareTypes";
import s from "../compare.module.css";
import c from "./compareLibrary.module.css";

type BriefSettings = {
  title: string;
  researchQuestion: string;
  narrative: string;
  conclusions: string;
  groupBy: "order" | "company" | "metric";
};
export type CompareBriefDraft = { base: BriefSettings; values: BriefSettings };
export default function CompareBriefComposer({
  notebook,
  selectedIds,
  selectionProblem,
  selectedDrafts,
  memoDirty,
  draft,
  setDraft,
  commit,
}: {
  notebook: any;
  selectedIds: string[];
  selectionProblem: string;
  selectedDrafts: number;
  memoDirty: boolean;
  draft?: CompareBriefDraft;
  setDraft: (draft?: CompareBriefDraft) => void;
  commit: (update: (current: any) => any, success: string) => boolean;
}) {
  const [preview, setPreview] = useState(false);
  const [exportedAt] = useState(() => new Date().toISOString());
  const [message, setMessage] = useState("");
  const saved = compareBriefDefaults(notebook) as BriefSettings;
  const values = draft?.values || saved;
  const conflict = Boolean(
    draft && JSON.stringify(saved) !== JSON.stringify(draft.base),
  );
  const brief = useMemo(
    () =>
      buildCompareBrief(notebook, {
        settings: values,
        selectedIds,
        exportedAt,
      }),
    [notebook, values, selectedIds, exportedAt],
  );
  const html = useMemo(() => compareBriefHtml(brief), [brief]);
  const available =
    brief.items.length > 0 &&
    values.title.trim().length > 0 &&
    !selectionProblem &&
    !selectedDrafts &&
    !memoDirty;
  const update = (patch: Partial<BriefSettings>) => {
    const base = draft?.base || saved,
      next = { ...values, ...patch };
    setDraft(
      JSON.stringify(next) === JSON.stringify(base)
        ? undefined
        : { base, values: next },
    );
  };
  const save = (overwrite = false) => {
    if (
      commit(
        (current) =>
          saveCompareBrief(
            current,
            overwrite ? saved : draft?.base || saved,
            values,
          ),
        "Brief fields saved in this browser.",
      )
    )
      setDraft(undefined);
  };
  const print = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setMessage(
        "The print window was blocked. Download the HTML brief and print it from your browser, or allow this window.",
      );
      return;
    }
    printWindow.opener = null;
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    setMessage(
      "The exact preview opened for printing. Choose Save as PDF in your browser if needed.",
    );
  };
  return (
    <details className={c.composer}>
      <summary>
        Research brief composer{" "}
        <span>{brief.items.length} selected observations</span>
      </summary>
      <p className={c.muted}>
        Choose observations in the organizer and arrange their order. Brief
        exports include the fields shown here, including an unsaved brief draft,
        and the saved observation annotations and collection memo.
      </p>
      <div className={c.briefFields}>
        <label>
          Brief title
          <input
            maxLength={160}
            value={values.title}
            onChange={(event) => update({ title: event.target.value })}
          />
        </label>
        <label>
          Group evidence by
          <select
            value={values.groupBy}
            onChange={(event) =>
              update({
                groupBy: event.target.value as BriefSettings["groupBy"],
              })
            }
          >
            <option value="order">Collection order</option>
            <option value="company">Company</option>
            <option value="metric">Metric</option>
          </select>
        </label>
        <label className={c.full}>
          Research question
          <textarea
            rows={2}
            maxLength={3000}
            value={values.researchQuestion}
            onChange={(event) =>
              update({ researchQuestion: event.target.value })
            }
            placeholder="Which differences need follow-up before reaching a conclusion?"
          />
        </label>
        <label className={c.full}>
          Analyst narrative
          <textarea
            rows={4}
            maxLength={12000}
            value={values.narrative}
            onChange={(event) => update({ narrative: event.target.value })}
            placeholder="Connect the selected evidence, compare reporting periods, and explain limitations."
          />
        </label>
        <label className={c.full}>
          Conclusions and open questions
          <textarea
            rows={3}
            maxLength={12000}
            value={values.conclusions}
            onChange={(event) => update({ conclusions: event.target.value })}
          />
        </label>
      </div>
      <div className={c.footer}>
        <span role="status">
          {conflict
            ? "Conflict: saved brief changed elsewhere"
            : draft
              ? "Unsaved brief draft"
              : notebook.brief
                ? "Brief fields saved"
                : "Default brief fields"}
        </span>
        <div className={s.actions}>
          <button
            disabled={!draft || conflict || !values.title.trim()}
            onClick={() => save()}
          >
            Save brief fields
          </button>
          {draft && (
            <button onClick={() => setDraft(undefined)}>
              Discard brief draft
            </button>
          )}
        </div>
      </div>
      {conflict && (
        <div className={c.conflict}>
          <strong>Latest saved brief</strong>
          <p>Title: {saved.title}</p>
          <p>Question: {saved.researchQuestion || "None"}</p>
          <p>Narrative: {saved.narrative || "None"}</p>
          <p>Conclusions: {saved.conclusions || "None"}</p>
          <p>Grouping: {saved.groupBy}</p>
          <button disabled={!values.title.trim()} onClick={() => save(true)}>
            Keep my draft over this saved brief
          </button>
        </div>
      )}
      <p className={c.muted}>
        {brief.items.length} selected observations from {brief.companyCount}{" "}
        companies and {brief.sourceCount} source filings. {brief.omittedCount}{" "}
        saved observations omitted. CSV repeats an observation once per original
        reported input.
      </p>
      {(!selectedIds.length ||
        selectionProblem ||
        selectedDrafts > 0 ||
        memoDirty) && (
        <p className={c.draftNotice}>
          {selectionProblem ||
            (!selectedIds.length
              ? "Select at least one saved observation to create a brief."
              : selectedDrafts
                ? "Save or discard the selected observation drafts before exporting; your unsaved notes have been kept."
                : "Save or discard the collection memo draft before exporting.")}
        </p>
      )}
      <div className={s.actions}>
        <button
          disabled={!available}
          onClick={() => setPreview((value) => !value)}
        >
          <Eye size={14} />
          {preview ? "Hide preview" : "Preview exact brief"}
        </button>
        <button
          disabled={!available}
          onClick={() => {
            downloadFile(
              "peer-comparison-research-brief.html",
              html,
              "text/html;charset=utf-8",
            );
            setMessage(
              "The exact preview downloaded as HTML with original settings, values, and SEC sources.",
            );
          }}
        >
          <Download size={14} />
          Download brief HTML
        </button>
        <button
          disabled={!available}
          onClick={() => {
            downloadFile(
              "peer-comparison-selected-evidence.csv",
              compareBriefCsv(brief),
              "text/csv;charset=utf-8",
            );
            setMessage(
              "Selected evidence and brief fields exported with original source snapshots.",
            );
          }}
        >
          <Download size={14} />
          Export selected CSV
        </button>
        <button disabled={!available} onClick={print}>
          <Printer size={14} />
          Print / PDF
        </button>
      </div>
      {message && (
        <p role="status" className={c.feedback}>
          {message}
        </p>
      )}
      {preview && available && (
        <iframe
          className={c.preview}
          sandbox=""
          srcDoc={html}
          title="Exact peer comparison research brief preview"
        />
      )}
    </details>
  );
}
