import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCftcPersistence, cftcSnapshotIdentity, cftcSourceBundle } from '../src/utils/cftcPersistence.js';
import { CFTC_FAMILIES, CFTC_LAUNCH_CATALOG } from '../src/utils/cftc.js';
import { CFTC_REFRESH_CHECKPOINT_VERSION, buildCftcMarketsSnapshot, cftcPublicationStatus, cftcResourceUrl, fetchCftcContractHistory, loadCftcHistory, loadCftcMarkets, publishPreparedResponse, refreshCftcSnapshots, validCftcRefreshCheckpoint, validMarketsResponse, validateRawHistoryEnvelope } from '../src/utils/cftcServer.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const priorDay = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400_000).toISOString().slice(0, 10);
const date = priorDay(new Date().toISOString().slice(0, 10), 1);
const retrievedAt = new Date(Date.now() - 10_000).toISOString();
const savedAt = new Date(Date.now() - 5_000).toISOString();
const base = JSON.parse(readFileSync(new URL('./fixtures/cftc-tff-gpe5-46if-v1.json', import.meta.url), 'utf8'))[0];
const codes = CFTC_LAUNCH_CATALOG.filter(item => item.family === 'tff').map(item => item.code);
const order = leading => {
  const seen = new Set(leading.map(([field]) => field));
  return [...leading, ...CFTC_FAMILIES.tff.fields.filter(field => !seen.has(field)).map(field => [field, 'ASC'])].map(([field, direction]) => `${field} ${direction}`).join(',');
};
const latestUrl = cftcResourceUrl('tff', { '$select': CFTC_FAMILIES.tff.fields.join(','), '$where': `report_date_as_yyyy_mm_dd='${date}T00:00:00.000'`, '$order': order([['cftc_contract_market_code', 'ASC'], ['cftc_market_code', 'ASC'], ['contract_units', 'ASC'], ['id', 'ASC']]), '$limit': 500, '$offset': 0 });
const launchUrl = cftcResourceUrl('tff', { '$select': CFTC_FAMILIES.tff.fields.join(','), '$where': `cftc_contract_market_code in(${codes.map(code => `'${code}'`).join(',')}) AND report_date_as_yyyy_mm_dd between '${priorDay(date, 6 * 366)}T00:00:00.000' and '${date}T23:59:59.999'`, '$order': order([['cftc_contract_market_code', 'ASC'], ['report_date_as_yyyy_mm_dd', 'DESC'], ['cftc_market_code', 'ASC'], ['contract_units', 'ASC'], ['id', 'ASC']]), '$limit': 1000, '$offset': 0 });
const rows = codes.flatMap(code => Array.from({ length: 261 }, (_, index) => ({ ...base, id: `${code}-${index}`, cftc_contract_market_code: code, report_date_as_yyyy_mm_dd: `${priorDay(date, index * 7)}T00:00:00.000` })));
const latestRows = rows.filter(row => row.report_date_as_yyyy_mm_dd.startsWith(date));
const response = cftcPublicationStatus(buildCftcMarketsSnapshot({ family: 'tff', reportDate: date, latestRaw: latestRows, historyRaw: rows, retrievedAt, sourceUrl: latestUrl, historySourceUrl: launchUrl }), { cacheRequired: true, primaryPersisted: true, lastGoodPersisted: true, rawHistoryExpected: codes.length, rawHistoryPersisted: codes.length });
const envelope = { savedAt, response };
const rawHistories = codes.map(code => ({ schema_version: 'edgar.cftc-raw-history.v2', family: 'tff', report_basis: 'futures_only', code, through_date: date, savedAt, retrievedAt, sourceUrl: launchUrl, pages: Math.ceil(rows.length / 1000), capReached: false, sourceExhausted: true, originScope: 'launch_selection', sourceRows: rows.length, sourcePageSize: 1000, sourceRowLimit: 5000, rows: rows.filter(row => row.cftc_contract_market_code === code) }));
const validate = value => validMarketsResponse(value?.response, 'tff', Date.now(), date);
const validateRaw = value => validateRawHistoryEnvelope(value, { family: 'tff', code: value.code, throughDate: date, count: 260 });

