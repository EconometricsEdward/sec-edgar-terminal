import { classifyIndustry, INDUSTRY_GROUPS } from './industry.js';

// ============================================================================
// Tag priorities — default + industry overrides
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

  // Industry-specific concepts
  interestIncome: ['InterestAndDividendIncomeOperating', 'InterestIncomeOperating', 'InterestIncome'],
  interestIncomeExpenseNet: ['InterestIncomeExpenseNet'],
  netInterestIncome: ['InterestIncomeExpenseAfterProvisionForLoanLoss', 'InterestIncomeExpenseNet'],
  noninterestIncome: ['NoninterestIncome'],
  noninterestExpense: ['NoninterestExpense'],
  provisionForLoanLoss: [
    'ProvisionForLoanLeaseAndOtherLosses',
    'ProvisionForLoanAndLeaseLosses',
    'ProvisionForCreditLosses',
  ],
  allowanceForLoanLoss: [
    'LoansAndLeasesReceivableAllowance',
    'FinancingReceivableAllowanceForCreditLossesExcludingAccruedInterest',
    'AllowanceForLoanAndLeaseLosses',
  ],
  loans: ['LoansAndLeasesReceivableNetReportedAmount', 'FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss', 'NotesReceivableNet'],
  deposits: ['Deposits'],
  nonperformingLoans: [
    'FinancingReceivableRecordedInvestmentNonaccrualStatus',
    'FinancingReceivableNonaccrualAmount',
  ],
  earningAssets: ['InterestEarningAssets'],
  premiumsEarned: ['PremiumsEarnedNet'],
  lossesIncurred: [
    'PolicyholderBenefitsAndClaimsIncurredNet',
    'IncurredClaimsPropertyCasualtyInsurance',
    'LiabilityForClaimsAndClaimsAdjustmentExpense',
  ],
  underwritingExpenses: ['InsuranceCommissionsAndFees'],
  investmentIncome: ['NetInvestmentIncome'],
};

const INDUSTRY_TAG_OVERRIDES = {
  [INDUSTRY_GROUPS.BANKING]: {
    revenue: ['Revenues', 'InterestAndDividendIncomeOperating', 'InterestIncomeOperating'],
    cash: ['CashAndDueFromBanks', 'Cash', 'CashAndCashEquivalentsAtCarryingValue'],
    costOfRevenue: [],
    grossProfit: [],
    rnd: [],
    currentAssets: [],
    currentLiabilities: [],
    inventory: [],
  },
  [INDUSTRY_GROUPS.INSURANCE]: {
    revenue: ['Revenues', 'PremiumsEarnedNet'],
    costOfRevenue: [],
    grossProfit: [],
    inventory: [],
  },
};

