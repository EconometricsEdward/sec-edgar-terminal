/**
 * XBRL Company Facts parser.
 *
 * SEC publishes structured financial data at data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json
 * Each "fact" (e.g. Revenues, Assets, NetIncomeLoss) contains an array of reported values
 * across many filings, each tagged with:
 *   - form: "10-K" or "10-Q"
 *   - fy: fiscal year
 *   - fp: fiscal period ("FY", "Q1", "Q2", "Q3")
 *   - end: period end date (YYYY-MM-DD)
 *   - val: the numeric value
 *   - unit: USD, shares, USD/shares, etc.
 *
 * Different companies tag the same concept differently (e.g. "Revenues" vs "RevenueFromContractWithCustomerExcludingAssessedTax").
 * We handle this by trying a prioritized list of tags for each metric.
 */

// Prioritized tag lookup — first match wins. Covers GAAP + common IFRS variants.
const METRIC_TAGS = {
  // ---------- INCOME STATEMENT ----------
  revenue: [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet',
    'SalesRevenueGoodsNet',
  ],
  costOfRevenue: [
    'CostOfRevenue',
    'CostOfGoodsAndServicesSold',
    'CostOfGoodsSold',
    'CostOfServices',
  ],
  grossProfit: ['GrossProfit'],
  operatingExpenses: ['OperatingExpenses'],
  rnd: ['ResearchAndDevelopmentExpense'],
  sga: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'],
  operatingIncome: ['OperatingIncomeLoss'],
  interestExpense: ['InterestExpense'],
  pretaxIncome: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
  incomeTax: ['IncomeTaxExpenseBenefit'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  epsBasic: ['EarningsPerShareBasic'],
  epsDiluted: ['EarningsPerShareDiluted'],
  sharesBasic: ['WeightedAverageNumberOfSharesOutstandingBasic'],
  sharesDiluted: ['WeightedAverageNumberOfDilutedSharesOutstanding'],

  // ---------- BALANCE SHEET ----------
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'Cash'],
  shortTermInvestments: ['ShortTermInvestments', 'MarketableSecuritiesCurrent'],
  receivables: ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'],
  inventory: ['InventoryNet'],
  currentAssets: ['AssetsCurrent'],
  ppe: ['PropertyPlantAndEquipmentNet'],
  goodwill: ['Goodwill'],
  intangibles: ['IntangibleAssetsNetExcludingGoodwill'],
  totalAssets: ['Assets'],
  accountsPayable: ['AccountsPayableCurrent'],
  shortTermDebt: ['LongTermDebtCurrent', 'ShortTermBorrowings', 'DebtCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  totalLiabilities: ['Liabilities'],
  retainedEarnings: ['RetainedEarningsAccumulatedDeficit'],
  stockholdersEquity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],

  // ---------- CASH FLOW ----------
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  investingCashFlow: ['NetCashProvidedByUsedInInvestingActivities'],
  financingCashFlow: ['NetCashProvidedByUsedInFinancingActivities'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  dividendsPaid: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
  stockRepurchased: ['PaymentsForRepurchaseOfCommonStock'],
  debtIssued: ['ProceedsFromIssuanceOfLongTermDebt'],
  debtRepaid: ['RepaymentsOfLongTermDebt'],
};

/**
 * Extract a single value for a metric in a given period from the facts object.
 * Tries each tag in priority order and returns the first one with a matching period.
 * `scope` filters which unit namespace to look in — usually "USD" or "USD/shares".
 */
function findFact(facts, tags, period, scope = 'USD') {
  for (const tag of tags) {
    const concept = facts['us-gaap']?.[tag] || facts['ifrs-full']?.[tag];
    if (!concept?.units) continue;

    // Look in preferred units first, then fall back to any available unit
    const unitsToTry = scope === 'USD' ? ['USD'] : scope === 'shares' ? ['shares'] : ['USD/shares'];
    const allUnits = [...unitsToTry, ...Object.keys(concept.units).filter((u) => !unitsToTry.includes(u))];

    for (const unit of allUnits) {
      const entries = concept.units[unit];
      if (!entries) continue;
      const match = entries.find(
        (e) => e.form === period.form && e.fy === period.fy && e.fp === period.fp
      );
      if (match) return match.val;
    }
  }
  return null;
}

/**
 * Build the set of annual (10-K) periods from a companyfacts object.
 * Returns sorted fiscal years, newest first.
 */
export function extractAnnualPeriods(facts) {
  const years = new Set();
  const tagsToScan = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'NetIncomeLoss', 'Assets'];

  for (const tag of tagsToScan) {
    const concept = facts['us-gaap']?.[tag];
    if (!concept?.units) continue;
    for (const entries of Object.values(concept.units)) {
      for (const e of entries) {
        if (e.form === '10-K' && e.fp === 'FY' && e.fy) years.add(e.fy);
      }
    }
  }

  return Array.from(years).sort((a, b) => b - a);
}

