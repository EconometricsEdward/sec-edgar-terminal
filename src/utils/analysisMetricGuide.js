import { evidenceSources } from "./researchEvidence.js";

const READING = {
  title: "SEC guide to reading a 10-K / 10-Q",
  url: "https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins/how-read",
};
const validDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
};
const guide = (
  meaning,
  movement,
  caution,
  query,
  section = "mda",
  lenses = null,
) => ({ meaning, movement, caution, query, section, lenses });

// Educational prompts, deliberately separate from numerical scoring. Exact
// calculations and reported concepts remain in the evidence inspector.
const GUIDES = {
  revenue: guide(
    "Sales recognized for the reporting period under the company's accounting policies.",
    "Investigate price, volume, product mix, acquisitions and currency effects.",
    "Revenue growth alone does not establish organic growth, cash collection or improved profitability.",
    "(revenue OR sales) AND (volume OR price OR acquisition OR currency)",
    "mda",
    ["corporate"],
  ),
  costOfRevenue: guide(
    "Reported costs assigned to goods sold or services delivered in the period, within the scope of the source concept.",
    "Compare with revenue and gross profit to investigate input costs and product mix.",
    "Companies classify costs differently. A missing subtotal is not zero; inspect whether the filing separates goods and service costs.",
    '"cost of revenue" OR "cost of sales"',
    "mda",
    ["corporate"],
  ),
  sga: guide(
    "Selling, general and administrative costs, reported together or calculated from compatible selling/marketing and general/administrative components.",
    "Compare with revenue to understand the cost of selling products and running the business.",
    "General and administrative expense alone is not total SG&A. Both components are required for a calculated total; classifications differ across companies.",
    '"selling" AND "administrative"',
  ),
  accountsPayable: guide(
    "Current amounts owed to suppliers for goods or services already received.",
    "Read alongside purchases, inventory and operating cash flow to investigate payment timing.",
    "A larger balance can reflect growth or slower payments. Payables combined with accrued liabilities are not substituted for separately reported accounts payable.",
    '"accounts payable" OR "payment terms"',
  ),
  receivables: guide(
    "Current receivables after the allowances included in the reported SEC concept. The source may cover trade receivables or a broader receivables balance.",
    "Compare with revenue and cash collections to investigate billing and collection timing.",
    "Check the source scope before comparing companies. Receivables growth alone does not establish collection problems or a deterioration in credit quality.",
    '"receivables" AND ("allowance" OR "collections")',
  ),
  grossProfit: guide(
    "Revenue remaining after the cost of revenue included in this reported measure.",
    "Read about selling prices, input costs and the mix of products or services.",
    "Cost classification differs across companies. This does not include all operating expenses.",
    '"gross profit" OR "gross margin"',
    "mda",
    ["corporate"],
  ),
  operatingIncome: guide(
    "The company's reported operating profit or loss, before items classified below operating income.",
    "Look for margin changes, operating expenses, restructuring and impairments.",
    "Reported operating profit can include unusual charges. Its movement is not automatically recurring earnings growth.",
    '"operating income" OR restructuring OR impairment',
    "mda",
    ["corporate", "insurance"],
  ),
  netIncome: guide(
    "Profit or loss for the period using the reported SEC concept identified below.",
    "Separate operating results from financing costs, taxes, disposal gains and other below-operating items.",
    "Check whether the source includes noncontrolling interests. Accounting profit is different from cash generated and from earnings available to common shareholders.",
    '"net income" OR "income tax" OR "noncontrolling interests"',
  ),
  pretaxIncome: guide(
    "Reported earnings before the income tax provision or benefit, within the scope of the selected concept.",
    "Check operating results alongside interest, investment gains and other nonoperating items.",
    "Continuing-operations scope may differ from net income. Subtracting taxes may leave a reconciliation residual.",
    '"income before" OR "nonoperating" OR "income tax"',
  ),
  incomeTax: guide(
    "The reported income tax expense or benefit recognized for this reporting period.",
    "Read the tax-rate reconciliation for jurisdiction mix, deferred tax changes, valuation allowances and discrete items.",
    "Tax expense is not cash taxes paid. A low rate or benefit may be temporary; dividing by nonpositive pretax income can mislead.",
    '"effective tax rate" OR "valuation allowance" OR "deferred tax"',
    "notes",
  ),
  epsDiluted: guide(
    "Reported earnings per diluted share, incorporating the issuer's earnings allocation and dilutive-security calculation.",
    "Review both the earnings numerator and weighted-average diluted share count, including stock compensation and convertible securities.",
    "Reported EPS need not equal consolidated net income divided by shares. Share reductions alone do not prove a buyback caused EPS growth.",
    '"earnings per share" OR "weighted average" OR "antidilutive"',
    "notes",
  ),
  epsBasic: guide(
    "Reported earnings per basic share using the issuer's earnings allocation and weighted-average common shares.",
    "Check the earnings numerator, share issuances, repurchases and the timing of shares outstanding.",
    "Basic EPS excludes the potential dilution captured by diluted EPS. Consolidated net income may use a different numerator scope.",
    '"earnings per share" OR "weighted average"',
    "notes",
  ),
  sharesDiluted: guide(
    "The weighted-average diluted share count for the reporting period.",
    "Investigate issuance, repurchases, stock compensation, splits and the treatment of potentially dilutive securities.",
    "This is a period average, not the number of shares outstanding at period end. A decline does not identify its cause.",
    '"weighted average" OR "share repurchase" OR "antidilutive"',
    "notes",
  ),
  operatingCashFlow: guide(
    "Cash provided by or used in operating activities during this period.",
    "Inspect the reconciliation from earnings, including noncash expenses and working-capital movements.",
    "Collection and payment timing can improve one period at the expense of another. Financial institutions need a different cash-flow interpretation.",
    '"operating activities" OR "working capital"',
  ),
  freeCashFlow: guide(
    "Operating cash flow less reported purchases of property, plant and equipment in this workspace.",
    "Separate the operating cash movement from PP&E investment and read about capital expenditure plans.",
    "This calculation is not a standardized GAAP subtotal or cash available for distribution. It excludes acquisitions and other obligations; it has limited usefulness for financial institutions.",
    '"capital expenditures" OR "operating activities" OR commitments',
  ),
  cashConversion: guide(
    "Operating cash flow relative to positive net income for the same reporting period.",
    "Investigate noncash charges, receivables, inventory, payables and other operating cash adjustments.",
    "A higher percentage can reflect a small earnings denominator or temporary cash timing. It is not an earnings-quality score.",
    '"operating activities" OR "working capital"',
  ),
  cashAdjustments: guide(
    "The arithmetic difference between operating cash flow and net income.",
    "Use the cash-flow statement reconciliation to identify the specific noncash items and operating balance changes.",
    "This residual does not attribute the difference to individual causes or prove earnings manipulation.",
    '"operating activities" OR "noncash" OR "working capital"',
  ),
  cash: guide(
    "The reported cash concept selected for this company, measured at the balance-sheet date.",
    "Read about operating cash generation, investing, financing and restrictions on use.",
    "The source may differ by industry. Reported cash is not automatically unrestricted, distributable or sufficient to meet every obligation.",
    'liquidity OR "restricted cash" OR "cash equivalents"',
  ),
  currentRatio: guide(
    "Current assets divided by current liabilities at the same balance-sheet date.",
    "Review the mix and realizability of current assets, near-term obligations and seasonal working capital.",
    "This is not a cash-flow forecast or covenant calculation. Asset quality and debt terms matter; it is not applied to unclassified bank balance sheets.",
    'liquidity OR "working capital" OR covenant',
    "mda",
    ["corporate"],
  ),
  stockholdersEquity: guide(
    "The reported book equity interest after liabilities, within the source concept's ownership scope.",
    "Check earnings, distributions, share transactions, other comprehensive income and ownership changes.",
    "Book equity is not market value or liquidation proceeds. For financial institutions, it is different from regulatory capital.",
    '"stockholders equity" OR "shareholders equity" OR "other comprehensive income"',
    "notes",
  ),
  totalAssets: guide(
    "The reported carrying amount of assets at the balance-sheet date.",
    "Review acquisitions, investment, lending, disposals, valuation adjustments and cash movements.",
    "Book assets do not establish market or liquidation value. Growth alone says little about asset quality or returns.",
    '"total assets" OR impairment OR acquisition',
  ),
  equityAssets: guide(
    "Reported book equity as a percentage of total assets.",
    "Separate retained earnings and distributions from asset growth, valuation effects and new equity issuance.",
    "This accounting ratio is not CET1, a regulatory leverage ratio or an insurance solvency measure. A change can come from either part of the ratio.",
    '"capital resources" OR "regulatory capital" OR "share repurchase"',
  ),
  roe: guide(
    "Net income relative to average beginning and ending book equity, with the displayed annualization rule.",
    "Separate profitability from the effect of leverage, buybacks and changes in the equity denominator.",
    "A small equity base can magnify this ratio. Annualizing an interim result does not forecast the full year; source ownership scope also matters.",
    '"return on equity" OR "capital resources" OR "share repurchase"',
  ),
  roa: guide(
    "Net income relative to average beginning and ending total assets, with the displayed annualization rule.",
    "Compare earnings movements with acquisitions, lending or investment growth and changes in the asset mix.",
    "Asset accounting and business models affect comparability. Interim annualization is arithmetic, not a full-year forecast.",
    '"return on assets" OR "net income" OR "total assets"',
  ),
  debtAssets: guide(
    "Reported current and noncurrent debt relative to total assets; both debt inputs are required.",
    "Review issuance, repayment, debt reclassification, asset changes and borrowing terms.",
    "The selected debt concepts may not capture every lease, guarantee or commitment. This ratio does not establish covenant compliance.",
    "debt OR maturity OR covenant OR guarantee",
    "notes",
    ["corporate", "insurance"],
  ),
  bankRevenue: guide(
    "Net interest income before provision plus noninterest income, as calculated in this workspace.",
    "Read about interest-rate sensitivity, earning-asset and funding mix, fees and trading or investment income.",
    "This is not gross interest revenue and may differ from the bank's adjusted presentation. Provision and operating expenses are separate.",
    '"net interest income" OR "noninterest income"',
    "mda",
    ["banking"],
  ),
  netInterestIncome: guide(
    "Reported interest income net of interest expense, before the credit-loss provision used in this workspace.",
    "Investigate yields, funding costs, rate changes, balance growth and the asset-liability mix.",
    "This amount is not net interest margin: that ratio also needs an appropriate average earning-asset denominator.",
    '"net interest income" OR "net interest margin" OR "deposit costs"',
    "mda",
    ["banking"],
  ),
  deposits: guide(
    "The bank's reported deposit liabilities at the balance-sheet date.",
    "Review deposit mix, rates paid, concentrations, uninsured balances and movements between account types.",
    "A total balance does not establish funding stability or the timing of withdrawals. Cash and total deposits are not matched maturities.",
    "deposits AND (uninsured OR concentration OR costs OR liquidity)",
    "mda",
    ["banking"],
  ),
  loans: guide(
    "Reported net loans within the selected SEC concept, after the allowances or adjustments that concept includes.",
    "Read about originations, repayments, sales, charge-offs, loan mix and credit-loss allowances.",
    "Net loans are different from gross loans. Growth or contraction alone does not establish credit quality.",
    '"loan portfolio" OR "credit quality" OR "charge-offs"',
    "notes",
    ["banking"],
  ),
  loanDeposits: guide(
    "Reported net loans as a percentage of deposits at the same balance-sheet date.",
    "Review loan and deposit movements separately, together with wholesale funding and liquid assets.",
    "The denominator is total deposits and the numerator is net loans. This is not a regulatory liquidity ratio or a forecast of deposit withdrawals.",
    'liquidity OR "wholesale funding" OR "deposit mix"',
    "mda",
    ["banking"],
  ),
  allowanceForLoanLoss: guide(
    "The reported credit-loss allowance associated with the selected source concept.",
    "Read the allowance rollforward alongside portfolio growth, expected-loss assumptions, provisions, charge-offs and recoveries.",
    "An allowance is an accounting estimate, not a separate cash reserve. Its source scope may be broader or narrower than the loan balance used elsewhere.",
    '"allowance for credit losses" OR "credit loss allowance"',
    "notes",
    ["banking"],
  ),
  allowanceLoans: guide(
    "Reported credit-loss allowance as a percentage of reported net loans in this workspace.",
    "Inspect both the allowance rollforward and changes in the size and mix of the loan portfolio.",
    "A higher ratio can reflect changed expected losses, loan mix or a smaller denominator. It does not establish reserve adequacy; verify that numerator and denominator scopes align.",
    '"allowance for credit losses" OR "credit quality"',
    "notes",
    ["banking"],
  ),
  provisionForLoanLoss: guide(
    "The period's reported credit-loss provision expense or benefit.",
    "Review portfolio growth, economic assumptions and the allowance rollforward to understand what changed.",
    "The provision is different from realized charge-offs. The reported concept may include exposures beyond funded loans.",
    '"provision for credit losses" OR "provision for loan losses"',
    "notes",
    ["banking"],
  ),
  provisionLoans: guide(
    "Credit-loss provision relative to ending net loans, annualized using the workspace's reporting-period rule.",
    "Inspect provision drivers and loan balance changes separately, including any shift in exposure scope.",
    "This uses ending net loans, not average gross loans. It is not a default probability or charge-off rate, and annualization is not a forecast.",
    '"provision for credit losses" OR "economic forecast"',
    "notes",
    ["banking"],
  ),
  efficiency: guide(
    "Noninterest expense relative to net interest income before provision plus noninterest income.",
    "Separate expense movements from revenue changes; check compensation, technology spending and unusual charges.",
    "This workspace's calculation may differ from the bank's adjusted efficiency ratio. A lower result alone does not establish better service, controls or future profitability.",
    '"efficiency ratio" OR "noninterest expense"',
    "mda",
    ["banking"],
  ),
  premiumsEarned: guide(
    "Reported net premiums earned over the reporting period.",
    "Read about pricing, policy volumes, coverage periods, business mix and reinsurance.",
    "Earned premiums differ from premiums written and cash receipts. This is not total insurance-company revenue or an underwriting profit measure.",
    '"premiums earned" OR "premiums written" OR reinsurance',
    "mda",
    ["insurance"],
  ),
  investmentIncome: guide(
    "Reported investment income for the period within the selected insurance-company concept.",
    "Inspect invested balances, yields, portfolio mix and how the issuer classifies gains, losses and investment expenses.",
    "Investment income is different from total investment return. The chosen concept may be net of expenses and may exclude gains or losses reported elsewhere.",
    '"investment income" OR "investment yield" OR "realized gains"',
    "mda",
    ["insurance"],
  ),
};

