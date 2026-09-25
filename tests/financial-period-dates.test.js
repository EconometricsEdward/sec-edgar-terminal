import test from 'node:test';
import assert from 'node:assert/strict';
import { validFinancialPeriodDates } from '../src/utils/financialPeriodDates.js';
import { reportingPeriods, selectFinancialFact } from '../src/utils/xbrlPeriods.js';
import { buildMarketBriefing, buildMarketIndustries } from '../src/utils/marketBriefing.js';
import { buildMarketSectorCompanies } from '../src/utils/marketSectorCompanies.js';
import { readMarketServingView } from '../src/utils/marketBriefingServer.js';
import { preparedEnvelopeUsable } from '../src/utils/secDocumentStore.js';
import { hasInvalidMarketPeriods, sanitizeMarketOverviewPeriods, MARKET_PERIOD_INTEGRITY_VERSION } from '../src/utils/marketPeriodIntegrity.js';
import { needsFactsRefresh, quantCheckpointFresh } from '../src/utils/quantCoverageServer.js';
import { MARKET_REVENUE_VERSION, MARKET_RISK_VERSION } from '../src/utils/marketResearchData.js';

test('historical dates reject impossible contexts without interpreting fiscal-year labels as calendar years', () => {
  const valid = { start: '2026-01-01', end: '2026-03-31', filed: '2026-05-13', fy: 2027 };
  assert.equal(validFinancialPeriodDates(valid), true);
  assert.equal(validFinancialPeriodDates({ end: '2024-02-29' }), true);
  for (const period of [null, { end: '2025-02-29' }, { end: '2026-02-30' },
    { ...valid, end: '2026-12-31' }, { ...valid, start: '2026-04-01' }, { ...valid, filed: 'invalid' }]) {
    assert.equal(validFinancialPeriodDates(period), false);
  }
});

test('a future anchor in the same SEC filing cannot replace the actual reporting quarter or supply a metric', () => {
  const entry = { val: 100, start: '2026-01-01', end: '2026-03-31', filed: '2026-05-13',
    fy: 2026, fp: 'Q1', form: '10-Q', accn: '0001493152-26-022633' };
  const data = { 'us-gaap': {
    NetIncomeLoss: { units: { USD: [entry, { ...entry, end: '2026-12-31', val: 575611 }] } },
    Assets: { units: { USD: [{ ...entry, start: undefined, val: 1000 },
      { ...entry, start: undefined, end: '2026-12-31', val: 9000 }] } },
  } };
  const periods = reportingPeriods(data, 'quarter');
  assert.equal(periods.length, 1);
  assert.equal(periods[0].end, '2026-03-31');
  assert.equal(selectFinancialFact(data, ['NetIncomeLoss'], periods[0]).value, 100);
  assert.equal(selectFinancialFact(data, ['Assets'], { ...periods[0], end: '2026-12-31' }), null);
});

function overviewFixture() {
  const generatedAt = new Date().toISOString();
  const companies = [0, 1].map(i => ({ ticker: i ? 'GOOD' : 'HVII', name: 'Example issuer',
    cik: String(i + 1).padStart(10, '0'), sic: '6770', observedAt: generatedAt,
    revenueVersion: MARKET_REVENUE_VERSION, riskVersion: MARKET_RISK_VERSION,
    cohorts: ['sector-financials'], sector: 'Financials',
    reports: { annual: { end: '2025-12-31', filed: '2026-03-01' },
      ttm: { end: i ? '2026-03-31' : '2026-12-31', filed: '2026-05-13' } },
    metrics: { annual: { netIncome: 15, revenue: 100 }, ttm: { netIncome: i ? -10 : 575611, revenue: 200 } },
  }));
  return { version: 'market-research-v3', generatedAt, requested: 2, companies,
    cohorts: [{ id: 'sector-financials', label: 'Financials', targetKnown: false, tickers: ['HVII', 'GOOD'] }], failures: [] };
}

test('legacy snapshots withhold only the invalid basis and exclude it from every current aggregate', () => {
  const original = overviewFixture(), clean = sanitizeMarketOverviewPeriods(original);
  assert.equal(hasInvalidMarketPeriods(original.companies[0]), true);
  assert.equal(hasInvalidMarketPeriods(clean.companies[0]), false);
  assert.equal(clean.companies[1], original.companies[1]);
  assert.equal(clean.companies[0].reports.annual, original.companies[0].reports.annual);
  assert.equal(clean.companies[0].metrics.annual.netIncome, 15);
  assert.equal(clean.companies[0].reports.ttm, null);
  assert.deepEqual(clean.companies[0].metrics.ttm, { netIncome: null, revenue: null });
  assert.equal(original.companies[0].metrics.ttm.netIncome, 575611, 'cached input is immutable');
  const briefing = buildMarketBriefing(original);
  assert.equal(briefing.summaries.ttm.companyCount, 2);
  assert.equal(briefing.summaries.ttm.profit.count, 1);
  assert.equal(briefing.summaries.ttm.profit.positive, 0);
  assert.equal(briefing.summaries.ttm.reportRange.latest, '2026-03-31');
  assert.equal(buildMarketIndustries(original).bases.ttm[0].industries[0].metrics.netIncome.count, 1);
  const sector = buildMarketSectorCompanies(original).companies.find(company => company.ticker === 'HVII');
  assert.equal(sector.reports.ttm, null);
  assert.ok(Object.values(sector.metrics.ttm).every(value => value === null));
});

test('old prepared aggregates are rebuilt locally from existing data even when their timestamp is still fresh', async () => {
  const overview = overviewFixture();
  const legacy = buildMarketBriefing(overview);
  delete legacy.periodIntegrityVersion;
  const envelope = { payload: legacy, metadata: { fetchedAt: overview.generatedAt, revalidatedAt: overview.generatedAt,
    expiresAt: new Date(Date.now() + 3600000).toISOString() } };
  assert.equal(preparedEnvelopeUsable(envelope), true);
  let fallbackCalls = 0;
  const result = await readMarketServingView('briefing', { mode: 'supabase', read: async () => envelope,
    fallback: async () => { fallbackCalls++; return overview; } });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.periodIntegrityVersion, MARKET_PERIOD_INTEGRITY_VERSION);
  assert.equal(result.summaries.ttm.reportRange.latest, '2026-03-31');
});

test('only invalid company checkpoints become due for recalculation before their normal refresh', () => {
  const overview = overviewFixture();
  const record = { company: overview.companies[0], fingerprint: 'unchanged', checkedAt: overview.generatedAt,
    factsRetrievedAt: overview.generatedAt };
  assert.equal(quantCheckpointFresh(record), false);
  assert.equal(needsFactsRefresh(record, 'unchanged'), true);
  const good = { ...record, company: overview.companies[1] };
  assert.equal(quantCheckpointFresh(good), true);
  assert.equal(needsFactsRefresh(good, 'unchanged'), false);
});
