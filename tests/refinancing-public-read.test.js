import test from 'node:test';
import assert from 'node:assert/strict';
import { createCachedRefinancingRead } from '../src/utils/refinancing/publicRead.js';
import { encodeRefinancingCache } from '../src/utils/refinancing/server.js';
import { buildRefinancingWall } from '../src/utils/refinancing/projection.js';
import { extractRefinancingProfile } from '../src/utils/refinancing/maturities.js';

const START = Date.parse('2026-09-29T00:00:00Z');
const env = { VERCEL_ENV: 'production' };
function fixture(time = START) {
  const generatedAt = new Date(time).toISOString();
  const company = { cik: '0000000001', ticker: 'TEST', name: 'Test issuer', sic: '3571', observedAt: generatedAt,
    refinancing: extractRefinancingProfile({ cik: 1, facts: {} }, { ticker: 'TEST', asOf: '2026-09-29' }) };
  return buildRefinancingWall({ companies: [company], requested: 1, generatedAt });
}
const memoCache = fn => { let saved; return async () => saved ||= await fn(); };

test('concurrent cold visitors share one source read and later visitors use a single cache entry', async () => {
  let calls = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const read = createCachedRefinancingRead({ env, now: () => START, cache: memoCache,
    read: async () => { calls++; await blocked; return fixture(); } });
  const visitors = Array.from({ length: 30 }, () => read());
  release();
  const values = await Promise.all(visitors);
  assert.equal(calls, 1);
  assert.ok(values.every(value => value.coverage.totalCandidates === 1));
  await Promise.all(Array.from({ length: 30 }, () => read()));
  assert.equal(calls, 1);
});

test('backend failures are never cached and a cold outage has a bounded recovery cooldown', async () => {
  let calls = 0, clock = START;
  const read = createCachedRefinancingRead({ env, now: () => clock, cache: memoCache,
    read: async () => { calls++; if (calls === 1) throw new Error('database unavailable'); return fixture(clock); } });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => read()));
  assert.ok(results.every(result => result.status === 'rejected'));
  await assert.rejects(read(), { status: 503 });
  assert.equal(calls, 1);
  clock += 10001;
  assert.equal((await read()).coverage.totalCandidates, 1);
  assert.equal(calls, 2);
});

test('a shared cache write failure retains a successful process fallback without repeating backend reads', async () => {
  let calls = 0, clock = START;
  const cache = fn => async () => { await fn(); throw new Error('cache write failed'); };
  const read = createCachedRefinancingRead({ env, cache, now: () => clock,
    read: async () => { calls++; return fixture(); } });
  assert.equal((await read()).coverage.totalCandidates, 1);
  clock += 120000;
  assert.equal((await read()).coverage.totalCandidates, 1);
  assert.equal(calls, 1);
});

test('expired stale cache entries cannot be served indefinitely when the backend is down', async () => {
  let calls = 0;
  const entry = encodeRefinancingCache(fixture(START - 8 * 86400000));
  const read = createCachedRefinancingRead({ env, now: () => START, cache: () => async () => entry,
    read: async () => { calls++; throw new Error('offline'); } });
  await assert.rejects(read(), { status: 503 });
  await assert.rejects(read(), { status: 503 });
  assert.equal(calls, 1);
});

test('a corrupt shared cache is repaired from one validated snapshot', async () => {
  let calls = 0;
  const read = createCachedRefinancingRead({ env, now: () => START, cache: () => async () => ({ gzip: 'bad' }),
    read: async () => { calls++; return fixture(); } });
  assert.equal((await read()).coverage.totalCandidates, 1);
  assert.equal(calls, 1);
});
