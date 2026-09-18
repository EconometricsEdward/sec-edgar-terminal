// Financial-risk presentation derived only from dated, source-linked SEC rows.
// No thresholds, forecasts, contractual DSCR, or regulatory ratings are inferred.
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const FLOW_KEYS = new Set(['netIncome', 'operatingCashFlow', 'operatingIncome', 'interestExpense', 'capitalExpenditure', 'dividendsPaid', 'cashInterestPaid', 'revenue', 'provision', 'netInterestIncome', 'noninterestIncome', 'noninterestExpense']);
const KEYS = ['cash', 'currentMarketableSecurities', 'noncurrentMarketableSecurities', 'currentDebt', 'noncurrentDebt', 'totalDebt', 'currentAssets', 'currentLiabilities', 'totalAssets', 'totalLiabilities', 'equity', 'consolidatedEquity', ...FLOW_KEYS,
  'loans', 'grossLoans', 'deposits', 'allowance', 'nonaccrualLoans', 'htmCarrying', 'htmFairValue', 'noninterestDeposits', 'brokerReceivables', 'brokerPayables', 'customerReceivables', 'customerPayables', 'securitiesBorrowed', 'securitiesLoaned', 'repos', 'reverseRepos', 'financialInstrumentsOwned', 'segregatedAssets'];
const periodLabel = (period) => period?.fp === 'FY' || period?.kind === 'annual' ? `FY ${period.fy}` : `${period.fp || ''} ${period.fy || ''}`.trim();
const uniqSources = (points) => {
  const map = new Map();
  for (const point of points) for (const source of point?.sources || []) map.set([source.taxonomy, source.tag, source.start, source.end, source.accession, source.value].join(':'), source);
  return [...map.values()];
};
const divide = (n, d) => d > 0 ? n / d : null;

