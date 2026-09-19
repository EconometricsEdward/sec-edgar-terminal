import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { buildMarketSectorCompanies, parseMarketSectorCompaniesQuery, pageMarketSectorCompanies,
  MARKET_SECTOR_COMPANY_METRICS } from '../src/utils/marketSectorCompanies.js';
import { isMarketSectorCompanies, isMarketSectorCompaniesPage } from '../src/utils/marketResearchValidation.js';
import { buildMarketMacroSummary } from '../src/utils/marketMacroSummary.js';

function fixture(size = 5000) {
  const generatedAt = new Date().toISOString();
  const labels = ['Technology', 'Financials'];
  return { generatedAt, requested: size, failures: [], version: 'market-research-v3',
    cohorts: labels.map(label => ({ id: `sector-${label.toLowerCase()}`, label, tickers: [] })),
    companies: Array.from({ length: size }, (_, i) => ({ ticker: `T${String(i).padStart(4, '0')}`,
      name: `Example issuer ${i}`, cik: String(i + 1), sic: i % 2 ? '6022' : '3571',
      sector: labels[i % 2], cohorts: [`sector-${labels[i % 2].toLowerCase()}`], observedAt: generatedAt,
      revenueBasis: 'Reported total revenue', evidence: { ttm: ['large source history excluded'] },
      metrics: Object.fromEntries(['ttm', 'annual'].map(basis => [basis, Object.fromEntries(
        MARKET_SECTOR_COMPANY_METRICS.map(key => [key, key === 'interestCoverage' ? null : i + (basis === 'annual' ? 100 : 0)]),
      )])),
      reports: Object.fromEntries(['ttm', 'annual'].map(basis => [basis, { end: basis === 'ttm' ? '2026-06-30' : '2025-12-31',
        filed: '2026-08-01', form: '10-Q', accession: `${String(i + 1).padStart(10, '0')}-26-000001`, other: 'excluded' }])),
    })),
  };
}
const selection = overrides => ({ sector: 'sector-technology', basis: 'ttm', query: '', sort: 'revenueGrowth', direction: 'desc', page: 1, ...overrides });

test('5,000-company serving projection preserves sector membership and both bases with only scalar metrics and dates', () => {
  const overview = fixture(), snapshot = buildMarketSectorCompanies(overview);
  assert.ok(isMarketSectorCompanies(snapshot));
  assert.equal(snapshot.companies.length, 5000);
  for (const sector of buildMarketMacroSummary(overview).sectors) {
    assert.equal(snapshot.companies.filter(company => company.sectorId === sector.id).length, sector.count);
  }
  const source = overview.companies[4], company = snapshot.companies[4];
  assert.deepEqual(company.metrics, source.metrics);
  assert.equal(company.reports.ttm.end, '2026-06-30');
  assert.equal(company.reports.annual.end, '2025-12-31');
  assert.equal('evidence' in company, false); assert.equal('other' in company.reports.ttm, false);
  assert.ok(gzipSync(JSON.stringify(snapshot)).length < 750000);
  assert.equal(snapshot.generatedAt, overview.generatedAt);
});

test('metrics rank the entire selected sector before pagination and ranges use every matching company', () => {
  const snapshot = buildMarketSectorCompanies(fixture());
  const first = pageMarketSectorCompanies(snapshot, selection());
  const next = pageMarketSectorCompanies(snapshot, selection({ page: 2 }));
  assert.ok(isMarketSectorCompaniesPage(first, selection()));
  assert.equal(first.companies.length, 25); assert.equal(first.total, 2500); assert.equal(first.sectorTotal, 2500);
  assert.equal(first.availableCount, 2500); assert.deepEqual(first.range, { min: 0, max: 4998, median: 2499 });
  assert.equal(first.companies[0].ticker, 'T4998'); assert.equal(next.companies[0].ticker, 'T4948');
  assert.equal(new Set([...first.companies, ...next.companies].map(company => company.cik)).size, 50);
  assert.equal(pageMarketSectorCompanies(snapshot, selection({ page: 9999 })).page, 100);
  const annual = pageMarketSectorCompanies(snapshot, selection({ basis: 'annual' }));
  assert.equal(annual.companies[0].metrics.revenueGrowth, 5098);
  assert.equal(annual.companies[0].report.end, '2025-12-31');
  assert.equal(pageMarketSectorCompanies(snapshot, selection({ sector: 'sector-financials' })).companies[0].ticker, 'T4999');
});

