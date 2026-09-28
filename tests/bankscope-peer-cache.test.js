import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankPeerUniverse, validPeerUniverse } from '../src/utils/bank/peerUniverseStore.js';
import { createPeerService } from '../src/utils/bank/peerService.js';
import { normalizePeerRecord, PEER_MODEL_VERSION } from '../src/utils/bank/peerSource.js';

const period = '2026-06-30';
const env = { VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' };
function fixture(date = period, count = 40) {
  return {
    snapshot: { id: 'abcd1234-1234-1234-1234-abcdef123456', report_date: date, model_version: PEER_MODEL_VERSION,
      completed_at: '2026-09-28T00:00:00Z', source_sha256: 'a'.repeat(64), matched_count: count },
    profiles: Array.from({ length: count }, (_, index) => ({
      ...normalizePeerRecord({ REPDTE: date.replaceAll('-', ''), RSSDID: index + 1, CERT: index + 1, ASSET: 10000 + index,
        LNLSGR: 7000, LNRE: 3000, LNCI: 2000, LNCON: 1000, DEP: 8000, DEPDOM: 8000, DEPNI: 2000, BRO: 100,
        ROA: 1.1, ROE: 12, CBLRIND: 0, RBCT1CER: 12 }, date), name: `BANK ${index + 1}`, city: 'CITY', state: 'NY', form: '041',
    })),
  };
}
function sharedCache() {
  const entries = new Map();
  return { entries, cache: (load, parts) => async (...args) => {
    const key = JSON.stringify([parts, args]);
    if (!entries.has(key)) entries.set(key, JSON.stringify(await load(...args)));
    return JSON.parse(entries.get(key));
  } };
}

test('large quarterly universe is compressed and reused across service instances and different banks', async () => {
  const shared = sharedCache(), data = fixture(period, 4500); let calls = 0;
  assert.ok(Buffer.byteLength(JSON.stringify(data)) > 2 * 1024 * 1024);
  const options = { env, cache: shared.cache, store: async op => { calls++; assert.equal(op, 'peer_universe'); return data; } };
  const first = createPeerService({ loadUniverse: createBankPeerUniverse(options) });
  const second = createPeerService({ loadUniverse: createBankPeerUniverse(options) });
  assert.equal((await first(1, period)).bank.rssd, 1);
  assert.equal((await second(2, period)).bank.rssd, 2);
  assert.equal(calls, 1);
  assert.equal(shared.entries.size, 1);
  assert.ok(Buffer.byteLength([...shared.entries.values()][0]) < 1536 * 1024);
});

test('concurrent requests coalesce, periods stay separate, and caller mutations are isolated', async () => {
  let calls = 0; const shared = sharedCache();
  const get = createBankPeerUniverse({ env, cache: shared.cache, store: async (op, payload) => { calls++; return fixture(payload.period); } });
  const results = await Promise.all(Array.from({ length: 20 }, () => get(period)));
  assert.equal(calls, 1);
  results[0].profiles[0].metrics.roa = -123;
  assert.equal(results[1].profiles[0].metrics.roa, 1.1);
  assert.equal((await get('2026-03-31')).snapshot.report_date, '2026-03-31');
  assert.equal(calls, 2);
});

test('expired shared snapshots do not accumulate another process TTL or hide source failures', async () => {
  let clock = 0, calls = 0, fail = false; const shared = sharedCache();
  const options = { env, cache: shared.cache, now: () => clock, store: async () => { calls++; if (fail) throw Error('offline'); return fixture(); } };
  await createBankPeerUniverse(options)(period);
  clock = 299000;
  const second = createPeerService({ now: () => clock, loadUniverse: createBankPeerUniverse(options) });
  await second(1, period); assert.equal(calls, 1);
  clock = 300001; fail = true;
  await assert.rejects(second(1, period), { code: 'database_failure' });
  assert.equal(calls, 2);
  await assert.rejects(second(1, period)); assert.equal(calls, 2);
  clock += 5001; fail = false;
  assert.equal((await second(1, period)).bank.rssd, 1); assert.equal(calls, 3);
});

test('corrupted shared data is repaired once, and mismatched bank source shapes never persist', async () => {
  const shared = sharedCache(); let calls = 0;
  const options = { env, cache: shared.cache, store: async () => { calls++; return fixture(); } };
  await createBankPeerUniverse(options)(period);
  const key = [...shared.entries.keys()][0], saved = JSON.parse(shared.entries.get(key));
  saved.sha256 = 'b'.repeat(64); shared.entries.set(key, JSON.stringify(saved));
  assert.equal((await createBankPeerUniverse(options)(period)).profiles.length, 40);
  assert.equal(calls, 2);
  for (const mutate of [d => d.snapshot.report_date = '2026-03-31', d => d.snapshot.owner = 'secret',
    d => d.snapshot.matched_count++, d => d.profiles[0].raw_source = {}, d => d.profiles[0].metrics.roa = '1',
    d => d.profiles[1].rssd = d.profiles[0].rssd]) {
    const data = fixture(); mutate(data); assert.equal(validPeerUniverse(data, period), false);
    const isolated = sharedCache();
    await assert.rejects(createBankPeerUniverse({ env, cache: isolated.cache, store: async () => data })(period));
    assert.equal(isolated.entries.size, 0);
  }
});

test('missing and cache-oversized results use only short local reuse, without duplicate source reads', async () => {
  for (const data of [{ profiles: [] }, fixture()]) {
    const shared = sharedCache(); let calls = 0;
    const get = createBankPeerUniverse({ env, cache: shared.cache, now: () => 0, maxSharedBytes: 1,
      store: async () => { calls++; return data; } });
    assert.deepEqual(await get(period), { ...data, cacheExpiresAt: 30000 });
    assert.equal(calls, 1); assert.equal(shared.entries.size, 0);
  }
});

test('shared read/write failures fall back once, while source failures are not repeated', async () => {
  for (const stage of ['read', 'write', 'source']) {
    let calls = 0;
    const cache = load => async (...args) => { if (stage === 'read') throw Error('cache offline'); await load(...args); throw Error('cache write failed'); };
    const get = createBankPeerUniverse({ env, cache, store: async () => { calls++; if (stage === 'source') throw Error('source offline'); return fixture(); } });
    if (stage === 'source') { await assert.rejects(get(period)); await assert.rejects(get(period)); }
    else assert.equal((await get(period)).profiles.length, 40);
    assert.equal(calls, 1, stage);
  }
});

test('environment guards precede all cache hits and approved previews never touch shared storage', async () => {
  const mutableEnv = { ...env }, shared = sharedCache(); let calls = 0;
  const get = createBankPeerUniverse({ env: mutableEnv, cache: shared.cache, store: async () => { calls++; return fixture(); } });
  await get(period); mutableEnv.VERCEL_ENV = 'preview';
  await assert.rejects(get(period), { code: 'bank_service_unavailable' });
  assert.equal(calls, 1);
  mutableEnv.VERCEL_GIT_COMMIT_REF = 'feat/ffiec-bank-pilot';
  await get(period); assert.equal(calls, 2); assert.equal(shared.entries.size, 1);
});
