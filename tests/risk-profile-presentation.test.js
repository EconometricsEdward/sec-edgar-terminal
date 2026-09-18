import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, classifyRiskIndustry } from '../src/utils/riskAnalysis.js';
import { decorateRiskProfile, formatRiskValue } from '../src/utils/riskWorkspace.js';
import { buildRiskProfilePresentation, riskMetricComparison, riskProfileBrief } from '../src/app/risk/riskProfilePresentation.js';

function companyFacts(overrides = {}) {
  const inputs = { Assets: [1000, 1100], Liabilities: [650, 700], StockholdersEquity: [350, 400], CashAndCashEquivalentsAtCarryingValue: [80, 100], AssetsCurrent: [300, 350], LiabilitiesCurrent: [200, 220], InventoryNet: [60, 70], LongTermDebtNoncurrent: [300, 320], DebtCurrent: [30, 40], Revenues: [500, 600], NetIncomeLoss: [50, 65], OperatingIncomeLoss: [90, 100], InterestExpense: [15, 20], NetCashProvidedByUsedInOperatingActivities: [75, 90], ...overrides };
  const flows = new Set(['Revenues', 'RevenuesNetOfInterestExpense', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'OperatingLeaseLeaseIncome', 'NetIncomeLoss', 'OperatingIncomeLoss', 'InterestExpense', 'NetCashProvidedByUsedInOperatingActivities', 'ProvisionForLoanLeaseAndOtherLosses', 'PremiumsEarnedNet', 'ClaimsAndBenefitsIncurredNet']);
  return { 'us-gaap': Object.fromEntries(Object.entries(inputs).filter(([,values]) => values != null).map(([tag, values]) => [tag, { units: { USD: values.map((val, index) => ({ val, fy: 2024 + index, fp: 'FY', form: '10-K', start: flows.has(tag) ? `${2024 + index}-01-01` : undefined, end: `${2024 + index}-12-31`, filed: `${2025 + index}-02-01`, accn: `0000000001-${24 + index}-000001` })) } }])) };
}
const profile = (values, sic = 3571) => decorateRiskProfile(assessRisk(companyFacts(values), sic, 1));

test('company profile connects exact reported debt, cash, earnings and balance-sheet amounts', () => {
  const p = profile();
  const view = buildRiskProfilePresentation(p, { sic: 3571 });
  assert.equal(view.lens.id, 'corporate');
  assert.equal(view.dimensions.length, 4);
  assert.equal(view.balance.assets.value, 1100);
  assert.equal(view.balance.liabilities.value, 700);
  assert.equal(view.balance.equity.value, 400);
  assert.equal(view.balance.debt.value, 360);
  assert.equal(view.balance.cash.value, 100);
  assert.equal(view.earnings.netIncome.value, 65);
  assert.equal(view.earnings.operatingCashFlow.value, 90);
  assert.deepEqual(view.earnings.series.map((item) => [item.netIncome, item.operatingCashFlow]), [[50, 75], [65, 90]]);
  assert.equal(view.balance.segments.reduce((total, item) => total + item.value, 0), 1100);
  assert.ok(view.strengths.every((item) => item.sources.length > 0));
});

test('missing debt components remain unavailable while reported cash stays visible', () => {
  const view = buildRiskProfilePresentation(profile({ DebtCurrent: null }));
  assert.equal(view.balance.debt.value, null);
  assert.equal(view.balance.cash.value, 100);
  assert.equal(view.dimensions[0].metric.id, 'interest_coverage');
  assert.ok(!view.strengths.some((item) => item.id === 'net_debt'));
});

test('reported zero debt is distinguishable from missing debt and supports an exact net-cash observation', () => {
  const view = buildRiskProfilePresentation(profile({ DebtCurrent: [0, 0], LongTermDebtNoncurrent: [0, 0] }));
  assert.equal(view.balance.debt.value, 0);
  assert.ok(view.strengths.some((item) => item.id === 'net_debt' && item.text.includes('$100.00')));
});

test('a missing newest input is never filled by an older historical amount', () => {
  const p = profile();
  p.stressInputs.cash.value = null;
  for (const metric of p.metrics) metric.inputs = metric.inputs.map((item) => /cash/i.test(item.label) ? { ...item, value: null } : item);
  const view = buildRiskProfilePresentation(p);
  assert.equal(view.balance.cash.value, null);
});

test('negative equity preserves original amounts without a misleading positive composition', () => {
  const view = buildRiskProfilePresentation(profile({ StockholdersEquity: [-50, -100], Liabilities: [1050, 1200] }));
  assert.equal(view.balance.equity.value, -100);
  assert.deepEqual(view.balance.segments, []);
  assert.ok(view.balance.notes.some((item) => item.includes('Book equity is negative')));
  assert.equal(view.dimensions[2].metrics.find((metric) => metric.id === 'debt_to_equity').value, -12);
});