/**
 * Build the set of quarterly (10-Q) periods. Returns array of {fy, fp, label, end} newest first.
 * Note: 10-K filings cover the full year, not Q4 — so Q4 data actually has to be derived from
 * the 10-K annual numbers minus Q1+Q2+Q3. We don't do that derivation here; 10-Q gives us Q1–Q3.
 */
export function extractQuarterlyPeriods(facts) {
  const periods = new Map(); // key: fy-fp
  const tagsToScan = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'NetIncomeLoss', 'Assets'];

  for (const tag of tagsToScan) {
    const concept = facts['us-gaap']?.[tag];
    if (!concept?.units) continue;
    for (const entries of Object.values(concept.units)) {
      for (const e of entries) {
        if (e.form === '10-Q' && e.fy && e.fp && e.fp.startsWith('Q')) {
          const key = `${e.fy}-${e.fp}`;
          if (!periods.has(key)) periods.set(key, { fy: e.fy, fp: e.fp, end: e.end });
        }
      }
    }
  }

  return Array.from(periods.values()).sort((a, b) => {
    if (a.fy !== b.fy) return b.fy - a.fy;
    return b.fp.localeCompare(a.fp);
  });
}

/**
 * Build a full row of metric values across all periods.
 * Returns: { label, category, rows: [{period, value}], format }
 */
export function buildMetricRow(facts, key, label, periods, format = 'currency') {
  const tags = METRIC_TAGS[key];
  const scope = format === 'eps' ? 'USD/shares' : format === 'shares' ? 'shares' : 'USD';

  const values = periods.map((p) => {
    const form = p.form || (p.fp === 'FY' ? '10-K' : '10-Q');
    const val = findFact(facts, tags, { form, fy: p.fy, fp: p.fp }, scope);
    return { period: p, value: val };
  });

  return { key, label, values, format };
}

/**
 * Build all Income Statement rows for the given periods.
 */
export function buildIncomeStatement(facts, periods) {
  const annotated = periods.map((p) => ({ ...p, form: p.fp === 'FY' ? '10-K' : '10-Q' }));
  return [
    buildMetricRow(facts, 'revenue', 'Revenue', annotated),
    buildMetricRow(facts, 'costOfRevenue', 'Cost of Revenue', annotated),
    buildMetricRow(facts, 'grossProfit', 'Gross Profit', annotated),
    buildMetricRow(facts, 'rnd', 'R&D Expense', annotated),
    buildMetricRow(facts, 'sga', 'SG&A Expense', annotated),
    buildMetricRow(facts, 'operatingIncome', 'Operating Income', annotated),
    buildMetricRow(facts, 'interestExpense', 'Interest Expense', annotated),
    buildMetricRow(facts, 'pretaxIncome', 'Pre-tax Income', annotated),
    buildMetricRow(facts, 'incomeTax', 'Income Tax', annotated),
    buildMetricRow(facts, 'netIncome', 'Net Income', annotated),
    buildMetricRow(facts, 'epsBasic', 'EPS (Basic)', annotated, 'eps'),
    buildMetricRow(facts, 'epsDiluted', 'EPS (Diluted)', annotated, 'eps'),
    buildMetricRow(facts, 'sharesDiluted', 'Diluted Shares', annotated, 'shares'),
  ];
}

export function buildBalanceSheet(facts, periods) {
  const annotated = periods.map((p) => ({ ...p, form: p.fp === 'FY' ? '10-K' : '10-Q' }));
  return [
    buildMetricRow(facts, 'cash', 'Cash & Equivalents', annotated),
    buildMetricRow(facts, 'shortTermInvestments', 'Short-term Investments', annotated),
    buildMetricRow(facts, 'receivables', 'Accounts Receivable', annotated),
    buildMetricRow(facts, 'inventory', 'Inventory', annotated),
    buildMetricRow(facts, 'currentAssets', 'Total Current Assets', annotated),
    buildMetricRow(facts, 'ppe', 'Property, Plant & Equipment', annotated),
    buildMetricRow(facts, 'goodwill', 'Goodwill', annotated),
    buildMetricRow(facts, 'intangibles', 'Intangible Assets', annotated),
    buildMetricRow(facts, 'totalAssets', 'Total Assets', annotated),
    buildMetricRow(facts, 'accountsPayable', 'Accounts Payable', annotated),
    buildMetricRow(facts, 'shortTermDebt', 'Short-term Debt', annotated),
    buildMetricRow(facts, 'currentLiabilities', 'Total Current Liabilities', annotated),
    buildMetricRow(facts, 'longTermDebt', 'Long-term Debt', annotated),
    buildMetricRow(facts, 'totalLiabilities', 'Total Liabilities', annotated),
    buildMetricRow(facts, 'retainedEarnings', 'Retained Earnings', annotated),
    buildMetricRow(facts, 'stockholdersEquity', "Stockholders' Equity", annotated),
  ];
}

