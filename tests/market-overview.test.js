import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketOverview, updateMarketView } from '../src/utils/marketOverview.js';
import { isMarketOverview, isMarketAtlas } from '../src/utils/marketResearchValidation.js';
import { MARKET_VERSION, DEFAULT_MARKET_VIEW, metricStats, selectMarketCompanies, marketCsv, marketBrief } from '../src/utils/marketResearch.js';

function fixture() {
  const date = new Date().toISOString();
  const companies = [0, 1].map(i => ({ version: MARKET_VERSION, ticker: ['NEW', 'OLD'][i], name: `Company ${i}`,
    cik: String(i + 1).padStart(10, '0'), sic: '3500', observedAt: date, checkedAt: date, factsRetrievedAt: date,
    membershipFund: 'IVV', cohorts: ['theme'], researchGroup: { id: `sector-${i}`, label: `Sector ${i}` },
    metrics: { ttm: { revenueGrowth: i ? null : 12, netIncome: i ? -10 : 10 }, annual: { revenueGrowth: 5 } },
    reports: { annual: null, ttm: null }, evidence: { bulky: 'unused'.repeat(1000) },
    filingComparisons: { ttm: null, annual: null },
  }));
  const membership = { rows: [...companies.map(c => ({ ticker: c.ticker, sector: c.researchGroup.label })), { ticker: 'MISSING', sector: 'Sector 0' }] };
  return { membership, atlas: { version: MARKET_VERSION, generatedAt: date, requested: 3, companies,
    groups: companies.map(c => c.researchGroup),
    cohorts: [{ id: 'theme', label: 'Theme', title: 'Original theme', description: 'Selected issuers', disclosureTerms: 'theme', tickers: ['NEW', 'OLD'] }],
    coverage: { membership_id: 'membership-a', target_issuers: 3, loaded_issuers: 2, missing_issuers: 1,
      sources: [{ fund: 'IVV', as_of: date.slice(0, 10), url: 'https://example.test/holdings' }] },
    failures: [{ ticker: 'MISSING', reason: 'No compatible facts' }], observations: [], historyPersistence: true } };
}

test('Market shares issuer identities and metrics while sector totals and own denominators remain correct', () => {
  const { atlas, membership } = fixture();
  const overview = buildMarketOverview(atlas, { membership });
  assert.ok(isMarketOverview(overview)); assert.equal(isMarketAtlas(overview), false);
  assert.deepEqual(overview.companies.map(c => c.cik), atlas.companies.map(c => c.cik));
  assert.equal(overview.cohorts.reduce((n, c) => n + c.tickers.length, 0), overview.requested);
  assert.equal(overview.cohorts.reduce((n, c) => n + overview.companies.filter(r => r.cohorts.includes(c.id)).length, 0), 2);
  assert.deepEqual(metricStats(overview.companies, 'ttm', 'revenueGrowth'), metricStats(atlas.companies, 'ttm', 'revenueGrowth'));
  assert.equal(metricStats(overview.companies, 'ttm', 'revenueGrowth').count, 1);
  assert.ok(overview.companies.every(c => !('filingComparisons' in c) && !('evidence' in c)));
  assert.deepEqual(overview.themes[0].tickers, ['NEW', 'OLD']);
  assert.ok(JSON.stringify(overview).length < JSON.stringify(atlas).length / 2);
  assert.equal(isMarketOverview({ ...overview, coverage: { ...overview.coverage, sources: null } }), false);
  assert.equal(isMarketOverview({ ...overview, coverage: { ...overview.coverage, loaded_issuers: 3 } }), false);
  const overlap = structuredClone(overview); overlap.companies[0].cohorts.push('sector-1');
  assert.equal(isMarketOverview(overlap), false);
});

test('Heatmap selections, tab navigation and exports retain the expanded scope', () => {
  const { atlas, membership } = fixture(); const overview = buildMarketOverview(atlas, { membership });
  const selected = updateMarketView({ ...DEFAULT_MARKET_VIEW, tab: 'sectors' }, { tab: 'companies', cohort: 'sector-0' });
  const rows = selectMarketCompanies(overview.companies, selected, [], overview.generatedAt);
  assert.deepEqual(rows.map(r => r.ticker), ['NEW']);
  assert.equal(updateMarketView(selected, { tab: 'overview' }).cohort, 'sector-0');
  assert.equal(updateMarketView(selected, { tab: 'factors' }).cohort, 'sector-0');
  assert.equal(updateMarketView({ ...selected, cohort: 'theme' }, { tab: 'factors' }).cohort, 'all');
  const csv = marketCsv(rows, 'ttm', overview.generatedAt, overview);
  assert.equal(csv.split('\r\n').length, 2); assert.match(csv, /Primary sector/); assert.match(csv, /membership-a/);
  assert.match(marketBrief(rows, selected, overview, 'https://example.test/market'), /shared with Quant Lab/);
});

test('Public projection does not invent observations and scheduled history resets when membership changes', () => {
  const { atlas, membership } = fixture();
  assert.equal(buildMarketOverview(atlas, { membership }).observations.length, 0);
  const first = buildMarketOverview(atlas, { membership, persistHistory: true });
  const later = { ...atlas, generatedAt: new Date(Date.parse(atlas.generatedAt) + 86400000).toISOString() };
  assert.equal(buildMarketOverview(later, { membership, previous: first, persistHistory: true }).observations.length, 2);
  const changed = buildMarketOverview({ ...later, coverage: { ...atlas.coverage, membership_id: 'membership-b' } }, { membership, previous: first, persistHistory: true });
  assert.equal(changed.observations.length, 1); assert.match(changed.historyNote, /not market trends/);
  assert.equal(changed.generatedAt, later.generatedAt);
});

test('Published compact Market reads use shared storage without SEC or price requests', async () => {
  const priorFetch = globalThis.fetch, priorUrl = process.env.KV_REST_API_URL, priorToken = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_URL = 'https://cache.example.test'; process.env.KV_REST_API_TOKEN = 'test';
  const values = new Map(); let calls = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input); assert.equal(url.hostname, 'cache.example.test'); calls++;
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (url.pathname.startsWith('/get/')) return Response.json({ result: values.get(key) ?? null });
    if (url.pathname.startsWith('/set/')) { values.set(key, options.body); return Response.json({ result: 'OK' }); }
    throw Error('Unexpected source request');
  };
  try {
    const { publishMarketOverview, readMarketOverview } = await import('../src/utils/marketOverviewServer.js');
    const { atlas, membership } = fixture();
    await publishMarketOverview(atlas, membership);
    const result = await readMarketOverview(); assert.equal(result.companies.length, 2); assert.equal(result.observations.length, 1);
    const before = calls; await Promise.all([readMarketOverview(), readMarketOverview()]); assert.equal(calls, before);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = priorUrl;
    if (priorToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = priorToken;
  }
});
