import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankPeerUniverse, validPeerUniverse } from '../src/utils/bank/peerUniverseStore.js';
import { createPeerService } from '../src/utils/bank/peerService.js';
import { normalizePeerRecord, PEER_MODEL_VERSION } from '../src/utils/bank/peerSource.js';

const period = '2026-06-30';
const env = { VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' };
function fixture(date = period, count = 40, publication = '2026-09-28T00:00:00Z') {
  return {
    snapshot: { id: 'abcd1234-1234-1234-1234-abcdef123456', report_date: date, model_version: PEER_MODEL_VERSION,
      completed_at: publication, source_sha256: 'a'.repeat(64), matched_count: count,
      source_index: 'fdic-publication', source_updated_at: null },
    profiles: Array.from({ length: count }, (_, index) => ({
      ...normalizePeerRecord({ REPDTE: date.replaceAll('-', ''), RSSDID: index + 1, CERT: index + 1, ASSET: 10000 + index,
        LNLSGR: 7000, LNRE: 3000, LNCI: 2000, LNCON: 1000, DEP: 8000, DEPDOM: 8000, DEPNI: 2000, BRO: 100,
        ROA: 1.1, ROE: 12, CBLRIND: 0, RBCT1CER: 12 }, date), name: `BANK ${index + 1}`, city: 'CITY', state: 'NY', form: '041',
    })),
  };
}
function manifest(...datasets) {
  return { snapshots: datasets.filter(d => d.snapshot).map(d => {
    const { report_date, completed_at, matched_count, source_index, source_updated_at, model_version } = d.snapshot;
    return { report_date, completed_at, matched_count, source_index, source_updated_at, model_version };
  }), ubprQueued: 100, ubprReports: 200 };
}
function sharedCache() {
  const entries = new Map(), settings = [];
  return { entries, settings, cache: (load, parts, options) => {
    settings.push(options.revalidate);
    return async (...args) => {
      const key = JSON.stringify([parts, args]);
      if (!entries.has(key)) entries.set(key, JSON.stringify(await load(...args)));
      return JSON.parse(entries.get(key));
    };
  } };
}
function backend(data = fixture()) {
  const counts = { peer_status: 0, peer_universe: 0 };
  const store = async op => { counts[op]++; return op === 'peer_status' ? manifest(data) : data; };
  return { counts, store };
}
const universeEntries = shared => [...shared.entries].filter(([, text]) => JSON.parse(text).gzipBase64);
const manifestEntries = shared => [...shared.entries].filter(([, text]) => JSON.parse(text).snapshots);

test('large universe and small publication manifest are shared across service instances and bank selections', async () => {
  const shared = sharedCache(), data = fixture(period, 4500), source = backend(data);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) > 2 * 1024 * 1024);
  const options = { env, cache: shared.cache, store: source.store };
  const first = createPeerService({ loadUniverse: createBankPeerUniverse(options) });
  const second = createPeerService({ loadUniverse: createBankPeerUniverse(options) });
  assert.equal((await first(1, period)).bank.rssd, 1);
  assert.equal((await second(2, period)).bank.rssd, 2);
  assert.deepEqual(source.counts, { peer_status: 1, peer_universe: 1 });
  assert.equal(shared.entries.size, 2);
  assert.ok(Buffer.byteLength(universeEntries(shared)[0][1]) < 1536 * 1024);
  const retainedManifest = JSON.parse(manifestEntries(shared)[0][1]);
  assert.deepEqual(Object.keys(retainedManifest).sort(), ['checkedAt', 'deployment', 'snapshots', 'version']);
  assert.equal(retainedManifest.snapshots[0].id, undefined);
  assert.ok(shared.settings.includes(300)); assert.ok(shared.settings.includes(86400));
});

test('five-minute manifest refresh reuses unchanged publication and reads a changed universe exactly once', async () => {
  const shared = sharedCache(); let clock = 0, data = fixture(), small = 0, heavy = 0;
  const options = { env, cache: shared.cache, now: () => clock, store: async op => {
    if (op === 'peer_status') { small++; return manifest(data); }
    heavy++; return data;
  } };
  const service = createPeerService({ now: () => clock, loadUniverse: createBankPeerUniverse(options) });
  await service(1, period); assert.equal(small, 1); assert.equal(heavy, 1);
  clock = 300001;
  await service(2, period); assert.equal(small, 2); assert.equal(heavy, 1);
  clock = 600002; data = fixture(period, 40, '2026-09-28T00:10:00Z');
  data.snapshot.id = 'abcd1234-1234-1234-1234-abcdef123457';
  const results = await Promise.all([service(1, period), service(2, period)]);
  assert.equal(small, 3); assert.equal(heavy, 2);
  assert.ok(results.every(r => r.snapshot.id === data.snapshot.id));
  assert.equal(universeEntries(shared).length, 2);
});

