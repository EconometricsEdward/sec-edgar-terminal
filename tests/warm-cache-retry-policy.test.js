import test from 'node:test';
import assert from 'node:assert/strict';
import { createWarmCacheRetryPolicy } from '../src/utils/warmCacheRetryPolicy.js';
import { createWarmDataCache } from '../src/utils/warmCache.js';

const NOW = Date.parse('2026-09-29T18:00:00Z');
const steady = () => ({ mode: 'steady', modeChangedAt: new Date(NOW - 1200000).toISOString(),
  state: { version: 1, phase: 'steady', completedAt: new Date(NOW - 300000).toISOString(), pending: [] } });
const policy = type => type === 'selected';

test('100 sequential steady-state misses use 100 data reads plus one shared control read instead of 200 data reads', async () => {
  let dataReads = 0, controlReads = 0, legacyReads = 0;
  const retryMiss = createWarmCacheRetryPolicy({ now: () => NOW,
    readState: async options => {
      controlReads++; assert.equal(options.timeoutMs, 1000); assert.equal(options.deadline, NOW + 1000);
      return steady();
    } });
  const cache = createWarmDataCache({ enabled: () => true, policy, retryMiss,
    read: async () => { dataReads++; return null; }, legacyRead: async () => { legacyReads++; return null; } });
  for (let index = 0; index < 100; index++) assert.equal(await cache.get('selected', `missing-${index}`), null);
  assert.equal(dataReads, 100); assert.equal(controlReads, 1); assert.equal(legacyReads, 100);
});

test('bulk steady misses retain ordering and 25-item batches with one amortized control lookup', async () => {
  let dataReads = 0, controlReads = 0;
  const retryMiss = createWarmCacheRetryPolicy({ now: () => NOW, readState: async () => { controlReads++; return steady(); } });
  const cache = createWarmDataCache({ enabled: () => true, policy, retryMiss,
    readMany: async (_type, ids) => { dataReads++; assert.ok(ids.length <= 25); return ids.map(id => id === 'hit' ? { payload: { id } } : null); },
    legacyReadMany: async (_type, ids) => ids.map(id => id === 'preserved' ? { id } : null) });
  const ids = Array.from({ length: 1000 }, (_, index) => `missing-${index}`); ids[26] = 'hit'; ids[51] = 'preserved';
  const results = await cache.getMany('selected', ids);
  assert.equal(dataReads, 40); assert.equal(controlReads, 1);
  assert.deepEqual(results, ids.map(id => ['hit', 'preserved'].includes(id) ? { id } : null));
});

test('hits and preserved Redis values need no maintenance check and retain original data', async () => {
  let controls = 0;
  const cache = createWarmDataCache({ enabled: () => true, policy,
    retryMiss: async () => { controls++; return false; },
    read: async (_type, id) => id === 'hit' ? { payload: { source: 'supabase' } } : null,
    legacyRead: async () => ({ source: 'preserved' }) });
  assert.deepEqual(await cache.get('selected', 'hit'), { source: 'supabase' });
  assert.deepEqual(await cache.get('selected', 'legacy'), { source: 'preserved' });
  assert.equal(controls, 0);
});

test('transport errors and malformed batches retain a recovery read even in steady state', async () => {
  let reads = 0, checks = 0;
  const cache = createWarmDataCache({ enabled: () => true, policy,
    retryMiss: async () => { checks++; return false; },
    read: async () => { if (++reads === 1) throw new Error('unavailable'); return { payload: { recovered: true } }; },
    legacyRead: async () => null });
  assert.deepEqual(await cache.get('selected', 'issuer'), { recovered: true }); assert.equal(reads, 2); assert.equal(checks, 0);
  for (const invalid of [null, [], 'invalid', new Error('unavailable')]) {
    reads = 0;
    const bulk = createWarmDataCache({ enabled: () => true, policy,
      retryMiss: async () => { throw new Error('unconfirmed miss must retry'); },
      readMany: async (_type, ids) => {
        if (++reads > 1) return ids.map(id => ({ payload: { id } }));
        if (invalid instanceof Error) throw invalid;
        return invalid;
      }, legacyReadMany: async (_type, ids) => ids.map(() => null) });
    assert.deepEqual(await bulk.getMany('selected', ['issuer']), [{ id: 'issuer' }]); assert.equal(reads, 2);
  }
});