function getTags(metricKey, group) {
  const override = INDUSTRY_TAG_OVERRIDES[group]?.[metricKey];
  if (override !== undefined) return override;
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

export function buildMetricRow(facts, metricKey, label, periods, format = 'currency', industryOrSic = null) {
  const group = typeof industryOrSic === 'string' && Object.values(INDUSTRY_GROUPS).includes(industryOrSic)
    ? industryOrSic
    : classifyIndustry(industryOrSic);

  const tags = getTags(metricKey, group);
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
  const g = classifyIndustry(sicCode);
  return [
    buildMetricRow(facts, 'revenue', 'Revenue', periods, 'currency', g),
    buildMetricRow(facts, 'costOfRevenue', 'Cost of Revenue', periods, 'currency', g),
    buildMetricRow(facts, 'grossProfit', 'Gross Profit', periods, 'currency', g),
    buildMetricRow(facts, 'rnd', 'R&D Expense', periods, 'currency', g),
    buildMetricRow(facts, 'sga', 'SG&A Expense', periods, 'currency', g),
    buildMetricRow(facts, 'operatingIncome', 'Operating Income', periods, 'currency', g),
    buildMetricRow(facts, 'interestExpense', 'Interest Expense', periods, 'currency', g),
    buildMetricRow(facts, 'pretaxIncome', 'Pre-tax Income', periods, 'currency', g),
    buildMetricRow(facts, 'incomeTax', 'Income Tax', periods, 'currency', g),
    buildMetricRow(facts, 'netIncome', 'Net Income', periods, 'currency', g),
    buildMetricRow(facts, 'epsBasic', 'EPS (Basic)', periods, 'eps', g),
    buildMetricRow(facts, 'epsDiluted', 'EPS (Diluted)', periods, 'eps', g),
    buildMetricRow(facts, 'sharesDiluted', 'Diluted Shares', periods, 'shares', g),
  ];
}

export function buildBalanceSheet(facts, periods, sicCode = null) {
  const g = classifyIndustry(sicCode);
  return [
    buildMetricRow(facts, 'cash', 'Cash & Equivalents', periods, 'currency', g),
    buildMetricRow(facts, 'shortTermInvestments', 'Short-term Investments', periods, 'currency', g),
    buildMetricRow(facts, 'receivables', 'Accounts Receivable', periods, 'currency', g),
    buildMetricRow(facts, 'inventory', 'Inventory', periods, 'currency', g),
    buildMetricRow(facts, 'currentAssets', 'Total Current Assets', periods, 'currency', g),
    buildMetricRow(facts, 'ppe', 'Property, Plant & Equipment', periods, 'currency', g),
    buildMetricRow(facts, 'goodwill', 'Goodwill', periods, 'currency', g),
    buildMetricRow(facts, 'intangibles', 'Intangible Assets', periods, 'currency', g),
    buildMetricRow(facts, 'totalAssets', 'Total Assets', periods, 'currency', g),
    buildMetricRow(facts, 'accountsPayable', 'Accounts Payable', periods, 'currency', g),
    buildMetricRow(facts, 'shortTermDebt', 'Short-term Debt', periods, 'currency', g),
    buildMetricRow(facts, 'currentLiabilities', 'Total Current Liabilities', periods, 'currency', g),
    buildMetricRow(facts, 'longTermDebt', 'Long-term Debt', periods, 'currency', g),
    buildMetricRow(facts, 'totalLiabilities', 'Total Liabilities', periods, 'currency', g),
    buildMetricRow(facts, 'retainedEarnings', 'Retained Earnings', periods, 'currency', g),
    buildMetricRow(facts, 'stockholdersEquity', "Stockholders' Equity", periods, 'currency', g),
  ];
}

export function buildCashFlow(facts, periods, sicCode = null) {
  const g = classifyIndustry(sicCode);
  return [
    buildMetricRow(facts, 'operatingCashFlow', 'Operating Cash Flow', periods, 'currency', g),
    buildMetricRow(facts, 'investingCashFlow', 'Investing Cash Flow', periods, 'currency', g),
    buildMetricRow(facts, 'financingCashFlow', 'Financing Cash Flow', periods, 'currency', g),
    buildMetricRow(facts, 'capex', 'Capital Expenditures', periods, 'currency', g),
    buildMetricRow(facts, 'dividendsPaid', 'Dividends Paid', periods, 'currency', g),
    buildMetricRow(facts, 'stockRepurchased', 'Stock Repurchased', periods, 'currency', g),
    buildMetricRow(facts, 'debtIssued', 'Debt Issued', periods, 'currency', g),
    buildMetricRow(facts, 'debtRepaid', 'Debt Repaid', periods, 'currency', g),
  ];
}

// ============================================================================
// Industry-specific ratios
// ============================================================================

export function buildRatios(facts, periods, sicCode = null) {
  const g = classifyIndustry(sicCode);
  const getVal = (key, p) => {
    const row = buildMetricRow(facts, key, '', [p], key.startsWith('eps') ? 'eps' : 'currency', g);
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

  const margins = {
    gross: ratio('Gross Margin', (p) => {
      const rev = getVal('revenue', p);
      let gp = getVal('grossProfit', p);
      if (gp == null) {
        const cost = getVal('costOfRevenue', p);
        if (rev != null && cost != null) gp = rev - cost;
      }
      return rev && gp != null ? (gp / rev) * 100 : null;
    }),
    operating: ratio('Operating Margin', (p) => {
      const rev = getVal('revenue', p);
      const op = getVal('operatingIncome', p);
      return rev && op != null ? (op / rev) * 100 : null;
    }),
    net: ratio('Net Margin', (p) => {
      const rev = getVal('revenue', p);
      const ni = getVal('netIncome', p);
      return rev && ni != null ? (ni / rev) * 100 : null;
    }),
  };
  const returns = {
    roe: ratio('Return on Equity (ROE)', (p) => {
      const eq = getVal('stockholdersEquity', p);
      const ni = getVal('netIncome', p);
      return eq && ni != null ? (ni / eq) * 100 : null;
    }),
    roa: ratio('Return on Assets (ROA)', (p) => {
      const ta = getVal('totalAssets', p);
      const ni = getVal('netIncome', p);
      return ta && ni != null ? (ni / ta) * 100 : null;
    }),
  };
  const leverage = {
    de: ratio('Debt-to-Equity', (p) => {
      const eq = getVal('stockholdersEquity', p);
      const std = getVal('shortTermDebt', p) || 0;
      const ltd = getVal('longTermDebt', p) || 0;
      return eq ? (std + ltd) / eq : null;
    }, 'decimal'),
    da: ratio('Debt-to-Assets', (p) => {
      const ta = getVal('totalAssets', p);
      const std = getVal('shortTermDebt', p) || 0;
      const ltd = getVal('longTermDebt', p) || 0;
      return ta ? (std + ltd) / ta : null;
    }, 'decimal'),
  };
  const liquidity = {
    cr: ratio('Current Ratio', (p) => {
      const ca = getVal('currentAssets', p);
      const cl = getVal('currentLiabilities', p);
      return ca && cl ? ca / cl : null;
    }, 'decimal'),
  };

  if (g === INDUSTRY_GROUPS.BANKING) {
    return [
      margins.net, returns.roe, returns.roa,
      ratio('Net Interest Margin (NIM)', (p) => {
        const nii = getVal('netInterestIncome', p) ?? getVal('interestIncomeExpenseNet', p);
        const earning = getVal('earningAssets', p) ?? getVal('totalAssets', p);
        return nii && earning ? (nii / earning) * 100 : null;
      }),
      ratio('Efficiency Ratio', (p) => {
        const nie = getVal('noninterestExpense', p);
        const nii = getVal('netInterestIncome', p) ?? getVal('interestIncomeExpenseNet', p);
        const noni = getVal('noninterestIncome', p);
        const revenue = (nii || 0) + (noni || 0);
        return nie && revenue ? (nie / revenue) * 100 : null;
      }),
      ratio('Loan-to-Deposit Ratio', (p) => {
        const loans = getVal('loans', p);
        const deposits = getVal('deposits', p);
        return loans && deposits ? (loans / deposits) * 100 : null;
      }),
      ratio('NPL Ratio', (p) => {
        const npl = getVal('nonperformingLoans', p);
        const loans = getVal('loans', p);
        return npl && loans ? (npl / loans) * 100 : null;
      }),
      ratio('Allowance Coverage Ratio', (p) => {
        const all = getVal('allowanceForLoanLoss', p);
        const loans = getVal('loans', p);
        return all && loans ? (all / loans) * 100 : null;
      }),
      ratio('Equity-to-Assets', (p) => {
        const eq = getVal('stockholdersEquity', p);
        const ta = getVal('totalAssets', p);
        return eq && ta ? (eq / ta) * 100 : null;
      }),
    ];
  }

  if (g === INDUSTRY_GROUPS.INSURANCE) {
    return [
      margins.net, returns.roe, returns.roa,
      ratio('Loss Ratio', (p) => {
        const losses = getVal('lossesIncurred', p);
        const premiums = getVal('premiumsEarned', p);
        return losses && premiums ? (losses / premiums) * 100 : null;
      }),
      ratio('Expense Ratio', (p) => {
        const ue = getVal('underwritingExpenses', p);
        const premiums = getVal('premiumsEarned', p);
        return ue && premiums ? (ue / premiums) * 100 : null;
      }),
      ratio('Combined Ratio', (p) => {
        const losses = getVal('lossesIncurred', p);
        const ue = getVal('underwritingExpenses', p);
        const premiums = getVal('premiumsEarned', p);
        if (!premiums) return null;
        const num = (losses || 0) + (ue || 0);
        return num > 0 ? (num / premiums) * 100 : null;
      }),
      ratio('Investment Yield', (p) => {
        const ii = getVal('investmentIncome', p);
        const inv = getVal('shortTermInvestments', p) ?? getVal('totalAssets', p);
        return ii && inv ? (ii / inv) * 100 : null;
      }),
      leverage.de,
    ];
  }

  if (g === INDUSTRY_GROUPS.TECH) {
    return [
      margins.gross, margins.operating, margins.net, returns.roe, returns.roa,
      ratio('R&D Intensity', (p) => {
        const rnd = getVal('rnd', p);
        const rev = getVal('revenue', p);
        return rnd && rev ? (rnd / rev) * 100 : null;
      }),
      ratio('FCF Margin', (p) => {
        const ocf = getVal('operatingCashFlow', p);
        const capex = getVal('capex', p) || 0;
        const rev = getVal('revenue', p);
        if (!ocf || !rev) return null;
        return ((ocf - capex) / rev) * 100;
      }),
      ratio('Rule of 40', (p) => {
        const curRev = getVal('revenue', p);
        const priorYearEnd = incrementYear(p.end, -1);
        const priorYearPeriod = { fy: p.fy - 1, fp: 'FY', end: priorYearEnd };
        const priorRev = getVal('revenue', priorYearPeriod);
        if (!curRev || !priorRev || priorRev <= 0) return null;
        const growth = ((curRev - priorRev) / priorRev) * 100;
        const ocf = getVal('operatingCashFlow', p);
        const capex = getVal('capex', p) || 0;
        const fcf = ocf != null ? ocf - capex : null;
        const fcfMargin = fcf != null ? (fcf / curRev) * 100 : null;
        return fcfMargin != null ? growth + fcfMargin : null;
      }),
      liquidity.cr, leverage.de,
    ];
  }

  if (g === INDUSTRY_GROUPS.RETAIL) {
    return [
      margins.gross, margins.operating, margins.net, returns.roe, returns.roa,
      ratio('Inventory Turnover', (p) => {
        const cogs = getVal('costOfRevenue', p);
        const inv = getVal('inventory', p);
        return cogs && inv ? cogs / inv : null;
      }, 'decimal'),
      ratio('Days Inventory', (p) => {
        const cogs = getVal('costOfRevenue', p);
        const inv = getVal('inventory', p);
        return cogs && inv ? (inv / cogs) * 365 : null;
      }, 'decimal'),
      ratio('Asset Turnover', (p) => {
        const rev = getVal('revenue', p);
        const ta = getVal('totalAssets', p);
        return rev && ta ? rev / ta : null;
      }, 'decimal'),
      ratio('DSO (Days Sales Outstanding)', (p) => {
        const rev = getVal('revenue', p);
        const ar = getVal('receivables', p);
        return rev && ar ? (ar / rev) * 365 : null;
      }, 'decimal'),
      leverage.de,
    ];
  }

  if (g === INDUSTRY_GROUPS.PHARMA) {
    return [
      margins.gross, margins.net, returns.roe, returns.roa,
      ratio('R&D Intensity', (p) => {
        const rnd = getVal('rnd', p);
        const rev = getVal('revenue', p);
        return rnd && rev ? (rnd / rev) * 100 : null;
      }),
      ratio('Cash Runway (years)', (p) => {
        const cash = (getVal('cash', p) || 0) + (getVal('shortTermInvestments', p) || 0);
        const ocf = getVal('operatingCashFlow', p);
        if (!cash || !ocf || ocf >= 0) return null;
        return cash / Math.abs(ocf);
      }, 'decimal'),
      ratio('FCF Margin', (p) => {
        const ocf = getVal('operatingCashFlow', p);
        const capex = getVal('capex', p) || 0;
        const rev = getVal('revenue', p);
        if (!ocf || !rev) return null;
        return ((ocf - capex) / rev) * 100;
      }),
      leverage.de,
    ];
  }

  if (g === INDUSTRY_GROUPS.MANUFACTURING) {
    return [
      margins.gross, margins.operating, margins.net, returns.roe, returns.roa,
      ratio('Asset Turnover', (p) => {
        const rev = getVal('revenue', p);
        const ta = getVal('totalAssets', p);
        return rev && ta ? rev / ta : null;
      }, 'decimal'),
      ratio('Inventory Turnover', (p) => {
        const cogs = getVal('costOfRevenue', p);
        const inv = getVal('inventory', p);
        return cogs && inv ? cogs / inv : null;
      }, 'decimal'),
      liquidity.cr, leverage.de,
    ];
  }

  // General fallback
  return [margins.gross, margins.operating, margins.net, returns.roe, returns.roa, liquidity.cr, leverage.de, leverage.da];
}

function incrementYear(isoDate, delta) {
  if (!isoDate) return isoDate;
  const d = new Date(isoDate);
  d.setFullYear(d.getFullYear() + delta);
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// Growth + formatting (unchanged)
// ============================================================================

export function yoyGrowth(current, previous) {
  if (current == null || previous == null) return null;
  if (previous === 0) return null;
  if (previous < 0 && current < 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function cagr(startValue, endValue, years) {
  if (startValue == null || endValue == null || years <= 0) return null;
  if (startValue <= 0 || endValue <= 0) return null;
  return (Math.pow(endValue / startValue, 1 / years) - 1) * 100;
}

export function computeGrowth(row) {
  const values = row.values.filter((v) => v.value != null);
  if (values.length === 0) return { latest: null, prior: null, yoy: null, cagr5y: null, cagr10y: null };
  const latest = values[0].value;
  const prior = values[1]?.value ?? null;
  const yoy = prior != null ? yoyGrowth(latest, prior) : null;
  const fiveBack = values[5]?.value ?? null;
  const tenBack = values[10]?.value ?? null;
  const cagr5y = fiveBack != null ? cagr(fiveBack, latest, 5) : null;
  const cagr10y = tenBack != null ? cagr(tenBack, latest, 10) : null;
  return { latest, prior, yoy, cagr5y, cagr10y };
}

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
