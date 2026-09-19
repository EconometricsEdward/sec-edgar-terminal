import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketReport, createMarketReportLoader, createNativeMarketCftcReader } from '../src/utils/marketReport.js';
import { MARKET_METRICS } from '../src/utils/marketResearch.js';
import { CFTC_FAMILIES, CFTC_REPORT_BASIS, CFTC_SCHEMA_VERSION, normalizeCftcRow, cftcCatalog } from '../src/utils/cftc.js';

const CLOCK = '2026-09-19T18:00:00.000Z';
const section = (report, id) => report.sections.find(row => row.id === id);
function company(ticker, id, sector, growth, margin) {
  const metrics = Object.fromEntries(MARKET_METRICS.map(metric => [metric.key, 10]));
  return { ticker, cik: String(id).padStart(10, '0'), name: `Company ${ticker}`, sector, sic: 7372,
    cohorts: [`sector-${sector.toLowerCase()}`, 'overlap-theme'],
    metrics: { annual: { ...metrics, revenueGrowth: growth + 1, netMargin: margin }, ttm: { ...metrics, revenueGrowth: growth, netMargin: margin } },
    reports: { annual: { end: '2025-12-31', filed: '2026-02-15', accession: `${String(id).padStart(10, '0')}-26-000001`, form: '10-K' },
      ttm: { end: '2026-06-30', filed: '2026-08-15', accession: `${String(id).padStart(10, '0')}-26-000002`, form: '10-Q' } },
    observedAt: '2026-09-19T10:00:00Z' };
}
function overview() {
  return { generatedAt: '2026-09-19T10:00:00Z', requested: 4,
    companies: [company('A', 1, 'Technology', 10, 20), company('B', 2, 'Technology', -4, null),
      company('C', 3, 'Industrials', 0, 10), company('D', 4, 'Industrials', null, 30)],
    cohorts: [{ id: 'sector-technology', label: 'Technology', tickers: ['A', 'B'] },
      { id: 'sector-industrials', label: 'Industrials', tickers: ['C', 'D'] },
      { id: 'overlap-theme', label: 'Overlapping theme', tickers: ['A', 'B', 'C', 'D'] }], failures: [] };
}
function cftc(family = 'tff', date = '2026-09-15', extraCatalog = true) {
  const definition = CFTC_FAMILIES[family], code = family === 'tff' ? '13874A' : '067651';
  const raw = { id: `${family}-source-row`, market_and_exchange_names: `${family} market - TEST EXCHANGE`, contract_market_name: `${family} contract`,
    report_date_as_yyyy_mm_dd: date, cftc_contract_market_code: code, cftc_market_code: 'TEST', contract_units: 'TEST CONTRACT UNITS', futonly_or_combined: 'FutOnly', open_interest_all: '500' };
  definition.groups.forEach((group, index) => {
    raw[group.long] = index === 2 ? '150' : index === 0 ? '50' : '100';
    raw[group.short] = index === 2 ? '50' : index === 0 ? '150' : '100';
    if (group.spread) raw[group.spread] = '0';
  });
  const position = normalizeCftcRow(raw, family).value;
  const original = structuredClone(position);
  for (const group of Object.values(position.groups)) Object.assign(group, { oneWeekChange: 25, oneWeekNetPctChange: 1.25,
    fourWeekChange: null, fourWeekNetPctChange: null });
  const catalog = cftcCatalog([original, ...(extraCatalog ? [normalizeCftcRow({ ...raw, cftc_contract_market_code: '999999', contract_market_name: 'Additional nonlaunch market' }, family).value] : [])], family);
  return { schema_version: CFTC_SCHEMA_VERSION, report_family: family, report_basis: CFTC_REPORT_BASIS, report_date: date,
    retrieved_at: '2026-09-18T22:30:00Z', status: 'ready', source: { url: definition.sourceUrl, dataset_id: definition.datasetId },
    freshness: { source_currency: 'current', cache_status: 'prepared' }, catalog, latest: [position], coverage: { catalog_rows: catalog.length, reconciliation_differences: 0 } };
}
const build = (fields = {}, options = {}) => buildMarketReport({ overview: overview(), cftcFamilies: [cftc(), cftc('disaggregated')], ...fields }, { generatedAt: CLOCK, ...options });

