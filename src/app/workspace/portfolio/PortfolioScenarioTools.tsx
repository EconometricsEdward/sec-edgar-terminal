"use client";

import { useId, useMemo, useRef, useState } from "react";
import {
  MAX_SCENARIO_CASES,
  buildScenarioComparison,
  buildScenarioSensitivity,
  captureScenarioCase,
  scenarioComparisonCsv,
  scenarioTargetLabel,
  solvePortfolioLossTarget,
} from "../../../utils/portfolioScenarioTools.js";
import { downloadText } from "../../../utils/download.js";
import styles from "./PortfolioScenario.module.css";

type Scenario = {
  scope: string;
  targetCik: string;
  targetIndustry: string;
  targetShockPct: string;
  remainderShockPct: string;
  equalWeight: boolean;
};
type Props = {
  area: string;
  rows: any[];
  settings: any;
  companies: any[];
  scenario: Scenario;
  result: any;
  onLoad: (scenario: Scenario) => void;
};
const pct = (value: number | null, signed = false) =>
  value === null || !Number.isFinite(value)
    ? "Unavailable"
    : `${new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
        signDisplay: signed ? "exceptZero" : "auto",
      }).format(Math.abs(value) < 1e-9 ? 0 : value)}%`;
const currency = (value: number | null, code: string | null) => {
  if (value === null || !code) return "No comparable value supplied";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${code} ${value.toFixed(2)}`;
  }
};
const direction = (value: number | null) =>
  value !== null && value < 0
    ? styles.negative
    : value !== null && value > 0
      ? styles.positive
      : "";

export default function PortfolioScenarioTools({
  area,
  rows,
  settings,
  companies,
  scenario,
  result,
  onLoad,
}: Props) {
  const id = useId();
  const caseNameInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(25);
  const [loss, setLoss] = useState("10");
  const [cases, setCases] = useState<any[]>([]);
  const [caseName, setCaseName] = useState("");
  const [notice, setNotice] = useState("");
  const [exportError, setExportError] = useState("");
  const grid = useMemo(
    () =>
      area === "sensitivity"
        ? buildScenarioSensitivity(rows, settings, companies, scenario, step)
        : null,
    [area, rows, settings, companies, scenario, step],
  );
  const solved = useMemo(
    () =>
      area === "loss"
        ? solvePortfolioLossTarget(rows, settings, companies, scenario, loss)
        : null,
    [area, rows, settings, companies, scenario, loss],
  );
  const comparison = useMemo(
    () =>
      area === "compare"
        ? buildScenarioComparison(rows, settings, companies, cases, scenario)
        : [],
    [area, rows, settings, companies, cases, scenario],
  );

  if (area === "scenario") return null;

  function saveCase() {
    if (!result.eligible || cases.length >= MAX_SCENARIO_CASES) return;
    const captured = captureScenarioCase(
      scenario,
      caseName.trim() || `Scenario ${cases.length + 1}`,
      crypto.randomUUID(),
    );
    if (!captured) return;
    setCases((current) => [...current, captured].slice(0, MAX_SCENARIO_CASES));
    setCaseName("");
    setNotice(
      `Added ${captured.name}. Download the comparison to keep a copy.`,
    );
  }

  function exportComparison() {
    try {
      downloadText(
        "portfolio-scenario-comparison.csv",
        scenarioComparisonCsv(comparison),
        "text/csv",
      );
      setExportError("");
    } catch {
      setExportError(
        "The comparison could not be downloaded. Try again; your cases are still here.",
      );
    }
  }

  if (area === "sensitivity" && grid)
    return (
      <div className={styles.toolPanel}>
        <div className={styles.tableHeading}>
          <div>
            <h4>See a range of price moves</h4>
            <p>
              Target: <strong>{scenarioTargetLabel(result)}</strong>. Each cell
              shows the whole portfolio’s modeled return.
              {scenario.scope === "all"
                ? " All holdings receive the same change."
                : " Rows change the target; columns change all other holdings."}{" "}
              Select a cell to inspect its issuer contributions.
            </p>
          </div>
          <label className={styles.gridStep} htmlFor={`${id}-step`}>
            Grid step
            <select
              id={`${id}-step`}
              value={step}
              onChange={(event) => setStep(Number(event.target.value))}
            >
              <option value={10}>10 percentage points</option>
              <option value={25}>25 percentage points</option>
              <option value={50}>50 percentage points</option>
            </select>
          </label>
        </div>
        {!grid.eligible ? (
          <div className={styles.blocked} role="status">
            <strong>
              Choose a target and complete the allocation to build the grid.
            </strong>
            <ul>
              {grid.errors.map((error: string) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <p className={styles.toolNote}>
              {pct(grid.targetWeightPct ?? null)} of starting allocation is in
              the target. Grid values are explicit assumptions around 0%; they
              do not represent likelihoods or historical outcomes.
            </p>
            <div
              className={`${styles.tableWrap} ${styles.sensitivityTable}`}
              tabIndex={0}
              role="region"
              aria-label="Price sensitivity grid; scroll horizontally for all assumptions"
            >
              <table>
                <caption>
                  {scenario.scope === "all"
                    ? "Target price change → whole-portfolio return"
                    : "Target price change down the rows · other holdings’ price change across the columns"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Target change</th>
                    {grid.remainderShocks.map((shock: number) => (
                      <th key={shock} scope="col">
                        {scenario.scope === "all"
                          ? "Portfolio return"
                          : `Others ${pct(shock, true)}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.cells.map((row: any[], index: number) => (
                    <tr key={grid.targetShocks[index]}>
                      <th scope="row">{pct(grid.targetShocks[index], true)}</th>
                      {row.map((cell: any) => (
                        <td key={cell.remainderShockPct}>
                          <button
                            type="button"
                            className={`${styles.sensitivityCell} ${direction(cell.totalReturnPct)}`}
                            aria-label={`Target ${pct(cell.targetShockPct, true)}${scenario.scope !== "all" ? `, other holdings ${pct(cell.remainderShockPct, true)}` : ""}: portfolio return ${pct(cell.totalReturnPct, true)}. Inspect scenario.`}
                            aria-pressed={
                              scenario.targetShockPct.trim() !== "" &&
                              Number(scenario.targetShockPct) ===
                                cell.targetShockPct &&
                              (scenario.scope === "all" ||
                                (scenario.remainderShockPct.trim() !== "" &&
                                  Number(scenario.remainderShockPct) ===
                                    cell.remainderShockPct))
                            }
                            onClick={() =>
                              onLoad({
                                ...scenario,
                                targetShockPct: String(cell.targetShockPct),
                                remainderShockPct: String(
                                  cell.remainderShockPct,
                                ),
                              })
                            }
                          >
                            {pct(cell.totalReturnPct, true)}
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );

  if (area === "loss" && solved)
    return (
      <div className={styles.toolPanel}>
        <div>
          <h4>What would it take to reach a loss?</h4>
          <p>
            Choose an exact portfolio loss and solve for the required price
            change in {scenarioTargetLabel(result)}. The other holdings’ change
            stays fixed at the assumption above.
          </p>
        </div>
        <div className={styles.controls}>
          <label htmlFor={`${id}-loss`}>
            Portfolio loss to reach (%)
            <input
              id={`${id}-loss`}
              type="number"
              min="0"
              max="100"
              step="any"
              value={loss}
              onChange={(event) => setLoss(event.target.value)}
              aria-describedby={`${id}-loss-help`}
            />
            <small id={`${id}-loss-help`}>
              Enter a positive number: 10 means a −10% portfolio return. This is
              an exact modeled threshold, not a forecast or a guaranteed loss
              limit.
            </small>
          </label>
        </div>
        <div aria-live="polite" aria-atomic="true">
          {solved.eligible && solved.scenarioResult ? (
            <div className={styles.resultSummary}>
              <div className={styles.total}>
                <span>Required target price change</span>
                <strong className={direction(solved.requiredShockPct)}>
                  {pct(solved.requiredShockPct, true)}
                </strong>
                <small>
                  {pct(solved.targetWeightPct)} of starting allocation
                </small>
              </div>
              <div className={styles.resultContext}>
                <strong>
                  Portfolio result:{" "}
                  {pct(solved.scenarioResult.totalReturnPct, true)}
                </strong>
                <p>
                  Other holdings contribute{" "}
                  {pct(solved.remainderContributionPct, true).replace(
                    "%",
                    " percentage points",
                  )}
                  .
                </p>
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() =>
                    onLoad({
                      ...scenario,
                      targetShockPct: String(solved.requiredShockPct),
                      ...(scenario.scope === "all"
                        ? { remainderShockPct: "0" }
                        : {}),
                    })
                  }
                >
                  Inspect this loss scenario
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.blocked} role="status">
              <strong>A loss target cannot be solved with these inputs.</strong>
              <ul>
                {solved.errors.map((error: string) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
          {solved.minimumReturnPct !== null && (
            <p className={styles.toolNote}>
              With target price changes limited to −100% through +100%, the
              reachable portfolio return is {pct(solved.minimumReturnPct, true)}{" "}
              to {pct(solved.maximumReturnPct, true)}. The required change may
              be positive if other holdings already produce a greater loss.
            </p>
          )}
        </div>
        <details className={styles.toolDetails}>
          <summary>How the loss target is solved</summary>
          <p>
            Required target change (%) = [−loss target (%) − other holdings’
            contribution (percentage points)] ÷ [target weight (%) ÷ 100]. The
            result is checked with the same issuer-level calculation used by a
            single scenario.
          </p>
        </details>
      </div>
    );

  return (
    <div className={styles.toolPanel}>
      <div>
        <h4>Compare your what-if cases</h4>
        <p>
          Keep up to {MAX_SCENARIO_CASES} named sets of assumptions alongside
          your current inputs. Cases stay while you switch research tabs.
          Reloading, editing rows, or opening another portfolio clears them;
          download the comparison to keep it. Every case is recalculated using
          the current allocation settings.
        </p>
      </div>
      <div className={`${styles.controls} ${styles.caseControls}`}>
        <label htmlFor={`${id}-case-name`}>
          Case name
          <input
            id={`${id}-case-name`}
            ref={caseNameInput}
            type="text"
            maxLength={60}
            value={caseName}
            placeholder="For example: largest issuer declines"
            onChange={(event) => setCaseName(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={styles.primary}
          disabled={!result.eligible || cases.length >= MAX_SCENARIO_CASES}
          onClick={saveCase}
        >
          Keep current case · {cases.length}/{MAX_SCENARIO_CASES}
        </button>
        <button
          type="button"
          disabled={
            !cases.length ||
            !comparison.some((item: any) => item.result.eligible)
          }
          onClick={exportComparison}
        >
          Download comparison CSV
        </button>
      </div>
      {notice && (
        <p className={styles.toolNote} role="status">
          {notice}
        </p>
      )}
      {exportError && <p role="alert">{exportError}</p>}
      {cases.length >= MAX_SCENARIO_CASES && (
        <p className={styles.toolNote}>
          All four case slots are in use. Remove a case to keep another set of
          assumptions.
        </p>
      )}
      {!result.eligible && (
        <div className={styles.blocked} role="status">
          <strong>Complete the current inputs before keeping a case.</strong>
          <ul>
            {result.errors.map((error: string) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      <div
        className={`${styles.tableWrap} ${styles.comparisonTable}`}
        tabIndex={0}
        role="region"
        aria-label="Scenario case comparison; scroll horizontally for all cases"
      >
        <table>
          <caption>
            {cases.length} named cases and current unsaved inputs · hypothetical
            price assumptions
          </caption>
          <thead>
            <tr>
              <th scope="col">Measure</th>
              {comparison.map((item: any) => (
                <th scope="col" key={item.id}>
                  <strong>{item.name}</strong>
                  {item.id !== "current" && (
                    <div className={styles.caseActions}>
                      <button
                        type="button"
                        aria-label={`Restore ${item.name}`}
                        onClick={() => onLoad(item.scenario)}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${item.name}`}
                        onClick={() => {
                          setCases((current) =>
                            current.filter(
                              (candidate) => candidate.id !== item.id,
                            ),
                          );
                          setNotice(`Removed ${item.name}.`);
                          caseNameInput.current?.focus();
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Portfolio return</th>
              {comparison.map((item: any) => (
                <td key={item.id}>
                  <strong
                    className={`${styles.comparisonReturn} ${direction(item.result.totalReturnPct)}`}
                  >
                    {pct(item.result.totalReturnPct, true)}
                  </strong>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Target</th>
              {comparison.map((item: any) => (
                <td key={item.id}>
                  {scenarioTargetLabel(item.result)}
                  <small>
                    {pct(item.result.targetWeightPct)} of starting allocation
                  </small>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Target price change</th>
              {comparison.map((item: any) => (
                <td key={item.id}>{pct(item.result.targetShockPct, true)}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Other holdings’ change</th>
              {comparison.map((item: any) => (
                <td key={item.id}>
                  {item.result.scope === "all"
                    ? "Not applicable"
                    : pct(item.result.remainderShockPct, true)}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Allocation model</th>
              {comparison.map((item: any) => (
                <td key={item.id}>
                  {item.result.basisLabel}
                  {item.result.temporaryEqualWeights && (
                    <small>
                      Temporary assumption; saved allocations unchanged
                    </small>
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Largest ending issuer weight</th>
              {comparison.map((item: any) => {
                const largest = item.result.endingWeightsDefined
                  ? item.result.contributions.reduce(
                      (best: any, issuer: any) =>
                        !best || issuer.endingWeightPct > best.endingWeightPct
                          ? issuer
                          : best,
                      null,
                    )
                  : null;
                return (
                  <td key={item.id}>
                    {largest ? (
                      <>
                        {pct(largest.endingWeightPct)}
                        <small>{largest.name}</small>
                      </>
                    ) : item.result.eligible ? (
                      "Undefined: total value is zero"
                    ) : (
                      "Unavailable"
                    )}
                  </td>
                );
              })}
            </tr>
            <tr>
              <th scope="row">Modeled value change</th>
              {comparison.map((item: any) => (
                <td key={item.id}>
                  {currency(item.result.valueChange, item.result.currency)}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Calculation status</th>
              {comparison.map((item: any) => (
                <td key={item.id}>
                  {item.result.eligible
                    ? "Calculated from current inputs"
                    : item.result.errors.join(" ")}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className={styles.toolNote}>
        The CSV includes each case’s assumptions, starting issuer weights,
        contributions, and SEC issuer identity links. Restore a case to inspect
        its full contribution table.
      </p>
    </div>
  );
}