test('noncontrolling or other interests are labelled as reconciliation, never silently assigned to equity', () => {
  const view = buildRiskProfilePresentation(profile({ StockholdersEquity: [300, 350] }));
  assert.equal(view.balance.reconciliation.value, 50);
  assert.equal(view.balance.segments.find((item) => item.id === 'equity').value, 350);
  assert.equal(view.balance.segments.find((item) => item.id === 'reconciliation').value, 50);
  assert.match(view.balance.reconciliation.formula, /reported stockholders equity/);
});

test('incompatible capital inputs do not create a fake 100 percent bar', () => {
  const view = buildRiskProfilePresentation(profile({ StockholdersEquity: [500, 500] }));
  assert.deepEqual(view.balance.segments, []);
  assert.ok(view.balance.notes.some((item) => item.includes('do not reconcile')));
});

test('negative operating cash flow cannot be presented as earnings support simply because accruals are negative', () => {
  const view = buildRiskProfilePresentation(profile({ NetIncomeLoss: [-50, -100], NetCashProvidedByUsedInOperatingActivities: [-25, -50] }));
  assert.ok(!view.strengths.some((item) => item.id === 'accruals_ratio'));
  assert.equal(view.earnings.netIncome.value, -100);
});

test('history keeps gaps and separates a missing adjacent comparison from earlier available observations', () => {
  const metric = { value: 0.12, prior: null, delta: 0.9, format: 'pct', series: [{ fy: 2023, end: '2023-12-31', value: 0.08 }, { fy: 2024, end: '2024-12-31', value: null }, { fy: 2025, end: '2025-12-31', value: 0.12 }] };
  const comparison = riskMetricComparison(metric);
  assert.equal(comparison.delta, null);
  assert.equal(comparison.history[1].value, null);
  assert.equal(comparison.historical.median, 0.08);
  assert.equal(comparison.historical.observations, 1);
});

test('TTM comparison is to the prior quarter, and rate differences use percentage points', () => {
  const result = riskMetricComparison({ value: 0.08, prior: 0.06, format: 'pct', series: [] }, 'ttm');
  assert.equal(result.label, 'vs prior quarter end');
  assert.equal(result.deltaFormat, 'pp');
  assert.equal(formatRiskValue(result.delta, result.deltaFormat, true), '+2.00 pp');
  const p = profile();
  p.basis = 'ttm';
  assert.ok(buildRiskProfilePresentation(p).limitations.some((item) => item.includes('overlap')));
});

test('historical TTM earnings use explicit derived outputs, not cumulative source facts', () => {
  const p = profile();
  delete p.reportedFlows;
  p.basis = 'ttm';
  p.periods = [{ fy: 2025, fp: 'Q3', kind: 'ttm', end: '2025-09-30' }, { fy: 2025, fp: 'Q2', kind: 'ttm', end: '2025-06-30' }];
  const margin = p.metrics.find((metric) => metric.id === 'net_margin');
  margin.series = [{ fy: 2025, fp: 'Q2', kind: 'ttm', end: '2025-06-30', value: 0.1, calculations: [{ label: 'Net income', end: '2025-06-30', value: 80 }], sources: [{ label: 'Net income', value: 40, start: '2025-01-01', end: '2025-06-30' }] }];
  assert.equal(buildRiskProfilePresentation(p).earnings.series[0].netIncome, 80);
  margin.series[0].calculations = [];
  assert.equal(buildRiskProfilePresentation(p).earnings.series[0].netIncome, null);
});

test('financial-company cash-flow histories remain available without industrial cash-conversion metrics', () => {
  for (const sic of [6021, 6311, 6211]) {
    const p = profile({}, sic);
    assert.ok(!p.metrics.some((item) => item.id === 'accruals_ratio'));
    const earnings = buildRiskProfilePresentation(p, { sic }).earnings;
    assert.equal(earnings.operatingCashFlow.value, 90);
    assert.deepEqual(earnings.series.map((point) => point.operatingCashFlow), [75, 90]);
    assert.equal(p.reportedFlows.operatingCashFlow[1].value, 90);
    assert.ok(p.reportedFlows.operatingCashFlow[1].sources.some((source) => source.value === 90 && source.documentUrl?.includes('/Archives/')));
  }
});

test('an absent current reported cash flow never falls back to an older financial-company observation', () => {
  const facts = companyFacts();
  facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD.pop();
  const p = decorateRiskProfile(assessRisk(facts, 6211, 1));
  const earnings = buildRiskProfilePresentation(p, { sic: 6211 }).earnings;
  assert.equal(earnings.operatingCashFlow.value, null);
  assert.deepEqual(earnings.series.map((point) => point.operatingCashFlow), [75, null]);
});

test('empty data shows missing dimensions and no invented support or overall score', () => {
  const view = buildRiskProfilePresentation({ metrics: [], periods: [], industry: {}, stressInputs: {}, watchItems: [] });
  assert.equal(view.coverage.available, 0);
  assert.ok(view.dimensions.every((item) => item.metric === null));
  assert.deepEqual(view.strengths, []);
  assert.deepEqual(view.watchItems, []);
  assert.equal('score' in view, false);
  assert.equal(view.balance.assets.value, null);
});

