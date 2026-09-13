import test from 'node:test';
import assert from 'node:assert/strict';
import { CFTC_TRANSPORT_NAMESPACE, createCftcOutboundGate } from '../src/utils/cftcTransport.js';
import { CFTC_CACHE_NAMESPACE } from '../src/utils/cftcServer.js';

test('CFTC outbound coordination uses an isolated namespace and one shared slot', async () => {
  let held = false, active = 0, maximum = 0, sequence = 0;
  const gate = createCftcOutboundGate({
    sharedEnabled: () => true,
    cooldownRemaining: async () => 0,
    acquireLease: async (namespace, id) => {
      assert.equal(namespace, CFTC_TRANSPORT_NAMESPACE);
      assert.equal(id, 'outbound');
      if (held) return null;
      held = true;
      return `lease-${++sequence}`;
    },
    releaseLease: async () => { held = false; return true; },
    pollMs: 1,
    acquireBudgetMs: 250,
  });
  const work = () => gate.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active -= 1;
  });
  await Promise.all([work(), work(), work()]);
  assert.equal(maximum, 1);
  assert.notEqual(CFTC_TRANSPORT_NAMESPACE, CFTC_CACHE_NAMESPACE);
});

test('a published Retry-After cooldown is visible to every shared request', async () => {
  let cooldown = 0, acquired = 0;
  const gate = createCftcOutboundGate({
    sharedEnabled: () => true,
    cooldownRemaining: async (namespace, id) => {
      assert.equal(namespace, CFTC_TRANSPORT_NAMESPACE);
      assert.equal(id, 'retry-after');
      return cooldown;
    },
    extendCooldown: async (namespace, id, milliseconds) => {
      assert.equal(namespace, CFTC_TRANSPORT_NAMESPACE);
      assert.equal(id, 'retry-after');
      cooldown = milliseconds;
      return true;
    },
    acquireLease: async () => { acquired += 1; return 'unused'; },
    releaseLease: async () => true,
  });
  await gate.publishCooldown(1750);
  await assert.rejects(gate.run(async () => 'unexpected'), error => error.code === 'CFTC_RATE_LIMITED' && error.retryAfter === 1750);
  assert.equal(acquired, 0);
});

test('CFTC gate cancellation while queued is bounded and distinct', async () => {
  const state = { active: true, cooldownUntil: 0 };
  const gate = createCftcOutboundGate({ sharedEnabled: () => false, state, pollMs: 2, acquireBudgetMs: 100 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 8);
  await assert.rejects(gate.run(async () => 'unexpected', { signal: controller.signal }), error => error.code === 'CFTC_REQUEST_CANCELLED' && error.status === 499);
});
