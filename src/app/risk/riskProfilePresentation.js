import { formatRiskValue, riskPeriodLabel } from '../../utils/riskWorkspace.js';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const valueOf = (value) => finite(value) ? value : null;

const LENSES = {
  bank: { id: 'bank', label: 'Bank risk profile', description: 'Read loan quality, deposit funding, book capital, and earnings together.' },
  insurance: { id: 'insurance', label: 'Insurance risk profile', description: 'Connect claims experience and earnings with the capital supporting policyholder obligations.' },
  financial: { id: 'financial', label: 'Financial services risk profile', description: 'Start with balance-sheet structure, earnings, and the specific funding obligations of this business.' },
  corporate: { id: 'corporate', label: 'Company risk profile', description: 'Connect debt service, near-term liquidity, capital structure, and the cash behind earnings.' },
};

// These are analytical views, not ratings. The API carries the narrower SIC
// classification; the SIC fallback also protects already-open, older clients.
function lensFor(profile, sicCode) {
  const sic = Number.parseInt(sicCode, 10);
  if (finite(sic) && sic > 0) {
    if ((sic >= 6000 && sic <= 6089) || sic === 6712) return LENSES.bank;
    if (sic >= 6300 && sic <= 6399) return LENSES.insurance;
    if ((sic >= 6090 && sic <= 6299) || (sic >= 6400 && sic <= 6499) || (sic >= 6720 && sic <= 6739) || sic === 6799) return LENSES.financial;
    return LENSES.corporate;
  }
  if (profile.industry?.isBank) return LENSES.bank;
  if (profile.industry?.isInsurer || profile.industry?.group === 'insurance') return LENSES.insurance;
  if (profile.industry?.isFinancial) return LENSES.financial;
  return LENSES.corporate;
}

const DIMENSIONS = {
  corporate: [
    ['debt-service', 'Debt service', 'How well do earnings and cash generation cover borrowing obligations?', ['interest_coverage', 'ocf_to_debt', 'net_debt']],
    ['liquidity', 'Near-term liquidity', 'What supports obligations due within the next year?', ['current_ratio', 'quick_ratio', 'cash_to_assets']],
    ['capital', 'Capital structure', 'How much of the balance sheet is financed by liabilities?', ['liab_to_assets', 'debt_to_equity']],
    ['earnings', 'Earnings & cash', 'Are reported profits supported by operating cash flow?', ['net_margin', 'accruals_ratio', 'receivables_gap', 'loss_years']],
  ],
  bank: [
    ['credit', 'Loan quality', 'How are problem loans and credit-loss provisions changing?', ['npl_ratio', 'provision_rate', 'reserve_coverage']],
    ['funding', 'Deposit funding', 'How does the loan book compare with reported deposit funding?', ['loans_deposits', 'deposits_trend', 'bank_cash_assets', 'nib_deposit_share']],
    ['capital', 'Capital & securities', 'What book capital supports the asset base, and what valuation gaps are disclosed?', ['bank_equity_assets', 'htm_unrealized', 'liab_to_assets']],
    ['earnings', 'Earnings capacity', 'How consistently does the business generate reported profits?', ['net_margin', 'loss_years']],
  ],
  insurance: [
    ['underwriting', 'Claims experience', 'How much earned premium is absorbed by reported claims?', ['loss_ratio']],
    ['capital', 'Capital support', 'What book equity supports policyholder and other obligations?', ['ins_equity_assets', 'liab_to_assets']],
    ['liquidity', 'Reported liquidity', 'What cash is disclosed, and what further funding evidence is needed?', ['cash_to_assets', 'current_ratio']],
    ['earnings', 'Earnings capacity', 'How are consolidated earnings changing across reporting periods?', ['net_margin', 'loss_years']],
  ],
  financial: [
    ['capital', 'Capital structure', 'How are assets financed across creditors and shareholders?', ['liab_to_assets', 'debt_to_equity']],
    ['liquidity', 'Reported liquidity', 'What cash and near-term balances does this business disclose?', ['cash_to_assets', 'current_ratio', 'quick_ratio']],
    ['earnings', 'Earnings capacity', 'How consistently are consolidated earnings positive?', ['net_margin', 'loss_years']],
  ],
};

