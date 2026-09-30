import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataStore, dataStoreContentHash, stableDataStoreJson } from '../src/utils/dataStore.js';

const env = { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: 'sb_secret_fixture',
  EDGAR_DATASTORE_NAMESPACE: 'fixture', EDGAR_DATASTORE_SEC: 'supabase', EDGAR_DATASTORE_FINANCIAL: 'supabase' };
const identity = 'a'.repeat(64);
const claim = { dataset: 'financial', key: 'one', owner: '00000000-0000-4000-8000-000000000001', generation: 1 };
const metadata = { fetchedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', nested: { value: 1 } };
const json = (value, status = 200) => Response.json(value, { status });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const row = (value = 1, extra = {}) => ({ id: `version-${value}`, identityHash: identity, generation: value,
  payload: { nested: { value } }, contentHash: dataStoreContentHash(stableDataStoreJson({ nested: { value } })),
  metadata, expiresAt: metadata.expiresAt, source: { nested: { value: 1 } }, ...extra });
function heldReads(runtime = { ...env }) {
  const requests = [];
  const store = createDataStore({ env: runtime, fetchImpl: async (url, init) => {
    const response = deferred();
    requests.push({ url, init, params: JSON.parse(init.body), resolve: response.resolve });
    return response.promise;
  } });
  return { store, requests };
}

test('singleflight keeps caller payloads, metadata, provenance, and stale policy independent', async () => {
  const { store, requests } = heldReads();
  const first = store.readDataset('financial', 'one');
  const second = store.readDataset('financial', 'one');
  const freshOnly = store.readDataset('financial', 'one', { allowStale: false });
  assert.equal(requests.length, 1);
  requests[0].resolve(json(row(1, { expiresAt: '2000-01-01T00:00:00Z' })));
  const [a, b, fresh] = await Promise.all([first, second, freshOnly]);
  assert.equal(fresh, null); assert.equal(a.stale, true);
  a.payload.nested.value = 99; a.metadata.nested.value = 99; a._source.nested.value = 99;
  assert.equal(b.payload.nested.value, 1); assert.equal(b.metadata.nested.value, 1); assert.equal(b._source.nested.value, 1);
  const latest = store.readDataset('financial', 'one', { allowStale: false });
  assert.equal(requests.length, 2);
  requests[1].resolve(json(row(2)));
  assert.equal((await latest).payload.nested.value, 2);
});

test('missing rows and failed version RPCs are shared only while pending and never cached', async () => {
  const { store, requests } = heldReads();
  for (const outcome of [null, 'failure', row()]) {
    const start = requests.length;
    const responses = Promise.allSettled(Array.from({ length: 8 }, () => store.readDataset('financial', 'one')));
    assert.equal(requests.length, start + 1);
    requests[start].resolve(outcome === 'failure' ? json({}, 503) : json(outcome));
    const result = await responses;
    assert.ok(result.every(item => outcome === 'failure' ? item.status === 'rejected' && item.reason.code === 'http_503'
      : item.status === 'fulfilled' && (outcome === null ? item.value === null : item.value.payload.nested.value === 1)));
  }
});

test('singleflight isolates endpoint, namespace, credential, dataset, key, pointer, and identity', async () => {
  const runtime = { ...env }, { store, requests } = heldReads(runtime);
  const reads = [store.readDataset('financial', 'one'), store.readDataset('financial', 'one'),
    store.readDataset('financial', 'one', { pointer: 'last-good' }),
    store.readDataset('financial', 'one', { pointer: 'rollback' }), store.readDataset('financial', 'two'),
    store.readDataset('sec', 'one'), store.readDatasetVersion('financial', 'one', identity),
    store.readDatasetVersion('financial', 'one', identity), store.readDatasetVersion('financial', 'one', 'b'.repeat(64))];
  assert.equal(requests.length, 7);
  runtime.SUPABASE_SECRET_KEY = 'sb_secret_changed'; reads.push(store.readDataset('financial', 'one'));
  runtime.EDGAR_DATASTORE_NAMESPACE = 'other'; reads.push(store.readDataset('financial', 'one'));
  runtime.SUPABASE_URL = 'http://localhost:54321'; reads.push(store.readDataset('financial', 'one'));
  assert.equal(requests.length, 10);
  requests.forEach(request => request.resolve(json(row())));
  assert.equal((await Promise.all(reads)).length, 12);
  // A second adapter never shares another adapter's injected transport/result.
  const other = heldReads(); const independent = other.store.readDataset('financial', 'one');
  assert.equal(other.requests.length, 1); other.requests[0].resolve(json(null)); assert.equal(await independent, null);
});

test('version coalescing registry is bounded and evicts completed reads', async () => {
  const { store, requests } = heldReads();
  const reads = Array.from({ length: 65 }, (_, index) => store.readDataset('financial', String(index)));
  reads.push(store.readDataset('financial', '0'), store.readDataset('financial', '64'));
  assert.equal(requests.length, 66, 'first 64 keys are tracked; overflow passes through without growing the registry');
  requests.forEach(request => request.resolve(json(null)));
  await Promise.all(reads);
  const next = [store.readDataset('financial', '64'), store.readDataset('financial', '64')];
  assert.equal(requests.length, 67, 'a completed batch frees the registry for later keys');
  requests[66].resolve(json(null)); await Promise.all(next);
});

test('lease barriers reject pre-acquisition sharing and old completions cannot remove newer reads', async () => {
  for (const outcome of ['acquired', 'busy', 'failed']) {
    const reads = [], mutation = deferred();
    const store = createDataStore({ env, fetchImpl: async (url) => {
      if (url.endsWith('/edgar_begin_write')) return mutation.promise;
      const response = deferred(); reads.push(response); return response.promise;
    } });
    const before = store.readDataset('financial', 'one');
    const writing = store.beginDatasetWrite('financial', 'one');
    const observedWrite = Promise.allSettled([writing]);
    const during = store.readDataset('financial', 'one');
    assert.equal(reads.length, 2, outcome);
    mutation.resolve(outcome === 'failed' ? json({}, 503) : json(outcome === 'busy' ? null : claim));
    await observedWrite;
    const after = store.readDataset('financial', 'one');
    assert.equal(reads.length, 3, outcome);
    reads[0].resolve(json(row(1))); await before;
    const shared = store.readDataset('financial', 'one');
    assert.equal(reads.length, 3, 'a pre-lease completion must not remove a post-lease pending read');
    reads[1].resolve(json(row(2))); await during;
    const alsoShared = store.readDataset('financial', 'one');
    assert.equal(reads.length, 3);
    reads[2].resolve(json(row(3)));
    assert.ok((await Promise.all([after, shared, alsoShared])).every(value => value.payload.nested.value === 3));
  }
});

test('publication and revalidation fence all selectors before and after settlement', async () => {
  for (const operation of ['publish', 'revalidate']) {
    for (const successful of [true, false]) {
      const pending = [], mutation = deferred(); let writing = false, identityCalls = 0;
      const store = createDataStore({ env, fetchImpl: async (url, init) => {
        const params = JSON.parse(init.body);
        if (url.endsWith(`/edgar_${operation}`)) return mutation.promise;
        // Internal publication existence and read-back queries stay independent
        // of ordinary version readers, including identical semantic identities.
        if (writing && operation === 'publish' && params.p_identity) {
          identityCalls++;
          return json(identityCalls === 1 ? null : row(3));
        }
        const response = deferred(); pending.push(response); return response.promise;
      } });
      const startReads = () => [store.readDataset('financial', 'one'),
        store.readDataset('financial', 'one', { pointer: 'last-good' }), store.readDatasetVersion('financial', 'one', identity)];
      const before = startReads(); writing = true;
      const action = operation === 'publish'
        ? store.publishDataset({ dataset: 'financial', key: 'one', claim, payload: row().payload, metadata })
        : store.revalidateDataset('financial', 'one', { claim, revalidatedAt: metadata.fetchedAt, expiresAt: metadata.expiresAt });
      const observed = Promise.allSettled([action]);
      // Wait until the publication's strict identity read reaches its write.
      if (operation === 'publish') while (identityCalls < 1) await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      writing = false;
      const during = startReads();
      assert.equal(pending.length, 6, `${operation}: pre-write reads must not be reused`);
      writing = true;
      mutation.resolve(successful ? json(operation === 'publish' ? 'version-3' : true) : json({}, 503));
      const [result] = await observed;
      assert.equal(result.status, successful ? 'fulfilled' : 'rejected');
      if (operation === 'publish') assert.equal(identityCalls, successful ? 2 : 1);
      writing = false;
      const after = startReads();
      assert.equal(pending.length, 9, `${operation}: post-write reads must not reuse during-write results`);
      pending.forEach((response, index) => response.resolve(json(row(Math.floor(index / 3) + 1))));
      const results = await Promise.all([...before, ...during, ...after]);
      assert.deepEqual(results.map(value => value.payload.nested.value), [1, 1, 1, 2, 2, 2, 3, 3, 3]);
    }
  }
});


test('an output lease also fences pending input reads from a different dataset', async () => {
  const requests = [];
  const store = createDataStore({ env, fetchImpl: async url => {
    if (url.endsWith('/edgar_begin_write')) return json(claim);
    const response = deferred(); requests.push(response); return response.promise;
  } });
  const oldInput = store.readDataset('sec', 'source');
  await store.beginDatasetWrite('financial', 'one');
  const capturedInput = store.readDataset('sec', 'source');
  assert.equal(requests.length, 2, 'post-lease source capture cannot share pre-lease input requests');
  requests[0].resolve(json(row(1))); requests[1].resolve(json(row(2)));
  assert.equal((await oldInput).payload.nested.value, 1);
  assert.equal((await capturedInput).payload.nested.value, 2);
});

test('joining a version RPC cannot extend its eight-second deadline and a timeout is retryable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  const store = createDataStore({ env, fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
    requests.push({ signal: init.signal, resolve });
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) });
  const first = store.readDataset('financial', 'one');
  t.mock.timers.tick(4000);
  const later = store.readDataset('financial', 'one');
  const completed = Promise.allSettled([first, later]);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(3999); assert.equal(requests[0].signal.aborted, false);
  t.mock.timers.tick(1);
  assert.ok((await completed).every(result => result.status === 'rejected' && result.reason.code === 'timeout'));
  const retry = store.readDataset('financial', 'one');
  assert.equal(requests.length, 2); requests[1].resolve(json(null)); assert.equal(await retry, null);
});

test('freshness is evaluated at delivery rather than the beginning of a shared RPC', async t => {
  let now = Date.parse('2026-09-30T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const { store, requests } = heldReads();
  const snapshot = row(1, { expiresAt: new Date(now + 1000).toISOString() });
  const staleAllowed = store.readDataset('financial', 'one');
  now += 1001;
  const freshOnly = store.readDataset('financial', 'one', { allowStale: false });
  assert.equal(requests.length, 1); requests[0].resolve(json(snapshot));
  assert.equal((await staleAllowed).stale, true); assert.equal(await freshOnly, null);
});
