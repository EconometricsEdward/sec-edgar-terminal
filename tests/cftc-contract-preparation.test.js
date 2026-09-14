import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CFTC_FAMILIES, normalizeCftcRow } from '../src/utils/cftc.js';
import { cftcContractRawKey, createCftcPersistence } from '../src/utils/cftcPersistence.js';
import { buildCftcMarketsSnapshot, cftcPublicationStatus, cftcResourceUrl, fetchCftcContractHistory, loadCftcHistory, prepareCftcContractRawHistory, validateRawHistoryEnvelope, validMarketsResponse } from '../src/utils/cftcServer.js';

const base = JSON.parse(readFileSync(new URL('./fixtures/cftc-tff-gpe5-46if-v1.json', import.meta.url)))[0];
const throughDate = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
const prior = weeks => new Date(Date.parse(`${throughDate}T00:00:00Z`) - weeks * 7 * 86400_000).toISOString().slice(0, 10);
const selection = { family: 'tff', code: 'ABC', throughDate };
const hash = value => createHash('sha256').update(value).digest('hex');
const rowsFor = (count, overrides = {}) => Array.from({ length: count }, (_, index) => ({ ...base, cftc_contract_market_code: selection.code,
  id: `background-${index}`, report_date_as_yyyy_mm_dd: `${prior(index)}T00:00:00.000`, ...overrides }));
const gate = { run: async task => task(), publishCooldown: async () => true };

function store() {
  const current = new Map(), lastGood = new Map(), calls = [], generations = new Map();
  let clockOffset = 0, failPublish = false;
  const api = createCftcPersistence({ mode: () => 'supabase', now: () => Date.now() + clockOffset,
    begin: async (dataset, key) => {
      calls.push({ action: 'reserve', key });
      const generation = String(Number(generations.get(key) || 0) + 1); generations.set(key, generation);
      return { dataset, key, generation };
    },
    read: async (_dataset, key, options) => {
      calls.push({ action: 'read', key });
      return (options?.pointer === 'last-good' ? lastGood : current).get(key) || null;
    },
    publish: async args => {
      calls.push({ action: 'publish', args });
      if (failPublish || generations.get(args.key) !== args.claim.generation) throw new Error('private provider failure');
      const record = { payload: structuredClone(args.payload), metadata: { ...args.metadata, generation: args.claim.generation, contentHash: hash(JSON.stringify(args.payload)) }, sourceBytes: Buffer.from(args.source.bytes) };
      current.set(args.key, record); if (args.promoteLastGood) lastGood.set(args.key, record); return record;
    },
    readSource: async record => { calls.push({ action: 'source' }); return record.sourceBytes; },
    release: async (_dataset, key) => { calls.push({ action: 'release', key }); return true; },
  });
  return { api, calls, current, lastGood, advance: ms => { clockOffset += ms; }, failPublish: () => { failPublish = true; } };
}

async function prepare(api, rows, extra = {}) {
  const requests = [];
  const value = await prepareCftcContractRawHistory({ ...selection, expectedSelectedRaw: rows[0], persistence: api, outboundGate: gate,
    fetchImpl: async url => {
      const query = new URL(url).searchParams, offset = Number(query.get('$offset'));
      requests.push({ offset, limit: Number(query.get('$limit')), where: query.get('$where') });
      return Response.json(rows.slice(offset, offset + 200));
    }, ...extra });
  return { value, requests };
}

test('all-group background preparation is bounded to three pages and one source-document archive', async () => {
  const backing = store(), rows = rowsFor(600);
  const { value, requests } = await prepare(backing.api, rows);
  assert.equal(value.status, 'ready');
  assert.deepEqual(requests.map(item => [item.offset, item.limit]), [[0, 200], [200, 200], [400, 200]]);
  assert.equal(value.coverage.required_prior_reports, 520);
  assert.equal(value.coverage.prior_observations, 599);
  assert.equal(value.coverage.cap_reached, false);
  const written = backing.calls.find(item => item.action === 'publish').args;
  assert.equal(written.kind, 'source-document');
  assert.equal(written.key, `raw-history-v1:futures-only:tff:ABC:${throughDate}`);
  assert.deepEqual(JSON.parse(written.source.bytes), written.payload);
  assert.equal(Object.hasOwn(written.payload, 'savedAt'), false);
  assert.equal(Object.hasOwn(written.payload, 'retrievedAt'), false);
  assert.equal(backing.calls.filter(item => item.action === 'publish').length, 1);
  assert.equal(backing.calls.at(-1).action, 'release');
  assert.equal(value.durable_receipt.content_hash, backing.current.get(written.key).metadata.contentHash);
  const raw = await backing.api.contractRaw({ ...selection, validate: envelope => validateRawHistoryEnvelope(envelope, { ...selection, count: 520 }) });
  assert.deepEqual(raw.rows, rows);
  assert.equal(raw.retrievedAt, written.metadata.originalRetrievedAt);
  assert.equal(raw.savedAt, written.metadata.originalSavedAt);
});