test('market report compares every distinct covered issuer using disjoint sector medians and valid-value counts', () => {
  const report = build();
  assert.deepEqual(report.entity, { id: 'MARKET', name: 'Market overview', cik: '' });
  assert.equal(report.kind, 'market'); assert.equal(report.period.basis, 'ttm');
  const rows = section(report, 'sector-performance').rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + row.companies, 0), 4);
  const technology = rows.find(row => row.sector === 'Technology');
  assert.equal(technology.growth, 0.03); assert.equal(technology.growthN, 2);
  assert.equal(technology.margin, 0.2); assert.equal(technology.marginN, 1);
  assert.equal(report.summary.find(row => row.label === 'Median revenue growth').value, 0);
  assert.ok(Math.abs(report.summary.find(row => row.label === 'Positive revenue growth').value - 1 / 3) < 1e-14);
  assert.equal(section(report, 'market-companies').rows.length, 4);
  assert.match(section(report, 'sector-performance').description, /No stock-price returns/);
  assert.ok(report.notes.some(note => note.includes('unweighted medians')));
});

test('annual and TTM stay separate; null metrics and missing reporting dates never become zero', () => {
  const annual = build({}, { basis: 'annual' });
  assert.equal(annual.period.basis, 'annual');
  assert.equal(section(annual, 'sector-performance').rows.find(row => row.sector === 'Technology').growth, 0.04);
  const data = overview(); data.companies[0].reports.ttm = null;
  data.companies[1].metrics.ttm.revenueGrowth = '20';
  const report = build({ overview: data });
  const a = section(report, 'market-companies').rows.find(row => row.ticker === 'A');
  assert.equal(a.revenueGrowth, null); assert.equal(a.periodEnd, null);
  const tech = section(report, 'sector-performance').rows.find(row => row.sector === 'Technology');
  assert.equal(tech.growthN, 0); assert.equal(tech.growth, null);
  assert.equal(section(report, 'market-companies').rows.find(row => row.ticker === 'C').revenueGrowth, 0);
});

test('duplicate share classes collapse by CIK while conflicting financial observations are rejected', () => {
  const data = overview(); data.companies.push({ ...structuredClone(data.companies[0]), ticker: 'A.B', cik: '1' });
  const report = build({ overview: data });
  assert.equal(section(report, 'market-companies').rows.length, 4);
  data.companies.at(-1).metrics.ttm.revenueGrowth = 999;
  assert.throws(() => build({ overview: data }), /Conflicting share-class/);
});

test('all CFTC catalog contracts and groups remain visible, with unavailable nonlaunch positions blank', () => {
  const report = build();
  const rows = section(report, 'cftc-all-groups').rows;
  assert.equal(rows.length, 20);
  assert.equal(rows.filter(row => row.code === '999999').length, 10);
  for (const row of rows.filter(row => row.code === '999999')) {
    assert.equal(row.long, null); assert.equal(row.netOi, null); assert.match(row.coverage, /Catalog identity only/);
  }
  const position = rows.find(row => row.familyId === 'tff' && row.code === '13874A' && row.groupId === 'leveraged-funds');
  assert.equal(position.net, 100); assert.equal(position.netOi, 0.2);
  assert.equal(position.oneWeekChangePp, 1.25); assert.equal(position.fourWeekChangePp, null);
  assert.equal(position.reportDate, '2026-09-15'); assert.equal(position.basis, 'Futures only');
  assert.equal(position.units, 'TEST CONTRACT UNITS');
  assert.equal(section(report, 'cftc-tff').rows.length, 1);
  assert.equal(section(report, 'cftc-market-coverage').rows.reduce((sum, row) => sum + row.catalog, 0), 4);
  assert.equal(report.summary.find(row => row.label === 'CFTC prepared markets').value, 2);
  assert.match(report.coverage.message, /2 prepared-position contracts within 4/);
  assert.equal(report.coverage.status, 'partial');
});

test('CFTC family dates remain independent and zero positions are retained while zero open interest withholds percentages', () => {
  const tff = cftc(), physical = cftc('disaggregated', '2026-09-08');
  for (const group of CFTC_FAMILIES.tff.groups) { tff.latest[0].raw[group.long] = '0'; tff.latest[0].raw[group.short] = '0'; }
  tff.latest[0].raw.open_interest_all = '0';
  tff.latest[0] = normalizeCftcRow(tff.latest[0].raw, 'tff').value;
  const report = build({ cftcFamilies: [tff, physical] });
  const row = section(report, 'cftc-tff').rows[0]; assert.equal(row.net, 0); assert.equal(row.netOi, null);
  assert.equal(section(report, 'cftc-disaggregated').rows[0].reportDate, '2026-09-08');
  assert.match(report.summary.find(row => row.label === 'CFTC prepared markets').detail, /2026-09-08, 2026-09-15/);
});

