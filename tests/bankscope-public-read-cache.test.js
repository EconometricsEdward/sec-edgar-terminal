import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCachedBankRead } from '../src/utils/bank/publicReadStore.js';
import { createBankScopeStore } from '../src/utils/bank/scopeStore.js';

const date = '2026-06-30';
const production = { VERCEL_ENV: 'production' };
function result(ids = [451965], status = 'ready') {
  return { banks: ids.map(id => ({ id_rssd: id, legal_name: `BANK ${id}`, available_periods: [date] })),
    reports: status === 'ready' ? ids.map(id => ({ id_rssd: id, report_date: date,
      source_sha256: 'a'.repeat(64), retrieved_at: '2026-09-27T00:00:00Z', validation: { passed: true },
      metrics: [{ key: 'assets', value: 1000000, rssd: id, reportDate: date }] })) : [],
    jobs: ids.map(id => ({ id_rssd: id, report_date: date, status })), periods: [date] };
}
function fixture({ swr = false } = {}) {
  const state = { clock: Date.parse('2026-09-28T00:00:00Z'), reads: 0, saves: 0, cacheGets: 0,
    entries: new Map(), refreshes: [], tags: [], respond: ids => result(ids) };
  const cache = (load, parts, options) => async () => {
    state.cacheGets++;
    const key = JSON.stringify(parts), hit = state.entries.get(key);
    const refresh = async () => { const value = await load(); state.saves++;
      state.entries.set(key, { value: structuredClone(value), at: state.clock, options }); return value; };
    if (!hit) return refresh();
    if (state.clock - hit.at >= options.revalidate * 1000) {
      if (!swr) return refresh();
      state.refreshes.push(refresh().catch(() => {}));
    }
    return structuredClone(hit.value);
  };
  const store = async (op, payload) => { assert.equal(op, 'read'); state.reads++; return state.respond(payload.rssds); };
  const invalidateTag = async (tag, options) => {
    state.tags.push({ tag, options });
    for (const [key, entry] of state.entries) if (entry.options.tags.includes(tag)) state.entries.delete(key);
  };
  const create = (options = {}) => createCachedBankRead({ store, cache, invalidateTag, env: production, now: () => state.clock, ...options });
  return { state, create, read: create() };
}

test('ready reports reuse a shared cache across instances, preserving source dates and isolated copies', async () => {
  const { state, read, create } = fixture();
  const first = await read({ rssds: [451965] });
  first.reports[0].metrics[0].value = -1;
  state.clock += 1000;
  const other = await create()({ rssds: ['451965'] });
  assert.equal(state.reads, 1);
  assert.equal(other.reports[0].metrics[0].value, 1000000);
  assert.equal(other.reports[0].retrieved_at, '2026-09-27T00:00:00Z');
  assert.equal(other.publicReadCache.checkedAt, first.publicReadCache.checkedAt);
  assert.equal(other.publicReadCache.stale, false);
  assert.equal([...state.entries.values()][0].options.revalidate, 300);
});

test('concurrent reads coalesce without retaining an unbounded local result cache', async () => {
  const { state, read } = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => read({ rssds: [451965] })));
  assert.equal(state.reads, 1);
  results[0].banks[0].legal_name = 'changed';
  assert.notEqual(results[1].banks[0].legal_name, 'changed');
  for (let i = 1; i <= 40; i++) await read({ rssds: [i] });
  await read({ rssds: [451965] });
  assert.equal(state.reads, 41, 'shared data survives cycling through more than 32 selections');
});

test('pending, missing and unprepared results never enter shared storage', async () => {
  for (const data of [result([451965], 'queued'), { ...result(), banks: [], reports: [], jobs: [] },
    { ...result(), reports: [], jobs: [] }]) {
    const { state, read, create } = fixture(); state.respond = () => data;
    assert.equal((await read({ rssds: [451965] })).publicReadCache.stale, false);
    await create()({ rssds: [451965] });
    assert.equal(state.reads, 2); assert.equal(state.saves, 0);
  }
});

test('wrong bank, source identity and invalid result envelopes fail closed with no second backend attempt', async () => {
  const mismatched = result(); mismatched.reports[0].metrics[0].rssd = 123;
  for (const data of [null, { ...result(), error: 'bad' }, result([123]), mismatched]) {
    const { state, read } = fixture(); state.respond = () => data;
    await assert.rejects(read({ rssds: [451965] }), { code: 'database_failure' });
    await assert.rejects(read({ rssds: [451965] }), { code: 'database_failure' });
    assert.equal(state.reads, 1); assert.equal(state.saves, 0);
  }
});