test('short histories are successful bounded work, with insufficient depth explicitly disclosed', async () => {
  const backing = store();
  const { value, requests } = await prepare(backing.api, rowsFor(8));
  assert.equal(value.status, 'ready');
  assert.equal(requests.length, 1);
  assert.equal(value.coverage.source_exhausted, true);
  assert.equal(value.coverage.sufficient, false);
  assert.equal(value.coverage.prior_observations, 7);
  assert.equal(backing.lastGood.size, 1);
});

test('incomplete metrics hit the bounded cap and stay partial without last-good promotion', async () => {
  const backing = store(), rows = rowsFor(600, { lev_money_positions_long: null });
  const { value, requests } = await prepare(backing.api, rows);
  assert.equal(requests.length, 3);
  assert.equal(value.status, 'partial');
  assert.equal(value.coverage.cap_reached, true);
  assert.equal(value.coverage.prior_observations, 0);
  assert.equal(backing.current.size, 1);
  assert.equal(backing.lastGood.size, 0);
});

test('latest-source conflicts and missing verified selections cannot enter the archive', async () => {
  const backing = store(), rows = rowsFor(8);
  await assert.rejects(prepare(backing.api, rows, { expectedSelectedRaw: { ...rows[0], dealer_positions_long_all: '999' } }), error => error.code === 'CFTC_SOURCE_CONFLICT');
  assert.equal(backing.current.size, 0);
  assert.equal(backing.calls.at(-1).action, 'release');
  await assert.rejects(prepare(backing.api, rows, { expectedSelectedRaw: null }), error => error.code === 'CFTC_SOURCE_INCOMPLETE');
  await assert.rejects(prepare(backing.api, rows, { expectedSelectedRaw: { ...rows[0], futonly_or_combined: 'Combined' } }), error => error.code === 'CFTC_RESPONSE_INVALID');
});

test('mixed report-basis evidence is quarantined and cannot promote a ready archive', async () => {
  const backing = store(), rows = rowsFor(8);
  rows[2].futonly_or_combined = 'Combined';
  const { value } = await prepare(backing.api, rows);
  assert.equal(value.status, 'partial');
  assert.equal(value.coverage.quarantined_rows, 1);
  assert.equal(backing.lastGood.size, 0);
});

test('dedicated prepared raw is the first durable read and serves every group without upstream', async () => {
  const backing = store(), rows = rowsFor(280); await prepare(backing.api, rows);
  backing.calls.length = 0; let fetched = 0;
  const result = await fetchCftcContractHistory('tff', 'ABC', throughDate, 260, { persistence: backing.api, group: 'dealer', expectedSelectedRaw: rows[0],
    cacheGet: async () => { throw new Error('no temporary cache needed'); }, fetchImpl: async () => { fetched++; throw new Error('no public source fetch'); } });
  assert.equal(result.cacheStatus, 'prepared');
  assert.equal(result.rows.length, rows.length);
  assert.equal(fetched, 0);
  assert.deepEqual(backing.calls.map(item => item.action), ['read']);
  assert.equal(backing.calls[0].key, cftcContractRawKey(selection));
});

test('contract/date/family binding, original timestamps, and freshness are enforced on raw reads', async () => {
  const backing = store(), rows = rowsFor(8); await prepare(backing.api, rows);
  const options = { ...selection, validate: envelope => validateRawHistoryEnvelope(envelope, { ...selection, count: 520, now: new Date() }) };
  const before = await backing.api.contractRaw(options);
  const record = backing.current.get(cftcContractRawKey(selection));
  record.metadata.reportBasis = 'combined';
  assert.equal(await backing.api.contractRaw(options), null);
  record.metadata.reportBasis = 'futures_only';
  record.payload.code = 'OTHER';
  assert.equal(await backing.api.contractRaw(options), null);
  record.payload.code = 'ABC';
  assert.equal((await backing.api.contractRaw(options)).retrievedAt, before.retrievedAt);
  record.metadata.originalSavedAt = new Date(Date.now() - 16 * 86400_000).toISOString();
  record.metadata.revalidatedAt = record.metadata.originalSavedAt;
  assert.equal(await backing.api.contractRaw(options), null);
  assert.notEqual(cftcContractRawKey(selection), cftcContractRawKey({ ...selection, family: 'disaggregated' }));
  assert.throws(() => cftcContractRawKey({ ...selection, code: '../ABC' }));
});

