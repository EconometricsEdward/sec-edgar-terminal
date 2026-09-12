import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_RETIREMENT_PLAN_ID, PROVIDER_RETIREMENT_VERSION, RETIRED_CACHE_PREFIXES, runProviderRetirementStep } from '../src/utils/providerRetirement.js';

const START = Date.parse('2026-09-12T12:00:00.000Z');

function replacement(basis) {
  return {
    schema_version: 'edgar.factor-universe.v2', methodology_version: 'fundamental-universe-2.0.0', basis,
    generated_at: '2026-09-12T09:00:00.000Z', sec_snapshot_at: '2026-09-12T08:00:00.000Z',
    status: 'ready', sec_stale: false,
    rows: Array.from({ length: 8 }, (_, index) => ({ ticker: `T${index}` })), scopes: { all: { companies: 8 } },
    universe: { issuers: 8, issuer_coverage: 1 },
  };
}

function harness({ checkpoint = null, snapshots = true, lease = 'owned', failTarget = null, failSet = false } = {}) {
  const values = new Map(checkpoint ? [[`${PROVIDER_RETIREMENT_VERSION}/checkpoint`, checkpoint]] : []);
  const seen = new Map();
  const calls = { prefixes: [], exact: [], releases: [], acquires: [], snapshots: 0, sets: 0 };
  const operations = {
    enabled: () => true,
    acquire: async (...args) => { calls.acquires.push(args); return lease; },
    release: async (...args) => { calls.releases.push(args); return true; },
    get: async (type, id) => values.get(`${type}/${id}`) ?? null,
    set: async (type, id, value) => { calls.sets += 1; if (failSet) return false; values.set(`${type}/${id}`, structuredClone(value)); return true; },
    readSnapshot: async (_type, id) => { calls.snapshots += 1; return snapshots ? replacement(id) : null; },
    deleteWarmPrefix: async prefix => {
      calls.prefixes.push(['warm', prefix]);
      if (prefix === failTarget) return null;
      const count = seen.get(`warm:${prefix}`) || 0; seen.set(`warm:${prefix}`, count + 1);
      const removed = count === 0 && prefix.endsWith('v1') ? 1 : 0;
      return { cursor: '0', matched: removed, removed, complete: true };
    },
    deleteRawPrefix: async prefix => { calls.prefixes.push(['raw', prefix]); return { cursor: '0', matched: 0, removed: 0, complete: true }; },
    deleteWarmMany: async (type, ids) => { calls.exact.push(['warm', type, [...ids]]); return 0; },
    deleteRawMany: async ids => { calls.exact.push(['raw', [...ids]]); return 0; },
  };
  return { operations, calls, values };
}

test('retirement persists a readiness proof and quiescence barrier before any deletion', async () => {
  const blocked = harness({ snapshots: false });
  await assert.rejects(runProviderRetirementStep({ operations: blocked.operations, now: START }), error => error.status === 503 && /Both SEC-only/.test(error.message));
  assert.deepEqual(blocked.calls.prefixes, []); assert.equal(blocked.calls.releases.length, 1);
  const failedCheckpoint = harness({ failSet: true });
  await assert.rejects(runProviderRetirementStep({ operations: failedCheckpoint.operations, now: START }), /readiness checkpoint/);
  assert.deepEqual(failedCheckpoint.calls.prefixes, []);
  const active = harness();
  const gated = await runProviderRetirementStep({ operations: active.operations, now: START });
  assert.equal(gated.phase, 'delete'); assert.equal(gated.complete, false); assert.match(gated.ready_proof.namespace, /^edgar\.fundamental-universe\.v2:/);
  assert.equal(Date.parse(gated.deletion_not_before) - START, 360_000); assert.deepEqual(active.calls.prefixes, []);
  const waiting = await runProviderRetirementStep({ operations: active.operations, now: START + 359_999 });
  assert.equal(waiting.complete, false); assert.deepEqual(active.calls.prefixes, []); assert.equal(active.calls.snapshots, 2, 'readiness is a one-time persisted gate');
  assert.equal(active.calls.acquires[0][2], 360_000);
});

