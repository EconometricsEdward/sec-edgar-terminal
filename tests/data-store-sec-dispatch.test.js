import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataStore } from '../src/utils/dataStore.js';

const owner = '256fe661-dd6d-4dc2-9072-a097601e09f0';
const acquiredAt = '2026-09-13T12:00:00.000Z';
const grant = { allowed: true, owner, acquiredAt, expiresAt: '2026-09-13T12:00:05.000Z', leaseMs: 5000, waitMs: 0, cooldown: false };
const denied = { allowed: false, owner: null, acquiredAt: null, expiresAt: null, leaseMs: 5000, waitMs: 600000, cooldown: true };
const env = { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: 'sb_secret_fixture', EDGAR_DATASTORE_NAMESPACE: 'fixture' };
function setup(respond = operation => operation === 'edgar_acquire_sec_dispatch' ? grant : true) {
  const calls = [];
  const store = createDataStore({ env, fetchImpl: async (url, options) => {
    const operation = url.split('/').at(-1);
    calls.push({ operation, params: JSON.parse(options.body), ...options });
    return Response.json(respond(operation));
  } });
  return { store, calls };
}

test('SEC dispatch wrappers retain exact RPC contracts and independent two-second budgets', async t => {
  const { store, calls } = setup(); const delays = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => { delays.push(delay); return original(callback, delay, ...args); });
  assert.deepEqual(await store.acquireSecDispatchPermit(owner), grant);
  assert.equal(await store.releaseSecDispatchPermit(owner, { cooldownMs: 1000 }), true);
  assert.equal(await store.publishSecDispatchCooldown(300000), true);
  assert.deepEqual(calls.map(call => [call.operation, call.params]), [
    ['edgar_acquire_sec_dispatch', { p_namespace: 'fixture', p_owner: owner }],
    ['edgar_release_sec_dispatch', { p_namespace: 'fixture', p_owner: owner, p_cooldown_ms: 1000 }],
    ['edgar_publish_sec_cooldown', { p_namespace: 'fixture', p_cooldown_ms: 300000 }],
  ]);
  assert.deepEqual(delays, [2000, 2000, 2000]);
  assert.ok(calls.every(call => call.redirect === 'error' && call.cache === 'no-store'));
});

test('handoff/unarmed responses deny dispatch and malformed or mismatched leases fail closed', async () => {
  assert.deepEqual(await setup(() => denied).store.acquireSecDispatchPermit(owner), denied);
  assert.deepEqual(await setup(() => ({ ...denied, waitMs: 300000 })).store.acquireSecDispatchPermit(owner), { ...denied, waitMs: 300000 });
  for (const invalid of [null, {}, { ...grant, owner: 'different-owner' }, { ...grant, owner: 12 }, { ...grant, leaseMs: 6000 },
    { ...grant, expiresAt: '2026-09-13T12:00:04.999Z' }, { ...grant, waitMs: 1 }, { ...grant, cooldown: true },
    { ...denied, owner }, { ...denied, waitMs: 600001 }, { ...denied, waitMs: 0 }, { ...grant, alternativeHost: 'other' }]) {
    await assert.rejects(setup(() => invalid).store.acquireSecDispatchPermit(owner), { code: 'invalid_sec_dispatch_response' });
  }
  await assert.rejects(setup(() => ({ ok: true })).store.releaseSecDispatchPermit(owner), { code: 'invalid_sec_dispatch_response' });
  await assert.rejects(setup(() => null).store.publishSecDispatchCooldown(1000), { code: 'invalid_sec_dispatch_response' });
});

test('dispatch input validation and cancelled acquisition cannot invoke a coordinator', async () => {
  const { store, calls } = setup();
  await assert.rejects(store.acquireSecDispatchPermit('invalid'), { code: 'invalid_sec_dispatch_owner' });
  await assert.rejects(store.releaseSecDispatchPermit('invalid'), { code: 'invalid_sec_dispatch_owner' });
  for (const cooldownMs of [-1, 300001, 1.5, '1000']) await assert.rejects(store.releaseSecDispatchPermit(owner, { cooldownMs }), { code: 'invalid_sec_cooldown' });
  for (const delay of [0, 300001, NaN, '1000']) await assert.rejects(store.publishSecDispatchCooldown(delay), { code: 'invalid_sec_cooldown' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.acquireSecDispatchPermit(owner, { signal: controller.signal }), { code: 'sec_dispatch_aborted' });
  assert.equal(calls.length, 0);
});

test('in-flight acquisition propagates caller abort while release remains independent', async () => {
  const controller = new AbortController(); let observedSignal;
  const store = createDataStore({ env, fetchImpl: async (_url, options) => {
    observedSignal = options.signal;
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
      controller.abort();
    });
  } });
  await assert.rejects(store.acquireSecDispatchPermit(owner, { signal: controller.signal }), { code: 'timeout' });
  assert.equal(observedSignal.aborted, true);
  const release = setup();
  assert.equal(await release.store.releaseSecDispatchPermit(owner), true);
  assert.equal(release.calls[0].signal.aborted, false);
});
