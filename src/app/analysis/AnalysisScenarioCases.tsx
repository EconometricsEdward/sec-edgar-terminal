"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BookmarkPlus,
  Copy,
  Download,
  FileText,
  Save,
  Trash2,
} from "lucide-react";
import { analysisValue } from "../../utils/analysisNotebook.js";
import { downloadText } from "../../utils/download.js";
import {
  SCENARIO_CASE_LIMIT,
  createScenarioCase,
  scenarioCaseCompatibility,
  scenarioCaseRestoreSettings,
  scenarioCaseRevision,
  scenarioCaseRows,
  scenarioCaseSelection,
  updateScenarioCases,
  validateScenarioCases,
} from "../../utils/analysisScenarioCases.js";
import {
  buildScenarioBrief,
  scenarioBriefCsv,
  scenarioBriefHtml,
} from "../../utils/analysisScenarioBrief.js";
import styles from "./AnalysisScenarioCases.module.css";

function CaseCard({
  entry,
  current,
  selected,
  onSelect,
  onAction,
  onPatch,
  onInspect,
  onPreview,
  units,
  draftsPending,
}: any) {
  const [draft, setDraft] = useState(() => ({
    name: entry.name,
    notes: entry.notes,
    revision: scenarioCaseRevision(entry),
  }));
  const [status, setStatus] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const changed = draft.revision !== scenarioCaseRevision(entry);
  const dirty = draft.name !== entry.name || draft.notes !== entry.notes;
  const compatibility = current
    ? scenarioCaseCompatibility(current, entry)
    : null;
  const value = (amount: any, format = "currency") =>
    analysisValue(amount, format, units);
  const resetDraft = () => {
    setDraft({
      name: entry.name,
      notes: entry.notes,
      revision: scenarioCaseRevision(entry),
    });
    setStatus("Saved name and notes loaded.");
  };
  const save = (event: any) => {
    event.preventDefault();
    const next = {
      ...entry,
      name: draft.name.trim(),
      notes: draft.notes,
      updatedAt: new Date().toISOString(),
    };
    const result = onAction({
      type: "update",
      id: entry.id,
      expectedRevision: draft.revision,
      entry: next,
    });
    setStatus(result.reason);
    if (result.ok)
      setDraft({
        name: next.name,
        notes: next.notes,
        revision: scenarioCaseRevision(next),
      });
  };
  return (
    <article className={styles.case}>
      <div className={styles.cardHeading}>
        <label className={styles.selectCase}>
          <input type="checkbox" checked={selected} onChange={onSelect} />
          <span>
            <strong>{entry.name}</strong>
            <small>Include in comparison and brief</small>
          </span>
        </label>
        <span className={styles.badge} data-match={compatibility?.compatible}>
          {compatibility?.status || "Saved snapshot"}
        </span>
      </div>
      <p className={styles.context}>
        {entry.context.basis} · {entry.context.period.start || "Instant"} →{" "}
        {entry.context.period.end} · cutoff{" "}
        {entry.context.asOf || "latest when saved"}
        <br />
        Observed {entry.context.observedAt || "date unavailable"} · saved{" "}
        {entry.createdAt.slice(0, 10)}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => {
            if (onPatch(scenarioCaseRestoreSettings(entry)) !== false)
              setStatus(
                "Assumptions and reporting context restored. Live results recalculate from available SEC data; this saved snapshot is preserved.",
              );
            else
              setStatus(
                "The case was not restored. Apply or discard pending assumption edits, then restore it again.",
              );
          }}
        >
          Restore assumptions
        </button>
        <button
          type="button"
          disabled={draftsPending}
          onClick={() => onPreview([entry])}
        >
          <FileText size={14} aria-hidden="true" /> Preview saved brief
        </button>
        <button
          type="button"
          disabled={draftsPending}
          onClick={() => {
            const now = new Date().toISOString();
            const id = `scenario_${crypto.randomUUID()}`;
            const result = onAction({
              type: "add",
              id,
              entry: {
                ...entry,
                id,
                name: `${draft.name.trim()} copy`,
                notes: draft.notes,
                createdAt: now,
                updatedAt: now,
              },
            });
            setStatus(result.reason);
          }}
        >
          <Copy size={14} aria-hidden="true" /> Duplicate case
        </button>
      </div>
      <details className={styles.details}>
        <summary>Edit name and notes{dirty ? " · unsaved edits" : ""}</summary>
        <form onSubmit={save} className={styles.form}>
          <label>
            Case name
            <input
              value={draft.name}
              maxLength={120}
              required
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <label>
            Case notes
            <textarea
              value={draft.notes}
              maxLength={8000}
              rows={4}
              onChange={(event) =>
                setDraft({ ...draft, notes: event.target.value })
              }
            />
          </label>
          {changed && (
            <p className={styles.warning} role="status">
              This case changed in another tab. Your draft is kept. Copy any
              draft text you need, then load the saved version before editing
              again.
            </p>
          )}
          <div className={styles.actions}>
            <button type="submit" disabled={draftsPending || changed || !dirty}>
              <Save size={14} aria-hidden="true" /> Save name and notes
            </button>
            {(changed || dirty) && (
              <button type="button" onClick={resetDraft}>
                Load saved name and notes
              </button>
            )}
          </div>
          <small>
            Saved assumptions, financial inputs, and results stay fixed. Save
            current results as a new case to capture another calculation.
          </small>
        </form>
      </details>
      <details className={styles.details}>
        <summary>Inspect original results and inputs</summary>
        {[entry.snapshot.operating, entry.snapshot.balance]
          .filter(Boolean)
          .map((exercise: any, exerciseIndex: number) => (
            <div key={exerciseIndex}>
              {exercise.reason && (
                <p className={styles.warning}>{exercise.reason}</p>
              )}
              <div className={styles.savedResults}>
                {exercise.rows.map((row: any) => (
                  <button
                    key={row.key}
                    type="button"
                    onClick={() =>
                      onInspect(scenarioCaseSelection(entry, row.selection))
                    }
                  >
                    <span>{row.label}</span>
                    <strong>
                      {value(row.selection.point.value, row.format)}{" "}
                      <ArrowUpRight size={12} aria-hidden="true" />
                    </strong>
                  </button>
                ))}
              </div>
              <div className={styles.savedInputs}>
                {exercise.inputs.map((input: any) => (
                  <button
                    key={input.key}
                    type="button"
                    onClick={() =>
                      onInspect(
                        scenarioCaseSelection(entry, {
                          definition: input.definition || {
                            key: input.key,
                            label: input.key,
                            format: "currency",
                          },
                          point: input.point || {
                            value: null,
                            period: entry.context.period,
                            reason: input.reason || "Input unavailable",
                            sources: [],
                          },
                        }),
                      )
                    }
                  >
                    Reported {input.definition?.label || input.key}:{" "}
                    {value(input.point?.value)}{" "}
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ))}
      </details>
      <div className={styles.remove}>
        {confirmRemove ? (
          <>
            <span>Remove this saved case?</span>
            <button
              type="button"
              onClick={() => {
                const result = onAction({
                  type: "remove",
                  id: entry.id,
                  expectedRevision: draft.revision,
                });
                setStatus(result.reason);
              }}
            >
              Remove case
            </button>
            <button type="button" onClick={() => setConfirmRemove(false)}>
              Keep case
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirmRemove(true)}>
            <Trash2 size={13} aria-hidden="true" /> Remove case
          </button>
        )}
      </div>
      {status && (
        <p className={styles.status} role="status">
          {status}
        </p>
      )}
    </article>
  );
}

export default function AnalysisScenarioCases({
  data,
  settings,
  index,
  scenario,
  cases: storedCases = [],
  onSaveCases,
  onPatch,
  onInspect,
  draftsPending = false,
}: any) {
  let storeError = "";
  try {
    validateScenarioCases(storedCases);
    if (storedCases.some((entry: any) => entry.context.ticker !== data.ticker))
      throw new Error("A saved case belongs to a different company.");
  } catch (error: any) {
    storeError = error.message;
  }
  const cases = storeError ? [] : storedCases;
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<string[]>(
    settings.scenarioCase ? [settings.scenarioCase] : [],
  );
  const [brief, setBrief] = useState<any>(null);
  useEffect(() => {
    if (settings.scenarioCase)
      setSelected((ids) =>
        ids.includes(settings.scenarioCase)
          ? ids
          : [...ids, settings.scenarioCase],
      );
  }, [settings.scenarioCase]);
  const currentState = useMemo(() => {
    try {
      return {
        entry: createScenarioCase({
          data,
          settings,
          index,
          scenario,
          name: name.trim() || "Current assumptions",
          notes,
          id: "current",
        }),
        error: "",
      };
    } catch (error: any) {
      return { entry: null, error: error.message };
    }
  }, [data, settings, index, scenario, name, notes]);
  const current = currentState.entry;
  const selectedCases = cases.filter((entry: any) =>
    selected.includes(entry.id),
  );
  const comparable = current
    ? selectedCases.filter(
        (entry: any) => scenarioCaseCompatibility(current, entry).compatible,
      )
    : [];
  const excluded = current
    ? selectedCases.filter(
        (entry: any) => !scenarioCaseCompatibility(current, entry).compatible,
      )
    : selectedCases;
  const comparisonEntries = current ? [current, ...comparable] : [];
  const rows = [
    ...new Map(
      comparisonEntries
        .flatMap((entry: any) => scenarioCaseRows(entry))
        .map((row: any) => [row.comparisonKey, row]),
    ).values(),
  ] as any[];
  const preview = brief ? scenarioBriefHtml(brief) : "";
  const value = (amount: any, format = "currency") =>
    analysisValue(amount, format, settings.units);
  const act = (action: any) => {
    if (draftsPending && action.type !== "remove") {
      const result = {
        ok: false,
        reason:
          "Apply or discard the pending assumption edits before saving a case or changing saved notes.",
      };
      setStatus(result.reason);
      return result;
    }
    let outcome: any;
    try {
      const saved = onSaveCases((fresh: any[]) => {
        outcome = updateScenarioCases(fresh || [], action);
        return outcome.cases;
      });
      const result = !outcome?.ok
        ? {
            ok: false,
            reason:
              outcome?.reason ||
              "Could not update saved cases. Your draft is kept.",
          }
        : !saved
          ? {
              ok: false,
              reason:
                "Browser storage could not save this case. Your draft is kept; preview and download a brief to preserve it.",
            }
          : { ok: true, reason: outcome.reason };
      setStatus(result.reason);
      return result;
    } catch (error: any) {
      const result = {
        ok: false,
        reason: `${error.message || "Could not save this case."} Your draft is kept.`,
      };
      setStatus(result.reason);
      return result;
    }
  };
  const showPreview = (entries: any[]) => {
    if (draftsPending) {
      setStatus(
        "Apply or discard the pending assumption edits before creating or exporting a brief.",
      );
      return;
    }
    try {
      setBrief(buildScenarioBrief(entries));
      setStatus(
        "Brief preview captured. Both downloads contain this exact snapshot, including its notes and source evidence.",
      );
    } catch (error: any) {
      setStatus(error.message);
    }
  };
  return (
    <section className={styles.panel} aria-labelledby="scenario-cases-heading">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>
            <BookmarkPlus size={14} aria-hidden="true" /> Scenario notebook
          </p>
          <h2 id="scenario-cases-heading">
            Save, compare, and explain your cases
          </h2>
        </div>
        <span className={styles.badge}>
          {cases.length} / {SCENARIO_CASE_LIMIT} saved
        </span>
      </div>
      <p className={styles.intro}>
        Keep the assumptions, reported inputs, source dates, and hypothetical
        results together. Cases remain fixed when new filings arrive.
      </p>
      {storeError && (
        <p className={styles.warning} role="alert">
          Saved cases could not be opened: {storeError} Existing data has been
          kept. You can still preview and export the current calculation to
          preserve your draft.
        </p>
      )}
      {draftsPending && (
        <p className={styles.warning} role="status">
          Assumption edits are pending. Apply or discard them before saving a
          case, updating notes, or exporting a brief.
        </p>
      )}
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const entry = createScenarioCase({
              data,
              settings,
              index,
              scenario,
              name,
              notes,
            });
            const result = act({ type: "add", id: entry.id, entry });
            if (result.ok) {
              setName("");
              setNotes("");
              setSelected((ids) => [...ids, entry.id]);
            }
          } catch (error: any) {
            setStatus(error.message);
          }
        }}
      >
        <label>
          Name this case
          <input
            value={name}
            maxLength={120}
            required
            placeholder="Example: volume decline with stable costs"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Thesis and assumptions
          <textarea
            value={notes}
            maxLength={8000}
            rows={3}
            placeholder="What are you testing, and why do these assumptions matter?"
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <div className={styles.actions}>
          <button
            type="submit"
            disabled={
              Boolean(storeError) ||
              draftsPending ||
              !current ||
              cases.length >= SCENARIO_CASE_LIMIT
            }
          >
            <BookmarkPlus size={14} aria-hidden="true" /> Save current case
          </button>
          <button
            type="button"
            disabled={draftsPending || !current}
            onClick={() => current && showPreview([current])}
          >
            <FileText size={14} aria-hidden="true" /> Preview current brief
          </button>
          <small>{notes.length.toLocaleString()} / 8,000 note characters</small>
        </div>
        {cases.length >= SCENARIO_CASE_LIMIT && (
          <p className={styles.warning}>
            Eight cases are saved. Existing cases are kept; remove one before
            saving another, or download the current brief.
          </p>
        )}
        {currentState.error && (
          <p className={styles.warning}>
            The current snapshot cannot be saved: {currentState.error}
          </p>
        )}
      </form>
      <p className={styles.status} role="status" aria-live="polite">
        {status ||
          "Cases and notes save in this browser. Download a brief to share or preserve them elsewhere."}
      </p>
      {cases.length ? (
        <div className={styles.caseList}>
          {cases.map((entry: any) => (
            <CaseCard
              key={entry.id}
              entry={entry}
              current={current}
              selected={selected.includes(entry.id)}
              onSelect={() =>
                setSelected((ids) =>
                  ids.includes(entry.id)
                    ? ids.filter((id) => id !== entry.id)
                    : [...ids, entry.id],
                )
              }
              onAction={act}
              onPatch={onPatch}
              onInspect={onInspect}
              onPreview={showPreview}
              units={settings.units}
              draftsPending={draftsPending}
            />
          ))}
        </div>
      ) : (
        <p className={styles.empty}>
          No saved cases yet. Save a case, change an assumption, then compare
          the outcomes against the same reported baseline.
        </p>
      )}
      <section
        className={styles.comparison}
        aria-labelledby="scenario-comparison-heading"
      >
        <div className={styles.heading}>
          <h3 id="scenario-comparison-heading">
            Compare with current assumptions
          </h3>
          <button
            type="button"
            disabled={draftsPending || !current}
            onClick={() => current && showPreview([current, ...selectedCases])}
          >
            <FileText size={14} aria-hidden="true" /> Preview comparison brief
          </button>
        </div>
        <p className={styles.small}>
          Select saved cases above. Only matching reported periods, filing
          cutoffs, financial data versions, and source inputs share this
          comparison.
        </p>
        {excluded.length > 0 && (
          <ul className={styles.warning}>
            {excluded.map((entry: any) => (
              <li key={entry.id}>
                {entry.name}:{" "}
                {current
                  ? scenarioCaseCompatibility(current, entry).status
                  : "Current comparison unavailable"}
                . Its original results remain inspectable above and appear
                separately in the comparison brief.
              </li>
            ))}
          </ul>
        )}
        <div className={styles.tableScroll}>
          <table>
            <caption>
              Reported baseline and hypothetical outcomes ·{" "}
              {settings.units === "raw" ? "full USD" : settings.units} display
            </caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">Reported baseline</th>
                {comparisonEntries.map((entry: any) => (
                  <th key={entry.id} scope="col">
                    {entry.id === "current"
                      ? "Current assumptions"
                      : entry.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any) => (
                <tr key={row.comparisonKey}>
                  <th scope="row">{row.label}</th>
                  <td>{value(row.baseline, row.format)}</td>
                  {comparisonEntries.map((entry: any) => {
                    const result = scenarioCaseRows(entry).find(
                      (candidate: any) =>
                        candidate.comparisonKey === row.comparisonKey,
                    );
                    return (
                      <td key={entry.id}>
                        {result ? (
                          <button
                            type="button"
                            onClick={() =>
                              onInspect(
                                scenarioCaseSelection(entry, result.selection),
                              )
                            }
                          >
                            {value(result.selection.point.value, result.format)}{" "}
                            <ArrowUpRight size={12} aria-hidden="true" />
                          </button>
                        ) : (
                          <span title="This measure is unavailable for this case or its selected operating model.">
                            Unavailable
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!selectedCases.length && (
          <p className={styles.small}>
            Choose saved cases to add comparison columns.
          </p>
        )}
      </section>
      {brief && (
        <section
          className={styles.preview}
          aria-labelledby="scenario-brief-heading"
        >
          <div className={styles.heading}>
            <div>
              <h3 id="scenario-brief-heading">Scenario brief preview</h3>
              <p className={styles.small}>
                Captured {brief.exportedAt}. Changes made after this preview
                require a new preview.
              </p>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={draftsPending}
                onClick={() =>
                  downloadText(
                    `${data.ticker}-scenario-brief.html`,
                    preview,
                    "text/html",
                  )
                }
              >
                <Download size={14} aria-hidden="true" /> Download HTML
              </button>
              <button
                type="button"
                disabled={draftsPending}
                onClick={() =>
                  downloadText(
                    `${data.ticker}-scenario-brief.csv`,
                    scenarioBriefCsv(brief),
                    "text/csv",
                  )
                }
              >
                <Download size={14} aria-hidden="true" /> Download CSV
              </button>
              <button type="button" onClick={() => setBrief(null)}>
                Close preview
              </button>
            </div>
          </div>
          <iframe
            title="Exact scenario brief preview"
            srcDoc={preview}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            className={styles.previewFrame}
          />
        </section>
      )}
    </section>
  );
}