export function buildRiskFundingPresentation(profile = {}, { sic } = {}) {
  const code = Number(sic);
  const industry = profile.industry || {};
  const lens = industry.isBank ? 'bank' : industry.isBrokerDealer || code === 6211 || code === 6221 ? 'broker'
    : industry.isInsurer ? 'insurance' : industry.isFinancial ? 'financial' : 'corporate';
  const periods = [...(profile.periods || [])].sort((a, b) => String(a.end).localeCompare(String(b.end)));
  const latestEnd = profile.periods?.[0]?.end || null;
  const sourceRows = { ...(profile.reportedBalances || {}), ...(profile.reportedFlows || {}) };
  const indexed = new Map(Object.entries(sourceRows).map(([key, rows]) => [key, new Map(rows.map((point) => [point.end, point]))]));
  const at = (key, end) => indexed.get(key)?.get(end);
  const validInputs = (keys, end) => {
    const points = keys.map((key) => at(key, end));
    if (points.some((point) => !finite(point?.value) || point.end !== end)) return null;
    const flows = points.filter((_, index) => FLOW_KEYS.has(keys[index]));
    // Ratios can compare a flow with an ending balance, but two flows must
    // cover exactly the same interval. Quarter/YTD/annual mixing is rejected.
    if (flows.some((point) => !point.start || point.start !== flows[0].start)) return null;
    return points;
  };
  const calculatedSeries = (keys, fn, formula) => periods.map((period) => {
    const points = validInputs(keys, period.end);
    const value = points ? fn(...points.map((point) => point.value)) : null;
    return { end: period.end, label: periodLabel(period), value: finite(value) ? value : null,
      start: points?.find((_, index) => FLOW_KEYS.has(keys[index]))?.start || null,
      sources: points ? uniqSources(points) : [], formula };
  });
  const fromSeries = (id, label, series, format, formula, note = '', metricId = null) => {
    const latest = series.find((point) => point.end === latestEnd);
    const index = series.findIndex((point) => point.end === latestEnd);
    const candidate = index > 0 ? series[index - 1] : null;
    const days = candidate && latest ? (Date.parse(latest.end) - Date.parse(candidate.end)) / 86400000 : null;
    const consecutive = profile.basis === 'annual' ? days >= 300 && days <= 400 : days >= 60 && days <= 120;
    const prior = consecutive && finite(candidate?.value) ? candidate.value : null;
    const value = finite(latest?.value) ? latest.value : null;
    return { id, label, format, value, prior, delta: value != null && prior != null ? value - prior : null,
      end: latestEnd, formula: latest?.formula || formula, sources: latest?.sources || [], series, note, metricId,
      gap: value == null ? 'Compatible reported inputs are unavailable for this date and reporting basis.' : null };
  };
  const calc = (id, label, keys, fn, format, formula, note = '') => fromSeries(id, label, calculatedSeries(keys, fn, formula), format, formula, note);
  const existing = (id) => {
    const metric = profile.metrics?.find((item) => item.id === id);
    if (!metric) return fromSeries(id, id.replaceAll('_', ' '), [], 'pct', 'Required reported inputs', '', id);
    return fromSeries(id, metric.label, (metric.series || []).map((point) => ({ ...point, label: periodLabel(point) })), metric.format, metric.formula, metric.why, id);
  };
  const balance = (key, label, note = '') => fromSeries(key, label, periods.map((period) => {
    const point = at(key, period.end);
    return { ...point, end: period.end, label: periodLabel(period), value: finite(point?.value) ? point.value : null, sources: point?.sources || [], formula: point?.formula || 'Reported SEC balance' };
  }), 'usd', 'Reported SEC balance', note);

  const freeCashFlow = calculatedSeries(['operatingCashFlow', 'capitalExpenditure'], (cash, capex) => capex >= 0 ? cash - capex : null, 'Operating cash flow − cash capital expenditure');
  const cashAfterDividends = calculatedSeries(['operatingCashFlow', 'capitalExpenditure', 'dividendsPaid'], (cash, capex, dividends) => capex >= 0 && dividends >= 0 ? cash - capex - dividends : null, 'Operating cash flow − cash capital expenditure − cash dividends');
  const history = periods.map((period) => ({
    end: period.end, label: periodLabel(period),
    ...Object.fromEntries(KEYS.map((key) => [key, finite(at(key, period.end)?.value) ? at(key, period.end).value : null])),
    freeCashFlow: freeCashFlow.find((point) => point.end === period.end)?.value ?? null,
    cashAfterDividends: cashAfterDividends.find((point) => point.end === period.end)?.value ?? null,
    creditLossProvision: finite(at('provision', period.end)?.value) ? at('provision', period.end).value : null,
  }));
  const liquidityRatios = [
    calc('cash_current_debt', 'Cash / current debt', ['cash', 'currentDebt'], divide, 'x', 'Cash and equivalents / current debt', 'Ending cash compared with debt classified as current. Cash restrictions and refinancing availability are separate.'),
    calc('liquid_current_debt', 'Cash + current securities / current debt', ['cash', 'currentMarketableSecurities', 'currentDebt'], (cash, securities, debt) => divide(cash + securities, debt), 'x', '(Cash + current marketable securities) / current debt', 'Current securities are included at their reported value without liquidity haircuts. Noncurrent securities are excluded.'),
    calc('current_debt_share', 'Current debt / total debt', ['currentDebt', 'totalDebt'], divide, 'pct', 'Current debt / total debt', 'Current balance-sheet classification is not a contractual maturity ladder.'),
    existing('current_ratio'),
  ];
  const obligationsRatios = [existing('interest_coverage'), existing('ocf_to_debt'),
    calc('fcf_to_debt', 'Cash after capex / debt', ['operatingCashFlow', 'capitalExpenditure', 'totalDebt'], (cash, capex, debt) => capex >= 0 ? divide(cash - capex, debt) : null, 'pct', '(Operating cash flow − cash capital expenditure) / total debt', 'Historical cash generation after reported PP&E purchases, before acquisitions, dividends, buybacks and debt principal. Not a forecast or covenant calculation.'),
    calc('fcf_to_current_debt', 'Cash after capex / current debt', ['operatingCashFlow', 'capitalExpenditure', 'currentDebt'], (cash, capex, debt) => capex >= 0 ? divide(cash - capex, debt) : null, 'x', '(Operating cash flow − cash capital expenditure) / current debt', 'Annual or TTM cash flow compared with ending current debt. It does not match scheduled future principal, interest and other commitments and is not debt-service coverage.'),
  ];
  const latestPoint = (series) => series.find((point) => point.end === latestEnd);
  const waterfall = [
    { id: 'operatingCashFlow', label: 'Operating cash flow', kind: 'total', value: at('operatingCashFlow', latestEnd)?.value ?? null, sources: at('operatingCashFlow', latestEnd)?.sources || [] },
    { id: 'capitalExpenditure', label: 'Cash capital expenditure', kind: 'outflow', value: at('capitalExpenditure', latestEnd)?.value ?? null, sources: at('capitalExpenditure', latestEnd)?.sources || [] },
    { id: 'freeCashFlow', label: 'Cash after capex', kind: 'total', value: latestPoint(freeCashFlow)?.value ?? null, sources: latestPoint(freeCashFlow)?.sources || [] },
    { id: 'dividendsPaid', label: 'Cash dividends', kind: 'outflow', value: at('dividendsPaid', latestEnd)?.value ?? null, sources: at('dividendsPaid', latestEnd)?.sources || [] },
    { id: 'cashAfterDividends', label: 'Cash after capex and dividends', kind: 'total', value: latestPoint(cashAfterDividends)?.value ?? null, sources: latestPoint(cashAfterDividends)?.sources || [] },
  ];

  const bankRatios = lens === 'bank' ? [existing('bank_equity_assets'), existing('npl_ratio'), existing('reserve_coverage'), existing('bank_allowance_nonaccrual'), existing('bank_earnings_assets'), existing('loans_deposits'), existing('bank_cash_deposits'), existing('bank_htm_gap_equity'),
    calc('bank_preprovision_credit_cost', 'Pre-provision earnings / credit provision', ['netInterestIncome', 'noninterestIncome', 'noninterestExpense', 'provision'], (interest, fees, expense, provision) => divide(interest + fees - expense, provision), 'x', '(Net interest income + noninterest income − noninterest expense) / credit-loss provision', 'Historical earnings before credit provision and tax versus the reported credit-loss provision. The provision may cover loans and other credit exposures. This is not forecast loss absorption.'),
  ] : [];
  const bankMetric = (...ids) => ids.map((id) => bankRatios.find((ratio) => ratio.id === id) || existing(id));
  const bank = lens === 'bank' ? { ratios: bankRatios, dimensions: [
    { letter: 'C', label: 'Capital', description: 'Accounting capital supporting the asset base.', metrics: bankMetric('bank_equity_assets'), gap: 'CET1, risk-weighted assets and subsidiary capital require their regulatory disclosures.' },
    { letter: 'A', label: 'Asset quality', description: 'Problem loans, reserves and the earnings cost of credit.', metrics: bankMetric('npl_ratio', 'reserve_coverage', 'bank_allowance_nonaccrual'), gap: 'Consolidated facts do not replace loan-vintage, delinquency, collateral or concentration tables.' },
    { letter: 'M', label: 'Management & controls', description: 'Read disclosed controls, governance and risk limits.', metrics: [], gap: 'A management assessment cannot be inferred from financial ratios. No management score is assigned.' },
    { letter: 'E', label: 'Earnings', description: 'Earnings capacity to absorb credit costs and retain capital.', metrics: bankMetric('bank_earnings_assets', 'bank_preprovision_credit_cost'), gap: null },
    { letter: 'L', label: 'Liquidity', description: 'Loan funding and cash against deposit obligations.', metrics: bankMetric('loans_deposits', 'bank_cash_deposits'), gap: 'Deposit insurance, concentrations, encumbrances and contingent borrowing capacity are separate.' },
    { letter: 'S', label: 'Sensitivity to market risk', description: 'Securities valuation sensitivity relative to book capital.', metrics: bankMetric('bank_htm_gap_equity'), gap: 'Repricing gaps, deposit assumptions and hedges require the interest-rate-risk note.' },
  ] } : null;
  const brokerIds = ['broker_receivables_assets', 'broker_clearing_assets', 'broker_securities_borrowed_assets', 'broker_financial_instruments_assets', 'broker_repos_assets', 'broker_cash_liabilities', 'broker_equity_assets'];
  const broker = lens === 'broker' ? { ratios: brokerIds.map(existing), balances: [
    balance('cash', 'Cash and equivalents', 'Separately segregated customer assets are excluded.'),
    balance('customerReceivables', 'Customer receivables'), balance('customerPayables', 'Customer payables'),
    balance('brokerReceivables', 'Broker and clearing receivables'), balance('brokerPayables', 'Broker and clearing payables'),
    balance('securitiesBorrowed', 'Securities borrowed'), balance('securitiesLoaned', 'Securities loaned'),
    balance('reverseRepos', 'Reverse repurchase agreements'), balance('repos', 'Repurchase agreements'),
    balance('financialInstrumentsOwned', 'Financial instruments owned, fair value'),
    balance('segregatedAssets', 'Segregated cash and securities', 'Customer-protection assets are not treated as freely available liquidity.'),
  ] } : null;
  const limitations = [
    'Missing facts remain unavailable. Flows use the selected annual or TTM basis; balance-sheet amounts use each corresponding period end.',
    lens === 'corporate' ? 'Cash after capex uses reported cash PP&E purchases. Dividends are distributions, not scheduled debt service. Lease payments may already be included in operating cash flow; they are not deducted again.'
      : 'Financial-company cash flows can be dominated by loans, securities, customer balances and funding movements. Industrial free-cash-flow debt coverage is not applied.',
    ...(lens === 'bank' ? ['CAMELS is used as a public-data organizing framework. These indicators are not supervisory ratings, and the management component has no inferred numerical score.'] : []),
    ...(lens === 'broker' ? ['Broker asset balances are shown separately without assumed netting or collateral haircuts. Consolidated book equity is not regulatory net capital; segregated customer assets are not available for general creditors.'] : []),
    at('cashInterestPaid', latestEnd)?.sources?.some((source) => source.tag === 'InterestPaidNet')
      ? 'Reported cash interest is net of capitalized interest. It is separate from interest expense and is not subtracted again from operating cash flow.'
      : 'Cash interest paid and accrual interest expense measure different things. Neither is substituted for the other.',
  ];
  return { lens, history, liquidity: { series: history, ratios: lens === 'bank' ? bankMetric('loans_deposits', 'bank_cash_deposits') : lens === 'broker' ? broker.ratios.filter((ratio) => ['broker_cash_liabilities', 'broker_equity_assets'].includes(ratio.id)) : liquidityRatios },
    obligations: { series: history, ratios: lens === 'corporate' ? obligationsRatios : lens === 'bank' ? bankMetric('bank_earnings_assets', 'bank_preprovision_credit_cost') : [existing('net_margin')], waterfall }, bank, broker, limitations };
}
