import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankScopeStore } from '../src/utils/bank/scopeStore.js';

const directory = () => ({ banks: [{ id_rssd: 451965, legal_name: 'WELLS FARGO BANK, NATIONAL ASSOCIATION', prepared_quarters: 4 }], bankCount: 4529, periods: ['2026-06-30'], directoryAt: '2026-09-27T00:00:00Z' });
function fixture(options = {}) {
  const state = { clock: 1_000_000, calls: [], logs: [], tokens: 0, respond: async () => Response.json(directory()) };
  const store = createBankScopeStore({ env: { VERCEL_ENV: 'production' }, now: () => state.clock,
    identity: async () => `private-token-${++state.tokens}`, logger: event => state.logs.push(event),
    fetchImpl: async (url, init) => { state.calls.push({ url, init }); return state.respond(url, init); }, ...options });
  return { state, store };
}
const unavailable = error => error.code === 'database_failure' && typeof error.retryAt === 'string';

test('directory search coalesces concurrent work, caches only public results, and isolates caller changes', async () => {
  const { store, state } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  state.respond = async () => { await gate; return Response.json(directory()); };
  const first = store('search', { query: '' });
  const second = store('search');
  await Promise.resolve();
  assert.equal(state.calls.length, 1);
  assert.equal(state.tokens, 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  left.banks[0].legal_name = 'changed';
  assert.equal(right.banks[0].legal_name, directory().banks[0].legal_name);
  assert.deepEqual(await store('search', { query: '  ' }), directory());
  assert.equal(state.calls.length, 1);
  const request = state.calls[0].init;
  assert.equal(request.redirect, 'error');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.headers.Authorization, 'Bearer private-token-1');
});

test('blank directory lives five minutes while named searches expire after thirty seconds', async () => {
  const { store, state } = fixture();
  await store('search');
  await store('search', { query: 'Wells Fargo' });
  state.clock += 29_999;
  await store('search', { query: ' wells fargo ' });
  assert.equal(state.calls.length, 2);
  state.clock++;
  await store('search', { query: 'wells fargo' });
  assert.equal(state.calls.length, 3);
  state.clock += 269_999;
  await store('search');
  assert.equal(state.calls.length, 3);
  state.clock++;
  await store('search');
  assert.equal(state.calls.length, 4);
  assert.equal(state.tokens, 4, 'each network attempt obtains its own identity token');
});

test('an outage coalesces failures, cools down briefly, and permits one later recovery without automatic retries', async () => {
  const { store, state } = fixture();
  state.respond = async () => Response.json({ secret: 'upstream diagnostic' }, { status: 503 });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => store('search')));
  assert.ok(results.every(result => result.status === 'rejected' && unavailable(result.reason)));
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.logs, [{ operation: 'search', status: 503, category: 'http' }]);
  await assert.rejects(store('search'), unavailable);
  state.clock += 4999;
  await assert.rejects(store('search'), unavailable);
  assert.equal(state.calls.length, 1);
  state.clock++;
  state.respond = async () => Response.json(directory());
  assert.deepEqual(await store('search'), directory());
  await store('search');
  assert.equal(state.calls.length, 2);
});

test('expired directory results are not returned as a fallback when refresh fails', async () => {
  const { store, state } = fixture();
  await store('search');
  state.clock += 300000;
  state.respond = async () => { throw new Error('private database connection detail'); };
  await assert.rejects(store('search'), unavailable);
  await assert.rejects(store('search'), unavailable);
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.logs, [{ operation: 'search', status: null, category: 'network' }]);
});

test('malformed and error-bearing successful HTTP responses never populate the search cache', async () => {
  for (const response of [() => new Response('not-json'), () => Response.json(null), () => Response.json({ code: 'database_failure' }),
    () => Response.json({ ...directory(), unavailable: true }), () => Response.json({ ...directory(), bankCount: null })]) {
    const { store, state } = fixture();
    state.respond = async () => response();
    await assert.rejects(store('search'), unavailable);
    await assert.rejects(store('search'), unavailable);
    assert.equal(state.calls.length, 1);
    state.clock += 5000;
    state.respond = async () => Response.json(directory());
    assert.deepEqual(await store('search'), directory());
    assert.equal(state.calls.length, 2);
    assert.deepEqual(state.logs, [{ operation: 'search', status: 200, category: 'response_invalid' }]);
  }
});