test('steady observations expire after 60 seconds, before the ten-minute migration deletion drain', async () => {
  let time = NOW, control = steady(), reads = 0;
  const retryMiss = createWarmCacheRetryPolicy({ now: () => time, readState: async () => { reads++; return control; } });
  assert.equal(await retryMiss(), false);
  control = { ...control, mode: 'migrate', modeChangedAt: new Date(time).toISOString() };
  time += 59999; assert.equal(await retryMiss(), false); assert.equal(reads, 1);
  time++; assert.equal(await retryMiss(), true); assert.equal(reads, 2);
  assert.ok(time < Date.parse(control.modeChangedAt) + 600000);
  let moved = false, cacheReads = 0;
  const cache = createWarmDataCache({ enabled: () => true, policy, retryMiss,
    read: async () => { cacheReads++; return moved ? { payload: { preserved: true } } : null; },
    legacyRead: async () => { moved = true; return null; } });
  assert.deepEqual(await cache.get('selected', 'issuer'), { preserved: true }); assert.equal(cacheReads, 2);
});

test('unknown, recently changed, incomplete and malformed control states preserve the retry', async () => {
  const good = steady();
  for (const control of [null, {}, { ...good, mode: 'inventory' }, { ...good, mode: 'migrate' },
    { ...good, modeChangedAt: 'invalid' }, { ...good, modeChangedAt: new Date(NOW + 1000).toISOString() },
    { ...good, modeChangedAt: new Date(NOW - 599999).toISOString() },
    ...[{ version: 2 }, { phase: 'migration' }, { pending: ['remaining'] }, { pending: null }, { completedAt: null },
      { completedAt: new Date(NOW + 1000).toISOString() }].map(patch => ({ ...good, state: { ...good.state, ...patch } })),
  ]) {
    const retryMiss = createWarmCacheRetryPolicy({ now: () => NOW, readState: async () => control });
    assert.equal(await retryMiss(), true, JSON.stringify(control));
  }
});

test('failed control refresh cannot retain an expired steady decision or hammer the control endpoint', async () => {
  let time = NOW, unavailable = false, reads = 0;
  const retryMiss = createWarmCacheRetryPolicy({ now: () => time, readState: async () => {
    reads++; if (unavailable) throw new Error('unavailable'); return steady();
  } });
  assert.equal(await retryMiss(), false);
  time += 60000; unavailable = true;
  assert.equal(await retryMiss(), true); assert.equal(reads, 2);
  for (let index = 0; index < 20; index++) assert.equal(await retryMiss(), true);
  assert.equal(reads, 2);
  time += 5000; unavailable = false;
  assert.equal(await retryMiss(), false); assert.equal(reads, 3);
});

test('simultaneous mode lookups share work without sharing caller cancellation', async () => {
  let reads = 0, resolve;
  const retryMiss = createWarmCacheRetryPolicy({ now: () => NOW, readState: options => {
    reads++; assert.equal(options.signal, undefined);
    return new Promise(done => { resolve = done; });
  } });
  const controller = new AbortController(), reason = new Error('caller stopped');
  const leaving = retryMiss({ signal: controller.signal }), staying = retryMiss();
  const rejected = assert.rejects(leaving, error => error === reason);
  controller.abort(reason); await rejected;
  assert.equal(reads, 1); resolve(steady()); assert.equal(await staying, false);
  assert.equal(await retryMiss(), false); assert.equal(reads, 1);
});

test('control waiters keep their deadlines and pre-cancelled readers do no work', async () => {
  let reads = 0, resolve;
  const retryMiss = createWarmCacheRetryPolicy({ now: () => NOW, readState: () => {
    reads++; return new Promise(done => { resolve = done; });
  } });
  await assert.rejects(retryMiss({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(retryMiss({ deadline: NOW }), /deadline/); assert.equal(reads, 0);
  const short = retryMiss({ deadline: NOW + 30 }), long = retryMiss({ deadline: NOW + 5000 });
  await assert.rejects(short, /deadline/);
  resolve(steady()); assert.equal(await long, false); assert.equal(reads, 1);
});

test('control freshness is bounded from request start rather than delayed completion', async () => {
  let time = NOW;
  const retryMiss = createWarmCacheRetryPolicy({ now: () => time, readState: async () => { time += 60001; return steady(); } });
  assert.equal(await retryMiss(), true);
});
