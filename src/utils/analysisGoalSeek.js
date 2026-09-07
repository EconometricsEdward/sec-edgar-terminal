import { labInput, labCalculatedPoint } from "./analysisFormula.js";

const HYPOTHETICAL =
  "Hypothetical arithmetic using user assumptions, not a forecast, probability, covenant test, or regulatory capital assessment. No tax benefit, management response, financing, or secondary effects are modeled.";

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
