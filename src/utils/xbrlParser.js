/**
 * XBRL Company Facts parser — v3.
 *
 * v3 additions:
 *   - Growth math helpers: yoyGrowth, cagr
 *   - Summary extractor: latest value + growth rates for headline metrics
 *   - Same correctness fixes from v2 preserved (period-end dates, latest-filed, industry-aware)
 */

// ============================================================================
// Tag priorities
// ============================================================================

const DEFAULT_TAGS = {
  revenue: [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet',
    'SalesRevenueGoodsNet',
  ],
  costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices'],
  grossProfit: ['GrossProfit'],
  operatingExpenses: ['OperatingExpenses'],
  rnd: ['ResearchAndDevelopmentExpense'],
  sga: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'],
  operatingIncome: ['OperatingIncomeLoss'],
  interestExpense: ['InterestExpense'],
  pretaxIncome: [
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
  ],
  incomeTax: ['IncomeTaxExpenseBenefit'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  epsBasic: ['EarningsPerShareBasic'],
  epsDiluted: ['EarningsPerShareDiluted'],
  sharesBasic: ['WeightedAverageNumberOfSharesOutstandingBasic'],
  sharesDiluted: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
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
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  investingCashFlow: ['NetCashProvidedByUsedInInvestingActivities'],
  financingCashFlow: ['NetCashProvidedByUsedInFinancingActivities'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  dividendsPaid: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
  stockRepurchased: ['PaymentsForRepurchaseOfCommonStock'],
  debtIssued: ['ProceedsFromIssuanceOfLongTermDebt'],
  debtRepaid: ['RepaymentsOfLongTermDebt'],
};

const BANK_TAGS = {
  revenue: ['Revenues', 'InterestAndDividendIncomeOperating', 'InterestIncomeOperating'],
  cash: ['CashAndDueFromBanks', 'Cash', 'CashAndCashEquivalentsAtCarryingValue'],
  costOfRevenue: [],
  grossProfit: [],
  rnd: [],
};

const INSURANCE_TAGS = {
  revenue: ['Revenues', 'PremiumsEarnedNet'],
  costOfRevenue: [],
  grossProfit: [],
};

function getTags(metricKey, sicCode) {
  const sic = parseInt(sicCode, 10) || 0;
  let industryTags = {};
  if (sic >= 6000 && sic <= 6299) industryTags = BANK_TAGS;
  else if (sic >= 6300 && sic <= 6411) industryTags = INSURANCE_TAGS;
  if (industryTags[metricKey] !== undefined) return industryTags[metricKey];
  return DEFAULT_TAGS[metricKey] || [];
}

// ============================================================================
// Period extraction
// ============================================================================

export function extractAnnualPeriods(facts) {
  const years = new Map();
  const scanTags = ['Assets', 'NetIncomeLoss', 'StockholdersEquity', 'Revenues', 'Liabilities'];
  for (const tag of scanTags) {
    const concept = facts['us-gaap']?.[tag];
    if (!concept?.units) continue;
    for (const entries of Object.values(concept.units)) {
      for (const e of entries) {
        if (e.form === '10-K' && e.fp === 'FY' && e.end) {
          const endYear = parseInt(e.end.slice(0, 4), 10);
          if (!years.has(endYear) || e.filed > years.get(endYear).filed) {
            years.set(endYear, { fy: endYear, fp: 'FY', end: e.end, filed: e.filed });
          }
        }
      }
    }
  }
  return Array.from(years.values()).sort((a, b) => b.fy - a.fy);
}

export function extractQuarterlyPeriods(facts) {
  const periods = new Map();
  const scanTags = ['Assets', 'NetIncomeLoss', 'Revenues'];
  for (const tag of scanTags) {
    const concept = facts['us-gaap']?.[tag];
    if (!concept?.units) continue;
    for (const entries of Object.values(concept.units)) {
      for (const e of entries) {
        if (e.form === '10-Q' && e.end && e.fp?.startsWith('Q')) {
          const endYear = parseInt(e.end.slice(0, 4), 10);
          const key = `${endYear}-${e.fp}`;
          if (!periods.has(key) || e.filed > periods.get(key).filed) {
            periods.set(key, { fy: endYear, fp: e.fp, end: e.end, filed: e.filed });
          }
        }
      }
    }
  }
  return Array.from(periods.values()).sort((a, b) => {
    if (a.fy !== b.fy) return b.fy - a.fy;
    return b.fp.localeCompare(a.fp);
  });
}

// ============================================================================
// Value lookup
// ============================================================================

function findFactByEnd(facts, tags, periodEnd, form, scope = 'USD') {
  const expectedEndYear = periodEnd.slice(0, 4);
  for (const tag of tags) {
    const concept = facts['us-gaap']?.[tag] || facts['ifrs-full']?.[tag];
    if (!concept?.units) continue;
    const preferred = scope === 'USD' ? ['USD'] : scope === 'shares' ? ['shares'] : ['USD/shares'];
    const allUnits = [...preferred, ...Object.keys(concept.units).filter((u) => !preferred.includes(u))];
    const matches = [];
    for (const unit of allUnits) {
      const entries = concept.units[unit];
      if (!entries) continue;
      for (const e of entries) {
        const sameEnd = e.end === periodEnd;
        const sameEndYear = e.end && e.end.slice(0, 4) === expectedEndYear;
        const formMatch = !form || e.form === form;
        if (formMatch && (sameEnd || sameEndYear)) {
          if (form === '10-K' && e.fp !== 'FY') continue;
          if (form === '10-Q' && !e.fp?.startsWith('Q')) continue;
          matches.push({ ...e, tag, unit });
        }
      }
      if (matches.length > 0) break;
    }
    if (matches.length > 0) {
      matches.sort((a, b) => {
        const aExact = a.end === periodEnd ? 1 : 0;
        const bExact = b.end === periodEnd ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        return (b.filed || '').localeCompare(a.filed || '');
      });
      const best = matches[0];
      return {
        value: best.val,
        tag: best.tag,
        unit: best.unit,
        accession: best.accn,
        filed: best.filed,
        end: best.end,
        form: best.form,
      };
    }
  }
  return null;
}

// ============================================================================
// Row builders
// ============================================================================

export function buildMetricRow(facts, metricKey, label, periods, format = 'currency', sicCode = null) {
  const tags = getTags(metricKey, sicCode);
  const scope = format === 'eps' ? 'USD/shares' : format === 'shares' ? 'shares' : 'USD';

  const values = periods.map((p) => {
    if (tags.length === 0) return { period: p, value: null, source: null };
    const form = p.form || (p.fp === 'FY' ? '10-K' : '10-Q');
    const found = findFactByEnd(facts, tags, p.end, form, scope);
    if (!found) return { period: p, value: null, source: null };
    return {
      period: p,
      value: found.value,
      source: {
        tag: found.tag,
        unit: found.unit,
        accession: found.accession,
        filed: found.filed,
        end: found.end,
      },
    };
  });

  return { key: metricKey, label, values, format };
}

export function buildIncomeStatement(facts, periods, sicCode = null) {
  return [
    buildMetricRow(facts, 'revenue', 'Revenue', periods, 'currency', sicCode),
    buildMetricRow(facts, 'costOfRevenue', 'Cost of Revenue', periods, 'currency', sicCode),
    buildMetricRow(facts, 'grossProfit', 'Gross Profit', periods, 'currency', sicCode),
    buildMetricRow(facts, 'rnd', 'R&D Expense', periods, 'currency', sicCode),
    buildMetricRow(facts, 'sga', 'SG&A Expense', periods, 'currency', sicCode),
    buildMetricRow(facts, 'operatingIncome', 'Operating Income', periods, 'currency', sicCode),
    buildMetricRow(facts, 'interestExpense', 'Interest Expense', periods, 'currency', sicCode),
    buildMetricRow(facts, 'pretaxIncome', 'Pre-tax Income', periods, 'currency', sicCode),
    buildMetricRow(facts, 'incomeTax', 'Income Tax', periods, 'currency', sicCode),
    buildMetricRow(facts, 'netIncome', 'Net Income', periods, 'currency', sicCode),
    buildMetricRow(facts, 'epsBasic', 'EPS (Basic)', periods, 'eps', sicCode),
    buildMetricRow(facts, 'epsDiluted', 'EPS (Diluted)', periods, 'eps', sicCode),
    buildMetricRow(facts, 'sharesDiluted', 'Diluted Shares', periods, 'shares', sicCode),
  ];
}

export function buildBalanceSheet(facts, periods, sicCode = null) {
  return [
    buildMetricRow(facts, 'cash', 'Cash & Equivalents', periods, 'currency', sicCode),
    buildMetricRow(facts, 'shortTermInvestments', 'Short-term Investments', periods, 'currency', sicCode),
    buildMetricRow(facts, 'receivables', 'Accounts Receivable', periods, 'currency', sicCode),
    buildMetricRow(facts, 'inventory', 'Inventory', periods, 'currency', sicCode),
    buildMetricRow(facts, 'currentAssets', 'Total Current Assets', periods, 'currency', sicCode),
    buildMetricRow(facts, 'ppe', 'Property, Plant & Equipment', periods, 'currency', sicCode),
    buildMetricRow(facts, 'goodwill', 'Goodwill', periods, 'currency', sicCode),
    buildMetricRow(facts, 'intangibles', 'Intangible Assets', periods, 'currency', sicCode),
    buildMetricRow(facts, 'totalAssets', 'Total Assets', periods, 'currency', sicCode),
    buildMetricRow(facts, 'accountsPayable', 'Accounts Payable', periods, 'currency', sicCode),
    buildMetricRow(facts, 'shortTermDebt', 'Short-term Debt', periods, 'currency', sicCode),
    buildMetricRow(facts, 'currentLiabilities', 'Total Current Liabilities', periods, 'currency', sicCode),
    buildMetricRow(facts, 'longTermDebt', 'Long-term Debt', periods, 'currency', sicCode),
    buildMetricRow(facts, 'totalLiabilities', 'Total Liabilities', periods, 'currency', sicCode),
    buildMetricRow(facts, 'retainedEarnings', 'Retained Earnings', periods, 'currency', sicCode),
    buildMetricRow(facts, 'stockholdersEquity', "Stockholders' Equity", periods, 'currency', sicCode),
  ];
}

export function buildCashFlow(facts, periods, sicCode = null) {
  return [
    buildMetricRow(facts, 'operatingCashFlow', 'Operating Cash Flow', periods, 'currency', sicCode),
    buildMetricRow(facts, 'investingCashFlow', 'Investing Cash Flow', periods, 'currency', sicCode),
    buildMetricRow(facts, 'financingCashFlow', 'Financing Cash Flow', periods, 'currency', sicCode),
    buildMetricRow(facts, 'capex', 'Capital Expenditures', periods, 'currency', sicCode),
    buildMetricRow(facts, 'dividendsPaid', 'Dividends Paid', periods, 'currency', sicCode),
    buildMetricRow(facts, 'stockRepurchased', 'Stock Repurchased', periods, 'currency', sicCode),
    buildMetricRow(facts, 'debtIssued', 'Debt Issued', periods, 'currency', sicCode),
    buildMetricRow(facts, 'debtRepaid', 'Debt Repaid', periods, 'currency', sicCode),
  ];
}

export function buildRatios(facts, periods, sicCode = null) {
  const getVal = (key, p) => {
    const row = buildMetricRow(facts, key, '', [p], key.startsWith('eps') ? 'eps' : 'currency', sicCode);
    return row.values[0]?.value;
  };

  const ratio = (label, fn, format = 'percent') => ({
    label,
    format,
    values: periods.map((p) => {
      try {
        const v = fn(p);
        return { period: p, value: Number.isFinite(v) ? v : null, source: null };
      } catch {
        return { period: p, value: null, source: null };
      }
    }),
  });

  return [
    ratio('Gross Margin', (p) => {
      const rev = getVal('revenue', p);
      let gp = getVal('grossProfit', p);
      if (gp == null) {
        const cost = getVal('costOfRevenue', p);
        if (rev != null && cost != null) gp = rev - cost;
      }
      return rev && gp != null ? (gp / rev) * 100 : null;
    }),
    ratio('Operating Margin', (p) => {
      const rev = getVal('revenue', p);
      const op = getVal('operatingIncome', p);
      return rev && op != null ? (op / rev) * 100 : null;
    }),
    ratio('Net Margin', (p) => {
      const rev = getVal('revenue', p);
      const ni = getVal('netIncome', p);
      return rev && ni != null ? (ni / rev) * 100 : null;
    }),
    ratio('Return on Equity (ROE)', (p) => {
      const eq = getVal('stockholdersEquity', p);
      const ni = getVal('netIncome', p);
      return eq && ni != null ? (ni / eq) * 100 : null;
    }),
    ratio('Return on Assets (ROA)', (p) => {
      const ta = getVal('totalAssets', p);
      const ni = getVal('netIncome', p);
      return ta && ni != null ? (ni / ta) * 100 : null;
    }),
    ratio('Current Ratio', (p) => {
      const ca = getVal('currentAssets', p);
      const cl = getVal('currentLiabilities', p);
      return ca && cl ? ca / cl : null;
    }, 'decimal'),
    ratio('Debt-to-Equity', (p) => {
      const eq = getVal('stockholdersEquity', p);
      const std = getVal('shortTermDebt', p) || 0;
      const ltd = getVal('longTermDebt', p) || 0;
      return eq ? (std + ltd) / eq : null;
    }, 'decimal'),
    ratio('Debt-to-Assets', (p) => {
      const ta = getVal('totalAssets', p);
      const std = getVal('shortTermDebt', p) || 0;
      const ltd = getVal('longTermDebt', p) || 0;
      return ta ? (std + ltd) / ta : null;
    }, 'decimal'),
  ];
}

// ============================================================================
// NEW: Growth calculations
// ============================================================================

/**
 * Year-over-year percentage change. Handles null/zero/negative edge cases safely.
 * Returns null if not computable, a number (not string) otherwise.
 */
export function yoyGrowth(current, previous) {
  if (current == null || previous == null) return null;
  if (previous === 0) return null;
  // If previous was negative, YoY % is misleading — flag it by returning null
  // (alternative: return Math.sign(current) * Math.abs((current - previous) / previous) * 100,
  //  but that's confusing. Null is more honest.)
  if (previous < 0 && current < 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/**
 * Compound annual growth rate over N years.
 * CAGR = (end/start)^(1/years) - 1
 * Returns percentage as a number, or null if not computable (needs positive values).
 */
export function cagr(startValue, endValue, years) {
  if (startValue == null || endValue == null || years <= 0) return null;
  if (startValue <= 0 || endValue <= 0) return null; // CAGR undefined for negative/zero
  return (Math.pow(endValue / startValue, 1 / years) - 1) * 100;
}

/**
 * Given a metric row's values array (newest first), compute:
 *   - latest: most recent non-null value
 *   - prior: second most recent non-null value
 *   - yoy: percent change latest vs prior
 *   - cagr5y: 5-year CAGR if possible
 *   - cagr10y: 10-year CAGR if possible
 */
export function computeGrowth(row) {
  const values = row.values.filter((v) => v.value != null);
  if (values.length === 0) return { latest: null, prior: null, yoy: null, cagr5y: null, cagr10y: null };

  const latest = values[0].value;
  const prior = values[1]?.value ?? null;
  const yoy = prior != null ? yoyGrowth(latest, prior) : null;

  // For CAGR, find the value 5 and 10 periods back if available
  const fiveBack = values[5]?.value ?? null;
  const tenBack = values[10]?.value ?? null;
  const cagr5y = fiveBack != null ? cagr(fiveBack, latest, 5) : null;
  const cagr10y = tenBack != null ? cagr(tenBack, latest, 10) : null;

  return { latest, prior, yoy, cagr5y, cagr10y };
}

// ============================================================================
// Formatting
// ============================================================================

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
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * Format a growth percentage with sign and color hint.
 * Returns { text, color } — color is 'positive' | 'negative' | 'neutral'
 */
export function formatGrowth(pct) {
  if (pct == null || !Number.isFinite(pct)) return { text: '—', color: 'neutral' };
  const sign = pct > 0 ? '+' : '';
  const text = `${sign}${pct.toFixed(1)}%`;
  const color = pct > 0.1 ? 'positive' : pct < -0.1 ? 'negative' : 'neutral';
  return { text, color };
}

export function periodLabel(period) {
  if (period.fp === 'FY') return `FY${String(period.fy).slice(-2)}`;
  return `${period.fp} ${String(period.fy).slice(-2)}`;
}

export function buildSourceUrl(cik, source) {
  if (!source) return null;
  const paddedCik = String(cik).padStart(10, '0');
  if (source.tag) {
    return `https://data.sec.gov/api/xbrl/companyconcept/CIK${paddedCik}/us-gaap/${source.tag}.json`;
  }
  return null;
}