test('cached values are revalidated for selection, deployment, timestamps, payload and byte bounds', async () => {
  for (const mutate of [v => { v.ids = [123]; }, v => { v.deployment = '["preview",""]'; },
    v => { v.version = 'old'; }, v => { v.checkedAt = Infinity; }, v => { v.checkedAt += 1; },
    v => { v.data = result([123]); }, v => { v.data.reports[0].metrics[0].value = Infinity; },
    v => { v.data.reports[0].metrics[0].label = 'x'.repeat(512 * 1024); }]) {
    const { state, read, create } = fixture();
    await read({ rssds: [451965] });
    mutate([...state.entries.values()][0].value);
    const data = await create()({ rssds: [451965] });
    assert.equal(data.reports[0].metrics[0].value, 1000000); assert.equal(state.reads, 2);
  }
});

test('ordered selections and approved deployment branches have distinct keys and tags', async () => {
  const { state, read, create } = fixture();
  await read({ rssds: [451965, 493741] });
  assert.equal((await read({ rssds: [493741, 451965] })).banks[0].id_rssd, 493741);
  await create({ env: { ...production, VERCEL_GIT_COMMIT_REF: 'another' } })({ rssds: [451965, 493741] });
  assert.equal(state.reads, 3);
  assert.deepEqual([...state.entries.values()][0].options.tags, ['bankscope-public-read-v1:production:451965', 'bankscope-public-read-v1:production:493741']);
});

test('unsupported environments and invalid selections cannot read cached production data', async () => {
  const { state, create } = fixture();
  for (const env of [{}, { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'other' }]) {
    await assert.rejects(create({ env })({ rssds: [451965] }), { code: 'bank_service_unavailable' });
  }
  const read = create();
  for (const payload of [undefined, {}, { rssds: [] }, { rssds: [1, 1] }, { rssds: [1], extra: true }, { rssds: [0] }, { rssds: [1, 2, 3, 4, 5] }]) {
    await assert.rejects(read(payload), { code: 'invalid_selection' });
  }
  assert.equal(state.cacheGets, 0); assert.equal(state.reads, 0);
});

