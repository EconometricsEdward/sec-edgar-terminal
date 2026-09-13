import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { CFTC_FCM_INDEX_URL, CFTC_FCM_SCHEMA_VERSION, buildFcmSnapshot, discoverFcmReports, fcmDollarValue, fcmEntityId, parseFcmWorkbook } from '../src/utils/cftcFcm.js';
import { CFTC_FCM_STALE_MAX_MS, createFcmLoader, fetchFcmSource, isUsableFcmSnapshot } from '../src/utils/cftcFcmServer.js';
import { GET, OPTIONS } from '../src/app/api/v1/cftc/fcm/route.js';

// Unmodified public CFTC workbooks downloaded September 13, 2026. Live loading
// discovers the index and downloads CFTC workbooks; it never imports fixtures.
const currentSource = { reportDate: '2026-07-31', url: 'https://www.cftc.gov/sites/default/files/2026-09/01%20-%20FCM%20Webpage%20Update%20-%20July%202026.xlsx' };
const previousSource = { reportDate: '2026-06-30', url: 'https://www.cftc.gov/sites/default/files/2026-08/01%20-%20FCM%20Webpage%20Update%20-%20June%202026.xlsx' };
const currentBytes = readFileSync(new URL('./fixtures/cftc-fcm/july-2026.xlsx', import.meta.url));
const previousBytes = readFileSync(new URL('./fixtures/cftc-fcm/june-2026.xlsx', import.meta.url));
const indexHtml = `<table><tr><td>July 31, 2026</td><td><a href="${currentSource.url}">Excel</a></td></tr><tr><td>June 30, 2026</td><td><a href="${previousSource.url}">Excel</a></td></tr></table>`;
const fixedNow = Date.parse('2026-09-13T12:00:00Z');
const parsedCurrent = () => parseFcmWorkbook(currentBytes, currentSource);
const parsedPrevious = () => parseFcmWorkbook(previousBytes, previousSource);
const snapshotAt = timestamp => buildFcmSnapshot(parsedCurrent(), parsedPrevious(), new Date(timestamp).toISOString());

function mutateWorkbook(bytes, change) {
  const entries = unzipSync(bytes);
  entries['xl/worksheets/sheet1.xml'] = strToU8(change(strFromU8(entries['xl/worksheets/sheet1.xml'])));
  return zipSync(entries);
}

function sourceFetch(calls = []) {
  return async (url, options) => {
    calls.push(String(url));
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    if (url === CFTC_FCM_INDEX_URL) return new Response(indexHtml);
    if (url === currentSource.url) return new Response(currentBytes);
    if (url === previousSource.url) return new Response(previousBytes);
    throw new Error('Unexpected outbound source');
  };
}

function loaderOptions(overrides = {}) {
  return { now: () => fixedNow, fetchImpl: sourceFetch(), readCache: async () => null, writeCache: async () => true, sharedEnabled: () => false, ...overrides };
}

test('FCM discovery uses actual official monthly links and ignores future/offsite/non-month-end rows', () => {
  const extra = '<tr><td>August 31, 2099</td><td><a href="https://www.cftc.gov/sites/default/files/future.xlsx">Excel</a></td></tr><tr><td>August 31, 2026</td><td><a href="https://other.example/fake.xlsx">Excel</a></td></tr><tr><td>August 30, 2026</td><td><a href="https://www.cftc.gov/sites/default/files/fake.xlsx">Excel</a></td></tr>';
  assert.deepEqual(discoverFcmReports(indexHtml + extra, new Date(fixedNow)), [currentSource, previousSource]);
  assert.throws(() => discoverFcmReports('<html>Access denied</html>', new Date(fixedNow)), /Two official/);
  assert.throws(() => discoverFcmReports(indexHtml + '<tr><td>July 31, 2026</td><a href="https://www.cftc.gov/sites/default/files/conflict.xlsx">Excel</a></tr>', new Date(fixedNow)), /conflicting/);
});

