import { labInput, labCalculatedPoint } from "./analysisFormula.js";

export const SCENARIO_DEFAULTS = {
  scenarioRevenue: 0,
  scenarioMargin: 0,
  scenarioLoss: 0,
  scenarioFunding: 0,
  scenarioModel: "margin",
  scenarioVariableCost: 60,
  scenarioCostChange: 0,
  scenarioCashAvailable: 100,
  scenarioReplacementFunding: 0,
};
export const SCENARIO_LIMITS = {
  scenarioRevenue: [-50, 50],
  scenarioMargin: [-20, 20],
  scenarioLoss: [0, 20],
  scenarioFunding: [0, 50],
  scenarioVariableCost: [0, 100],
  scenarioCostChange: [-50, 50],
  scenarioCashAvailable: [0, 100],
  scenarioReplacementFunding: [0, 50],
};
export function normalizeScenarioSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const settings = { ...SCENARIO_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(SCENARIO_LIMITS)) {
    const raw = source[key];
    const candidate =
      typeof raw === "number" || (typeof raw === "string" && raw.trim())
        ? Number(raw)
        : NaN;
    if (Number.isFinite(candidate))
      settings[key] = Math.min(max, Math.max(min, candidate));
  }
  if (["margin", "cost"].includes(source.scenarioModel))
    settings.scenarioModel = source.scenarioModel;
  return settings;
}
const ratio = (a, b) => {
  const value = b > 0 ? (a / b) * 100 : NaN;
  return Number.isFinite(value) ? value : null;
};
const hypothetical =
  "Hypothetical static sensitivity, not a forecast or reported SEC result. No probabilities, tax effects, management response, regulatory capital treatment, or secondary effects are modeled.";
const diagnostic = (key, status, message) => ({ key, status, message });
const endingInputReason = (inputs) =>
  inputs.find((item) => item.reason)?.reason ||
  (inputs.some((item) => item.basis !== "ending balance")
    ? "Balance sensitivity requires compatible ending balances."
    : null);

