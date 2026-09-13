import test from 'node:test';
import assert from 'node:assert/strict';
import { createWarmDataCache } from '../src/utils/warmCache.js';

const policy = (type, id) => type === 'selected' && !String(id).startsWith('legacy');
test('selected data writes only Supabase, including values above the former Redis size limit', async () => {
  let writes = 0, legacyWrites = 0;
  const cache = createWarmDataCache({ enabled: () => true, policy,
    put: async (_type, _id, value, ttl) => { writes++; assert.equal(value.text.length, 1000000); assert.equal(ttl, 300); return { stored: true }; },
    legacyWrite: async () => { legacyWrites++; return true; } });
  assert.equal(await cache.set('selected', 'CIK', { text: 'x'.repeat(1000000) }, 300), true);
  assert.equal(await cache.set('unselected', 'CIK', {}), true);
  assert.equal(writes, 1); assert.equal(legacyWrites, 1);
  const outage = createWarmDataCache({ enabled: () => true, policy,
    put: async () => { throw new Error('unavailable'); }, legacyWrite: async () => { throw new Error('must not refill Redis'); } });
  assert.equal(await outage.set('selected', 'CIK', {}), false);
});

test('cache reads prefer Supabase and never promote or renew legacy values on a miss or outage', async () => {
  let oldReads = 0;
  const cache = createWarmDataCache({ enabled: () => true, policy,
    read: async (_type, id) => { if (id === 'error') throw new Error('cache unavailable'); return id === 'hit' ? { payload: { source: 'new' } } : null; },
    put: async () => { throw new Error('a read must never write'); },
    legacyRead: async () => { oldReads++; return { source: 'old' }; } });
  assert.deepEqual(await cache.get('selected', 'hit'), { source: 'new' });
  assert.deepEqual(await cache.get('selected', 'miss'), { source: 'old' });
  assert.deepEqual(await cache.get('selected', 'error'), { source: 'old' });
  assert.equal(oldReads, 2);
});

test('one final Supabase read closes a concurrent copy-and-delete migration window', async () => {
  const events = [], deadlines = []; let copied = false;
  const value = { source: 'retained', fetchedAt: '2026-09-13T10:00:00Z' };
  const cache = createWarmDataCache({ enabled: () => true, policy,
    read: async (_type, _id, options) => { events.push('supabase'); deadlines.push(options.deadline); return copied ? { payload: value } : null; },
    legacyRead: async () => { events.push('copy-delete-redis'); copied = true; return null; },
    put: async () => { throw new Error('reader must not publish'); } });
  assert.deepEqual(await cache.get('selected', 'issuer'), value);
  assert.deepEqual(events, ['supabase', 'copy-delete-redis', 'supabase']);
  assert.equal(deadlines[0], deadlines[1]);
  assert.ok(deadlines[0] <= Date.now() + 12000);
});

test('single cache reads retry at most once after a legacy error or genuine miss', async () => {
  let reads = 0, legacyReads = 0;
  const cache = createWarmDataCache({ enabled: () => true, policy,
    read: async () => { reads++; return null; },
    legacyRead: async () => { legacyReads++; throw new Error('Redis unavailable'); } });
  assert.equal(await cache.get('selected', 'missing'), null);
  assert.equal(reads, 2); assert.equal(legacyReads, 1);
  reads = 0;
  const recovered = createWarmDataCache({ enabled: () => true, policy,
    read: async () => ++reads === 1 ? null : { payload: { migrated: true } },
    legacyRead: async () => { throw new Error('Redis unavailable'); } });
  assert.deepEqual(await recovered.get('selected', 'issuer'), { migrated: true }); assert.equal(reads, 2);
});

test('mixed bulk reads preserve ordering with at most three batches and 25 items per batch', async () => {
  let active = 0, peak = 0; const oldIds = [];
  const cache = createWarmDataCache({ enabled: () => true, policy,
    readMany: async (_type, ids) => {
      assert.ok(ids.length <= 25); active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve)); active--;
      return ids.map(id => Number(id) % 2 ? null : { payload: { id } });
    },
    legacyReadMany: async (_type, ids) => { assert.ok(ids.length <= 25); oldIds.push(...ids); return ids.map(id => ({ id })); } });
  const ids = Array.from({ length: 151 }, (_, i) => String(i)); ids[20] = 'legacy20';
  assert.deepEqual((await cache.getMany('selected', ids)).map(value => value.id), ids);
  assert.equal(peak, 3); assert.ok(oldIds.includes('legacy20')); assert.ok(!oldIds.includes('0'));
  await assert.rejects(cache.getMany('selected', ids, { signal: AbortSignal.abort() }), /deadline/);
});