test('wrong family, basis, dates, source, calculations and duplicate contracts fail closed for that CFTC family', () => {
  const mutations = [
    data => { data.report_basis = 'combined'; }, data => { data.report_date = '2026-09-16'; },
    data => { data.source.url = 'https://evil.example/source'; }, data => { data.latest[0].groups['leveraged-funds'].net = 999; },
    data => { data.catalog.push(data.catalog[0]); data.coverage.catalog_rows++; },
    data => { data.latest[0].family = 'disaggregated'; }, data => { data.latest[0].raw.futonly_or_combined = 'Combined'; },
  ];
  for (const mutate of mutations) {
    const tff = cftc(); mutate(tff);
    const report = build({ cftcFamilies: [tff, cftc('disaggregated')] });
    assert.equal(section(report, 'cftc-tff'), undefined);
    assert.ok(section(report, 'cftc-disaggregated'));
    assert.equal(report.coverage.status, 'partial');
    assert.ok(report.notes.some(note => /did not|invalid|duplicated/.test(note)));
  }
});

test('CFTC outage preserves SEC report and does not imply zero positioning or successful coverage', () => {
  const report = build({ cftcFamilies: [] });
  assert.equal(report.summary.find(row => row.label === 'CFTC prepared markets').value, null);
  assert.equal(section(report, 'cftc-all-groups').rows.length, 0);
  assert.equal(section(report, 'market-companies').rows.length, 4);
  assert.ok(section(report, 'market-coverage').rows.slice(1).every(row => row.available === null && row.target === null));
  assert.equal(report.coverage.status, 'partial');
  assert.ok(report.notes.some(note => note.includes('positioning is unavailable')));
});

test('CFTC catalog units and exchange identity reconcile with raw observations before positioning is used', () => {
  for (const mutate of [data => { data.catalog[0].units = 'DIFFERENT UNITS'; },
    data => { data.latest[0].venueCode = 'OTHER VENUE'; },
    data => { data.latest[0].units = 'DIFFERENT UNITS'; },
    data => { data.catalog[0].exchange = 'DIFFERENT EXCHANGE'; },
    data => { data.catalog[0].marketName = 'Different market'; },
    data => { data.catalog[0].contractName = 'Different contract'; }]) {
    const snapshot = cftc('tff', '2026-09-15', false); mutate(snapshot);
    const report = build({ cftcFamilies: [snapshot, cftc('disaggregated')] });
    assert.equal(section(report, 'cftc-tff'), undefined);
    assert.ok(section(report, 'cftc-disaggregated'));
    assert.ok(report.notes.some(note => /units or market identity did not match/.test(note)));
  }
});

test('stale source clocks, incomplete requested coverage and older company periods are disclosed', () => {
  const data = overview(); data.generatedAt = '2026-09-10T10:00:00Z'; data.requested = 6;
  data.companies[0].reports.ttm.end = '2025-06-30';
  const report = build({ overview: data });
  assert.equal(report.period.asOf, '2026-09-10');
  assert.match(section(report, 'market-coverage').rows[0].detail, /2 unavailable issuers/);
  assert.ok(report.notes.some(note => /scheduled check is due/.test(note)));
  assert.match(section(report, 'market-companies').rows.find(row => row.ticker === 'A').olderReport, /Older/);
  assert.equal(report.coverage.status, 'partial');
});

test('retained snapshot age counts and company rows use the same report generation clock', () => {
  for (const [basis, end] of [['ttm', '2026-03-01'], ['annual', '2025-03-15']]) {
    const data = overview(); data.generatedAt = '2026-09-10T10:00:00Z';
    data.companies[0].reports[basis].end = end;
    const report = build({ overview: data }, { basis });
    const olderRows = section(report, 'market-companies').rows.filter(row => row.olderReport.startsWith('Older'));
    assert.equal(olderRows.length, 1);
    assert.match(section(report, 'market-coverage').rows[0].detail, /1 older or unavailable reporting periods/);
    assert.match(report.highlights.find(item => item.title === 'Reporting dates and breadth').text, /1 issuers have older or unavailable/);
    assert.equal(report.period.asOf, '2026-09-10', 'Original source snapshot date stays unchanged');
    assert.equal(report.generatedAt, CLOCK);
    assert.equal(data.generatedAt, '2026-09-10T10:00:00Z', 'Projection does not update source provenance');
  }
});