test('approved previews bypass the shared cache', async () => {
  const { state, create } = fixture();
  const read = create({ env: { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feat/ffiec-bank-pilot' } });
  await read({ rssds: [451965] }); await read({ rssds: [451965] });
  assert.equal(state.reads, 2); assert.equal(state.cacheGets, 0);
});

test('saved reports are marked stale during background refresh and failures retain the original check time', async () => {
  const { state, read, create } = fixture({ swr: true });
  const first = await read({ rssds: [451965] });
  state.clock += 300000;
  state.respond = () => { throw new Error('database timeout'); };
  const stale = await create()({ rssds: [451965] });
  await Promise.all(state.refreshes);
  assert.equal(stale.publicReadCache.stale, true);
  assert.equal(stale.publicReadCache.checkedAt, first.publicReadCache.checkedAt);
  assert.equal(state.reads, 2);
  assert.equal(state.saves, 1);
});

test('failed background refreshes cool down while saved reports remain available', async () => {
  const { state, read } = fixture({ swr: true });
  await read({ rssds: [451965] });
  state.clock += 300000;
  state.respond = () => { throw new Error('database timeout'); };
  await read({ rssds: [451965] }); await Promise.all(state.refreshes);
  for (let i = 0; i < 10; i++) assert.equal((await read({ rssds: [451965] })).publicReadCache.stale, true);
  await Promise.all(state.refreshes);
  assert.equal(state.reads, 2, 'an outage does not cause ten more source calls');
  state.clock += 5000;
  await read({ rssds: [451965] }); await Promise.all(state.refreshes);
  assert.equal(state.reads, 3);
});

test('background work is coalesced and capped independently of completed cache-hit requests', async () => {
  const { state, read } = fixture({ swr: true });
  for (let i = 1; i <= 65; i++) await read({ rssds: [i] });
  state.clock += 300000;
  let release; const gate = new Promise(resolve => { release = resolve; });
  state.respond = async ids => { await gate; return result(ids); };
  await read({ rssds: [1] }); await read({ rssds: [1] });
  for (let i = 2; i <= 65; i++) await read({ rssds: [i] });
  assert.equal(state.reads, 65 + 64);
  release(); await Promise.all(state.refreshes);
  assert.equal(state.saves, 65 + 65, 'joining one source promise can satisfy both same-bank cache refreshes');
});

test('the six-hour stale bound is enforced without duplicate refresh requests', async () => {
  const { state, read, create } = fixture({ swr: true });
  await read({ rssds: [451965] });
  state.clock += 6 * 60 * 60 * 1000 + 1;
  state.respond = () => { throw new Error('database timeout'); };
  await assert.rejects(create()({ rssds: [451965] }), /database timeout/);
  await Promise.all(state.refreshes);
  assert.equal(state.reads, 2, 'a failed background source call is not repeated by the hard-expiry fallback');
});

test('cache infrastructure read and write failures each use one valid source request', async () => {
  for (const cache of [() => async () => { throw new Error('cache unavailable'); },
    load => async () => { await load(); throw new Error('cache write unavailable'); }]) {
    const { state, create } = fixture();
    const data = await create({ cache })({ rssds: [451965] });
    assert.equal(data.reports[0].metrics[0].value, 1000000); assert.equal(state.reads, 1);
  }
});

test('source failures are never immediately retried by cache fallback', async () => {
  const { state, read } = fixture();
  state.respond = () => { throw new Error('database timeout'); };
  await assert.rejects(read({ rssds: [451965] }), /database timeout/);
  await assert.rejects(read({ rssds: [451965] }), { code: 'database_failure' });
  assert.equal(state.reads, 1);
  state.clock += 5000;
  state.respond = ids => result(ids);
  assert.equal((await read({ rssds: [451965] })).publicReadCache.stale, false);
  assert.equal(state.reads, 2);
});

test('large ready responses are usable but are never retained in shared storage', async () => {
  const { state, read } = fixture();
  state.respond = ids => { const data = result(ids); data.reports[0].metrics[0].label = 'x'.repeat(512 * 1024); return data; };
  await read({ rssds: [451965] }); await read({ rssds: [451965] });
  assert.equal(state.reads, 2); assert.equal(state.saves, 0);
});

test('bank invalidation expires its selections immediately, preserving unrelated cached banks', async () => {
  const { state, read, create } = fixture();
  await read({ rssds: [451965] }); await read({ rssds: [451965, 493741] }); await read({ rssds: [493741] });
  await read.invalidate(451965);
  assert.deepEqual(state.tags, [{ tag: 'bankscope-public-read-v1:production:451965', options: { expire: 0 } }]);
  await create()({ rssds: [493741] }); assert.equal(state.reads, 3);
  await create()({ rssds: [451965] }); assert.equal(state.reads, 4);
  await create()({ rssds: [451965, 493741] }); assert.equal(state.reads, 5);
});

test('tag invalidation followed by a read cannot persist a pre-amendment local gateway hit', async () => {
  const { state, create } = fixture();
  let version = 'a', requests = 0;
  const raw = createBankScopeStore({ env: production, now: () => state.clock, identity: async () => 'test-token', logger: () => {},
    fetchImpl: async (_, init) => {
      requests++;
      const { payload } = JSON.parse(init.body);
      const data = result(payload.rssds); data.reports[0].source_sha256 = version.repeat(64);
      return Response.json(data);
    } });
  await raw('read', { rssds: [451965] });
  const one = create({ store: raw }), another = create({ store: raw });
  assert.equal((await one({ rssds: [451965] })).reports[0].source_sha256, 'a'.repeat(64));
  version = 'b';
  await another.invalidate(451965);
  state.clock += 1000;
  assert.equal((await raw('read', { rssds: [451965] })).reports[0].source_sha256, 'a'.repeat(64), 'other process local data is still warm');
  const amended = await one({ rssds: [451965] });
  assert.equal(amended.reports[0].source_sha256, 'b'.repeat(64));
  assert.equal(amended.publicReadCache.checkedAt, new Date(state.clock).toISOString());
  assert.equal((await another({ rssds: [451965] })).reports[0].source_sha256, 'b'.repeat(64));
  assert.equal(requests, 3, 'one initial raw read and one actual database read per shared fill');
});

test('a read started before preparation cannot refill the cache afterward', async () => {
  const { state, read } = fixture();
  let release; const gate = new Promise(resolve => { release = resolve; });
  state.respond = async ids => { await gate; return result(ids); };
  const old = read({ rssds: [451965] });
  await Promise.resolve(); await read.invalidate(451965);
  release(); await old;
  assert.equal(state.saves, 0);
  state.respond = ids => result(ids, 'queued');
  assert.equal((await read({ rssds: [451965] })).jobs[0].status, 'queued');
  assert.equal(state.saves, 0);
});

test('API, page and exposure manifests use the public read cache without disabling Data Cache', () => {
  const file = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const route = file('../src/app/api/banks/route.js'), page = file('../src/app/analysis/banks/[rssd]/page.jsx');
  assert.match(route, /getBankPublicRead\(payload\)/);
  assert.match(route, /invalidateBankPublicRead\(payload\.rssd\)/);
  assert.match(page, /getBankPublicRead\(/);
  assert.doesNotMatch(page, /force-dynamic/);
  assert.match(file('../src/utils/bank/exposureService.js'), /read = store === bankScopeStore \? getBankPublicRead/);
});
