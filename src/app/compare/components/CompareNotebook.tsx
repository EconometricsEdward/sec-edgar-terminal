"use client";
import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  Download,
  FolderOpen,
  Search,
  Trash2,
} from "lucide-react";
import { METRIC_BY_KEY } from "../../../utils/compareResearch.js";
import {
  bulkComparePins,
  checkedCompareSelection,
  compareAnnotations,
  compareMemo,
  comparePinSnapshot,
  compareTags,
  filterComparePins,
  reorderComparePins,
  saveCompareAnnotations,
  saveCompareMemo,
} from "../../../utils/compareLibrary.js";
import {
  displayValue,
  downloadFile,
  type CompareEvidence,
} from "../compareTypes";
import CompareBriefComposer, {
  type CompareBriefDraft,
} from "./CompareBriefComposer";
import s from "../compare.module.css";
import c from "./compareLibrary.module.css";

type Annotation = { notes: string; tags: string };
type PinDraft = {
  base: Annotation;
  values: Annotation;
  label: string;
  ticker: string;
};
type Memo = { collectionName: string; notes: string };
export default function CompareNotebook({
  notebook,
  mutate,
  load,
  inspect,
  notice,
}: {
  notebook: any;
  mutate: (update: (n: any) => any) => boolean;
  load: (item: any) => void;
  inspect: (e: CompareEvidence) => void;
  notice: (s: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [company, setCompany] = useState("");
  const [metric, setMetric] = useState("");
  const [tag, setTag] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [bulkTags, setBulkTags] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, PinDraft>>({});
  const [memoDraft, setMemoDraft] = useState<{ base: Memo; values: Memo }>();
  const [briefDraft, setBriefDraft] = useState<CompareBriefDraft>();
  const [message, setMessage] = useState("");
  const dirty = Boolean(Object.keys(drafts).length || memoDraft || briefDraft);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const report = (text: string) => {
    setMessage(text);
    notice(text);
  };
  const commit = (update: (current: any) => any, success: string) => {
    let detail = "";
    const saved = mutate((current) => {
      try {
        return update(current);
      } catch (cause) {
        detail =
          cause instanceof Error
            ? cause.message
            : "This change could not be saved.";
        throw cause;
      }
    });
    if (!saved) {
      report(
        detail ||
          "Changes could not be saved. Your draft and selection have been kept.",
      );
      return false;
    }
    report(success);
    return true;
  };
  const visible = filterComparePins(notebook.pins, {
    search,
    company,
    metric,
    tag,
  });
  const selectedIds = Object.keys(selected);
  const hiddenSelected = selectedIds.filter(
    (id) => !visible.some((pin: any) => pin.id === id),
  ).length;
  const selectedDrafts = selectedIds.filter((id) => drafts[id]).length;
  let selectionProblem = "";
  if (selectedIds.length) {
    try {
      checkedCompareSelection(notebook.pins, selected);
    } catch (cause) {
      selectionProblem =
        cause instanceof Error
          ? cause.message
          : "Selected observations changed.";
    }
  }
  const companies = [
    ...new Set(notebook.pins.map((pin: any) => pin.ticker)),
  ].sort() as string[];
  const metrics = [
    ...new Map<string, string>(
      notebook.pins.map((pin: any) => [pin.metric, pin.label]),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const tags = [
    ...new Set<string>(
      notebook.pins.flatMap((pin: any) => compareTags(pin.tags)),
    ),
  ].sort();
  const savedMemo = compareMemo(notebook);
  const memo = memoDraft?.values || savedMemo;
  const memoConflict = Boolean(
    memoDraft && JSON.stringify(memoDraft.base) !== JSON.stringify(savedMemo),
  );
  const changeSelection = (next: Record<string, string>) => {
    setSelected(next);
    setConfirmRemove(false);
  };
  const clearDraft = (id: string) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  const editPin = (pin: any, patch: Partial<Annotation>) =>
    setDrafts((current) => {
      const base = current[pin.id]?.base || compareAnnotations(pin);
      const values = { ...(current[pin.id]?.values || base), ...patch };
      const next = {
        ...current,
        [pin.id]: { base, values, ticker: pin.ticker, label: pin.label },
      };
      if (JSON.stringify(base) === JSON.stringify(values)) delete next[pin.id];
      return next;
    });
  const savePin = (pin: any, overwrite = false) => {
    const draft = drafts[pin.id];
    if (!draft) return;
    let updated: any;
    if (
      commit((current) => {
        const next = saveCompareAnnotations(
          current,
          pin.id,
          overwrite ? compareAnnotations(pin) : draft.base,
          draft.values,
        );
        updated = next.pins.find((item: any) => item.id === pin.id);
        return next;
      }, "Observation notes and tags saved.")
    ) {
      clearDraft(pin.id);
      if (selected[pin.id] && updated)
        setSelected((current) => ({
          ...current,
          [pin.id]: comparePinSnapshot(updated),
        }));
    }
  };
  const editMemo = (patch: Partial<Memo>) => {
    const base = memoDraft?.base || savedMemo,
      values = { ...memo, ...patch };
    setMemoDraft(
      JSON.stringify(base) === JSON.stringify(values)
        ? undefined
        : { base, values },
    );
  };
  const saveMemo = (overwrite = false) => {
    if (
      commit(
        (current) =>
          saveCompareMemo(
            current,
            overwrite ? savedMemo : memoDraft?.base || savedMemo,
            memo,
          ),
        "Collection name and research memo saved.",
      )
    )
      setMemoDraft(undefined);
  };
  const bulk = (action: "tag" | "remove") => {
    if (selectedDrafts) {
      report(
        "Save or discard drafts on selected observations before applying a bulk action.",
      );
      return;
    }
    let nextPins: any[] = [];
    if (
      commit(
        (current) => {
          const next = bulkComparePins(current, {
            selected,
            action,
            tags: bulkTags,
          });
          nextPins = next.pins;
          return next;
        },
        action === "remove"
          ? `${selectedIds.length} selected observations removed.`
          : `Tags added to ${selectedIds.length} selected observations.`,
      )
    ) {
      changeSelection(
        action === "remove"
          ? {}
          : Object.fromEntries(
              nextPins
                .filter((pin) => selectedIds.includes(pin.id))
                .map((pin) => [pin.id, comparePinSnapshot(pin)]),
            ),
      );
      if (action === "tag") setBulkTags("");
    }
  };
  const orphanDrafts = Object.entries(drafts).filter(
    ([id]) => !notebook.pins.some((pin: any) => pin.id === id),
  );
  return (
    <section className={s.panel} aria-label="Peer research notebook">
      <div className={s.sectionHead}>
        <div>
          <span className={s.eyebrow}>Research notebook</span>
          <h2>Turn observations into a supported conclusion.</h2>
          <p>
            Organize captured financial evidence, protect your working notes,
            and choose exactly what belongs in your research brief.
          </p>
        </div>
        <span className={s.badge}>Saved in this browser</span>
      </div>
      <details className={c.savedSetups}>
        <summary>
          <Bookmark size={15} /> Saved comparisons{" "}
          <span>{notebook.searches.length}</span>
        </summary>
        {!notebook.searches.length && (
          <p className={c.muted}>
            Use “Save comparison” above to retain your peer set, period,
            metrics, exclusions and benchmark.
          </p>
        )}
        <div className={c.setupGrid}>
          {notebook.searches.map((item: any) => (
            <article className={c.setup} key={item.id}>
              <strong>{item.name}</strong>
              <small>
                {item.tickers.join(" · ")}
                <br />
                {item.settings.basis} · {item.settings.asOf || "Latest filings"}{" "}
                · Saved {item.savedAt?.slice(0, 10)}
              </small>
              <div className={s.actions}>
                <button onClick={() => load(item)}>
                  <FolderOpen size={14} />
                  Open comparison
                </button>
                <button
                  aria-label={`Delete saved comparison ${item.name}`}
                  onClick={() =>
                    commit(
                      (current) => ({
                        ...current,
                        searches: current.searches.filter(
                          (saved: any) => saved.id !== item.id,
                        ),
                      }),
                      "Saved comparison removed.",
                    )
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </article>
          ))}
        </div>
        <p className={c.muted}>
          Opening a setup refreshes SEC data. Evidence below retains the values,
          original settings and sources captured when saved.
        </p>
      </details>
      <div className={c.memo}>
        <label>
          Collection name
          <input
            maxLength={120}
            value={memo.collectionName}
            onChange={(event) =>
              editMemo({ collectionName: event.target.value })
            }
          />
        </label>
        <label>
          Collection research memo
          <textarea
            rows={4}
            maxLength={16000}
            value={memo.notes}
            onChange={(event) => editMemo({ notes: event.target.value })}
            placeholder="What explains the differences, and what still needs review?"
          />
        </label>
        <div className={c.footer}>
          <span role="status">
            {memoConflict
              ? "Conflict: saved collection memo changed elsewhere"
              : memoDraft
                ? "Unsaved collection draft"
                : "Collection fields saved"}
          </span>
          <div className={s.actions}>
            <button
              disabled={
                !memoDraft || memoConflict || !memo.collectionName.trim()
              }
              onClick={() => saveMemo()}
            >
              Save collection memo
            </button>
            {memoDraft && (
              <button onClick={() => setMemoDraft(undefined)}>
                Discard memo draft
              </button>
            )}
          </div>
        </div>
        {memoConflict && (
          <div className={c.conflict}>
            <strong>Latest saved version</strong>
            <p>{savedMemo.collectionName}</p>
            <p>{savedMemo.notes || "No memo"}</p>
            <button
              onClick={() => saveMemo(true)}
              disabled={!memo.collectionName.trim()}
            >
              Keep my memo over this saved version
            </button>
          </div>
        )}
      </div>
      {dirty && (
        <p className={c.draftNotice}>
          Unsaved drafts stay available when you filter observations or switch
          comparison views. Save them before leaving or reloading this page.
        </p>
      )}
      <CompareBriefComposer
        notebook={notebook}
        selectedIds={selectedIds}
        selectionProblem={selectionProblem}
        selectedDrafts={selectedDrafts}
        memoDirty={Boolean(memoDraft)}
        draft={briefDraft}
        setDraft={setBriefDraft}
        commit={commit}
      />
      <div className={c.organizer}>
        <div className={s.sectionHead}>
          <div>
            <h3>Evidence organizer</h3>
            <p>
              {visible.length} of {notebook.pins.length} captured observations
              shown
            </p>
          </div>
          <span className={s.badge}>
            {selectedIds.length} selected
            {hiddenSelected ? ` · ${hiddenSelected} hidden by filters` : ""}
          </span>
        </div>
        <div className={c.filters}>
          <label>
            <span>
              <Search size={13} />
              Search saved evidence
            </span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Company, metric, notes, accession…"
            />
          </label>
          <label>
            Filter company
            <select
              value={company}
              onChange={(event) => setCompany(event.target.value)}
            >
              <option value="">All companies</option>
              {companies.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Filter metric
            <select
              value={metric}
              onChange={(event) => setMetric(event.target.value)}
            >
              <option value="">All metrics</option>
              {metrics.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Filter tag
            <select
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            >
              <option value="">All tags</option>
              {tags.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        <div className={s.actions}>
          <button
            onClick={() => {
              setSearch("");
              setCompany("");
              setMetric("");
              setTag("");
            }}
          >
            Clear filters
          </button>
          <button
            disabled={!visible.length}
            onClick={() =>
              changeSelection({
                ...selected,
                ...Object.fromEntries(
                  visible.map((pin: any) => [pin.id, comparePinSnapshot(pin)]),
                ),
              })
            }
          >
            Select shown observations
          </button>
          <button
            disabled={!selectedIds.length}
            onClick={() => changeSelection({})}
          >
            Clear selection
          </button>
        </div>
        <div className={c.bulk}>
          <label>
            Tags to add to selected observations
            <input
              value={bulkTags}
              maxLength={300}
              onChange={(event) => setBulkTags(event.target.value)}
              placeholder="funding, follow-up"
            />
          </label>
          <button
            disabled={
              !selectedIds.length ||
              !bulkTags.trim() ||
              Boolean(selectionProblem) ||
              Boolean(selectedDrafts)
            }
            onClick={() => bulk("tag")}
          >
            Add tags to {selectedIds.length} selected
          </button>
          <button
            disabled={
              !selectedIds.length ||
              Boolean(selectionProblem) ||
              Boolean(selectedDrafts)
            }
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 size={13} />
            Remove selected
          </button>
        </div>
        {confirmRemove && (
          <div className={c.draftNotice}>
            <p>
              Remove these {selectedIds.length} selected captured observations
              and their saved notes?{" "}
              {hiddenSelected > 0
                ? `${hiddenSelected} are hidden by current filters.`
                : ""}
            </p>
            <div className={s.actions}>
              <button onClick={() => bulk("remove")}>
                Remove these {selectedIds.length} observations
              </button>
              <button onClick={() => setConfirmRemove(false)}>
                Keep observations
              </button>
            </div>
          </div>
        )}
        {selectionProblem && (
          <p className={c.conflict} role="alert">
            {selectionProblem}
          </p>
        )}
        {selectedDrafts > 0 && (
          <p className={c.draftNotice}>
            {selectedDrafts} selected observations have unsaved drafts. Save or
            discard those drafts to use bulk actions or export them.
          </p>
        )}
      </div>
      {message && (
        <p className={c.feedback} role="status">
          {message}
        </p>
      )}
      {!notebook.pins.length ? (
        <p className={s.emptySmall}>
          Choose a value and save it from the evidence inspector to start your
          collection.
        </p>
      ) : !visible.length ? (
        <p className={s.emptySmall}>
          No saved observations match these filters. Clear filters to see the
          full collection.
        </p>
      ) : null}
      <div className={c.evidenceGrid}>
        {visible.map((pin: any) => {
          const draft = drafts[pin.id],
            saved = compareAnnotations(pin),
            values = draft?.values || saved;
          const conflict = Boolean(
            draft && JSON.stringify(draft.base) !== JSON.stringify(saved),
          );
          const index = notebook.pins.findIndex(
            (item: any) => item.id === pin.id,
          );
          return (
            <article key={pin.id} className={c.card}>
              <div className={s.sectionHead}>
                <label className={c.choose}>
                  <input
                    type="checkbox"
                    checked={Boolean(selected[pin.id])}
                    aria-label={`Select ${pin.ticker} ${pin.label} ${pin.point?.period?.end}`}
                    onChange={(event) => {
                      const next = { ...selected };
                      if (event.target.checked)
                        next[pin.id] = comparePinSnapshot(pin);
                      else delete next[pin.id];
                      changeSelection(next);
                    }}
                  />
                  <span>
                    {pin.ticker} / {pin.point?.period?.end || "Unknown period"}
                  </span>
                </label>
                <span className={s.badge}>Order {index + 1}</span>
              </div>
              <h3>{pin.label}</h3>
              <strong className={c.value}>
                {displayValue(pin.point?.value, pin.format)}
              </strong>
              <p className={c.muted}>
                {pin.name}
                <br />
                {pin.point?.period?.kind || pin.settings?.basis} ·{" "}
                {pin.point?.classification || "Unclassified"} · Captured{" "}
                {pin.savedAt?.slice(0, 10)}
                <br />
                Filing cutoff:{" "}
                {pin.settings?.asOf || "Latest available at capture"}
              </p>
              <label>
                Observation notes
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={values.notes}
                  onChange={(event) =>
                    editPin(pin, { notes: event.target.value })
                  }
                />
              </label>
              <label>
                Observation tags
                <input
                  maxLength={300}
                  value={values.tags}
                  onChange={(event) =>
                    editPin(pin, { tags: event.target.value })
                  }
                  placeholder="liquidity, funding, follow-up"
                />
              </label>
              <div className={c.footer}>
                <span role="status">
                  {conflict
                    ? "Conflict: saved annotation changed"
                    : draft
                      ? "Unsaved observation draft"
                      : "Notes and tags saved"}
                </span>
                <div className={s.actions}>
                  <button
                    disabled={!draft || conflict}
                    onClick={() => savePin(pin)}
                  >
                    Save annotation
                  </button>
                  {draft && (
                    <button onClick={() => clearDraft(pin.id)}>
                      Discard annotation draft
                    </button>
                  )}
                </div>
              </div>
              {conflict && (
                <div className={c.conflict}>
                  <strong>Latest saved annotation</strong>
                  <p>Notes: {saved.notes || "None"}</p>
                  <p>Tags: {saved.tags || "None"}</p>
                  <button onClick={() => savePin(pin, true)}>
                    Keep my annotation over this saved version
                  </button>
                </div>
              )}
              <div className={s.actions}>
                <button
                  onClick={() =>
                    inspect({
                      metric: {
                        ...(METRIC_BY_KEY[pin.metric] || {}),
                        ...(pin.metricDefinition || {}),
                        key: pin.metric,
                        label: pin.label,
                        format: pin.format,
                        category:
                          pin.category ||
                          pin.metricDefinition?.category ||
                          METRIC_BY_KEY[pin.metric]?.category,
                      },
                      cell: {
                        ticker: pin.ticker,
                        name: pin.name,
                        cik: pin.cik,
                        period: pin.point?.period,
                        point: pin.point,
                      },
                      settings: pin.settings,
                      capturedAt: pin.savedAt,
                      snapshotName: notebook.collectionName,
                    } as CompareEvidence)
                  }
                >
                  Review saved sources
                </button>
                <button
                  disabled={index === 0}
                  aria-label={`Move ${pin.ticker} ${pin.label} earlier`}
                  onClick={() =>
                    commit(
                      (current) =>
                        reorderComparePins(
                          current,
                          pin.id,
                          -1,
                          notebook.pins.map((item: any) => item.id),
                        ),
                      "Observation moved earlier in the collection.",
                    )
                  }
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  disabled={index === notebook.pins.length - 1}
                  aria-label={`Move ${pin.ticker} ${pin.label} later`}
                  onClick={() =>
                    commit(
                      (current) =>
                        reorderComparePins(
                          current,
                          pin.id,
                          1,
                          notebook.pins.map((item: any) => item.id),
                        ),
                      "Observation moved later in the collection.",
                    )
                  }
                >
                  <ArrowDown size={13} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {orphanDrafts.map(([id, draft]) => (
        <article key={id} className={c.conflict}>
          <h3>
            Draft retained: {draft.ticker} · {draft.label}
          </h3>
          <p>
            The saved observation was removed elsewhere. Your unsaved text
            remains here.
          </p>
          <p>Notes: {draft.values.notes || "None"}</p>
          <p>Tags: {draft.values.tags || "None"}</p>
          <div className={s.actions}>
            <button
              onClick={() =>
                downloadFile(
                  "retained-comparison-annotation.txt",
                  `${draft.ticker} · ${draft.label}\n\nNotes: ${draft.values.notes}\n\nTags: ${draft.values.tags}`,
                  "text/plain;charset=utf-8",
                )
              }
            >
              <Download size={14} />
              Download retained draft
            </button>
            <button onClick={() => clearDraft(id)}>
              Discard retained draft
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
