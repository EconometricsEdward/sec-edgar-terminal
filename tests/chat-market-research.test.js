import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMarketChatTools } from '../src/utils/chatMarketResearch.js';
import { MARKET_SECTOR_COMPANY_METRICS, buildMarketSectorCompanies, pageMarketSectorCompanies } from '../src/utils/marketSectorCompanies.js';
import { CFTC_FAMILIES } from '../src/utils/cftc.js';
import { buildCftcHistoryResponse, cftcResourceUrl, loadCftcHistory } from '../src/utils/cftcServer.js';
import { GET as historyGet } from '../src/app/api/v1/cftc/history/route.js';
import { QUANT_GROUPS } from '../src/utils/quantGroups.js';

const sectorInput = overrides => ({ sector: 'Information Technology', basis: 'ttm', metric: 'revenueGrowth', direction: 'desc', query: '', page: '1', ...overrides });
const cftcInput = overrides => ({ family: 'tff', contract: '13874A', group: 'leveraged-funds', date: '2026-09-08', window: '1y', ...overrides });
const error = (message, code) => Object.assign(new Error(message), { researchCode: code });
function harness(options = {}) {
  const sources = [], reads = [];
  const api = { tool: (description, properties, status, execute) => ({ description, properties, status, execute }),
    read: async (key, reader) => { reads.push(key); return reader(new AbortController().signal); },
    addSource: (title, url, date) => { sources.push({ title, url, date }); return `S${sources.length}`; },
    txt: (value, max = 600) => typeof value === 'string' ? value.slice(0, max) : '',
    finite: value => Number.isFinite(value) ? value : null, fail: error,
    unavailable: (reason, code, extra) => ({ status: 'unavailable', reason, code, ...extra }),
    ...options };
  return { tools: createMarketChatTools(api), sources, reads };
}
function sectorFixture(size = 80) {
  return buildMarketSectorCompanies({ generatedAt: '2026-09-18T12:00:00Z', cohorts: QUANT_GROUPS,
    companies: Array.from({ length: size }, (_, i) => ({ ticker: `T${String(i).padStart(3, '0')}`, cik: String(i + 1), name: `Technology company ${i}`,
      sic: '3571', sector: 'Information Technology', cohorts: ['sector-technology'],
      metrics: Object.fromEntries(['ttm', 'annual'].map(basis => [basis, Object.fromEntries(MARKET_SECTOR_COMPANY_METRICS.map(metric => [metric, i]))])),
      reports: Object.fromEntries(['ttm', 'annual'].map(basis => [basis, { end: basis === 'annual' ? '2025-12-31' : '2026-06-30', filed: '2026-08-01', form: '10-Q', accession: null }])),
    })) });
}
function historyFixture({ count = 60, date = '2026-09-08', missing = false } = {}) {
  const base = JSON.parse(readFileSync(new URL('./fixtures/cftc-tff-gpe5-46if-v1.json', import.meta.url), 'utf8'))[0];
  const rows = Array.from({ length: count }, (_, index) => ({ ...base, id: `chat-${index}`,
    report_date_as_yyyy_mm_dd: new Date(Date.parse(`${date}T00:00:00Z`) - index * 7 * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000',
    ...(missing && index === 0 ? { lev_money_positions_long: '.' } : {}) }));
  const leading = [['report_date_as_yyyy_mm_dd', 'DESC'], ['cftc_market_code', 'ASC'], ['contract_units', 'ASC'], ['id', 'ASC']];
  const fields = CFTC_FAMILIES.tff.fields;
  const order = [...leading, ...fields.filter(field => !leading.some(([key]) => key === field)).map(field => [field, 'ASC'])].map(([field, direction]) => `${field} ${direction}`).join(',');
  const sourceUrl = cftcResourceUrl('tff', { '$select': fields.join(','), '$where': `cftc_contract_market_code='13874A' AND report_date_as_yyyy_mm_dd<='${date}T23:59:59.999'`, '$order': order, '$limit': 200, '$offset': 0 });
  return buildCftcHistoryResponse({ family: 'tff', code: '13874A', group: 'leveraged-funds', throughDate: date, window: '1y', rawRows: rows,
    retrievedAt: '2026-09-09T12:00:00Z', sourceUrl, cacheStatus: 'prepared' });
}

test('sector ranking uses every prepared company before bounded pagination and preserves fiscal dates and units', async () => {
  const snapshot = sectorFixture();
  const h = harness({ dependencies: { sectorCompanies: async selection => pageMarketSectorCompanies(snapshot, selection) } });
  const value = await h.tools.sector_companies.execute(sectorInput());
  assert.equal(value.companies.length, 25); assert.equal(value.sectorCompanies, 80); assert.equal(value.availableCount, 80);
  assert.equal(value.companies[0].ticker, 'T079'); assert.equal(value.companies[0].position, 1);
  assert.equal(value.companies[0].value, 79); assert.equal(value.companies[0].report.end, '2026-06-30');
  assert.equal(value.selection.sector, 'sector-technology');
  assert.deepEqual(value.range, { min: 0, max: 79, median: 39.5 }); assert.equal(value.metric.unit, 'pct');
  assert.match(value.units, /12.5 = 12.5%/); assert.ok(Buffer.byteLength(JSON.stringify(value)) < 12000);
  assert.ok(value.companies.every(row => row.sourceIds.length)); assert.equal(h.reads.length, 1);
});

test('sector tool follows exact page selectors and allows clearing a selected search', async () => {
  const snapshot = sectorFixture(), selections = [];
  const h = harness({ context: { section: 'market', query: 'cohort=sector-technology&basis=annual&companyMetric=currentRatio&companyDirection=asc&companyQuery=Technology&companyPage=2' },
    dependencies: { sectorCompanies: async selection => { selections.push(selection); return pageMarketSectorCompanies(snapshot, selection); } } });
  const input = Object.fromEntries(Object.keys(sectorInput()).map(key => [key, '']));
  const value = await h.tools.sector_companies.execute(input);
  assert.equal(value.companies[0].position, 26); assert.equal(value.companies[0].ticker, 'T025');
  assert.equal(value.companies[0].report.end, '2025-12-31'); assert.equal(value.metric.unit, 'ratio');
  assert.equal(value.selection.query, 'technology'); assert.equal(value.selection.direction, 'asc');
  await h.tools.sector_companies.execute({ ...input, query: '*', page: '1' });
  assert.equal(selections[1].query, '');
  const url = new URL(h.sources[0].url); assert.equal(url.searchParams.get('companyPage'), '2');
  assert.equal(url.searchParams.get('companyMetric'), 'currentRatio');
});

test('published sector labels and IDs resolve identically, including non-slug labels', async () => {
  for (const group of QUANT_GROUPS.filter(row => row.id !== 'sector-unclassified')) {
    const snapshot = sectorFixture(1); snapshot.companies[0].sectorId = group.id;
    const h = harness({ dependencies: { sectorCompanies: async selection => pageMarketSectorCompanies(snapshot, selection) } });
    for (const sector of [group.label, group.id]) {
      const value = await h.tools.sector_companies.execute(sectorInput({ sector }));
      assert.equal(value.selection.sector, group.id); assert.equal(value.companies.length, 1);
    }
  }
});

test('sector nulls never become zero, rank last in both directions, and coverage excludes them', async () => {
  const snapshot = sectorFixture(3); snapshot.companies[0].metrics.ttm.netMargin = null;
  snapshot.companies[1].metrics.ttm.netMargin = 0; snapshot.companies[2].metrics.ttm.netMargin = -2;
  const h = harness({ dependencies: { sectorCompanies: async selection => pageMarketSectorCompanies(snapshot, selection) } });
  const value = await h.tools.sector_companies.execute(sectorInput({ metric: 'netMargin', direction: 'asc' }));
  assert.deepEqual(value.companies.map(row => row.value), [-2, 0, null]); assert.equal(value.availableCount, 2);
  assert.equal(value.companies[2].status, 'unavailable');
});

test('sector mismatches and invalid selection fail before publishing a source', async () => {
  const snapshot = sectorFixture(); let reads = 0;
  const h = harness({ dependencies: { sectorCompanies: async selection => { reads++; return { ...pageMarketSectorCompanies(snapshot, selection), basis: 'annual' }; } } });
  await assert.rejects(h.tools.sector_companies.execute(sectorInput()), { researchCode: 'SOURCE_IDENTITY_MISMATCH' });
  assert.equal(h.sources.length, 0);
  await assert.rejects(h.tools.sector_companies.execute(sectorInput({ metric: 'sharePrice' })));
  assert.equal(reads, 1);
});

test('CFTC respects exact selected date, family, group and window and verifies native calculations', async () => {
  const result = historyFixture(), requests = [];
  const h = harness({ context: { query: 'family=tff&contract=13874A&group=leveraged-funds&date=2026-09-08&history=1y' },
    dependencies: { cftcHistory: async selection => { requests.push(selection); return result; } } });
  const value = await h.tools.cftc_history.execute(Object.fromEntries(Object.keys(cftcInput()).map(key => [key, ''])));
  assert.equal(value.selection.actualDate, '2026-09-08'); assert.equal(requests[0].reportDate, '2026-09-08');
  assert.equal(value.history.length, 24); assert.equal(value.historySampled, true);
  assert.equal(value.history[0].date, result.history[0].reportDate); assert.equal(value.history.at(-1).date, '2026-09-08');
  assert.equal(value.selected.net, result.selected.groups['leveraged-funds'].net);
  assert.equal(value.selected.oneWeekChange, result.selected.oneWeekChange);
  assert.equal(value.historicalRange.netContractsChange, 0); assert.ok(value.sourceIds.length);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 12000);
});

