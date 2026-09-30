import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setImmediate } from 'node:timers/promises';
import { createDisposableCache } from '../src/utils/disposableCache.js';
import { createWarmDataCache } from '../src/utils/warmCache.js';

const NOW = Date.parse('2026-09-27T18:00:00Z');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function record(id, value) {
  const raw = Buffer.from(JSON.stringify({ id, value })), gzip = gzipSync(raw);
  return { id, gzipBase64: gzip.toString('base64'), rawSha256: hash(raw), gzipSha256: hash(gzip), rawBytes: raw.length,
    storedBytes: gzip.length, writtenAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 60000).toISOString() };
}
function fixture() {
  const reads = [], writes = [], waiters = [];
  const cache = createDisposableCache({ env: { VERCEL_ENV: 'production' }, now: () => NOW, identityTokenImpl: async () => 'fixture.identity.token',
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      const params = JSON.parse(init.body);
      const target = url.endsWith('edgar_cache_get') ? reads : writes;
      const abort = () => reject(init.signal.reason);
      init.signal.addEventListener('abort', abort, { once: true });
      target.push({ url, params, signal: init.signal, resolve: response => {
        init.signal.removeEventListener('abort', abort); resolve(response);
      } });
      for (const check of [...waiters]) check();
    }),
  });
  function until(target, count) {
    if (target.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { remove(); reject(new Error(`Expected ${count} requests, saw ${target.length}`)); }, 2000);
      const remove = () => { const index = waiters.indexOf(check); if (index >= 0) waiters.splice(index, 1); clearTimeout(timer); };
      const check = () => { if (target.length >= count) { remove(); resolve(); } };
      waiters.push(check);
    });
  }
  function answer(index, value = 1) {
    const request = reads[index];
    request.resolve(Response.json(request.params.p_ids.map(id => record(id, value))));
  }
  return { cache, reads, writes, until, answer };
}

test('simultaneous canonical cache reads share one RPC but completed values are never retained', async () => {
  const { cache, reads, until, answer } = fixture();
  const first = cache.cacheGet('holders-v3', 'aapl'), second = cache.cacheGet('holders-v3', 'AAPL');
  await until(reads, 1); await setImmediate();
  assert.equal(reads.length, 1);
  answer(0);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b); assert.ok(Object.isFrozen(a.payload));
  const next = cache.cacheGet('holders-v3', 'AAPL');
  await until(reads, 2); answer(1, 2);
  assert.equal((await next).payload.value, 2);
});

test('ordered batch keys preserve duplicate positions and separate namespaces', async () => {
  const { cache, reads, until, answer } = fixture();
  const requests = [
    cache.cacheGetMany('holders-v3', ['AAPL', 'MSFT', 'AAPL']),
    cache.cacheGetMany('holders-v3', ['aapl', 'msft', 'aapl']),
    cache.cacheGetMany('holders-v3', ['MSFT', 'AAPL', 'AAPL']),
    cache.cacheGetMany('risk-workspace-v9', ['AAPL', 'MSFT', 'AAPL']),
  ];
  await until(reads, 3); await setImmediate(); assert.equal(reads.length, 3);
  reads.forEach((_, index) => answer(index));
  const result = await Promise.all(requests);
  assert.deepEqual(result.map(rows => rows.map(row => row.payload.id)), [
    ['AAPL', 'MSFT', 'AAPL'], ['AAPL', 'MSFT', 'AAPL'], ['MSFT', 'AAPL', 'AAPL'], ['AAPL', 'MSFT', 'AAPL'],
  ]);
  assert.deepEqual(reads.map(read => read.params.p_ids), [['AAPL', 'MSFT', 'AAPL'], ['MSFT', 'AAPL', 'AAPL'], ['AAPL', 'MSFT', 'AAPL']]);
});

test('shared errors and corrupt data are discarded so a later read can recover', async () => {
  for (const response of [Response.json({ code: 'unavailable' }, { status: 503 }), Response.json([record('MSFT', 1)])]) {
    const { cache, reads, until, answer } = fixture();
    const outcomes = Promise.allSettled([cache.cacheGet('holders-v3', 'AAPL'), cache.cacheGet('holders-v3', 'AAPL')]);
    await until(reads, 1); reads[0].resolve(response);
    assert.ok((await outcomes).every(result => result.status === 'rejected'));
    assert.equal(reads.length, 1);
    const next = cache.cacheGet('holders-v3', 'AAPL');
    await until(reads, 2); answer(1, 2);
    assert.equal((await next).payload.value, 2);
  }
});

