"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, RotateCcw, Target } from "lucide-react";
import {
  GOAL_SEEK_DEFAULTS,
  goalSeekInput,
  goalSeekDraft,
  goalSeekDraftPatch,
  isGoalNumericDraft,
  goalSeekUnits,
  solveOperatingGoal,
  solveAssetLossGoal,
  operatingGoalApplication,
  assetLossGoalApplication,
  buildScenarioHeadroom,
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

function GoalSeekForm({
  data,
  settings,
  index,
  onInspect,
  onPatch,
  onApply,
}: any) {
  const storedInput = goalSeekInput(data, index, settings);
  const displayDraft = goalSeekDraft(data, index, settings, settings.units);
  const signature = JSON.stringify(displayDraft);
  const [draft, setDraft] = useState<any>(displayDraft);
  const [dirty, setDirty] = useState<string[]>([]);
  // Saved setups and shared URLs can replace targets while this panel remains
  // mounted. Only persisted target changes refresh drafts, not a solve flag.
  useEffect(() => {
    setDraft(JSON.parse(signature));
    setDirty([]);
  }, [signature]);
  const operating = settings.goalOperatingSolved
    ? solveOperatingGoal(data, storedInput, index, "raw")
    : null;
  const balance = settings.goalAssetSolved
    ? solveAssetLossGoal(data, storedInput, index)
    : null;
  const operatingApply = operating?.selection
    ? operatingGoalApplication(data, storedInput, index, settings)
    : null;
  const balanceApply =
    balance && !balance.reason
      ? assetLossGoalApplication(data, storedInput, index, settings)
      : null;
  const headroom = buildScenarioHeadroom(data, settings, index);
  const denomination = goalSeekUnits(settings.units).label;
  const period = data.periods?.[index];
  const value = (number: any, format = "currency") =>
    analysisValue(number, format, settings.units);
  const signed = (number: number, suffix: string) =>
    `${number >= 0 ? "+" : ""}${Number(number.toFixed(8))}${suffix}`;
  const change = (field: string, raw: string, exercise: string) => {
    if (!isGoalNumericDraft(raw)) return;
    raw = raw.trim();
    setDraft((current: any) => ({ ...current, [field]: raw }));
    setDirty((current) =>
      current.includes(field) ? current : [...current, field],
    );
    onPatch({
      [exercise === "operating" ? "goalOperatingSolved" : "goalAssetSolved"]:
        false,
    });
  };
  const commit = (extra: any = {}) => {
    // A submitted default becomes an explicit target, so a later baseline
    // revision cannot silently redefine the target the user already solved.
    const submitted = extra.goalOperatingSolved
      ? {
          goalTargetIncome: storedInput.targetIncome,
          ...(draft.mode === "revenue"
            ? { goalAssumedMargin: storedInput.assumedMargin }
            : { goalAssumedRevenue: storedInput.assumedRevenue }),
        }
      : extra.goalAssetSolved
        ? { goalEquityFloor: storedInput.targetEquityRatio }
        : {};
    onPatch({
      ...submitted,
      ...goalSeekDraftPatch(draft, settings.units, dirty),
      ...extra,
    });
    setDirty([]);
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
        type="text"
        inputMode="decimal"
        name={field}
        value={draft[field]}
        autoComplete="off"
        spellCheck={false}
        maxLength={80}
        onChange={(event) => change(field, event.target.value, exercise)}
        onBlur={() => {
          if (dirty.length) commit();
        }}
        aria-describedby={help ? `goal-${field}-help` : undefined}
      />
      {help && <small id={`goal-${field}-help`}>{help}</small>}
    </label>
  );
  const resultRows = (rows: any[]) => (
    <div className={styles.metrics}>
      {rows.map((row) => (
        <div key={row.definition.key}>
          <span>{row.definition.label.replace("Hypothetical ", "")}</span>
          <button
            type="button"
            onClick={() => onInspect(row)}
            aria-label={`Inspect ${row.definition.label.toLowerCase()}`}
          >
            {value(row.point.value, row.definition.format)}
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
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
        <button
          type="button"
          onClick={() => {
            setDraft(
              goalSeekDraft(data, index, GOAL_SEEK_DEFAULTS, settings.units),
            );
            setDirty([]);
            onPatch(GOAL_SEEK_DEFAULTS);
          }}
        >
          <RotateCcw size={14} aria-hidden="true" /> Use reported targets
        </button>
      </div>
      <p className={styles.intro}>
        Set your own target, inspect the required assumptions, then apply a
        valid solution to the scenario. Calculations retain {data.ticker}'s{" "}
        {period?.label || period?.end} source evidence.
      </p>
      <p className={styles.notice}>
        Hypothetical arithmetic. Your targets are not forecasts, probabilities,
        covenant tests, or regulatory capital requirements. Amount inputs use{" "}
        {denomination}; committed amounts retain the same dollar value when
        display units change.
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
              duration without annualization. Applying a solution selects the
              margin model.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                commit({ goalOperatingSolved: true });
              }}
            >
              <div className={styles.controls}>
                <label>
                  Solve for
                  <select
                    name="mode"
                    value={draft.mode}
                    onChange={(event) => {
                      setDraft((current: any) => ({
                        ...current,
                        mode: event.target.value,
                      }));
                      onPatch({
                        goalMode: event.target.value,
                        goalOperatingSolved: false,
                      });
                    }}
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
                      "Held constant as revenue changes; must be positive and no greater than 100%.",
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
                <>
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
                      . Costs are implied by the margin; business feasibility is
                      not assessed.
                    </small>
                  </div>
                  {operatingApply?.reason ? (
                    <p className={styles.notice}>
                      Cannot apply: {operatingApply.reason}
                    </p>
                  ) : (
                    operatingApply?.patch && (
                      <div className={styles.preview}>
                        <h4>Preview the assumptions to apply</h4>
                        <dl>
                          <div>
                            <dt>Operating model</dt>
                            <dd>Revenue × margin</dd>
                          </div>
                          <div>
                            <dt>Revenue change</dt>
                            <dd>
                              {signed(
                                operatingApply.patch.scenarioRevenue,
                                "%",
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Margin change</dt>
                            <dd>
                              {signed(
                                operatingApply.patch.scenarioMargin,
                                " pp",
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Resulting revenue</dt>
                            <dd>{value(operating.requiredRevenue)}</dd>
                          </div>
                          <div>
                            <dt>Resulting operating margin</dt>
                            <dd>
                              {value(operating.requiredMargin, "percent")}
                            </dd>
                          </div>
                          <div>
                            <dt>Implied operating costs</dt>
                            <dd>{value(operating.impliedCosts)}</dd>
                          </div>
                          <div>
                            <dt>Resulting operating income</dt>
                            <dd>{value(operating.target)}</dd>
                          </div>
                        </dl>
                        <button
                          type="button"
                          className={styles.solve}
                          onClick={() => onApply(operatingApply.patch)}
                        >
                          Apply operating solution to scenario
                        </button>
                      </div>
                    )
                  )}
                </>
              )}
            </div>
            {inspectSources(
              solveOperatingGoal(data, storedInput, index, "raw").inputs,
            )}
          </section>
        )}
        <section
          className={styles.exercise}
          aria-labelledby="asset-loss-goal-heading"
        >
          <h3 id="asset-loss-goal-heading">Find an asset-loss boundary</h3>
          <p className={styles.small}>
            Starting from reported assets and equity, solve the total noncash
            asset loss that reaches your floor. Assets and equity fall
            dollar-for-dollar. This standalone solution excludes withdrawals and
            borrowing.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              commit({ goalAssetSolved: true });
            }}
          >
            <div className={styles.controls}>
              {numberField(
                "targetEquityRatio",
                "Your minimum shareholder equity / assets (%)",
                "balance",
                "Enter 0% to below 100%. Starts at the reported ratio; this is an accounting floor you choose.",
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
                    ? `Already below your floor: the reported ratio is ${value(balance.baselineRatio, "percent")}. Zero additional loss does not restore the floor.`
                    : balance.status === "atTarget"
                      ? "The reported ratio is at your floor. Any positive loss in this model takes it below the floor."
                      : `Reported ratio: ${value(balance.baselineRatio, "percent")}. This loss brings the ratio to your ${value(balance.target, "percent")} floor.`}
                </p>
                {resultRows(balance.rows)}
                {balanceApply?.reason ? (
                  <p className={styles.notice}>
                    Cannot apply: {balanceApply.reason}
                  </p>
                ) : (
                  balanceApply?.patch && (
                    <div className={styles.preview}>
                      <h4>Preview the standalone loss scenario</h4>
                      <dl>
                        <div>
                          <dt>Total loss / reported assets</dt>
                          <dd>
                            {signed(balanceApply.patch.scenarioLoss, "%")}
                          </dd>
                        </div>
                        <div>
                          <dt>Resulting shareholder equity / assets</dt>
                          <dd>{value(balance.target, "percent")}</dd>
                        </div>
                        {data.lens === "banking" && (
                          <>
                            <div>
                              <dt>Deposit withdrawals</dt>
                              <dd>Reset to 0%</dd>
                            </div>
                            <div>
                              <dt>Replacement borrowing</dt>
                              <dd>Reset to 0%</dd>
                            </div>
                          </>
                        )}
                      </dl>
                      <p className={styles.small}>
                        Replaces the current total asset-loss assumption.{" "}
                        {data.lens === "banking"
                          ? "Withdrawals and replacement borrowing are reset so the scenario matches this standalone solution. Current-scenario headroom, including funding, is checked below."
                          : "Current-scenario headroom is checked separately below."}
                      </p>
                      <button
                        type="button"
                        className={styles.solve}
                        onClick={() => onApply(balanceApply.patch)}
                      >
                        Apply asset-loss solution to scenario
                      </button>
                    </div>
                  )
                )}
              </>
            )}
          </div>
          <p className={styles.small}>
            Loss = (equity − floor ratio × assets) / (1 − floor ratio). No tax
            benefit or use of existing allowances. Shareholder equity and
            consolidated assets can differ in scope.
          </p>
          {inspectSources(solveAssetLossGoal(data, storedInput, index).inputs)}
        </section>
        <section
          className={styles.exercise}
          aria-labelledby="scenario-headroom-heading"
        >
          <p className={styles.eyebrow}>Check the current scenario</p>
          <h3 id="scenario-headroom-heading">Headroom against your floor</h3>
          <p className={styles.small}>
            Your committed floor: {value(headroom.target, "percent")}. Remaining
            loss starts from current scenario balances, including the current
            loss and any funding assumptions. It is additional to the loss
            already modeled.
          </p>
          {headroom.reason ? (
            <p className={styles.notice}>{headroom.reason}</p>
          ) : (
            <>
              <p className={styles.notice}>
                {headroom.status === "alreadyBelow"
                  ? "Current scenario is already below your floor. Zero remaining loss does not restore it."
                  : headroom.status === "atTarget"
                    ? "Current scenario is at your floor. Any additional noncash loss takes it below."
                    : "Current scenario is above your floor. The remaining additional loss below is the arithmetic boundary, with funding held fixed."}
              </p>
              {resultRows(headroom.rows)}
              {headroom.capacityNote && (
                <p className={styles.notice}>{headroom.capacityNote}</p>
              )}
            </>
          )}
          {headroom.cash && (
            <div className={styles.cashCheck}>
              <h4>Cash available for deposit withdrawals</h4>
              <p className={styles.small}>
                Usable reported cash follows your availability assumption.
                Borrowed cash is an explicit assumption and adds a matching
                liability. Remaining capacity is measured after the current
                withdrawal.
              </p>
              {headroom.cash.reason ? (
                <p className={styles.notice}>{headroom.cash.reason}</p>
              ) : (
                <>
                  {resultRows(headroom.cash.rows)}
                  {(headroom.cash.gap ?? 0) > 0 && (
                    <p className={styles.notice}>
                      Current withdrawal exceeds modeled usable and borrowed
                      cash by {value(headroom.cash.gap)}. The ending balance
                      scenario is unavailable until the gap is addressed.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          <p className={styles.small}>
            These checks do not establish a covenant threshold, regulatory
            capital or liquidity compliance, borrowing availability, or a
            probability of loss.
          </p>
        </section>
      </div>
    </section>
  );
}
