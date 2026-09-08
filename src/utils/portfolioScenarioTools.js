import { buildPortfolioScenario } from "./portfolioScenario.js";
import { canonicalPortfolioCik } from "./portfolioModel.js";
import { csvString } from "./portfolioFiles.js";

export const MAX_SCENARIO_CASES = 4;
const finiteInput = (value) =>
  (typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value));
const boundedShock = (value) =>
  finiteInput(value) && Number(value) >= -100 && Number(value) <= 100;

/** Keep only assumptions, never a portfolio or a calculated result. */
export function captureScenarioCase(scenario, name, id) {
  if (
    !["all", "issuer", "industry"].includes(scenario?.scope) ||
    !boundedShock(scenario?.targetShockPct) ||
    !boundedShock(scenario?.remainderShockPct)
  )
    return null;
  const cleanName = typeof name === "string" ? name.trim().slice(0, 60) : "";
  if (!cleanName || typeof id !== "string" || !id.trim()) return null;
  return {
    id: id.trim().slice(0, 80),
    name: cleanName,
    scenario: {
      scope: scenario.scope,
      targetCik: canonicalPortfolioCik(scenario.targetCik) || "",
      targetIndustry:
        typeof scenario.targetIndustry === "string"
          ? scenario.targetIndustry.trim().slice(0, 240)
          : "",
      targetShockPct: String(Number(scenario.targetShockPct)),
      remainderShockPct: String(Number(scenario.remainderShockPct)),
      equalWeight: scenario.equalWeight === true,
    },
  };
}

/** Sensitivity axes are explicit price assumptions, not probability estimates. */
export function buildScenarioSensitivity(
  rows,
  settings,
  companies,
  scenario,
  stepPct = 25,
) {
  if (![10, 25, 50].includes(stepPct))
    return {
      eligible: false,
      errors: ["Choose a 10, 25 or 50 percentage-point grid step."],
      targetShocks: [],
      remainderShocks: [],
      cells: [],
    };
  const base = buildPortfolioScenario(rows, settings, companies, {
    ...scenario,
    targetShockPct: 0,
    remainderShockPct: 0,
  });
  const targetShocks = [-2, -1, 0, 1, 2].map((factor) => factor * stepPct);
  const remainderShocks = scenario.scope === "all" ? [0] : targetShocks;
  if (!base.eligible)
    return {
      eligible: false,
      errors: base.errors,
      targetShocks,
      remainderShocks,
      cells: [],
    };
  return {
    eligible: true,
    errors: [],
    targetWeightPct: base.targetWeightPct,
    targetShocks,
    remainderShocks,
    cells: targetShocks.map((targetShockPct) =>
      remainderShocks.map((remainderShockPct) => {
        const calculated = buildPortfolioScenario(rows, settings, companies, {
          ...scenario,
          targetShockPct,
          remainderShockPct,
        });
        return {
          targetShockPct,
          remainderShockPct,
          totalReturnPct: calculated.totalReturnPct,
          eligible: calculated.eligible,
        };
      }),
    ),
  };
}

/** Solve the price change that reaches an exact portfolio loss, with a fixed remainder. */
export function solvePortfolioLossTarget(
  rows,
  settings,
  companies,
  scenario,
  lossPct,
) {
  const base = buildPortfolioScenario(rows, settings, companies, {
    ...scenario,
    targetShockPct: 0,
    ...(scenario.scope === "all" ? { remainderShockPct: 0 } : {}),
  });
  const result = {
    eligible: false,
    errors: [...base.errors],
    lossPct: finiteInput(lossPct) ? Number(lossPct) : null,
    requiredShockPct: null,
    targetWeightPct: base.targetWeightPct,
    remainderContributionPct: null,
    minimumReturnPct: null,
    maximumReturnPct: null,
    scenarioResult: null,
  };
  if (!finiteInput(lossPct) || Number(lossPct) < 0 || Number(lossPct) > 100)
    result.errors.push(
      "Enter a portfolio loss from 0% to 100%; use a positive number for a loss.",
    );
  if (!base.eligible || result.errors.length) return result;
  const remainderContributionPct = base.contributions
    .filter((row) => !row.targeted)
    .reduce((sum, row) => sum + row.contributionPct, 0);
  result.remainderContributionPct = remainderContributionPct;
  result.minimumReturnPct = -base.targetWeightPct + remainderContributionPct;
  result.maximumReturnPct = base.targetWeightPct + remainderContributionPct;
  if (base.targetWeightPct <= 0) {
    result.errors.push(
      "The selected target has 0% allocation, so changing its price cannot determine a portfolio loss target. Choose a target with a positive weight.",
    );
    return result;
  }
  const needed =
    ((-Number(lossPct) - remainderContributionPct) * 100) /
    base.targetWeightPct;
  if (needed < -100 - 1e-9 || needed > 100 + 1e-9) {
    result.errors.push(
      "This loss cannot be reached within a target price change of −100% to +100% while keeping the other holdings’ change fixed.",
    );
    return result;
  }
  const requiredShockPct = Math.min(100, Math.max(-100, needed));
  const scenarioResult = buildPortfolioScenario(rows, settings, companies, {
    ...scenario,
    targetShockPct: requiredShockPct,
    ...(scenario.scope === "all" ? { remainderShockPct: 0 } : {}),
  });
  return {
    ...result,
    eligible: scenarioResult.eligible,
    errors: scenarioResult.errors,
    requiredShockPct,
    scenarioResult,
  };
}