export function riskMetricComparison(metric, basis = 'annual') {
  const series = (metric?.series || []).map((point) => ({ ...point, value: valueOf(point.value), label: riskPeriodLabel(point) }));
  const current = valueOf(metric?.value);
  const prior = valueOf(metric?.prior);
  // Recompute the displayed difference from the two API observations. A missing
  // prior is not replaced by an older, non-adjacent point in the chart.
  const delta = current != null && prior != null ? current - prior : null;
  const priorValues = series.slice(0, -1).map((p) => p.value).filter(finite).sort((a, b) => a - b);
  const middle = Math.floor(priorValues.length / 2);
  const median = priorValues.length ? priorValues.length % 2 ? priorValues[middle] : (priorValues[middle - 1] + priorValues[middle]) / 2 : null;
  return {
    current, prior, delta,
    label: basis === 'ttm' ? 'vs prior quarter end' : 'vs prior fiscal year',
    priorLabel: basis === 'ttm' ? 'Prior quarter end' : 'Prior fiscal year',
    deltaFormat: ['pct', 'pp'].includes(metric?.format) ? 'pp' : metric?.format || 'usd',
    history: series,
    historical: { minimum: priorValues[0] ?? null, maximum: priorValues[priorValues.length - 1] ?? null, median, observations: priorValues.length, label: 'Earlier company observations' },
  };
}

function input(profile, key, metricIds, labels) {
  const history = profile.reportedFlows?.[key] || profile.reportedBalances?.[key];
  const reported = history?.find((point) => point.end === profile.periods?.[0]?.end);
  if (finite(reported?.value)) return { value: reported.value, label: labels[0], formula: reported.formula || 'Reported SEC fact', sources: reported.sources || [], metricId: metricIds[0] || null };
  const explicit = profile.stressInputs?.[key];
  if (finite(explicit?.value)) return { value: explicit.value, label: labels[0], formula: explicit.formula || 'Reported SEC fact', sources: explicit.sources || [], metricId: metricIds[0] || null };
  for (const id of metricIds) {
    const metric = profile.metrics?.find((item) => item.id === id);
    const found = metric?.inputs?.find((item) => labels.includes(item.label) && finite(item.value));
    if (found) return { value: found.value, label: found.label, formula: 'Input to ' + metric.label, sources: metric.sources || [], metricId: id };
  }
  return { value: null, label: labels[0], formula: 'Required input unavailable', sources: [], metricId: metricIds[0] || null };
}

