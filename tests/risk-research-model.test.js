import test from 'node:test';
import assert from 'node:assert/strict';
import { riskResearchLens, buildRiskResearchModel, riskResearchBrief } from '../src/app/risk/riskResearchModel.js';

const source = (tag, end, start = null) => ({ tag, taxonomy: 'us-gaap', end, start, value: 100, accession: '0000000001-25-000001', documentUrl: 'https://www.sec.gov/Archives/edgar/data/1/000000000125000001/test.htm' });
const dates = ['2024-12-31', '2025-12-31'];
const profile = (basis = 'annual') => ({ basis, industry: {}, periods: [...dates].reverse().map((end, index) => ({ end, fy: 2025 - index, fp: 'FY', kind: basis })), metrics: [], reportedBalances: {}, reportedFlows: {} });
const series = (tag, values, flow = false, ends = dates) => ends.map((end, index) => ({ end, fy: Number(end.slice(0, 4)), fp: 'FY', kind: 'annual', ...(flow ? { start: `${end.slice(0, 4)}-01-01` } : {}), value: values[index], sources: [source(tag, end, flow ? `${end.slice(0, 4)}-01-01` : null)] }));
const find = (model, id) => model.drivers.flatMap(driver => driver.metrics).find(metric => metric.id === id);

test('SIC distinguishes legal business models without relying on company brand', () => {
  for (const [sic, expected] of [[6021, 'bank'], [6712, 'bank'], [6211, 'broker'], [6221, 'broker'], [6311, 'life'], [6324, 'life'], [6331, 'property'], [6399, 'insurance'], [6798, 'reit'], [6513, 'real_estate'], [4931, 'utilities'], [1311, 'energy'], [2911, 'energy'], [5411, 'retail'], [7372, 'technology'], [3674, 'technology'], [2836, 'health'], [8062, 'health'], [3312, 'industrial'], [6282, 'financial'], [6411, 'financial'], [9999, 'corporate']]) {
    assert.equal(riskResearchLens({}, { sic: String(sic) }).id, expected, String(sic));
  }
  assert.equal(riskResearchLens({ industry: { isBank: true } }, { sic: '7372' }).id, 'technology');
  assert.equal(riskResearchLens({ industry: { group: 'oil_gas' } }).id, 'energy');
});

test('each lens exposes four meaningful questions with explicit coverage gaps', () => {
  for (const sic of [6021, 6211, 6311, 6331, 6399, 6798, 6513, 4931, 1311, 5411, 7372, 2836, 3312, 6282, 9999]) {
    const model = buildRiskResearchModel(profile(), { ticker: 'TEST', sic });
    assert.equal(model.drivers.length, 4);
    assert.ok(model.drivers.every(driver => driver.metrics.length >= 2 && driver.metrics.length <= 3 && driver.question && driver.meaning));
    assert.equal(model.coverage.available, 0);
    assert.ok(model.gaps.every(gap => gap.detail && gap.href));
    assert.equal(model.changes.length, 0);
    assert.ok(model.marketChannels.every(channel => channel.mechanism && channel.href));
  }
});

test('cash investment metrics preserve exact sources and negative cash generation', () => {
  const p = profile();
  p.reportedFlows.operatingCashFlow = series('NetCashProvidedByUsedInOperatingActivities', [100, -20], true);
  p.reportedFlows.capitalExpenditure = series('PaymentsToAcquirePropertyPlantAndEquipment', [50, 40], true);
  const model = buildRiskResearchModel(p, { ticker: 'UTIL', sic: '4931' });
  assert.equal(find(model, 'cash_investment_cover').value, -0.5);
  assert.equal(find(model, 'cash_after_capex').value, -60);
  assert.equal(find(model, 'cash_after_capex').prior, 50);
  assert.equal(find(model, 'cash_after_capex').sources.length, 2);
  assert.equal(find(model, 'cash_after_capex').metricId, undefined);
  assert.equal(model.changes.find(change => change.id === 'cash_after_capex').delta, -110);
});

test('missing capex and crossed flow intervals remain unavailable rather than zero', () => {
  const p = profile();
  p.reportedFlows.operatingCashFlow = series('NetCashProvidedByUsedInOperatingActivities', [100, 100], true);
  assert.equal(find(buildRiskResearchModel(p, { sic: 4931 }), 'cash_after_capex').value, null);
  p.reportedFlows.capitalExpenditure = series('PaymentsToAcquirePropertyPlantAndEquipment', [50, 50], true);
  p.reportedFlows.capitalExpenditure[1].start = '2025-02-01';
  const crossed = buildRiskResearchModel(p, { sic: 4931 });
  assert.equal(find(crossed, 'cash_after_capex').value, null);
  assert.equal(find(crossed, 'cash_after_capex').prior, null);
});

