import test from 'node:test';
import assert from 'node:assert/strict';
import { maintainProviderRetirement, summarizeProviderRetirementState } from '../src/utils/providerRetirementMaintenance.js';
import { PROVIDER_RETIREMENT_VERSION, PROVIDER_RETIREMENT_PLAN_ID } from '../src/utils/providerRetirement.js';
import { buildUniverseSnapshot, UNIVERSE_METRICS } from '../src/utils/marketUniverse.js';

const START = Date.parse('2026-09-12T12:00:00.000Z');
const CHECKPOINT = `warm:${PROVIDER_RETIREMENT_VERSION}:CHECKPOINT`;
const LEASE = `warm:lease:${PROVIDER_RETIREMENT_VERSION}:RUN`;
const RETIRED = 'warm:stock-raw-yahoo:';

function replacement(basis) {
  const companies = Array.from({ length: 8 }, (_, index) => {
    const cik = String(index + 1), accession = `${cik.padStart(10, '0')}-26-000001`;
    const current = Object.fromEntries(UNIVERSE_METRICS.map(({ key }, metric) => [key, index + metric + 2]));
    const prior = Object.fromEntries(UNIVERSE_METRICS.map(({ key }, metric) => [key, index + metric + 1]));
    const comparison = { pointInTime: true, gapDays: 365,
      current: { metrics: current, filed: '2026-08-01', end: '2026-06-30', accession, factorSourceAccessions: [accession] },
      prior: { metrics: prior, filed: '2025-08-01', end: '2025-06-30', factorSourceAccessions: [`${cik.padStart(10, '0')}-25-000001`] } };
    return { ticker: `T${index}`, cik, name: `Issuer ${index}`, sic: '1000', cohorts: ['test-group'],
      checkedAt: '2026-09-12T08:00:00.000Z', factsRetrievedAt: '2026-09-12T08:00:00.000Z', filingComparisons: { ttm: comparison, annual: comparison } };
  });
  return buildUniverseSnapshot({ generatedAt: '2026-09-12T08:00:00.000Z', requested: 8, companies,
    groups: [{ id: 'test-group', label: 'Test group' }], coverage: { membership_id: 'test', duplicate_share_classes: 0, grouping: 'Test groups.' } },
  {}, { basis, now: new Date('2026-09-12T09:00:00.000Z') });
}

function harness() {
  const h = { time: START, control: { mode: 'migrate', modeChangedAt: new Date(START - 600_000).toISOString(), state: { counters: { removed: 1 } } },
    keys: new Map(), calls: [], deleted: [], cacheCalls: [], hook: null, scan: null, snapshots: true };
  const transport = { command: async (args, options) => {
    h.calls.push({ args: structuredClone(args), options });
    await h.hook?.(args, options);
    if (h.time >= options.deadline) throw Object.assign(new Error('bounded'), { code: 'maintenance_deadline' });
    if (args[0] === 'GET') return h.keys.get(args[1]) ?? null;
    if (args[0] === 'SET') {
      assert.deepEqual(args.slice(3), ['NX', 'PX', 360_000]);
      if (h.keys.has(args[1])) return null;
      h.keys.set(args[1], args[2]); return 'OK';
    }
    if (args[0] === 'SCAN') {
      const prefix = args[3].slice(0, -1);
      return h.scan ? h.scan(args) : ['0', [...h.keys.keys()].filter(key => key.startsWith(prefix))];
    }
    assert.equal(args[0], 'EVAL');
    const [, script, keyCount] = args, keys = args.slice(3, 3 + keyCount), argv = args.slice(3 + keyCount);
    if (script.includes('local prefixes')) {
      if (h.keys.get(LEASE) !== argv[0]) return -1;
      let removed = 0;
      for (const key of keys.slice(1)) if (h.keys.delete(key)) { h.deleted.push(key); removed++; }
      return removed;
    }
    if (script.includes("redis.call('SET'")) {
      if (h.keys.get(LEASE) !== argv[0]) return 0;
      assert.equal(keys[1], CHECKPOINT); assert.equal(argv[2], 180 * 86400);
      h.keys.set(keys[1], argv[1]); return 1;
    }
    if (h.keys.get(LEASE) !== argv[0]) return 0;
    h.keys.delete(LEASE); return 1;
  } };
  h.injected = { now: () => h.time, transport,
    readControl: async () => structuredClone(h.control),
    cacheGet: async (type, id, options) => {
      h.cacheCalls.push({ type, id, options });
      return h.snapshots ? { payload: replacement(id) } : null;
    } };
  h.run = options => maintainProviderRetirement(options || {}, h.injected);
  h.checkpoint = () => JSON.parse(h.keys.get(CHECKPOINT));
  h.arm = async () => { const result = await h.run(); assert.equal(result.status, 'progress'); h.time += 360_000; };
  return h;
}