function fakeStore(initialMode = 'supabase') {
  const current = new Map(), lastGood = new Map(), generations = new Map(), calls = [];
  let currentMode = initialMode, failWrite = false, failRead = false;
  const api = createCftcPersistence({ mode: () => currentMode,
    begin: async (_dataset, key) => { calls.push('reserve'); const generation = (generations.get(key) || 0) + 1; generations.set(key, generation); return { key, generation }; },
    publish: async args => {
      calls.push('publish');
      if (failWrite || generations.get(args.key) !== args.claim.generation) throw new Error('private provider detail');
      const record = { payload: structuredClone(args.payload), metadata: { ...args.metadata, generation: args.claim.generation, contentHash: hash(JSON.stringify(args.payload)) }, sourceBytes: Buffer.from(args.source.bytes) };
      current.set(args.key, record);
      if (args.promoteLastGood) lastGood.set(args.key, record);
      return record;
    },
    read: async (_dataset, key, options) => { calls.push('read'); if (failRead) throw new Error('private provider detail'); return (options?.pointer === 'last-good' ? lastGood : current).get(key) || null; },
    readSource: async record => { calls.push('source'); return record.sourceBytes; },
  });
  return { api, current, lastGood, calls, setMode: value => { currentMode = value; }, setFailWrite: value => { failWrite = value; }, setFailRead: value => { failRead = value; } };
}

async function save(store, overrides = {}) {
  const key = 'markets:tff:latest', claim = await store.api.reserve(key);
  return store.api.save({ key, claim, envelope, rawHistories, latestRows, validate, validateRaw, promoteLastGood: true, ...overrides });
}

test('CFTC durable roundtrip preserves prepared formulas, exact raw provenance, and original retrieval time', async () => {
  assert.equal(validate(envelope), true);
  assert.equal(rawHistories.every(validateRaw), true);
  const store = fakeStore();
  await save(store);
  const prepared = await store.api.prepared('markets:tff:latest', { validate });
  assert.deepEqual(prepared, envelope);
  assert.equal(store.calls.includes('source'), false, 'ordinary markets reads do not download raw history');
  const raw = await store.api.raw('markets:tff:latest', { family: 'tff', code: codes[0], throughDate: date, validate: validateRaw });
  assert.deepEqual(raw, rawHistories[0]);
  assert.equal(raw.retrievedAt, retrievedAt);
  assert.deepEqual(store.lastGood.get('markets:tff:latest'), store.current.get('markets:tff:latest'));
});

test('unchanged source content does not manufacture archives when retrieval times change', () => {
  const earlier = cftcSourceBundle(rawHistories, latestRows);
  const later = cftcSourceBundle(rawHistories.map(item => ({ ...item, savedAt: '2030-01-01T00:00:00Z', retrievedAt: '2030-01-01T00:00:00Z' })), latestRows);
  assert.equal(earlier.bytes, later.bytes);
  assert.notDeepEqual(earlier.times, later.times);
  const revalidated = { savedAt: '2030-01-01T00:00:00Z', response: { ...response, retrieved_at: '2030-01-01T00:00:00Z', freshness: { ...response.freshness, cache_status: 'computed' } } };
  assert.deepEqual(cftcSnapshotIdentity('markets:tff:latest', envelope), cftcSnapshotIdentity('markets:tff:latest', revalidated));
});

test('off leaves legacy serving and source generation unchanged with zero datastore calls', async () => {
  const store = fakeStore('off');
  await save(store);
  const value = await loadCftcMarkets({ family: 'tff', persistence: store.api, cacheGet: async () => envelope, fetchImpl: () => { throw new Error('unexpected upstream'); } });
  assert.equal(value.report_date, date);
  assert.deepEqual(store.calls, []);
});

