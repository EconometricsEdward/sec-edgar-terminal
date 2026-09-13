import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readLegacySnapshot, readSnapshot, writeSnapshot } from '../src/utils/snapshotCache.js';

const timestamp = Date.parse('2026-09-13T12:00:00Z');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const value = { generatedAt: '2026-09-13T11:00:00Z', companies: [{ cik: '0000002098', annual: { revenue: 100 } }] };

function legacyStore() {
  const rows = new Map(), writes = [];
  return {
    rows, writes, cacheEnabled: false,
    get: async (type, id) => rows.get(`${type}/${id}`) ?? null,
    set: async (type, id, payload, ttl) => { rows.set(`${type}/${id}`, payload); writes.push({ type, id, ttl }); return true; },
  };
}

function durableStore() {
  const rows = new Map(), writes = [];
  const envelope = payload => ({ payload, rawSha256: digest(payload), rawBytes: Buffer.byteLength(JSON.stringify(payload)), expiresAt: new Date(timestamp + 3600000).toISOString() });
  return {
    rows, writes, envelope, cacheEnabled: true, now: () => timestamp,
    set: async () => { assert.fail('Production snapshot must never publish Redis chunks.'); },
    cacheRead: async (type, id) => rows.get(`${type}/${id}`) ?? null,
    cacheWrite: async (type, id, payload, ttl, options) => {
      writes.push({ type, id, payload, ttl, options });
      const key = `${type}/${id}`, current = rows.get(key);
      const matched = options.ifHash === 'absent' ? !current : current?.rawSha256 === options.ifHash;
      if (!matched) return { stored: false };
      rows.set(key, envelope(payload));
      return { stored: true };
    },
  };
}

test('production duplicate snapshot publications retain one atomic row and no Redis generations', async () => {
  const store = durableStore();
  assert.equal(await writeSnapshot('quant-atlas-v2:production', 'atlas', value, 100, store), true);
  assert.equal(await writeSnapshot('quant-atlas-v2:production', 'atlas', value, 100, store), true);
  assert.equal(store.rows.size, 1);
  assert.equal(store.writes[0].options.ifHash, 'absent');
  assert.equal(store.writes[1].options.ifHash, digest(value));
  assert.deepEqual(await readSnapshot('quant-atlas-v2:production', 'atlas', {
    ...store, legacyGet: async () => { assert.fail('Valid Supabase snapshot must not read Redis.'); },
  }), value);
});

test('concurrent atomic publishers reject the writer whose observed hash was replaced', async () => {
  const store = durableStore(), key = 'type/atlas';
  const previous = store.envelope(value);
  store.rows.set(key, previous);
  const options = { ...store, cacheRead: async () => previous };
  const next = { ...value, generatedAt: '2026-09-13T11:30:00Z' };
  const newer = { ...value, generatedAt: '2026-09-13T11:45:00Z' };
  const results = await Promise.all([
    writeSnapshot('type', 'atlas', next, 100, options),
    writeSnapshot('type', 'atlas', newer, 100, options),
  ]);
  assert.deepEqual(results, [true, false]);
  assert.deepEqual(store.rows.get(key).payload, next);
});

test('failed and backward publications preserve the complete current snapshot', async () => {
  const store = durableStore(), key = 'type/atlas';
  store.rows.set(key, store.envelope(value));
  assert.equal(await writeSnapshot('type', 'atlas', value, 100, {
    ...store, cacheRead: async () => { throw new Error('Read unavailable'); },
  }), false);
  assert.equal(await writeSnapshot('type', 'atlas', { ...value, generatedAt: '2026-09-13T10:00:00Z' }, 100, store), false);
  assert.equal(store.writes.length, 0);
  assert.equal(await writeSnapshot('type', 'atlas', value, 100, { ...store, cacheWrite: async () => ({ stored: false }) }), false);
  assert.deepEqual(store.rows.get(key).payload, value);
});

test('local duplicate publication uses deterministic chunks without shortening an existing chunk lifetime', async () => {
  const store = legacyStore();
  assert.equal(await writeSnapshot('type', 'atlas', value, 7 * 86400, store), true);
  const originalKeys = [...store.rows.keys()];
  assert.equal(await writeSnapshot('type', 'atlas', value, 1, store), true);
  assert.deepEqual([...store.rows.keys()], originalKeys);
  assert.ok(store.writes.filter(row => row.type.endsWith(':chunks')).every(row => row.ttl === 7 * 86400 + 3600));
  assert.deepEqual(await readSnapshot('type', 'atlas', store), value);
});