test('official FCM workbooks preserve whole USD, legal entities, report dates and customer-fund categories', () => {
  const current = parsedCurrent(), prior = parsedPrevious();
  assert.equal(current.firms.length, 74); assert.equal(prior.firms.length, 73);
  const abn = current.firms[0], jpm = current.firms.find(firm => firm.legalName === 'JP MORGAN SECURITIES LLC');
  assert.equal(abn.legalName, 'ABN AMRO CLEARING USA LLC');
  assert.equal(abn.nfaId, null); assert.equal(abn.identityBasis, 'published-legal-name');
  assert.equal(abn.reportDate, '2026-07-31'); assert.equal(abn.sourceReportDate, '2026-07-31');
  assert.equal(abn.adjustedNetCapital, 914023371); assert.equal(abn.netCapitalRequirement, 307391117); assert.equal(abn.excessNetCapital, 606632254);
  assert.equal(abn.capitalCoverage, 914023371 / 307391117);
  assert.equal(abn.customerSegregationRequired, 5087058775); assert.equal(abn.customerAssetsInSegregation, 6032936185);
  assert.equal(abn.part30Required, 214069669); assert.equal(abn.clearedSwapsRequired, 0);
  assert.equal(jpm.adjustedNetCapital, 27801517105); assert.equal(jpm.excessNetCapital, 20005894675);
  assert.equal(jpm.clearedSwapsRequired, 25134485640);
  assert.equal(current.firms.some(firm => /Totals|Additions/.test(firm.legalName)), false);
});

test('monthly comparisons require consecutive as-of dates and same legal entity, without inferred renames or parents', () => {
  const snapshot = snapshotAt(fixedNow), abn = snapshot.firms[0];
  assert.equal(abn.previous.adjustedNetCapital, 853625551);
  assert.equal(abn.changes.excessNetCapital, 38263002);
  assert.equal(abn.changes.excessNetCapitalPct, 38263002 / 568369252 * 100);
  assert.equal(abn.comparisonStatus, 'matched-legal-name');
  assert.equal(snapshot.firms.find(firm => firm.legalName === 'KALSHI PRIME LLC').previous, null);
  assert.equal(snapshot.firms.find(firm => firm.legalName === 'GUS III LLC').changes, null);
  assert.equal(fcmEntityId('  Abn  Amro Clearing USA LLC '), abn.id);
  assert.notEqual(fcmEntityId('JP MORGAN SECURITIES LLC'), fcmEntityId('JPMORGAN CHASE & CO'));
  assert.notEqual(fcmEntityId('ABC INC'), fcmEntityId('ABC LLC'));
  assert.notEqual(fcmEntityId('ABC, INC'), fcmEntityId('ABC INC'));
  assert.equal(isUsableFcmSnapshot(snapshot, fixedNow), true);
});

test('missing values never become zero; zero requirements produce unavailable coverage and exact dollar validation', () => {
  for (const value of [null, undefined, '', ' ', 'N/A', '—']) assert.equal(fcmDollarValue(value), null);
  assert.equal(fcmDollarValue('0'), 0); assert.equal(fcmDollarValue('(12,000)'), -12000);
  for (const value of ['100.5', '9007199254740993', 'NaN']) assert.throws(() => fcmDollarValue(value), /exact whole-dollar/);
  const bytes = mutateWorkbook(currentBytes, xml => xml.replace(/(<c r="F4"[^>]*>)<v>[^<]+<\/v>/, '$1').replace(/(<c r="G4"[^>]*><v>)[^<]+/, '$10'));
  const firm = parseFcmWorkbook(bytes, currentSource).firms[0];
  assert.equal(firm.adjustedNetCapital, null); assert.equal(firm.netCapitalRequirement, 0); assert.equal(firm.capitalCoverage, null);
  assert.ok(firm.unavailableFields.includes('adjustedNetCapital'));
});

test('financial columns follow verified headers when worksheet columns move', () => {
  const bytes = mutateWorkbook(currentBytes, xml => xml.replace(/\br="([FG])(\d+)"/g, (_, column, row) => `r="${column === 'F' ? 'G' : 'F'}${row}"`));
  const firm = parseFcmWorkbook(bytes, currentSource).firms[0];
  assert.equal(firm.adjustedNetCapital, 914023371); assert.equal(firm.netCapitalRequirement, 307391117);
  const missingHeader = mutateWorkbook(currentBytes, xml => xml.replace(/<c r="F1"[^>]*>[\s\S]*?<\/c>/, ''));
  assert.throws(() => parseFcmWorkbook(missingHeader, currentSource), /worksheet|column/);
});