test('supabase public markets and raw misses never amplify into upstream requests, even if both stores fail', async () => {
  const store = fakeStore(); let requests = 0;
  store.setFailRead(true);
  await assert.rejects(loadCftcMarkets({ persistence: store.api, cacheGet: async () => { throw new Error('Redis down'); }, fetchImpl: async () => { requests++; return Response.json([]); } }), error => error.code === 'CFTC_REPORT_NOT_PREPARED');
  await assert.rejects(fetchCftcContractHistory('tff', codes[0], date, 260, { persistence: store.api, cacheGet: async () => { throw new Error('Redis down'); }, fetchImpl: async () => { requests++; return Response.json([]); } }), error => error.code === 'CFTC_REPORT_NOT_PREPARED');
  assert.equal(requests, 0);
});

test('supabase market read serves exact durable candidate and ignores provisional or retired payloads', async () => {
  const store = fakeStore(); await save(store);
  let legacyReads = 0;
  const value = await loadCftcMarkets({ persistence: store.api, cacheGet: async () => { legacyReads++; return null; } });
  assert.equal(value.report_date, date);
  assert.equal(legacyReads, 1, 'the existing Redis hot response is checked before a durable miss');
  const record = store.current.get('markets:tff:latest');
  record.payload = { savedAt, response: { ...response, price_source: 'retired' } };
  await assert.rejects(loadCftcMarkets({ persistence: store.api, cacheGet: async () => null }), error => error.code === 'CFTC_REPORT_NOT_PREPARED');
});

test('durable failure uses validated prepared rollback data and never exposes provider exception details', async () => {
  const store = fakeStore(); store.setFailRead(true);
  const value = await loadCftcMarkets({ persistence: store.api, cacheGet: async () => envelope });
  assert.equal(value.report_date, date);
  store.setFailWrite(true);
  await assert.rejects(save(store), error => error.code === 'CFTC_DURABLE_PUBLICATION_FAILED' && !error.message.includes('private provider'));
});

test('older generations and failed source/object publication preserve newer current and last-good', async () => {
  const store = fakeStore(), key = 'markets:tff:latest';
  const old = await store.api.reserve(key);
  await save(store);
  const good = store.current.get(key);
  await assert.rejects(store.api.save({ key, claim: old, envelope, rawHistories, latestRows, validate, validateRaw, promoteLastGood: true }), error => error.code === 'CFTC_DURABLE_PUBLICATION_FAILED');
  assert.equal(store.current.get(key), good);
  assert.equal(store.lastGood.get(key), good);
  store.setFailWrite(true);
  await assert.rejects(save(store), error => error.code === 'CFTC_DURABLE_PUBLICATION_FAILED');
  assert.equal(store.current.get(key), good);
  assert.equal(store.lastGood.get(key), good);
});

test('shadow writes compare only their own published generation and cap comparison reads', async () => {
  const store = fakeStore('shadow');
  for (let index = 0; index < 10; index++) await save(store);
  assert.equal(store.api.status().shadow_matches, 8);
  assert.equal(store.calls.filter(item => item === 'read').length, 8);
  assert.equal(await store.api.prepared('markets:tff:latest', { validate }), null);
  store.setFailWrite(true);
  assert.equal(await save(store), null, 'shadow storage failures cannot break legacy responses');
});