test('a verified legacy snapshot imports only for its shortest remaining component lifetime', async () => {
  const legacy = legacyStore(), durable = durableStore();
  await writeSnapshot('type', 'atlas', value, 100, legacy);
  const result = await readSnapshot('type', 'atlas', {
    ...durable, legacyGet: legacy.get,
    legacyEnvelope: async (type, id) => ({ payload: await legacy.get(type, id), observedAt: timestamp - 5000, ttlMs: type.endsWith(':chunks') ? 25000 : 60000 }),
  });
  assert.deepEqual(result, value);
  assert.equal(durable.writes.length, 1);
  assert.equal(durable.writes[0].ttl, 20);
  assert.equal(durable.writes[0].options.ifHash, 'absent');
  assert.equal(durable.writes[0].options.expiresAt, new Date(timestamp + 20000).toISOString());
  assert.equal(durable.writes[0].payload.generatedAt, value.generatedAt);
});

test('failed TTL inspection serves complete legacy data without renewing it in Supabase', async () => {
  const legacy = legacyStore(), durable = durableStore();
  await writeSnapshot('type', 'atlas', value, 100, legacy);
  const result = await readSnapshot('type', 'atlas', {
    ...durable, legacyGet: legacy.get, legacyEnvelope: async () => { throw new Error('TTL unavailable'); },
  });
  assert.deepEqual(result, value);
  assert.equal(durable.writes.length, 0);
});

test('Supabase read or import failure cannot hide a complete legacy fallback', async () => {
  const legacy = legacyStore(), durable = durableStore();
  await writeSnapshot('type', 'atlas', value, 100, legacy);
  const result = await readSnapshot('type', 'atlas', {
    ...durable, cacheRead: async () => { throw new Error('Store unavailable'); },
    cacheWrite: async () => { throw new Error('Store unavailable'); }, legacyGet: legacy.get,
    legacyEnvelope: async (type, id) => ({ payload: await legacy.get(type, id), observedAt: timestamp, ttlMs: 10000 }),
  });
  assert.deepEqual(result, value);
});

test('partial, corrupt and cross-parent legacy generations never serve or migrate', async () => {
  for (const damage of ['partial', 'corrupt', 'cross-parent', 'oversized']) {
    const legacy = legacyStore(), durable = durableStore();
    await writeSnapshot('type', 'atlas', value, 100, legacy);
    const manifest = legacy.rows.get('type/atlas');
    if (damage === 'partial') legacy.rows.delete(`type:chunks/${manifest.ids[0]}`);
    if (damage === 'corrupt') legacy.rows.set(`type:chunks/${manifest.ids[0]}`, 'damaged');
    if (damage === 'cross-parent') manifest.ids[0] = manifest.ids[0].replace('atlas:', 'other:');
    if (damage === 'oversized') manifest.bytes = 32 * 1024 * 1024 + 1;
    assert.equal(await readSnapshot('type', 'atlas', {
      ...durable, legacyGet: legacy.get,
      legacyEnvelope: async (type, id) => ({ payload: await legacy.get(type, id), observedAt: timestamp, ttlMs: 10000 }),
    }), null, damage);
    assert.equal(durable.writes.length, 0);
  }
});

test('a damaged Supabase envelope does not bypass content checks', async () => {
  const durable = durableStore();
  durable.rows.set('type/atlas', { ...durable.envelope(value), rawSha256: '0'.repeat(64) });
  assert.equal(await readSnapshot('type', 'atlas', {
    ...durable, legacyGet: async () => null, legacyEnvelope: async () => null,
  }), null);
  assert.equal(await writeSnapshot('type', 'atlas', value, 100, durable), false);
  assert.equal(durable.writes.length, 0);
});

test('known legacy expiry is not renewed when reading the generation takes too long', async () => {
  const legacy = legacyStore();
  await writeSnapshot('type', 'atlas', value, 100, legacy);
  assert.equal(await readLegacySnapshot('type', 'atlas', {
    get: legacy.get, now: () => timestamp,
    getEnvelope: async (type, id) => ({ payload: await legacy.get(type, id), observedAt: timestamp - 2000, ttlMs: 1000 }),
  }), null);
});

test('a reader racing migration chunk deletion picks up the complete atomic replacement', async () => {
  const legacy = legacyStore(), durable = durableStore();
  await writeSnapshot('type', 'atlas', value, 100, legacy);
  const replacement = { ...value, generatedAt: '2026-09-13T11:30:00Z' };
  let reads = 0, parentRead = false;
  const result = await readSnapshot('type', 'atlas', {
    ...durable,
    cacheRead: async (type, id) => { reads++; return durable.cacheRead(type, id); },
    legacyGet: legacy.get,
    legacyEnvelope: async (type, id) => {
      if (type.endsWith(':chunks')) {
        assert.equal(parentRead, true);
        // The maintenance worker copies and verifies the full replacement,
        // then retires the Redis generation between parent and chunk reads.
        durable.rows.set('type/atlas', durable.envelope(replacement));
        legacy.rows.delete(`${type}/${id}`);
        return null;
      }
      parentRead = true;
      return { payload: await legacy.get(type, id), observedAt: timestamp, ttlMs: 10000 };
    },
  });
  assert.deepEqual(result, replacement);
  assert.equal(reads, 2);
  assert.equal(durable.writes.length, 0);
});
