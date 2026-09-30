import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskChangeTimeline } from '../src/app/risk/riskChangeTimelineModel.js';
import { extractRefinancingProfile } from '../src/utils/refinancing/maturities.js';
import { compactRefinancingProfile } from '../src/utils/refinancing/projection.js';

const million = 1000000;
const ends = ['2024-12-31', '2025-12-31'];
const company = { ticker: 'TEST', cik: '0000000001', sic: '9999' };
const source = (tag, end, value, start = null, issuer = '1') => ({ taxonomy: 'us-gaap', tag, value, unit: 'USD', end, ...(start ? { start } : {}),
  sourceCik: issuer.padStart(10, '0'), accession: `0000000001-${Number(end.slice(2, 4)) + 1}-000001`, filed: `${Number(end.slice(0, 4)) + 1}-02-15`, form: '10-K',
  documentUrl: `https://www.sec.gov/Archives/edgar/data/${issuer}/0000000001${Number(end.slice(2, 4)) + 1}000001/test.htm`,
  url: `https://data.sec.gov/api/xbrl/companyconcept/CIK${issuer.padStart(10, '0')}/us-gaap/${tag}.json` });
const profile = (dates = ends, basis = 'annual') => ({ basis, industry: {}, periods: [...dates].reverse().map(end => ({ end, fy: Number(end.slice(0, 4)), fp: basis === 'annual' ? 'FY' : `Q${Math.ceil(Number(end.slice(5, 7)) / 3)}`, kind: basis })), metrics: [], reportedFlows: {}, reportedBalances: {} });
const series = (tag, values, dates = ends, flow = false) => dates.map((end, index) => {
  const start = flow ? `${end.slice(0, 4)}-01-01` : null;
  return { end, ...(start ? { start } : {}), value: values[index], formula: flow ? 'Reported annual SEC flow' : 'Reported SEC balance', sources: values[index] == null ? [] : [source(tag, end, values[index], start)] };
});
const metric = (id, label, format, values, tag, dates = ends) => ({ id, label, format, value: values.at(-1), end: dates.at(-1), formula: 'Supported reported inputs', series: series(tag, values, dates) });
const eventFor = (model, id) => model.events.find(event => event.id.startsWith(`${id}:`));

test('native percent values and pp deltas retain their own before/after evidence', () => {
  const p = profile();
  p.metrics.push(metric('npl_ratio', 'Nonaccrual loans / loans', 'pct', [.01, .013], 'NonperformingLoans'));
  const m = buildRiskChangeTimeline(p, { ...company, sic: '6021' });
  const e = eventFor(m, 'npl_ratio');
  assert.equal(m.lens.id, 'bank');
  assert.equal(e.format, 'pct');
  assert.equal(e.deltaFormat, 'pp');
  assert.ok(Math.abs(e.delta - .003) < 1e-12);
  assert.equal(e.before.value, .01);
  assert.equal(e.after.value, .013);
  assert.equal(e.metricId, 'npl_ratio');
  assert.equal(e.date, ends[1]);
  assert.equal(e.before.filed, '2025-02-15');
  assert.equal(e.after.filed, '2026-02-15');
  assert.notEqual(e.before.sourceUrls[0], e.after.sourceUrls[0]);
  assert.equal(e.criterion.threshold, .001);
  assert.deepEqual(m.periods.map(period => period.date), ends);
});

test('cash generation and neutral dividends use compatible full-year sources', () => {
  const p = profile();
  p.reportedFlows.operatingCashFlow = series('NetCashProvidedByUsedInOperatingActivities', [100 * million, -30 * million], ends, true);
  p.reportedFlows.capitalExpenditure = series('PaymentsToAcquireProductiveAssets', [50 * million, 70 * million], ends, true);
  p.reportedFlows.dividendsPaid = series('PaymentsOfDividends', [10 * million, 15 * million], ends, true);
  const m = buildRiskChangeTimeline(p, company);
  const cash = eventFor(m, 'reported_operatingCashFlow');
  assert.equal(cash.before.start, '2024-01-01');
  assert.equal(cash.after.start, '2025-01-01');
  assert.equal(cash.after.value, -30 * million);
  assert.equal(cash.direction, 'decrease');
  assert.equal(cash.relativeChange, -1.3);
  assert.equal(cash.metricId, null);
  const dividend = eventFor(m, 'reported_dividendsPaid');
  assert.equal(dividend.category, 'distributions');
  assert.match(dividend.scope, /capital allocation/);
  const investment = eventFor(m, 'cash_investment_cover');
  assert.match(investment.scope, /intangible assets/);
  assert.equal(investment.after.formula, 'Operating cash flow / reported cash capital purchases');
});

