"use client";

import { useState } from "react";
import { ArrowUpRight, RotateCcw, Target } from "lucide-react";
import {
  goalSeekDefaults,
  goalSeekUnits,
  solveOperatingGoal,
  solveAssetLossGoal,
} from "../../utils/analysisGoalSeek.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./AnalysisGoalSeek.module.css";

export default function AnalysisGoalSeek(props: any) {
  const { data, settings, index } = props;
  const period = data.periods?.[index];
  const context = JSON.stringify([
    data.ticker,
    data.basis,
    period?.kind,
    period?.start,
    period?.end,
    data.asOf ?? settings.asOf,
    data.observedAt,
    settings.units,
  ]);
  return <GoalSeekForm key={context} {...props} />;
}

function GoalSeekForm({ data, settings, index, onInspect }: any) {
  const defaults = goalSeekDefaults(data, index, settings.units);
  const [draft, setDraft] = useState(defaults);
  const [operatingInput, setOperatingInput] = useState<any>(null);
  const [assetInput, setAssetInput] = useState<any>(null);
  const operating = operatingInput
    ? solveOperatingGoal(data, operatingInput, index, settings.units)
    : null;
  const balance = assetInput
    ? solveAssetLossGoal(data, assetInput, index)
    : null;
  const denomination = goalSeekUnits(settings.units).label;
  const period = data.periods?.[index];
  const value = (number: any, format = "currency") =>
    analysisValue(number, format, settings.units);
  const change = (field: string, raw: string, exercise: string) => {
    setDraft((current) => ({ ...current, [field]: raw }));
    if (exercise === "operating") setOperatingInput(null);
    else setAssetInput(null);
  };
  const reset = () => {
    setDraft(defaults);
    setOperatingInput(null);
    setAssetInput(null);
  };
  const inspectSources = (inputs: any[]) => (
    <details className={styles.sources}>
      <summary>Inspect reported baseline inputs</summary>
      <div className={styles.sourceGrid}>
        {inputs.map((input) => (
          <div key={input.key}>
            <span>{input.definition?.label || input.key}</span>
            <button
              type="button"
              onClick={() =>
                onInspect({
                  definition: input.definition || {
                    key: input.key,
                    label: input.key,
                    format: "currency",
                  },
                  point: input.point || {
                    period,
                    value: null,
                    reason: input.reason,
                    sources: [],
                  },
                })
              }
            >
              {value(input.point?.value)}
              <ArrowUpRight size={13} aria-hidden="true" />
            </button>
            {input.reason && <small>{input.reason}</small>}
          </div>
        ))}
      </div>
    </details>
  );
  const numberField = (
    field: string,
    label: string,
    exercise: string,
    help?: string,
  ) => (
    <label>
      {label}
      <input
        type="number"
        step="any"
        name={field}
        value={draft[field]}
        onChange={(event) => change(field, event.target.value, exercise)}
        aria-describedby={help ? `goal-${field}-help` : undefined}
      />
      {help && <small id={`goal-${field}-help`}>{help}</small>}
    </label>
  );
  return (
    <section className={styles.lab} aria-labelledby="goal-seek-heading">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>
            <Target size={14} aria-hidden="true" /> Work backward from a target
          </p>
          <h2 id="goal-seek-heading">What would it take?</h2>
        </div>
        <button type="button" onClick={reset}>
          <RotateCcw size={14} aria-hidden="true" /> Use reported baseline
        </button>
      </div>
      <p className={styles.intro}>
        Choose your own target and solve for the assumption it requires. Every
        result preserves its assumptions and {data.ticker}'s{" "}
        {period?.label || period?.end} source evidence when you collect it in
        the inspector.
      </p>
      <p className={styles.notice}>
        Hypothetical arithmetic. These targets are yours; they are not
        forecasts, probabilities, covenant tests, or regulatory capital
        requirements. Inputs start at the reported baseline and reset when the
        company, period, filing cutoff, or units change.
      </p>

      <div className={styles.exercises}>
        {data.lens === "corporate" && (
          <section
            className={styles.exercise}
            aria-labelledby="operating-goal-heading"
          >
            <h3 id="operating-goal-heading">
              Reach an operating-income target
            </h3>
            <p className={styles.small}>
              Revenue × operating margin = operating income. Hold one assumption
              constant and solve for the other, using the selected reporting
              duration without annualization.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setOperatingInput({
                  mode: form.get("mode"),
                  targetIncome: form.get("targetIncome"),
                  assumedMargin: form.get("assumedMargin"),
                  assumedRevenue: form.get("assumedRevenue"),
                });
              }}
            >
              <div className={styles.controls}>
                <label>
                  Solve for
                  <select
                    name="mode"
                    value={draft.mode}
                    onChange={(event) =>
                      change("mode", event.target.value, "operating")
                    }
                  >
                    <option value="revenue">Required revenue</option>
                    <option value="margin">Required operating margin</option>
                  </select>
                </label>
                {numberField(
                  "targetIncome",
                  `Target operating income (${denomination})`,
                  "operating",
                )}
                {draft.mode === "revenue"
                  ? numberField(
                      "assumedMargin",
                      "Assumed operating margin (%)",
                      "operating",
                      "Held constant as revenue changes; must be positive.",
                    )
                  : numberField(
                      "assumedRevenue",
                      `Assumed revenue (${denomination})`,
                      "operating",
                      "Held constant as operating margin changes; must be positive.",
                    )}
              </div>
              <button type="submit" className={styles.solve}>
                Solve operating target
              </button>
            </form>
            <div aria-live="polite">
              {operating?.reason && (
                <p className={styles.notice}>{operating.reason}</p>
              )}
              {operating?.selection && (
                <div className={styles.result}>
                  <span>
                    {operating.mode === "revenue"
                      ? "Required revenue"
                      : "Required operating margin"}
                  </span>
                  <button
                    type="button"
                    onClick={() => onInspect(operating.selection)}
                    aria-label={`Inspect hypothetical required ${operating.mode === "revenue" ? "revenue" : "operating margin"}`}
                  >
                    {value(
                      operating.selection.point.value,
                      operating.selection.definition.format,
                    )}
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </button>
                  <small>
                    Reported baseline:{" "}
                    {value(
                      operating.baseline,
                      operating.selection.definition.format,
                    )}
                    . Costs are implied by the assumed margin; fixed costs,
                    variable costs, and business feasibility are not modeled.
                  </small>
                </div>
              )}
            </div>
            {inspectSources(
              solveOperatingGoal(data, defaults, index, settings.units).inputs,
            )}
          </section>
        )}

        <section
          className={styles.exercise}
          aria-labelledby="asset-loss-goal-heading"
        >
          <h3 id="asset-loss-goal-heading">Find an asset-loss boundary</h3>
          <p className={styles.small}>
            How much additional asset loss would bring shareholder equity /
            assets to your target? Assets and equity fall dollar-for-dollar. No
            tax benefit, use of existing allowances, or funding changes are
            included.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              setAssetInput({
                targetEquityRatio: form.get("targetEquityRatio"),
              });
            }}
          >
            <div className={styles.controls}>
              {numberField(
                "targetEquityRatio",
                "Your minimum shareholder equity / assets (%)",
                "balance",
                "Enter 0% to below 100%. This is an accounting ratio, not regulatory capital.",
              )}
            </div>
            <button type="submit" className={styles.solve}>
              Solve asset-loss target
            </button>
          </form>
          <div aria-live="polite">
            {balance?.reason && (
              <p className={styles.notice}>{balance.reason}</p>
            )}
            {balance && !balance.reason && (
              <>
                <p className={styles.notice}>
                  {balance.status === "alreadyBelow"
                    ? `Already below your target: the reported ratio is ${value(balance.baselineRatio, "percent")}. Zero additional loss does not restore the target.`
                    : balance.status === "atTarget"
                      ? "The reported ratio is at your target. Any positive loss in this model takes it below the target."
                      : `Reported ratio: ${value(balance.baselineRatio, "percent")}. The loss below brings the modeled ratio to your ${value(balance.target, "percent")} target.`}
                </p>
                <div className={styles.result}>
                  {balance.rows.map((row: any) => (
                    <div key={row.definition.key}>
                      <span>
                        {row.definition.label.replace("Hypothetical ", "")}
                      </span>
                      <button
                        type="button"
                        onClick={() => onInspect(row)}
                        aria-label={`Inspect ${row.definition.label.toLowerCase()}`}
                      >
                        {value(row.point.value, row.definition.format)}
                        <ArrowUpRight size={16} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <p className={styles.small}>
            Formula: loss = (equity − target ratio × assets) / (1 − target
            ratio). Shareholder equity and consolidated assets can differ in
            accounting scope. No probability or ability to absorb a real loss is
            inferred.
          </p>
          {inspectSources(solveAssetLossGoal(data, defaults, index).inputs)}
        </section>
      </div>
    </section>
  );
}