test('stale individual dates and unreconciled capital are visible and cannot create false monthly changes', () => {
  const staleBytes = mutateWorkbook(currentBytes, xml => xml.replace(/(<c r="E4"[^>]*><v>)[^<]+/, '$146203'));
  const current = parseFcmWorkbook(staleBytes, currentSource), snapshot = buildFcmSnapshot(current, parsedPrevious());
  assert.equal(snapshot.firms[0].reportDate, '2026-06-30');
  assert.equal(snapshot.firms[0].sourceReportDate, '2026-07-31');
  assert.equal(snapshot.firms[0].previous, null); assert.equal(snapshot.firms[0].changes, null);
  assert.match(snapshot.firms[0].validationNotes.join(' '), /older as-of/);
  const inconsistent = mutateWorkbook(currentBytes, xml => xml.replace(/(<c r="H4"[^>]*><v>)[^<]+/, '$11'));
  const bad = buildFcmSnapshot(parseFcmWorkbook(inconsistent, currentSource), parsedPrevious());
  assert.match(bad.firms[0].validationNotes.join(' '), /does not reconcile/); assert.equal(bad.firms[0].changes, null);
  const future = mutateWorkbook(currentBytes, xml => xml.replace(/(<c r="E4"[^>]*><v>)[^<]+/, '$149203'));
  assert.throws(() => parseFcmWorkbook(future, currentSource), /as-of date/);
});

test('FCM rejects duplicate legal identity and invalid XML/archive data instead of publishing partial results', () => {
  const duplicate = mutateWorkbook(currentBytes, xml => xml.replace(/(<c r="B5"[^>]*><v>)[^<]+/, (_, prefix) => prefix + /<c r="B4"[^>]*><v>([^<]+)/.exec(xml)[1]));
  assert.throws(() => parseFcmWorkbook(duplicate, currentSource), /duplicate legal/);
  assert.throws(() => parseFcmWorkbook(new Uint8Array([1, 2, 3]), currentSource), /valid XLSX/);
  const entity = mutateWorkbook(currentBytes, xml => '<!DOCTYPE worksheet [<!ENTITY x "bad">]>' + xml);
  assert.throws(() => parseFcmWorkbook(entity, currentSource), /XML declarations/);
});

test('FCM runtime performs real index discovery and two workbook acquisitions, coalesces readers and caches result', async () => {
  const calls = [], saved = [];
  const loader = createFcmLoader(loaderOptions({ fetchImpl: sourceFetch(calls), writeCache: async value => { saved.push(value); return true; } }));
  const [first, second] = await Promise.all([loader.load(), loader.load()]);
  assert.equal(first.status, 'ready'); assert.equal(second.reportDate, '2026-07-31');
  assert.equal(first.freshness.cacheStatus, 'source'); assert.equal(first.firms.length, 74);
  assert.deepEqual(calls, [CFTC_FCM_INDEX_URL, currentSource.url, previousSource.url]); assert.equal(saved.length, 1);
  assert.equal((await loader.load()).freshness.cacheStatus, 'memory'); assert.equal(calls.length, 3);
});

test('warm FCM records retain original retrieval time and source provenance', async () => {
  const cached = snapshotAt(fixedNow - 3600_000);
  const loader = createFcmLoader(loaderOptions({ readCache: async () => cached, fetchImpl: async () => { throw new Error('Should not fetch'); } }));
  const result = await loader.load();
  assert.equal(result.freshness.cacheStatus, 'warm'); assert.equal(result.retrievedAt, cached.retrievedAt);
  assert.equal(result.source.reports[0].url, currentSource.url);
});