test('signals and deadlines share reads while custom timeouts and unknown options remain isolated', async () => {
  const { cache, reads, until, answer } = fixture();
  const requests = [cache.cacheGet('holders-v3', 'AAPL'), cache.cacheGet('holders-v3', 'AAPL'),
    ...[{ signal: new AbortController().signal }, { deadline: NOW + 5000 }, { timeoutMs: 5000 }, { [Symbol('option')]: true }, Object.create({ deadline: NOW + 5000 })]
      .map(options => cache.cacheGet('holders-v3', 'AAPL', options))];
  await until(reads, 4); await setImmediate(); assert.equal(reads.length, 4);
  await assert.rejects(cache.cacheGet('holders-v3', 'AAPL', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(cache.cacheGet('holders-v3', 'AAPL', { deadline: NOW - 1 }), { code: 'deadline' });
  assert.equal(reads.length, 4);
  reads.forEach((_, index) => answer(index));
  await Promise.all(requests);
});

test('twenty concurrent warm-style deadline reads issue one RPC without retaining the result', async () => {
  const { cache, reads, until, answer } = fixture();
  const requests = Array.from({ length: 20 }, (_, index) => cache.cacheGet('holders-v3', index % 2 ? 'aapl' : 'AAPL', { deadline: NOW + 12000 + index }));
  await until(reads, 1); await setImmediate();
  assert.equal(reads.length, 1, '20 deadline-bound readers share one gateway request');
  answer(0);
  assert.ok((await Promise.all(requests)).every(value => value.payload.value === 1));
  const next = cache.cacheGet('holders-v3', 'AAPL', { deadline: NOW + 12000 });
  await until(reads, 2); answer(1, 2);
  assert.equal((await next).payload.value, 2, 'a completed read cannot hide another server publication');
});

test('the production warm-reader wrapper no longer bypasses single-flight with its default deadline', async () => {
  const { cache, reads, until, answer } = fixture();
  const warm = createWarmDataCache({ enabled: () => true, read: cache.cacheGet,
    legacyRead: async () => { throw new Error('a hit must not read Redis'); } });
  const requests = Array.from({ length: 20 }, () => warm.get('holders-v3', 'AAPL'));
  await until(reads, 1); await setImmediate(); assert.equal(reads.length, 1);
  answer(0);
  assert.ok((await Promise.all(requests)).every(value => value.value === 1));
});

test('aborting either shared subscriber does not cancel the other subscriber', async () => {
  for (const firstLeaves of [true, false]) {
    const { cache, reads, until, answer } = fixture();
    const controller = new AbortController(), reason = new Error('caller stopped');
    const leavingOptions = { signal: controller.signal, deadline: NOW + 5000 };
    const first = cache.cacheGet('holders-v3', 'AAPL', firstLeaves ? leavingOptions : {});
    const second = cache.cacheGet('holders-v3', 'AAPL', firstLeaves ? {} : leavingOptions);
    const leaving = firstLeaves ? first : second, staying = firstLeaves ? second : first;
    const rejected = assert.rejects(leaving, error => error === reason);
    await until(reads, 1); controller.abort(reason);
    await rejected;
    assert.equal(reads.length, 1); assert.equal(reads[0].signal.aborted, false);
    answer(0);
    assert.equal((await staying).payload.value, 1);
  }
});

test('a shorter subscriber deadline does not end a longer shared read', async () => {
  const { cache, reads, until, answer } = fixture();
  const short = cache.cacheGet('holders-v3', 'AAPL', { deadline: NOW + 30 });
  const rejected = assert.rejects(short, { code: 'timeout' });
  const long = cache.cacheGet('holders-v3', 'AAPL', { deadline: NOW + 5000 });
  await until(reads, 1); await rejected;
  assert.equal(reads[0].signal.aborted, false);
  answer(0);
  assert.equal((await long).payload.value, 1); assert.equal(reads.length, 1);
});

test('when every subscriber leaves the transport is aborted and a later reader starts fresh', async () => {
  const { cache, reads, until, answer } = fixture();
  const controllers = [new AbortController(), new AbortController()];
  const outcomes = Promise.allSettled(controllers.map(controller => cache.cacheGet('holders-v3', 'AAPL', { signal: controller.signal })));
  await until(reads, 1);
  controllers[0].abort(); assert.equal(reads[0].signal.aborted, false);
  controllers[1].abort();
  assert.ok((await outcomes).every(outcome => outcome.status === 'rejected'));
  assert.equal(reads[0].signal.aborted, true);
  const next = cache.cacheGet('holders-v3', 'AAPL', { deadline: NOW + 5000 });
  await until(reads, 2); answer(1, 2);
  assert.equal((await next).payload.value, 2);
});

test('CFTC history readers share both bounded cutover lookups and preserve the original expiry', async () => {
  const { cache, reads, until, answer } = fixture();
  const type = 'edgar.cftc-positioning.v1:production', id = 'raw-history:tff:13874A:2026-09-08';
  const requests = [cache.cacheGet(type, id), cache.cacheGet(type, id, { deadline: NOW + 12000 })];
  await until(reads, 1); reads[0].resolve(Response.json([null]));
  await until(reads, 2); await setImmediate();
  assert.deepEqual(reads.map(read => read.params.p_family), ['cftc-history', 'history']);
  answer(1);
  for (const value of await Promise.all(requests)) assert.equal(value.expiresAt, new Date(NOW + 60000).toISOString());
});

test('pending map stays bounded and overflow reads proceed independently', async () => {
  const { cache, reads, until, answer } = fixture();
  const requests = Array.from({ length: 65 }, (_, index) => cache.cacheGet('holders-v3', `T${index}`));
  await until(reads, 65);
  requests.push(cache.cacheGet('holders-v3', 'T0'), cache.cacheGet('holders-v3', 'T64'));
  await until(reads, 66); await setImmediate(); assert.equal(reads.length, 66);
  reads.forEach((_, index) => answer(index));
  await Promise.all(requests);
});

test('writes and reservations separate pre-write, concurrent and post-write read generations', async () => {
  const type = 'edgar.cftc-positioning.v1:production', id = 'markets:tff:latest';
  const claim = { dataset: 'cftc', key: id, fenceId: id, owner: '2dd38600-28e1-4b8c-8387-8a350226bdab', generation: '1', expiresAt: new Date(NOW + 120000).toISOString() };
  for (const kind of ['put', 'fenced', 'reserve', 'failed']) {
    const { cache, reads, writes, until, answer } = fixture();
    const options = { deadline: NOW + 5000 };
    const before = cache.cacheGet(type, id, options); await until(reads, 1);
    const write = kind === 'reserve' ? cache.cacheReserveGeneration(type, id, claim)
      : kind === 'fenced' ? cache.cachePutFenced(type, id, { value: 2 }, 60, claim)
        : cache.cachePut(type, id, { value: 2 }, 60, { ifHash: 'absent' });
    const writeResult = Promise.allSettled([write]);
    const during = cache.cacheGet(type, id, options);
    await until(reads, 2); await until(writes, 1);
    const request = writes[0];
    request.resolve(kind === 'failed' ? Response.json({ code: 'unavailable' }, { status: 503 }) : Response.json(kind === 'reserve' ? true
      : { stored: true, rawSha256: request.params.p_raw_sha256, expiresAt: new Date(NOW + 60000).toISOString() }));
    assert.equal((await writeResult)[0].status, kind === 'failed' ? 'rejected' : 'fulfilled');
    const after = cache.cacheGet(type, id, options); await until(reads, 3);
    answer(0, 0); answer(1, 1); await Promise.all([before, during]);
    const afterTwin = cache.cacheGet(type, id, options); await setImmediate();
    assert.equal(reads.length, 3, `${kind}: old cleanup cannot remove the new generation`);
    answer(2, 2);
    assert.ok((await Promise.all([after, afterTwin])).every(row => row.payload.value === 2));
    if (kind === 'put' || kind === 'failed') assert.equal(request.params.p_if_hash, 'absent');
    if (kind === 'fenced') assert.deepEqual(request.params.p_claim, { owner: claim.owner, generation: '1' });
  }
});

test('shared oversized batches keep the existing bounded sequential split behavior', async () => {
  const { cache, reads, until, answer } = fixture();
  const requests = [cache.cacheGetMany('holders-v3', ['AAPL', 'MSFT']), cache.cacheGetMany('holders-v3', ['AAPL', 'MSFT'])];
  await until(reads, 1);
  reads[0].resolve(Response.json({ code: 'cache_response_too_large' }, { status: 413 }));
  await until(reads, 2); answer(1);
  await until(reads, 3); answer(2);
  assert.ok((await Promise.all(requests)).every(rows => rows.length === 2));
  assert.equal(reads.length, 3);
  assert.deepEqual(reads.map(read => read.params.p_ids), [['AAPL', 'MSFT'], ['AAPL'], ['MSFT']]);
});