function balancePresentation(profile, lens) {
  const assets = input(profile, 'totalAssets', ['liab_to_assets', 'bank_equity_assets', 'ins_equity_assets'], ['Total assets']);
  const liabilities = input(profile, 'totalLiabilities', ['liab_to_assets', 'debt_to_equity'], ['Total liabilities']);
  const equity = input(profile, 'equity', ['debt_to_equity', 'bank_equity_assets', 'ins_equity_assets'], ['Stockholders equity']);
  const cash = input(profile, 'cash', ['net_debt', 'cash_to_assets', 'bank_cash_assets'], ['Cash & equivalents', 'Tagged cash balance', 'Cash and equivalents', 'Cash excluding tagged restrictions', 'Narrow tagged cash balance']);
  const debt = input(profile, 'totalDebt', ['net_debt', 'ocf_to_debt'], ['Total debt']);
  const currentDebt = input(profile, 'currentDebt', [], ['Current debt']);
  const noncurrentDebt = input(profile, 'noncurrentDebt', [], ['Noncurrent debt']);
  const currentSecurities = input(profile, 'currentMarketableSecurities', [], ['Current marketable securities']);
  const noncurrentSecurities = input(profile, 'noncurrentMarketableSecurities', [], ['Noncurrent marketable securities']);
  const combine = (label, entries, formula, calculate) => ({
    label, value: entries.every((entry) => finite(entry.value)) ? calculate(entries.map((entry) => entry.value)) : null,
    formula, sources: entries.flatMap((entry) => entry.sources), metricId: null,
  });
  const cashAndMarketableSecurities = combine('Cash and marketable securities', [cash, currentSecurities, noncurrentSecurities],
    'Cash and cash equivalents + current marketable securities + noncurrent marketable securities', (values) => values.reduce((sum, value) => sum + value, 0));
  const netDebtAfterMarketableSecurities = combine('Debt less cash and marketable securities', [debt, cashAndMarketableSecurities],
    'Current and noncurrent debt − cash and cash equivalents − current and noncurrent marketable securities', ([borrowings, liquidAssets]) => borrowings - liquidAssets);
  const loans = input(profile, 'loans', ['loans_deposits'], ['Loans, net']);
  const deposits = input(profile, 'deposits', ['loans_deposits'], ['Deposits']);
  const notes = [];
  /** @type {{ id: string, label: string, value: number, share: number, sources: any[] }[]} */
  const segments = [];
  let reconciliation = null;
  // Never draw an apparently complete 100% stack from an inferred residual.
  // Parent equity can exclude noncontrolling or redeemable interests. Preserve
  // that difference as an explicitly labelled balance-sheet reconciliation.
  if (assets.value > 0 && liabilities.value >= 0 && liabilities.value != null && equity.value >= 0 && equity.value != null) {
    const remainder = assets.value - liabilities.value - equity.value;
    const tolerance = Math.max(1, assets.value * 0.000001);
    if (remainder >= -tolerance) {
      for (const { id, label, item } of [{ id: 'liabilities', label: 'Liabilities', item: liabilities }, { id: 'equity', label: 'Book equity', item: equity }]) segments.push({ id, label, value: item.value, share: item.value / assets.value, sources: item.sources });
      if (remainder > tolerance) {
        reconciliation = { value: remainder, label: 'Other interests / reconciliation', formula: 'Assets − liabilities − reported stockholders equity' };
        segments.push({ id: 'reconciliation', label: reconciliation.label, value: remainder, share: remainder / assets.value, sources: [...assets.sources, ...liabilities.sources, ...equity.sources] });
        notes.push('The remainder is a balance-sheet reconciliation, not inferred debt or equity; inspect the filing for noncontrolling or other interests.');
      }
    } else notes.push('Reported assets, liabilities, and equity do not reconcile into a positive composition. The original balances are shown without a percentage stack.');
  }
  if (equity.value != null && equity.value < 0) notes.push('Book equity is negative. A composition chart is not meaningful; review the equity note together with cash generation and debt service.');
  if (cash.value != null) notes.push(lens.id === 'bank' ? 'Tagged cash is only one liquidity source; securities, borrowing capacity, and deposit concentration require the funding note.' : 'Cash availability, restrictions, collateral, and committed facilities require the liquidity note.');
  if (lens.id === 'corporate') notes.push('Borrowings use a current-debt total or separately reported current maturities and short-term borrowings, plus noncurrent debt. Missing components are never assumed to be zero; leases and other obligations require separate review.');
  if (currentSecurities.value != null || noncurrentSecurities.value != null) notes.push('Marketable securities are separate from cash. Credit quality, price risk, maturities, taxes, and restrictions can affect their realizable value and availability.');
  if (lens.id === 'bank' || lens.id === 'insurance' || lens.id === 'financial') notes.push('Book equity is an accounting balance, not a regulatory capital ratio.');
  return { assets, liabilities, equity, cash, debt, currentDebt, noncurrentDebt, currentSecurities, noncurrentSecurities, cashAndMarketableSecurities, netDebtAfterMarketableSecurities, loans, deposits, segments, reconciliation, notes, comparisonLabel: lens.id === 'bank' ? 'Net loans and deposits' : 'Cash and reported borrowings' };
}

// Historical flows are recovered only from explicit calculation outputs or
// matching source facts. We never invert a ratio or add cumulative filings.
function flowAt(point, labels) {
  const calculation = [...(point?.calculations || [])].reverse().find((item) => labels.includes(item.label) && finite(item.value) && (!item.end || item.end === point.end));
  if (calculation) return calculation.value;
  const matching = (point?.sources || []).filter((source) => labels.includes(source.label) && finite(source.value) && source.end === point.end && source.start && (() => {
    const days = (Date.parse(source.end) - Date.parse(source.start)) / 86400000;
    return days >= 300 && days <= 385;
  })());
  const uniqueValues = [...new Set(matching.map((source) => source.value))];
  return uniqueValues.length === 1 ? uniqueValues[0] : null;
}

