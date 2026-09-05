import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketCompany, marketPeriodMetrics, marketCompanySummary } from '../src/utils/marketResearchData.js';
import { MARKET_VERSION, DEFAULT_MARKET_VIEW, metricStats, selectMarketCompanies, parseMarketView, marketViewQuery, parseMarketSaved, baselineChanges, marketTrendPoints, marketCsv, formatMarket, isOlderReport } from '../src/utils/marketResearch.js';

const inputs = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
function company(ticker, values, end = '2026-06-30') {
  return { ticker, name: ticker, cik: '0000000001', cohorts: ['credit'], version: MARKET_VERSION, observedAt: '2026-09-05T00:00:00Z', metrics: { ttm: values, annual: values }, reports: { ttm: { end, filed: '2026-08-01' }, annual: { end, filed: '2026-08-01' } } };
}
const obs = (val, start, end, fp, fy) => ({ val, start, end, fp, fy, form: fp === 'FY' ? '10-K' : '10-Q', filed: `${Number(end.slice(0, 4)) + (fp === 'FY' ? 1 : 0)}-${fp === 'FY' ? '02-01' : `${String(Number(end.slice(5, 7)) + 1).padStart(2, '0')}-25`}`, accn: `0000000001-${String(fy).slice(-2)}-00000${fp === 'FY' ? 4 : fp.slice(1)}` });
const make = (facts) => buildMarketCompany({ ticker: 'TEST', cik: '0000000001', name: 'Test', sic: '3571', facts }, ['software'], '2026-09-05T00:00:00Z');

