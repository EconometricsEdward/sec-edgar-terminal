import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataStore, dataStoreContentHash, stableDataStoreJson } from '../src/utils/dataStore.js';

const env = { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: 'sb_secret_fixture', EDGAR_DATASTORE_NAMESPACE: 'fixture', EDGAR_DATASTORE_SEC: 'supabase', EDGAR_DATASTORE_FINANCIAL: 'supabase' };
const expiresAt = '2099-01-01T00:00:00.000Z';
const claim = { id: '8792e2b4-119f-4a72-8b1e-34cec2e38554', owner: '8792e2b4-119f-4a72-8b1e-34cec2e38554', generation: 1 };
function row(key, expired = false) {
  const payload = { key, value: 1.25 };
  return { id: key, generation: 3, identityHash: 'b'.repeat(64), contentHash: dataStoreContentHash(stableDataStoreJson(payload)), payload,
    expiresAt: expired ? '2000-01-01T00:00:00.000Z' : expiresAt,
    metadata: { fetchedAt: '2026-09-01T00:00:00.000Z', expiresAt: expired ? '2000-01-01T00:00:00.000Z' : expiresAt } };
}

test('one manifest RPC checks a hundred heads with aligned misses and no object download', async () => {
  const calls = [];
  const keys = Array.from({ length: 100 }, (_, i) => `issuer-${i}`);
  const store = createDataStore({ env, fetchImpl: async (url, options) => {
    calls.push({ url, params: JSON.parse(options.body) });
    return Response.json(keys.map((key, i) => i === 4 ? null : { key, id: key, generation: 1, expiresAt, objectPath: `fixture/sec/source/${'a'.repeat(64)}.json.gz`, metadata: { generation: 1 } }));
  } });
  const manifests = await store.readDatasetManifests('sec', keys);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /edgar_get_manifests$/);
  assert.deepEqual(calls[0].params.p_keys, keys);
  assert.equal(manifests[4], null);
  assert.equal(manifests[99].key, keys[99]);
  assert.equal(manifests[99].stale, false);
});

test('compact batch reads bound concurrent RPC work and preserve order, missing values and freshness', async () => {
  const keys = Array.from({ length: 19 }, (_, i) => `issuer-${i}`);
  let active = 0, peak = 0; const calls = [];
  const store = createDataStore({ env, fetchImpl: async (url, options) => {
    const params = JSON.parse(options.body); calls.push(params);
    assert.match(url, /edgar_get_compact_batch$/);
    assert.ok(params.p_keys.length <= 5);
    active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, params.p_keys[0] === 'issuer-0' ? 15 : 5));
    active -= 1;
    return Response.json(params.p_keys.map(key => key === 'issuer-3' ? null : row(key, key === 'issuer-7')));
  } });
  const results = await store.readDatasetBatch('financial', keys, { allowStale: false });
  assert.equal(calls.length, 4); assert.ok(peak <= 3);
  assert.deepEqual(results.map(item => item?.payload.key ?? null), keys.map(key => ['issuer-3','issuer-7'].includes(key) ? null : key));
  assert.equal(results[0].metadata.generation, 3);
  assert.equal(results[0].serializedPayload, stableDataStoreJson(row(keys[0]).payload));
});

test('compact batch refuses oversized object pointers and corrupted compact hashes without downloading Storage', async () => {
  for (const malformed of [{ ...row('one'), objectPath: 'fixture/sec/source/something.json.gz' }, { ...row('one'), contentHash: 'f'.repeat(64) }]) {
    let calls = 0;
    const store = createDataStore({ env, fetchImpl: async url => {
      calls += 1; assert.match(url, /edgar_get_compact_batch$/); return Response.json([malformed]);
    } });
    await assert.rejects(store.readDatasetBatch('financial',['one']), error => ['invalid_compact_batch','compact_integrity_mismatch'].includes(error.code));
    assert.equal(calls,1);
  }
});

test('invalid batch inputs and off-mode issue no requests; response shape errors are explicit', async () => {
  let calls = 0;
  const store = createDataStore({ env, fetchImpl: async () => { calls += 1; return Response.json([]); } });
  for (const keys of [null, [null], [''], Array(101).fill('one')]) await assert.rejects(store.readDatasetManifests('sec',keys));
  assert.equal(calls,0);
  await assert.rejects(store.readDatasetManifests('sec',['one']), { code: 'invalid_manifest_batch' });
  await assert.rejects(store.readDatasetBatch('sec',['one']), { code: 'invalid_compact_batch' });
  const off = createDataStore({ env: {}, fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.deepEqual(await off.readDatasetManifests('sec',['one']), [null]);
  assert.deepEqual(await off.readDatasetBatch('financial',[]), []);
});

test('coverage job RPCs use prefix isolation, batched enqueue and explicit fenced continuation', async () => {
  const calls = [];
  const store = createDataStore({ env, fetchImpl: async (url, options) => { calls.push({ url, params: JSON.parse(options.body) }); return Response.json(true); } });
  await store.claimDataStoreJob({ dataset:'sec', prefix:'sec-coverage-v1:', leaseSeconds:270 });
  await store.yieldDataStoreJob(claim,{ checkpoint:{ cursor:8 }, retryAfterSeconds:2 });
  await store.enqueueCoverageJobs({ cycle:'2026-09-13', version:'a'.repeat(16), shards:[0,31] });
  assert.match(calls[0].url,/edgar_claim_job_prefix$/);
  assert.equal(calls[0].params.p_prefix,'sec-coverage-v1:');
  assert.match(calls[1].url,/edgar_yield_job$/);
  assert.deepEqual(calls[1].params.p_claim,claim);
  assert.match(calls[2].url,/edgar_enqueue_coverage_jobs$/);
  assert.deepEqual(calls[2].params.p_shards,[0,31]);
  await assert.rejects(store.claimDataStoreJob({dataset:'sec',prefix:'sec-',jobKey:'other'}),{code:'invalid_job_prefix'});
  await assert.rejects(store.yieldDataStoreJob(claim,{checkpoint:{},retryAfterSeconds:0}),{code:'invalid_job_yield'});
  await assert.rejects(store.enqueueCoverageJobs({cycle:'2026-02-31',version:'a'.repeat(16)}),{code:'invalid_coverage_jobs'});
  await assert.rejects(store.enqueueCoverageJobs({cycle:'2026-09-13',version:'a'.repeat(16),shards:[1,1]}),{code:'invalid_coverage_jobs'});
  assert.equal(calls.length,3);
});