function earningsPresentation(profile) {
  const netIncome = input(profile, 'netIncome', ['net_margin', 'accruals_ratio'], ['Net income']);
  const operatingCashFlow = input(profile, 'operatingCashFlow', ['accruals_ratio', 'ocf_to_debt'], ['Operating cash flow']);
  const operatingIncome = input(profile, 'operatingIncome', ['interest_coverage'], ['Operating income']);
  const interestExpense = input(profile, 'interestExpense', ['interest_coverage'], ['Interest expense']);
  const revenue = input(profile, 'revenue', ['net_margin'], ['Revenue', 'Net revenue after interest expense', 'Reported lease revenue']);
  const periods = [...(profile.periods || [])].reverse();
  const findPoint = (ids, end) => ids.flatMap((id) => profile.metrics?.find((m) => m.id === id)?.series || []).filter((p) => p.end === end);
  const series = periods.map((period) => {
    const ni = Array.isArray(profile.reportedFlows?.netIncome) ? profile.reportedFlows.netIncome.find((point) => point.end === period.end)?.value
      : findPoint(['net_margin', 'accruals_ratio', 'loss_years'], period.end).map((p) => flowAt(p, ['Net income'])).find(finite);
    const ocf = Array.isArray(profile.reportedFlows?.operatingCashFlow) ? profile.reportedFlows.operatingCashFlow.find((point) => point.end === period.end)?.value
      : findPoint(['accruals_ratio', 'ocf_to_debt'], period.end).map((p) => flowAt(p, ['Operating cash flow'])).find(finite);
    const isLatest = period.end === profile.periods?.[0]?.end;
    return { end: period.end, label: riskPeriodLabel(period), netIncome: isLatest ? netIncome.value : ni ?? null, operatingCashFlow: isLatest ? operatingCashFlow.value : ocf ?? null };
  });
  return { netIncome, operatingCashFlow, operatingIncome, interestExpense, revenue, series };
}

function supportingObservations(metrics, balance, earnings, lens) {
  const observations = [];
  const add = (metric, text) => observations.push({ id: metric.id, metricId: metric.id, label: metric.label, value: metric.value, format: metric.format, text, reason: text, sources: metric.sources || [] });
  for (const metric of metrics) {
    const v = metric.value;
    if (!finite(v)) continue;
    const displayed = formatRiskValue(v, metric.format);
    if (metric.id === 'interest_coverage' && v >= 3) add(metric, `Operating income covers tagged interest expense ${displayed}. Check cash interest and refinancing terms alongside this coverage.`);
    if (metric.id === 'ocf_to_debt' && v >= 0.2) add(metric, `Operating cash flow equals ${displayed} of tagged debt for the selected reporting basis.`);
    if (metric.id === 'current_ratio' && v >= 1.2 && lens.id === 'corporate') add(metric, `Current assets cover current liabilities ${displayed}; asset quality and payment timing still matter.`);
    if (metric.id === 'net_debt' && v <= 0 && balance.cash.value != null && balance.debt.value != null) add(metric, `Tagged cash ${v === 0 ? 'equals tagged debt' : `exceeds tagged debt by ${formatRiskValue(-v)}`}. Cash restrictions and other obligations require separate review.`);
    if (metric.id === 'accruals_ratio' && v <= 0 && earnings.operatingCashFlow.value > 0 && earnings.netIncome.value >= 0) add(metric, 'Positive operating cash flow meets or exceeds reported net income for the selected period.');
    if (metric.id === 'net_margin' && v >= 0.1 && lens.id !== 'financial') add(metric, `Reported net income is ${displayed} of ${metric.revenueBasis === 'lease' ? 'reported lease revenue' : metric.revenueBasis === 'net-of-interest' ? 'net revenue after interest expense' : 'revenue'}; review recurring earnings and one-time items.`);
    if (metric.id === 'bank_equity_assets' && v >= 0.11) add(metric, `Book equity represents ${displayed} of total assets. Regulatory capital and risk-weighted assets are separate measures.`);
    if (metric.id === 'npl_ratio' && v >= 0 && v <= 0.005) add(metric, `Consolidated nonaccrual loans are ${displayed} of gross loans. Delinquencies and charge-offs add further credit-quality evidence.`);
    if (metric.id === 'loss_ratio' && v >= 0 && v <= 0.65) add(metric, `Claims consumed ${displayed} of earned premiums. Operating expenses and reserve development are outside this ratio.`);
  }
  if (!observations.length && earnings.netIncome.value > 0) observations.push({ id: 'positive-income', metricId: 'net_margin', label: 'Positive reported earnings', value: earnings.netIncome.value, format: 'usd', text: `Reported net income is ${formatRiskValue(earnings.netIncome.value)} for the selected period.`, reason: `Reported net income is ${formatRiskValue(earnings.netIncome.value)} for the selected period.`, sources: earnings.netIncome.sources });
  // Prefer distinct economic questions; do not inflate the list by repeating
  // correlated leverage screens or representing missing data as a strength.
  return observations.slice(0, 3);
}