const marginGuide = guide(
  "The specified earnings subtotal as a percentage of the revenue denominator in the calculation below.",
  "Separate the numerator's drivers from revenue, business mix, expense classifications and unusual items.",
  "Compare the exact formula and source scope across periods. Different margins describe different stages of profitability and are not interchangeable.",
  'margin OR "results of operations"',
);
for (const key of [
  "grossMargin",
  "operatingMargin",
  "netMargin",
  "bankNetMargin",
])
  GUIDES[key] = {
    ...marginGuide,
    lenses: key === "bankNetMargin" ? ["banking"] : ["corporate"],
  };

/** Preserve the requested symbol, including share-class punctuation. No broad
 * market search is offered when a trustworthy single-company target is absent.
 * @param {{ticker?: string, cik?: string | number, query?: string, section?: string, asOf?: string}} options
 */
export function analysisDisclosureHandoff({
  ticker,
  cik,
  query,
  section = "all",
  asOf = "",
} = {}) {
  const symbol = typeof ticker === "string" ? ticker.trim().toUpperCase() : "";
  const target = /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)
    ? symbol
    : /^\d{1,10}$/.test(String(cik || ""))
      ? String(cik)
      : "";
  if (!target || typeof query !== "string" || !query.trim()) return null;
  const params = new URLSearchParams({
    mode: "companies",
    tickers: target,
    query: query.trim(),
    forms: "10-K,10-Q",
    section: ["mda", "notes", "risk", "all"].includes(section)
      ? section
      : "all",
  });
  // A filing cutoff must survive a handoff; the financial period end is not a
  // substitute for it because reports are generally filed after period end.
  if (validDate(asOf)) {
    params.set("end", asOf);
    params.set(
      "start",
      `${Math.max(1900, Number(asOf.slice(0, 4)) - 5)}-01-01`,
    );
  }
  return `/disclosures?${params.toString()}`;
}

