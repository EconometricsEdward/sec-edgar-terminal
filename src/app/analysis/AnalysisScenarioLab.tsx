"use client";
import { ArrowUpRight, Check, RotateCcw } from "lucide-react";
import { SCENARIO_LIMITS } from "../../utils/analysisScenarios.js";
import { SCENARIO_FIELDS } from "../../utils/analysisScenarioEditing.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./AnalysisScenarioWorkspace.module.css";

export default function AnalysisScenarioLab({
  settings,
  scenario,
  drafts,
  errors,
  onDraft,
  onApply,
  onDiscard,
  onInspect,
}: any) {
  const value = (amount: any, format = "currency") =>
    analysisValue(amount, format, settings.units);
  const dirty = Object.keys(drafts).length > 0;
  const model = drafts.scenarioModel ?? scenario.settings.scenarioModel;
  const control = (key: string, help: string) => {
    const field = SCENARIO_FIELDS[key];
    const [min, max] = SCENARIO_LIMITS[key];
    const raw = drafts[key] ?? String(scenario.settings[key]);
    const numeric = Number(raw);
    return (
      <div className={styles.control} key={key}>
        <label htmlFor={`scenario-${key}`}>
          {field.label} <span>({field.unit})</span>
        </label>
        <input
          id={`scenario-${key}`}
          type="text"
          inputMode="decimal"
          value={raw}
          onChange={(e) => onDraft(key, e.target.value)}
          aria-invalid={!!errors[key]}
          aria-describedby={`scenario-help-${key}`}
          autoComplete="off"
        />
        <input
          type="range"
          min={min}
          max={max}
          step={0.25}
          value={
            Number.isFinite(numeric) && raw.trim()
              ? Math.min(max, Math.max(min, numeric))
              : scenario.settings[key]
          }
          onChange={(e) => onDraft(key, e.target.value)}
          aria-label={`${field.label} slider`}
          aria-valuetext={`${raw} ${field.unit}`}
        />
        <p id={`scenario-help-${key}`}>{errors[key] || help}</p>
        {errors[key] && (
          <small>
            Supported range: {min} to {max} {field.unit}.
          </small>
        )}
      </div>
    );
  };
  const results = (exercise: any) =>
    exercise.reason ? (
      <p className={styles.notice} role="status">
        {exercise.reason}
      </p>
    ) : (
      <div className={styles.tableScroll}>
        <table>
          <caption>
            Committed assumptions · inspect any hypothetical result for its
            formula and SEC inputs
          </caption>
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col">Reported baseline</th>
              <th scope="col">Hypothetical</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {exercise.rows.map((row: any) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{value(row.baseline, row.format)}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => onInspect(row.selection)}
                    aria-label={`Inspect hypothetical ${row.label.toLowerCase()}`}
                  >
                    {value(row.selection.point.value, row.format)}
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </button>
                </td>
                <td>
                  {Number.isFinite(row.baseline) &&
                  Number.isFinite(row.selection.point.value)
                    ? value(
                        row.selection.point.value - row.baseline,
                        row.format === "percent"
                          ? "percentagePoints"
                          : row.format,
                      )
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <section
      className={styles.editor}
      aria-label="Scenario assumptions and results"
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Build a testable case</p>
          <h3>Assumptions you can explain</h3>
        </div>
        <span className={styles.badge}>
          {dirty ? "Unapplied edits" : "Results up to date"}
        </span>
      </div>
      <p className={styles.muted}>
        Edit assumptions, then apply them together. Every result below uses the
        last applied values. Operating and balance-sheet exercises are
        independent.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onApply();
        }}
      >
        {scenario.operating && (
          <fieldset className={styles.fieldset}>
            <legend>Operating sensitivity</legend>
            <label className={styles.modelChoice} htmlFor="scenario-model">
              Operating model
              <select
                id="scenario-model"
                value={model}
                onChange={(e) => onDraft("scenarioModel", e.target.value)}
              >
                <option value="margin">Revenue and operating margin</option>
                <option value="cost">Fixed and variable operating costs</option>
              </select>
            </label>
            <p className={styles.muted}>
              {model === "cost"
                ? "Implied costs are reported revenue less operating income. You choose the variable share; fixed costs hold constant before the cost-change assumption. This split is a modeling assumption."
                : "Change revenue and add percentage points to the reported operating margin. The resulting costs are implied by those assumptions."}
            </p>
            <div className={styles.controls}>
              {control(
                "scenarioRevenue",
                "Relative change from reported revenue; price and volume are not separated.",
              )}
              {model === "cost" ? (
                <>
                  {control(
                    "scenarioVariableCost",
                    "Share of implied baseline costs that moves proportionately with revenue. The remainder is fixed.",
                  )}
                  {control(
                    "scenarioCostChange",
                    "Applies to both fixed and volume-adjusted variable costs. The margin-change assumption is inactive.",
                  )}
                </>
              ) : (
                control(
                  "scenarioMargin",
                  "Percentage points added to operating income / revenue; distinct from a percentage change.",
                )
              )}
            </div>
          </fieldset>
        )}
        <fieldset className={styles.fieldset}>
          <legend>
            {scenario.banking
              ? "Asset loss and bank funding"
              : "Asset loss and shareholder equity"}
          </legend>
          <div className={styles.controls}>
            {control(
              "scenarioLoss",
              "A new noncash write-down charged fully to shareholder equity, with no tax benefit or allowance absorption.",
            )}
            {scenario.banking && (
              <>
                {control(
                  "scenarioFunding",
                  "Share of baseline deposits withdrawn. Payment is limited to usable cash plus the borrowing assumption below.",
                )}
                {control(
                  "scenarioCashAvailable",
                  "Only this share of reported cash can fund withdrawals. Remaining cash stays on the balance sheet.",
                )}
                {control(
                  "scenarioReplacementFunding",
                  "Explicit new borrowing, measured against baseline deposits. It increases cash, assets and debt, not deposits or equity. Availability and interest cost are not modeled.",
                )}
              </>
            )}
          </div>
        </fieldset>
        <div className={styles.applyBar}>
          <button className={styles.primary} type="submit" disabled={!dirty}>
            <Check size={15} aria-hidden="true" />
            Apply assumptions
          </button>
          <button type="button" disabled={!dirty} onClick={onDiscard}>
            <RotateCcw size={14} aria-hidden="true" />
            Discard edits
          </button>
          <span>
            {dirty
              ? "Unsaved assumption drafts do not affect calculations or exports."
              : "You can share these applied assumptions using the page URL."}
          </span>
        </div>
      </form>
      {scenario.operating && (
        <section
          className={styles.results}
          aria-labelledby="scenario-operating-results"
        >
          <h3 id="scenario-operating-results">
            Operating results ·{" "}
            {scenario.settings.scenarioModel === "cost"
              ? "cost model"
              : "margin model"}
          </h3>
          {results(scenario.operating)}
          {scenario.operating.costs && (
            <p className={styles.muted}>
              Baseline fixed costs: {value(scenario.operating.costs.fixed)} ·
              variable costs: {value(scenario.operating.costs.variable)} ·
              hypothetical total costs:{" "}
              {value(scenario.operating.costs.hypothetical)}
            </p>
          )}
        </section>
      )}
      <section
        className={styles.results}
        aria-labelledby="scenario-balance-results"
      >
        <h3 id="scenario-balance-results">Balance-sheet results</h3>
        <div className={styles.totals}>
          <span>
            Assumed asset loss <strong>{value(scenario.balance.loss)}</strong>
          </span>
          {scenario.banking && (
            <>
              <span>
                Usable starting cash{" "}
                <strong>{value(scenario.balance.usableCash)}</strong>
              </span>
              <span>
                New borrowing{" "}
                <strong>{value(scenario.balance.borrowing)}</strong>
              </span>
              <span>
                Deposit payments{" "}
                <strong>{value(scenario.balance.withdrawal)}</strong>
              </span>
            </>
          )}
        </div>
        {results(scenario.balance)}
        {(scenario.balance.fundingGap ?? 0) > 0 && (
          <p className={styles.notice}>
            Unfunded withdrawal amount:{" "}
            <strong>{value(scenario.balance.fundingGap)}</strong>. Ending
            balances are unavailable until funding assumptions cover the
            payment.
          </p>
        )}
        {scenario.banking && !scenario.balance.funding?.available && (
          <p className={styles.muted}>{scenario.balance.funding?.reason}</p>
        )}
        <p className={styles.muted}>{scenario.balance.note}</p>
      </section>
      {scenario.diagnostics
        .filter((item: any) => item.status !== "error")
        .map((item: any) => (
          <p key={item.key} className={styles.notice}>
            {item.message}
          </p>
        ))}
      <details className={styles.method}>
        <summary>Read the modeling boundaries</summary>
        <p>
          These are hypothetical arithmetic exercises, not forecasts or
          probabilities. Operating income does not flow into the separate
          balance exercise. Neither model estimates net income, cash flow,
          taxes, interest expense, collateral needs, borrowing capacity,
          management responses, covenant compliance or regulatory capital.
          Equity means reported shareholder equity. Negative equity is shown as
          arithmetic.
        </p>
        <p>
          Control ranges limit the exercise, not the range of possible real
          outcomes. An unavailable input remains unavailable. Inspect results to
          review each equation and the original SEC source inputs.
        </p>
      </details>
    </section>
  );
}
