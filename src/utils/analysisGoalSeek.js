import { labInput, labCalculatedPoint } from "./analysisFormula.js";
import { buildAnalysisScenario, SCENARIO_LIMITS } from "./analysisScenarios.js";

// Amounts are stored as USD strings; null alone means the reported default.
// Empty and incomplete drafts must remain visibly incomplete after restoration.
export const GOAL_SEEK_DEFAULTS = {
  goalMode: "revenue",
  goalTargetIncome: null,
  goalAssumedRevenue: null,
  goalAssumedMargin: null,
  goalEquityFloor: null,
  goalOperatingSolved: false,
  goalAssetSolved: false,
};
const numericDraft = /^[+-]?(?:\d+(?:\.\d*)?|\.\d*)?(?:[eE][+-]?\d*)?$/;
const completeNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export const isGoalNumericDraft = (raw) =>
  typeof raw === "string" && raw.length <= 80 && numericDraft.test(raw.trim());
const goalFields = {
  targetIncome: "goalTargetIncome",
  assumedRevenue: "goalAssumedRevenue",
  assumedMargin: "goalAssumedMargin",
  targetEquityRatio: "goalEquityFloor",
};

export function normalizeGoalSeekSettings(input = {}) {
  input = input && typeof input === "object" ? input : {};
  const out = { ...GOAL_SEEK_DEFAULTS };
  if (["revenue", "margin"].includes(input.goalMode))
    out.goalMode = input.goalMode;
  for (const key of Object.values(goalFields)) {
    const raw = input[key];
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = String(raw);
    else if (
      typeof raw === "string" &&
      raw.length <= 96 &&
      numericDraft.test(raw.trim())
    )
      out[key] = raw.trim();
  }
  for (const key of ["goalOperatingSolved", "goalAssetSolved"])
    out[key] = input[key] === true || input[key] === "true";
  return out;
}

// Decimal shifts preserve exact input strings, including amounts too large for
// Number; the solver will explicitly reject those instead of restoring defaults.
function shiftDraft(raw, power) {
  if (!completeNumber.test(raw)) return raw;
  const [coefficient, exponent = "0"] = raw.split(/[eE]/);
  const shifted = BigInt(exponent) + BigInt(power);
  const number = Number(`${coefficient}e${shifted}`);
  return Number.isFinite(number) && (number !== 0 || Number(coefficient) === 0)
    ? String(number)
    : `${coefficient}e${shifted}`;
}

export function goalSeekInput(data, index, settings = {}) {
  const defaults = goalSeekDefaults(data, index, "raw");
  const normalized = normalizeGoalSeekSettings(settings);
  return {
    mode: normalized.goalMode,
    targetIncome: normalized.goalTargetIncome ?? defaults.targetIncome,
    assumedRevenue: normalized.goalAssumedRevenue ?? defaults.assumedRevenue,
    assumedMargin: normalized.goalAssumedMargin ?? defaults.assumedMargin,
    targetEquityRatio: normalized.goalEquityFloor ?? defaults.targetEquityRatio,
  };
}

export function goalSeekDraft(data, index, settings = {}, units = "raw") {
  const input = goalSeekInput(data, index, settings);
  const power = Math.log10(goalSeekUnits(units).divisor);
  return {
    ...input,
    targetIncome: shiftDraft(input.targetIncome, -power),
    assumedRevenue: shiftDraft(input.assumedRevenue, -power),
  };
}

export function goalSeekDraftPatch(
  draft,
  units = "raw",
  fields = Object.keys(goalFields),
) {
  const power = Math.log10(goalSeekUnits(units).divisor);
  return {
    goalMode: draft.mode,
    ...Object.fromEntries(
      fields.map((field) => [
        goalFields[field],
        ["targetIncome", "assumedRevenue"].includes(field)
          ? shiftDraft(String(draft[field]), power)
          : String(draft[field]),
      ]),
    ),
  };
}

