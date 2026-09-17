import test from 'node:test';
import assert from 'node:assert/strict';
import { revenueCorrectionPriority, recalculatePreparedMarketRevenue, withholdUncorrectedRevenue } from '../src/utils/marketRevenueCorrections.js';
import { refreshQuantRevenueCorrections, applyPreparedRevenueCorrections } from '../src/utils/quantCoverageServer.js';
import { MARKET_REVENUE_VERSION } from '../src/utils/marketResearchData.js';

const date = '2026-09-17T09:00:00.000Z';
const company = (extra = {}) => ({ version: 'market-research-v3', ticker: 'IBKR', cik: '0001381197', name: 'Broker', sic: '6211',
  observedAt: date, cohorts: ['sector-financials'], metrics: { annual: { revenue: 10, netMargin: 200, netIncome: 20, totalAssets: 500 }, ttm: {} },
  reports: { annual: null, ttm: null }, filingComparisons: { annual: null, ttm: null }, ...extra });
const documents = () => ({
  facts: { payload: { cik: 1381197, facts: { 'us-gaap': { RevenuesNetOfInterestExpense: { units: { USD: [
    { val: 100, start: '2025-01-01', end: '2025-12-31', fy: 2025, fp: 'FY', form: '10-K', filed: '2026-02-27', accn: '0001381197-26-000062' },
  ] } }, Assets: { units: { USD: [
    { val: 500, end: '2025-12-31', fy: 2025, fp: 'FY', form: '10-K', filed: '2026-02-27', accn: '0001381197-26-000062' },
  ] } } } } } },
  submissions: { payload: { cik: '0001381197', sic: '6211', name: 'Broker', filings: { recent: {} } } },
});

test('source corrections prioritize audited issuers, cover affected industries, and become idempotent', () => {
  assert.equal(revenueCorrectionPriority(company({ cik: '0000906345', ticker: 'CPT' })), 0);
  assert.equal(revenueCorrectionPriority(company()), 1);
  assert.equal(revenueCorrectionPriority(company({ cik: '0001035983', sic: '1700', ticker: 'FIX' })), 2);
  assert.equal(revenueCorrectionPriority(company({ cik: '4', sic: '6798' })), 3);
  assert.equal(revenueCorrectionPriority(company({ cik: '5', sic: '3571' })), null);
  assert.equal(revenueCorrectionPriority(company({ cik: '5', sic: '6500' })), null);
  assert.equal(revenueCorrectionPriority(company({ revenueVersion: MARKET_REVENUE_VERSION })), null);
});

test('missing correction inputs withhold revenue ratios while preserving earnings, assets, and source dates', () => {
  const old = company();
  const withheld = withholdUncorrectedRevenue(old);
  assert.equal(withheld.metrics.annual.revenue, null);
  assert.equal(withheld.metrics.annual.netMargin, null);
  assert.equal(withheld.metrics.annual.netIncome, 20);
  assert.equal(withheld.metrics.annual.totalAssets, 500);
  assert.equal(withheld.revenueQuality, 'awaiting-compatible-source');
  assert.equal(withheld.observedAt, date);
  assert.equal(old.metrics.annual.revenue, 10);
});

test('prepared correction rejects another issuer and preserves original observation clocks', () => {
  const { facts, submissions } = documents();
  const corrected = recalculatePreparedMarketRevenue(company(), facts, submissions);
  assert.equal(corrected.metrics.annual.revenue, 100);
  assert.equal(corrected.observedAt, date);
  assert.equal(corrected.revenueVersion, MARKET_REVENUE_VERSION);
  assert.throws(() => recalculatePreparedMarketRevenue(company(), facts, { payload: { ...submissions.payload, cik: '7' } }), /unavailable/);
});

test('prepared correction reports actual source timestamps and refuses an older financial period', () => {
  const { facts, submissions } = documents();
  facts.metadata = { fetchedAt: '2026-09-17T11:00:00.000Z' };
  submissions.metadata = { fetchedAt: '2026-09-16T10:00:00.000Z', revalidatedAt: '2026-09-17T12:00:00.000Z' };
  const corrected = recalculatePreparedMarketRevenue(company(), facts, submissions);
  assert.equal(corrected.observedAt, facts.metadata.fetchedAt);
  assert.equal(corrected.factsRetrievedAt, facts.metadata.fetchedAt);
  assert.equal(corrected.checkedAt, submissions.metadata.revalidatedAt);
  assert.throws(() => recalculatePreparedMarketRevenue(company({ reports: { annual: { end: '2026-06-30' }, ttm: null } }), facts, submissions), /older/);
});

test('deployment correction updates checkpoints for the separately leased final publisher', async () => {
  const old = company({ checkedAt: date, factsRetrievedAt: '2026-09-10T06:00:00.000Z' });
  const record = { company: old, checkedAt: old.checkedAt, factsRetrievedAt: old.factsRetrievedAt, fingerprint: 'original' };
  const { facts, submissions } = documents();
  facts.metadata = { fetchedAt: record.factsRetrievedAt, revalidatedAt: date };
  submissions.metadata = { fetchedAt: date, revalidatedAt: date };
  const reads = [], writes = [], releases = [];
  const result = await refreshQuantRevenueCorrections({
    readAtlas: async () => ({ generatedAt: date, companies: [old] }), read: async () => record,
    write: async (...args) => { writes.push(args); return true; },
    prepared: async path => { reads.push(path); return path.includes('companyfacts') ? facts : submissions; },
    acquire: async () => 'lease', release: async (...args) => { releases.push(args); },
  });
  assert.equal(result.corrected, 1);
  assert.equal(result.withheld, 0);
  assert.equal(result.remaining, 0);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(path => path.includes('CIK0001381197.json')));
  assert.equal(writes[0][2].company.metrics.annual.revenue, 100);
  assert.equal(writes[0][2].checkedAt, record.checkedAt);
  assert.equal(writes[0][2].factsRetrievedAt, record.factsRetrievedAt);
  assert.equal(releases.length, 1);
  const published = await applyPreparedRevenueCorrections({ generatedAt: date, companies: [old] }, { readMany: async () => [writes[0][2]] });
  assert.equal(published.companies[0].metrics.annual.revenue, 100);
  assert.equal(published.companies[0].observedAt, facts.metadata.fetchedAt);
});