test('global gates prevent every Redis operation until mode, drain and freed-space proofs pass', async () => {
  for (const edit of [
    h => { h.control.mode = 'inventory'; },
    h => { h.control.mode = 'steady'; },
    h => { h.control.modeChangedAt = new Date(START - 599_999).toISOString(); },
    h => { h.control.modeChangedAt = new Date(START + 60_000).toISOString(); },
    h => { h.control.modeChangedAt = 'invalid'; },
    h => { h.control.state.counters.removed = 0; },
    h => { h.control.state.counters.removed = '1'; },
    h => { h.control.state = {}; },
  ]) {
    const h = harness(); edit(h);
    assert.equal((await h.run()).status, 'blocked');
    assert.deepEqual(h.calls, []); assert.deepEqual(h.cacheCalls, []);
  }
});

test('existing readiness checkpoint and independent six-minute writer grace are preserved', async () => {
  const h = harness(); h.keys.set(`${RETIRED}AAPL`, 'legacy');
  const state = await h.run();
  assert.equal(state.status, 'progress'); assert.equal(state.phase, 'delete');
  assert.equal(Date.parse(state.deletionNotBefore), START + 360_000);
  assert.equal(h.checkpoint().plan_id, PROVIDER_RETIREMENT_PLAN_ID);
  assert.equal(h.cacheCalls.length, 2); assert.deepEqual(h.deleted, []); assert.equal(h.keys.has(LEASE), false);
  h.time += 359_999;
  await h.run(); assert.deepEqual(h.deleted, []); assert.equal(h.cacheCalls.length, 2);
  for (const { options } of h.cacheCalls) assert.equal(options.deadline, START + 18_000);
});

test('missing or stale Supabase replacement data cannot authorize initial or resumed deletion', async () => {
  const missing = harness(); missing.snapshots = false;
  assert.equal((await missing.run()).code, 'retirement_replacement_unready');
  assert.equal(missing.keys.has(CHECKPOINT), false); assert.equal(missing.keys.has(LEASE), false);
  const resumed = harness(); await resumed.arm(); resumed.snapshots = false;
  resumed.keys.set(`${RETIRED}MSFT`, 'legacy');
  assert.equal((await resumed.run()).code, 'retirement_replacement_unready');
  assert.deepEqual(resumed.deleted, []); assert.equal(resumed.keys.has(`${RETIRED}MSFT`), true);
});

test('SCAN COUNT overflow restarts the prefix and eventually processes every tail key', async () => {
  const h = harness(); await h.arm();
  for (let i = 0; i < 375; i++) h.keys.set(`${RETIRED}T${i}`, 'retired');
  for (const key of ['warm:lease:sec-source:RUN', 'warm:generation:research:ABC', 'warm:companyfacts:123', 'rl:sec:IP', 'popular_tickers']) h.keys.set(key, 'preserved');
  const first = await h.run();
  assert.equal(first.removed, 200); assert.equal(h.checkpoint().cursor, '0');
  assert.equal(h.deleted.length, 200);
  const second = await h.run();
  assert.equal(second.removed, 375); assert.equal(second.phase, 'verify'); assert.equal(h.deleted.length, 375);
  for (const key of ['warm:lease:sec-source:RUN', 'warm:generation:research:ABC', 'warm:companyfacts:123', 'rl:sec:IP', 'popular_tickers']) assert.equal(h.keys.has(key), true);
  for (const call of h.calls.filter(({ args }) => args[0] === 'EVAL' && args[1].includes('local prefixes'))) assert.ok(call.args[2] <= 101);
  const delayed = await h.run(); assert.equal(delayed.complete, false);
  h.time += 15_000;
  assert.equal((await h.run()).complete, true);
  const before = h.calls.length; await h.run();
  assert.deepEqual(h.calls.slice(before).map(({ args }) => args[0]), ['GET']);
});

test('deadline after a saved page checkpoints progress and resumes from the recorded cursor', async () => {
  const h = harness(); await h.arm(); h.keys.set(`${RETIRED}ONE`, 'retired'); h.keys.set(`${RETIRED}TWO`, 'retired');
  const started = h.time;
  h.scan = args => args[1] === '0' ? ['91', [`${RETIRED}ONE`]] : ['0', [`${RETIRED}TWO`]];
  h.hook = args => { if (args[0] === 'SCAN' && args[1] === '91') h.time = started + 18_001; };
  const stopped = await h.run();
  assert.equal(stopped.status, 'deferred'); assert.equal(stopped.code, 'maintenance_deadline');
  assert.equal(stopped.removed, 1); assert.equal(h.checkpoint().cursor, '91'); assert.equal(h.keys.has(LEASE), false);
  const before = h.calls.length; h.time += 1; h.hook = null;
  h.scan = args => ['0', [...h.keys.keys()].filter(key => key.startsWith(args[3].slice(0, -1)))];
  await h.run();
  assert.equal(h.calls.slice(before).find(({ args }) => args[0] === 'SCAN').args[1], '91');
  assert.deepEqual(h.deleted, [`${RETIRED}ONE`, `${RETIRED}TWO`]);
});