test('CFTC rejects a different date and forged source calculation rather than explaining it', async () => {
  const result = historyFixture();
  const h = harness({ dependencies: { cftcHistory: async () => result } });
  await assert.rejects(h.tools.cftc_history.execute(cftcInput({ date: '2026-09-01' })), { researchCode: 'SOURCE_IDENTITY_MISMATCH' });
  result.selected.oneWeekChange += 1;
  await assert.rejects(h.tools.cftc_history.execute(cftcInput()), { researchCode: 'SOURCE_IDENTITY_MISMATCH' });
  assert.equal(h.sources.length, 0);
});

test('CFTC missing positions and short history remain explicitly unavailable', async () => {
  const result = historyFixture({ count: 4, missing: true });
  const h = harness({ dependencies: { cftcHistory: async () => result } });
  const value = await h.tools.cftc_history.execute(cftcInput());
  assert.equal(value.status, 'ready'); assert.equal(value.sourceStatus, 'partial');
  assert.equal(value.selected.long, null); assert.equal(value.selected.net, null);
  assert.equal(value.selected.oneWeekChange, null); assert.equal(value.percentile.value, null);
  assert.equal(value.historicalRange.netContractsChange, null); assert.equal(value.historySampled, false);
  assert.equal(value.history.at(-1).unavailable.net, 'long_or_short_unavailable');
});