export function analysisMetricGuide(
  definition = {},
  point = {},
  lens = "corporate",
) {
  const match = Object.hasOwn(GUIDES, definition.key || "")
    ? GUIDES[definition.key]
    : null;
  const transformed = ["index", "percentagePoints"].includes(definition.format);
  const selected =
    match && !transformed && (!match.lenses || match.lenses.includes(lens))
      ? match
      : null;
  const scopeNotes = [];
  const sources = evidenceSources(point);
  if (sources.some((source) => /RestrictedCash/.test(source.tag || "")))
    scopeNotes.push(
      "A selected input explicitly includes restricted cash. Review restrictions before treating it as available liquidity.",
    );
  if (sources.some((source) => source.tag === "ProfitLoss"))
    scopeNotes.push(
      "The selected ProfitLoss input can include noncontrolling interests; inspect the issuer's earnings allocation before comparing it with per-share or parent-equity measures.",
    );
  if (sources.some((source) => /CashAndDueFromBanks/.test(source.tag || "")))
    scopeNotes.push(
      "The selected cash input is CashAndDueFromBanks. Use its banking scope rather than assuming it matches a corporate cash-and-equivalents measure.",
    );
  if (!Number.isFinite(point?.value))
    scopeNotes.push(
      "This observation is unavailable. The guide explains the measure; it does not fill in a missing number or establish a company conclusion.",
    );
  const context = selected || {
    meaning:
      "Use the displayed definition, calculation and reported inputs to establish exactly what this figure measures.",
    movement:
      "Check whether a change comes from business activity, reporting duration, a different source concept, a revised filing or the calculation's denominator.",
    caution:
      "No metric-specific interpretation has been assigned to this figure. Custom, indexed and scenario results must be read using their own formula and assumptions.",
    query: '"results of operations" OR "accounting policies"',
    section: "all",
  };
  const commonSize =
    definition.format === "percent" &&
    ["income", "balance", "cashflow"].includes(definition.category);
  return {
    ...context,
    meaning: commonSize
      ? `The displayed value is a common-size percentage using the denominator in the calculation, rather than the reported currency amount. Underlying measure: ${context.meaning}`
      : context.meaning,
    known: Boolean(selected),
    scopeNotes,
    reading: READING,
  };
}
