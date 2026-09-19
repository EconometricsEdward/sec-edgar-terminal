import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { buildMarketBriefing, buildMarketDirectory, buildMarketIndustries, pageMarketDirectory, parseMarketDirectoryQuery } from '../src/utils/marketBriefing.js';
import { isMarketBriefing, isMarketDirectory, isMarketIndustries } from '../src/utils/marketResearchValidation.js';
import { buildMarketMacroSummary } from '../src/utils/marketMacroSummary.js';

function fixture(size = 5000) {
  const generatedAt = new Date().toISOString();
  const metrics = i => ({ revenueGrowth: i % 3 ? i % 17 - 3 : null, netMargin: i % 11 - 4,
    cashFlowMargin: i % 7, capexIntensity: i % 5, equityToAssets: i % 40, netIncome: i % 31 - 8 });
  return { generatedAt, version: 'market-research-v3', requested: size + 10,
    companies: Array.from({ length: size }, (_, i) => ({ ticker: i ? `T${i}` : 'AAPL',
      name: i ? `Example ${i}` : 'Apple Inc.', cik: String(i + 1).padStart(10, '0'), sic: i % 2 ? '6022' : '3571',
      observedAt: generatedAt, cohorts: [i % 2 ? 'sector-financials' : 'sector-technology'],
      sector: i % 2 ? 'Financials' : 'Technology', metrics: { ttm: metrics(i), annual: metrics(i + 2) },
      reports: { ttm: { end: '2026-06-30' }, annual: { end: '2025-12-31' } }, revenueBasis: 'Reported total revenue' })),
    cohorts: ['Technology', 'Financials'].map((label, i) => ({ id: i ? 'sector-financials' : 'sector-technology', label, targetKnown: false, tickers: [] })),
    failures: Array.from({ length: 10 }, (_, i) => ({ ticker: `M${i}`, reason: 'Pending SEC check' })),
  };
}

test('5,000-issuer briefing preserves exact aggregates without shipping company records or industry calculations', () => {
  const overview = fixture();
  const briefing = buildMarketBriefing(overview);
  assert.ok(isMarketBriefing(briefing));
  assert.equal(briefing.summaries.ttm.companyCount, 5000);
  assert.deepEqual(briefing.summaries.ttm.metrics, buildMarketMacroSummary(overview, 'ttm').metrics);
  assert.deepEqual(briefing.summaries.annual.metrics, buildMarketMacroSummary(overview, 'annual').metrics);
  assert.equal(briefing.failureCount, 10);
  assert.equal('companies' in briefing, false);
  assert.equal('metrics' in briefing.summaries.ttm.sectors[0].industries[0], false);
  assert.ok(gzipSync(JSON.stringify(briefing)).length < 6000);
  const invalid = structuredClone(briefing); invalid.summaries.ttm.sectors[0].metrics.netMargin.count = 6000;
  assert.equal(isMarketBriefing(invalid), false);
  assert.equal(isMarketBriefing({ ...briefing, summaries: { ttm: null, annual: {} } }), false);
});

test('industry details keep their own basis, source date and missing-data denominators', () => {
  const overview = fixture(); const data = buildMarketIndustries(overview);
  assert.ok(isMarketIndustries(data));
  const expected = buildMarketMacroSummary(overview, 'annual');
  assert.deepEqual(data.bases.annual[0].industries, expected.sectors[0].industries);
  assert.equal(data.generatedAt, overview.generatedAt);
  assert.notDeepEqual(data.bases.ttm[0].industries, data.bases.annual[0].industries);
});

test('directory pages stay at 50 identities, support name/ticker/sector search and stable paging across 5,000 companies', () => {
  const directory = buildMarketDirectory(fixture()); assert.ok(isMarketDirectory(directory));
  const first = pageMarketDirectory(directory); const next = pageMarketDirectory(directory, { page: 2 });
  assert.equal(first.total, 5000); assert.equal(first.companies.length, 50);
  assert.equal(next.page, 2); assert.equal(new Set([...first.companies, ...next.companies].map(c => c.cik)).size, 100);
  assert.ok(first.companies.every(c => !('metrics' in c) && !('reports' in c)));
  assert.equal(pageMarketDirectory(directory, { query: 'apple' }).companies[0].ticker, 'AAPL');
  assert.equal(pageMarketDirectory(directory, { query: 't11' }).companies[0].ticker, 'T11');
  assert.equal(pageMarketDirectory(directory, { sector: 'sector-financials' }).total, 2500);
  assert.equal(pageMarketDirectory(directory, { query: 'no company matches' }).total, 0);
  assert.equal(pageMarketDirectory(directory, { page: 9999 }).page, 100);
  assert.equal(pageMarketDirectory({ ...directory, companies: [{ ticker: 'BRK-B', cik: '0001067983', name: 'Berkshire Hathaway', sector: 'Financials', sectorId: 'sector-financials' }] }, { query: 'brk.b' }).companies[0].ticker, 'BRK-B');
});

test('invalid and unbounded directory requests are rejected before storage work', () => {
  assert.deepEqual(parseMarketDirectoryQuery(new URLSearchParams('query=%20APPLE%20%20Inc.&page=2')), { query: 'apple inc.', sector: 'all', page: 2 });
  for (const query of ['page=-1', 'page=1&page=2', 'limit=5000', 'query=' + 'a'.repeat(101), 'sector=../all', 'page=99999']) {
    assert.throws(() => parseMarketDirectoryQuery(new URLSearchParams(query)));
  }
});

test('prepared projections publish with source dates, retain newer versions and need no SEC fetch on public reads', async () => {
  const { publishMarketServingViews, readMarketServingView } = await import('../src/utils/marketBriefingServer.js');
  const overview = fixture(20), saved = new Map(); let writes = 0, releases = 0;
  const dependencies = { mode: 'supabase', begin: async () => ({ generation: '1' }),
    read: async (dataset, key) => { assert.equal(dataset, 'financial'); return saved.get(key) || null; },
    publish: async ({ key, payload, metadata }) => { writes++; saved.set(key, { payload, metadata }); },
    release: async () => { releases++; }, fallback: async () => { throw new Error('Public read should use prepared projection.'); } };
  await publishMarketServingViews(overview, dependencies);
  assert.equal(writes, 3);
  const briefing = await readMarketServingView('briefing', dependencies);
  assert.equal(briefing.generatedAt, overview.generatedAt); assert.equal(briefing.summaries.ttm.companyCount, 20);
  await publishMarketServingViews({ ...overview, generatedAt: new Date(Date.parse(overview.generatedAt) - 60000).toISOString() }, dependencies);
  assert.equal(writes, 3); assert.equal(releases, 3);
  assert.equal((await readMarketServingView('briefing', dependencies)).generatedAt, overview.generatedAt);
});