test('publication failures remain safe, release their claim, and do not acknowledge success', async () => {
  const backing = store(); backing.failPublish();
  await assert.rejects(prepare(backing.api, rowsFor(8)), error => error.code === 'CFTC_DURABLE_PUBLICATION_FAILED' && !error.message.includes('private provider'));
  assert.equal(backing.current.size, 0);
  assert.equal(backing.calls.at(-1).action, 'release');
});

async function seedMarkets(backing, rows) {
  const leading = [['cftc_contract_market_code', 'ASC'], ['cftc_market_code', 'ASC'], ['contract_units', 'ASC'], ['id', 'ASC']];
  const used = new Set(leading.map(([field]) => field));
  const order = [...leading, ...CFTC_FAMILIES.tff.fields.filter(field => !used.has(field)).map(field => [field, 'ASC'])].map(([field, direction]) => `${field} ${direction}`).join(',');
  const sourceUrl = cftcResourceUrl('tff', { '$select': CFTC_FAMILIES.tff.fields.join(','), '$where': `report_date_as_yyyy_mm_dd='${throughDate}T00:00:00.000'`, '$order': order, '$limit': 500, '$offset': 0 });
  const response = cftcPublicationStatus(buildCftcMarketsSnapshot({ family: 'tff', reportDate: throughDate, latestRaw: [rows[0]], historyRaw: [], sourceUrl }), {
    cacheRequired: true, primaryPersisted: true, lastGoodPersisted: true, rawHistoryExpected: 0, rawHistoryPersisted: 0 });
  assert.equal(validMarketsResponse(response, 'tff', Date.now()), true);
  const envelope = { savedAt: new Date().toISOString(), response }, key = 'markets:tff:latest';
  const claim = await backing.api.reserve(key);
  await backing.api.save({ key, claim, envelope, latestRows: [rows[0]], validate: () => true });
}

test('a non-launch contract produces accurate public five-year history from the pinned catalog and raw archive', async () => {
  const backing = store(), rows = rowsFor(280); await seedMarkets(backing, rows); await prepare(backing.api, rows);
  const catalog = await backing.api.catalogRaw('tff', throughDate);
  assert.deepEqual(catalog.rows, [rows[0]]);
  assert.equal(catalog.report_basis, 'futures_only');
  assert.equal(await backing.api.catalogRaw('tff', prior(1)), null);
  let requests = 0;
  const result = await loadCftcHistory({ family: 'tff', code: 'ABC', group: 'leveraged-funds', window: '5y', persistence: backing.api,
    cacheGet: async () => null, fetchImpl: async () => { requests++; throw new Error('no public upstream'); } });
  assert.equal(requests, 0);
  assert.equal(result.selection.report_date, throughDate);
  assert.equal(result.history.length, 261);
  assert.deepEqual(result.selected.raw, normalizeCftcRow(rows[0], 'tff').value.raw);
  assert.equal(result.percentile.reason, null);
  assert.equal(Number.isFinite(result.percentile.value), true);
  assert.equal(result.freshness.cache_status, 'computed-from-prepared-raw');
});

test('a non-launch latest/history conflict is rejected without a public source crawl', async () => {
  const backing = store(), rows = rowsFor(280); await seedMarkets(backing, rows);
  const conflicting = rows.map((row, index) => index ? row : { ...row, dealer_positions_long_all: '999' });
  await prepare(backing.api, conflicting);
  let requests = 0;
  await assert.rejects(loadCftcHistory({ family: 'tff', code: 'ABC', group: 'dealer', window: '5y', persistence: backing.api,
    cacheGet: async () => null, fetchImpl: async () => { requests++; throw new Error('no public upstream'); } }), error => error.code === 'CFTC_REPORT_NOT_PREPARED');
  assert.equal(requests, 0);
});