test('zero baselines and negative dollar values are preserved without invented growth', () => {
  const p = profile();
  p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [0, 2 * million]);
  let e = eventFor(buildRiskChangeTimeline(p, company), 'reported_cash');
  assert.equal(e.before.value, 0);
  assert.equal(e.relativeChange, null);
  p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [-10 * million, -7 * million]);
  e = eventFor(buildRiskChangeTimeline(p, company), 'reported_cash');
  assert.equal(e.after.value, -7 * million);
  assert.equal(e.relativeChange, .3);
});

test('missing periods are not filled with zero or bridged', () => {
  const dates = ['2023-12-31', '2024-12-31', '2025-12-31'];
  const p = profile(dates);
  p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [10 * million, null, 30 * million], dates);
  const m = buildRiskChangeTimeline(p, company);
  assert.equal(m.events.length, 0);
  assert.ok(m.gaps.some(gap => gap.id === 'missing' && gap.count > 0));
  const gap = profile(['2023-12-31', '2025-12-31']);
  gap.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [10 * million, 30 * million], ['2023-12-31', '2025-12-31']);
  assert.equal(buildRiskChangeTimeline(gap, company).events.length, 0);
});

test('source concept, units, capital purchase scope and issuer changes exclude comparisons', () => {
  for (const mutate of [
    p => { p.reportedBalances.cash[1].sources[0].tag = 'Cash'; p.reportedBalances.cash[1].sources[0].url = 'https://data.sec.gov/api/xbrl/companyconcept/CIK0000000001/us-gaap/Cash.json'; },
    p => { p.reportedBalances.cash[1].sources[0].unit = 'EUR'; },
    p => { p.reportedBalances.cash[0].sources = [source('CashAndCashEquivalentsAtCarryingValue', ends[0], 10 * million, null, '2')]; },
    p => { p.reportedBalances.cash[0].sources[0].documentUrl = 'https://example.com/filing.htm'; },
    p => { p.reportedBalances.cash[0].sources[0].url = 'https://data.sec.gov/api/xbrl/companyconcept/CIK0000000001/us-gaap/%ZZ.json'; },
    p => { delete p.reportedBalances.cash[0].sources[0].accession; },
  ]) {
    const p = profile();
    p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [10 * million, 30 * million]);
    mutate(p);
    assert.equal(buildRiskChangeTimeline(p, company).events.length, 0);
  }
  const p = profile();
  p.reportedFlows.capitalExpenditure = series('PaymentsToAcquirePropertyPlantAndEquipment', [10 * million, 30 * million], ends, true);
  p.reportedFlows.capitalExpenditure[1].sources[0] = source('PaymentsToAcquireProductiveAssets', ends[1], 30 * million, '2025-01-01');
  assert.equal(buildRiskChangeTimeline(p, company).events.length, 0);
});

test('quarter flows, crossed flow intervals and stale balance dates are excluded', () => {
  const p = profile();
  p.reportedFlows.operatingCashFlow = series('NetCashProvidedByUsedInOperatingActivities', [10 * million, 30 * million], ends, true);
  p.reportedFlows.operatingCashFlow[1].start = '2025-10-01';
  assert.equal(buildRiskChangeTimeline(p, company).events.length, 0);
  p.reportedFlows.operatingCashFlow[1].start = '2025-01-01';
  p.reportedFlows.capitalExpenditure = series('PaymentsToAcquirePropertyPlantAndEquipment', [10 * million, 20 * million], ends, true);
  p.reportedFlows.capitalExpenditure[1].start = '2025-02-01';
  const m = buildRiskChangeTimeline(p, company);
  assert.equal(eventFor(m, 'cash_after_capex'), undefined);
  p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [10 * million, 30 * million]);
  p.reportedBalances.cash[1].sources[0].end = '2025-09-30';
  assert.equal(eventFor(buildRiskChangeTimeline(p, company), 'reported_cash'), undefined);
});

