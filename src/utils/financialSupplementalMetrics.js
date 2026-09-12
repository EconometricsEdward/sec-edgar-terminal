import { evidenceSources, evidenceCalculations } from "./researchEvidence.js";
import { comparePointQuality } from "./compareQuality.js";

const corporate = ["corporate"];
const all = ["corporate", "banking", "insurance"];
const nonbank = ["corporate", "insurance"];
const definition = (
  key,
  label,
  inputs,
  formula,
  lenses,
  format = "percent",
  category = "ratios",
) => ({ key, label, inputs, formula, lenses, format, category, order: 100 });

/** One formula registry for both live Analysis and timestamped Portfolio captures. */
export const SUPPLEMENTAL_METRIC_DEFINITIONS = [
  definition(
    "workingCapital",
    "Working capital",
    ["currentAssets", "currentLiabilities"],
    "Current assets − current liabilities, at the same balance-sheet date",
    corporate,
    "currency",
    "balance",
  ),
  definition(
    "cashRatio",
    "Cash ratio",
    ["cash", "currentLiabilities"],
    "Cash and equivalents / positive current liabilities; excludes short-term investments",
    corporate,
    "decimal",
  ),
  definition(
    "liabilitiesAssets",
    "Liabilities / assets",
    ["totalLiabilities", "totalAssets"],
    "Total liabilities / positive total assets × 100",
    all,
  ),
  definition(
    "reportedDebtEquity",
    "Reported debt / equity",
    ["shortTermDebt", "longTermDebt", "stockholdersEquity"],
    "(Selected current debt + reported noncurrent debt) / positive stockholders’ equity × 100; both debt inputs required",
    nonbank,
  ),
  definition(
    "netReportedDebt",
    "Net reported debt",
    ["shortTermDebt", "longTermDebt", "cash"],
    "Selected current debt + reported noncurrent debt − cash and equivalents; both debt inputs required",
    nonbank,
    "currency",
    "balance",
  ),
  definition(
    "operatingCashFlowMargin",
    "Operating cash flow margin",
    ["operatingCashFlow", "revenue"],
    "Operating cash flow / positive revenue × 100, for the same reporting duration",
    corporate,
  ),
  definition(
    "freeCashFlowMargin",
    "Free cash flow margin",
    ["operatingCashFlow", "capex", "revenue"],
    "(Operating cash flow − PP&E purchases) / positive revenue × 100, for the same reporting duration",
    corporate,
  ),
  definition(
    "capexRevenue",
    "PP&E investment / revenue",
    ["capex", "revenue"],
    "Purchases of property, plant and equipment / positive revenue × 100",
    corporate,
  ),
  definition(
    "researchRevenue",
    "R&D expense / revenue",
    ["rnd", "revenue"],
    "Reported research and development expense / positive revenue × 100",
    corporate,
  ),
  definition(
    "operatingInterestCoverage",
    "Operating income / interest expense",
    ["operatingIncome", "interestExpense"],
    "Reported operating income / positive reported interest expense; not EBITDA coverage",
    corporate,
    "decimal",
  ),
  definition(
    "pretaxMargin",
    "Pre-tax margin",
    ["pretaxIncome", "revenue"],
    "Reported pre-tax income / positive revenue × 100, for the same reporting duration",
    corporate,
  ),
  definition(
    "effectiveTaxRate",
    "Effective tax rate",
    ["incomeTax", "pretaxIncome"],
    "Income tax expense or benefit / positive reported pre-tax income × 100",
    all,
  ),
];

const ratio = (numerator, denominator) =>
  denominator > 0 ? (numerator / denominator) * 100 : null;
const COMPUTE = {
  workingCapital: (assets, liabilities) => assets - liabilities,
  cashRatio: (cash, liabilities) =>
    liabilities > 0 ? cash / liabilities : null,
  liabilitiesAssets: ratio,
  reportedDebtEquity: (current, noncurrent, equity) =>
    ratio(current + noncurrent, equity),
  netReportedDebt: (current, noncurrent, cash) => current + noncurrent - cash,
  operatingCashFlowMargin: ratio,
  freeCashFlowMargin: (cash, purchases, revenue) =>
    ratio(cash - purchases, revenue),
  capexRevenue: ratio,
  researchRevenue: ratio,
  operatingInterestCoverage: (income, expense) =>
    expense > 0 ? income / expense : null,
  pretaxMargin: ratio,
  effectiveTaxRate: ratio,
};
const description = (
  meaning,
  caution,
  query,
  lenses,
  movement = "Review the reported components and their periods before comparing companies or attributing changes to business performance.",
) => ({ meaning, movement, caution, query, section: "mda", lenses });
const debtCaution =
  "This uses the selected reported current-debt concept plus explicitly noncurrent debt. It can omit separately reported borrowings, leases and other obligations; it is not a complete measure of all debt. Both components are required, and unavailable inputs are never zero.";