test('bulk migration retries only admitted IDs still missing after Redis copy-and-delete', async () => {
  const copied = new Map([['ready', { id: 'ready' }]]), reads = [], deadlines = [];
  const cache = createWarmDataCache({ enabled: () => true, policy,
    readMany: async (_type, ids, options) => { reads.push(ids); deadlines.push(options.deadline); return ids.map(id => copied.has(id) ? { payload: copied.get(id) } : null); },
    legacyReadMany: async (_type, ids) => {
      assert.deepEqual(ids, ['moved', 'legacy-kept', 'cold']);
      copied.set('moved', { id: 'moved' });
      return [null, { id: 'legacy-kept' }, null];
    }, put: async () => { throw new Error('no publication from a read'); } });
  assert.deepEqual(await cache.getMany('selected', ['ready', 'moved', 'legacy-kept', 'cold']),
    [{ id: 'ready' }, { id: 'moved' }, { id: 'legacy-kept' }, null]);
  assert.deepEqual(reads, [['ready', 'moved', 'cold'], ['moved', 'cold']]); assert.equal(deadlines[0], deadlines[1]);
});

test('bulk legacy transport failures recover only when the final Supabase read supplies every failed record', async () => {
  let calls = 0;
  const cache = createWarmDataCache({ enabled: () => true, policy,
    readMany: async (_type, ids) => ++calls === 1 ? ids.map(() => null) : ids.map(id => ({ payload: { id } })),
    legacyReadMany: async () => { throw new Error('legacy transport failure'); } });
  assert.deepEqual(await cache.getMany('selected', ['moved']), [{ id: 'moved' }]); assert.equal(calls, 2);
  calls = 0;
  const unresolved = createWarmDataCache({ enabled: () => true, policy,
    readMany: async (_type, ids) => { calls++; return ids.map(() => null); },
    legacyReadMany: async () => { throw new Error('legacy transport failure'); } });
  await assert.rejects(unresolved.getMany('selected', ['missing']), /legacy transport failure/); assert.equal(calls, 2);
});

test('bulk cache outages use bounded legacy reads but caller cancellation never starts a fallback', async () => {
  let fallbacks = 0;
  const controller = new AbortController();
  const cache = createWarmDataCache({ enabled: () => true, policy,
    readMany: async () => { throw new Error('unavailable'); },
    legacyReadMany: async (_type, ids) => { fallbacks++; return ids.map(() => null); } });
  assert.deepEqual(await cache.getMany('selected', ['1', '2']), [null, null]); assert.equal(fallbacks, 1);
  const canceled = createWarmDataCache({ enabled: () => true, policy,
    readMany: async () => { controller.abort(); throw new Error('aborted'); },
    legacyReadMany: async () => { throw new Error('must not run'); } });
  await assert.rejects(canceled.getMany('selected', ['1'], { signal: controller.signal }), /deadline/);
});

test('legacy migration reads GET and PTTL atomically and reject persistent, expired or oversized values', async () => {
  const priorFetch = globalThis.fetch, priorUrl = process.env.KV_REST_API_URL, priorToken = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_URL = 'https://redis.example.test'; process.env.KV_REST_API_TOKEN = 'fixture';
  let ttl = 12345, payload = JSON.stringify({ previous: true });
  try {
    const { warmLegacyGetEnvelope } = await import(`../src/utils/warmCache.js?legacy=${crypto.randomUUID()}`);
    globalThis.fetch = async (_url, options) => {
      const command = JSON.parse(options.body);
      assert.equal(command[0], 'EVAL'); assert.match(command[1], /redis.call\('GET'/); assert.match(command[1], /redis.call\('PTTL'/);
      assert.doesNotMatch(command[1], /(?:SET|EXPIRE|DEL)/); assert.equal(command.at(-1), 'warm:selected:CIK');
      return Response.json({ result: [payload, ttl] });
    };
    const before = Date.now(), value = await warmLegacyGetEnvelope('selected', 'cik');
    assert.deepEqual(value.payload, { previous: true }); assert.equal(value.ttlMs, ttl);
    assert.ok(value.observedAt >= before); assert.equal(Date.parse(value.expiresAt), value.observedAt + ttl);
    ttl = -1; assert.equal(await warmLegacyGetEnvelope('selected', 'cik'), null);
    ttl = 0; assert.equal(await warmLegacyGetEnvelope('selected', 'cik'), null);
    ttl = 12345; payload = 'x'.repeat(1024 * 1024 + 1); assert.equal(await warmLegacyGetEnvelope('selected', 'cik'), null);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = priorUrl;
    if (priorToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = priorToken;
  }
});