test('invalid company identity, future dates, empty SEC research and unsupported basis are rejected', () => {
  assert.throws(() => build({}, { basis: 'quarter' }), { status: 400 });
  for (const mutate of [data => { data.companies = []; }, data => { data.companies[0].cik = 'invalid'; },
    data => { data.generatedAt = '2030-01-01T00:00:00Z'; }, data => { data.companies[0].reports.ttm.end = '2026-02-31'; }]) {
    const data = overview(); mutate(data); assert.throws(() => build({ overview: data }), { status: 503 });
  }
});

test('loader uses prepared-only readers, both complete families and tolerates one source outage', async () => {
  const calls = [];
  const load = createMarketReportLoader({ now: () => CLOCK,
    loadOverview: async options => { assert.ok(options.signal); calls.push('sec'); return overview(); },
    loadCftcMarkets: async options => {
      assert.deepEqual(Object.keys(options).sort(), ['family', 'preparedOnly', 'reportDate', 'signal']);
      assert.equal(options.preparedOnly, true); assert.equal(options.reportDate, 'latest'); calls.push(options.family);
      if (options.family === 'disaggregated') throw new Error('Source unavailable');
      return cftc();
    } });
  const report = await load({ basis: 'annual' });
  assert.deepEqual(calls.sort(), ['disaggregated', 'sec', 'tff']);
  assert.equal(report.period.basis, 'annual'); assert.ok(section(report, 'cftc-tff'));
  assert.equal(section(report, 'cftc-disaggregated'), undefined); assert.equal(report.coverage.status, 'partial');
  await assert.rejects(load({ basis: 'quarter' }), { status: 400 });
});

test('loader propagates caller cancellation and rejects missing SEC fundamentals', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  const load = createMarketReportLoader({ loadOverview: async () => overview(), loadCftcMarkets: async ({ family }) => cftc(family) });
  await assert.rejects(load({}, cancelled.signal), { name: 'AbortError' });
  const missing = createMarketReportLoader({ loadOverview: async () => { throw new Error('Missing'); }, loadCftcMarkets: async ({ family }) => cftc(family) });
  await assert.rejects(missing({}), /prepared SEC market snapshot is unavailable/);
});

test('native CFTC rollback blocks the source reader while SEC market reports remain available', async () => {
  let sourceCalls = 0;
  const reader = createNativeMarketCftcReader({ enabled: () => false,
    load: async () => { sourceCalls++; return cftc(); } });
  await assert.rejects(reader({ family: 'tff', preparedOnly: true }), { code: 'CFTC_DISABLED' });
  assert.equal(sourceCalls, 0);
  const previous = process.env.CFTC_ENABLED;
  process.env.CFTC_ENABLED = 'false';
  try {
    const load = createMarketReportLoader({ now: () => CLOCK, loadOverview: async () => overview() });
    const report = await load({ basis: 'annual' });
    assert.equal(report.period.basis, 'annual');
    assert.equal(section(report, 'market-companies').rows.length, 4);
    assert.equal(section(report, 'cftc-all-groups').rows.length, 0);
    assert.equal(report.summary.find(row => row.label === 'CFTC prepared markets').value, null);
    assert.equal(report.coverage.status, 'partial');
    assert.equal(report.notes.filter(note => note.includes('positioning is disabled')).length, 2);
    const publicCalls = [];
    const publicLoad = createMarketReportLoader({ now: () => CLOCK, loadOverview: async () => overview(),
      loadCftcMarkets: async ({ family }) => { publicCalls.push(family); return cftc(family); } });
    const preview = await publicLoad();
    assert.deepEqual(publicCalls.sort(), ['disaggregated', 'tff']);
    assert.ok(section(preview, 'cftc-tff'));
    assert.ok(section(preview, 'cftc-disaggregated'));
  } finally {
    if (previous === undefined) delete process.env.CFTC_ENABLED;
    else process.env.CFTC_ENABLED = previous;
  }
});
