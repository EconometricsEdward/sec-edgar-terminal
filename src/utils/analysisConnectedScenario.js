import { labInput, labCalculatedPoint } from "./analysisFormula.js";
import { evidenceSources } from "./researchEvidence.js";

const currentDebtTags = new Set([
  "LongTermDebtCurrent", "ShortTermBorrowings", "DebtCurrent",
]);
const diagnostic = (key, status, message) => ({ key, status, message });
const valueOf = (input) => input.point?.value;
const tags = (input) => evidenceSources(input.point).map((source) => source.tag);
const result = (value, reason = null) => ({
  value: !reason && Number.isFinite(value) ? value : null,
  reason: reason || (!Number.isFinite(value) ? "The result exceeds the supported numerical range." : null),
});
const calculate = (dependencies, compute) => {
  const reason = dependencies.find((item) => item.reason)?.reason;
  return reason ? result(null, reason) : result(compute(...dependencies.map((item) => item.value)));
};
const inputResult = (input, basis) => result(valueOf(input), input.reason || (
  input.basis !== basis ? `The ${input.definition?.label || input.key} input requires a compatible ${basis}.` : null
));
const scope = (input, mapping) => {
  const found = new Set(tags(input).map((tag) => mapping[tag] || "unknown"));
  return found.size === 1 ? [...found][0] : "mixed";
};

/** Same-period counterfactual: change reported ending cash only by incremental
 * cash effects. Reported CFO has already contributed to the ending balance. */