export const SUPPLEMENTAL_METRIC_GUIDES = {
  workingCapital: description(
    "Current assets remaining after current liabilities at the reporting date.",
    "A negative amount can reflect the operating model or near-term funding needs. Inventory and receivables are not equivalent to immediately available cash.",
    '"working capital" OR "current liabilities"',
    corporate,
  ),
  cashRatio: description(
    "Reported cash and equivalents relative to current liabilities at the same date.",
    "Short-term investments and restricted-cash concepts are excluded. This is a narrow cash measure, not a prediction that all current liabilities must be settled immediately.",
    '"cash equivalents" OR "liquidity"',
    corporate,
  ),
  liabilitiesAssets: description(
    "The share of reported assets financed by total liabilities.",
    "Total liabilities include obligations beyond debt. Accounting scope matters, particularly for financial institutions, and the ratio can exceed 100% when equity is negative.",
    '"total liabilities" OR "capital resources"',
    all,
  ),
  reportedDebtEquity: description(
    "Selected reported current and noncurrent debt relative to positive stockholders’ equity.",
    debtCaution +
      " Nonpositive equity makes this ratio unavailable; a very small positive equity balance can produce a large ratio.",
    '"borrowings" OR "debt" OR "stockholders equity"',
    nonbank,
  ),
  netReportedDebt: description(
    "Selected reported current and noncurrent debt after subtracting cash and equivalents.",
    debtCaution +
      " A negative value means the selected cash balance exceeds these debt inputs; it does not establish that every obligation is covered.",
    '"borrowings" OR "cash equivalents"',
    nonbank,
  ),
  operatingCashFlowMargin: description(
    "Cash provided by or used in operations for each dollar of revenue in the same period.",
    "Collection and payment timing can affect cash flow. The ratio is not annualized and does not measure cash available after investment or financing obligations.",
    '"operating activities" OR "working capital"',
    corporate,
  ),
  freeCashFlowMargin: description(
    "Operating cash flow after purchases of property, plant and equipment, as a share of revenue.",
    "This definition of free cash flow is not a standardized GAAP subtotal. It excludes acquisitions and other investing or financing obligations. The ratio is not annualized.",
    '"capital expenditures" OR "operating activities"',
    corporate,
  ),
  capexRevenue: description(
    "Cash purchases of property, plant and equipment relative to revenue for the same period.",
    "This excludes acquisitions and capitalized items outside the selected PP&E concept. A higher ratio may reflect expansion, replacement investment or timing; it is not inherently better or worse.",
    '"capital expenditures" OR "property plant"',
    corporate,
  ),
  researchRevenue: description(
    "Reported research and development expense relative to revenue for the same period.",
    "Capitalized development costs are not added to reported expense. Expense classification and business models differ; this ratio does not measure the success of research spending.",
    '"research and development" OR "capitalized development"',
    corporate,
  ),
  operatingInterestCoverage: description(
    "Reported operating profit or loss divided by the positive interest expense reported for the same duration.",
    "This deliberately uses operating income, not EBITDA or an invented EBIT subtotal. It excludes interest capitalized outside the expense concept. Negative operating income produces negative coverage; zero or negative interest expense produces no ratio.",
    '"interest expense" OR "operating income"',
    corporate,
  ),
  pretaxMargin: description(
    "The selected reported pre-tax earnings subtotal as a percentage of revenue.",
    "The pre-tax concept may be limited to continuing operations or include equity-method results. It is not interchangeable with operating or net margin, and is not annualized.",
    '"income before" OR "results of operations"',
    corporate,
  ),
  effectiveTaxRate: description(
    "Reported income tax expense or benefit relative to positive pre-tax income for the same period.",
    "This is an accounting tax rate, not cash taxes paid or a statutory tax rate. Tax benefits can produce a negative rate; discrete items can produce rates above 100%. Nonpositive pre-tax income produces no rate.",
    '"effective tax rate" OR "income tax" OR "valuation allowance"',
    all,
  ),
};

const BALANCE_INPUTS = new Set([
  "currentAssets",
  "currentLiabilities",
  "cash",
  "totalLiabilities",
  "totalAssets",
  "shortTermDebt",
  "longTermDebt",
  "stockholdersEquity",
]);
const CASH_TAGS = new Set(["CashAndCashEquivalentsAtCarryingValue"]);
const CURRENT_DEBT_TAGS = new Set([
  "DebtCurrent",
  "LongTermDebtCurrent",
  "ShortTermBorrowings",
]);
const unitFor = (format) =>
  format === "percent" ? "%" : format === "decimal" ? "x" : "USD";