test('deadline immediately after SCAN preserves its uncommitted page for the next invocation', async () => {
  const h = harness(); await h.arm(); h.keys.set(`${RETIRED}AAPL`, 'retired');
  const started = h.time;
  h.scan = () => { h.time = started + 18_001; return ['12', [`${RETIRED}AAPL`]]; };
  const result = await h.run();
  assert.equal(result.code, 'maintenance_deadline'); assert.equal(h.checkpoint().cursor, '0');
  assert.deepEqual(h.deleted, []); assert.equal(h.keys.has(LEASE), false);
});

test('lost lease blocks deletes and cannot overwrite a newer checkpoint or release another owner', async () => {
  const h = harness(); await h.arm(); h.keys.set(`${RETIRED}AAPL`, 'retired');
  const original = h.keys.get(CHECKPOINT);
  h.hook = args => { if (args[0] === 'EVAL' && args[1].includes('local prefixes')) h.keys.set(LEASE, 'new-owner'); };
  const result = await h.run();
  assert.equal(result.code, 'retirement_lease_lost'); assert.deepEqual(h.deleted, []);
  assert.equal(h.keys.get(CHECKPOINT), original); assert.equal(h.keys.get(LEASE), 'new-owner');
});

test('a checkpoint write that loses its lease fails closed before any deletion', async () => {
  const h = harness();
  h.hook = args => { if (args[0] === 'EVAL' && args[1].includes("redis.call('SET'")) h.keys.set(LEASE, 'new-owner'); };
  assert.equal((await h.run()).code, 'retirement_lease_lost');
  assert.equal(h.keys.has(CHECKPOINT), false); assert.deepEqual(h.deleted, []); assert.equal(h.keys.get(LEASE), 'new-owner');
});

test('malformed or foreign SCAN responses never become deletion arguments', async () => {
  for (const page of [['0', ['warm:companyfacts:123']], ['bad-cursor', []], ['0', [null]], ['0', [`${RETIRED}${'x'.repeat(1200)}`]]]) {
    const h = harness(); await h.arm(); h.scan = () => page;
    assert.equal((await h.run()).code, 'retirement_response'); assert.deepEqual(h.deleted, []);
  }
});

test('provider errors stay safe and blocked lease writes do not cause retry or unscoped cleanup', async () => {
  const h = harness();
  h.hook = args => { if (args[0] === 'SET') throw Object.assign(new Error('credential-bearing provider body'), { code: 'redis_storage_limit' }); };
  const result = await h.run();
  assert.equal(result.code, 'redis_storage_limit'); assert.equal(h.calls.filter(({ args }) => args[0] === 'SET').length, 1);
  assert.ok(!JSON.stringify(result).includes('credential')); assert.deepEqual(h.deleted, []);
});

test('busy coordination and preview deployments are read-only', async () => {
  const h = harness(); h.keys.set(LEASE, 'other-owner');
  assert.equal((await h.run()).code, 'retirement_lease_busy'); assert.equal(h.keys.get(LEASE), 'other-owner');
  assert.deepEqual(h.deleted, []);
  const original = process.env.VERCEL_ENV; process.env.VERCEL_ENV = 'preview';
  try {
    const preview = harness(); assert.equal((await preview.run()).code, 'retirement_environment'); assert.deepEqual(preview.calls, []);
  } finally { if (original === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = original; }
});

test('execution deadline is clamped to 20 seconds with a two-second checkpoint and release reserve', async () => {
  const h = harness(); await h.run({ deadline: START + 999_000 });
  for (const { args, options } of h.calls) assert.equal(options.deadline,
    args[0] === 'EVAL' ? START + 20_000 : START + 18_000);
  const limited = harness(); await limited.run({ deadline: START + 10_000 });
  for (const { args, options } of limited.calls) assert.equal(options.deadline,
    args[0] === 'EVAL' ? START + 10_000 : START + 8000);
  const expired = harness(); assert.equal((await expired.run({ deadline: START + 1000 })).code, 'maintenance_deadline');
  assert.deepEqual(expired.calls, []);
});

test('status exposes aggregates only and never returns checkpoint cursor, namespace or lease data', () => {
  const state = { version: PROVIDER_RETIREMENT_VERSION, plan_id: PROVIDER_RETIREMENT_PLAN_ID,
    phase: 'delete', target_index: 2, removed: 4, scanned: 5, complete: false,
    cursor: 'sensitive', ready_proof: { namespace: 'private' }, token: 'secret', updated_at: new Date(START).toISOString() };
  const summary = summarizeProviderRetirementState(state);
  assert.equal(summary.removed, 4); assert.equal(summary.targetIndex, 2);
  assert.ok(!/sensitive|private|secret/.test(JSON.stringify(summary)));
  assert.equal(summarizeProviderRetirementState({}), null);
});
