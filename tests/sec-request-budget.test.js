import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithSecRequestBudget, takeSecRequestBudget } from '../src/utils/secRequestBudget.js';
import { createSecDispatchCoordinator, secFetch } from '../src/utils/secClient.js';

function coordinatorFixture() {
  let sent = 0, released = 0;
  const coordinator = createSecDispatchCoordinator({ uuid: () => 'fixture-owner', now: () => 0, wait: async () => {},
    acquire: async owner => ({ allowed: true, owner, cooldown: false, waitMs: 0, leaseMs: 5000,
      acquiredAt: '2026-09-15T12:00:00Z', expiresAt: '2026-09-15T12:00:05Z' }),
    release: async () => { released++; return true; },
    transport: async () => { sent++; return new Response('{}'); },
  });
  return { coordinator, sent: () => sent, released: () => released };
}

test('production dispatch budget counts actual sends and releases its SEC permit when exhausted', async () => {
  const f = coordinatorFixture();
  await runWithSecRequestBudget(2, async budget => {
    await f.coordinator.fetch('https://data.sec.gov/submissions/CIK0000320193.json', {});
    await f.coordinator.fetch('https://data.sec.gov/submissions/CIK0000320193.json', {});
    await assert.rejects(f.coordinator.fetch('https://data.sec.gov/submissions/CIK0000320193.json', {}), { code: 'SEC_REQUEST_BUDGET_EXHAUSTED' });
    assert.equal(budget.used, 2);
  });
  assert.equal(f.sent(), 2); assert.equal(f.released(), 3);
});

test('concurrent requests cannot exceed one allowance and unrelated callers remain unaffected', async () => {
  const f = coordinatorFixture();
  const outcomes = await runWithSecRequestBudget(3, async () => Promise.allSettled(Array.from({ length: 12 }, () => f.coordinator.fetch('https://data.sec.gov/test', {}))));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 3);
  assert.equal(f.sent(), 3);
  await f.coordinator.fetch('https://data.sec.gov/test', {});
  assert.equal(f.sent(), 4);
});

test('nested source-free work cannot bypass or consume its parent allowance', async () => {
  await runWithSecRequestBudget(2, async parent => {
    assert.equal(takeSecRequestBudget(), true);
    await runWithSecRequestBudget(0, async child => { assert.equal(takeSecRequestBudget(), false); assert.equal(child.used, 0); });
    assert.equal(parent.used, 1);
    await runWithSecRequestBudget(4, async child => {
      assert.equal(takeSecRequestBudget(), true); assert.equal(takeSecRequestBudget(), false); assert.equal(child.used, 1);
    });
    assert.equal(parent.used, 2);
  });
});

test('each HTTP retry consumes an actual request and exhaustion is not retried', async () => {
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => { sends++; return new Response('{}', { status: 503, headers: { 'retry-after': '0' } }); };
  try {
    await runWithSecRequestBudget(2, async budget => {
      await assert.rejects(secFetch('https://www.sec.gov/test', { retries: 4 }), { code: 'SEC_REQUEST_BUDGET_EXHAUSTED' });
      assert.equal(budget.used, 2);
    });
    assert.equal(sends, 2);
  } finally { globalThis.fetch = originalFetch; }
});
