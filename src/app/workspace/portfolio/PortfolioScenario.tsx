"use client";

import { useId, useMemo, useRef, useState } from "react";
import { buildPortfolioScenario } from "../../../utils/portfolioScenario.js";
import { csvString } from "../../../utils/portfolioFiles.js";
import { downloadText } from "../../../utils/download.js";
import PortfolioScenarioTools from "./PortfolioScenarioTools";
import dynamic from "next/dynamic";
import insightStyles from "./PortfolioInsightTools.module.css";
const PortfolioScenarioWorkbench = dynamic(
  () => import("./PortfolioScenarioWorkbench"),
);
import styles from "./PortfolioScenario.module.css";

type Props = {
  report: any;
  rows: any[];
  settings: any;
  companies: any[];
  onInspectCompany: (rowId: string) => void;
};

const DEFAULT_SCENARIO = {
  scope: "all",
  targetCik: "",
  targetIndustry: "",
  targetShockPct: "-20",
  remainderShockPct: "0",
  equalWeight: false,
};
const number = (value: number | null, signed = false) =>
  value === null
    ? "Unavailable"
    : new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
        signDisplay: signed ? "exceptZero" : "auto",
      }).format(Math.abs(value) < 0.00000001 ? 0 : value);
const amount = (value: number | null, currency: string | null) => {
  if (value === null || !currency) return "Unavailable";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${number(value)}`;
  }
};

export default function PortfolioScenario({
  report,
  rows,
  settings,
  companies,
  onInspectCompany,
}: Props) {
  const controlId = useId();
  const singleScenarioButton = useRef<HTMLSelectElement>(null);
  const [scenario, setScenario] = useState(DEFAULT_SCENARIO);
  const [previousBasis, setPreviousBasis] = useState(settings.basis);
  // A newly selected portfolio basis supersedes the temporary equal-weight override.
  // Keep the user's shocks, target and cases while updating the allocation assumption.
  if (previousBasis !== settings.basis) {
    setPreviousBasis(settings.basis);
    if (scenario.equalWeight)
      setScenario((current) => ({ ...current, equalWeight: false }));
  }
  const [toolArea, setToolArea] = useState("scenario");
  const [expanded, setExpanded] = useState(false);
  const [exportError, setExportError] = useState("");
  const result = useMemo(
    () => buildPortfolioScenario(rows, settings, companies, scenario),
    [rows, settings, companies, scenario],
  );
  const visibleContributions = expanded
    ? result.contributions
    : result.contributions.slice(0, 10);
  const targetLabel =
    scenario.scope === "all"
      ? "All holdings"
      : scenario.scope === "issuer"
        ? result.issuers.find(
            (issuer: any) => issuer.cik === scenario.targetCik,
          )?.name || "Choose a holding"
        : scenario.targetIndustry || "Choose an industry";
  const rangeValue = Number(scenario.targetShockPct);
  const largestIssuer = result.issuers.find(
    (issuer: any) => issuer.weightPct !== null,
  );
  const change = (patch: Partial<typeof DEFAULT_SCENARIO>) => {
    setScenario((current) => ({ ...current, ...patch }));
    setExportError("");
  };

  function exportScenario() {
    if (!result.eligible) return;
    try {
      const data: any[][] = [
        ["EDGAR Terminal hypothetical portfolio price scenario"],
        ["Allocation model", result.basisLabel],
        [
          "Temporary equal-weight model",
          result.temporaryEqualWeights ? "Yes; saved holdings unchanged" : "No",
        ],
        [
          "Equal-weight assumption",
          result.equalWeight
            ? "Yes; assumed allocation across positions"
            : "No",
        ],
        ["Target scope", result.scope],
        ["Target", targetLabel],
        ["Target price change (%)", result.targetShockPct],
        [
          "Other holdings price change (%)",
          result.scope === "all"
            ? "Not applicable: all holdings targeted"
            : result.remainderShockPct,
        ],
        ["Hypothetical total return (%)", result.totalReturnPct],
        ...result.assumptions.map((assumption: string) => [
          "Assumption",
          assumption,
        ]),
        ...result.warnings.map((warning: string) => [
          "Allocation note",
          warning,
        ]),
      ];
      if (result.startingValue !== null)
        data.push(
          ["Comparable starting value", result.startingValue, result.currency],
          ["Hypothetical value change", result.valueChange, result.currency],
          ["Hypothetical ending value", result.endingValue, result.currency],
        );
      data.push(
        [],
        [
          "Holding",
          "Tickers",
          "CIK",
          "SEC industry",
          "Targeted",
          "Starting weight (%)",
          "Price change (%)",
          "Contribution (percentage points)",
          "Ending weight (%)",
          "Weight drift (percentage points)",
        ],
        ...result.contributions.map((row: any) => [
          row.name,
          row.tickers.join(" / "),
          row.cik,
          row.industry || "Unclassified",
          row.targeted ? "Yes" : "No",
          row.weightPct,
          row.shockPct,
          row.contributionPct,
          row.endingWeightPct ?? "Undefined: total modeled value is zero",
          row.driftPct ?? "Undefined: total modeled value is zero",
        ]),
      );
      downloadText("portfolio-price-scenario.csv", csvString(data), "text/csv");
    } catch {
      setExportError(
        "The scenario could not be downloaded. Your portfolio is unchanged; try again.",
      );
    }
  }

  return (
    <section
      className={styles.scenario}
      aria-labelledby={`${controlId}-heading`}
    >
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>Explore a what-if</span>
          <h3 id={`${controlId}-heading`}>Explore portfolio scenarios</h3>
          <p>
            Explore price changes, allocation targets, and operating-profit
            sensitivity. Choose a tool and inspect the assumptions behind each
            result.
          </p>
        </div>
        <span className={styles.hypothetical}>Hypothetical scenario</span>
      </div>

      <label className={insightStyles.selector}>
        Scenario tool
        <select
          ref={singleScenarioButton}
          value={toolArea}
          onChange={(event) => setToolArea(event.target.value)}
        >
          {[
            ["scenario", "Single price scenario"],
            ["mixed", "Multiple price shocks"],
            ["rebalance", "Allocation sandbox"],
            ["operating", "Operating-profit sensitivity"],
            ["sensitivity", "Sensitivity grid"],
            ["loss", "Loss target"],
            ["compare", "Compare cases"],
          ].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {["mixed", "rebalance", "operating"].includes(toolArea) ? (
        <PortfolioScenarioWorkbench
          report={report}
          rows={rows}
          settings={settings}
          companies={companies}
          view={toolArea}
          onInspect={onInspectCompany}
        />
      ) : (
        <>
          {result.basis === "none" && !scenario.equalWeight && (
            <div className={styles.optIn}>
              <div>
                <strong>
                  Your ticker list does not specify invested weights.
                </strong>
                <p>
                  Explore with equal weights across the included positions. This
                  assumption stays in this scenario and does not change your
                  saved portfolio.
                </p>
              </div>
              <button
                type="button"
                className={styles.primary}
                onClick={() => change({ equalWeight: true })}
              >
                Try an equal-weight scenario
              </button>
            </div>
          )}
          {result.equalWeight && (
            <div className={styles.modelNotice}>
              <p>
                <strong>Equal-weight model · assumed allocations.</strong> Each
                included position starts with the same weight. Share classes are
                combined by holding.{" "}
                {result.temporaryEqualWeights
                  ? "This scenario does not change your saved allocations."
                  : "Your portfolio has an explicit equal-weight model selected."}
              </p>
              {result.temporaryEqualWeights && (
                <button
                  type="button"
                  onClick={() => change({ equalWeight: false })}
                >
                  Use saved allocation
                </button>
              )}
            </div>
          )}

          {(toolArea === "scenario" || toolArea === "compare") && (
            <div className={styles.presets} aria-label="Price scenario presets">
              <span>Try a scenario</span>
              <button
                type="button"
                onClick={() =>
                  change({
                    scope: "all",
                    targetShockPct: "-10",
                    remainderShockPct: "0",
                  })
                }
              >
                All holdings −10%
              </button>
              <button
                type="button"
                disabled={!largestIssuer || result.allocationErrors.length > 0}
                onClick={() =>
                  change({
                    scope: "issuer",
                    targetCik: largestIssuer?.cik || "",
                    targetShockPct: "-30",
                    remainderShockPct: "0",
                  })
                }
              >
                Largest holding −30%
              </button>
              <button
                type="button"
                disabled={!result.industries.length}
                onClick={() =>
                  change({
                    scope: "industry",
                    targetIndustry: result.industries.includes(
                      scenario.targetIndustry,
                    )
                      ? scenario.targetIndustry
                      : result.industries[0],
                    targetShockPct: "-20",
                    remainderShockPct: "0",
                  })
                }
              >
                One industry −20%
              </button>
            </div>
          )}

          <div className={styles.controls}>
            <label htmlFor={`${controlId}-scope`}>
              Apply the price change to
              <select
                id={`${controlId}-scope`}
                value={scenario.scope}
                onChange={(event) =>
                  change({
                    scope: event.target.value,
                    remainderShockPct: "0",
                    targetCik:
                      scenario.targetCik || result.issuers[0]?.cik || "",
                    targetIndustry:
                      scenario.targetIndustry || result.industries[0] || "",
                  })
                }
              >
                <option value="all">All holdings</option>
                <option value="issuer">One holding</option>
                <option value="industry">One SEC industry</option>
              </select>
            </label>
            {scenario.scope === "issuer" && (
              <label htmlFor={`${controlId}-holding`}>
                Target holding
                <select
                  id={`${controlId}-holding`}
                  value={scenario.targetCik}
                  onChange={(event) =>
                    change({ targetCik: event.target.value })
                  }
                >
                  <option value="">Choose a holding</option>
                  {result.issuers.map((issuer: any) => (
                    <option key={issuer.cik} value={issuer.cik}>
                      {issuer.tickers.join(" / ")} · {issuer.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {scenario.scope === "industry" && (
              <label htmlFor={`${controlId}-industry`}>
                Target SEC industry
                <select
                  id={`${controlId}-industry`}
                  value={scenario.targetIndustry}
                  onChange={(event) =>
                    change({ targetIndustry: event.target.value })
                  }
                >
                  <option value="">Choose an industry</option>
                  {result.industries.map((industry: string) => (
                    <option key={industry} value={industry}>
                      {industry}
                    </option>
                  ))}
                </select>
                <small>
                  SEC SIC classifications; unclassified holdings stay in other
                  holdings.
                </small>
              </label>
            )}
            {(toolArea === "scenario" || toolArea === "compare") && (
              <div className={styles.shockControl}>
                <label htmlFor={`${controlId}-shock`}>
                  Target price change (%)
                  <input
                    id={`${controlId}-shock`}
                    type="number"
                    min="-100"
                    max="100"
                    step="any"
                    value={scenario.targetShockPct}
                    onChange={(event) =>
                      change({ targetShockPct: event.target.value })
                    }
                    aria-describedby={`${controlId}-bounds`}
                  />
                </label>
                <input
                  aria-label="Adjust target price change"
                  type="range"
                  min="-100"
                  max="100"
                  step="1"
                  value={
                    Number.isFinite(rangeValue)
                      ? Math.max(-100, Math.min(100, rangeValue))
                      : 0
                  }
                  onChange={(event) =>
                    change({ targetShockPct: event.target.value })
                  }
                />
                <small id={`${controlId}-bounds`}>
                  −100% to +100%; negative values model a price decline.
                </small>
              </div>
            )}
            {scenario.scope !== "all" && toolArea !== "sensitivity" && (
              <label htmlFor={`${controlId}-rest`}>
                Other holdings’ price change (%)
                <input
                  id={`${controlId}-rest`}
                  type="number"
                  min="-100"
                  max="100"
                  step="any"
                  value={scenario.remainderShockPct}
                  onChange={(event) =>
                    change({ remainderShockPct: event.target.value })
                  }
                />
                <small>Applies only outside the selected target.</small>
              </label>
            )}
          </div>

          <PortfolioScenarioTools
            area={toolArea}
            rows={rows}
            settings={settings}
            companies={companies}
            scenario={scenario}
            result={result}
            onLoad={(assumptions) => {
              setScenario(assumptions);
              setExpanded(false);
              setExportError("");
              setToolArea("scenario");
              singleScenarioButton.current?.focus();
            }}
          />

          {toolArea === "scenario" && result.errors.length > 0 && (
            <div className={styles.blocked} role="status">
              <strong>Complete the inputs to see a portfolio result.</strong>
              <ul>
                {result.errors.map((error: string) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
          {toolArea === "scenario" &&
            result.eligible &&
            result.totalReturnPct !== null && (
              <>
                <div
                  className={styles.resultSummary}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <div className={styles.total}>
                    <span>Hypothetical portfolio return</span>
                    <strong
                      className={
                        result.totalReturnPct < 0
                          ? styles.negative
                          : result.totalReturnPct > 0
                            ? styles.positive
                            : ""
                      }
                    >
                      {number(result.totalReturnPct, true)}%
                    </strong>
                    <small>
                      {result.equalWeight
                        ? "Equal-weight model · assumed allocations"
                        : result.basisLabel}
                    </small>
                  </div>
                  <div className={styles.resultContext}>
                    <strong>
                      {targetLabel}: {number(result.targetShockPct, true)}%
                    </strong>
                    <p>
                      {number(result.targetWeightPct)}% of starting allocation
                      receives this change.{" "}
                      {result.scope !== "all" &&
                        `Other holdings move ${number(result.remainderShockPct, true)}%.`}
                    </p>
                    {result.startingValue !== null && (
                      <p>
                        Modeled value:{" "}
                        {amount(result.startingValue, result.currency)} →{" "}
                        <strong>
                          {amount(result.endingValue, result.currency)}
                        </strong>{" "}
                        ({amount(result.valueChange, result.currency)} change).
                      </p>
                    )}
                  </div>
                </div>
                <div className={styles.tableHeading}>
                  <div>
                    <h4>Where the impact comes from</h4>
                    <p>
                      Ordered by absolute contribution. Ending weights show
                      concentration after the assumed price moves.
                    </p>
                  </div>
                  <button type="button" onClick={exportScenario}>
                    Download scenario CSV
                  </button>
                </div>
                {exportError && <p role="alert">{exportError}</p>}
                {!result.endingWeightsDefined && (
                  <p className={styles.modelNotice}>
                    The modeled portfolio value falls to zero. Ending weights
                    and weight drift are undefined.
                  </p>
                )}
                <div
                  className={styles.tableWrap}
                  tabIndex={0}
                  role="region"
                  aria-label="Scenario contributions; scroll horizontally for all columns"
                >
                  <table>
                    <caption>
                      {result.contributions.length} holdings ·{" "}
                      {result.equalWeight
                        ? "Equal-weight model; assumed allocations"
                        : "Selected portfolio allocation"}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Holding</th>
                        <th scope="col">Starting weight</th>
                        <th scope="col">Price change</th>
                        <th scope="col">Contribution</th>
                        <th scope="col">Ending weight</th>
                        <th scope="col">Weight drift</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleContributions.map((row: any) => (
                        <tr key={row.cik}>
                          <th scope="row">
                            <button
                              type="button"
                              className={styles.issuerButton}
                              onClick={() => onInspectCompany(row.rowId)}
                            >
                              {row.tickers.join(" / ") || row.name}
                            </button>
                            <small>{row.name}</small>
                            <span className={styles.targetBadge}>
                              {row.targeted ? "Target" : "Other holdings"}
                            </span>
                          </th>
                          <td>{number(row.weightPct)}%</td>
                          <td>{number(row.shockPct, true)}%</td>
                          <td
                            className={
                              row.contributionPct < 0
                                ? styles.negative
                                : row.contributionPct > 0
                                  ? styles.positive
                                  : ""
                            }
                          >
                            <strong>
                              {number(row.contributionPct, true)} pp
                            </strong>
                          </td>
                          <td>
                            {row.endingWeightPct === null
                              ? "Undefined"
                              : `${number(row.endingWeightPct)}%`}
                          </td>
                          <td>
                            {row.driftPct === null
                              ? "Undefined"
                              : `${number(row.driftPct, true)} pp`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">Whole portfolio</th>
                        <td>100.00%</td>
                        <td>—</td>
                        <td>{number(result.totalReturnPct, true)} pp</td>
                        <td>
                          {!result.endingWeightsDefined
                            ? "Undefined"
                            : "100.00%"}
                        </td>
                        <td>—</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {result.contributions.length > 10 && (
                  <button
                    type="button"
                    className={styles.showAll}
                    aria-expanded={expanded}
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded
                      ? "Show largest 10 contributions"
                      : `Show all ${result.contributions.length} holdings`}
                  </button>
                )}
              </>
            )}
          <div className={styles.footer}>
            <details>
              <summary>Calculation and assumptions</summary>
              <p>
                “pp” means percentage points of the whole portfolio. A 60%
                holding falling 20% contributes −12 percentage points.
              </p>
              <ul>
                {result.assumptions.map((assumption: string) => (
                  <li key={assumption}>{assumption}</li>
                ))}
              </ul>
              {result.warnings.length > 0 && (
                <ul>
                  {result.warnings.map((warning: string) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </details>
            <button
              type="button"
              onClick={() => {
                setScenario(DEFAULT_SCENARIO);
                setExpanded(false);
                setExportError("");
                setToolArea("scenario");
              }}
            >
              Reset scenario
            </button>
          </div>
        </>
      )}
    </section>
  );
}