test('concurrent quarters share one manifest, separate their data and isolate caller mutations', async () => {
  let small = 0, heavy = 0; const shared = sharedCache(), earlier = '2026-03-31';
  const get = createBankPeerUniverse({ env, cache: shared.cache, store: async (op, payload) => {
    if (op === 'peer_status') { small++; return manifest(fixture(), fixture(earlier)); }
    heavy++; return fixture(payload.period);
  } });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => get(i % 2 ? period : earlier)));
  assert.equal(small, 1); assert.equal(heavy, 2);
  results[0].profiles[0].metrics.roa = -123;
  assert.equal(results[2].profiles[0].metrics.roa, 1.1);
  assert.equal(results[0].snapshot.report_date, earlier);
});

test('manifest outage reuses published data with a bounded thirty-second recovery check', async () => {
  let clock = 0, fail = false, small = 0, heavy = 0; const shared = sharedCache();
  const options = { env, cache: shared.cache, now: () => clock, store: async op => {
    if (op === 'peer_status') { small++; if (fail) throw Error('offline'); return manifest(fixture()); }
    heavy++; return fixture();
  } };
  await createBankPeerUniverse(options)(period);
  clock = 299000;
  const second = createPeerService({ now: () => clock, loadUniverse: createBankPeerUniverse(options) });
  await second(1, period); assert.equal(small, 1); assert.equal(heavy, 1);
  clock = 300001; fail = true;
  assert.equal((await second(1, period)).bank.rssd, 1);
  assert.equal(small, 2); assert.equal(heavy, 1);
  assert.equal((await second(1, period)).bank.rssd, 1); assert.equal(small, 2);
  clock += 30001; fail = false;
  assert.equal((await second(1, period)).bank.rssd, 1);
  assert.equal(small, 3); assert.equal(heavy, 1);
});

test('background manifest revalidation and hard-expiry repair share one small read, including a failure', async () => {
  let clock = 0, small = 0, heavy = 0, fail = false;
  const entries = new Map();
  const cache = (load, parts, options) => async (...args) => {
    const key = JSON.stringify([parts, args]), hit = entries.get(key);
    const refresh = async () => {
      const value = await load(...args);
      entries.set(key, { json: JSON.stringify(value), until: clock + options.revalidate * 1000 });
      return structuredClone(value);
    };
    if (!hit) return refresh();
    if (hit.until <= clock) void refresh().catch(() => {});
    return JSON.parse(hit.json);
  };
  const get = createBankPeerUniverse({ env, cache, now: () => clock, store: async op => {
    if (op === 'peer_status') { small++; if (fail) throw Error('offline'); return manifest(fixture()); }
    heavy++; return fixture();
  } });
  await get(period);
  clock = 300001;
  const refreshed = await get(period);
  assert.equal(refreshed.cacheExpiresAt, 600001); assert.equal(small, 2); assert.equal(heavy, 1);
  clock = 600002; fail = true;
  const stale = await get(period);
  assert.equal(stale.publicPeerCache.stale, true);
  assert.equal(stale.publicPeerCache.checkedAt, new Date(300001).toISOString());
  assert.equal(stale.cacheExpiresAt, 630002);
  assert.equal((await get(period)).snapshot.id, stale.snapshot.id);
  assert.equal(small, 3); assert.equal(heavy, 1);
});

test('stale fallback preserves publication identity across instances, expires and recovers to a new publication', async () => {
  let clock = 0, unavailable = false, data = fixture(), small = 0, heavy = 0;
  const shared = sharedCache();
  const options = { env, cache: shared.cache, now: () => clock, store: async op => {
    if (op === 'peer_status') { small++; if (unavailable) throw Error('offline'); return manifest(data); }
    heavy++; return data;
  } };
  const original = await createBankPeerUniverse(options)(period);
  clock = 300001; unavailable = true;
  const second = createBankPeerUniverse(options);
  const stale = await second(period);
  assert.deepEqual(stale.snapshot, original.snapshot);
  assert.deepEqual(stale.profiles, original.profiles);
  assert.equal(stale.publicPeerCache.stale, true);
  assert.equal(stale.publicPeerCache.checkedAt, new Date(0).toISOString());
  assert.equal(stale.cacheExpiresAt, 330001);
  clock = 320001;
  assert.equal((await second(period)).cacheExpiresAt, 330001);
  assert.equal(small, 2); assert.equal(heavy, 1);
  clock = 330002; unavailable = false; data = fixture(period, 40, '2026-09-28T00:10:00Z');
  data.snapshot.id = 'abcd1234-1234-1234-1234-abcdef123457';
  const recovered = await second(period);
  assert.equal(recovered.publicPeerCache.stale, false);
  assert.equal(recovered.snapshot.id, data.snapshot.id);
  assert.equal(small, 3); assert.equal(heavy, 2);
  clock = 86390000; unavailable = true;
  // A new process has only the original shared manifest, whose outage allowance
  // cannot be extended by successive fallback reads or the later L1 refresh.
  const finalInstance = createBankPeerUniverse(options);
  assert.equal((await finalInstance(period)).cacheExpiresAt, 86400000);
  clock = 86400000;
  await assert.rejects(finalInstance(period), { code: 'database_failure' });
  assert.equal(small, 4); assert.equal(heavy, 2);
});

