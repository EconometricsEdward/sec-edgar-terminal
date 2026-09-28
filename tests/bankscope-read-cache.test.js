import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankScopeStore } from '../src/utils/bank/scopeStore.js';
import { isBankReadResult } from '../src/utils/bank/readResult.js';

const period = '2026-06-30';
function result(ids = [451965], status = 'ready') {
  return {
    banks: ids.map(id => ({ id_rssd: id, legal_name: `BANK ${id}`, available_periods: [period] })),
    reports: status === 'ready' ? ids.map(id => ({ id_rssd: id, report_date: period,
      source_sha256: 'a'.repeat(64), retrieved_at: '2026-09-27T00:00:00Z', validation: { passed: true },
      metrics: [{ key: 'assets', value: 1000000, rssd: id, reportDate: period }] })) : [],
    jobs: ids.map(id => ({ id_rssd: id, report_date: period, status })), periods: [period],
  };
}
function fixture() {
  const state = { clock: 1000000, calls: 0, env: { VERCEL_ENV: 'production' },
    respond: async payload => result(payload.rssds) };
  const store = createBankScopeStore({ env: state.env, now: () => state.clock, identity: async () => 'token', logger: () => {},
    fetchImpl: async (_, init) => { state.calls++; const { operation, payload } = JSON.parse(init.body);
      return Response.json(await state.respond(payload, operation)); } });
  return { state, store, read: (ids = [451965]) => store('read', { rssds: ids }) };
}

test('twenty concurrent profile reads plus repeated warm reads make one backend call', async () => {
  const { state, read } = fixture();
  const values = await Promise.all(Array.from({ length: 20 }, () => read()));
  assert.equal(state.calls, 1);
  values[0].reports[0].metrics[0].value = 0;
  assert.equal(values[1].reports[0].metrics[0].value, 1000000);
  assert.equal((await read(['451965'])).reports[0].metrics[0].value, 1000000);
  assert.equal(state.calls, 1);
  state.clock += 30000;
  await read();
  assert.equal(state.calls, 2, 'a ready report is refreshed at thirty seconds');
});

test('shared-cache refresh can bypass a warm local read after an amendment', async () => {
  const { state, read, store } = fixture();
  await read();
  state.respond = async payload => {
    const data = result(payload.rssds);
    data.reports[0].source_sha256 = 'b'.repeat(64);
    data.reports[0].metrics[0].value = 2000000;
    return data;
  };
  assert.equal((await read()).reports[0].source_sha256, 'a'.repeat(64));
  assert.equal(state.calls, 1, 'ordinary reads retain their local optimization');
  const amended = await store.readFresh({ rssds: ['451965'] });
  assert.equal(amended.reports[0].source_sha256, 'b'.repeat(64));
  assert.equal(amended.reports[0].metrics[0].value, 2000000);
  assert.equal(state.calls, 2);
});

test('fresh reads enforce environment, selection and source validation before reuse', async () => {
  const { state, store } = fixture();
  await assert.rejects(store.readFresh({ rssds: [451965], extra: true }), { code: 'invalid_selection' });
  assert.equal(state.calls, 0);
  state.env.VERCEL_ENV = 'preview';
  await assert.rejects(store.readFresh({ rssds: [451965] }), { code: 'bank_service_unavailable' });
  assert.equal(state.calls, 0);
  state.env.VERCEL_ENV = 'production';
  state.respond = async () => result([123]);
  await assert.rejects(store.readFresh({ rssds: [451965] }), { code: 'database_failure' });
  state.respond = async payload => { const data = result(payload.rssds); data.reports[0].source_sha256 = 'bad'; return data; };
  await assert.rejects(store.readFresh({ rssds: [451965] }), { code: 'database_failure' });
});