export function scenarioTargetLabel(result) {
  if (result.scope === "all") return "All holdings";
  if (result.scope === "industry")
    return result.targetIndustry || "Choose an industry";
  return (
    result.issuers.find((issuer) => issuer.cik === result.targetCik)?.name ||
    "Choose an issuer"
  );
}

/** Every invocation recomputes the saved assumptions using the current allocation. */
export function buildScenarioComparison(
  rows,
  settings,
  companies,
  cases,
  currentScenario,
) {
  const saved = (Array.isArray(cases) ? cases : [])
    .slice(0, MAX_SCENARIO_CASES)
    .map((item) => captureScenarioCase(item?.scenario, item?.name, item?.id))
    .filter(Boolean);
  return [
    {
      id: "current",
      name: "Current inputs (unsaved)",
      scenario: currentScenario,
    },
    ...saved,
  ].map((item) => ({
    ...item,
    result: buildPortfolioScenario(rows, settings, companies, item.scenario),
  }));
}

/** Comparison includes starting allocations and assumptions; never row notes or quantities. */
export function scenarioComparisonCsv(comparison) {
  const data = [
    ["EDGAR Terminal hypothetical price scenario comparison"],
    [
      "Source",
      "User-supplied price changes and selected portfolio allocations. No market-price series is used.",
    ],
    [
      "Cases",
      "Named assumptions kept only for this open portfolio session; results recomputed using current portfolio inputs.",
    ],
    [
      "Units",
      "Price changes and portfolio returns are percentages; contributions are percentage points of the whole portfolio.",
    ],
    [],
    [
      "Case",
      "Status",
      "Allocation model",
      "Temporary equal weights",
      "Target scope",
      "Target",
      "Target weight (%)",
      "Target price change (%)",
      "Other holdings price change (%)",
      "Portfolio return (%)",
      "Comparable starting value",
      "Modeled value change",
      "Modeled ending value",
      "Currency",
    ],
    ...comparison.map(({ name, result }) => [
      name,
      result.eligible ? "Calculated" : result.errors.join(" "),
      result.basisLabel,
      result.temporaryEqualWeights ? "Yes; saved allocations unchanged" : "No",
      result.scope,
      scenarioTargetLabel(result),
      result.targetWeightPct,
      result.targetShockPct,
      result.scope === "all" ? "Not applicable" : result.remainderShockPct,
      result.totalReturnPct,
      result.startingValue,
      result.valueChange,
      result.endingValue,
      result.currency,
    ]),
    [],
    ["Case", "Assumption or allocation note"],
    ...comparison.flatMap(({ name, result }) =>
      [...result.assumptions, ...result.warnings].map((value) => [name, value]),
    ),
    [],
    [
      "Case",
      "Issuer",
      "Tickers",
      "CIK",
      "SEC industry",
      "Targeted",
      "Starting weight (%)",
      "Price change (%)",
      "Contribution (percentage points)",
      "Ending weight (%)",
      "SEC issuer identity",
    ],
    ...comparison.flatMap(({ name, result }) =>
      result.contributions.map((row) => [
        name,
        row.name,
        row.tickers.join(" / "),
        row.cik,
        row.industry || "Unclassified",
        row.targeted ? "Yes" : "No",
        row.weightPct,
        row.shockPct,
        row.contributionPct,
        row.endingWeightPct ?? "Undefined: total modeled value is zero",
        `https://www.sec.gov/edgar/browse/?CIK=${row.cik}`,
      ]),
    ),
  ];
  return csvString(data);
}
