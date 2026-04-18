/**
 * XBRL Company Facts parser — v2.
 *
 * Key improvements over v1:
 *   1. Uses period-end dates (not fy field) to identify fiscal years — avoids the bug
 *      where multiple `fy` values for the same calendar year gave wrong results.
 *   2. When multiple entries exist for the same period (e.g. original + restatement),
 *      picks the most recently filed value (latest `filed` date).
 *   3. Industry-aware tag priorities — banks report revenue differently from tech companies.
 *      Pass SIC code to buildMetricRow/buildIncomeStatement to get the right priority.
 *   4. Returns the source tag name and filing accession with each value so the UI can
 *      link to the exact SEC endpoint for verification.
 */

// ============================================================================
// Tag priorities: generic + industry-specific overrides
// ============================================================================

const DEFAULT_TAGS = {
  // Income Statement
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

  // Balance Sheet
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
  stockholdersEquity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  ],

  // Cash Flow
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  investingCashFlow: ['NetCashProvidedByUsedInInvestingActivities'],
  financingCashFlow: ['NetCashProvidedByUsedInFinancingActivities'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  dividendsPaid: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
  stockRepurchased: ['PaymentsForRepurchaseOfCommonStock'],
  debtIssued: ['ProceedsFromIssuanceOfLongTermDebt'],
  debtRepaid: ['RepaymentsOfLongTermDebt'],
};

// Banking industry (SIC 6000-6999): revenue = interest income + non-interest income
// Banks typically don't report "Revenues", "CostOfRevenue", or "GrossProfit" at all.
const BANK_TAGS = {
  revenue: [
    // Net revenues (interest + non-interest)
    'Revenues',
    'InterestAndDividendIncomeOperating',
    'InterestIncomeOperating',
  ],
  // Bank-specific interest revenue (additional metric)
  netInterestIncome: ['InterestIncomeExpenseNet'],
  noninterestIncome: ['NoninterestIncome'],
  // Banks don't report these — leave empty to avoid confusion
  costOfRevenue: [],
  grossProfit: [],
  rnd: [],
};

// Insurance industry (SIC 6300-6411): premiums + investment income
const INSURANCE_TAGS = {
  revenue: [
    'Revenues',
    'PremiumsEarnedNet',
  ],
  costOfRevenue: [],
  grossProfit: [],
};

/**
 * Get the effective tag list for a metric, given industry.
 */
function getTags(metricKey, sicCode) {
  const sic = parseInt(sicCode, 10) || 0;
  let industryTags = {};

  if (sic >= 6000 && sic <= 6299) industryTags = BANK_TAGS;
  else if (sic >= 6300 && sic <= 6411) industryTags = INSURANCE_TAGS;

  // Industry override takes precedence; falls back to default.
  if (industryTags[metricKey] !== undefined) return industryTags[metricKey];
  return DEFAULT_TAGS[metricKey] || [];
}

// ============================================================================
// Period extraction (using period-end dates, not fy field)
// ============================================================================

/**
 * From a companyfacts object, extract all distinct annual fiscal years by looking
 * at 10-K filings with fp="FY". Uses the end date to determine which calendar year
 * the fiscal year maps to.
 */
export function extractAnnualPeriods(facts) {
  const years = new Map(); // endYear -> { fy, fp, end }
  const scanTags = ['Assets', 'NetIncomeLoss', 'StockholdersEquity', 'Revenues', 'Liabilities'];

  for (const tag of scanTags) {
    const concept = facts['us-gaap']?.[tag];
    if (!concept?.units) continue;
    for (const entries of Object.values(concept.units)) {
      for (const e of entries) {
        if (e.form === '10-K' && e.fp === 'FY' && e.end) {
          // Parse end date to get the calendar year
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

/**
 * Extract quarterly periods. We key by end-date quarter for robustness.
 */
export function extractQuarterlyPeriods(facts) {
  const periods = new Map(); // "YYYY-Q" -> { fy, fp, end }
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
// Value lookup — match by period END DATE, pick latest-filed
// ============================================================================

/**
 * Find the best value for a metric at a given period.
 * Matches using period end date (more reliable than fy field).
 * Returns { value, tag, unit, accession, filed, end } for transparency.
 */
function findFactByEnd(facts, tags, periodEnd, form, scope = 'USD') {
  const expectedEndYear = periodEnd.slice(0, 4);

  for (const tag of tags) {
    const concept = facts['us-gaap']?.[tag] || facts['ifrs-full']?.[tag];
    if (!concept?.units) continue;

    // Preferred units first, then any available
    const preferred = scope === 'USD' ? ['USD'] : scope === 'shares' ? ['shares'] : ['USD/shares'];
    const allUnits = [...preferred, ...Object.keys(concept.units).filter((u) => !preferred.includes(u))];

    // Collect all matching entries, then pick latest-filed
    const matches = [];
    for (const unit of allUnits) {
      const entries = concept.units[unit];
      if (!entries) continue;

      for (const e of entries) {
        // Match by end date: exact match, or same end year (for small filing-date drift)
        const sameEnd = e.end === periodEnd;
        const sameEndYear = e.end && e.end.slice(0, 4) === expectedEndYear;
        const formMatch = !form || e.form === form;

        if (formMatch && (sameEnd || sameEndYear)) {
          // For annual (FY), require fp=FY. For quarterly, require fp starts with Q.
          if (form === '10-K' && e.fp !== 'FY') continue;
          if (form === '10-Q' && !e.fp?.startsWith('Q')) continue;
          matches.push({ ...e, tag, unit });
        }
      }

      if (matches.length > 0) break; // Stop at first unit with any matches
    }

    if (matches.length > 0) {
      // Prefer exact end-date match over same-year match
      matches.sort((a, b) => {
        const aExact = a.end === periodEnd ? 1 : 0;
        const bExact = b.end === periodEnd ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        // Then by latest filing date
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

/**
 * Build a metric row across multiple periods.
 * Each value is { value, source: { tag, unit, accession, filed, end } }
 */
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
// Formatting helpers
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

export function periodLabel(period) {
  if (period.fp === 'FY') return `FY${String(period.fy).slice(-2)}`;
  return `${period.fp} ${String(period.fy).slice(-2)}`;
}

/**
 * Build the SEC URL for verifying a specific metric value.
 * If we have a source tag, link to the companyconcept endpoint. Otherwise the accession.
 */
export function buildSourceUrl(cik, source) {
  if (!source) return null;
  const paddedCik = String(cik).padStart(10, '0');
  if (source.tag) {
    return `https://data.sec.gov/api/xbrl/companyconcept/CIK${paddedCik}/us-gaap/${source.tag}.json`;
  }
  if (source.accession) {
    const clean = source.accession.replace(/-/g, '');
    return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=&dateb=&owner=include&count=40`;
  }
  return null;
}