test('deployment correction withholds stale mappings when prepared source storage misses', async () => {
  let checkpoint;
  const result = await refreshQuantRevenueCorrections({
    readAtlas: async () => ({ generatedAt: date, companies: [company()] }),
    read: async () => ({ company: company(), checkedAt: date }),
    write: async (_type, _id, value) => { checkpoint = value; return true; }, prepared: async () => null,
    acquire: async () => 'lease', release: async () => {},
  });
  assert.equal(result.withheld, 1);
  assert.equal(checkpoint.needsReconciliation, true);
  assert.equal(checkpoint.company.metrics.annual.revenue, null);
  assert.equal(checkpoint.company.metrics.annual.netIncome, 20);
});

test('deployment correction respects active shard refreshes and a newer corrected checkpoint', async () => {
  let requests = 0;
  const skipped = await refreshQuantRevenueCorrections({ readAtlas: async () => ({ companies: [company()] }),
    acquire: async () => null, prepared: async () => { requests++; } });
  assert.equal(skipped.skipped, 1);
  assert.equal(skipped.remaining, 1);
  const newer = company({ revenueVersion: MARKET_REVENUE_VERSION, metrics: { annual: { revenue: 123 }, ttm: {} } });
  const reused = await refreshQuantRevenueCorrections({ readAtlas: async () => ({ companies: [company()] }),
    read: async () => ({ company: newer }), acquire: async () => 'lease', release: async () => {},
    prepared: async () => { requests++; } });
  assert.equal(reused.corrected, 1);
  assert.equal(requests, 0);
  assert.equal(reused.audited[0].annualRevenue, 123);
});

test('prepared recalculation refuses source documents older than the checked checkpoint', () => {
  const { facts, submissions } = documents();
  facts.metadata = { fetchedAt: '2026-09-15T00:00:00.000Z' };
  submissions.metadata = { revalidatedAt: date };
  assert.throws(() => recalculatePreparedMarketRevenue(company({ factsRetrievedAt: date, checkedAt: date }), facts, submissions), /predate/);
  facts.metadata.revalidatedAt = date;
  assert.equal(recalculatePreparedMarketRevenue(company({ factsRetrievedAt: date, checkedAt: date }), facts, submissions).revenueVersion, MARKET_REVENUE_VERSION,
    'a revalidated identical older source document is still current evidence');
});

test('final publisher preserves newer atlas data and membership when old corrections finish late', async () => {
  const newerDate = '2026-09-17T14:00:00.000Z';
  const latest = { generatedAt: newerDate, coverage: { membership_id: 'new-membership' },
    companies: [company({ checkedAt: newerDate, metrics: { annual: { revenue: 999 }, ttm: {} } })] };
  const oldCorrection = { checkedAt: date, company: company({ revenueVersion: MARKET_REVENUE_VERSION, metrics: { annual: { revenue: 123 }, ttm: {} } }) };
  const retained = await applyPreparedRevenueCorrections(latest, { readMany: async () => [oldCorrection] });
  assert.equal(retained, latest);
  assert.equal(retained.companies[0].metrics.annual.revenue, 999);
  const updated = { ...oldCorrection, checkedAt: newerDate };
  const merged = await applyPreparedRevenueCorrections(latest, { readMany: async () => [updated] });
  assert.equal(merged.coverage.membership_id, 'new-membership');
  assert.equal(merged.companies[0].metrics.annual.revenue, 123);
});

test('final publisher rejects older or invalid facts clocks despite a newer submissions check', async () => {
  const latest = { generatedAt: date, companies: [company({ checkedAt: date, factsRetrievedAt: date })] };
  const corrected = company({ revenueVersion: MARKET_REVENUE_VERSION });
  for (const factsRetrievedAt of ['2026-09-16T12:00:00.000Z', 'invalid', undefined]) {
    const record = { company: corrected, checkedAt: '2026-09-17T14:00:00.000Z', factsRetrievedAt };
    assert.equal(await applyPreparedRevenueCorrections(latest, { readMany: async () => [record] }), latest);
  }
  const revalidated = { company: corrected, checkedAt: date, factsRetrievedAt: '2026-09-15T12:00:00.000Z', factsValidatedAt: date };
  const merged = await applyPreparedRevenueCorrections(latest, { readMany: async () => [revalidated] });
  assert.equal(merged.companies[0].factsRetrievedAt, revalidated.factsRetrievedAt, 'actual fetch time is not replaced with validation time');
  assert.equal(merged.companies[0].factsValidatedAt, date);
  assert.equal(merged.companies[0].revenueVersion, MARKET_REVENUE_VERSION);
});