test('nulls stay last in both directions, zeros and negatives remain data, and ties are stable by ticker', () => {
  const overview = fixture(8);
  [null, 3, 0, -2].forEach((value, i) => { overview.companies[i * 2].metrics.ttm.netMargin = value; });
  const snapshot = buildMarketSectorCompanies(overview);
  const desc = pageMarketSectorCompanies(snapshot, selection({ sort: 'netMargin' }));
  const asc = pageMarketSectorCompanies(snapshot, selection({ sort: 'netMargin', direction: 'asc' }));
  assert.deepEqual(desc.companies.map(company => company.metrics.netMargin), [3, 0, -2, null]);
  assert.deepEqual(asc.companies.map(company => company.metrics.netMargin), [-2, 0, 3, null]);
  assert.equal(desc.availableCount, 3); assert.deepEqual(desc.range, { min: -2, max: 3, median: 0 });
  snapshot.companies.forEach(company => { company.metrics.ttm.netMargin = 2; });
  assert.deepEqual(pageMarketSectorCompanies(snapshot, selection({ sort: 'netMargin' })).companies.map(company => company.ticker), ['T0000', 'T0002', 'T0004', 'T0006']);
  const missing = pageMarketSectorCompanies(snapshot, selection({ sort: 'interestCoverage' }));
  assert.equal(missing.availableCount, 0); assert.equal(missing.range, null); assert.equal(missing.total, 4);
});

test('name and share-class ticker searches stay within the selected sector and bind returned ranges to matches', () => {
  const overview = fixture(6); overview.companies[0].ticker = 'BRK-B'; overview.companies[0].name = 'Berkshire Hathaway Inc.';
  const snapshot = buildMarketSectorCompanies(overview);
  for (const query of ['berkshire', 'brk.b', 'brk-b', 'berkshire hathaway']) {
    const page = pageMarketSectorCompanies(snapshot, selection({ query }));
    assert.equal(page.total, 1); assert.equal(page.sectorTotal, 3); assert.equal(page.companies[0].ticker, 'BRK-B');
    assert.deepEqual(page.range, { min: 0, max: 0, median: 0 });
  }
  const none = pageMarketSectorCompanies(snapshot, selection({ query: 'no matching company', page: 9 }));
  assert.equal(none.total, 0); assert.equal(none.page, 1); assert.equal(none.range, null);
  assert.ok(isMarketSectorCompaniesPage(none, selection({ query: 'no matching company', page: 9 })));
  assert.throws(() => pageMarketSectorCompanies(snapshot, selection({ sector: 'sector-not-present' })), { status: 404 });
});

test('legacy prepared data retains absent risks as null and does not invent filing or metric inputs', () => {
  const overview = fixture(2);
  overview.companies[0].metrics.ttm = { revenueGrowth: 0, netMargin: '12', cashToAssets: Infinity };
  overview.companies[0].reports.ttm = { end: '2026-06-30' };
  overview.companies[1].reports.annual = null;
  const snapshot = buildMarketSectorCompanies(overview);
  assert.ok(isMarketSectorCompanies(snapshot));
  assert.equal(snapshot.companies[0].metrics.ttm.revenueGrowth, 0);
  assert.equal(snapshot.companies[0].metrics.ttm.netMargin, null);
  assert.equal(snapshot.companies[0].metrics.ttm.debtToAssets, null);
  assert.equal(snapshot.companies[0].metrics.ttm.cashToAssets, null);
  assert.deepEqual(snapshot.companies[0].reports.ttm, { end: '2026-06-30', filed: null, form: null, accession: null });
  assert.equal(snapshot.companies[1].reports.annual, null);
});