function inputProblem(point, key, period) {
  if (
    !Number.isFinite(point?.value) ||
    ["unavailable", "not_applicable"].includes(point?.classification)
  )
    return `A required reported input (${key}) is unavailable; missing values are never zero.`;
  if (point.unit != null && point.unit !== "USD")
    return "All monetary inputs must use USD; currencies are not substituted.";
  const sources = evidenceSources(point);
  if (
    !sources.length ||
    sources.some(
      (source) =>
        !source.tag || source.unit !== "USD" || !Number.isFinite(source.value),
    )
  )
    return "Every input requires tagged reported monetary evidence in USD.";
  if (BALANCE_INPUTS.has(key) && sources.some((source) => source.start != null))
    return "Balance-sheet inputs must be reported at the same date, not over a duration.";
  if (
    !BALANCE_INPUTS.has(key) &&
    sources.some((source) => source.start == null)
  )
    return "Income and cash-flow inputs require reported durations, not balance-sheet dates.";
  const quality = comparePointQuality(point, key, period);
  return quality.valid ? null : quality.reason;
}

/** Source intervals, currency and accounting scope are checked before any arithmetic.
 * Raw cumulative inputs may differ: comparePointQuality validates their connection
 * to the output quarter/TTM rather than mistaking their longest input for the output. */
export function calculateSupplementalMetric(def, metrics, period, lens) {
  const unavailable = (reason, classification = "unavailable") => ({
    value: null,
    unit: unitFor(def.format),
    period,
    label: def.label,
    format: def.format,
    category: def.category,
    formula: def.formula,
    definitionFormula: def.formula,
    classification,
    reason,
    sources: [],
    calculations: [],
  });
  if (!def.lenses.includes(lens))
    return unavailable(
      "Not applicable to this company's accounting model.",
      "not_applicable",
    );
  const inputs = def.inputs.map((key) => metrics?.[key]);
  for (let i = 0; i < inputs.length; i++) {
    const problem = inputProblem(inputs[i], def.inputs[i], period);
    if (problem) return unavailable(problem);
  }
  if (
    ["cashRatio", "netReportedDebt"].includes(def.key) &&
    evidenceSources(metrics.cash).some((source) => !CASH_TAGS.has(source.tag))
  )
    return unavailable(
      "This measure requires the combined cash-and-equivalents concept; cash-only, restricted or industry-specific cash is not substituted.",
    );
  if (
    ["reportedDebtEquity", "netReportedDebt"].includes(def.key) &&
    (evidenceSources(metrics.shortTermDebt).some(
      (source) => !CURRENT_DEBT_TAGS.has(source.tag),
    ) ||
      evidenceSources(metrics.longTermDebt).some(
        (source) => source.tag !== "LongTermDebtNoncurrent",
      ))
  )
    return unavailable(
      "Distinct current and explicitly noncurrent debt concepts are required; ambiguous total-debt contexts are not added together.",
    );
  const value = COMPUTE[def.key](...inputs.map((point) => point.value));
  if (!Number.isFinite(value))
    return unavailable(
      "This ratio requires a positive denominator. Zero or negative denominators are not ranked.",
    );
  const inputDetails = inputs.map((point, index) => ({
    key: def.inputs[index],
    label: point.label || def.inputs[index],
    value: point.value,
    unit: "USD",
    start: BALANCE_INPUTS.has(def.inputs[index]) ? null : period.start,
    end: period.end,
    formula: point.formula || "Reported input",
  }));
  return {
    ...unavailable(null),
    value,
    classification: "calculated",
    sources: evidenceSources({ sources: inputs.flatMap(evidenceSources) }),
    calculations: [
      ...new Map(
        [...inputs.flatMap(evidenceCalculations), ...inputDetails].map(
          (entry) => [JSON.stringify(entry), entry],
        ),
      ).values(),
    ],
  };
}

/** Recompute only these shared measures. Existing reported values remain unchanged.
 * Does not change the evidence capture timestamp or claim to refresh SEC facts. */
export function augmentPortfolioCompanyMetrics(company) {
  if (
    !company ||
    !company.metrics ||
    !company.period ||
    !company.lens ||
    company.kind === "fund"
  )
    return company;
  const metrics = { ...company.metrics };
  for (const def of SUPPLEMENTAL_METRIC_DEFINITIONS)
    if (def.lenses.includes(company.lens))
      metrics[def.key] = calculateSupplementalMetric(
        def,
        metrics,
        company.period,
        company.lens,
      );
  return { ...company, metrics };
}