test('historical cash-use months are shown only for negative compatible cash flows', () => {
  const p = profile();
  p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [100, 100]);
  p.reportedFlows.operatingCashFlow = series('NetCashProvidedByUsedInOperatingActivities', [20, -40], true);
  const metric = find(buildRiskResearchModel(p, { sic: 2836 }), 'historical_burn_months');
  assert.equal(metric.value, 30);
  assert.equal(metric.prior, null);
  assert.match(metric.note, /not forecast runway/);
  p.reportedFlows.operatingCashFlow[1].value = 0;
  assert.equal(find(buildRiskResearchModel(p, { sic: 2836 }), 'historical_burn_months').value, null);
  p.reportedFlows.operatingCashFlow[1].value = 20;
  assert.equal(find(buildRiskResearchModel(p, { sic: 2836 }), 'historical_burn_months').value, null);
});

test('missing current dates and non-adjacent observations cannot become recent changes', () => {
  const p = profile();
  p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [100]);
  assert.equal(find(buildRiskResearchModel(p, { sic: 2836 }), 'reported_cash').value, null);
  const gapDates = ['2023-12-31', '2025-12-31'];
  p.periods = [...gapDates].reverse().map(end => ({ end, fy: Number(end.slice(0, 4)), fp: 'FY', kind: 'annual' }));
  p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [100, 200], false, gapDates);
  const gapModel = buildRiskResearchModel(p, { sic: 2836 });
  assert.equal(find(gapModel, 'reported_cash').value, 200);
  assert.equal(find(gapModel, 'reported_cash').prior, null);
  assert.ok(!gapModel.changes.some(change => change.id === 'reported_cash'));
});

test('TTM comparisons require adjacent quarter ends and matching source concepts', () => {
  const p = profile('ttm');
  const ends = ['2025-03-31', '2025-06-30'];
  p.periods = [...ends].reverse().map(end => ({ end, fy: 2025, fp: end.includes('03-') ? 'Q1' : 'Q2', kind: 'ttm' }));
  p.metrics = [{ id: 'interest_coverage', label: 'Interest coverage', value: 5, end: ends[1], format: 'x', formula: 'Operating income / interest expense', series: series('InterestExpense', [4, 5], false, ends) }];
  let model = buildRiskResearchModel(p, { sic: 9999 });
  assert.equal(find(model, 'interest_coverage').prior, 4);
  assert.equal(model.changes.find(change => change.id === 'interest_coverage').metricId, 'interest_coverage');
  p.metrics[0].series[0].sources[0].tag = 'InterestExpenseDebt';
  model = buildRiskResearchModel(p, { sic: 9999 });
  assert.equal(find(model, 'interest_coverage').prior, null);
});

test('life insurers do not inherit P&C claims screens or industrial cash-debt drivers', () => {
  const p = profile();
  p.industry = { isFinancial: true, isInsurer: true };
  p.metrics = [{ id: 'loss_ratio', label: 'Claims / premiums', value: 0.8, end: dates[1], format: 'pct', series: series('PolicyholderBenefitsAndClaimsIncurredNet', [0.7, 0.8], true) }];
  const life = buildRiskResearchModel(p, { sic: 6311 });
  assert.equal(find(life, 'loss_ratio'), undefined);
  assert.equal(find(life, 'fcf_to_debt'), undefined);
  assert.equal(find(life, 'interest_coverage'), undefined);
  const property = buildRiskResearchModel(p, { sic: 6331 });
  assert.equal(find(property, 'loss_ratio').value, 0.8);
  assert.match(property.drivers[0].meaning, /excludes underwriting expenses/);
});

test('download briefing preserves reported dates, source URLs, missing evidence and market scope', () => {
  const p = profile();
  p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [100, 200]);
  const text = riskResearchBrief({ ticker: 'TEST', sic: 2836 }, p);
  assert.match(text, /Reporting end 2025-12-31/);
  assert.match(text, /Cash and equivalents: \$200\.00/);
  assert.match(text, /Formula: Reported SEC fact/);
  assert.match(text, /https:\/\/www\.sec\.gov\/Archives/);
  assert.match(text, /Compatible evidence unavailable/);
  assert.match(text, /not a credit rating/);
  assert.match(text, /https:\/\/secedgarterminal\.com\/risk\?ticker=TEST&view=exposures/);
});

test('loss-window counts preserve the aggregate rather than the latest binary history flag', () => {
  const p = profile();
  const sources = [source('NetIncomeLoss', dates[0], '2024-01-01'), source('NetIncomeLoss', dates[1], '2025-01-01')];
  p.metrics = [{ id: 'loss_years', label: 'Loss-making fiscal years', value: 3, end: dates[1], format: 'count', formula: 'Count of reported net-income observations below zero', sources,
    series: series('NetIncomeLoss', [1, 0], true) }];
  let model = buildRiskResearchModel(p, { sic: 6311 });
  const metric = find(model, 'loss_years');
  assert.equal(metric.value, 3);
  assert.equal(metric.prior, null);
  assert.deepEqual(metric.series, []);
  assert.deepEqual(metric.sources, sources);
  assert.ok(!model.changes.some(change => change.id === 'loss_years'));
  p.metrics[0].end = dates[0];
  model = buildRiskResearchModel(p, { sic: 6311 });
  assert.equal(find(model, 'loss_years').value, null);
  assert.deepEqual(find(model, 'loss_years').sources, []);
});
