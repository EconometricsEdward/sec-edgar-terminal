import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketCompany, marketCompanySummary, marketPeriodMetrics, MARKET_RISK_VERSION, MARKET_REVENUE_VERSION } from '../src/utils/marketResearchData.js';
import { formatMarket, marketCsv } from '../src/utils/marketResearch.js';
import { refreshQuantRiskMappings, applyPreparedRevenueCorrections, quantCheckpointFresh, needsFactsRefresh } from '../src/utils/quantCoverageServer.js';

const checkedAt = '2026-09-19T08:00:00.000Z';
const accession = '0000000001-26-000001';
const instant = val => ({ val, end: '2025-12-31', form: '10-K', fy: 2025, fp: 'FY', filed: '2026-02-01', accn: accession });
const annual = val => ({ ...instant(val), start: '2025-01-01' });
const facts = (changes = {}) => ({ 'us-gaap': Object.fromEntries(Object.entries({
  Assets: [instant(1000)], AssetsCurrent: [instant(300)], LiabilitiesCurrent: [instant(150)],
  DebtCurrent: [instant(50)], LongTermDebtNoncurrent: [instant(200)], LongTermDebtCurrent: [instant(40)],
  ShortTermBorrowings: [instant(10)], LongTermDebt: [instant(240)],
  OperatingIncomeLoss: [annual(80)], InterestExpense: [annual(20)], Revenues: [annual(500)], ...changes,
}).map(([tag, entries]) => [tag, { units: { USD: entries } }])) });
const build = (data = facts(), sic = '3571') => buildMarketCompany({ ticker: 'TEST', cik: '0000000001', name: 'Test', sic, facts: data }, [], checkedAt);

test('sector risk metrics reuse exact debt balances and retain their reporting basis', () => {
  const company = build();
  assert.equal(company.riskVersion, MARKET_RISK_VERSION);
  assert.equal(company.metrics.annual.debtToAssets, 25, 'DebtCurrent is not added again to LongTermDebt including current maturities');
  assert.equal(company.metrics.annual.currentRatio, 2);
  assert.equal(company.metrics.annual.interestCoverage, 4);
  assert.equal(company.evidence.annual[0].inputs.totalDebt.sources.length, 2);
  assert.equal(marketCompanySummary(company).riskVersion, MARKET_RISK_VERSION);
  assert.equal(formatMarket(4, 'ratio'), '4.0×');
  const csv = marketCsv([company], 'annual', checkedAt);
  assert.match(csv, /Current ratio \(times\)/);
  assert.match(csv, /Operating income \/ interest expense \(times\)/);
});

test('missing debt components are not zero and interest losses remain negative', () => {
  const incomplete = build(facts({ DebtCurrent: [], LongTermDebtCurrent: [], ShortTermBorrowings: [], LongTermDebt: [] }));
  assert.equal(incomplete.metrics.annual.debtToAssets, null);
  assert.equal(build(facts({ OperatingIncomeLoss: [annual(-40)] })).metrics.annual.interestCoverage, -2);
  for (const amount of [0, -20]) assert.equal(build(facts({ InterestExpense: [annual(amount)] })).metrics.annual.interestCoverage, null);
  assert.equal(build(facts({ DebtCurrent: [instant(0)], LongTermDebtNoncurrent: [instant(0)], LongTermDebt: [], LongTermDebtCurrent: [], ShortTermBorrowings: [] })).metrics.annual.debtToAssets, 0);
});

test('mapped debt totals and scoped interest alternatives agree with Analysis without inventing components', () => {
  const combined = build(facts({ DebtCurrent: [], LongTermDebtNoncurrent: [], LongTermDebtCurrent: [], ShortTermBorrowings: [], LongTermDebt: [],
    DebtLongtermAndShorttermCombinedAmount: [instant(250)], InterestExpense: [], InterestExpenseNonoperating: [annual(20)] }));
  assert.equal(combined.metrics.annual.debtToAssets, 25);
  assert.equal(combined.metrics.annual.interestCoverage, 4);
  assert.ok(combined.evidence.annual[0].inputs.interestExpense.sources[0].scopeNote);
  assert.equal(build(facts({ InterestExpense: [], InterestPaid: [annual(20)], InterestExpenseOperating: [annual(20)] })).metrics.annual.interestCoverage, null,
    'cash interest paid and financial operating-interest scope cannot fill a corporate financing ratio');
});

