"use client";

import { useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, BookmarkPlus, RefreshCw } from "lucide-react";
import { analysisValue } from "../../utils/analysisNotebook.js";
import { SCENARIO_CASE_LIMIT, createScenarioCase, scenarioCaseRevision, updateScenarioCases, validateScenarioCases } from "../../utils/analysisScenarioCases.js";
import { buildScenarioRebase } from "../../utils/analysisScenarioRebase.js";
import styles from "./AnalysisScenarioBaselineReview.module.css";

export default function AnalysisScenarioBaselineReview({
  data, settings, index, scenario, cases: storedCases = [], onSaveCases,
  onPatch, onInspect, draftsPending = false, ready = false,
}: any) {
  const [selectedId, setSelectedId] = useState(settings.scenarioCase || "");
  const [metric, setMetric] = useState("operating:OperatingIncome");
  const [message, setMessage] = useState("");
  const [removeId, setRemoveId] = useState("");
  const storage = useMemo(() => {
    try {
      validateScenarioCases(storedCases);
      return { cases: storedCases.filter((entry: any) => entry.context.ticker === data.ticker), error: "" };
    } catch (error: any) { return { cases: [], error: error.message }; }
  }, [storedCases, data.ticker]);
  const reference = storage.cases.find((entry: any) => entry.id === selectedId) || storage.cases.at(-1);
  const comparison = useMemo(() => reference ? buildScenarioRebase({ reference, data, settings, index, scenario }) : null,
    [reference, data, settings, index, scenario]);
  const row = comparison?.rows.find((item: any) => item.key === metric) || comparison?.rows[0];
  const value = (amount: any, format = "currency") => analysisValue(amount, format, settings.units);
  const delta = (amount: any, format: string) => amount === null ? "Unavailable" : `${amount > 0 ? "+" : ""}${format === "percent" ? `${Number(amount.toFixed(2)).toLocaleString()} pp` : value(amount, format)}`;
  const period = data.periods?.[index];
  const saveBlocked = !ready || draftsPending || Boolean(storage.error) || storedCases.length >= SCENARIO_CASE_LIMIT;
  function keep(updated = false) {
    if (saveBlocked || (updated && !comparison?.compatible)) return;
    try {
      const entry = createScenarioCase({
        data, index,
        settings: updated ? comparison!.rebasedSettings : settings,
        scenario: updated ? comparison!.rebasedScenario : scenario,
        name: `${data.ticker} · ${period.end} · ${updated ? "updated baseline" : "baseline"}`,
      });
      let outcome: any;
      const saved = onSaveCases((fresh: any[]) => {
        outcome = updateScenarioCases(fresh || [], { type: "add", id: entry.id, entry });
        return outcome.cases;
      });
      if (!outcome?.ok || !saved) {
        setMessage(outcome?.ok ? "Browser storage could not save this baseline. Existing references are preserved." : outcome?.reason || "The baseline could not be saved.");
        return;
      }
      if (!updated) setSelectedId(entry.id);
      setMessage(updated ? "Updated inputs with the original assumptions saved as a separate reference. The original is unchanged." : "Baseline, assumptions, and source evidence saved in this browser.");
    } catch (error: any) { setMessage(error.message); }
  }
  function removeReference() {
    if (!reference || !ready || storage.error) return;
    try {
      let outcome: any;
      const saved = onSaveCases((fresh: any[]) => {
        outcome = updateScenarioCases(fresh || [], { type: "remove", id: reference.id, expectedRevision: scenarioCaseRevision(reference) });
        return outcome.cases;
      });
      setMessage(outcome?.ok && saved ? "Selected reference removed. Other baselines and the current assumptions are unchanged." : outcome?.reason || "The reference could not be removed.");
      if (outcome?.ok && saved) { setRemoveId(""); setSelectedId(""); }
    } catch (error: any) { setMessage(error.message); }
  }
  const inspectValue = (amount: any, selection: any, label: string, format: string) => selection ? (
    <button type="button" className={styles.sourceValue} onClick={() => onInspect(selection)} aria-label={`Inspect ${label}`}>
      {value(amount, format)} <ArrowUpRight size={13} aria-hidden="true" />
    </button>
  ) : <span>{value(amount, format)}</span>;

  return (
    <div className={styles.review}>
      <p className={styles.intro}>Keep a dated reference, then see what changed in the reported inputs and what changed in your assumptions. Every saved reference retains its original evidence.</p>
      <div className={styles.controls}>
        {reference && <label className={styles.reference}>Saved reference
          <select value={reference.id} onChange={(event) => { setSelectedId(event.target.value); setRemoveId(""); }}>
            {storage.cases.map((entry: any) => <option key={entry.id} value={entry.id}>{entry.name} · saved {entry.createdAt.slice(0, 10)} {entry.createdAt.slice(11, 19)} UTC</option>)}
          </select>
        </label>}
        <div className={styles.actions}>
          <button type="button" onClick={() => keep()} disabled={saveBlocked}><BookmarkPlus size={14} aria-hidden="true" /> Keep current baseline</button>
          <button type="button" disabled={draftsPending} onClick={() => {
            if (onPatch({ end: "latest", asOf: "" }) !== false) setMessage("Latest available filings selected. Your saved reference is preserved; the comparison updates when the selected data arrives.");
          }}><RefreshCw size={14} aria-hidden="true" /> Use latest filings</button>
        </div>
      </div>
      {draftsPending && <p className={styles.notice}>Apply or discard your assumption edits before saving a reference or changing its reporting context. The comparison uses applied assumptions.</p>}
      {storedCases.length >= SCENARIO_CASE_LIMIT && <p className={styles.notice}>All eight reference slots are occupied. You can still compare every reference, or remove one below to make room.</p>}
      {storage.error && <p className={styles.notice} role="alert">{storage.error} Existing stored records have not been changed.</p>}
      {!reference && !storage.error && <div className={styles.empty}><BookmarkPlus size={22} aria-hidden="true" /><p>Keep this baseline before the next filing.<span>You can return to the original figures and assumptions when new SEC data arrives.</span></p></div>}
      {comparison && !comparison.compatible && <p className={styles.notice}>{comparison.reason}</p>}
      {comparison?.compatible && <>
        <div className={styles.comparisonHeading}>
          <div><span className={styles.eyebrow}>{comparison.status}</span><p>{reference.context.period.end} <ArrowRight size={12} aria-hidden="true" /> {period.end}<span> · {settings.basis}</span></p></div>
          <label className={styles.metric}>Outcome<select value={row?.key || ""} onChange={(event) => setMetric(event.target.value)}>{comparison.rows.map((item: any) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
        </div>
        {row && <>
          <div className={styles.stages}>
            <article><span className={styles.step}>01</span><h4>Original reference</h4>{inspectValue(row.original, row.originalSelection, `${row.label}, original reference`, row.format)}<p>Saved inputs + saved assumptions</p></article>
            <article><span className={styles.step}>02</span><h4>Update the data</h4>{inspectValue(row.rebased, row.rebasedSelection, `${row.label}, current inputs and saved assumptions`, row.format)}<p>Current inputs + saved assumptions</p></article>
            <article><span className={styles.step}>03</span><h4>Update assumptions</h4>{inspectValue(row.current, row.currentSelection, `${row.label}, current inputs and assumptions`, row.format)}<p>Current inputs + current assumptions</p></article>
          </div>
          <div className={styles.attribution} aria-label={`${row.label} change attribution`}>
            <div><span>Reported-data effect</span><strong>{delta(row.dataChange, row.format)}</strong></div><span className={styles.operator} aria-hidden="true">+</span>
            <div><span>Assumption effect</span><strong>{delta(row.assumptionChange, row.format)}</strong></div><span className={styles.operator} aria-hidden="true">=</span>
            <div><span>Total change</span><strong>{delta(row.totalChange, row.format)}</strong></div>
          </div>
          {(row.dataReason || row.assumptionReason) && <p className={styles.notice}>{[...new Set([row.dataReason, row.assumptionReason].filter(Boolean))].join(" ")}</p>}
        </>}
        <p className={styles.note}>{comparison.note}</p>
        <details className={styles.allResults}>
          <summary>All outcomes and source evidence</summary>
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Baseline comparison outcomes">
            <table><caption>Hypothetical outcomes: update reported inputs first, then assumptions. Select a value to inspect its original source context.</caption><thead><tr><th scope="col">Outcome</th><th scope="col">Original</th><th scope="col">Updated data</th><th scope="col">Current</th><th scope="col">Data effect</th><th scope="col">Assumption effect</th></tr></thead><tbody>
              {comparison.rows.map((item: any) => <tr key={item.key}><th scope="row">{item.label}{(item.dataReason || item.assumptionReason) && <small>{[...new Set([item.dataReason, item.assumptionReason].filter(Boolean))].join(" ")}</small>}</th><td>{inspectValue(item.original, item.originalSelection, `${item.label}, original reference`, item.format)}</td><td>{inspectValue(item.rebased, item.rebasedSelection, `${item.label}, current inputs and saved assumptions`, item.format)}</td><td>{inspectValue(item.current, item.currentSelection, `${item.label}, current inputs and assumptions`, item.format)}</td><td>{delta(item.dataChange, item.format)}</td><td>{delta(item.assumptionChange, item.format)}</td></tr>)}
            </tbody></table>
          </div>
        </details>
        <div className={styles.footer}><p>Original observed {reference.context.observedAt?.slice(0, 10) || "date unavailable"} · current observed {data.observedAt?.slice(0, 10) || "date unavailable"}. Saved only in this browser.</p><button type="button" disabled={saveBlocked} onClick={() => keep(true)} title="Save current reported inputs with the original reference assumptions as a new reference"><BookmarkPlus size={14} aria-hidden="true" /> Keep updated baseline</button></div>
      </>}
      {reference && <div className={styles.actions}>{removeId === reference.id ? <><span className={styles.note}>Remove this saved reference and its retained evidence?</span><button type="button" disabled={!ready} onClick={removeReference}>Remove reference</button><button type="button" onClick={() => setRemoveId("")}>Keep reference</button></> : <button type="button" disabled={!ready || Boolean(storage.error)} onClick={() => setRemoveId(reference.id)}>Remove selected reference…</button>}</div>}
      {message && <p className={styles.status} role="status">{message}</p>}
    </div>
  );
}
