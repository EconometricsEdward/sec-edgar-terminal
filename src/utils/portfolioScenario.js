import { resolveCompanyClassification } from "./companyClassification.js";
import { allocationSummary, canonicalPortfolioCik } from "./portfolioModel.js";

const TOLERANCE = 0.000001;
const text = (value) => (typeof value === "string" ? value.trim() : "");
const industryLabel = (company) => {
  const industry = resolveCompanyClassification(company).industry;
  return industry === "Unclassified" ? "" : industry;
};

function shockNumber(value, label, errors) {
  if (
    !["number", "string"].includes(typeof value) ||
    (typeof value === "string" && !value.trim()) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < -100 ||
    Number(value) > 100
  ) {
    errors.push(`${label} must be a number from −100% to +100%.`);
    return null;
  }
  return Number(value);
}

/** Explicit price assumptions only. No returns, financial metrics or holdings are inferred. */
export function buildPortfolioScenario(
  rows,
  settings = {},
  companies = [],
  scenario = {},
) {
  const companiesByCik = Object.fromEntries(
    (Array.isArray(companies) ? companies : Object.values(companies || {}))
      .filter((company) => canonicalPortfolioCik(company?.cik))
      .map((company) => [canonicalPortfolioCik(company.cik), company]),
  );
  const temporaryEqualWeights = scenario.equalWeight === true;
  const selectedAllocation = settings.allocation || settings;
  const allocation = allocationSummary(
    rows,
    temporaryEqualWeights
      ? { basis: "equal", normalize: false }
      : selectedAllocation,
    companiesByCik,
  );
  const issuers = allocation.issuers.map((issuer) => ({
    cik: issuer.cik,
    rowId: issuer.rowIds[0],
    rowIds: [...issuer.rowIds],
    name: issuer.name,
    tickers: [...issuer.tickers],
    weightPct: issuer.weightPct,
    industry:
      issuer.kind === "fund" ? "" : industryLabel(companiesByCik[issuer.cik]),
  }));
  const industries = [
    ...new Set(issuers.map((issuer) => issuer.industry).filter(Boolean)),
  ].sort();
  const errors = [];
  const scope = scenario.scope ?? "all";
  const targetShockPct = shockNumber(
    scenario.targetShockPct === undefined ? -20 : scenario.targetShockPct,
    "Target price change",
    errors,
  );
  const remainderShockPct = shockNumber(
    scenario.remainderShockPct === undefined ? 0 : scenario.remainderShockPct,
    "Other holdings’ price change",
    errors,
  );
  const targetCik = canonicalPortfolioCik(scenario.targetCik);
  const targetIndustry = text(scenario.targetIndustry);
  if (!["all", "issuer", "industry"].includes(scope))
    errors.push("Choose all holdings, one holding, or one SEC industry.");
  if (scope === "issuer" && !issuers.some((issuer) => issuer.cik === targetCik))
    errors.push("Choose an identified holding in this portfolio.");
  if (scope === "industry" && !industries.includes(targetIndustry))
    errors.push("Choose a reported SEC industry in this portfolio.");

  const allocationErrors = [];
  if (!allocation.holdingCount)
    allocationErrors.push(
      "Add and identify holdings before running a price scenario.",
    );
  if (allocation.unresolvedCount)
    allocationErrors.push(
      "Identify every included holding before calculating a portfolio result.",
    );
  if (allocation.basis === "none")
    allocationErrors.push(
      "This research list has no selected allocation. Supply reviewed weights or explicitly try a temporary equal-weight scenario.",
    );
  else if (
    !allocation.valid ||
    allocation.reviewRequired ||
    !allocation.allocationComplete ||
    !Number.isFinite(allocation.allocatedWeight) ||
    Math.abs(allocation.allocatedWeight - 100) > TOLERANCE
  )
    allocationErrors.push(
      "Portfolio results require reviewed, complete allocations totaling 100%. Review missing weights, duplicate decisions, or incompatible position values first.",
    );

  const assumptions = [
    allocation.label,
    ...(temporaryEqualWeights
      ? [
          "Temporary equal weights across included positions; saved portfolio allocations are unchanged. Share classes are combined by holding after weights are assigned.",
        ]
      : allocation.assumptions),
    "Hypothetical price changes only; not a forecast, historical stress test or value at risk estimate.",
    "Each holding receives one price change. All its share classes receive the same change; the remainder change applies only outside the target.",
    "No correlations, spillovers, liquidity effects, trading, dividends, fees, taxes, currency moves or changes in company fundamentals are modeled.",
    "Contribution in percentage points = starting weight (%) × assumed price change (%) ÷ 100. Ending weight (%) = starting weight × (1 + price change ÷ 100) ÷ (1 + total return ÷ 100).",
  ];
  const result = {
    eligible: errors.length === 0 && allocationErrors.length === 0,
    errors: [...allocationErrors, ...errors],
    inputErrors: errors,
    allocationErrors,
    basis: allocation.basis,
    basisLabel: allocation.label,
    equalWeight: allocation.basis === "equal",
    temporaryEqualWeights,
    assumptions,
    warnings: allocation.warnings,
    scope,
    targetCik,
    targetIndustry,
    targetShockPct,
    remainderShockPct,
    issuers,
    industries,
    totalReturnPct: null,
    targetWeightPct: null,
    startingValue: null,
    valueChange: null,
    endingValue: null,
    endingWeightsDefined: false,
    currency: null,
    contributions: [],
  };
  if (!result.eligible) return result;

  const selected = (issuer) =>
    scope === "all" ||
    (scope === "issuer"
      ? issuer.cik === targetCik
      : issuer.industry === targetIndustry);
  const contributions = issuers.map((issuer) => {
    const targeted = selected(issuer);
    const shockPct = targeted ? targetShockPct : remainderShockPct;
    return {
      ...issuer,
      targeted,
      shockPct,
      contributionPct: (issuer.weightPct * shockPct) / 100,
    };
  });
  const totalReturnPct = contributions.reduce(
    (sum, row) => sum + row.contributionPct,
    0,
  );
  // Sum the remaining pieces directly to avoid cancellation near a total loss.
  const remainingValueFraction = contributions.reduce(
    (sum, row) => sum + (row.weightPct / 100) * (1 + row.shockPct / 100),
    0,
  );
  const complete = contributions
    .map((row) => {
      const endingWeightPct =
        remainingValueFraction > 0
          ? (row.weightPct * (1 + row.shockPct / 100)) / remainingValueFraction
          : null;
      return {
        ...row,
        endingWeightPct,
        driftPct:
          endingWeightPct === null ? null : endingWeightPct - row.weightPct,
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.contributionPct) - Math.abs(a.contributionPct) ||
        b.weightPct - a.weightPct ||
        a.name.localeCompare(b.name),
    );
  const comparableValue =
    allocation.basis === "market_value" &&
    !temporaryEqualWeights &&
    Number.isFinite(allocation.valueTotal) &&
    allocation.valueTotal > 0 &&
    allocation.currencies.length === 1;
  return {
    ...result,
    totalReturnPct,
    targetWeightPct: contributions
      .filter((row) => row.targeted)
      .reduce((sum, row) => sum + row.weightPct, 0),
    startingValue: comparableValue ? allocation.valueTotal : null,
    valueChange: comparableValue
      ? (allocation.valueTotal * totalReturnPct) / 100
      : null,
    endingValue: comparableValue
      ? allocation.valueTotal * remainingValueFraction
      : null,
    currency: comparableValue ? allocation.currencies[0] : null,
    endingWeightsDefined: remainingValueFraction > 0,
    contributions: complete,
  };
}
