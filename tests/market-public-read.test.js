import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMarketResearchPublicRead } from '../src/utils/marketPlumbing/publicRead.js';
const fixture = kind => JSON.parse(readFileSync(`src/data/market-research/${kind}.json`, 'utf8'));
const env = { VERCEL_ENV: 'production' };
function harness(options = {}) {
  let now = Date.parse('2026-09-29T12:00:00Z'), reads = 0;
  const entries = new Map();
  const reader = createMarketResearchPublicRead({ env, now: () => now,
    store: async (_operation, { kind }) => { reads++; return { snapshot: fixture(kind), refresh: { [kind]: 'ready' } }; },
    cache: (load, keys, policy) => {
      assert.ok(keys.includes('production')); assert.equal(policy.revalidate, 900);
      return async kind => { if (!entries.has(kind)) entries.set(kind, await load(kind)); return structuredClone(entries.get(kind)); };
    }, ...options });
  return { reader, reads: () => reads, entries, advance: ms => { now += ms; } };
}
test('SSR and API readers share one public snapshot per kind without changing its source date', async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) assert.equal((await h.reader('funding')).snapshot.generatedAt, fixture('funding').generatedAt);
  assert.equal(h.reads(), 1);
  await h.reader('derivatives'); assert.equal(h.reads(), 2);
  assert.deepEqual((await h.reader('funding')).refresh, { funding: 'ready' });
});
test('stale shared reads are labeled and hard-expired cache is rechecked', async () => {
  const h = harness(); await h.reader('funding'); h.advance(900000);
  assert.equal((await h.reader('funding')).refresh.funding, 'retained');
  h.advance(6 * 3600000); await h.reader('funding'); assert.equal(h.reads(), 2);
});
test('invalid data and source errors are thrown instead of persisted', async () => {
  const h = harness({ store: async () => ({ snapshot: {} }) });
  await assert.rejects(h.reader('funding'), /Invalid prepared/);
  assert.equal(h.entries.size, 0);
  await assert.rejects(h.reader('unknown'), /Invalid market/);
});
test('preview never reads production shared cache', async () => {
  let sharedReads = 0;
  const h = harness({ env: { VERCEL_ENV: 'preview' }, cache: () => async () => { sharedReads++; throw Error('must not read'); } });
  await h.reader('funding'); assert.equal(sharedReads, 0); assert.equal(h.reads(), 1);
});