test('bounded market ingestion archives exact latest rows and every launch history and emits a private publication receipt', async () => {
  const store = fakeStore('shadow'), requests = [], receipts = [];
  const orderedRows = [...rows].sort((a, b) => a.cftc_contract_market_code.localeCompare(b.cftc_contract_market_code)
    || b.report_date_as_yyyy_mm_dd.localeCompare(a.report_date_as_yyyy_mm_dd));
  const orderedLatest = orderedRows.filter(row => row.report_date_as_yyyy_mm_dd.startsWith(date));
  const value = await loadCftcMarkets({ family: 'tff', forceRefresh: true, persistence: store.api, cacheGet: async () => null,
    onDurablePublication: receipt => receipts.push(receipt),
    fetchImpl: async input => {
      const url = new URL(input); requests.push(url);
      const where = url.searchParams.get('$where');
      if (where === "futonly_or_combined='FutOnly'") return Response.json(orderedLatest);
      if (where.startsWith('report_date_as_yyyy_mm_dd=')) return Response.json(orderedLatest);
      const offset = Number(url.searchParams.get('$offset'));
      return Response.json(orderedRows.slice(offset, offset + 1000));
    },
  });
  assert.equal(value.status, 'ready');
  assert.equal(requests.length, 2 + Math.ceil(rows.length / 1000), 'only the existing discovery, latest, and bounded launch-history requests run');
  const stored = store.current.get('markets:tff:latest');
  const source = JSON.parse(stored.sourceBytes.toString('utf8'));
  assert.deepEqual(source.latestRows, orderedLatest);
  assert.deepEqual(source.rawHistories.map(item => item.code).sort(), [...codes].sort());
  assert.deepEqual(source.rawHistories.flatMap(item => item.rows).sort((a, b) => a.id.localeCompare(b.id)), [...rows].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].raw_history_count, codes.length);
  assert.equal(receipts[0].report_date, date);
  assert.equal(receipts[0].content_hash, stored.metadata.contentHash);
  assert.equal(Object.hasOwn(value, 'durable_publication'), false, 'job evidence never changes the public response schema');
});

function refreshHarness(mode = 'shadow', prior = null) {
  const calls = [], checkpoints = [], finished = [];
  const claim = { id: 'job', generation: '1', jobKey: `cftc-refresh:${new Date().toISOString().slice(0, 10)}` };
  const cache = {
    enabled: () => true,
    get: async () => prior,
    set: async (_namespace, _key, checkpoint) => { checkpoints.push(structuredClone(checkpoint)); return true; },
    acquire: async () => 'refresh-owner',
    release: async () => { calls.push('release'); },
  };
  const persistence = {
    mode: () => mode,
    startRefreshJob: async () => mode === 'off' ? null : claim,
    checkpointRefreshJob: async () => {},
    completeRefreshJob: async (_claim, checkpoint, error) => { finished.push({ checkpoint: structuredClone(checkpoint), error }); },
  };
  return { cache, persistence, calls, checkpoints, finished };
}

const publicationFor = family => ({ generation: '1', content_hash: 'a'.repeat(64), report_date: date,
  raw_history_count: CFTC_LAUNCH_CATALOG.filter(item => item.family === family).length });
const readyFamily = family => ({ family, status: 'ready', report_date: date, catalog_rows: 13, cache_durable: true });