test('TTM interest coverage combines the same twelve-month contexts rather than a quarter and an annual amount', () => {
  const quarterly = (val, year, quarter = 3) => ({ val, start: `${year}-01-01`, end: `${year}-${['03-31', '06-30', '09-30'][quarter - 1]}`, fy: year, fp: `Q${quarter}`, form: '10-Q',
    filed: `${year}-${['05', '08', '11'][quarter - 1]}-01`, accn: `0000000001-${String(year).slice(-2)}-00000${quarter}` });
  const previous = val => ({ ...annual(val), start: '2024-01-01', end: '2024-12-31', fy: 2024, filed: '2025-02-01', accn: '0000000001-25-000004' });
  const company = build(facts({ Assets: [{ ...instant(1000), end: '2025-09-30', fp: 'Q3', form: '10-Q', filed: '2025-11-01' }],
    AssetsCurrent: [{ ...instant(300), end: '2025-09-30', fp: 'Q3', form: '10-Q', filed: '2025-11-01' }],
    LiabilitiesCurrent: [{ ...instant(150), end: '2025-09-30', fp: 'Q3', form: '10-Q', filed: '2025-11-01' }],
    Revenues: [previous(500), quarterly(350, 2024), quarterly(120, 2025, 1), quarterly(250, 2025, 2), quarterly(400, 2025)],
    OperatingIncomeLoss: [previous(80), quarterly(60, 2024), quarterly(25, 2025, 1), quarterly(50, 2025, 2), quarterly(90, 2025)],
    InterestExpense: [previous(40), quarterly(30, 2024), quarterly(15, 2025, 1), quarterly(30, 2025, 2), quarterly(45, 2025)],
  }));
  assert.equal(company.reports.ttm.end, '2025-09-30');
  assert.equal(company.metrics.ttm.interestCoverage, 2);
  assert.equal(company.evidence.ttm[0].inputs.operatingIncome.value, 110);
  assert.equal(company.evidence.ttm[0].inputs.interestExpense.value, 55);
  assert.equal(company.metrics.ttm.currentRatio, 2, 'TTM liquidity uses the latest reporting-end balance sheet');
  assert.equal(company.metrics.ttm.debtToAssets, null, 'other-date annual debt is not used for the new quarterly end');
});

test('current ratio and interest coverage do not use industrial screens for financial intermediaries', () => {
  for (const sic of ['6021', '6211', '6311', '6712']) {
    const company = build(facts(), sic);
    assert.equal(company.metrics.annual.currentRatio, null, sic);
    assert.equal(company.metrics.annual.interestCoverage, null, sic);
    assert.equal(company.metrics.annual.debtToAssets, 25, 'reported debt remains a labeled balance-sheet measure');
  }
  assert.equal(build(facts(), '6798').metrics.annual.interestCoverage, 4, 'rental REITs retain their reported interest coverage');
});

test('risk ratios reject incompatible dates, units and duration inputs', () => {
  const point = (value, start = null, end = '2025-12-31', unit = 'USD') => ({ value, observationPeriod: { start, end }, unit });
  const values = {
    totalDebt: point(250), totalAssets: point(1000), currentAssets: point(300), currentLiabilities: point(150),
    operatingIncome: point(80, '2025-01-01'), interestExpense: point(20, '2025-01-01'),
  };
  assert.equal(marketPeriodMetrics(values).interestCoverage, 4);
  assert.equal(marketPeriodMetrics({ ...values, interestExpense: point(20, '2025-04-01') }).interestCoverage, null);
  assert.equal(marketPeriodMetrics({ ...values, interestExpense: point(20, '2025-01-01', '2025-12-31', 'EUR') }).interestCoverage, null);
  assert.equal(marketPeriodMetrics({ ...values, currentLiabilities: point(150, null, '2025-09-30') }).currentRatio, null);
  assert.equal(marketPeriodMetrics({ ...values, totalDebt: point(250, '2025-01-01') }).debtToAssets, null);
  assert.equal(build(facts({ InterestExpense: [{ ...annual(20), start: '2025-10-01' }] })).metrics.annual.interestCoverage, null);
});

const documents = () => ({
  facts: { payload: { cik: 1, facts: facts() }, metadata: { fetchedAt: checkedAt, revalidatedAt: checkedAt } },
  submissions: { payload: { cik: 1, name: 'Test', sic: '3571', filings: { recent: {
    accessionNumber: [accession], form: ['10-K'], acceptanceDateTime: ['2026-02-01T19:00:00Z'],
  } } }, metadata: { fetchedAt: checkedAt, revalidatedAt: checkedAt } },
});
const oldCompany = () => {
  const { riskVersion: _version, ...company } = marketCompanySummary(build());
  for (const basis of ['annual', 'ttm']) for (const key of ['debtToAssets', 'currentRatio', 'interestCoverage']) delete company.metrics[basis][key];
  return { ...company, checkedAt, factsRetrievedAt: checkedAt, factsValidatedAt: checkedAt };
};