test('FCM cache validation rejects corrupted current/prior metrics, comparisons and linked provenance', () => {
  const original = snapshotAt(fixedNow - 3600_000);
  const cases = [
    ['current coverage', value => { value.firms[0].capitalCoverage = 999; }],
    ['capital change', value => { value.firms[0].changes.excessNetCapital = -999999999999; }],
    ['percent change', value => { value.firms[0].changes.excessNetCapitalPct = -95; }],
    ['prior coverage', value => { value.firms[0].previous.capitalCoverage = 999; }],
    ['prior monetary value', value => { value.firms[0].previous.adjustedNetCapital = '853625551'; }],
    ['prior identity', value => { value.firms[0].previous = structuredClone(value.firms[1].previous); }],
    ['prior date', value => { value.firms[0].previous.reportDate = '2026-05-31'; }],
    ['prior source report date', value => { value.firms[0].previous.sourceReportDate = '2026-07-31'; }],
    ['prior source URL', value => { value.firms[0].previous.sourceUrl = currentSource.url; }],
    ['current source URL', value => { value.firms[0].sourceUrl = previousSource.url; }],
    ['source report dates', value => { value.source.reports.reverse(); }],
    ['null report date', value => { value.reportDate = null; }],
    ['null prior as-of date', value => { value.firms[0].previous.reportDate = null; }],
    ['source report file', value => { value.source.reports[0].url = 'https://www.cftc.gov/sites/default/files/unrelated.xlsx'; }],
    ['definitions URL', value => { value.source.definitionsUrl = 'https://example.test/definitions'; }],
    ['invented identity identifier', value => { value.firms[0].previous.nfaId = '1234567'; }],
    ['comparison status', value => { value.firms[0].comparisonStatus = 'no-comparable-prior-row'; }],
    ['missing-data annotations', value => { value.firms[0].unavailableFields = ['adjustedNetCapital']; }],
    ['reconciliation annotations', value => { value.firms[0].validationNotes = ['Invented warning']; }],
    ['methodology', value => { value.methodology.capitalCoverage = 'Capital multiplied by requirements'; }],
    ['missing change field', value => { delete value.firms[0].changes.capitalCoverage; }],
  ];
  assert.equal(isUsableFcmSnapshot(original, fixedNow), true);
  for (const [label, corrupt] of cases) {
    const snapshot = structuredClone(original); corrupt(snapshot);
    assert.equal(isUsableFcmSnapshot(snapshot, fixedNow), false, label);
  }
});

test('corrupted warm cache is refreshed, and corrupted stale data cannot be a last-good fallback', async () => {
  const corrupted = snapshotAt(fixedNow - 3600_000); corrupted.firms[0].capitalCoverage = 999;
  const calls = [];
  const loader = createFcmLoader(loaderOptions({ readCache: async () => corrupted, fetchImpl: sourceFetch(calls) }));
  const result = await loader.load();
  assert.equal(result.freshness.cacheStatus, 'source');
  assert.equal(result.firms[0].capitalCoverage, 914023371 / 307391117);
  assert.deepEqual(calls, [CFTC_FCM_INDEX_URL, currentSource.url, previousSource.url]);
  const stale = snapshotAt(fixedNow - 2 * 86400_000); stale.firms[0].changes.excessNetCapital = -999999999999;
  const unavailable = createFcmLoader(loaderOptions({ readCache: async () => stale, fetchImpl: async () => new Response('Unavailable', { status: 503 }) }));
  await assert.rejects(unavailable.load(), { code: 'CFTC_FCM_SOURCE_HTTP_ERROR' });
});

test('failed refresh serves only bounded last-good data with stale disclosure and never invents empty results', async () => {
  const cached = snapshotAt(fixedNow - 2 * 86400_000);
  const loader = createFcmLoader(loaderOptions({ readCache: async () => cached, fetchImpl: async () => new Response('Unavailable', { status: 503 }) }));
  const result = await loader.load();
  assert.equal(result.status, 'degraded'); assert.equal(result.freshness.stale, true);
  assert.equal(result.retrievedAt, cached.retrievedAt); assert.equal(result.reportDate, cached.reportDate);
  assert.equal(result.firms.length, 74); assert.equal(result.refreshError.code, 'CFTC_FCM_SOURCE_HTTP_ERROR');
  const old = snapshotAt(fixedNow - CFTC_FCM_STALE_MAX_MS - 1);
  assert.equal(isUsableFcmSnapshot(old, fixedNow), false);
  const expiredLoader = createFcmLoader(loaderOptions({ readCache: async () => old, fetchImpl: async () => new Response('Unavailable', { status: 503 }) }));
  await assert.rejects(expiredLoader.load(), { code: 'CFTC_FCM_SOURCE_HTTP_ERROR' });
  const missingLoader = createFcmLoader(loaderOptions({ fetchImpl: async () => new Response('Unavailable', { status: 503 }) }));
  await assert.rejects(missingLoader.load(), { code: 'CFTC_FCM_SOURCE_HTTP_ERROR' });
});