test('shadow refresh cannot complete on successful Redis publication when the Supabase write failed', async () => {
  const harness = refreshHarness(), store = fakeStore('shadow'); store.setFailWrite(true);
  const result = await refreshCftcSnapshots({ ...harness,
    loadMarkets: async ({ family, onDurablePublication }) => {
      harness.calls.push(family);
      const record = await save(store);
      if (record) onDurablePublication(publicationFor(family));
      return { ...response, catalog: [1], cache_publication: { durable: true } };
    },
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.checkpoint.complete, false);
  assert.equal(result.durable_job.status, 'retry');
  assert.equal(result.families.every(item => item.status === 'ready' && item.cache_durable && item.durable_published === false), true);
  assert.equal(harness.finished.at(-1).error, 'CFTC_REFRESH_DEGRADED');
  assert.equal(harness.checkpoints.every(value => validCftcRefreshCheckpoint(value)), true);
  assert.deepEqual(harness.calls, ['tff', 'disaggregated', 'release']);
});

test('durable refresh resumes only the family with verified Supabase evidence and retries a Redis-only checkpoint', async () => {
  const prior = { schema_version: CFTC_REFRESH_CHECKPOINT_VERSION, durable_required: true, started_at: retrievedAt, updated_at: savedAt, complete: false,
    families: { tff: { ...readyFamily('tff'), durable_published: true, durable_publication: publicationFor('tff') }, disaggregated: { ...readyFamily('disaggregated'), durable_published: false } },
  };
  const harness = refreshHarness('shadow', prior);
  const result = await refreshCftcSnapshots({ ...harness,
    loadMarkets: async ({ family, onDurablePublication }) => {
      harness.calls.push(family); onDurablePublication(publicationFor(family));
      return { ...response, catalog: [1], cache_publication: { durable: true } };
    },
  });
  assert.deepEqual(harness.calls, ['disaggregated', 'release']);
  assert.equal(result.status, 'ready');
  assert.equal(result.durable_job.status, 'done');
  assert.equal(harness.finished.at(-1).error, null);
  assert.equal(validCftcRefreshCheckpoint(harness.finished.at(-1).checkpoint), true);
});

test('off-mode refresh still completes on legacy publication without a Supabase receipt', async () => {
  const harness = refreshHarness('off');
  const result = await refreshCftcSnapshots({ ...harness, loadMarkets: async () => ({ ...response, catalog: [1], cache_publication: { durable: true } }) });
  assert.equal(result.status, 'ready');
  assert.equal(result.checkpoint.complete, true);
  assert.equal(Object.hasOwn(result, 'durable_job'), false);
  assert.equal(validCftcRefreshCheckpoint(harness.finished.at(-1).checkpoint), true);
});

test('supabase history can calculate from durable raw without another public-source retrieval', async () => {
  const store = fakeStore(); await save(store);
  let requests = 0;
  const value = await loadCftcHistory({ family: 'tff', code: codes[0], group: 'leveraged-funds', window: '1y', persistence: store.api, cacheGet: async () => null, fetchImpl: async () => { requests++; throw new Error('No public upstream allowed'); } });
  assert.equal(value.selection.report_date, date);
  assert.equal(value.freshness.cache_status, 'computed-from-prepared-raw');
  assert.equal(requests, 0);
  assert.equal(store.current.has(`history:tff:${codes[0]}:leveraged-funds:${date}:1y`), true);
});

for (const window of ['1y', '3y']) test(`${window} contract history persists a sufficient non-exhausted 200-row source page`, async () => {
  const store = fakeStore(); await save(store);
  let requests = 0;
  const subset = rawHistories[0].rows.slice(0, 200);
  const value = await loadCftcHistory({ family: 'tff', code: codes[0], group: 'leveraged-funds', window, forceRefresh: true, persistence: store.api, cacheGet: async () => null,
    fetchImpl: async () => { requests++; return Response.json(subset); },
  });
  assert.equal(requests, 1);
  assert.equal(value.selection.report_date, date);
  const key = `history:tff:${codes[0]}:leveraged-funds:${date}:${window}`;
  assert.equal(store.current.has(key), true);
  const raw = await store.api.raw(key, { family: 'tff', code: codes[0], throughDate: date,
    validate: candidate => validateRawHistoryEnvelope(candidate, { family: 'tff', code: codes[0], throughDate: date, count: window === '1y' ? 52 : 156, group: 'leveraged-funds' }),
  });
  assert.equal(raw.sourceExhausted, false);
  assert.equal(raw.rows.length, 200);
});

test('legacy staged/final publication survives a final-primary interruption and remains a usable rollback twin', async () => {
  const values = new Map(); let primaryWrites = 0;
  const published = await publishPreparedResponse({ cacheId: 'markets:tff:latest', lastGoodId: 'markets-last-good:tff:latest', response, savedAt, allowLastGood: true, cacheRequired: true,
    cacheWrite: async (_namespace, id, value) => { if (id === 'markets:tff:latest' && ++primaryWrites === 2) return false; values.set(id, value); return true; },
  });
  assert.equal(published.cache_publication.durable, true);
  const store = fakeStore('off');
  const rollback = await loadCftcMarkets({ persistence: store.api, cacheGet: async (_namespace, id) => values.get(id) || null });
  assert.equal(rollback.cache_publication.durable, true);
  assert.equal(rollback.report_date, date);
});

test('existing CFTC refresh gains an idempotent durable claim and exact resumable family checkpoints', async () => {
  const calls = [], claim = { id: 'job', generation: 3, jobKey: 'cftc-refresh:2026-09-13' };
  let enqueued = false;
  const checkpoint = { schema_version: CFTC_REFRESH_CHECKPOINT_VERSION, durable_required: true, started_at: retrievedAt, updated_at: savedAt, complete: false, families: { tff: { family: 'tff', status: 'ready', report_date: date, catalog_rows: 13, cache_durable: true, durable_published: false } } };
  const api = createCftcPersistence({ mode: () => 'shadow', now: () => Date.parse('2026-09-13T12:00:00Z'),
    enqueueJob: async args => { calls.push(['enqueue', args]); enqueued = true; return 'job'; },
    claimJob: async args => { calls.push(['claim', args]); return enqueued ? claim : null; },
    checkpointJob: async (owner, args) => { calls.push(['checkpoint', owner, args]); return true; },
    finishJob: async (owner, args) => { calls.push(['finish', owner, args]); return true; },
  });
  assert.equal(await api.startRefreshJob(checkpoint), claim);
  await api.checkpointRefreshJob(claim, checkpoint);
  await api.completeRefreshJob(claim, checkpoint, 'CFTC_REFRESH_DEGRADED');
  assert.equal(calls.find(item => item[0] === 'enqueue')[1].jobKey, 'cftc-refresh:2026-09-13');
  assert.equal(calls.find(item => item[0] === 'enqueue')[1].maxAttempts, 4);
  assert.equal(calls.find(item => item[0] === 'claim')[1].leaseSeconds, 300);
  assert.deepEqual(calls.find(item => item[0] === 'checkpoint')[2].checkpoint.refresh_checkpoint, checkpoint);
  assert.equal(calls.find(item => item[0] === 'finish')[2].status, 'retry');
  assert.equal(calls.find(item => item[0] === 'finish')[2].errorCode, 'CFTC_REFRESH_DEGRADED');
});

test('off-mode CFTC cron creates no durable jobs or checkpoint writes', async () => {
  const never = () => { throw new Error('off must not call the datastore'); };
  const api = createCftcPersistence({ mode: () => 'off', enqueueJob: never, claimJob: never, checkpointJob: never, finishJob: never });
  assert.equal(await api.startRefreshJob({}), null);
  await api.checkpointRefreshJob(null, {});
  await api.completeRefreshJob(null, {});
});

test('CFTC resume checks only the bounded recent daily jobs when Redis lost its checkpoint', async () => {
  const keys = [], previous = { id: 'prior', jobKey: 'cftc-refresh:2026-09-12', checkpoint: { refresh_checkpoint: { sentinel: 'original bounded family checkpoint' } } };
  const api = createCftcPersistence({ mode: () => 'supabase', now: () => Date.parse('2026-09-13T12:00:00Z'),
    enqueueJob: async () => { throw new Error('a resumed job must not create another job'); },
    claimJob: async ({ jobKey }) => { keys.push(jobKey); return jobKey === previous.jobKey ? previous : null; },
  });
  assert.equal(await api.startRefreshJob({ started_at: '2026-09-13T12:00:00Z' }), previous);
  assert.deepEqual(keys, ['cftc-refresh:2026-09-13', 'cftc-refresh:2026-09-12']);
});
