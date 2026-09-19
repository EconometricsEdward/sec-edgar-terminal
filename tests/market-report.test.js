import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketReport, createMarketReportLoader, createNativeMarketCftcReader } from '../src/utils/marketReport.js';
import { MARKET_METRICS } from '../src/utils/marketResearch.js';
import { CFTC_FAMILIES, CFTC_REPORT_BASIS, CFTC_SCHEMA_VERSION, normalizeCftcRow, cftcCatalog, cftcSeries } from '../src/utils/cftc.js';
import { buildMarketMacroSummary, MARKET_SECTOR_METRICS } from '../src/utils/marketMacroSummary.js';
import { buildMarketMacroPositioning } from '../src/utils/marketMacroPositioning.js';

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

test('retained snapshot age counts and company rows match the Market page snapshot clock', () => {
  for (const [basis, end] of [['ttm', '2026-03-01'], ['annual', '2025-03-15']]) {
    const data = overview(); data.generatedAt = '2026-09-10T10:00:00Z';
    data.companies[0].reports[basis].end = end;
    const report = build({ overview: data }, { basis });
    const olderRows = section(report, 'market-companies').rows.filter(row => row.olderReport.startsWith('Older'));
    assert.equal(olderRows.length, 0);
    assert.equal(report.marketBriefing.coverage.olderReports, buildMarketMacroSummary(data, basis).olderReports);
    assert.match(section(report, 'market-coverage').rows[0].detail, /0 older or unavailable reporting periods/);
    assert.match(report.highlights.find(item => item.title === 'Reporting dates and breadth').text, /0 issuers have older or unavailable/);
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
    assert.equal(report.marketBriefing.positioning.cards.length, 6);
    assert.ok(report.marketBriefing.positioning.cards.every(card => !card.available && card.netPctOi === null));
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

test('rich market briefing agrees with the shared Market page statistics in both reporting bases', () => {
  for (const basis of ['ttm', 'annual']) {
    const data = overview(), report = build({ overview: data }, { basis });
    const macro = buildMarketMacroSummary(data, basis), briefing = report.marketBriefing;
    assert.deepEqual(briefing.sectorMetrics, MARKET_SECTOR_METRICS);
    assert.deepEqual(briefing.sectors, macro.sectors);
    assert.deepEqual(briefing.industries, macro.industries);
    assert.deepEqual(briefing.coverage.reportRange, macro.reportRange);
    for (const [index, key] of ['growth', 'profit', 'cash'].entries()) {
      assert.equal(briefing.breadth[index].positive, macro[key].positive);
      assert.equal(briefing.breadth[index].count, macro[key].count);
      assert.equal(briefing.breadth[index].share, macro[key].positivePct / 100);
    }
    assert.equal(briefing.growthLeaders.highest.sector, 'Technology');
    assert.equal(briefing.growthLeaders.highest.value, basis === 'ttm' ? 3 : 4);
    for (const sector of macro.sectors) {
      const row = section(report, 'sector-comparison').rows.find(item => item.sectorId === sector.id);
      for (const metric of MARKET_SECTOR_METRICS) {
        assert.equal(row[metric.key], sector.metrics[metric.key].median / 100);
        assert.equal(row[`${metric.key}N`], sector.metrics[metric.key].count);
      }
      const industries = section(report, 'sector-industries').rows.filter(item => item.sectorId === sector.id);
      assert.equal(industries.reduce((sum, item) => sum + item.companies, 0), sector.count - sector.missingIndustryCount);
    }
  }
});

test('distribution tables retain correct percent units, quartiles, singletons and missing-value denominators', () => {
  const data = overview();
  for (const item of data.companies) item.metrics.ttm.capexIntensity = null;
  const report = build({ overview: data });
  const techGrowth = section(report, 'sector-statistics').rows.find(row => row.sector === 'Technology' && row.metricKey === 'revenueGrowth');
  assert.equal(techGrowth.median, 0.03); assert.equal(techGrowth.mean, 0.03);
  assert.equal(techGrowth.min, -0.04); assert.equal(techGrowth.max, 0.1);
  assert.ok(Math.abs(techGrowth.p25 - -0.005) < 1e-14);
  assert.ok(Math.abs(techGrowth.p75 - 0.065) < 1e-14);
  assert.equal(techGrowth.positive, 1); assert.equal(techGrowth.negative, 1); assert.equal(techGrowth.count, 2);
  const single = section(report, 'sector-statistics').rows.find(row => row.sector === 'Technology' && row.metricKey === 'netMargin');
  assert.equal(single.p25, 0.2); assert.equal(single.p75, 0.2); assert.equal(single.coverage, 0.5);
  for (const empty of section(report, 'sector-statistics').rows.filter(row => row.metricKey === 'capexIntensity')) {
    for (const key of ['median', 'mean', 'p25', 'p75', 'min', 'max']) assert.equal(empty[key], null);
    assert.equal(empty.count, 0); assert.equal(empty.coverage, 0);
  }
});

test('breadth distinguishes zero, negative and missing values and growth leaders require observed sectors', () => {
  const data = overview();
  data.companies = data.companies.slice(0, 2);
  data.companies[0].metrics.ttm.revenueGrowth = 0;
  data.companies[1].metrics.ttm.revenueGrowth = null;
  for (const item of data.companies) {
    item.metrics.ttm.netIncome = null;
    item.metrics.ttm.cashFlowMargin = -5;
  }
  const briefing = build({ overview: data }).marketBriefing;
  assert.deepEqual(briefing.breadth.map(({ positive, count, share }) => ({ positive, count, share })), [
    { positive: 0, count: 1, share: 0 }, { positive: 0, count: 0, share: null }, { positive: 0, count: 2, share: 0 },
  ]);
  assert.equal(briefing.growthLeaders.highest.value, 0);
  assert.equal(briefing.growthLeaders.lowest, null); assert.equal(briefing.growthLeaders.spreadPp, null);
  data.companies[0].metrics.ttm.revenueGrowth = null;
  assert.deepEqual(build({ overview: data }).marketBriefing.growthLeaders, { highest: null, lowest: null, spreadPp: null });
});

test('CFTC macro uses shared six-card definitions and units only after raw-position validation', () => {
  const snapshots = [cftc(), cftc('disaggregated')];
  const report = build({ cftcFamilies: snapshots });
  const expected = buildMarketMacroPositioning(Object.fromEntries(snapshots.map(snapshot => [snapshot.report_family, snapshot])));
  assert.deepEqual(report.marketBriefing.positioning.cards, expected.cards);
  assert.equal(report.marketBriefing.positioning.cards.length, 6);
  assert.equal(report.marketBriefing.positioning.availableCount, 2);
  const equity = report.marketBriefing.positioning.cards.find(card => card.id === 'equities');
  assert.equal(equity.netPctOi, 20); assert.equal(equity.weeklyChange, 1.25);
  const flat = section(report, 'cftc-macro').rows.find(row => row.id === 'equities');
  assert.equal(flat.netOi, 0.2); assert.equal(flat.oneWeekChangePp, 1.25);
  const physical = cftc('disaggregated', '2026-09-08');
  const different = build({ cftcFamilies: [snapshots[0], physical] }).marketBriefing.positioning;
  assert.equal(different.differentReportDates, true); assert.equal(different.largestMove, null);
  assert.equal(different.cards.find(card => card.id === 'energy').reportDate, '2026-09-08');
  snapshots[0].latest[0].groups['leveraged-funds'].net = 999;
  const rejected = build({ cftcFamilies: snapshots });
  assert.equal(rejected.marketBriefing.positioning.cards.find(card => card.id === 'equities').netPctOi, null);
  assert.equal(section(rejected, 'cftc-macro').rows.length, 6);
  const absent = build({ cftcFamilies: [] });
  assert.ok(absent.marketBriefing.positioning.cards.every(card => !card.available && !card.hasObservation && card.reportDate === null));
});

test('retained CFTC dates propagate effective source age to the macro cards without changing dates', () => {
  const snapshot = cftc('tff', '2026-09-01');
  const report = build({ cftcFamilies: [snapshot] });
  const family = report.marketBriefing.positioning.families.find(item => item.family === 'tff');
  assert.equal(family.sourceAgeDays, 18); assert.equal(family.aged, true);
  const card = report.marketBriefing.positioning.cards.find(item => item.id === 'equities');
  assert.equal(card.aged, true); assert.equal(card.reportDate, '2026-09-01');
  assert.equal(section(report, 'cftc-macro').rows.find(item => item.id === 'equities').coverage, 'Retained or aged snapshot');
  assert.equal(snapshot.freshness.source_currency, 'current', 'The original prepared input is unchanged');
});

test('conflicting duplicate-issuer industry and effective primary-sector assignments fail closed', () => {
  for (const mutation of [copy => { copy.sic = 2834; }, copy => { copy.cohorts = ['sector-industrials']; }]) {
    const data = overview(); data.companies[0].sector = '';
    const duplicate = structuredClone(data.companies[0]); duplicate.ticker = 'A.B';
    mutation(duplicate); data.companies.push(duplicate);
    assert.throws(() => build({ overview: data }), /Conflicting share-class/);
  }
  const data = overview();
  const duplicate = structuredClone(data.companies[0]); duplicate.ticker = 'A.B'; duplicate.sic = '7372';
  data.companies.push(duplicate);
  assert.equal(build({ overview: data }).marketBriefing.coverage.companyCount, 4);
});

test('CFTC ranks preserve exact prepared 1y/3y/5y windows and reject incompatible date or unit context', () => {
  const snapshot = cftc('tff', '2026-09-15', false), selected = snapshot.latest[0];
  const history = Array.from({ length: 261 }, (_, index) => {
    const date = new Date(`${snapshot.report_date}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - index * 7);
    return normalizeCftcRow({ ...selected.raw, id: `history-${index}`, report_date_as_yyyy_mm_dd: date.toISOString().slice(0, 10) }, 'tff').value;
  });
  for (const group of CFTC_FAMILIES.tff.groups) {
    const prepared = cftcSeries(history, group.id);
    Object.assign(selected.groups[group.id], { percentile: prepared.percentile, shorterPercentiles: prepared.shorterPercentiles,
      historyRange: prepared.historyRange });
  }
  const rowFor = input => section(build({ cftcFamilies: [input] }), 'cftc-all-groups').rows.find(row => row.groupId === 'leveraged-funds');
  const row = rowFor(snapshot);
  for (const [window, required] of [['1y', 52], ['3y', 156], ['5y', 260]]) {
    assert.equal(row[`rank${window}`], 0.5); assert.equal(row[`rank${window}N`], required);
    assert.equal(row[`rank${window}Required`], required); assert.equal(row[`rank${window}Status`], 'Available');
    assert.equal(row[`rank${window}End`], '2026-09-08');
  }
  assert.equal(section(build({ cftcFamilies: [snapshot] }), 'cftc-heatmap').rows[0].rank5y, 0.5);
  const shortOnly = structuredClone(snapshot);
  delete shortOnly.latest[0].groups['leveraged-funds'].percentile;
  assert.equal(rowFor(shortOnly).rank5y, null); assert.equal(rowFor(shortOnly).rank1y, 0.5);
  for (const mutation of [group => { group.historyRange.compatibility.units = 'OTHER'; },
    group => { group.percentile.comparisonRange.latest = snapshot.report_date; },
    group => { group.percentile.observations = 52; }]) {
    const invalid = structuredClone(snapshot); mutation(invalid.latest[0].groups['leveraged-funds']);
    const rejected = rowFor(invalid);
    assert.equal(rejected.rank5y, null); assert.equal(rejected.rank5yStatus, 'Unverified percentile context');
    assert.equal(rejected.netOi, 0.2, 'Invalid historical ranks do not discard verified current positions');
  }
});
