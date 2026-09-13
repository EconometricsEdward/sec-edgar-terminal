import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createDataStore, dataStoreContentHash, getDataStoreMode, stableDataStoreJson } from '../src/utils/dataStore.js';

const timestamp = '2026-09-01T00:00:00.000Z';
const baseEnv = { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: 'sb_secret_fixture', EDGAR_DATASTORE_NAMESPACE: 'fixture', EDGAR_DATASTORE_CFTC: 'shadow', EDGAR_DATASTORE_SEC: 'shadow', EDGAR_DATASTORE_FINANCIAL: 'supabase' };
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function metadata(extra = {}) { return { fetchedAt: timestamp, sourceUrl: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json', expiresAt: '2099-01-01T00:00:00Z', ...extra }; }
function fixture({ failUpload = false, corruptObject = false, afterPublish } = {}) {
  const heads = new Map(), versions = new Map(), objects = new Map(), calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname; calls.push({ path, method: init.method, headers: init.headers });
    if (path.startsWith('/storage/v1/object/')) {
      const key = path.replace('/authenticated/', '/').replace('/storage/v1/object/edgar-durable-private/', '');
      if (init.method === 'GET') return new Response(corruptObject ? gzipSync(Buffer.from('{}')) : objects.get(key));
      if (failUpload) return json({ code: 'upload_error' }, 503);
      if (!objects.has(key)) objects.set(key, Buffer.from(await new Response(init.body).arrayBuffer()));
      return json({ Key: key });
    }
    const name = path.split('/').pop(), p = JSON.parse(init.body), key = `${p.p_dataset}:${p.p_key}`;
    if (name === 'edgar_begin_write') {
      const head = heads.get(key) || { generation: 0 };
      if (head.owner) return json(null);
      head.generation += 1; head.owner = p.p_owner; heads.set(key, head);
      return json({ dataset: p.p_dataset, key: p.p_key, generation: head.generation, owner: head.owner });
    }
    if (name === 'edgar_get_version') {
      const head = heads.get(key);
      const row = versions.get(`${key}:${p.p_identity || (p.p_pointer === 'last-good' ? head?.lastGood : head?.current)}`);
      return json(row ? { ...row, metadata: { ...row.metadata, ...(head?.current === row.identityHash ? head.revalidation : {}) } } : null);
    }
    if (name === 'edgar_publish') {
      const head = heads.get(key);
      if (!head || head.generation !== p.p_claim.generation || head.owner !== p.p_claim.owner) return json({ code: '40001' }, 409);
      const rec = p.p_record, versionKey = `${key}:${rec.identityHash}`;
      if (!versions.has(versionKey)) versions.set(versionKey, { ...rec, id: `version-${versions.size + 1}`, generation: head.generation });
      head.current = rec.identityHash; if (p.p_promote_good) head.lastGood = rec.identityHash;
      head.revalidation = { revalidatedAt: rec.metadata.revalidatedAt || rec.metadata.fetchedAt, expiresAt: rec.metadata.expiresAt };
      head.owner = null; await afterPublish?.({ versions, head, key });
      return json(versions.get(versionKey).id);
    }
    if (name === 'edgar_revalidate') {
      const head = heads.get(key); if (!head || head.generation !== p.p_claim.generation || head.owner !== p.p_claim.owner) return json(false);
      head.revalidation = p.p_metadata; head.owner = null; return json(true);
    }
    throw new Error(`Unexpected fixture RPC ${name}`);
  };
  return { store: createDataStore({ env: baseEnv, fetchImpl }), heads, versions, objects, calls };
}

test('off is independently controlled and does not even request configuration', async () => {
  let calls = 0;
  const store = createDataStore({ env: {}, fetchImpl: async () => { calls++; throw new Error(); } });
  assert.equal(await store.readDataset('sec', 'one'), null);
  assert.equal(await store.beginDatasetWrite('cftc', 'one'), null);
  assert.equal(getDataStoreMode('sec', { EDGAR_DATASTORE_SEC: 'typo' }), 'off');
  assert.equal(getDataStoreMode('financial', baseEnv), 'supabase');
  assert.equal(calls, 0);
});

test('privileged production credentials are denied in previews regardless of namespace or trusted flag', async () => {
  let calls = 0;
  const store = createDataStore({ env: { ...baseEnv, SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co', VERCEL_ENV: 'preview', EDGAR_DATASTORE_TRUSTED_INGEST: '1' }, fetchImpl: async () => { calls++; return json(null); } });
  await assert.rejects(store.readDataset('sec', 'one'), { code: 'preview_production_credentials_denied' });
  assert.equal(calls, 0);
});

test('remote endpoints and implicit local production-key use are refused', async () => {
  for (const url of ['https://different.supabase.co', 'https://evil.example', 'http://vvkihuduqqnxqahhbphs.supabase.co']) {
    const store = createDataStore({ env: { ...baseEnv, SUPABASE_URL: url }, fetchImpl: async () => { throw new Error('must not fetch'); } });
    await assert.rejects(store.readDataset('sec', 'one'), { code: 'unapproved_endpoint' });
  }
  const store = createDataStore({ env: { ...baseEnv, SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co' } });
  await assert.rejects(store.readDataset('sec', 'one'), { code: 'untrusted_runtime' });
});

test('compact round trip is deterministic and missing is distinct from dependency failure', async () => {
  const f = fixture(); assert.equal(await f.store.readDataset('financial', 'a'), null);
  const claim = await f.store.beginDatasetWrite('financial', 'a');
  const result = await f.store.publishDataset({ dataset: 'financial', key: 'a', claim, payload: { z: null, a: 10.25 }, metadata: metadata() });
  assert.deepEqual(result.payload, { a: 10.25, z: null });
  assert.equal(result.metadata.versionId, 'version-1'); assert.equal(result.metadata.generation, 1);
  assert.equal(f.objects.size, 0);
  assert.ok(f.calls.every(call => call.headers.apikey === 'sb_secret_fixture' && !call.headers.Authorization));
  const failing = createDataStore({ env: baseEnv, fetchImpl: async () => { throw new Error('credential must never echo'); } });
  await assert.rejects(failing.readDataset('sec', 'one'), error => error.code === 'transport_failure' && !error.message.includes('credential'));
});

test('one immutable source object serves SEC source evidence and parsed document', async () => {
  const f = fixture(), key = 'sec-documents-v1:CIK0000320193:companyfacts';
  const bytes = Buffer.from('{ "cik":320193, "facts": {"us-gaap":{}} }\n');
  const claim = await f.store.beginDatasetWrite('sec', key);
  const result = await f.store.publishDataset({ dataset: 'sec', key, claim, payload: JSON.parse(bytes), metadata: metadata(), source: { bytes, url: metadata().sourceUrl, fetchedAt: timestamp }, kind: 'source-document' });
  assert.equal(f.objects.size, 1); assert.equal(result.metadata.contentHash, dataStoreContentHash(bytes));
  assert.deepEqual(result.payload, JSON.parse(bytes));
  assert.deepEqual(await f.store.readDatasetSource(result), bytes);
  assert.equal([...f.versions.values()][0].objectPath, [...f.versions.values()][0].source.objectPath);
});

test('upload failure and verified-object corruption never publish a DB pointer', async () => {
  for (const option of [{ failUpload: true }, { corruptObject: true }]) {
    const f = fixture(option), claim = await f.store.beginDatasetWrite('sec', 'one');
    await assert.rejects(f.store.publishDataset({ dataset: 'sec', key: 'one', claim, payload: { cik: 1 }, metadata: metadata(), source: { bytes: '{"cik":1}', url: metadata().sourceUrl }, kind: 'source-document' }));
    assert.equal(f.versions.size, 0);
    assert.ok(!f.calls.some(call => call.path.endsWith('/edgar_publish')));
  }
});

test('unchanged explicit semantic identity reuses source and snapshot despite retrieval clocks', async () => {
  const f = fixture(), key = 'tff:current';
  const source = { bytes: '{"positions":[1,2,3]}', url: 'https://publicreporting.cftc.gov/resource/test.json', fetchedAt: timestamp };
  for (let day = 1; day <= 2; day++) {
    const at = `2026-09-0${day}T00:00:00.000Z`, claim = await f.store.beginDatasetWrite('cftc', key);
    await f.store.publishDataset({ dataset: 'cftc', key, claim, payload: { savedAt: at, retrieved_at: at, value: 12 }, source,
      metadata: metadata({ fetchedAt: at, sourceUrl: source.url, rawHistoryTimes: [{ savedAt: at }] }), identityInputs: { reportPeriod: '2026-08-25', formulaVersion: '1', value: 12 } });
  }
  assert.equal(f.versions.size, 1); assert.equal(f.objects.size, 1);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.startsWith('/storage/')).length, 1);
  const result = await f.store.readDataset('cftc', key);
  assert.equal(result.payload.savedAt, timestamp); assert.equal(result.metadata.fetchedAt, timestamp);
  assert.equal(result.metadata.revalidatedAt, '2026-09-02T00:00:00.000Z');
});

test('source revisions create versions while partial updates preserve last-good', async () => {
  const f = fixture(), key = 'tff:current';
  for (const value of [1, 2]) {
    const claim = await f.store.beginDatasetWrite('cftc', key);
    await f.store.publishDataset({ dataset: 'cftc', key, claim, payload: { value }, metadata: metadata({ sourceUrl: 'https://www.cftc.gov/' }), promoteLastGood: value === 1 });
  }
  assert.equal(f.versions.size, 2);
  assert.equal((await f.store.readDataset('cftc', key)).payload.value, 2);
  assert.equal((await f.store.readDataset('cftc', key, { pointer: 'last-good' })).payload.value, 1);
});

test('publish returns its exact version even when current changes before the following read', async () => {
  const f = fixture({ afterPublish: async ({ versions, head, key }) => {
    versions.set(`${key}:newer`, { id: 'newer', identityHash: 'newer', payload: { value: 999 }, contentHash: dataStoreContentHash(stableDataStoreJson({ value: 999 })), metadata: metadata(), generation: 999 });
    head.current = 'newer';
  } });
  const claim = await f.store.beginDatasetWrite('financial', 'one');
  const result = await f.store.publishDataset({ dataset: 'financial', key: 'one', claim, payload: { value: 1 }, metadata: metadata() });
  assert.equal(result.payload.value, 1); assert.equal(result.metadata.generation, 1);
});

test('malformed/mismatched claims and fabricated source documents fail before writes', async () => {
  const f = fixture(), claim = await f.store.beginDatasetWrite('sec', 'one');
  await assert.rejects(f.store.publishDataset({ dataset: 'sec', key: 'two', claim, payload: {}, metadata: metadata() }), { code: 'claim_resource_mismatch' });
  await assert.rejects(f.store.publishDataset({ dataset: 'sec', key: 'one', claim: {}, payload: {}, metadata: metadata() }), { code: 'invalid_claim' });
  await assert.rejects(f.store.publishDataset({ dataset: 'sec', key: 'one', claim, payload: { cik: 2 }, metadata: metadata(), source: { bytes: '{"cik":1}', url: metadata().sourceUrl }, kind: 'source-document' }), { code: 'source_payload_mismatch' });
  await assert.rejects(f.store.publishDataset({ dataset: 'sec', key: 'one', claim, payload: { value: NaN }, metadata: metadata() }), { code: 'non_finite_value' });
  assert.equal(f.versions.size, 0);
});

test('compressed object size and compact content integrity are checked on read', async () => {
  const invalidCompact = createDataStore({ env: baseEnv, fetchImpl: async () => json({ payload: { value: 99 }, contentHash: '0'.repeat(64), metadata: metadata() }) });
  await assert.rejects(invalidCompact.readDataset('financial', 'one'), { code: 'compact_integrity_mismatch' });
  const invalidObject = createDataStore({ env: baseEnv, fetchImpl: async (url) => url.includes('/rpc/')
    ? json({ objectPath: `fixture/sec/source/${'0'.repeat(64)}.json.gz`, contentHash: '0'.repeat(64), rawBytes: 2, storedBytes: 2, metadata: metadata() })
    : new Response('x', { headers: { 'Content-Length': String(7 * 1024 * 1024) } }) });
  await assert.rejects(invalidObject.readDataset('sec', 'one'), { code: 'response_too_large' });
});

test('job completion respects Retry-After and never submits raw exception details', async () => {
  let submitted;
  const store = createDataStore({ env: baseEnv, fetchImpl: async (_url, init) => { submitted = JSON.parse(init.body); return json(true); } });
  await store.finishDataStoreJob({ id: 'id', owner: '00000000-0000-4000-8000-000000000001', generation: 1, attempts: 2 }, { status: 'retry', retryAfterSeconds: 900, errorCode: 'SEC HTTP 429', checkpoint: { cursor: 2 } });
  assert.equal(submitted.p_delay_seconds, 900); assert.equal(submitted.p_error, 'SEC_HTTP_429'); assert.deepEqual(submitted.p_checkpoint, { cursor: 2 });
});

test('identical large prepared payloads under two resource keys share one immutable object', async () => {
  const f = fixture(), payload = { series: 'x'.repeat(70000) };
  for (const key of ['tff:current', 'tff:2026-08-25']) {
    const claim = await f.store.beginDatasetWrite('cftc', key);
    await f.store.publishDataset({ dataset: 'cftc', key, claim, payload, metadata: metadata({ sourceUrl: 'https://www.cftc.gov/' }) });
  }
  assert.equal(f.versions.size, 2); assert.equal(f.objects.size, 1);
  assert.deepEqual((await f.store.readDataset('cftc', 'tff:current')).payload, payload);
});

test('revalidation rejects expired ownership and longer Retry-After is not shortened', async () => {
  let body;
  const store = createDataStore({ env: baseEnv, fetchImpl: async (url, init) => { body = JSON.parse(init.body); return json(!url.endsWith('/edgar_revalidate')); } });
  const claim = { dataset: 'sec', key: 'one', id: 'one', owner: '00000000-0000-4000-8000-000000000001', generation: 1 };
  await assert.rejects(store.revalidateDataset('sec', 'one', { claim, revalidatedAt: timestamp, expiresAt: timestamp }), { code: 'stale_generation' });
  await store.finishDataStoreJob(claim, { status: 'retry', retryAfterSeconds: 172800 });
  assert.equal(body.p_delay_seconds, 172800); assert.equal(body.p_status, 'retry');
});

test('immutable object reuse coalesces downloads while every read observes head expiry and revisions', async () => {
  const values = [{ rows: [{ value: 1 }], padding: 'x'.repeat(70000) }, { rows: [{ value: 2 }], padding: 'x'.repeat(70000) }];
  const bytes = values.map(value => Buffer.from(stableDataStoreJson(value)));
  const hashes = bytes.map(dataStoreContentHash), zipped = bytes.map(value => gzipSync(value));
  let current = 0, expiresAt = '2099-01-01T00:00:00Z', reads = 0, downloads = 0;
  const store = createDataStore({ env: baseEnv, fetchImpl: async (url) => {
    if (url.includes('/rpc/')) {
      reads++;
      return json({ id: `version-${current}`, identityHash: hashes[current], generation: current + 1,
        objectPath: `fixture/financial/snapshot/${hashes[current]}.json.gz`, contentHash: hashes[current],
        rawBytes: bytes[current].length, storedBytes: zipped[current].length, metadata: metadata(), expiresAt });
    }
    downloads++;
    await new Promise(resolve => setTimeout(resolve, 15));
    return new Response(zipped[hashes.findIndex(hash => url.includes(hash))]);
  } });
  const results = await Promise.all(Array.from({ length: 12 }, () => store.readDataset('financial', 'one')));
  assert.equal(reads, 12); assert.equal(downloads, 1);
  assert.equal(results[0].serializedPayload, bytes[0].toString());
  assert.throws(() => { results[0].payload.rows[0].value = 99; }, TypeError);
  results[0].metadata.fetchedAt = 'mutated caller metadata';
  expiresAt = '2000-01-01T00:00:00Z';
  const stale = await store.readDataset('financial', 'one');
  assert.equal(stale.stale, true); assert.equal(stale.metadata.fetchedAt, timestamp);
  assert.equal(await store.readDataset('financial', 'one', { allowStale: false }), null);
  assert.equal(downloads, 1);
  current = 1; expiresAt = '2099-01-01T00:00:00Z';
  const revised = await store.readDataset('financial', 'one');
  assert.equal(revised.payload.rows[0].value, 2); assert.equal(revised.metadata.generation, 2);
  assert.equal(downloads, 2); assert.equal(reads, 15);
});

test('failed object reads are retried and exact source export bypasses cached parsed payload', async () => {
  const bytes = Buffer.from('{ "rows": [1,2,3] }\n'), zipped = gzipSync(bytes), hash = dataStoreContentHash(bytes);
  const asset = { objectPath: `fixture/sec/source/${hash}.json.gz`, contentHash: hash, rawBytes: bytes.length, storedBytes: zipped.length };
  let fail = true, downloads = 0;
  const store = createDataStore({ env: baseEnv, fetchImpl: async url => {
    if (url.includes('/rpc/')) return json({ ...asset, metadata: metadata(), source: asset });
    downloads++;
    return fail ? json({ code: 'outage' }, 503) : new Response(zipped);
  } });
  await assert.rejects(store.readDataset('sec', 'one'), { code: 'http_503' });
  fail = false;
  const result = await store.readDataset('sec', 'one');
  assert.equal(downloads, 2); assert.equal(result.serializedPayload, bytes.toString());
  fail = true;
  assert.deepEqual((await store.readDataset('sec', 'one')).payload, { rows: [1, 2, 3] });
  await assert.rejects(store.readDatasetSource(result), { code: 'http_503' });
  assert.equal(downloads, 3);
});

test('object content reuse never crosses a changed credential boundary or bypasses upload verification', async () => {
  const env = { ...baseEnv }, bytes = Buffer.from('{"value":1}'), zipped = gzipSync(bytes), hash = dataStoreContentHash(bytes);
  let downloads = 0;
  const store = createDataStore({ env, fetchImpl: async (url, init) => {
    if (url.includes('/rpc/')) return json({ objectPath: `fixture/sec/source/${hash}.json.gz`, contentHash: hash, rawBytes: bytes.length, storedBytes: zipped.length, metadata: metadata() });
    downloads++;
    return init.headers.apikey === baseEnv.SUPABASE_SECRET_KEY ? new Response(zipped) : json({}, 401);
  } });
  await store.readDataset('sec', 'one');
  env.SUPABASE_SECRET_KEY = 'sb_secret_different';
  await assert.rejects(store.readDataset('sec', 'one'), { code: 'http_401' });
  assert.equal(downloads, 2);
  const f = fixture(), payload = { series: 'x'.repeat(70000) };
  for (const key of ['one', 'two']) {
    const claim = await f.store.beginDatasetWrite('financial', key);
    await f.store.publishDataset({ dataset: 'financial', key, claim, payload, metadata: metadata() });
  }
  // Two uploads require two actual read-back verifications; only the subsequent
  // immutable serving read can reuse the first parsed snapshot.
  assert.equal(f.calls.filter(call => call.path.startsWith('/storage/') && call.method === 'GET').length, 3);
});

test('immutable content cache evicts by decoded input budget and absolute age', async t => {
  let now = Date.parse('2026-09-13T00:00:00Z'), downloads = 0;
  t.mock.method(Date, 'now', () => now);
  const assets = Array.from({ length: 5 }, (_, index) => {
    const bytes = Buffer.from(JSON.stringify({ index, text: 'x'.repeat(7 * 1024 * 1024) }));
    const zipped = gzipSync(bytes), contentHash = dataStoreContentHash(bytes);
    return { zipped, row: { objectPath: `fixture/financial/snapshot/${contentHash}.json.gz`, contentHash, rawBytes: bytes.length, storedBytes: zipped.length, metadata: metadata() } };
  });
  const store = createDataStore({ env: baseEnv, fetchImpl: async (url, init) => {
    if (url.includes('/rpc/')) return json(assets[Number(JSON.parse(init.body).p_key)].row);
    downloads++;
    return new Response(assets.find(asset => url.includes(asset.row.contentHash)).zipped);
  } });
  for (let index = 0; index < assets.length; index++) await store.readDataset('financial', String(index));
  assert.equal(downloads, 5);
  await store.readDataset('financial', '4'); assert.equal(downloads, 5);
  // Five 7MiB decoded inputs cannot all remain in a 32MiB cache.
  await store.readDataset('financial', '0'); assert.equal(downloads, 6);
  now += 59000;
  await store.readDataset('financial', '0'); assert.equal(downloads, 6);
  now += 1001;
  const reread = await store.readDataset('financial', '0');
  assert.equal(downloads, 7); assert.equal(reread.metadata.fetchedAt, timestamp);
});
