"use client";
import { useState } from "react";
import { ArrowUpRight, Pencil, Plus, Trash2 } from "lucide-react";
import { analysisValue } from "../../utils/analysisNotebook.js";
import {
  evaluateAnalysisRules,
  RULE_BASES,
  RULE_MODES,
  validateAnalysisRules,
} from "../../utils/analysisRules.js";
import styles from "./AnalysisThresholds.module.css";

export default function AnalysisThresholds({
  data,
  settings,
  index,
  rules = [],
  onSave,
  onInspect,
  onPatch,
  ready,
}: any) {
  const [editing, setEditing] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState("");
  const [mode, setMode] = useState("below");
  const [status, setStatus] = useState("");
  const definitions = data.definitions.filter((d) =>
    ["currency", "shares", "eps", "percent", "decimal", "days"].includes(
      d.format,
    ),
  );
  const chosen = definitions.find((d) => d.key === metric) || definitions[0];
  const results: any[] = evaluateAnalysisRules(data, settings, index, rules);
  const unit =
    chosen?.format === "currency"
      ? "USD"
      : chosen?.format === "percent"
        ? mode.startsWith("change")
          ? "percentage points"
          : "percent"
        : chosen?.format === "decimal"
          ? "multiple (×)"
          : chosen?.format === "eps"
            ? "USD per share"
            : chosen?.format;
  function edit(rule: any = null) {
    setEditing(rule);
    setMetric(rule?.metric || definitions[0]?.key || "");
    setMode(rule?.mode || "below");
    setOpen(true);
    setStatus("");
  }
  return (
    <section
      className={styles.panel}
      aria-labelledby="analysis-thresholds-heading"
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Your research criteria</p>
          <h2 id="analysis-thresholds-heading">
            Personal financial thresholds
          </h2>
        </div>
        <button disabled={!ready || rules.length >= 20} onClick={() => edit()}>
          <Plus size={15} /> Add threshold
        </button>
      </div>
      <p className={styles.intro}>
        Choose what deserves your attention. Conditions are checked against the
        selected period and filing cutoff whenever you open this view. Saved in
        this browser; no background checks or notifications.
      </p>
      <p className={styles.note}>
        A condition met is your prompt to investigate, not a risk rating or a
        covenant test. Equality does not meet a strict “above” or “below”
        condition. Change means an absolute change, with percentage points for
        percentage metrics.
      </p>
      {open && (
        <form
          key={`${editing?.id || "new"}:${editing?.updatedAt || ""}`}
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const raw = String(fields.get("threshold") || "").trim();
            const scale =
              chosen?.format === "currency" ? Number(fields.get("scale")) : 1;
            if (!raw || !Number.isFinite(Number(raw) * scale)) {
              setStatus("Enter a finite threshold.");
              return;
            }
            const next = {
              id: editing?.id || crypto.randomUUID(),
              label: String(fields.get("label") || "").trim() || chosen.label,
              metric: chosen.key,
              format: chosen.format,
              basis: String(fields.get("basis")),
              mode,
              baseline: String(fields.get("baseline") || "year"),
              threshold: Number(raw) * scale,
              updatedAt: new Date().toISOString(),
            };
            try {
              validateAnalysisRules([next]);
            } catch (error) {
              setStatus((error as Error).message);
              return;
            }
            let conflict = false;
            const ok = onSave((current) => {
              const latest = current.find((r) => r.id === editing?.id);
              if (
                editing &&
                (!latest || latest.updatedAt !== editing.updatedAt)
              ) {
                conflict = true;
                return current;
              }
              const updated = editing
                ? current.map((r) => (r.id === editing.id ? next : r))
                : [...current, next];
              validateAnalysisRules(updated);
              return updated;
            });
            if (conflict) {
              setStatus(
                "This threshold changed in another view. Your draft is still here; cancel and reopen the latest version before saving.",
              );
              return;
            }
            if (ok) {
              setOpen(false);
              setEditing(null);
              setStatus("Threshold saved.");
            } else setStatus("Could not save. Your draft remains here.");
          }}
        >
          <label>
            Threshold name
            <input
              name="label"
              maxLength={160}
              defaultValue={editing?.label || ""}
              placeholder="What do you want to investigate?"
            />
          </label>
          <label>
            Financial metric
            <select
              value={chosen?.key || ""}
              onChange={(e) => setMetric(e.target.value)}
            >
              {definitions.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reporting basis
            <select
              name="basis"
              defaultValue={editing?.basis || settings.basis}
            >
              {Object.entries(RULE_BASES).map(([key, label]) => (
                <option key={key} value={key}>
                  {label as string}
                </option>
              ))}
            </select>
          </label>
          <label>
            Condition
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              {Object.entries(RULE_MODES).map(([key, label]) => (
                <option key={key} value={key}>
                  {label as string}
                </option>
              ))}
            </select>
          </label>
          <label>
            Threshold ({unit})
            <input
              key={chosen?.key}
              name="threshold"
              type="number"
              step="any"
              required
              defaultValue={
                editing?.metric === chosen?.key ? editing.threshold : ""
              }
            />
          </label>
          {chosen?.format === "currency" && (
            <label>
              Dollar scale
              <select name="scale" defaultValue="1">
                <option value="1">Dollars</option>
                <option value="1000000">Millions of dollars</option>
                <option value="1000000000">Billions of dollars</option>
              </select>
            </label>
          )}
          {mode.startsWith("change") && (
            <label>
              Compare with
              <select
                name="baseline"
                defaultValue={editing?.baseline || "year"}
              >
                <option value="year">Same fiscal season last year</option>
                <option value="previous">Previous comparable period</option>
              </select>
            </label>
          )}
          <div className={styles.actions}>
            <button type="submit" disabled={!ready}>
              Save threshold
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setStatus("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {!rules.length && !open && (
        <p className={styles.empty}>
          Start with a figure that matters to your research, such as cash
          conversion, operating margin, or equity relative to assets.
        </p>
      )}
      {results.length > 0 && (
        <div className={styles.list}>
          {results.map((result) => (
            <article className={styles.rule} key={result.rule.id}>
              <div className={styles.ruleTitle}>
                <h3>{result.rule.label}</h3>
                <span className={styles[result.status]}>
                  {result.status === "matched"
                    ? "Condition met"
                    : result.status === "clear"
                      ? "Condition not met"
                      : "Unavailable"}
                </span>
              </div>
              <p>
                {result.definition?.label || result.rule.metric} ·{" "}
                {RULE_BASES[result.rule.basis]} · {RULE_MODES[result.rule.mode]}{" "}
                {analysisValue(result.threshold, result.format, settings.units)}
                {result.rule.mode.startsWith("change")
                  ? ` · ${result.rule.baseline === "year" ? "same season last year" : "previous comparable period"}`
                  : ""}
              </p>
              <div className={styles.actions}>
                {result.selection && (
                  <button onClick={() => onInspect(result.selection)}>
                    Inspect checked figure:{" "}
                    {analysisValue(
                      result.measuredValue,
                      result.format,
                      settings.units,
                    )}{" "}
                    <ArrowUpRight size={13} />
                  </button>
                )}
                {result.rule.basis !== settings.basis && (
                  <button
                    onClick={() =>
                      onPatch({ basis: result.rule.basis, end: "latest" })
                    }
                  >
                    Use {RULE_BASES[result.rule.basis]}
                  </button>
                )}
                <button
                  aria-label={`Edit threshold ${result.rule.label}`}
                  onClick={() => edit(result.rule)}
                  disabled={!ready}
                >
                  <Pencil size={13} /> Edit
                </button>
                <button
                  aria-label={`Delete threshold ${result.rule.label}`}
                  disabled={!ready}
                  onClick={() => {
                    let conflict = false;
                    const ok = onSave((current) => {
                      const latest = current.find(
                        (r) => r.id === result.rule.id,
                      );
                      if (
                        !latest ||
                        latest.updatedAt !== result.rule.updatedAt
                      ) {
                        conflict = true;
                        return current;
                      }
                      return current.filter((r) => r.id !== result.rule.id);
                    });
                    setStatus(
                      conflict
                        ? "This threshold changed in another view. Review its latest version before deleting."
                        : ok
                          ? "Threshold deleted."
                          : "Could not delete the threshold.",
                    );
                  }}
                >
                  <Trash2 size={13} /> Delete
                </button>
              </div>
              {result.reason && <p className={styles.note}>{result.reason}</p>}
              <small>
                Checked period:{" "}
                {result.period?.label || result.period?.end || "Unavailable"} ·
                Cutoff: {result.asOf || "Latest available filings"}
              </small>
            </article>
          ))}
        </div>
      )}
      {status && (
        <p className={styles.status} role="status">
          {status}
        </p>
      )}
    </section>
  );
}