test('Market ratios require every component, retain zero, and reject nonpositive denominators', () => {
  const missing = marketPeriodMetrics(inputs({ revenue: 100, operatingCashFlow: 20, totalAssets: 200 }));
  assert.equal(missing.freeCashFlowMargin, null); assert.equal(missing.netMargin, null);
  const zero = marketPeriodMetrics(inputs({ revenue: 100, operatingCashFlow: 0, capex: 0, netIncome: 0, totalAssets: 200, cash: 0 }));
  assert.equal(zero.freeCashFlowMargin, 0); assert.equal(zero.netMargin, 0); assert.equal(zero.cashToAssets, 0);
  assert.equal(marketPeriodMetrics(inputs({ revenue: -10, netIncome: -5 })).netMargin, null);
  assert.equal(marketPeriodMetrics(inputs({ totalAssets: 0, stockholdersEquity: 10 })).equityToAssets, null);
  assert.equal(formatMarket(0, 'usd'), '$0');
});
test('Free cash flow consistently subtracts PP&E purchases while preserving operating losses', () => {
  const a = marketPeriodMetrics(inputs({ revenue: 100, operatingCashFlow: -20, capex: -10, netIncome: -5, totalAssets: 200, stockholdersEquity: -10 }));
  assert.equal(a.freeCashFlowMargin, -30); assert.equal(a.netMargin, -5); assert.equal(a.equityToAssets, -5);
});
test('Current Market metrics never fall back to an older reporting period', () => {
  const facts = { 'us-gaap': { Assets: { units: { USD: [obs(100, undefined, '2025-12-31', 'FY', 2025), obs(90, undefined, '2024-12-31', 'FY', 2024)] } }, Revenues: { units: { USD: [obs(50, '2024-01-01', '2024-12-31', 'FY', 2024)] } } } };
  const c = make(facts); assert.equal(c.reports.annual.end, '2025-12-31'); assert.equal(c.metrics.annual.revenue, null); assert.equal(c.evidence.annual[1].metrics.revenue, 50);
});
test('Annual growth does not bridge a missing financial year', () => {
  const c = make({ 'us-gaap': { Revenues: { units: { USD: [obs(120, '2025-01-01', '2025-12-31', 'FY', 2025), obs(100, '2023-01-01', '2023-12-31', 'FY', 2023)] } } } });
  assert.equal(c.metrics.annual.revenueGrowth, null); assert.equal(c.evidence.annual[0].priorRevenue, null);
});
test('TTM and annual metrics remain distinct with auditable cumulative source inputs', () => {
  const c = make({ 'us-gaap': { Revenues: { units: { USD: [
    obs(60, '2023-01-01', '2023-09-30', 'Q3', 2023), obs(90, '2023-01-01', '2023-12-31', 'FY', 2023),
    obs(10, '2024-01-01', '2024-03-31', 'Q1', 2024), obs(30, '2024-01-01', '2024-06-30', 'Q2', 2024), obs(60, '2024-01-01', '2024-09-30', 'Q3', 2024), obs(100, '2024-01-01', '2024-12-31', 'FY', 2024),
    obs(40, '2025-01-01', '2025-03-31', 'Q1', 2025), obs(90, '2025-01-01', '2025-06-30', 'Q2', 2025), obs(150, '2025-01-01', '2025-09-30', 'Q3', 2025),
  ] } } } });
  assert.equal(c.metrics.annual.revenue, 100); assert.equal(c.metrics.ttm.revenue, 190);
  assert.equal(c.evidence.ttm[0].priorRevenue.value, 90);
  assert.ok(Math.abs(c.metrics.ttm.revenueGrowth - (190 / 90 - 1) * 100) < 1e-9);
  assert.ok(c.evidence.ttm[0].inputs.revenue.sources.some((s) => s.value === 100 && s.end === '2024-12-31'));
  assert.ok(c.evidence.ttm[0].inputs.revenue.calculations.some((p) => p.value === 40));
  assert.equal(marketCompanySummary(c).evidence, undefined);
});
test('Breadth denominators include only available values and distinguish zero from missing', () => {
  const rows = [company('A', { revenueGrowth: 10 }), company('B', { revenueGrowth: 0 }), company('C', { revenueGrowth: null })];
  const stat = metricStats(rows, 'ttm', 'revenueGrowth');
  assert.deepEqual({ count: stat.count, total: stat.total, positivePct: stat.positivePct, median: stat.median }, { count: 2, total: 3, positivePct: 50, median: 5 });
  assert.equal(metricStats([], 'ttm', 'revenueGrowth').positivePct, null);
});
test('Screener filters do not treat unavailable values as losses; missing values sort last both ways', () => {
  const rows = [company('MISSING', { revenueGrowth: null }), company('NEG', { revenueGrowth: -10 }), company('POS', { revenueGrowth: 20 })];
  const view = { ...DEFAULT_MARKET_VIEW, screen: 'contraction' };
  assert.deepEqual(selectMarketCompanies(rows, view, [], '').map((c) => c.ticker), ['NEG']);
  for (const direction of ['asc', 'desc']) assert.equal(selectMarketCompanies(rows, { ...view, screen: 'all', direction }, [], '').at(-1).ticker, 'MISSING');
  assert.deepEqual(selectMarketCompanies(rows, { ...view, screen: 'watchlist' }, ['POS'], '').map((c) => c.ticker), ['POS']);
});
test('Shareable views round-trip filters, sanitize invalid options, and cap peer selection', () => {
  const view = { ...DEFAULT_MARKET_VIEW, tab: 'companies', cohort: 'credit', basis: 'annual', query: 'JPM & bank', selected: ['JPM', 'BAC'], screen: 'losses' };
  assert.deepEqual(parseMarketView(marketViewQuery(view), ['credit']), view);
  const malformed = parseMarketView('basis=invalid&cohort=unknown&peers=A,A,B,C,D,E,F,%3Cscript%3E', ['credit']);
  assert.equal(malformed.basis, 'ttm'); assert.equal(malformed.cohort, 'all'); assert.deepEqual(malformed.selected, ['A', 'B', 'C', 'D', 'E']);
});
test('Saved research refuses incompatible versions and keeps unavailable-company baselines', () => {
  assert.throws(() => parseMarketSaved('{"version":2,"watchlist":[],"views":[]}'));
  const c = company('OLD', { revenueGrowth: 5 });
  const restored = parseMarketSaved(JSON.stringify({ version: 1, watchlist: ['OLD'], views: [{ name: 'Saved', query: 'screen=losses' }], baselines: { OLD: c } }));
  assert.equal(restored.baselines.OLD.metrics.ttm.revenueGrowth, 5);
});
test('Watchlist changes distinguish new periods from changed values and skip incomparable missing metrics', () => {
  const before = company('A', { revenueGrowth: 10, netMargin: null });
  let after = company('A', { revenueGrowth: 12, netMargin: 5 });
  assert.equal(baselineChanges(before, after, 'ttm').length, 1);
  assert.equal(baselineChanges(before, after, 'ttm')[0].reason, 'Updated value for the same period');
  after = company('A', { revenueGrowth: 12 }, '2026-09-30');
  assert.equal(baselineChanges(before, after, 'ttm')[0].reason, 'Different reporting period');
  assert.deepEqual(baselineChanges({ ...before, version: 'old' }, after, 'ttm'), []);
});
test('Trend charts insert a break for unobserved quarters and retain missing metric values', () => {
  const rows = [{ period: { end: '2026-06-30' }, metrics: { revenue: 10 } }, { period: { end: '2025-12-31' }, metrics: { revenue: null } }];
  const points = marketTrendPoints(rows, 'revenue', 'ttm');
  assert.equal(points.length, 3); assert.equal(points[1].value, null); assert.equal(points[0].value, null);
});
test('CSV exports raw numeric negatives, empty unavailable cells, and escapes spreadsheet formulas in text', () => {
  const c = { ...company('A', { revenueGrowth: -5, netMargin: null }), name: '=HYPERLINK("bad")' };
  const csv = marketCsv([c], 'ttm', '2026-09-05');
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"')); assert.ok(csv.includes(',-5,"",')); assert.ok(csv.includes('CIK0000000001.json'));
});
test('Freshness is based on financial report end rather than retrieval date', () => {
  assert.equal(isOlderReport(company('A', {}, '2025-12-31'), 'ttm', '2026-09-05'), true);
  assert.equal(isOlderReport(company('A', {}, '2026-06-30'), 'ttm', '2026-09-05'), false);
});