test('stale metadata never starts a cold universe read or repairs a corrupted payload', async () => {
  for (const corrupt of [false, true]) {
    let clock = 0, unavailable = false, small = 0, heavy = 0;
    const shared = sharedCache();
    const options = { env, cache: shared.cache, now: () => clock, store: async op => {
      if (op === 'peer_status') { small++; if (unavailable) throw Error('offline'); return manifest(fixture()); }
      heavy++; return fixture();
    } };
    await createBankPeerUniverse(options)(period);
    const [key, text] = universeEntries(shared)[0];
    if (corrupt) { const value = JSON.parse(text); value.sha256 = 'b'.repeat(64); shared.entries.set(key, JSON.stringify(value)); }
    else shared.entries.delete(key);
    clock = 300001; unavailable = true;
    await assert.rejects(createBankPeerUniverse(options)(period), { code: 'database_failure' });
    assert.equal(small, 2); assert.equal(heavy, 1);
  }
});

test('malformed current metadata and unknown stale publications cannot be hidden by fallback', async () => {
  for (const invalid of [{ snapshots: 'invalid' }, { snapshots: [{ ...manifest(fixture()).snapshots[0], matched_count: -1 }] }]) {
    let clock = 0, data = manifest(fixture()); const shared = sharedCache();
    const get = createBankPeerUniverse({ env, cache: shared.cache, now: () => clock,
      store: async op => op === 'peer_status' ? data : fixture() });
    await get(period);
    clock = 300001; data = invalid;
    await assert.rejects(get(period), { code: 'database_failure' });
  }
  let clock = 0, unavailable = false, heavy = 0; const shared = sharedCache();
  const get = createBankPeerUniverse({ env, cache: shared.cache, now: () => clock, store: async op => {
    if (op === 'peer_status') { if (unavailable) throw Error('offline'); return manifest(fixture()); }
    heavy++; return fixture();
  } });
  await get(period); clock = 300001; unavailable = true;
  await assert.rejects(get('2026-03-31'), { code: 'database_failure' });
  assert.equal(heavy, 1);
});

test('malformed manifests never persist or trigger a full universe read', async () => {
  for (const mutate of [d => d.snapshots = {}, d => d.snapshots.push(d.snapshots[0]),
    d => d.snapshots[0].report_date = 'not-a-quarter', d => d.snapshots[0].completed_at = 'bad',
    d => d.snapshots[0].matched_count = -1, d => d.snapshots[0].source_index = '',
    d => d.snapshots[0].source_updated_at = 'bad', d => d.snapshots[0].model_version = '',
    d => d.snapshots = Array(129).fill(d.snapshots[0])]) {
    const data = manifest(fixture()); mutate(data); const shared = sharedCache(); let calls = 0;
    const get = createBankPeerUniverse({ env, cache: shared.cache, store: async op => {
      assert.equal(op, 'peer_status'); calls++; return data;
    } });
    await assert.rejects(get(period)); await assert.rejects(get(period));
    assert.equal(calls, 1); assert.equal(shared.entries.size, 0);
  }
});

test('an older full snapshot is rejected but a newer publication race remains valid', async () => {
  const newer = fixture(period, 40, '2026-09-28T00:10:00Z');
  for (const [metadata, data, allowed] of [[newer, fixture(), false], [fixture(), newer, true]]) {
    const shared = sharedCache(); let heavy = 0;
    const get = createBankPeerUniverse({ env, cache: shared.cache, store: async op => {
      if (op === 'peer_status') return manifest(metadata);
      heavy++; return data;
    } });
    if (allowed) assert.equal((await get(period)).snapshot.completed_at, newer.snapshot.completed_at);
    else { await assert.rejects(get(period)); await assert.rejects(get(period)); }
    assert.equal(heavy, 1); assert.equal(universeEntries(shared).length, allowed ? 1 : 0);
  }
});

