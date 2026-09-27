import test from 'node:test';
import assert from 'node:assert/strict';
import { createCachedBankDirectory } from '../src/utils/bank/directoryStore.js';

const directory = { bankCount: 4445, banks: [], periods: ['2026-06-30'] };
const production = { VERCEL_ENV: 'production' };

test('directory cache shares only validated public metadata and keeps its original timestamp', async () => {
  let calls = 0, clock = 1000000, keys, config;
  const get = createCachedBankDirectory({ env: production, now: () => clock,
    store: async (op, payload) => { calls++; assert.equal(op, 'search'); assert.deepEqual(payload, { query: '' }); return directory; },
    cache: (load, parts, options) => { keys = parts; config = options; let saved; return async () => saved ||= await load(); },
  });
  const first = await get();
  clock += 1000;
  assert.deepEqual(await get(), first);
  assert.equal(calls, 1);
  assert.deepEqual(keys, ['bankscope-directory-v1', 'production']);
  assert.equal(config.revalidate, 300);
  clock += 600000;
  assert.equal((await get()).stale, true);
  assert.equal((await get()).cachedAt, first.cachedAt);
});

test('directory cache expires old fallback and refuses to invent data during a prolonged outage', async () => {
  let clock = 0, fails = false, calls = 0;
  const get = createCachedBankDirectory({ env: production, now: () => clock,
    store: async () => { calls++; if (fails) throw new Error('unavailable'); return directory; },
    cache: load => { let saved; return async () => saved ||= await load(); },
  });
  await get(); clock = 6 * 60 * 60 * 1000 + 1; fails = true;
  await assert.rejects(get, /unavailable/);
  fails = false;
  const recovered = await get();
  assert.equal(recovered.stale, false);
  assert.equal(recovered.cachedAt, new Date(clock).toISOString());
  assert.equal(calls, 3);
});

test('failed and malformed directory loads are never cached as successful empty coverage', async () => {
  let calls = 0;
  const get = createCachedBankDirectory({ env: production,
    store: async () => ++calls === 1 ? { banks: [], unavailable: true } : directory,
    cache: load => { let saved; return async () => saved ||= await load(); },
  });
  await assert.rejects(get, { code: 'database_failure' });
  assert.equal((await get()).bankCount, 4445);
});

test('unsupported environments cannot read a production cache and approved previews bypass it', async () => {
  let reads = 0, cacheReads = 0;
  const options = { store: async () => { reads++; return directory; }, cache: () => async () => { cacheReads++; return directory; } };
  await assert.rejects(createCachedBankDirectory({ ...options, env: {} }), { code: 'bank_service_unavailable' });
  await assert.rejects(createCachedBankDirectory({ ...options, env: { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'other' } }), { code: 'bank_service_unavailable' });
  await createCachedBankDirectory({ ...options, env: { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feat/ffiec-bank-pilot' } })();
  assert.equal(reads, 1); assert.equal(cacheReads, 0);
});