test('validated stale CFTC evidence remains usable with explicit source status and freshness', async () => {
  const result = historyFixture(); result.status = 'stale';
  const h = harness({ dependencies: { cftcHistory: async () => result } });
  const value = await h.tools.cftc_history.execute(cftcInput());
  assert.equal(value.status, 'ready'); assert.equal(value.sourceStatus, 'stale');
  assert.deepEqual(value.freshness, result.freshness); assert.ok(value.sourceIds.length);
});

test('CFTC names resolve against the full prepared catalog and ambiguous contracts require a selection', async () => {
  let historyReads = 0;
  const catalog = { report_family: 'tff', report_basis: 'futures_only', catalog: [
    { code: '13874A', label: 'E-mini S&P 500' }, { code: '209742', label: 'Nasdaq-100 E-mini' }, { code: '999999', label: 'Other verified contract' }] };
  const h = harness({ dependencies: { cftc: async () => catalog, cftcHistory: async () => { historyReads++; return historyFixture(); } } });
  const ambiguous = await h.tools.cftc_history.execute(cftcInput({ contract: 'E-mini' }));
  assert.equal(ambiguous.status, 'needs_selection'); assert.equal(ambiguous.choices.length, 2); assert.equal(historyReads, 0);
  assert.deepEqual(ambiguous.choices.map(item => item.id), ['13874A', '209742']);
  const value = await h.tools.cftc_history.execute(cftcInput({ contract: 'E-mini S&P 500' }));
  assert.equal(value.selection.code, '13874A'); assert.equal(historyReads, 1);
});

test('CFTC flag and invalid dates/groups prevent data access; unprepared charts have an explicit gap', async () => {
  let count = 0;
  const disabled = harness({ dependencies: { cftcEnabled: () => false, cftcHistory: async () => { count++; } } });
  assert.equal((await disabled.tools.cftc_history.execute(cftcInput())).status, 'unavailable'); assert.equal(count, 0);
  const h = harness({ dependencies: { cftcHistory: async () => { count++; throw Object.assign(new Error('not prepared'), { code: 'CFTC_REPORT_NOT_PREPARED' }); } } });
  for (const patch of [{ group: 'managed-money' }, { date: '2999-01-01' }, { date: '2026-02-30' }]) await assert.rejects(h.tools.cftc_history.execute(cftcInput(patch)));
  assert.equal(count, 0);
  const value = await h.tools.cftc_history.execute(cftcInput()); assert.equal(value.code, 'SOURCE_NOT_PREPARED'); assert.equal(count, 1);
});

test('preview requests use fixed public paths and strict prepared-only CFTC mode', async () => {
  const calls = [];
  const h = harness({ preview: true, publicJson: async (path, params) => { calls.push({ path, params });
    return { payload: path.includes('history') ? historyFixture() : pageMarketSectorCompanies(sectorFixture(), params) }; } });
  await h.tools.sector_companies.execute(sectorInput()); await h.tools.cftc_history.execute(cftcInput());
  assert.equal(calls[0].path, '/api/market-sector-companies'); assert.equal(calls[1].path, '/api/v1/cftc/history');
  assert.equal(calls[1].params.prepared, 'true'); assert.equal(calls[1].params.date, '2026-09-08');
});

test('prepared-only native CFTC miss never starts an upstream download', async () => {
  let fetches = 0;
  await assert.rejects(loadCftcHistory({ family: 'tff', code: '13874A', group: 'leveraged-funds', preparedOnly: true,
    persistence: { mode: () => 'off' }, cacheGet: async () => null,
    fetchImpl: async () => { fetches++; throw new Error('Unexpected upstream request'); } }), { code: 'CFTC_REPORT_NOT_PREPARED' });
  assert.equal(fetches, 0);
});

test('public history route rejects non-strict or duplicated prepared-only controls', async () => {
  for (const value of ['false', '1', 'true&prepared=true']) {
    const response = await historyGet(new Request(`https://example.test/api/v1/cftc/history?contract=13874A&prepared=${value}`,
      { headers: { 'x-forwarded-for': '192.0.2.229' } }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).code, /INVALID_PREPARED_SELECTION|DUPLICATE_QUERY_PARAMETER/);
  }
});
