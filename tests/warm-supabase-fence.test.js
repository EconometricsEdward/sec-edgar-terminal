import test from 'node:test';
import assert from 'node:assert/strict';
import { createWarmGenerationCache } from '../src/utils/warmCache.js';
import { disposableCacheFencePolicy } from '../src/utils/disposableCache.js';

const owner = '12345678-1234-4234-8234-123456789abc';
const expiresAt = new Date(Date.now() + 120000).toISOString();
const claimFor = (dataset, key, generation = '9007199254740993') => ({ dataset, key, fenceId: key, generation, owner, expiresAt });
const prohibitedRedis = async () => { throw new Error('Supabase publications must not refill Redis'); };
const supported = [
  { type: 'edgar.cftc-positioning.v1:production', dataset: 'cftc', key: 'markets:tff:latest', id: 'markets-last-good:tff:latest' },
  { type: 'research-sec-v1', dataset: 'sec', key: 'sec-documents-v1:CIK0000320193:companyfacts', id: '/api/xbrl/companyfacts/CIK0000320193.json' },
  { type: 'submissions-cik', dataset: 'sec', key: 'sec-documents-v1:CIK0000789019:submissions', id: '0000789019' },
  { type: 'analysis-research', dataset: 'financial', key: 'financial-analysis-v1:analysis-v1.4:context-v3:CIK0000320193:annual:latest', id: 'analysis-v1.4:context-v3:AAPL:annual:' },
  { type: 'research-serving-v1', dataset: 'financial', key: 'research-compare-v1:compare-v2:context-v3:CIK0000019617:quarter:latest', id: 'research-compare-v1:compare-v2:context-v3:CIK0000019617:quarter:latest' },
];

test('production canonical mirrors reserve and publish through Supabase using exact dataset claims', async () => {
  const reservations = [], writes = [], datasets = [];
  const cache = createWarmGenerationCache({ enabled: () => true,
    mode: dataset => { datasets.push(dataset); return 'supabase'; },
    reserve: async (type, key, claim) => { reservations.push({ type, key, claim }); return true; },
    put: async (type, id, payload, ttl, claim) => { writes.push({ type, id, payload, ttl, claim }); return { stored: true }; },
    legacyReserve: prohibitedRedis, legacyWrite: prohibitedRedis });
  for (const target of supported) {
    assert.equal(disposableCacheFencePolicy(target.type, target.key)?.dataset, target.dataset);
    const claim = claimFor(target.dataset, target.key);
    assert.equal(await cache.reserve(target.type, target.key, claim.generation, claim), true);
    assert.equal(await cache.set(target.type, target.id, { prepared: true }, 90000, claim), true);
  }
  assert.equal(reservations.length, supported.length); assert.equal(writes.length, supported.length);
  writes.forEach((write, index) => {
    assert.equal(write.id, supported[index].id); assert.equal(write.claim.key, supported[index].key);
    assert.equal(write.claim.dataset, supported[index].dataset); assert.equal(write.claim.generation, '9007199254740993');
  });
  assert.deepEqual(new Set(datasets), new Set(['cftc', 'sec', 'financial']));
});

test('off and shadow keep the original Redis fencing and disabled disposable storage never selects Supabase', async () => {
  const target = supported[0], claim = claimFor(target.dataset, target.key, 1);
  for (const [enabled, mode] of [[true, 'off'], [true, 'shadow'], [false, 'supabase']]) {
    let oldReserves = 0, oldWrites = 0;
    const cache = createWarmGenerationCache({ enabled: () => enabled, mode: () => mode,
      reserve: async () => { throw new Error('must not select Supabase'); }, put: async () => { throw new Error('must not select Supabase'); },
      legacyReserve: async () => { oldReserves++; return true; }, legacyWrite: async () => { oldWrites++; return true; } });
    assert.equal(await cache.reserve(target.type, target.key, 1, claim), true);
    assert.equal(await cache.set(target.type, target.id, {}, 3600, claim), true);
    assert.equal(oldReserves, 1); assert.equal(oldWrites, 1);
  }
});

test('wrong canonical claims and destination identities cannot reserve or publish to either backend', async () => {
  const target = supported[1], good = claimFor(target.dataset, target.key, 1);
  let calls = 0;
  const forbidden = async () => { calls++; return true; };
  const cache = createWarmGenerationCache({ enabled: () => true, mode: () => 'supabase', reserve: forbidden, put: forbidden,
    legacyReserve: forbidden, legacyWrite: forbidden });
  for (const bad of [{ ...good, dataset: 'cftc' }, { ...good, key: 'sec-documents-v1:CIK0000789019:companyfacts' },
    { ...good, fenceId: 'sec-documents-v1:CIK0000789019:companyfacts' },
    { ...good, owner: '' }, { ...good, expiresAt: '' }, { ...good, generation: 0 }]) {
    assert.equal(await cache.reserve(target.type, target.key, bad.generation, bad), false);
    assert.equal(await cache.set(target.type, target.id, {}, 300, bad), false);
  }
  assert.equal(await cache.reserve(target.type, target.key, 2, good), false);
  assert.equal(await cache.set(target.type, '/api/xbrl/companyfacts/CIK0000789019.json', {}, 300, good), false);
  assert.equal(await cache.set(target.type, target.id, {}, 0, good), false);
  assert.equal(calls, 0);
});

test('rejected reservations, stale writes, and storage failures return false without any Redis or unfenced fallback', async () => {
  const target = supported[0], claim = claimFor(target.dataset, target.key, 1);
  for (const fail of ['denied', 'exception']) {
    let reserves = 0, writes = 0;
    const cache = createWarmGenerationCache({ enabled: () => true, mode: () => 'supabase',
      reserve: async () => { reserves++; if (fail === 'exception') throw new Error('unavailable'); return false; },
      put: async () => { writes++; if (fail === 'exception') throw new Error('unavailable'); return { stored: false, reason: 'fence_unreserved' }; },
      legacyReserve: prohibitedRedis, legacyWrite: prohibitedRedis });
    assert.equal(await cache.reserve(target.type, target.key, 1, claim), false);
    assert.equal(await cache.set(target.type, target.id, {}, 86400, claim), false);
    assert.equal(reserves, 1); assert.equal(writes, 1);
  }
});

test('selected fenced cache payloads above the old Redis ceiling reach the bounded Supabase adapter', async () => {
  const target = supported[1], claim = claimFor(target.dataset, target.key, 1);
  const payload = { cik: 320193, facts: { description: 'x'.repeat(1100000) } };
  let received;
  const cache = createWarmGenerationCache({ enabled: () => true, mode: () => 'supabase',
    put: async (_type, _id, value) => { received = value; return { stored: true }; }, legacyWrite: prohibitedRedis });
  assert.equal(await cache.set(target.type, target.id, payload, 300, claim), true); assert.equal(received, payload);
});
