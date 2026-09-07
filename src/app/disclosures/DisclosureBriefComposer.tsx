"use client";
import { useMemo, useState } from "react";
import { Download, Eye, Printer } from "lucide-react";
import {
  buildDisclosureBrief,
  disclosureBriefCsv,
  disclosureBriefHtml,
} from "../../utils/disclosureBrief.js";
import {
  disclosureBriefDefaults,
  saveDisclosureBriefDraft,
} from "../../utils/disclosureCollections.js";
import type { Collection, DisclosureNotebook } from "./disclosureTypes";
import s from "./disclosures.module.css";
import c from "./disclosureCollections.module.css";

type BriefSettings = {
  title: string;
  researchQuestion: string;
  narrative: string;
  conclusions: string;
  groupBy: "order" | "company" | "topic";
};
export type BriefDraft = { base: BriefSettings; values: BriefSettings };
const download = (name: string, value: string, type: string) => {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export function DisclosureBriefComposer({
  collection,
  selectedIds,
  draft,
  setDraft,
  mutate,
}: {
  collection: Collection;
  selectedIds: string[];
  draft?: BriefDraft;
  setDraft: (draft?: BriefDraft) => void;
  mutate: (
    update: (current: DisclosureNotebook) => DisclosureNotebook,
    success: string,
  ) => boolean;
}) {
  const [preview, setPreview] = useState(false);
  const [exportedAt] = useState(() => new Date().toISOString());
  const [message, setMessage] = useState("");
  const saved = disclosureBriefDefaults(collection) as BriefSettings;
  const values = draft?.values || saved;
  const conflict = Boolean(
    draft && JSON.stringify(saved) !== JSON.stringify(draft.base),
  );
  const brief = useMemo(
    () =>
      buildDisclosureBrief(collection, {
        settings: values,
        selectedIds,
        exportedAt,
      }),
    [collection, values, selectedIds, exportedAt],
  );
  const html = useMemo(() => disclosureBriefHtml(brief), [brief]);
  const missingSelected = selectedIds.length - brief.items.length;
  const available =
    brief.items.length > 0 &&
    values.title.trim().length > 0 &&
    missingSelected === 0;
  const update = (patch: Partial<BriefSettings>) => {
    const base = draft?.base || saved;
    const next = { ...values, ...patch };
    setDraft(
      JSON.stringify(next) === JSON.stringify(base)
        ? undefined
        : { base, values: next },
    );
  };
  const save = (keepDraft = false) => {
    if (
      mutate(
        (current) =>
          saveDisclosureBriefDraft(
            current,
            collection.id,
            keepDraft ? saved : draft?.base || saved,
            values,
          ),
        "Brief draft saved to this collection.",
      )
    )
      setDraft(undefined);
  };
  const print = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setMessage(
        "The print window was blocked. Allow this window or download the HTML brief and print it from your browser.",
      );
      return;
    }
    printWindow.opener = null;
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    setMessage(
      "The exact preview opened for printing. Choose your browser’s Save as PDF option if needed.",
    );
  };
  return (
    <details className={c.composer}>
      <summary>
        <span>Research brief composer</span>
        <span>{brief.items.length} selected passages</span>
      </summary>
      <p className={s.muted}>
        Select passages above or below, arrange their order in the collection,
        and add your own interpretation. Exports use saved passage annotations
        and the brief fields shown here, including any unsaved brief draft.
      </p>
      <div className={c.briefFields}>
        <label>
          Brief title
          <input
            value={values.title}
            maxLength={160}
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
            <option value="topic">Primary tag / section</option>
          </select>
        </label>
        <label className={c.fullWidth}>
          Research question
          <textarea
            value={values.researchQuestion}
            maxLength={3000}
            rows={2}
            onChange={(event) =>
              update({ researchQuestion: event.target.value })
            }
            placeholder="What does the evidence tell us about refinancing capacity?"
          />
        </label>
        <label className={c.fullWidth}>
          Research narrative
          <textarea
            value={values.narrative}
            maxLength={12000}
            rows={4}
            onChange={(event) => update({ narrative: event.target.value })}
            placeholder="Connect the evidence, state the reporting periods, and explain the limits of your search."
          />
        </label>
        <label className={c.fullWidth}>
          Conclusions and open questions
          <textarea
            value={values.conclusions}
            maxLength={12000}
            rows={3}
            onChange={(event) => update({ conclusions: event.target.value })}
            placeholder="Record your conclusion, uncertainty and follow-up questions."
          />
        </label>
      </div>
      <div className={c.annotationFooter}>
        <span role="status">
          {conflict
            ? "Conflict: another tab changed the saved brief"
            : draft
              ? "Unsaved brief draft"
              : collection.brief
                ? "Brief fields saved"
                : "Default brief fields"}
        </span>
        <div className={s.actions}>
          <button
            disabled={!draft || conflict || !values.title.trim()}
            onClick={() => save()}
          >
            Save brief draft
          </button>
          {draft && (
            <button onClick={() => setDraft(undefined)}>Use saved brief</button>
          )}
        </div>
      </div>
      {conflict && (
        <div className={c.conflict}>
          <strong>Latest saved brief</strong>
          <p>{saved.title}</p>
          <p>Research question: {saved.researchQuestion || "None"}</p>
          <p>Narrative: {saved.narrative || "None"}</p>
          <p>Conclusions: {saved.conclusions || "None"}</p>
          <p>Grouping: {saved.groupBy}</p>
          <button disabled={!values.title.trim()} onClick={() => save(true)}>
            Keep my draft over this saved brief
          </button>
        </div>
      )}
      <p className={s.muted}>
        {brief.items.length} selected passages from {brief.filingCount} filings
        and {brief.companyCount} companies.{" "}
        {collection.items.length - brief.items.length} saved passages omitted.
        This is the selected evidence set, not a measure of complete document
        coverage.
      </p>
      <div className={s.actions}>
        <button
          disabled={!available}
          onClick={() => setPreview((current) => !current)}
        >
          <Eye size={14} />
          {preview ? "Hide preview" : "Preview exact brief"}
        </button>
        <button
          disabled={!available}
          onClick={() => {
            download(
              "disclosure-research-brief.html",
              html,
              "text/html;charset=utf-8",
            );
            setMessage(
              "The exact preview was exported as HTML, including source metadata and saved search settings.",
            );
          }}
        >
          <Download size={14} />
          Download brief HTML
        </button>
        <button
          disabled={!available}
          onClick={() => {
            download(
              "disclosure-research-brief.csv",
              disclosureBriefCsv(brief),
              "text/csv;charset=utf-8",
            );
            setMessage(
              "Selected evidence and brief fields exported as CSV with saved source snapshots.",
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
      {!selectedIds.length && (
        <p className={s.muted}>
          Select at least one saved passage to preview or export a brief.
        </p>
      )}
      {missingSelected > 0 && (
        <p role="alert" className={c.draftNotice}>
          {missingSelected} selected passages were moved or removed elsewhere.
          Clear the selection and choose the current saved passages before
          exporting.
        </p>
      )}
      {message && (
        <p role="status" className={c.feedback}>
          {message}
        </p>
      )}
      {preview && available && (
        <iframe
          title="Exact disclosure research brief preview"
          className={c.preview}
          sandbox=""
          srcDoc={html}
        />
      )}
    </details>
  );
}