test('bounded deletion, delayed clean verification and repeated completion are idempotent', async () => {
  const { operations, calls } = harness();
  await runProviderRetirementStep({ operations, now: START });
  const deleted = await runProviderRetirementStep({ operations, now: START + 360_000 });
  assert.equal(deleted.phase, 'verify'); assert.equal(deleted.complete, false); assert.equal(deleted.exact_cleaned, true);
  assert.deepEqual(calls.prefixes.map(([, prefix]) => prefix), [...RETIRED_CACHE_PREFIXES, 'views:']);
  assert.ok(!calls.exact.flat(3).includes('membership'));
  const waiting = await runProviderRetirementStep({ operations, now: START + 374_999 });
  assert.equal(waiting.complete, false); assert.equal(calls.prefixes.length, RETIRED_CACHE_PREFIXES.length + 1);
  const verified = await runProviderRetirementStep({ operations, now: START + 375_000 });
  assert.equal(verified.complete, true); assert.equal(calls.prefixes.length, 2 * (RETIRED_CACHE_PREFIXES.length + 1));
  const afterComplete = await runProviderRetirementStep({ operations, now: START + 400_000 });
  assert.equal(afterComplete.complete, true); assert.equal(calls.prefixes.length, 2 * (RETIRED_CACHE_PREFIXES.length + 1));
});

test('malformed and impossible current-plan checkpoints cannot suppress cleanup', async () => {
  for (const checkpoint of [
    { version: PROVIDER_RETIREMENT_VERSION, plan_id: PROVIDER_RETIREMENT_PLAN_ID, phase: 'delete', target_index: 0, cursor: '0', removed: 0, scanned: 0, exact_cleaned: false, complete: true },
    { version: PROVIDER_RETIREMENT_VERSION, plan_id: PROVIDER_RETIREMENT_PLAN_ID, phase: 'verify', target_index: 0, cursor: '0', removed: 0, scanned: 0, exact_cleaned: false, complete: true },
    { version: PROVIDER_RETIREMENT_VERSION, plan_id: 'old-plan', phase: 'verify', target_index: 99, cursor: '0', removed: 99, scanned: 99, complete: true },
  ]) {
    const active = harness({ checkpoint });
    const state = await runProviderRetirementStep({ operations: active.operations, now: START });
    assert.equal(state.plan_id, PROVIDER_RETIREMENT_PLAN_ID); assert.equal(state.complete, false); assert.equal(active.calls.snapshots, 2); assert.deepEqual(active.calls.prefixes, []);
  }
  const locked = harness({ lease: null });
  const skipped = await runProviderRetirementStep({ operations: locked.operations, now: START });
  assert.match(skipped.skipped, /already running|coordination/); assert.equal(locked.calls.snapshots, 0);
});

test('migration errors release the lease and invalid work bounds are rejected', async () => {
  const { operations, calls } = harness({ failTarget: RETIRED_CACHE_PREFIXES[0] });
  await runProviderRetirementStep({ operations, now: START });
  await assert.rejects(runProviderRetirementStep({ operations, now: START + 360_000 }), /could not scan/);
  assert.equal(calls.releases.length, 2);
  for (const maxKeys of [0, 2501, 1.5]) await assert.rejects(runProviderRetirementStep({ operations, maxKeys }), error => error.status === 400);
});

test('preview cleanup is forbidden before cache operations begin', async () => {
  const prior = process.env.VERCEL_ENV; process.env.VERCEL_ENV = 'preview';
  const { operations, calls } = harness();
  try { await assert.rejects(runProviderRetirementStep({ operations, now: START }), error => error.status === 403); }
  finally { if (prior == null) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prior; }
  assert.deepEqual(calls.acquires, []); assert.deepEqual(calls.prefixes, []);
});