export function buildConnectedScenario(data, settings, index, operating) {
  const requested = settings.scenarioCashMode === "connected";
  const enabled = requested && data.lens === "corporate";
  const empty = { enabled, reason: null, note: "", inputs: [], rows: [], bridge: [], diagnostics: [], metrics: {}, periodDays: null };
  if (requested && !enabled) {
    const reason = "The connected operating and cash model is available for operating companies only. The independent balance exercise remains active for this accounting lens.";
    return { ...empty, reason, diagnostics: [diagnostic("connectedUnavailable", "info", reason)] };
  }
  if (!enabled) return empty;
  const reason = operating?.reason || (!Number.isFinite(operating?.delta) ? "A compatible operating scenario is required before connecting cash and financing." : null);
  if (reason) return { ...empty, reason, diagnostics: [diagnostic("connectedUnavailable", "error", reason)] };

  const period = data.periods?.[index];
  const periodDays = period?.start && period?.end
    ? (Date.parse(period.end) - Date.parse(period.start)) / 86400000 + 1 : NaN;
  const duration = result(periodDays, !(Number.isFinite(periodDays) && periodDays >= 1 && periodDays <= 550)
    ? "A valid selected reporting duration of 1 to 550 days is required; borrowing interest is not applied to an undated period." : null);
  const inputs = ["revenue", "operatingIncome", "netIncome", "operatingCashFlow", "capex", "cash", "totalAssets", "stockholdersEquity", "shortTermDebt", "longTermDebt"].map((key) => labInput(data, key, index));
  const byKey = Object.fromEntries(inputs.map((input) => [input.key, input]));
  const flow = (key) => inputResult(byKey[key], "period flow");
  const balance = (key) => inputResult(byKey[key], "ending balance");
  const revenue = flow("revenue");
  let income = flow("netIncome");
  const cfo = flow("operatingCashFlow");
  let capex = flow("capex");
  let cash = balance("cash");
  let assets = balance("totalAssets");
  const equity = balance("stockholdersEquity");
  const currentDebt = balance("shortTermDebt");
  const longDebt = balance("longTermDebt");
  if (!capex.reason && capex.value < 0) capex = result(null, "Reported PP&E purchases must be a nonnegative cash outflow amount.");
  if (!cash.reason && (cash.value < 0 || tags(byKey.cash).some((tag) => tag !== "CashAndCashEquivalentsAtCarryingValue")))
    cash = result(null, "The connected cash bridge requires nonnegative reported cash and equivalents; cash-only or restricted-cash concepts are not substituted.");
  if (!assets.reason && assets.value <= 0) assets = result(null, "Positive reported total assets are required for the connected balance.");
  if (!cash.reason && !assets.reason && cash.value > assets.value)
    cash = result(null, "Reported cash exceeds total assets; inspect their accounting scopes.");
  let debt = calculate([currentDebt, longDebt], (a, b) => a + b);
  if (!debt.reason && (currentDebt.value < 0 || longDebt.value < 0 || tags(byKey.shortTermDebt).some((tag) => !currentDebtTags.has(tag)) || tags(byKey.longTermDebt).some((tag) => tag !== "LongTermDebtNoncurrent")))
    debt = result(null, "Reported debt requires distinct nonnegative selected current debt and explicitly noncurrent debt. Ambiguous total-debt concepts are not added together.");
  if (!debt.reason && !assets.reason && debt.value > assets.value - equity.value && !equity.reason)
    debt = result(null, "Selected debt exceeds liabilities implied by assets less equity; inspect the debt and equity scopes.");

  const incomeScope = scope(byKey.netIncome, { NetIncomeLoss: "parent", ProfitLoss: "consolidated" });
  const equityScope = scope(byKey.stockholdersEquity, {
    StockholdersEquity: "parent",
    StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: "consolidated",
  });
  if (!income.reason && !["parent", "consolidated"].includes(incomeScope))
    income = result(null, "The net-income source must establish a consistent parent or consolidated scope.");
  const equityScopeReason = incomeScope === equityScope && ["parent", "consolidated"].includes(incomeScope)
    ? null : "Net income and equity must have matching parent or consolidated source scopes; the model does not allocate earnings to noncontrolling interests.";
  const note = `Hypothetical same-period counterfactual, not a forecast. Explicit assumptions: tax on positive incremental pretax earnings ${settings.scenarioTaxRate}%; extra working-capital cash use ${settings.scenarioWorkingCapital}% of baseline revenue (negative means release); PP&E purchases change ${settings.scenarioCapexChange}%; new borrowing ${settings.scenarioBorrowing}% of baseline revenue; repayment ${settings.scenarioDebtRepayment}% of selected reported debt; annual new-borrowing interest ${settings.scenarioBorrowRate}%. Reported ending cash is adjusted only by incremental cash effects; the full reported operating cash flow is never added to ending cash again. Incremental operating earnings, less interest on new borrowing and tax on positive incremental pretax earnings, are assumed to convert to cash before the explicit working-capital adjustment. No tax benefit is assumed for an earnings decline. New borrowing is assumed outstanding for the entire selected period (${duration.value ?? "unavailable"} days / 365); no interest saving is assumed on repayments. Working-capital use adds net noncash operating assets; a release reduces them. The aggregate noncash-asset ceiling is checked, but individual working-capital and PP&E capacity is not established. Changes in capital spending change PP&E and cash equally, with no incremental depreciation. Free cash flow here means modeled operating cash flow less PP&E purchases; it is not a measure of all capital commitments or discretionary cash. Other noncash adjustments, other income and expenses, dividends, existing financing and other cash flows are held unchanged. ${incomeScope === "parent" ? "The incremental earnings are assumed attributable to the parent; noncontrolling interests are held unchanged. " : ""}Borrowing proceeds are not income and capital spending is not an equity expense. The independent asset-loss exercise is excluded. Debt uses selected current debt plus explicitly noncurrent debt and may not represent every obligation. Funding availability, usable cash, covenants, debt capacity and regulatory capital are not established.`;
  const diagnostics = [diagnostic("connectedAssumptions", "info", "Only incremental effects change reported ending cash. Earnings-to-cash conversion is an explicit assumption; extra working capital and capital spending are modeled separately.")];
  if (settings.scenarioLoss !== 0) diagnostics.push(diagnostic("separateLossExcluded", "info", "The separate noncash asset-loss assumption is excluded from connected results."));

  const operatingDelta = result(operating.delta);
  const borrowing = calculate([revenue], (v) => v * settings.scenarioBorrowing / 100);
  // A zero requested repayment/change establishes a zero increment, not a
  // fabricated reported debt or capital-spending balance.
  const repayment = settings.scenarioDebtRepayment === 0 ? result(0)
    : calculate([debt], (v) => Math.min(v, v * settings.scenarioDebtRepayment / 100));
  const interest = borrowing.value === 0 || settings.scenarioBorrowRate === 0
    ? result(0, borrowing.reason) : calculate([borrowing, duration], (v, days) => v * settings.scenarioBorrowRate / 100 * days / 365);
  const pretaxDelta = calculate([operatingDelta, interest], (a, b) => a - b);
  const tax = calculate([pretaxDelta], (v) => Math.max(v, 0) * settings.scenarioTaxRate / 100);
  const earningsDelta = calculate([pretaxDelta, tax], (a, b) => a - b);
  const workingCapitalUse = calculate([revenue], (v) => v * settings.scenarioWorkingCapital / 100);
  const capexDelta = settings.scenarioCapexChange === 0 ? result(0)
    : calculate([capex], (v) => v * settings.scenarioCapexChange / 100);
  const cashDelta = calculate([earningsDelta, workingCapitalUse, capexDelta, borrowing, repayment], (earnings, wc, investment, draw, pay) => earnings - wc - investment + draw - pay);
  const noncashAssetDelta = calculate([workingCapitalUse, capexDelta], (a, b) => a + b);
  const debtDelta = calculate([borrowing, repayment], (a, b) => a - b);
  const netIncome = calculate([income, earningsDelta], (a, b) => a + b);
  let operatingCashFlow = calculate([cfo, earningsDelta, workingCapitalUse], (a, b, c) => a + b - c);
  const nextCapex = calculate([capex, capexDelta], (a, b) => a + b);
  let freeCashFlow = calculate([operatingCashFlow, nextCapex], (a, b) => a - b);
  let nextCash = calculate([cash, cashDelta], (a, b) => a + b);
  const cashTolerance = Math.max(Number.MIN_VALUE, Math.abs(cash.value || 0), Math.abs(cashDelta.value || 0)) * Number.EPSILON * 16;
  if (!nextCash.reason && Math.abs(nextCash.value) <= cashTolerance) nextCash = result(0);
  const nextDebt = calculate([debt, debtDelta], (a, b) => a + b);
  const nextEquity = calculate([equity, earningsDelta, result(0, equityScopeReason)], (a, b) => a + b);
  let nextAssets = calculate([assets, cashDelta, noncashAssetDelta, cash], (a, b, c) => a + b + c);
  const noncashAssets = calculate([assets, cash, noncashAssetDelta], (a, b, c) => a - b + c);
  const noncashTolerance = Math.max(Number.MIN_VALUE, Math.abs(assets.value || 0), Math.abs(cash.value || 0), Math.abs(noncashAssetDelta.value || 0)) * Number.EPSILON * 16;
  if (!noncashAssets.reason && noncashAssets.value < -noncashTolerance) {
    const unavailable = result(null, "The assumed working-capital release and capital-spending change exceed reported noncash assets. The connected cash and balance cannot complete.");
    nextAssets = unavailable;
    nextCash = unavailable;
    operatingCashFlow = unavailable;
    freeCashFlow = unavailable;
  }
  const fundingGap = calculate([nextCash], (v) => Math.max(0, -v));
  if (!nextAssets.reason && nextAssets.value <= 0)
    nextAssets = result(null, "Hypothetical assets must remain positive for a connected balance.");
  if (fundingGap.value > 0) {
    nextAssets = result(null, "Negative modeled cash leaves an unfunded shortfall. A feasible ending balance and equity-to-assets ratio require an additional explicit financing assumption.");
    diagnostics.push(diagnostic("connectedFundingGap", "warning", "These assumptions leave a cash funding shortfall. Negative modeled cash is not a feasible funded balance; additional financing is not assumed."));
  }
  const equityAssets = calculate([nextEquity, nextAssets], (a, b) => a / b * 100);
  if (nextEquity.value < 0) diagnostics.push(diagnostic("connectedNegativeEquity", "warning", "The connected assumptions produce negative accounting equity; this is not a default probability or regulatory capital result."));

  const make = (key, label, baseline, computed, dependencies, formula, format = "currency") => ({
    key, label, format, baseline: baseline.value,
    selection: {
      definition: { key: `scenarioConnected${key}`, label: `Hypothetical ${label}`, format },
      point: { ...labCalculatedPoint(period, dependencies, computed.value, `Hypothetical: ${formula}`, note), reason: computed.reason },
    },
  });
  const operatingInputs = operating.inputs || [byKey.revenue, byKey.operatingIncome];
  const earningsInputs = [...operatingInputs];
  const cashInputs = [...earningsInputs, byKey.cash, ...(settings.scenarioCapexChange !== 0 ? [byKey.capex] : []), ...(settings.scenarioDebtRepayment !== 0 ? [byKey.shortTermDebt, byKey.longTermDebt] : [])];
  const rows = [
    make("NetIncome", "Net income", income, netIncome, [...earningsInputs, byKey.netIncome], "reported net income + incremental operating income − new-borrowing interest − tax on positive incremental pretax earnings"),
    make("OperatingCashFlow", "Operating cash flow", cfo, operatingCashFlow, [...earningsInputs, byKey.operatingCashFlow], "reported operating cash flow + incremental earnings after tax and interest − extra working-capital cash use"),
    make("Capex", "Capital spending", capex, nextCapex, [byKey.capex], `reported PP&E purchases × (1 + ${settings.scenarioCapexChange} / 100)`),
    make("FreeCashFlow", "Free cash flow", calculate([cfo, capex], (a, b) => a - b), freeCashFlow, [...earningsInputs, byKey.operatingCashFlow, byKey.capex], "hypothetical operating cash flow − hypothetical PP&E purchases"),
    make("Cash", "Cash before any unmodeled funding", cash, nextCash, cashInputs, "reported ending cash + incremental earnings after tax and interest − extra working-capital use − incremental PP&E purchases + new borrowing − debt repayment"),
    make("Debt", "Selected reported debt", debt, nextDebt, [byKey.revenue, byKey.shortTermDebt, byKey.longTermDebt], "selected current debt + explicitly noncurrent debt + new borrowing − repayment"),
    make("Assets", "Total assets", assets, nextAssets, [...cashInputs, byKey.totalAssets], "reported assets + incremental cash + incremental net noncash operating assets + incremental PP&E"),
    make("Equity", "Shareholder equity", equity, nextEquity, [...earningsInputs, byKey.netIncome, byKey.stockholdersEquity], "compatible-scope reported equity + incremental earnings after tax and interest"),
    make("EquityAssets", "Shareholder equity / assets", calculate([equity, assets, result(0, equityScopeReason)], (a, b) => a / b * 100), equityAssets, [...cashInputs, byKey.netIncome, byKey.stockholdersEquity, byKey.totalAssets], "hypothetical compatible-scope equity / positive funded hypothetical assets × 100", "percent"),
    make("FundingGap", "Unfunded cash shortfall", result(0, cash.reason), fundingGap, cashInputs, "maximum of zero and negative hypothetical cash; additional borrowing is not assumed"),
  ];
  const bridge = [
    make("EarningsChange", "Earnings after tax and interest", result(0), earningsDelta, earningsInputs, "incremental operating income − new borrowing × annual interest rate × period days / 365 − tax rate × max(incremental operating income − new interest, 0)"),
    make("WorkingCapitalChange", "Extra working capital", result(0), calculate([workingCapitalUse], (v) => -v), [byKey.revenue], `− reported revenue × (${settings.scenarioWorkingCapital} / 100)`),
    make("CapexChange", "Capital spending change", result(0), calculate([capexDelta], (v) => -v), settings.scenarioCapexChange === 0 ? [] : [byKey.capex], `− reported PP&E purchases × (${settings.scenarioCapexChange} / 100)`),
    make("BorrowingChange", "New borrowing", result(0), borrowing, [byKey.revenue], `reported revenue × (${settings.scenarioBorrowing} / 100)`),
    make("RepaymentChange", "Debt repayment", result(0), calculate([repayment], (v) => -v), settings.scenarioDebtRepayment === 0 ? [] : [byKey.shortTermDebt, byKey.longTermDebt], `− (selected current debt + explicitly noncurrent debt) × (${settings.scenarioDebtRepayment} / 100)`),
  ];
  const failures = [...new Set(rows.map((row) => row.selection.point.reason).filter(Boolean))];
  failures.forEach((message, i) => diagnostics.push(diagnostic(`connectedInput${i}`, "warning", message)));
  const metrics = Object.fromEntries(Object.entries({ netIncome, operatingCashFlow, capex: nextCapex, freeCashFlow, cash: nextCash, debt: nextDebt, assets: nextAssets, equity: nextEquity, equityAssets, fundingGap, operatingDelta, interest, tax, workingCapitalUse, capexDelta, borrowing, repayment, cashDelta, noncashAssetDelta, equityDelta: earningsDelta, debtDelta }).map(([key, computed]) => [key, computed.value]));
  return { ...empty, periodDays: duration.value, note, inputs, rows, bridge, diagnostics, metrics };
}