test('TTM full windows are proved from flow inputs rather than the primary quarter source', () => {
  const dates = ['2025-03-31', '2025-06-30'];
  const p = profile(dates, 'ttm');
  p.reportedFlows.netIncome = dates.map((end, index) => ({ end, start: index ? '2024-07-01' : '2024-04-01', value: (100 + 50 * index) * million,
    sources: [source('NetIncomeLoss', end, (100 + 50 * index) * million, index ? '2024-07-01' : '2024-04-01')] }));
  p.reportedFlows.revenue = dates.map((end, index) => ({ end, start: index ? '2024-07-01' : '2024-04-01', value: 1000 * million,
    sources: [source('Revenues', end, 1000 * million, index ? '2024-07-01' : '2024-04-01')] }));
  p.metrics = [{ id: 'net_margin', label: 'Net margin', format: 'pct', end: dates[1], value: .15, formula: 'Net income / revenue',
    series: dates.map((end, index) => ({ end, start: index ? '2025-04-01' : '2025-01-01', kind: 'ttm', value: .1 + .05 * index,
      sources: [...p.reportedFlows.netIncome[index].sources, ...p.reportedFlows.revenue[index].sources] })) }];
  const m = buildRiskChangeTimeline(p, { ...company, sic: '6311' });
  const e = eventFor(m, 'net_margin');
  assert.equal(e.before.start, '2024-04-01');
  assert.equal(e.after.start, '2024-07-01');
  assert.match(e.scope, /windows overlap/);
  p.reportedFlows.revenue[1].start = '2024-08-01';
  assert.equal(eventFor(buildRiskChangeTimeline(p, { ...company, sic: '6311' }), 'net_margin'), undefined);
});

test('cutoff checks complete source filing dates and excludes unknown or future filings', () => {
  const p = profile();
  p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [10 * million, 30 * million]);
  assert.equal(buildRiskChangeTimeline(p, company, { asOf: '2025-12-31' }).events.length, 0);
  assert.ok(buildRiskChangeTimeline(p, company, { asOf: '2025-12-31' }).coverage.cutoffExcludedPairs > 0);
  assert.ok(eventFor(buildRiskChangeTimeline(p, company, { asOf: '2026-03-01' }), 'reported_cash'));
  delete p.reportedBalances.cash[0].sources[0].filed;
  assert.equal(buildRiskChangeTimeline(p, company, { asOf: '2026-03-01' }).events.length, 0);
  assert.ok(eventFor(buildRiskChangeTimeline(p, company), 'reported_cash'));
  assert.equal(buildRiskChangeTimeline(p, company, { asOf: '2026-99-01' }).events.length, 0);
});

test('financial lenses exclude industrial cash/debt screens and aggregate loss counts', () => {
  for (const sic of ['6021', '6211', '6311', '6331', '6399', '6282']) {
    const p = profile();
    p.reportedFlows.operatingCashFlow = series('NetCashProvidedByUsedInOperatingActivities', [10 * million, 50 * million], ends, true);
    p.reportedFlows.capitalExpenditure = series('PaymentsToAcquirePropertyPlantAndEquipment', [10 * million, 50 * million], ends, true);
    p.metrics.push(metric('loss_years', 'Loss-making fiscal years', 'count', [0, 5], 'NetIncomeLoss'));
    const m = buildRiskChangeTimeline(p, { ...company, sic });
    assert.ok(!m.events.some(e => /operatingCashFlow|cash_after_capex|cash_investment_cover|fcf|loss_years/.test(e.id)), sic);
  }
});

test('dollar screen scales with same-date supported assets and ignores small changes', () => {
  const p = profile();
  p.reportedBalances.cash = series('CashAndCashEquivalentsAtCarryingValue', [10 * million, 13 * million]);
  p.reportedBalances.totalAssets = series('Assets', [10000 * million, 10000 * million]);
  assert.equal(eventFor(buildRiskChangeTimeline(p, company), 'reported_cash'), undefined);
  p.reportedBalances.cash[1].value = 20 * million;
  p.reportedBalances.cash[1].sources[0].value = 20 * million;
  const e = eventFor(buildRiskChangeTimeline(p, company), 'reported_cash');
  assert.equal(e.criterion.threshold, 5 * million);
  assert.equal(e.criterion.assetScale, 10000 * million);
});

test('output is deterministic, bounded and does not mutate loaded evidence', () => {
  const dates = Array.from({ length: 9 }, (_, index) => `${2017 + index}-12-31`);
  const p = profile(dates);
  for (const [key, tag] of [['cash', 'CashAndCashEquivalentsAtCarryingValue'], ['currentDebt', 'LongTermDebtCurrent'], ['totalDebt', 'LongTermDebt']]) p.reportedBalances[key] = series(tag, dates.map((_, i) => 10 * million * (i + 1) ** 2), dates);
  for (const [key, tag] of [['netIncome', 'NetIncomeLoss'], ['operatingCashFlow', 'NetCashProvidedByUsedInOperatingActivities'], ['capitalExpenditure', 'PaymentsToAcquirePropertyPlantAndEquipment'], ['dividendsPaid', 'PaymentsOfDividends']]) p.reportedFlows[key] = series(tag, dates.map((_, i) => 10 * million * (i + 1) ** 3), dates, true);
  const input = JSON.stringify(p);
  const m = buildRiskChangeTimeline(p, company);
  assert.equal(m.periods.length, 6);
  assert.ok(m.events.length > 0 && m.events.length <= 20);
  assert.ok(m.periods.every(period => period.eventCount <= 4));
  assert.ok(m.events.every((event, index) => !index || event.date <= m.events[index - 1].date));
  assert.deepEqual(buildRiskChangeTimeline(p, company), m);
  assert.equal(JSON.stringify(p), input);
});

