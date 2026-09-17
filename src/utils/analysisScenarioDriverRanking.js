import { buildAnalysisScenario, normalizeScenarioSettings, SCENARIO_LIMITS } from "./analysisScenarios.js";

const definitions = {
  scenarioRevenue: ["Revenue change", "%", 5, "Change from reported revenue"],
  scenarioMargin: ["Margin change", "pp", 2, "Percentage points added to reported operating margin"],
  scenarioVariableCost: ["Variable-cost share", "%", 10, "Share of baseline implied operating costs"],
  scenarioCostChange: ["Cost change", "%", 5, "Change in modeled costs after the revenue-volume effect"],
  scenarioLoss: ["Asset loss", "%", 2, "Share of reported total assets"],
  scenarioFunding: ["Deposit withdrawal", "%", 5, "Share of reported deposits"],
  scenarioCashAvailable: ["Usable reported cash", "%", 10, "Share of reported cash assumed available"],
  scenarioReplacementFunding: ["Replacement borrowing", "%", 5, "New borrowing as a share of reported deposits"],
  scenarioTaxRate: ["Tax on incremental profit", "%", 5, "Tax on positive incremental pretax earnings only"],
  scenarioWorkingCapital: ["Additional working-capital use", "%", 5, "Share of reported revenue; negative means cash release"],
  scenarioCapexChange: ["Capital-spending change", "%", 10, "Change from reported PP&E purchases"],
  scenarioBorrowing: ["Additional borrowing", "%", 5, "New borrowing as a share of reported revenue"],
  scenarioDebtRepayment: ["Debt repayment", "%", 5, "Share of selected reported current plus noncurrent debt"],
  scenarioBorrowRate: ["New borrowing interest rate", "%", 1, "Annual interest rate on new borrowing"],
};

export function scenarioDriverExercises(data, settings) {
  return [
    ...(data.lens === "corporate" ? [
      { key: "operating", label: "Operating performance" },
      ...(settings.scenarioCashMode === "connected" ? [{ key: "connected", label: "Connected cash & balance sheet" }] : []),
    ] : []),
    { key: "balance", label: "Independent balance stress" },
  ];
}

export function scenarioDriverOutcomes(data, exercise) {
  const currency = (key, label) => ({ key, label, format: "currency" });
  const percent = (key, label) => ({ key, label, format: "percent" });
  if (exercise === "operating") return [currency("OperatingIncome", "Operating income"), percent("Margin", "Operating margin")];
  if (exercise === "connected") return [currency("Cash", "Cash before extra funding"), currency("FundingGap", "Unfunded cash need"), currency("FreeCashFlow", "Free cash flow"), currency("Debt", "Selected ending debt"), percent("EquityAssets", "Shareholder equity / assets")];
  return [percent("EquityAssets", "Shareholder equity / assets"), ...(data.lens === "banking" ? [currency("Cash", "Cash after withdrawals")] : [])];
}

export function scenarioDriverDefinitions(data, input, exercise) {
  const settings = normalizeScenarioSettings(input);
  const operating = ["scenarioRevenue", ...(settings.scenarioModel === "cost" ? ["scenarioVariableCost", "scenarioCostChange"] : ["scenarioMargin"])];
  const keys = exercise === "operating" ? operating : exercise === "connected" ? [
    ...operating, "scenarioTaxRate", "scenarioWorkingCapital", "scenarioCapexChange", "scenarioBorrowing", "scenarioDebtRepayment", "scenarioBorrowRate",
  ] : ["scenarioLoss", ...(data.lens === "banking" ? ["scenarioFunding", "scenarioCashAvailable", "scenarioReplacementFunding"] : [])];
  return keys.filter((key) => SCENARIO_LIMITS[key]).map((key) => {
    const [label, unit, shock, basis] = definitions[key];
    const [min, max] = SCENARIO_LIMITS[key];
    const current = settings[key];
    return { key, label, unit, shock, basis, min, max, current, low: Math.max(min, current - shock), high: Math.min(max, current + shock) };
  });
}

function result(scenario, exercise, outcome, analysisSettings) {
  const section = scenario[exercise];
  const row = section?.rows?.find((item) => item.key === outcome);
  const reason = section?.reason || row?.selection?.point?.reason ||
    (outcome === "Cash" && exercise === "balance" ? section?.funding?.reason : null) ||
    (!Number.isFinite(row?.selection?.point?.value) ? "This outcome is unavailable for these reported inputs and assumptions." : null);
  return { value: reason ? null : row.selection.point.value, reason,
    selection: reason ? null : { ...row.selection, analysisSettings } };
}

/** One-at-a-time endpoint sensitivity around the committed case. Endpoint
 * changes are model sensitivities, not additive attribution or probabilities. */
export function buildScenarioDriverRanking(data, input = {}, index = 0, options = {}) {
  const settings = normalizeScenarioSettings(input);
  const exercises = scenarioDriverExercises(data, settings);
  const exercise = exercises.some((item) => item.key === options.exercise) ? options.exercise : exercises[0].key;
  const outcomes = scenarioDriverOutcomes(data, exercise);
  const outcome = outcomes.find((item) => item.key === options.outcome) || outcomes[0];
  const period = data.periods?.[index];
  const analysisSettings = (patch) => ({ ...input, ...settings, ...patch, view: "scenarios", basis: data.basis || period?.kind, end: period?.end, asOf: data.asOf ?? input.asOf ?? null });
  const current = result(buildAnalysisScenario(data, settings, index), exercise, outcome.key, analysisSettings({}));
  const drivers = scenarioDriverDefinitions(data, settings, exercise).map((driver) => {
    const custom = options.ranges?.[driver.key];
    const low = custom ? custom.low : driver.low;
    const high = custom ? custom.high : driver.high;
    const rangeReason = !Number.isFinite(low) || !Number.isFinite(high) || low < driver.min || high > driver.max || low > driver.current || high < driver.current || low >= high
      ? `Choose distinct low and high values within ${driver.min} to ${driver.max} ${driver.unit}, spanning the committed value ${driver.current} ${driver.unit}.` : null;
    const endpoint = (value) => {
      if (rangeReason) return { assumption: value, value: null, delta: null, reason: rangeReason, selection: null };
      const patch = { [driver.key]: value };
      const resolved = result(buildAnalysisScenario(data, { ...settings, ...patch }, index), exercise, outcome.key, analysisSettings(patch));
      return { ...resolved, assumption: value, delta: Number.isFinite(current.value) && Number.isFinite(resolved.value) ? resolved.value - current.value : null };
    };
    const lower = endpoint(low), upper = endpoint(high);
    const comparable = Number.isFinite(lower.delta) && Number.isFinite(upper.delta);
    return { ...driver, low, high, lower, upper, rangeReason,
      magnitude: comparable ? Math.max(Math.abs(lower.delta), Math.abs(upper.delta)) : null,
      reason: rangeReason || current.reason || lower.reason || upper.reason || null };
  }).sort((a, b) => (b.magnitude ?? -1) - (a.magnitude ?? -1) || a.label.localeCompare(b.label));
  return { settings, exercise, exercises, outcome, outcomes, current, drivers,
    maximum: Math.max(0, ...drivers.filter((row) => Number.isFinite(row.magnitude)).map((row) => row.magnitude)),
    note: "One assumption changes at a time; all others stay at their committed values. Ranked by the largest absolute outcome change at the chosen endpoints. Ranges are user assumptions: changing them changes the ranking. These effects are not additive, causal estimates, or probabilities.",
  };
}