test('corrupted compressed data is repaired once and invalid source shapes never persist', async () => {
  const shared = sharedCache(), source = backend();
  const options = { env, cache: shared.cache, store: source.store };
  await createBankPeerUniverse(options)(period);
  const [key, text] = universeEntries(shared)[0], saved = JSON.parse(text);
  saved.sha256 = 'b'.repeat(64); shared.entries.set(key, JSON.stringify(saved));
  assert.equal((await createBankPeerUniverse(options)(period)).profiles.length, 40);
  assert.deepEqual(source.counts, { peer_status: 1, peer_universe: 2 });
  for (const mutate of [d => d.snapshot.report_date = '2026-03-31', d => d.snapshot.owner = 'secret',
    d => d.snapshot.matched_count++, d => d.profiles[0].raw_source = {}, d => d.profiles[0].metrics.roa = '1',
    d => d.profiles[1].rssd = d.profiles[0].rssd]) {
    const data = fixture(); mutate(data); assert.equal(validPeerUniverse(data, period), false);
    const isolated = sharedCache();
    await assert.rejects(createBankPeerUniverse({ env, cache: isolated.cache, store: async op => op === 'peer_status' ? manifest(fixture()) : data })(period));
    assert.equal(universeEntries(isolated).length, 0);
  }
});

test('missing publications skip full reads and retry metadata after thirty seconds; oversized data stays unshared', async () => {
  const shared = sharedCache(); let clock = 0, available = false, small = 0, heavy = 0;
  const get = createBankPeerUniverse({ env, cache: shared.cache, now: () => clock, store: async op => {
    if (op === 'peer_status') { small++; return available ? manifest(fixture()) : { snapshots: [] }; }
    heavy++; return fixture();
  } });
  assert.deepEqual(await get(period), { profiles: [], cacheExpiresAt: 30000 });
  assert.equal(heavy, 0);
  clock = 30001; available = true;
  assert.equal((await get(period)).profiles.length, 40);
  assert.equal(small, 2); assert.equal(heavy, 1);
  const isolated = sharedCache(), source = backend();
  const oversized = createBankPeerUniverse({ env, cache: isolated.cache, now: () => 0, maxSharedBytes: 1, store: source.store });
  assert.deepEqual(await oversized(period), { ...fixture(), cacheExpiresAt: 30000, publicPeerCache: { checkedAt: new Date(0).toISOString(), stale: false } });
  assert.deepEqual(source.counts, { peer_status: 1, peer_universe: 1 });
  assert.equal(universeEntries(isolated).length, 0);
});

test('cache read/write failures fall back once at each layer; source failures stay on cooldown', async () => {
  for (const stage of ['read', 'write', 'manifest-source', 'universe-source']) {
    const counts = { peer_status: 0, peer_universe: 0 };
    const cache = load => async (...args) => {
      if (stage === 'read') throw Error('cache offline');
      const data = await load(...args);
      if (stage === 'write') throw Error('cache write failed');
      return data;
    };
    const get = createBankPeerUniverse({ env, cache, store: async op => {
      counts[op]++;
      if (stage === 'manifest-source' && op === 'peer_status' || stage === 'universe-source' && op === 'peer_universe') throw Error('source offline');
      return op === 'peer_status' ? manifest(fixture()) : fixture();
    } });
    if (stage.endsWith('source')) { await assert.rejects(get(period)); await assert.rejects(get(period)); }
    else assert.equal((await get(period)).profiles.length, 40);
    assert.equal(counts.peer_status, 1, stage);
    assert.equal(counts.peer_universe, stage === 'manifest-source' ? 0 : 1, stage);
  }
});

test('normalized publication instants are stable cache keys and data is refreshed at the daily limit', async () => {
  const shared = sharedCache(); let clock = 0, stamp = '2026-09-28T00:00:00Z', heavy = 0;
  const options = { env, cache: shared.cache, now: () => clock, store: async op => {
    if (op === 'peer_status') return manifest(fixture(period, 40, stamp));
    heavy++; return fixture(period, 40, stamp);
  } };
  await createBankPeerUniverse(options)(period);
  clock = 300001; stamp = '2026-09-27T20:00:00-04:00';
  await createBankPeerUniverse(options)(period); assert.equal(heavy, 1);
  clock = 86400001;
  await createBankPeerUniverse(options)(period); assert.equal(heavy, 2);
});

test('environment guards precede cache reads and approved previews never touch shared storage', async () => {
  const mutableEnv = { ...env }, shared = sharedCache(), source = backend();
  const get = createBankPeerUniverse({ env: mutableEnv, cache: shared.cache, store: source.store });
  await get(period); mutableEnv.VERCEL_ENV = 'preview';
  await assert.rejects(get(period), { code: 'bank_service_unavailable' });
  assert.deepEqual(source.counts, { peer_status: 1, peer_universe: 1 });
  mutableEnv.VERCEL_GIT_COMMIT_REF = 'feat/ffiec-bank-pilot';
  await get(period);
  assert.deepEqual(source.counts, { peer_status: 2, peer_universe: 2 });
  assert.equal(shared.entries.size, 2);
});