function schedule(year, value, basis = 'fiscal') {
  const end = `${year}-12-31`, filed = `${year + 1}-02-15`, accession = `0000000001-${String(year + 1).slice(-2)}-000001`;
  const tag = `LongTermDebtMaturitiesRepaymentsOfPrincipal${basis === 'fiscal' ? 'InNextTwelveMonths' : 'InNextRollingTwelveMonths'}`;
  const facts = { cik: 1, facts: { 'us-gaap': { [tag]: { units: { USD: [{ val: value, end, filed, accn: accession, form: '10-K', fy: year, fp: 'FY' }] } } } } };
  return compactRefinancingProfile(extractRefinancingProfile(facts, { cik: company.cik, asOf: filed }));
}

test('optional maturity events compare original annual buckets with different future windows', () => {
  const p = profile();
  const refinancingHistory = [schedule(2024, 10 * million), schedule(2025, 30 * million)];
  const m = buildRiskChangeTimeline(p, { ...company, refinancingHistory });
  const e = eventFor(m, 'scheduled_next12m');
  assert.equal(e.category, 'refinancing');
  assert.equal(e.date, '2025-12-31');
  assert.equal(e.before.start, '2025-01-01');
  assert.equal(e.before.windowEnd, '2025-12-31');
  assert.equal(e.after.start, '2026-01-01');
  assert.equal(e.after.windowEnd, '2026-12-31');
  assert.equal(e.before.value, 10 * million);
  assert.equal(e.after.value, 30 * million);
  assert.equal(e.metricId, null);
  assert.equal(e.before.sources[0].tag, 'LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths');
  assert.match(e.before.sourceUrls[0], /0000000001-25-000001-index.html$/);
  assert.match(e.after.sourceUrls[0], /0000000001-26-000001-index.html$/);
  assert.match(e.scope, /different forward windows/);
  assert.match(e.scope, /same loan cohort/);
  assert.equal(buildRiskChangeTimeline(p, { ...company, refinancingHistory }, { asOf: '2025-12-31' }).events.length, 0);
});

test('maturity events reject crossed basis, unverified sources, missing buckets and annual gaps', () => {
  for (const history of [
    [schedule(2024, 10 * million), schedule(2025, 30 * million, 'rolling')],
    [schedule(2023, 10 * million), schedule(2025, 30 * million)],
    [schedule(2024, 10 * million), { ...schedule(2025, 30 * million), sourceUrl: 'https://example.com/report.htm' }],
    [schedule(2024, 10 * million), { ...schedule(2025, 30 * million), cik: '0000000002' }],
    [schedule(2024, 10 * million), { ...schedule(2025, 30 * million), form: '10-K/A' }],
  ]) assert.equal(eventFor(buildRiskChangeTimeline(profile(), { ...company, refinancingHistory: history }), 'scheduled_next12m'), undefined);
  const missing = schedule(2025, 30 * million);
  missing.buckets[0].value = null;
  missing.buckets[1].value = 30 * million;
  const m = buildRiskChangeTimeline(profile(), { ...company, refinancingHistory: [schedule(2024, 10 * million), missing] });
  assert.equal(eventFor(m, 'scheduled_next12m'), undefined);
  assert.ok(m.gaps.some(gap => gap.id === 'missing'));
});

test('annual schedule events remain annual comparisons within a TTM reporting timeline', () => {
  const dates = ['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'];
  const p = profile(dates, 'ttm');
  const m = buildRiskChangeTimeline(p, { ...company, refinancingHistory: [schedule(2024, 10 * million, 'rolling'), schedule(2025, 30 * million, 'rolling')] });
  const e = eventFor(m, 'scheduled_next12m');
  assert.equal(e.before.end, '2024-12-31');
  assert.equal(e.after.end, '2025-12-31');
  assert.equal(e.after.sources[0].tag, 'LongTermDebtMaturitiesRepaymentsOfPrincipalInNextRollingTwelveMonths');
  assert.equal(e.label, 'Next rolling 12-month principal');
  assert.equal(m.periods.find(period => period.date === '2025-12-31').eventCount, 1);
});