test('FCM isolation enforces source allowlist, byte bounds, refresh lease and provider kill switch', async () => {
  await assert.rejects(fetchFcmSource('https://example.test/data.xlsx', { fetchImpl: async () => { throw new Error('No request should happen'); } }), { code: 'CFTC_FCM_SOURCE_URL_INVALID' });
  await assert.rejects(fetchFcmSource(CFTC_FCM_INDEX_URL, { fetchImpl: async () => new Response('too large', { headers: { 'content-length': '9999999' } }) }), { code: 'CFTC_FCM_RESPONSE_TOO_LARGE' });
  const disabled = createFcmLoader(loaderOptions({ enabled: () => false, readCache: async () => { throw new Error('Should not read'); } }));
  await assert.rejects(disabled.load(), { code: 'CFTC_DISABLED' });
  const busy = createFcmLoader(loaderOptions({ sharedEnabled: () => true, acquireLease: async () => null }));
  await assert.rejects(busy.load(), { code: 'CFTC_FCM_REFRESH_BUSY' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createFcmLoader(loaderOptions()).load({ signal: controller.signal }), { code: 'CFTC_FCM_TIMEOUT' });
});

test('FCM public route rejects malformed selections, exposes CORS and obeys CFTC_ENABLED before source work', async () => {
  for (const [query, code] of [['?url=https://example.test', 'UNKNOWN_QUERY_PARAMETER'], ['?entity=x&entity=y', 'DUPLICATE_QUERY_PARAMETER'], ['?entity=JPM', 'INVALID_FCM_ENTITY']]) {
    const response = await GET(new Request(`https://example.test/api/v1/cftc/fcm${query}`, { headers: { 'x-forwarded-for': '192.0.2.173' } }));
    assert.equal(response.status, 400); assert.equal((await response.json()).code, code);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(OPTIONS().status, 204); assert.equal(OPTIONS().headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  const prior = process.env.CFTC_ENABLED; process.env.CFTC_ENABLED = '0';
  try {
    const disabled = await GET(new Request('https://example.test/api/v1/cftc/fcm'));
    assert.equal(disabled.status, 503); assert.equal((await disabled.json()).code, 'CFTC_DISABLED');
  } finally { if (prior == null) delete process.env.CFTC_ENABLED; else process.env.CFTC_ENABLED = prior; }
});

test('FCM route returns a populated contract and exact entity selections, with no-match as an explicit 404', async context => {
  context.mock.method(Date, 'now', () => fixedNow);
  const priorFetch = globalThis.fetch; globalThis.fetch = sourceFetch();
  try {
    const response = await GET(new Request('https://example.test/api/v1/cftc/fcm', { headers: { 'x-forwarded-for': '192.0.2.174' } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.schema_version, CFTC_FCM_SCHEMA_VERSION); assert.equal(body.firms.length, 74);
    assert.equal(response.headers.get('x-report-date'), '2026-07-31');
    const entity = await GET(new Request(`https://example.test/api/v1/cftc/fcm?entity=${body.firms[0].id}`, { headers: { 'x-forwarded-for': '192.0.2.174' } }));
    const selected = await entity.json(); assert.equal(selected.firms.length, 1); assert.equal(selected.firms[0].adjustedNetCapital, 914023371);
    const missing = await GET(new Request('https://example.test/api/v1/cftc/fcm?entity=fcm-000000000000000000000000', { headers: { 'x-forwarded-for': '192.0.2.174' } }));
    assert.equal(missing.status, 404); assert.equal((await missing.json()).code, 'FCM_ENTITY_NOT_FOUND');
  } finally { globalThis.fetch = priorFetch; }
});