test('broker-dealers, lenders and agents receive financial-service context without industrial screens', () => {
  for (const sic of [6099, 6111, 6199, 6211, 6411, 6726, 6799]) {
    const p = profile({}, sic);
    assert.equal(p.industry.isFinancial, true, String(sic));
    assert.equal(p.industry.isBank, false, String(sic));
    assert.equal(p.industry.isInsurer, false, String(sic));
    assert.equal(p.zScore, null, String(sic));
    assert.ok(!p.metrics.some((metric) => ['loans_deposits', 'loss_ratio', 'interest_coverage'].includes(metric.id)), String(sic));
    assert.ok(p.metrics.filter((metric) => ['liab_to_assets', 'current_ratio', 'net_margin'].includes(metric.id)).every((metric) => metric.zone.level === 'info'), String(sic));
    assert.equal(buildRiskProfilePresentation(p, { sic }).lens.id, 'financial');
  }
  assert.equal(classifyRiskIndustry(6712).isBank, true);
  assert.equal(classifyRiskIndustry(6311).isInsurer, true);
  assert.equal(classifyRiskIndustry(6798).group, 'reit');
  assert.equal(classifyRiskIndustry(6531).group, 'general');
  assert.equal(classifyRiskIndustry(6719).group, 'general');
});

test('a negative tangible-capital denominator cannot produce a reassuring nonaccrual screen', () => {
  const inputs = { FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss: [500, 500], FinancingReceivableAllowanceForCreditLossExcludingAccruedInterest: [10, 10], FinancingReceivableRecordedInvestmentNonaccrualStatus: [20, 20], Goodwill: [400, 450], IntangibleAssetsNetExcludingGoodwill: [30, 30], Deposits: [700, 750] };
  const p = profile(inputs, 6021);
  const metric = p.metrics.find((item) => item.id === 'texas_ratio');
  assert.equal(metric.value, null);
  assert.equal(metric.zone.level, 'na');
  assert.ok(!p.watchItems.some((item) => item.id === 'texas_ratio'));
  assert.equal(buildRiskProfilePresentation(p).lens.id, 'bank');
  const positiveBuffer = profile({ ...inputs, Goodwill: [10, 10] }, 6021).metrics.find((item) => item.id === 'texas_ratio');
  assert.equal(positiveBuffer.value, 20 / (400 - 10 - 30 + 10));
});

test('nonpositive denominator makes ordinary ratios unavailable while negative earnings remain valid', () => {
  assert.equal(profile({ Revenues: [-100, -200] }).metrics.find((item) => item.id === 'net_margin').value, null);
  assert.equal(profile({ NetIncomeLoss: [-50, -60] }).metrics.find((item) => item.id === 'net_margin').value, -0.1);
});

test('broker margins use net revenue rather than a partial customer-fee line', () => {
  const p = profile({ Revenues: null, RevenueFromContractWithCustomerExcludingAssessedTax: [50, 60], RevenuesNetOfInterestExpense: [500, 600] }, 6211);
  const metric = p.metrics.find((item) => item.id === 'net_margin');
  assert.equal(metric.value, 65 / 600);
  assert.equal(metric.revenueBasis, 'net-of-interest');
  assert.equal(metric.label, 'Net income / net revenue');
  assert.equal(buildRiskProfilePresentation(p, { sic: 6211 }).earnings.revenue.value, 600);
  assert.ok(metric.sources.some((source) => source.tag === 'RevenuesNetOfInterestExpense'));
  assert.ok(!metric.sources.some((source) => source.tag === 'RevenueFromContractWithCustomerExcludingAssessedTax'));
});

test('rental REIT margins keep the lease denominator explicit when consolidated total revenue is unavailable', () => {
  const p = profile({ Revenues: null, RevenueFromContractWithCustomerExcludingAssessedTax: [5, 6], OperatingLeaseLeaseIncome: [500, 600] }, 6798);
  const metric = p.metrics.find((item) => item.id === 'net_margin');
  assert.equal(metric.value, 65 / 600);
  assert.equal(metric.label, 'Net income / reported lease revenue');
  assert.match(metric.why, /excludes non-lease income/);
  assert.equal(buildRiskProfilePresentation(p).earnings.revenue.value, 600);
});

test('brief exports the new profile and sources without retired stress scenarios or academic models', () => {
  const p = profile();
  const brief = riskProfileBrief({ ticker: 'TEST', companyName: 'Test Company', sic: '3571', generatedAt: '2026-09-18T00:00:00Z' }, p);
  assert.match(brief, /Company risk profile/);
  assert.match(brief, /2025-12-31/);
  assert.match(brief, /Supporting observations/);
  assert.match(brief, /https:\/\/www.sec.gov\/Archives/);
  assert.doesNotMatch(brief, /Illustrative stress scenario|Altman|Beneish|Zmijewski/);
});