test('duplicate issuer aliases share one sector row and classification follows the briefing label', () => {
  const overview = fixture(4); overview.companies[0].sector = 'Financials';
  overview.companies.push({ ...overview.companies[0], ticker: 'ALIAS', cik: '0000000001' });
  const snapshot = buildMarketSectorCompanies(overview);
  assert.equal(snapshot.companies.length, 4);
  for (const sector of buildMarketMacroSummary(overview).sectors) {
    assert.equal(snapshot.companies.filter(company => company.sectorId === sector.id).length, sector.count);
  }
});

test('strict requests reject unexpected or unbounded controls before any data retrieval', () => {
  assert.deepEqual(parseMarketSectorCompaniesQuery(new URLSearchParams('sector=sector-technology&query=%20Apple%20%20Inc.%20')), selection({ query: 'apple inc.' }));
  for (const query of ['', 'sector=all', 'sector=sector-technology&limit=5000', 'sector=sector-technology&page=-1',
    'sector=sector-technology&page=99999', 'sector=sector-technology&basis=quarter', 'sector=sector-technology&sort=creditScore',
    'sector=sector-technology&direction=random', 'sector=sector-technology&sector=sector-financials',
    'sector=sector-technology&query=' + 'a'.repeat(101)]) {
    assert.throws(() => parseMarketSectorCompaniesQuery(new URLSearchParams(query)));
  }
});

test('response validation rejects mismatched requests, broken counts, invalid sources and metric payloads', () => {
  const snapshot = buildMarketSectorCompanies(fixture(60));
  const page = pageMarketSectorCompanies(snapshot, selection());
  assert.ok(isMarketSectorCompaniesPage(page, selection()));
  assert.equal(isMarketSectorCompaniesPage(page, selection({ basis: 'annual' })), false);
  assert.equal(isMarketSectorCompaniesPage(page, selection({ sector: 'sector-financials' })), false);
  assert.equal(isMarketSectorCompaniesPage(page, selection({ page: 2 })), false);
  assert.equal(isMarketSectorCompaniesPage({ ...page, availableCount: 999 }, selection()), false);
  assert.equal(isMarketSectorCompaniesPage({ ...page, range: { min: 5, median: 2, max: 10 } }), false);
  const broken = structuredClone(page); broken.companies[0].report.accession = 'https://example.com';
  assert.equal(isMarketSectorCompaniesPage(broken), false);
  broken.companies[0].report.accession = null; broken.companies[0].metrics.currentRatio = undefined;
  assert.equal(isMarketSectorCompaniesPage(broken), false);
  const tickerPage = pageMarketSectorCompanies(snapshot, selection({ sort: 'ticker', direction: 'asc' }));
  assert.ok(isMarketSectorCompaniesPage(tickerPage)); assert.equal(tickerPage.range, null);
});

test('public sector API uses a prepared shared projection, returns only 25 rows, and rejects invalid selections', async () => {
  const { publishMarketServingViews } = await import('../src/utils/marketBriefingServer.js');
  const { GET } = await import('../src/app/api/market-sector-companies/route.js');
  const overview = fixture(80);
  await publishMarketServingViews(overview, { mode: 'off' });
  const response = await GET(new Request('http://localhost/api/market-sector-companies?sector=sector-technology&sort=netMargin'));
  assert.equal(response.status, 200); assert.match(response.headers.get('Cache-Control'), /s-maxage=900/);
  assert.equal(response.headers.get('X-SEC-Snapshot-At'), overview.generatedAt);
  const body = await response.json(); assert.ok(isMarketSectorCompaniesPage(body));
  assert.equal(body.companies.length, 25); assert.equal(body.total, 40);
  assert.equal((await GET(new Request('http://localhost/api/market-sector-companies?sector=sector-missing'))).status, 404);
  assert.equal((await GET(new Request('http://localhost/api/market-sector-companies?sector=sector-technology&limit=5000'))).status, 400);
});