const HYPOTHETICAL =
  "Hypothetical arithmetic using user assumptions, not a forecast, probability, covenant test, or regulatory capital assessment. No tax benefit, management response, or secondary effects are modeled. Financing is included only where explicitly stated.";

export function goalSeekUnits(units) {
  if (units === "billions") return { divisor: 1e9, label: "USD billions" };
  if (units === "millions") return { divisor: 1e6, label: "USD millions" };
  // Auto is a display rule, not an unambiguous input denomination.
  return { divisor: 1, label: "USD" };
}

function amount(raw) {
  if (
    !["string", "number"].includes(typeof raw) ||
    (typeof raw === "string" && !raw.trim())
  )
    return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function selection(period, inputs, key, label, format, value, formula, note) {
  return {
    definition: { key: `goalSeek:${key}`, label, format },
    point: labCalculatedPoint(
      period,
      inputs,
      value,
      `Hypothetical: ${formula}`,
      `${HYPOTHETICAL} ${note}`,
    ),
  };
}

export function goalSeekDefaults(data, index, units) {
  const revenue = labInput(data, "revenue", index).point?.value;
  const income = labInput(data, "operatingIncome", index).point?.value;
  const assets = labInput(data, "totalAssets", index).point?.value;
  const equity = labInput(data, "stockholdersEquity", index).point?.value;
  const divisor = goalSeekUnits(units).divisor;
  return {
    mode: "revenue",
    targetIncome: Number.isFinite(income) ? String(income / divisor) : "",
    assumedRevenue: Number.isFinite(revenue) ? String(revenue / divisor) : "",
    assumedMargin:
      revenue > 0 && Number.isFinite(income)
        ? String((income / revenue) * 100)
        : "",
    targetEquityRatio:
      assets > 0 && Number.isFinite(equity)
        ? String((equity / assets) * 100)
        : "",
  };
}

export function solveOperatingGoal(data, input, index, units = "raw") {
  const period = data.periods?.[index];
  const inputs = [
    labInput(data, "revenue", index),
    labInput(data, "operatingIncome", index),
  ];
  let reason =
    data.lens !== "corporate"
      ? "This operating-margin exercise uses the corporate lens; bank and insurance revenue and operating cost scopes need a different model."
      : inputs.find((item) => item.reason)?.reason || null;
  if (!reason && inputs.some((item) => item.basis !== "period flow"))
    reason = "The operating baseline requires compatible period flows.";
  if (!reason && !(inputs[0].point.value > 0))
    reason = "The operating baseline requires positive reported revenue.";
  if (
    !reason &&
    (!Number.isFinite(inputs[0].point.value - inputs[1].point.value) ||
      inputs[0].point.value - inputs[1].point.value < 0)
  )
    reason =
      "Reported revenue less operating income implies negative or nonfinite operating costs; this operating model is unavailable.";
  const mode = input.mode;
  if (!reason && !["revenue", "margin"].includes(mode))
    reason = "Choose revenue or operating margin as the unknown.";
  const scale = goalSeekUnits(units);
  const target = amount(input.targetIncome);
  const assumption = amount(
    mode === "revenue" ? input.assumedMargin : input.assumedRevenue,
  );
  if (!reason && (target === null || assumption === null))
    reason = "Enter a finite target and assumption; blank inputs are not zero.";
  const income = target === null ? null : target * scale.divisor;
  const revenue = assumption === null ? null : assumption * scale.divisor;
  if (!reason && !(assumption > 0))
    reason =
      mode === "revenue"
        ? "Required revenue needs a strictly positive assumed operating margin. To explore a loss target, solve for margin instead."
        : "Required operating margin needs strictly positive assumed revenue.";
  if (!reason && mode === "revenue" && income < 0)
    reason =
      "A loss target with a positive margin would imply negative revenue. Solve for margin to explore a loss target.";
  const value = reason
    ? null
    : mode === "revenue"
      ? income / (assumption / 100)
      : (income / revenue) * 100;
  if (
    !reason &&
    (!Number.isFinite(income) ||
      !Number.isFinite(value) ||
      (mode === "margin" && !Number.isFinite(revenue)))
  )
    reason = "The entered amounts exceed the supported numerical range.";
  const requiredRevenue = mode === "revenue" ? value : revenue;
  const requiredMargin = mode === "revenue" ? assumption : value;
  const impliedCosts = requiredRevenue - income;
  if (!reason && !Number.isFinite(impliedCosts))
    reason =
      "The implied operating costs exceed the supported numerical range.";
  if (!reason && impliedCosts < 0)
    reason =
      "The target implies negative operating costs (an operating margin above 100%). Choose a target no higher than assumed revenue or a margin no higher than 100%.";
  const baseline =
    mode === "revenue"
      ? inputs[0].point?.value
      : (inputs[1].point?.value / inputs[0].point?.value) * 100;
  const formula =
    mode === "revenue"
      ? `target operating income USD ${income} / (assumed operating margin ${assumption}% / 100)`
      : `target operating income USD ${income} / assumed revenue USD ${revenue} × 100`;
  const note =
    `User target operating income = USD ${income}; ` +
    (mode === "revenue"
      ? `user assumed operating margin = ${assumption}%. `
      : `user assumed revenue = USD ${revenue}. `) +
    `Reported baseline revenue = USD ${inputs[0].point?.value}; operating income = USD ${inputs[1].point?.value}. Uses the selected reporting duration without annualization. Margin is held independently of revenue; this does not model fixed or variable costs or establish business feasibility.`;
  return {
    reason,
    mode,
    inputs,
    baseline,
    target: income,
    requiredRevenue: reason ? null : requiredRevenue,
    requiredMargin: reason ? null : requiredMargin,
    impliedCosts: reason ? null : impliedCosts,
    selection: reason
      ? null
      : selection(
          period,
          inputs,
          mode,
          mode === "revenue"
            ? "Hypothetical required revenue"
            : "Hypothetical required operating margin",
          mode === "revenue" ? "currency" : "percent",
          value,
          formula,
          note,
        ),
  };
}

export function solveAssetLossGoal(data, input, index) {
  const period = data.periods?.[index];
  const inputs = [
    labInput(data, "totalAssets", index),
    labInput(data, "stockholdersEquity", index),
  ];
  let reason = inputs.find((item) => item.reason)?.reason || null;
  if (!reason && inputs.some((item) => item.basis !== "ending balance"))
    reason = "The asset-loss exercise requires compatible ending balances.";
  const assets = inputs[0].point?.value;
  const equity = inputs[1].point?.value;
  const target = amount(input.targetEquityRatio);
  if (!reason && !(assets > 0))
    reason = "Positive reported total assets are required.";
  if (!reason && (target === null || target < 0 || target >= 100))
    reason = "Enter a target ratio from 0% up to, but below, 100%.";
  if (!reason && equity >= assets)
    reason =
      "This exercise requires equity below assets. At or above 100%, dollar-for-dollar losses do not reduce this ratio toward the target.";
  const ratio = target === null ? null : target / 100;
  const baselineRatio = assets > 0 ? (equity / assets) * 100 : null;
  if (!reason && !Number.isFinite(baselineRatio))
    reason = "The reported ratio exceeds the supported numerical range.";
  // Compare ratios with a small rounding tolerance so a reported-ratio reset
  // does not manufacture a tiny positive/negative boundary through division.
  const atTarget = !reason && Math.abs(baselineRatio - target) < 1e-10;
  const below = !reason && !atTarget && baselineRatio < target;
  const rawLoss =
    reason || below || atTarget ? 0 : (equity - ratio * assets) / (1 - ratio);
  if (!reason && (!Number.isFinite(rawLoss) || !(assets - rawLoss > 0)))
    reason = "The target leaves no positive asset balance in this model.";
  const status = reason
    ? "unavailable"
    : below
      ? "alreadyBelow"
      : atTarget
        ? "atTarget"
        : "solved";
  const loss = reason ? null : Math.max(0, rawLoss);
  const note = `User target shareholder equity / assets = ${target}%; reported assets = USD ${assets}; reported shareholder equity = USD ${equity}; baseline ratio = ${baselineRatio}%. Incremental noncash asset loss reduces assets and reported shareholder equity dollar-for-dollar, with no tax benefit or use of existing allowances. No deposit withdrawal is included. Reported shareholder equity and consolidated assets may differ in scope. ${below ? "The baseline is already below the user target; zero means no additional loss is permitted by this exercise and does not mean the target is attained." : atTarget ? "The baseline is at the user target; any positive modeled loss lowers the ratio." : "The solved loss is the boundary at which the modeled ratio equals the user target; a larger loss falls below it."}`;
  const formula =
    below || atTarget
      ? `maximum additional asset loss = 0 because the reported ratio is ${below ? "below" : "at"} the user target ${target}%`
      : `(reported equity USD ${equity} − target ratio ${ratio} × reported assets USD ${assets}) / (1 − target ratio ${ratio})`;
  const rows = reason
    ? []
    : [
        selection(
          period,
          inputs,
          "assetLoss",
          "Hypothetical maximum additional asset loss",
          "currency",
          loss,
          formula,
          note,
        ),
        selection(
          period,
          inputs,
          "assetLossShare",
          "Hypothetical maximum loss / baseline assets",
          "percent",
          (loss / assets) * 100,
          `(${formula}) / reported assets USD ${assets} × 100`,
          note,
        ),
      ];
  return { reason, status, inputs, baselineRatio, target, loss, rows };
}

function patchLimitReason(patch) {
  for (const [key, value] of Object.entries(patch)) {
    const limits = SCENARIO_LIMITS[key];
    if (!limits) continue;
    if (
      !Number.isFinite(value) ||
      value < limits[0] - 1e-10 ||
      value > limits[1] + 1e-10
    )
      return `The solved ${key === "scenarioRevenue" ? "revenue change" : key === "scenarioMargin" ? "margin change" : "asset loss"} is outside the scenario range of ${limits[0]} to ${limits[1]}${key === "scenarioMargin" ? " percentage points" : "%"}. Adjust the target; it will not be clamped.`;
  }
  return null;
}

export function operatingGoalApplication(data, input, index, settings = {}) {
  const solved = solveOperatingGoal(data, input, index, "raw");
  if (solved.reason)
    return { reason: solved.reason, patch: null, preview: null };
  const revenue = solved.inputs[0].point.value;
  const income = solved.inputs[1].point.value;
  const patch = {
    scenarioModel: "margin",
    scenarioRevenue: (solved.requiredRevenue / revenue - 1) * 100,
    scenarioMargin: solved.requiredMargin - (income / revenue) * 100,
  };
  let reason = patchLimitReason(patch);
  const preview = reason
    ? null
    : buildAnalysisScenario(data, { ...settings, ...patch }, index);
  reason ||= preview?.operating?.reason || null;
  return { reason, patch: reason ? null : patch, preview, solved };
}

export function assetLossGoalApplication(data, input, index, settings = {}) {
  const solved = solveAssetLossGoal(data, input, index);
  if (solved.reason)
    return { reason: solved.reason, patch: null, preview: null };
  if (solved.status === "alreadyBelow")
    return {
      reason:
        "The reported baseline is already below your floor. Zero additional loss does not attain it, so this result cannot be applied as a solved target.",
      patch: null,
      preview: null,
    };
  const patch = {
    scenarioLoss: (solved.loss / solved.inputs[0].point.value) * 100,
    scenarioFunding: 0,
    scenarioReplacementFunding: 0,
  };
  let reason = patchLimitReason(patch);
  const preview = reason
    ? null
    : buildAnalysisScenario(data, { ...settings, ...patch }, index);
  reason ||= preview?.balance?.reason || null;
  return { reason, patch: reason ? null : patch, preview, solved };
}

// The floor is the user's accounting-ratio assumption, never a regulatory or
// covenant threshold. Additional loss starts from the CURRENT scenario.
export function buildScenarioHeadroom(data, settings, index) {
  const input = goalSeekInput(data, index, settings);
  const baseline = solveAssetLossGoal(data, input, index);
  const scenario = buildAnalysisScenario(data, settings, index);
  const balance = scenario.balance;
  const currentAssetRow = balance.rows.find((row) => row.key === "Assets");
  const currentEquityRow = balance.rows.find((row) => row.key === "Equity");
  const currentAssets = currentAssetRow?.selection.point.value;
  const currentEquity = currentEquityRow?.selection.point.value;
  let reason = baseline.reason || balance.reason || null;
  if (!reason && (!(currentAssets > 0) || !Number.isFinite(currentEquity)))
    reason =
      "Current scenario balances are unavailable; remaining loss headroom cannot be calculated.";
  if (!reason && currentEquity >= currentAssets)
    reason =
      "Current shareholder equity must be below assets for dollar-for-dollar losses to reduce the ratio toward your floor.";
  const currentRatio = reason ? null : (currentEquity / currentAssets) * 100;
  if (!reason && !Number.isFinite(currentRatio))
    reason =
      "The current scenario ratio exceeds the supported numerical range.";
  const atTarget = !reason && Math.abs(currentRatio - baseline.target) < 1e-10;
  const below = !reason && !atTarget && currentRatio < baseline.target;
  const ratio = baseline.target / 100;
  const rawLoss =
    reason || below || atTarget
      ? 0
      : (currentEquity - ratio * currentAssets) / (1 - ratio);
  if (!reason && (!Number.isFinite(rawLoss) || !(currentAssets - rawLoss > 0)))
    reason =
      "The current scenario leaves no valid finite asset-loss boundary at your floor.";
  const remainingLoss = reason ? null : Math.max(0, rawLoss);
  const status = reason
    ? "unavailable"
    : below
      ? "alreadyBelow"
      : atTarget
        ? "atTarget"
        : "headroom";
  const inputs = reason
    ? []
    : [currentAssetRow.selection.point, currentEquityRow.selection.point];
  const baselineAssets = baseline.inputs[0].point?.value;
  const noncashShare = balance.capacity?.noncashLossPct;
  const remainingNoncash =
    Number.isFinite(noncashShare) && Number.isFinite(balance.loss)
      ? Math.max(0, (baselineAssets * noncashShare) / 100 - balance.loss)
      : null;
  const capacityNote =
    remainingNoncash === null
      ? "Compatible reported cash is unavailable, so remaining noncash assets cannot be verified."
      : remainingLoss > remainingNoncash + Math.max(1, remainingNoncash) * 1e-10
        ? "The arithmetic floor boundary exceeds the remaining noncash assets. This model cannot reach the floor using noncash asset losses alone."
        : null;
  const note = `User accounting-ratio floor = ${baseline.target}%. Reported baseline ratio = ${baseline.baselineRatio}%. Current scenario assets = USD ${currentAssets}; shareholder equity = USD ${currentEquity}; ratio = ${currentRatio}%. Additional noncash loss reduces current assets and equity dollar-for-dollar. ${balance.note || ""} ${below ? "The current scenario is already below the floor; zero headroom does not mean the floor is attained." : atTarget ? "The current scenario is at the floor; any additional loss goes below it." : "The remaining loss is measured from current scenario balances, with current funding assumptions held fixed."}`;
  const rows = reason
    ? []
    : [
        selection(
          scenario.period,
          baseline.inputs,
          "baselineEquityAssets",
          "Reported baseline shareholder equity / assets",
          "percent",
          baseline.baselineRatio,
          "reported shareholder equity / reported assets × 100",
          note,
        ),
        selection(
          scenario.period,
          inputs,
          "currentEquityAssets",
          "Current scenario shareholder equity / assets",
          "percent",
          currentRatio,
          `current scenario shareholder equity USD ${currentEquity} / current scenario assets USD ${currentAssets} × 100`,
          note,
        ),
        selection(
          scenario.period,
          inputs,
          "remainingLoss",
          "Remaining additional loss to your floor",
          "currency",
          remainingLoss,
          below || atTarget
            ? `0 because the current scenario is ${below ? "below" : "at"} the user floor`
            : `(current equity USD ${currentEquity} − user floor ${ratio} × current assets USD ${currentAssets}) / (1 − user floor ${ratio})`,
          note,
        ),
      ];
  let cash = null;
  if (scenario.banking) {
    const usableCash = balance.usableCash;
    const borrowedCash = balance.borrowing;
    const withdrawal = balance.withdrawal;
    const available =
      balance.funding?.available &&
      [
        usableCash,
        borrowedCash,
        withdrawal,
        usableCash + (borrowedCash - withdrawal),
      ].every(Number.isFinite);
    const remaining = available
      ? Math.max(0, usableCash + (borrowedCash - withdrawal))
      : null;
    const cashInputs = balance.inputs.filter(
      (item) => ["cash", "deposits"].includes(item.key) && !item.reason,
    );
    const cashNote = `Usable reported cash = USD ${usableCash}, using the explicit ${scenario.settings.scenarioCashAvailable}% availability assumption. Assumed borrowed cash = USD ${borrowedCash}; borrowing adds cash and a matching liability, without adding equity. Current assumed withdrawal = USD ${withdrawal}. This arithmetic cash-payment capacity does not infer future borrowing access, asset-sale proceeds, deposit outflow probabilities, a covenant limit, or regulatory liquidity compliance.`;
    cash = {
      reason: available
        ? null
        : balance.funding?.reason ||
          balance.reason ||
          "Compatible cash and deposit inputs are required.",
      remaining,
      gap: available ? balance.fundingGap : null,
      rows: available
        ? [
            selection(
              scenario.period,
              cashInputs,
              "usableCash",
              "Usable reported cash",
              "currency",
              usableCash,
              `reported cash × explicit available share ${scenario.settings.scenarioCashAvailable}% / 100`,
              cashNote,
            ),
            selection(
              scenario.period,
              cashInputs,
              "borrowedCash",
              "Assumed borrowed cash",
              "currency",
              borrowedCash,
              `reported deposits × explicit replacement borrowing ${scenario.settings.scenarioReplacementFunding}% / 100`,
              cashNote,
            ),
            selection(
              scenario.period,
              cashInputs,
              "cashWithdrawal",
              "Current assumed withdrawal",
              "currency",
              withdrawal,
              `reported deposits × explicit withdrawal ${scenario.settings.scenarioFunding}% / 100`,
              cashNote,
            ),
            selection(
              scenario.period,
              cashInputs,
              "remainingCashWithdrawal",
              "Remaining cash-funded withdrawal capacity",
              "currency",
              remaining,
              `max(0, usable reported cash USD ${usableCash} + assumed borrowed cash USD ${borrowedCash} − current assumed withdrawal USD ${withdrawal})`,
              cashNote,
            ),
          ]
        : [],
    };
  }
  return {
    reason,
    status,
    target: baseline.target,
    baselineRatio: baseline.baselineRatio,
    currentRatio,
    currentAssets,
    currentEquity,
    remainingLoss,
    remainingNoncash,
    capacityNote,
    rows,
    cash,
    scenario,
  };
}