export function buildCashFlow(facts, periods) {
  const annotated = periods.map((p) => ({ ...p, form: p.fp === 'FY' ? '10-K' : '10-Q' }));
  return [
    buildMetricRow(facts, 'operatingCashFlow', 'Operating Cash Flow', annotated),
    buildMetricRow(facts, 'investingCashFlow', 'Investing Cash Flow', annotated),
    buildMetricRow(facts, 'financingCashFlow', 'Financing Cash Flow', annotated),
    buildMetricRow(facts, 'capex', 'Capital Expenditures', annotated),
    buildMetricRow(facts, 'dividendsPaid', 'Dividends Paid', annotated),
    buildMetricRow(facts, 'stockRepurchased', 'Stock Repurchased', annotated),
    buildMetricRow(facts, 'debtIssued', 'Debt Issued', annotated),
    buildMetricRow(facts, 'debtRepaid', 'Debt Repaid', annotated),
  ];
}

/**
 * Ratios are computed, not looked up. Each needs its own value-computation function.
 */
export function buildRatios(facts, periods) {
  const annotated = periods.map((p) => ({ ...p, form: p.fp === 'FY' ? '10-K' : '10-Q' }));

  const get = (key, p) => findFact(facts, METRIC_TAGS[key], p, key.startsWith('eps') ? 'USD/shares' : 'USD');

  const ratio = (label, fn, format = 'percent') => ({
    label,
    format,
    values: annotated.map((p) => {
      try {
        const v = fn(p);
        return { period: p, value: Number.isFinite(v) ? v : null };
      } catch {
        return { period: p, value: null };
      }
    }),
  });

  return [
    ratio('Gross Margin', (p) => {
      const rev = get('revenue', p);
      const gp = get('grossProfit', p) ?? (rev - get('costOfRevenue', p));
      return rev ? (gp / rev) * 100 : null;
    }),
    ratio('Operating Margin', (p) => {
      const rev = get('revenue', p);
      const op = get('operatingIncome', p);
      return rev && op != null ? (op / rev) * 100 : null;
    }),
    ratio('Net Margin', (p) => {
      const rev = get('revenue', p);
      const ni = get('netIncome', p);
      return rev && ni != null ? (ni / rev) * 100 : null;
    }),
    ratio('Return on Equity (ROE)', (p) => {
      const eq = get('stockholdersEquity', p);
      const ni = get('netIncome', p);
      return eq && ni != null ? (ni / eq) * 100 : null;
    }),
    ratio('Return on Assets (ROA)', (p) => {
      const ta = get('totalAssets', p);
      const ni = get('netIncome', p);
      return ta && ni != null ? (ni / ta) * 100 : null;
    }),
    ratio('Current Ratio', (p) => {
      const ca = get('currentAssets', p);
      const cl = get('currentLiabilities', p);
      return ca && cl ? ca / cl : null;
    }, 'decimal'),
    ratio('Debt-to-Equity', (p) => {
      const eq = get('stockholdersEquity', p);
      const std = get('shortTermDebt', p) || 0;
      const ltd = get('longTermDebt', p) || 0;
      return eq ? (std + ltd) / eq : null;
    }, 'decimal'),
    ratio('Debt-to-Assets', (p) => {
      const ta = get('totalAssets', p);
      const std = get('shortTermDebt', p) || 0;
      const ltd = get('longTermDebt', p) || 0;
      return ta ? (std + ltd) / ta : null;
    }, 'decimal'),
  ];
}

/**
 * Value formatters for display.
 */
export function formatValue(value, format) {
  if (value === null || value === undefined) return '—';
  if (format === 'eps') return `$${value.toFixed(2)}`;
  if (format === 'shares') {
    if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    return value.toLocaleString();
  }
  if (format === 'percent') return `${value.toFixed(1)}%`;
  if (format === 'decimal') return value.toFixed(2);
  // currency: scale to B / M / K
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function periodLabel(period) {
  if (period.fp === 'FY') return `FY${String(period.fy).slice(-2)}`;
  return `${period.fp} ${String(period.fy).slice(-2)}`;
}