test('successful search cache is bounded to one hundred small entries and uses LRU eviction', async () => {
  const { store, state } = fixture();
  for (let i = 0; i < 100; i++) await store('search', { query: `bank ${i}` });
  await store('search', { query: 'bank 0' });
  await store('search', { query: 'bank 100' });
  await store('search', { query: 'bank 0' });
  assert.equal(state.calls.length, 101);
  await store('search', { query: 'bank 1' });
  assert.equal(state.calls.length, 102, 'least recently used result was evicted');
  state.respond = async () => Response.json({ ...directory(), padding: 'x'.repeat(65536) });
  await store('search', { query: 'large response' });
  await store('search', { query: 'large response' });
  assert.equal(state.calls.length, 104, 'large results are returned but never retained');
});

test('in-flight protection is bounded without evicting active identical work', async () => {
  const { store, state } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  state.respond = async () => { await gate; return Response.json(directory()); };
  const requests = Array.from({ length: 100 }, (_, i) => store('search', { query: `bank ${i}` }));
  const same = store('search', { query: 'bank 0' });
  await assert.rejects(store('search', { query: 'extra bank' }), unavailable);
  assert.equal(state.calls.length, 100);
  release();
  await Promise.all([...requests, same]);
  await store('search', { query: 'extra bank' });
  assert.equal(state.calls.length, 101);
});

test('environment checks apply before cached hits and allowed environments do not share cached results', async () => {
  const env = { VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' };
  const { store, state } = fixture({ env });
  await store('search');
  env.VERCEL_ENV = 'development';
  await assert.rejects(store('search'), { code: 'bank_service_unavailable' });
  env.VERCEL_ENV = 'preview';
  await assert.rejects(store('search'), { code: 'bank_service_unavailable' });
  assert.equal(state.calls.length, 1);
  env.VERCEL_GIT_COMMIT_REF = 'feat/ffiec-bank-pilot';
  await store('search');
  assert.equal(state.calls.length, 2);
  env.VERCEL_ENV = 'production';
  env.VERCEL_GIT_COMMIT_REF = 'main';
  await store('search');
  assert.equal(state.calls.length, 2);
});

test('mutations and uncacheable operations bypass caching, coalescing, cooldown, and retries', async () => {
  const { store, state } = fixture();
  state.respond = async () => Response.json({ accepted: true });
  await Promise.all([store('request', { rssd: 451965 }), store('request', { rssd: 451965 })]);
  await store('request', { rssd: 451965 });
  assert.equal(state.calls.length, 3);
  state.respond = async () => Response.json({}, { status: 503 });
  await assert.rejects(store('publish', { owner: 'private-owner' }), { code: 'database_failure', retryAt: null });
  assert.equal(state.calls.length, 4);
  await assert.rejects(store('publish', { owner: 'private-owner' }), { code: 'database_failure', retryAt: null });
  assert.equal(state.calls.length, 5);
  state.respond = async () => Response.json({ reports: [] });
  await store('status');
  await store('status');
  assert.equal(state.calls.length, 7);
});

test('failure diagnostics exclude tokens, payloads, raw error messages, and unknown operation text', async () => {
  const { store, state } = fixture();
  state.respond = async () => { throw new Error('private-token-1 private-query secret upstream message'); };
  await assert.rejects(store('search', { query: 'private-query' }), unavailable);
  await assert.rejects(store('private-operation', { secret: 'private-payload' }), { code: 'database_failure' });
  assert.deepEqual(state.logs, [{ operation: 'search', status: null, category: 'network' }, { operation: 'unknown', status: null, category: 'network' }]);
  assert.doesNotMatch(JSON.stringify(state.logs), /private|secret|upstream/);
});