export function buildAnalysisScenario(data, input, index) {
  const settings = normalizeScenarioSettings(input);
  const period = data.periods?.[index];
  const get = (key) => labInput(data, key, index);
  const corporate = data.lens === "corporate";
  const banking = data.lens === "banking";
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
  let operating = null;
  if (corporate) {
    const inputs = [get("revenue"), get("operatingIncome")];
    let reason = inputs.find((item) => item.reason)?.reason || null;
    const revenue = inputs[0].point?.value;
    const income = inputs[1].point?.value;
    if (
      !reason &&
      (inputs.some((item) => item.basis !== "period flow") || !(revenue > 0))
    )
      reason =
        "Operating sensitivity requires positive revenue and compatible operating income for the selected reporting duration.";
    const costModel = settings.scenarioModel === "cost";
    const growth = settings.scenarioRevenue / 100;
    const marginChange = settings.scenarioMargin / 100;
    const inflation = settings.scenarioCostChange / 100;
    const baselineMargin = ratio(income, revenue);
    const baselineCost = !reason ? revenue - income : null;
    if (!reason && baselineMargin === null)
      reason = "The operating baseline exceeds the supported numerical range.";
    if (
      !reason &&
      costModel &&
      (!Number.isFinite(baselineCost) || baselineCost < 0)
    )
      reason =
        "The cost model requires finite, nonnegative implied operating costs (reported revenue less operating income).";
    const variableCost =
      !reason && costModel
        ? baselineCost * (settings.scenarioVariableCost / 100)
        : null;
    const fixedCost = !reason && costModel ? baselineCost - variableCost : null;
    const changedRevenue = !reason ? revenue * (1 + growth) : null;
    const costAfterVolume =
      !reason && costModel ? fixedCost + variableCost * (1 + growth) : null;
    const changedCost =
      !reason && costModel ? costAfterVolume * (1 + inflation) : null;
    const changedIncome = !reason
      ? costModel
        ? changedRevenue - changedCost
        : income * (1 + growth) + changedRevenue * marginChange
      : null;
    const changedMargin = !reason
      ? costModel
        ? ratio(changedIncome, changedRevenue)
        : baselineMargin + settings.scenarioMargin
      : null;
    const bridgeMethod = costModel
      ? "First change revenue and variable costs with revenue volume; then apply the assumed cost change to both fixed and volume-adjusted variable costs."
      : "Separate the revenue effect at baseline margin, the margin effect at baseline revenue, and their interaction.";
    const note = costModel
      ? `Revenue change = ${settings.scenarioRevenue}%; baseline implied operating costs = reported revenue less operating income. User variable-cost share = ${settings.scenarioVariableCost}% of baseline implied costs; the remainder is fixed. Variable costs move proportionately with revenue; this is a modeling assumption, not reported cost behavior. After the volume change, both fixed and variable costs change by ${settings.scenarioCostChange}%. The operating margin control is inactive in this model. ${bridgeMethod} This does not model net income, cash flow, tax, or balance sheet effects. The separate balance exercise below is not linked to this result.`
      : `Revenue change = ${settings.scenarioRevenue}%; operating margin change = ${settings.scenarioMargin} percentage points. Margin movement is an independent user assumption; costs are implied by revenue less operating income. ${bridgeMethod} This does not model net income, cash flow, tax, or balance sheet effects. The separate balance exercise below is not linked to this result.`;
    const bridgeParts = costModel
      ? [
          [
            "RevenueGrowth",
            "Revenue growth",
            revenue * growth,
            `reported revenue × (${settings.scenarioRevenue} / 100)`,
          ],
          [
            "VariableCostVolume",
            "Variable cost volume",
            -variableCost * growth,
            `− baseline implied costs × (${settings.scenarioVariableCost} / 100) × (${settings.scenarioRevenue} / 100)`,
          ],
          [
            "CostInflation",
            "Cost change after volume",
            -costAfterVolume * inflation,
            `− (fixed costs + baseline variable costs × (1 + ${settings.scenarioRevenue} / 100)) × (${settings.scenarioCostChange} / 100)`,
          ],
        ]
      : [
          [
            "RevenueEffect",
            "Revenue effect at baseline margin",
            income * growth,
            `reported operating income × (${settings.scenarioRevenue} / 100)`,
          ],
          [
            "MarginEffect",
            "Margin effect at baseline revenue",
            revenue * marginChange,
            `reported revenue × (${settings.scenarioMargin} / 100)`,
          ],
          [
            "Interaction",
            "Revenue and margin interaction",
            revenue * growth * marginChange,
            `reported revenue × (${settings.scenarioRevenue} / 100) × (${settings.scenarioMargin} / 100)`,
          ],
        ];
    const delta = !reason ? changedIncome - income : null;
    if (
      !reason &&
      (![
        changedRevenue,
        changedIncome,
        changedMargin,
        delta,
        ...bridgeParts.map((part) => part[2]),
      ].every(Number.isFinite) ||
        (costModel && !Number.isFinite(changedCost)))
    )
      reason =
        "The operating assumptions exceed the supported numerical range; hypothetical results are unavailable.";
    const rows = reason
      ? []
      : [
          make(
            "Revenue",
            "Revenue",
            "currency",
            revenue,
            changedRevenue,
            [inputs[0]],
            `reported revenue × (1 + ${settings.scenarioRevenue} / 100)`,
            note,
          ),
          make(
            "Margin",
            "Operating margin",
            "percent",
            baselineMargin,
            changedMargin,
            inputs,
            costModel
              ? "hypothetical operating income / hypothetical revenue × 100"
              : `reported operating income / reported revenue × 100 + ${settings.scenarioMargin} percentage points`,
            note,
          ),
          make(
            "OperatingIncome",
            "Operating income",
            "currency",
            income,
            changedIncome,
            inputs,
            costModel
              ? `reported revenue × (1 + ${settings.scenarioRevenue} / 100) − (fixed costs + variable costs × (1 + ${settings.scenarioRevenue} / 100)) × (1 + ${settings.scenarioCostChange} / 100)`
              : `reported revenue × (1 + ${settings.scenarioRevenue} / 100) × (reported operating income / reported revenue + ${settings.scenarioMargin} / 100)`,
            note,
          ),
        ];
    if (!reason && costModel)
      rows.push(
        make(
          "OperatingCosts",
          "Implied operating costs",
          "currency",
          baselineCost,
          changedCost,
          inputs,
          `(baseline fixed costs + baseline variable costs × (1 + ${settings.scenarioRevenue} / 100)) × (1 + ${settings.scenarioCostChange} / 100)`,
          note,
        ),
      );
    const diagnostics = reason
      ? [diagnostic("operatingUnavailable", "error", reason)]
      : [];
    if (!reason && changedIncome < 0)
      diagnostics.push(
        diagnostic(
          "operatingLoss",
          "warning",
          "These assumptions produce an operating loss; no net income or cash-flow conclusion is implied.",
        ),
      );
    if (!reason && !costModel && changedMargin > 100)
      diagnostics.push(
        diagnostic(
          "negativeImpliedCosts",
          "warning",
          "The assumed operating margin exceeds 100%, implying negative operating costs. The arithmetic does not establish business feasibility.",
        ),
      );
    operating = {
      reason,
      inputs,
      rows,
      bridgeMethod,
      note,
      delta: reason ? null : delta,
      bridge: reason
        ? []
        : bridgeParts.map(([key, label, amount, formula]) =>
            make(key, label, "currency", 0, amount, inputs, formula, note),
          ),
      costs:
        costModel && !reason
          ? {
              baseline: baselineCost,
              variable: variableCost,
              fixed: fixedCost,
              hypothetical: changedCost,
            }
          : null,
      diagnostics,
    };
  }

  const assetsInput = get("totalAssets");
  const equityInput = get("stockholdersEquity");
  const cashInput = get("cash");
  const depositInput = banking ? get("deposits") : null;
  const baseInputs = [assetsInput, equityInput];
  const assets = assetsInput.point?.value;
  const equity = equityInput.point?.value;
  const cashReason = endingInputReason([cashInput]);
  const cash = !cashReason ? cashInput.point?.value : null;
  const deposits =
    banking && !endingInputReason([depositInput])
      ? depositInput.point?.value
      : null;
  const inputs = banking
    ? [...baseInputs, cashInput, depositInput]
    : [...baseInputs, ...(!cashReason ? [cashInput] : [])];
  let reason = endingInputReason(baseInputs);
  if (!reason && !(assets > 0))
    reason =
      "Positive reported total assets are required for this balance exercise.";
  if (!reason && cash !== null && (cash < 0 || cash > assets))
    reason =
      "Reported cash must be nonnegative and cannot exceed total assets in this model; inspect the balance scopes.";
  const baseRatio = ratio(equity, assets);
  if (!reason && baseRatio === null)
    reason =
      "The reported balance ratio exceeds the supported numerical range.";
  let fundingReason = banking
    ? endingInputReason([cashInput, depositInput]) ||
      (!(deposits > 0) || !(cash >= 0)
        ? "Positive reported deposits and nonnegative cash are required for the funding exercise."
        : null)
    : null;
  if (banking && !fundingReason && cash > assets)
    fundingReason =
      "Reported cash exceeds total assets; inspect the balance scopes before modeling funding.";
  const fundingAvailable = banking && !fundingReason;
  const fundingRequested =
    banking &&
    (settings.scenarioFunding !== 0 ||
      settings.scenarioReplacementFunding !== 0);
  const loss = !reason ? assets * (settings.scenarioLoss / 100) : null;
  const withdrawal =
    !banking || settings.scenarioFunding === 0
      ? 0
      : deposits !== null
        ? deposits * (settings.scenarioFunding / 100)
        : null;
  const borrowing =
    !banking || settings.scenarioReplacementFunding === 0
      ? 0
      : deposits !== null
        ? deposits * (settings.scenarioReplacementFunding / 100)
        : null;
  const usableCash =
    banking && cash !== null
      ? cash * (settings.scenarioCashAvailable / 100)
      : null;
  // Subtract borrowing first to avoid overflowing a large cash-capacity sum.
  const arithmeticTolerance = (...values) =>
    Math.max(Number.MIN_VALUE, ...values.map(Math.abs)) * Number.EPSILON * 16;
  const rawFundingGap = fundingAvailable
    ? withdrawal - borrowing - usableCash
    : null;
  const fundingGap = fundingAvailable
    ? rawFundingGap > arithmeticTolerance(withdrawal, borrowing, usableCash)
      ? rawFundingGap
      : 0
    : null;
  if (!reason && fundingRequested && fundingReason) reason = fundingReason;
  if (
    !reason &&
    cash !== null &&
    loss - (assets - cash) > arithmeticTolerance(assets, cash, loss)
  )
    reason =
      "The assumed noncash asset loss exceeds reported noncash assets (total assets less cash).";
  if (!reason && fundingGap > 0)
    reason =
      settings.scenarioReplacementFunding === 0 &&
      settings.scenarioCashAvailable === 100
        ? "The assumed withdrawal exceeds reported cash. The cash-only model cannot complete; asset sales or replacement funding would require additional assumptions."
        : "The assumed withdrawal exceeds usable reported cash plus explicitly assumed replacement borrowing. Reduce withdrawals or change the funding assumptions.";
  const fundingNet =
    borrowing !== null && withdrawal !== null ? borrowing - withdrawal : null;
  const nextAssets = !reason ? assets - loss + fundingNet : null;
  const nextEquity = !reason ? equity - loss : null;
  const nextCash =
    !reason && banking && cash !== null ? cash + fundingNet : null;
  const nextDeposits =
    !reason && banking && deposits !== null ? deposits - withdrawal : null;
  if (
    !reason &&
    (![loss, nextAssets, nextEquity].every(Number.isFinite) ||
      (fundingAvailable &&
        ![borrowing, withdrawal, usableCash, nextCash, nextDeposits].every(
          Number.isFinite,
        )))
  )
    reason =
      "The balance assumptions exceed the supported numerical range; hypothetical results are unavailable.";
  if (!reason && !(nextAssets > 0))
    reason =
      "Hypothetical ending assets must remain positive; this assumption set exceeds the model's valid range.";
  const nextRatio = ratio(nextEquity, nextAssets);
  if (!reason && nextRatio === null)
    reason =
      "The hypothetical balance ratio exceeds the supported numerical range.";
  const note = `Incremental noncash asset loss = ${settings.scenarioLoss}% of baseline total assets; charged fully to the reported shareholder equity balance, with no tax benefit or use of existing allowances. ${banking ? `Deposit withdrawal = ${settings.scenarioFunding}% of baseline deposits. User-assumed usable cash = ${settings.scenarioCashAvailable}% of reported cash. Replacement funding = ${settings.scenarioReplacementFunding}% of baseline deposits, modeled as newly borrowed cash that increases assets and debt equally. Cash payments reduce assets and deposits equally; borrowing and withdrawals do not change equity. No borrowing capacity, interest expense, collateral requirements, funding availability, or use of unavailable cash is established. ${fundingReason ? `Funding exercise unavailable: ${fundingReason} Zero requested withdrawal and borrowing permit an independent asset-loss exercise; missing balances are not assumed to be zero. ` : ""}` : ""}Reported cash availability is not verified and may include restricted or operational balances. ${cash === null ? "Reported cash is unavailable on a compatible ending basis; the noncash-asset loss ceiling cannot be verified. " : "Noncash asset losses cannot exceed reported assets less reported cash. "}Shareholder equity and consolidated assets can differ in scope; this ratio is not a regulatory capital ratio. Operating results above, if present, are a separate exercise.`;
  const modelInputs = inputs.filter(
    (item) => !item.reason && item.basis === "ending balance",
  );
  const fundingFormula =
    banking && (settings.scenarioFunding || settings.scenarioReplacementFunding)
      ? ` + deposits × (${settings.scenarioReplacementFunding} / 100) − deposits × (${settings.scenarioFunding} / 100)`
      : "";
  const rows = reason
    ? []
    : [
        make(
          "Assets",
          "Total assets",
          "currency",
          assets,
          nextAssets,
          modelInputs,
          `assets − assets × (${settings.scenarioLoss} / 100)${fundingFormula}`,
          note,
        ),
        make(
          "Equity",
          "Shareholder equity",
          "currency",
          equity,
          nextEquity,
          baseInputs,
          `shareholder equity − assets × (${settings.scenarioLoss} / 100)`,
          note,
        ),
        make(
          "EquityAssets",
          "Shareholder equity / assets",
          "percent",
          baseRatio,
          nextRatio,
          modelInputs,
          `(equity − assets × (${settings.scenarioLoss} / 100)) / (assets − assets × (${settings.scenarioLoss} / 100)${fundingFormula}) × 100`,
          note,
        ),
      ];
  if (!reason && fundingAvailable)
    rows.push(
      make(
        "Cash",
        "Cash after withdrawals",
        "currency",
        cash,
        nextCash,
        [cashInput, depositInput],
        `cash + deposits × (${settings.scenarioReplacementFunding} / 100) − deposits × (${settings.scenarioFunding} / 100)`,
        note,
      ),
      make(
        "Deposits",
        "Deposits",
        "currency",
        deposits,
        nextDeposits,
        [depositInput],
        `deposits × (1 − ${settings.scenarioFunding} / 100)`,
        note,
      ),
      make(
        "ReplacementFunding",
        "Additional borrowing",
        "currency",
        0,
        borrowing,
        [depositInput],
        `deposits × (${settings.scenarioReplacementFunding} / 100)`,
        note,
      ),
    );
  const capacity = {
    cashFundedWithdrawalPct: fundingAvailable
      ? ratio(usableCash, deposits)
      : null,
    zeroEquityLossPct:
      !endingInputReason(baseInputs) && assets > 0
        ? ratio(Math.max(0, equity), assets)
        : null,
    noncashLossPct:
      !endingInputReason([assetsInput, cashInput]) &&
      assets > 0 &&
      cash >= 0 &&
      cash <= assets
        ? ratio(assets - cash, assets)
        : null,
  };
  const diagnostics = reason
    ? [diagnostic("balanceUnavailable", "error", reason)]
    : [];
  if (banking && fundingReason)
    diagnostics.push(
      diagnostic(
        "fundingUnavailable",
        "warning",
        `Funding exercise unavailable: ${fundingReason}`,
      ),
    );
  if (cash === null)
    diagnostics.push(
      diagnostic(
        "noncashCapacityUnknown",
        "info",
        "Compatible reported cash is unavailable, so the noncash-asset loss ceiling cannot be checked. The asset-loss arithmetic uses only reported assets and equity.",
      ),
    );
  if (!reason && nextEquity < 0)
    diagnostics.push(
      diagnostic(
        "negativeEquity",
        "warning",
        "These assumptions produce negative shareholder equity. This is an accounting result, not a default probability or regulatory capital determination.",
      ),
    );
  if (!reason && banking && withdrawal > 0 && borrowing === 0)
    diagnostics.push(
      diagnostic(
        "withdrawalRatio",
        "info",
        "A cash-funded withdrawal reduces assets and deposits equally. It can mechanically increase a positive equity-to-assets ratio while reducing liquidity.",
      ),
    );
  if (banking && borrowing > 0)
    diagnostics.push(
      diagnostic(
        "borrowingAssumption",
        "info",
        "Replacement borrowing is an explicit assumption: it adds cash and debt equally. Interest, collateral and access to funding are not modeled.",
      ),
    );
  return {
    settings,
    operating,
    banking,
    corporate,
    period,
    balance: {
      reason,
      inputs,
      rows,
      loss,
      withdrawal,
      borrowing,
      usableCash,
      nextCash: reason ? null : nextCash,
      fundingGap,
      note,
      capacity,
      diagnostics,
      funding: { available: fundingAvailable, reason: fundingReason },
    },
    diagnostics: [...(operating?.diagnostics || []), ...diagnostics],
  };
}