test('prepared migration updates missing risk metrics without a live SEC fetch or artificial freshness', async () => {
  const old = oldCompany(), docs = documents(), reads = [], writes = [];
  const record = { company: old, checkedAt, factsRetrievedAt: checkedAt, factsValidatedAt: checkedAt, fingerprint: 'same' };
  const result = await refreshQuantRiskMappings({
    readAtlas: async () => ({ companies: [old] }), readMany: async () => [record],
    prepared: async (path, options) => { reads.push({ path, options }); return path.includes('companyfacts') ? docs.facts : docs.submissions; },
    write: async (...args) => { writes.push(args); return true; }, acquire: async () => 'lease', release: async () => {},
  });
  assert.equal(result.corrected, 1);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(read => read.options.allowStale));
  const saved = writes[0][2];
  assert.equal(saved.checkedAt, checkedAt);
  assert.equal(saved.company.checkedAt, checkedAt);
  assert.equal(saved.company.metrics.annual.currentRatio, 2);
  assert.equal(saved.company.riskVersion, MARKET_RISK_VERSION);
  assert.equal(saved.fingerprint, 'same');
  const atlas = await applyPreparedRevenueCorrections({ generatedAt: checkedAt, companies: [old] }, { readMany: async () => [saved] });
  assert.equal(atlas.companies[0].metrics.annual.interestCoverage, 4);
  assert.equal(atlas.companies[0].checkedAt, checkedAt);
  assert.notEqual(atlas.generatedAt, checkedAt, 'a changed prepared projection can invalidate its old serving cache');
});

test('missing, mismatched or older prepared sources retain the old company instead of fabricating risk figures', async () => {
  const old = oldCompany(), docs = documents();
  const stale = { ...docs.facts, metadata: { fetchedAt: '2026-09-18T08:00:00.000Z' } };
  for (const prepared of [async () => null, async path => path.includes('companyfacts') ? stale : docs.submissions,
    async path => path.includes('companyfacts') ? { ...docs.facts, payload: { ...docs.facts.payload, cik: 2 } } : docs.submissions]) {
    let writes = 0;
    const result = await refreshQuantRiskMappings({ readAtlas: async () => ({ companies: [old] }), readMany: async () => [],
      prepared, write: async () => { writes++; return true; }, acquire: async () => 'lease', release: async () => {} });
    assert.equal(result.unavailable, 1);
    assert.equal(writes, 0);
  }
  const unchanged = { generatedAt: checkedAt, companies: [old] };
  assert.equal(await applyPreparedRevenueCorrections(unchanged, { readMany: async () => [{ company: old }] }), unchanged);
});

test('mapping version schedules safe checkpoint upgrades while unsupported candidates remain negatively cached', () => {
  const now = Date.parse(checkedAt), record = { company: { revenueVersion: MARKET_REVENUE_VERSION }, checkedAt, factsRetrievedAt: checkedAt, fingerprint: 'same' };
  assert.equal(quantCheckpointFresh(record, now), false);
  assert.equal(needsFactsRefresh(record, 'same', now), true);
  const current = { ...record, company: { ...record.company, riskVersion: MARKET_RISK_VERSION } };
  assert.equal(quantCheckpointFresh(current, now), true);
  assert.equal(needsFactsRefresh(current, 'same', now), false);
  assert.equal(quantCheckpointFresh({ eligibility: 'unsupported', checkedAt }, now), true);
});

test('prepared risk recalculation honors current shard ownership and later unsupported decisions', async () => {
  const old = oldCompany();
  let reads = 0;
  const prepared = async () => { reads++; throw new Error('Sources should not be read.'); };
  const locked = await refreshQuantRiskMappings({ readAtlas: async () => ({ companies: [old] }),
    acquire: async () => null, prepared });
  assert.equal(locked.skipped, 1);
  const unsupported = await refreshQuantRiskMappings({ readAtlas: async () => ({ companies: [old] }),
    acquire: async () => 'lease', release: async () => {}, prepared,
    readMany: async () => [{ eligibility: 'unsupported', checkedAt }] });
  assert.equal(unsupported.skipped, 1);
  assert.equal(reads, 0);
});
