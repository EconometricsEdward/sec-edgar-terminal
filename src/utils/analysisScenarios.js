import { labInput, labCalculatedPoint } from "./analysisFormula.js";

export const SCENARIO_DEFAULTS = {
  scenarioRevenue: 0,
  scenarioMargin: 0,
  scenarioLoss: 0,
  scenarioFunding: 0,
};
export function normalizeScenarioSettings(input = {}) {
  const limits = {
    scenarioRevenue: [-50, 50],
    scenarioMargin: [-20, 20],
    scenarioLoss: [0, 20],
    scenarioFunding: [0, 50],
  };
  return Object.fromEntries(
    Object.entries(limits).map(([key, [min, max]]) => {
      const candidate =
        typeof input[key] === "number" || typeof input[key] === "string"
          ? Number(input[key])
          : NaN;
      return [
        key,
        Number.isFinite(candidate)
          ? Math.round(Math.min(max, Math.max(min, candidate)) * 100) / 100
          : 0,
      ];
    }),
  );
}
const ratio = (a, b) => (b > 0 ? (a / b) * 100 : null);
const hypothetical =
  "Hypothetical static sensitivity, not a forecast or reported SEC result. No probabilities, tax effects, management response, regulatory capital treatment, or secondary effects are modeled.";

export function buildAnalysisScenario(data, input, index) {
  const settings = normalizeScenarioSettings(input);
  const period = data.periods?.[index];
  const get = (key) => labInput(data, key, index);
  const corporate = data.lens === "corporate";
  const banking = data.lens === "banking";
  const operatingInputs = corporate
    ? [get("revenue"), get("operatingIncome")]
    : [];
  let operatingReason = operatingInputs.find((i) => i.reason)?.reason || null;
  if (
    corporate &&
    !operatingReason &&
    (operatingInputs.some((i) => i.basis !== "period flow") ||
      !(operatingInputs[0].point.value > 0))
  )
    operatingReason =
      "Operating sensitivity requires positive revenue and compatible operating income for the selected reporting duration.";
  const revenue = operatingInputs[0]?.point?.value;
  const income = operatingInputs[1]?.point?.value;
  const changedRevenue =
    !operatingReason && corporate
      ? revenue * (1 + settings.scenarioRevenue / 100)
      : null;
  const changedMargin =
    !operatingReason && corporate
      ? (income / revenue) * 100 + settings.scenarioMargin
      : null;
  const changedIncome =
    Number.isFinite(changedRevenue) && Number.isFinite(changedMargin)
      ? (changedRevenue * changedMargin) / 100
      : null;
  const make = (
    key,
    label,
    format,
    baseline,
    value,
    inputs,
    formula,
    note,
  ) => ({
    key,
    label,
    format,
    baseline,
    selection: {
      definition: {
        key: `scenario${key}`,
        label: `Hypothetical ${label}`,
        format,
      },
      point: labCalculatedPoint(
        period,
        inputs,
        value,
        `Hypothetical: ${formula}`,
        `${hypothetical} ${note}`,
      ),
    },
  });
  const operating = corporate
    ? {
        reason: operatingReason,
        inputs: operatingInputs,
        rows: operatingReason
          ? []
          : [
              make(
                "Revenue",
                "Revenue",
                "currency",
                revenue,
                changedRevenue,
                [operatingInputs[0]],
                `reported revenue × (1 + ${settings.scenarioRevenue}% / 100)`,
                "Revenue is changed by the selected assumption.",
              ),
              make(
                "Margin",
                "Operating margin",
                "percent",
                (income / revenue) * 100,
                changedMargin,
                operatingInputs,
                `reported operating income / reported revenue × 100 + ${settings.scenarioMargin} percentage points`,
                "Margin movement is an independent user assumption; costs are implied by revenue less operating income.",
              ),
              make(
                "OperatingIncome",
                "Operating income",
                "currency",
                income,
                changedIncome,
                operatingInputs,
                `reported revenue × (1 + ${settings.scenarioRevenue}% / 100) × (reported operating income / reported revenue + ${settings.scenarioMargin} / 100)`,
                "This does not model net income, cash flow, tax, or balance sheet effects. The separate balance exercise below is not linked to this result.",
              ),
            ],
      }
    : null;
  const assetsInput = get("totalAssets"),
    equityInput = get("stockholdersEquity");
  const required = [assetsInput, equityInput];
  if (banking) required.push(get("cash"), get("deposits"));
  let reason = required.find((i) => i.reason)?.reason || null;
  if (!reason && required.some((i) => i.basis !== "ending balance"))
    reason = "Balance sensitivity requires compatible ending balances.";
  const assets = assetsInput.point?.value,
    equity = equityInput.point?.value;
  const cash = banking ? required[2].point?.value : null;
  const deposits = banking ? required[3].point?.value : null;
  if (!reason && (!(assets > 0) || (banking && (!(deposits > 0) || cash < 0))))
    reason =
      "Positive assets and deposits, and nonnegative reported cash, are required for this balance exercise.";
  const loss = !reason ? (assets * settings.scenarioLoss) / 100 : null;
  const withdrawal = banking
    ? !reason
      ? (deposits * settings.scenarioFunding) / 100
      : null
    : 0;
  const fundingGap = !reason && banking ? Math.max(0, withdrawal - cash) : null;
  if (!reason && fundingGap > 0)
    reason =
      "The assumed withdrawal exceeds reported cash. The cash-only model cannot complete; asset sales or replacement funding would require additional assumptions.";
  const nextAssets = !reason ? assets - loss - withdrawal : null;
  const nextEquity = !reason ? equity - loss : null;
  const nextCash = !reason && banking ? cash - withdrawal : null;
  const nextDeposits = !reason && banking ? deposits - withdrawal : null;
  if (!reason && !(nextAssets > 0))
    reason =
      "Hypothetical ending assets must remain positive; this assumption set exceeds the model's valid range.";
  const note = `Incremental noncash asset loss = ${settings.scenarioLoss}% of baseline total assets; charged fully to the reported shareholder equity balance, with no tax benefit or use of existing allowances. ${banking ? `Deposit withdrawal = ${settings.scenarioFunding}% of baseline deposits, paid entirely from reported cash; assets and deposits fall equally, with no change to equity from the withdrawal. Reported cash availability is not verified and may include restricted or operational balances. ` : ""}Shareholder equity and consolidated assets can differ in scope; this ratio is not a regulatory capital ratio. Operating results above, if present, are a separate exercise.`;
  const rows = reason
    ? []
    : [
        make(
          "Assets",
          "Total assets",
          "currency",
          assets,
          nextAssets,
          required,
          `assets − assets × ${settings.scenarioLoss} / 100${banking ? ` − deposits × ${settings.scenarioFunding} / 100` : ""}`,
          note,
        ),
        make(
          "Equity",
          "Shareholder equity",
          "currency",
          equity,
          nextEquity,
          [assetsInput, equityInput],
          `shareholder equity − assets × ${settings.scenarioLoss} / 100`,
          note,
        ),
        make(
          "EquityAssets",
          "Shareholder equity / assets",
          "percent",
          ratio(equity, assets),
          ratio(nextEquity, nextAssets),
          required,
          `(equity − assets × ${settings.scenarioLoss} / 100) / (assets − assets × ${settings.scenarioLoss} / 100${banking ? ` − deposits × ${settings.scenarioFunding} / 100` : ""}) × 100`,
          note,
        ),
      ];
  if (!reason && banking)
    rows.push(
      make(
        "Cash",
        "Cash after withdrawals",
        "currency",
        cash,
        nextCash,
        [required[2], required[3]],
        `cash − deposits × ${settings.scenarioFunding} / 100`,
        note,
      ),
      make(
        "Deposits",
        "Deposits",
        "currency",
        deposits,
        nextDeposits,
        [required[3]],
        `deposits × (1 − ${settings.scenarioFunding} / 100)`,
        note,
      ),
    );
  return {
    settings,
    operating,
    balance: {
      reason,
      inputs: required,
      rows,
      loss,
      withdrawal,
      fundingGap,
      note,
    },
    banking,
    corporate,
    period,
  };
}