export function buildRiskProfilePresentation(profile, company = {}) {
  const lens = lensFor(profile, company.sic);
  const metrics = (profile.metrics || []).map((metric) => ({ ...metric, value: valueOf(metric.value), format: metric.id === 'receivables_gap' ? 'pp' : metric.format }));
  const map = new Map(metrics.map((metric) => [metric.id, metric]));
  const dimensions = DIMENSIONS[lens.id].map(([id, label, question, metricIds]) => {
    const candidates = metricIds.map((key) => map.get(key)).filter(Boolean);
    const metric = candidates.find((candidate) => finite(candidate.value)) || candidates[0] || null;
    const comparison = riskMetricComparison(metric, profile.basis);
    return { id, label, question, metric, metrics: candidates, comparison, history: comparison.history };
  });
  const balance = balancePresentation(profile, lens);
  const earnings = earningsPresentation(profile);
  const allowed = new Set(DIMENSIONS[lens.id].flatMap((item) => item[3]));
  const watchItems = (profile.watchItems || []).filter((item) => allowed.has(item.id) && finite(map.get(item.id)?.value))
    .filter((item) => lens.id !== 'financial' || item.id === 'loss_years')
    .map((item) => ({ ...item, metricId: item.id, value: map.get(item.id).value, format: map.get(item.id).format, text: item.reason, sources: map.get(item.id).sources || [] }))
    .slice(0, 3);
  const strengths = supportingObservations(metrics.filter((metric) => allowed.has(metric.id)), balance, earnings, lens);
  const limitations = lens.id === 'bank'
    ? ['Consolidated company facts may omit uninsured deposits, asset concentrations, regulatory capital, and dimensional credit disclosures.']
    : lens.id === 'insurance' ? ['Loss ratios exclude operating expenses; statutory capital and reserve adequacy require additional disclosures.']
      : lens.id === 'financial' ? ['Collateral, netting, client balances, maturity mismatches, and regulatory capital require the business-specific notes. Industrial thresholds are not applied.']
        : ['Debt maturity schedules, covenants, off-balance-sheet obligations, and restricted liquidity require the source notes.'];
  if (profile.basis === 'ttm') limitations.push('TTM earnings windows overlap. Their changes compare with the previous quarter end, not an independent full year.');
  return {
    lens, dimensions, strengths, watchItems, balance, earnings,
    coverage: { available: dimensions.filter((d) => finite(d.metric?.value)).length, total: dimensions.length, availableMetrics: metrics.filter((m) => allowed.has(m.id) && finite(m.value)).length, totalMetrics: metrics.filter((m) => allowed.has(m.id)).length },
    historyLabel: profile.basis === 'ttm' ? 'Quarter-end observations · TTM earnings' : 'Annual reporting history',
    comparisonLabel: profile.basis === 'ttm' ? 'Prior quarter end' : 'Prior fiscal year',
    limitations,
  };
}

export function riskProfileBrief(data, profile) {
  const view = buildRiskProfilePresentation(profile, data);
  const lines = [`# ${data.ticker} — Company risk profile`, data.companyName, `Reporting end: ${profile.periods?.[0]?.end || 'Unavailable'}`, `Basis: ${profile.basis === 'ttm' ? 'Quarter-end balances and trailing-twelve-month earnings' : 'Annual'}`, `Retrieved: ${data.generatedAt || 'Unavailable'}`, `Lens: ${view.lens.label}`, '', '## Supporting observations', ...view.strengths.map((item) => `- ${item.text}`), '', '## Review priorities', ...view.watchItems.map((item) => `- ${item.label}: ${item.reason}. ${item.question || ''}`), '', '## Risk dimensions'];
  for (const dimension of view.dimensions) {
    lines.push('', `### ${dimension.label}`, dimension.question);
    for (const metric of dimension.metrics) {
      const comparison = riskMetricComparison(metric, profile.basis);
      lines.push(`- ${metric.label}: ${formatRiskValue(metric.value, metric.format)}${comparison.delta == null ? '' : ` (${formatRiskValue(comparison.delta, comparison.deltaFormat, true)} ${comparison.label})`}`, `  Formula: ${metric.formula || 'Reported SEC fact'}`, `  ${metric.why || ''}`);
      if (metric.thresholds) lines.push(`  Product screen thresholds: ${metric.thresholds}`);
      for (const source of metric.sources || []) lines.push(`  Source: ${source.label || source.tag}: ${source.value ?? 'Unavailable'} ${source.unit || ''}; ${source.start ? source.start + ' to ' : ''}${source.end || 'Undated'}; ${source.documentUrl || source.url || 'Source link unavailable'}`);
    }
  }
  lines.push('', '## Scope', 'These are reported financial observations and transparent screening conventions, not credit ratings or default probabilities.', ...view.limitations.map((item) => `- ${item}`));
  return lines.join('\n');
}
