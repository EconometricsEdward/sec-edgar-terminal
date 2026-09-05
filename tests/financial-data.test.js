import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetricRow, buildRatios, computeGrowth, extractQuarterlyPeriods } from '../src/utils/xbrlParser.js';
import { selectFinancialFact } from '../src/utils/xbrlPeriods.js';
import { illustrativeGeography, appendSnapshot } from '../src/utils/marketEvidence.js';

const obs = (val, start, end = '2026-06-30', extra = {}) => ({ val, start, end, fp: 'Q2', fy: 2026, form: '10-Q', filed: '2026-08-01', accn: '0000000001-26-000002', ...extra });
const facts = (entries, unit = 'USD') => ({ 'us-gaap': { Revenues: { units: { [unit]: entries } } } });
const quarter = { fy: 2026, fp: 'Q2', end: '2026-06-30' };
const value = (data, p = quarter) => buildMetricRow(data, 'revenue', 'Revenue', [p]).values[0];

test('quarter uses three months rather than six months, independent of upstream ordering', () => {
  const entries = [obs(200, '2026-01-01'), obs(110, '2026-04-01')];
  for (const ordered of [entries, [...entries].reverse()]) assert.equal(value(facts(ordered)).value, 110);
});
test('missing quarter remains missing rather than using another end date in the same year', () => {
  assert.equal(value(facts([obs(110, '2026-04-01')]), { ...quarter, fp: 'Q1', end: '2026-03-31' }).value, null);
});
test('currency units never silently substitute', () => assert.equal(value(facts([obs(110, '2026-04-01')], 'EUR')).value, null));
test('a cumulative cash flow produces a calculated quarter with both source contexts', () => {
  const point = value(facts([obs(200, '2026-01-01'), obs(90, '2026-01-01', '2026-03-31', { fp: 'Q1', filed: '2026-05-01' })]));
  assert.equal(point.value, 110); assert.equal(point.classification, 'calculated'); assert.equal(point.sources.length, 2);
});
test('fiscal-year starts must agree before cumulative subtraction', () => {
  assert.equal(value(facts([obs(200, '2026-01-01'), obs(90, '2025-12-01', '2026-03-31')])).value, null);
});
test('year-to-date and quarter remain distinct', () => {
  const data = facts([obs(200, '2026-01-01'), obs(110, '2026-04-01')]);
  assert.equal(value(data, { ...quarter, kind: 'ytd', fiscalStart: '2026-01-01' }).value, 200);
});
test('as-of selection excludes later revisions and retains exact-context revision evidence', () => {
  const data = facts([obs(110, '2026-04-01'), obs(115, '2026-04-01', '2026-06-30', { filed: '2026-09-01', form: '10-Q/A' })]);
  assert.equal(value(data, { ...quarter, asOf: '2026-08-15' }).value, 110);
  assert.equal(value(data).value, 115); assert.equal(value(data).source.revised, true);
});
test('non-calendar fiscal quarters retain the issuer fiscal year', () => {
  const data = facts([obs(100, '2025-10-01', '2025-12-31', { fp: 'Q1', fy: 2026, filed: '2026-02-01' })]);
  assert.equal(extractQuarterlyPeriods(data)[0].fy, 2026);
});
test('EPS and weighted shares are never derived by cumulative subtraction', () => {
  assert.equal(selectFinancialFact(facts([obs(200, '2026-01-01'), obs(90, '2026-01-01', '2026-03-31')]), ['Revenues'], quarter, 'USD', { additive: false }), null);
});
test('growth does not close gaps in a financial series', () => {
  const growth = computeGrowth({ values: [{ value: 120, period: { end: '2025-12-31' } }, { value: null, period: { end: '2024-12-31' } }, { value: 100, period: { end: '2023-12-31' } }] });
  assert.equal(growth.yoy, null);
});
test('bank NIM cannot substitute total assets or after-provision income', () => {
  const data = { 'us-gaap': Object.fromEntries([['Assets', 1000], ['InterestIncomeExpenseAfterProvisionForLoanLoss', 50]].map(([tag, val]) => [tag, { units: { USD: [obs(val, tag === 'Assets' ? undefined : '2026-01-01')] } }])) };
  const rows = buildRatios(data, [quarter], '6021');
  assert.equal(rows.find((r) => r.label === 'Net Interest Margin (NIM)').values[0].value, null);
});
test('geographic assumptions cannot masquerade as historical observations', () => {
  const [region] = illustrativeGeography([{ metricByMode: { assets: 100 }, timeSeries: [{ label: '1Y ago', metricByMode: { assets: 70 } }] }]);
  assert.equal(region.classification, 'illustrative'); assert.deepEqual(region.timeSeries.map((p) => p.label), ['Scenario']);
});
test('observed snapshots keep actual dates and replace only the same day', () => {
  const rows = appendSnapshot([{ observedAt: '2026-09-04T10:00:00Z', totalAssets: 90 }], { observedAt: '2026-09-05T10:00:00Z', totalAssets: 100 });
  assert.equal(rows.length, 2); assert.equal(rows[0].totalAssets, 90);
});

test('Q4 and trailing twelve months derive from consecutive quarters with full evidence', () => {
  const data = facts([
    obs(100, '2024-01-01', '2024-12-31', { fp: 'FY', fy: 2024, form: '10-K', filed: '2025-02-01', accn: '0000000001-25-000001' }),
    obs(70, '2024-01-01', '2024-09-30', { fp: 'Q3', fy: 2024, filed: '2024-11-01', accn: '0000000001-24-000003' }),
    obs(150, '2025-01-01', '2025-09-30', { fp: 'Q3', fy: 2025, filed: '2025-11-01', accn: '0000000001-25-000004' }),
    obs(90, '2025-01-01', '2025-06-30', { fp: 'Q2', fy: 2025, filed: '2025-08-01', accn: '0000000001-25-000003' }),
    obs(40, '2025-01-01', '2025-03-31', { fp: 'Q1', fy: 2025, filed: '2025-05-01', accn: '0000000001-25-000002' }),
  ]);
  const periods = extractQuarterlyPeriods(data);
  const q4 = value(data, periods.find((p) => p.fp === 'Q4'));
  assert.equal(q4.value, 30); assert.equal(q4.source.start, '2024-10-01');
  const ttm = value(data, { ...periods[0], kind: 'ttm' });
  assert.equal(ttm.value, 180); assert.equal(ttm.source.start, '2024-10-01');
  assert.equal(ttm.calculations.length, 3);
  assert.equal(periods[0].ttmStart, '2024-10-01');
  assert.equal(ttm.sources.find((s) => s.end === '2024-12-31').value, 100);
});

test('trailing periods stay unavailable when an intermediate quarter is missing', () => {
  const data = facts([obs(110, '2026-04-01')]);
  assert.equal(value(data, { ...quarter, kind: 'ttm' }).value, null);
});