test('pending, missing and unprepared banks refresh after three seconds', async () => {
  for (const response of [result([451965], 'queued'), { ...result(), banks: [], reports: [], jobs: [] }, { ...result(), reports: [], jobs: [] }]) {
    const { state, read } = fixture();
    state.respond = async () => response;
    await read(); state.clock += 2999; await read(); assert.equal(state.calls, 1);
    state.clock++; await read(); assert.equal(state.calls, 2);
  }
});

test('ordered bank selections and allowed deployment scopes never share responses', async () => {
  const { state, read } = fixture();
  await read([451965, 101]);
  assert.equal((await read([101, 451965])).banks[0].id_rssd, 101);
  assert.equal(state.calls, 2);
  state.env.VERCEL_ENV = 'preview';
  await assert.rejects(read([451965, 101]), { code: 'bank_service_unavailable' });
  state.env.VERCEL_GIT_COMMIT_REF = 'feat/ffiec-bank-pilot';
  await read([451965, 101]); assert.equal(state.calls, 3);
});

test('failed reads coalesce, cool down without retries, and do not serve expired figures', async () => {
  const { state, read } = fixture();
  await read(); state.clock += 30000;
  state.respond = async () => { throw new Error('database unavailable'); };
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => read()));
  assert.ok(attempts.every(attempt => attempt.status === 'rejected' && attempt.reason.retryAt));
  await assert.rejects(read(), { code: 'database_failure' }); assert.equal(state.calls, 2);
  state.clock += 5000; state.respond = async () => result();
  await read(); assert.equal(state.calls, 3);
});

test('wrong bank, period, source and malformed successful responses fail closed', async () => {
  const invalid = [null, { reports: [] }, { ...result(), error: 'unavailable' }, result([101]),
    { ...result(), periods: ['2026-06-30', '2026-06-30'] }];
  for (const change of [report => { report.source_sha256 = ''; }, report => { report.metrics[0].rssd = 101; },
    report => { report.metrics[0].reportDate = '2026-03-31'; }, report => { report.validation = null; }]) {
    const data = result(); change(data.reports[0]); invalid.push(data);
  }
  for (const data of invalid) {
    assert.equal(isBankReadResult(data, [451965]), false);
    const { state, read } = fixture(); state.respond = async () => data;
    await assert.rejects(read(), { code: 'database_failure' });
    await assert.rejects(read(), { code: 'database_failure' }); assert.equal(state.calls, 1);
  }
});

test('public report reuse is bounded by both entry count and response bytes', async () => {
  const { state, read } = fixture();
  for (let id = 1; id <= 32; id++) await read([id]);
  await read([1]); await read([33]); await read([1]); assert.equal(state.calls, 33);
  await read([2]); assert.equal(state.calls, 34, 'least recently used report was evicted');
  state.respond = async ids => ({ ...result(ids.rssds), padding: 'x'.repeat(512 * 1024) });
  await read([34]); await read([34]); assert.equal(state.calls, 36, 'oversized results are returned without retention');
});

test('preparation invalidates profiles and no pre-mutation completion can refill the cache', async () => {
  const { state, read, store } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  state.respond = async (payload, op) => {
    if (op === 'request') return { queued: 1 };
    if (state.calls === 1) { await gate; return result(payload.rssds); }
    return result(payload.rssds, 'queued');
  };
  const old = read(); await Promise.resolve();
  await store('request', { rssd: 451965, clientHash: 'private' });
  assert.equal((await read()).jobs[0].status, 'queued');
  release(); await old;
  assert.equal((await read()).jobs[0].status, 'queued');
  assert.equal(state.calls, 3);
});

test('a read during a write and an uncertain failed write cannot leave a retained result', async () => {
  const { state, read, store } = fixture();
  await read();
  let release; const gate = new Promise(resolve => { release = resolve; });
  state.respond = async (payload, op) => {
    if (op === 'publish') { await gate; throw new Error('response lost after commit'); }
    return result(payload.rssds);
  };
  const write = store('publish', { owner: 'private' });
  await read();
  release(); await assert.rejects(write, { code: 'database_failure' });
  await read(); assert.equal(state.calls, 4);
});
