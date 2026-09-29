import test from 'node:test';
import assert from 'node:assert/strict';
import { runRefinancingBackfill, loadRefinancingBackfillFacts, validRefinancingBackfillState,
  REFINANCING_BACKFILL_KEY } from '../src/utils/refinancing/backfill.js';
import { advanceRefinancingWall, publishRefinancingWall } from '../src/utils/refinancing/server.js';
import { buildRefinancingWall, buildRefinancingCompany, mergeRefinancingWall, isRefinancingWall } from '../src/utils/refinancing/projection.js';
import { PreparedSecUnavailableError } from '../src/utils/secDocumentStore.js';
import { extractRefinancingProfile } from '../src/utils/refinancing/maturities.js';

const clock = Date.parse('2026-09-29T04:00:00.000Z');
const iso = (offset = 0) => new Date(clock + offset).toISOString();
const facts = (cik, supported = true) => ({ cik: Number(cik), facts: supported ? { 'us-gaap': {
  LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: { units: { USD: [{
    val: 100, end: '2025-12-31', filed: '2026-02-01', accn: '0000000001-26-000001', form: '10-K', fy: 2025, fp: 'FY',
  }] } },
} } : {} });
const company = index => ({ cik: String(index).padStart(10, '0'), ticker: `T${index}`, name: `Issuer ${index}`,
  sic: '3571', checkedAt: iso(), factsRetrievedAt: iso(), refinancing: null });
function harness(count = 5, overrides = {}) {
  const store = { wall: buildRefinancingWall({ companies: Array.from({ length: count }, (_, i) => company(i + 1)),
    requested: count, generatedAt: iso() }), state: null, now: clock, sourceCalls: [], events: [], owned: false };
  const deps = { mode: 'supabase', now: () => store.now,
    read: async (_dataset, key) => { assert.equal(key, REFINANCING_BACKFILL_KEY); store.events.push('state-read'); return store.state ? { payload: store.state } : null; },
    begin: async (_dataset, key, options) => { assert.equal(key, REFINANCING_BACKFILL_KEY); assert.equal(options.leaseSeconds, 300);
      if (store.owned) return null; store.owned = true; store.events.push('claim'); return { owner: 'worker' }; },
    release: async () => { store.owned = false; },
    write: async value => { assert.equal(store.owned, true); assert.equal(validRefinancingBackfillState(value.payload), true);
      store.state = structuredClone(value.payload); store.owned = false; store.events.push('state-write'); },
    wallRead: async () => { store.events.push('wall-read'); return store.wall; },
    loadRegistry: async options => { assert.equal(options.required, true); store.events.push('registry'); },
    admitted: () => false,
    source: async row => { store.sourceCalls.push(row.cik); return { payload: facts(row.cik), origin: 'download',
      metadata: { fetchedAt: iso(-86400000), revalidatedAt: iso(-86400000), expiresAt: iso(3600000) } }; },
    advance: async (rows, options) => { store.events.push('advance'); return advanceRefinancingWall(rows, {
      ...options, mode: 'supabase', now: () => store.now, begin: async () => ({ owner: 'projection' }),
      read: async () => ({ payload: store.wall }), release: async () => {}, publish: async value => { store.wall = value.payload; },
    }); }, ...overrides };
  return { store, deps, run: (options = {}) => runRefinancingBackfill({ deadline: store.now + 240000, ...options }, deps) };
}

test('resumable bounded runs use the exact Market universe, prioritize archives and publish actual progress', async () => {
  const h = harness(8); h.deps.admitted = cik => Number(cik) === 7 || Number(cik) === 8;
  const first = await h.run({ limit: 3 });
  assert.deepEqual(h.store.sourceCalls, ['0000000007', '0000000008', '0000000001']);
  assert.equal(first.admitted, 3); assert.equal(first.pendingCompanies, 5); assert.equal(h.store.state.buffered.length, 0);
  assert.equal(h.store.wall.sourceSnapshotAt, iso());
  const initial = h.store.wall.companies.find(row => row.cik === '0000000007');
  assert.equal(initial.checkedAt, iso(-86400000), 'archived maturity source is independently dated');
  await h.run({ limit: 3 }); await h.run({ limit: 3 });
  assert.equal(h.store.sourceCalls.length, 8); assert.equal(new Set(h.store.sourceCalls).size, 8);
  assert.equal(h.store.wall.coverage.checkedCompanies, 8); assert.equal(isRefinancingWall(h.store.wall), true);
  const events = h.store.events.length;
  const caughtUp = await h.run(); assert.equal(caughtUp.reason, 'not-due');
  assert.deepEqual(h.store.events.slice(events), ['state-read'], 'caught-up worker reads only compact state');
});

test('first-row failures have capped persisted backoff and cannot starve later companies', async () => {
  const h = harness(6); const source = h.deps.source;
  h.deps.source = async row => { if (Number(row.cik) <= 2) { h.store.sourceCalls.push(row.cik); throw Object.assign(new Error('Missing'), { status: 404, code: 'SEC_HTTP_404' }); } return source(row); };
  await h.run({ limit: 2 }); assert.equal(h.store.state.failures['0000000001'].count, 1);
  await h.run({ limit: 2 }); await h.run({ limit: 2 });
  assert.equal(h.store.wall.coverage.checkedCompanies, 4); assert.equal(h.store.sourceCalls.length, 6);
  const retry = await h.run(); assert.equal(retry.reason, 'not-due');
  assert.equal(h.store.sourceCalls.length, 6);
});

test('valid facts with no supported schedule are completed negative results and never repeatedly downloaded', async () => {
  const h = harness(3);
  h.deps.source = async row => { h.store.sourceCalls.push(row.cik); return { payload: facts(row.cik, false), origin: 'download', metadata: { fetchedAt: iso(), revalidatedAt: iso() } }; };
  const result = await h.run(); assert.equal(result.admitted, 3); assert.equal(result.coveredCompanies, 0);
  assert.equal(h.store.wall.coverage.missingScheduleCompanies, 3);
  h.store.now += 7 * 3600000; await h.run(); assert.equal(h.store.sourceCalls.length, 3);
});

test('failed optional publication buffers successes and the next run only flushes, with no source downloads', async () => {
  const h = harness(5); const advance = h.deps.advance;
  h.deps.advance = async () => { throw new Error('Projection storage outage'); };
  const deferred = await h.run({ limit: 3 });
  assert.equal(deferred.status, 'deferred'); assert.equal(deferred.buffered, 3); assert.equal(deferred.admitted, 0);
  assert.equal(h.store.wall.coverage.checkedCompanies, 0);
  h.deps.advance = advance;
  const flushed = await h.run({ limit: 3 });
  assert.equal(flushed.admitted, 3); assert.equal(h.store.sourceCalls.length, 3); assert.equal(h.store.state.buffered.length, 0);
  await h.run(); assert.equal(h.store.wall.coverage.checkedCompanies, 5);
});

test('registry and invalid archive failures stop the batch without authorizing any direct SEC fallback', async () => {
  const h = harness(); h.deps.loadRegistry = async () => { throw Object.assign(new Error('Registry unavailable'), { code: 'SEC_COVERAGE_REGISTRY_UNAVAILABLE' }); };
  const result = await h.run(); assert.equal(result.status, 'deferred'); assert.equal(h.store.sourceCalls.length, 0);
  assert.equal(Date.parse(h.store.state.nextCheckAt), clock + 30 * 60000);
  for (const sourceState of ['storage', 'invalid', 'busy']) {
    let calls = 0;
    await assert.rejects(loadRefinancingBackfillFacts(company(1), {
      prepared: async () => { throw new PreparedSecUnavailableError('Unavailable', { sourceState }); },
      fetchSec: async () => { calls++; }, refresh: async () => { calls++; },
    }), /Unavailable/);
    assert.equal(calls, 0);
  }
});

test('project-wide SEC coordination/cooldown failures stop after only the two in-flight workers', async () => {
  for (const code of ['SEC_RATE_GATE_UNAVAILABLE', 'SEC_RATE_GATE_SATURATED', 'SEC_REQUEST_BUDGET_EXHAUSTED', 'SEC_USER_AGENT_INVALID']) {
    const h = harness(200); h.deps.source = async row => { h.store.sourceCalls.push(row.cik); throw Object.assign(new Error('Stop'), { code }); };
    await h.run(); assert.ok(h.store.sourceCalls.length <= 2, code);
    assert.equal(Date.parse(h.store.state.nextCheckAt), clock + 30 * 60000);
  }
});

test('archive-first source preserves old real clocks, and confirmed missing/expired sources refresh once', async () => {
  const envelope = { payload: facts(1), metadata: { fetchedAt: iso(-86400000), revalidatedAt: iso(-86400000), expiresAt: iso(3600000) } };
  const archived = await loadRefinancingBackfillFacts(company(1), { now: () => clock,
    prepared: async (_path, options) => { assert.equal(options.requireRegistry, true); return envelope; },
    fetchSec: async () => assert.fail('archive must avoid HTTP') });
  assert.equal(archived.metadata.fetchedAt, iso(-86400000)); assert.equal(archived.origin, 'archive');
  for (const sourceState of ['missing', 'expired']) {
    let refreshes = 0;
    await loadRefinancingBackfillFacts(company(1), { now: () => clock,
      prepared: async () => { throw new PreparedSecUnavailableError('Missing', { sourceState }); },
      refresh: async () => { refreshes++; return { envelope }; }, fetchSec: async () => assert.fail('no double fetch') });
    assert.equal(refreshes, 1);
  }
});

test('non-admitted known CIK downloads exactly one bounded companyfacts document without retries or redirects', async () => {
  let calls = 0;
  const result = await loadRefinancingBackfillFacts(company(9), { now: () => clock,
    prepared: async () => null, fetchSec: async (url, options) => {
      calls++; assert.equal(url, 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000000009.json');
      assert.equal(options.retries, 0); assert.equal(options.redirect, 'error'); assert.equal(options.maxBytes, 24 * 1024 * 1024);
      assert.equal(options.timeoutMs, 12000); return Response.json(facts(9));
    } });
  assert.equal(calls, 1); assert.equal(result.origin, 'download'); assert.equal(result.metadata.fetchedAt, iso());
  await assert.rejects(loadRefinancingBackfillFacts(company(9), { prepared: async () => null,
    fetchSec: async () => Response.json(facts(8)) }), /identity/);
  await assert.rejects(loadRefinancingBackfillFacts(company(9), { prepared: async () => null,
    fetchSec: async () => new Response(null, { status: 429 }) }), error => error.global && error.status === 429);
});

test('deadlines reserve publication/state time and source concurrency never exceeds two', async () => {
  const h = harness(200); let active = 0, peak = 0;
  const source = h.deps.source;
  h.deps.source = async row => { active++; peak = Math.max(peak, active); await Promise.resolve();
    const result = await source(row); h.store.now += 45000; active--; return result; };
  const result = await h.run();
  assert.equal(peak, 2); assert.equal(result.attempted, 4); assert.equal(result.admitted, 4);
  assert.equal(h.store.state.buffered.length, 0);
  await assert.rejects(h.run({ limit: 501 }), /Unbounded/);
  const skipped = await h.run({ deadline: h.store.now + 30000 }); assert.equal(skipped.reason, 'deadline');
});

test('a 500-issuer seed is bounded, persists all accepted profiles once, and private state stays compact', async () => {
  const h = harness(600); const result = await h.run({ limit: 500 });
  assert.equal(result.attempted, 500); assert.equal(result.admitted, 500); assert.equal(result.pendingCompanies, 100);
  assert.equal(h.store.events.filter(value => value === 'advance').length, 1);
  assert.equal(h.store.events.filter(value => value === 'state-write').length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(h.store.state)) < 1000);
});

test('initial independently dated archive survives full publication and cannot then be replaced by older evidence', async () => {
  const h = harness(1); await h.run(); const retained = h.store.wall;
  const pendingAtlas = { companies: [company(1)], requested: 1, generatedAt: iso(60000) };
  const published = await publishRefinancingWall(pendingAtlas, { mode: 'supabase', now: () => clock + 60000,
    begin: async () => ({}), read: async () => ({ payload: retained }), release: async () => {}, publish: async () => {} });
  assert.equal(published.coverage.checkedCompanies, 1); assert.equal(published.companies[0].checkedAt, iso(-86400000));
  const old = { ...published.companies[0], checkedAt: iso(-2 * 86400000), factsRetrievedAt: iso(-2 * 86400000) };
  assert.equal(mergeRefinancingWall(published, [old], iso(60000)), published);
});

test('worker lease excludes duplicate source batches, and corrupt private state fails before source work', async () => {
  const h = harness(5); h.store.owned = true;
  assert.equal((await h.run()).reason, 'busy'); assert.equal(h.store.sourceCalls.length, 0);
  h.store.owned = false; h.store.state = { invalid: true };
  await assert.rejects(h.run(), /validation/); assert.equal(h.store.sourceCalls.length, 0);
});

test('buffered results outside source retention are discarded and rechecked rather than published as current', async () => {
  const h = harness(1); const advance = h.deps.advance;
  h.deps.advance = async () => { throw new Error('Temporary outage'); }; await h.run();
  assert.equal(h.store.state.buffered.length, 1);
  h.store.state.buffered[0].refinancingSource.usableUntil = iso(-1);
  h.store.state.buffered[0].refinancingSource.revalidatedAt = iso(-2);
  h.store.state.buffered[0].refinancingSource.fetchedAt = iso(-2);
  h.deps.advance = advance; await h.run(); assert.equal(h.store.sourceCalls.length, 2); assert.equal(h.store.wall.coverage.checkedCompanies, 1);
});

test('no-profile admission still rejects future and wrong-issuer source identities', () => {
  const h = harness(1); const base = company(1);
  const row = buildRefinancingCompany({ ...base, refinancing: extractRefinancingProfile(facts(1), { asOf: '2026-09-29' }) });
  assert.equal(mergeRefinancingWall(h.store.wall, [{ ...row, checkedAt: iso(120000) }], iso()), h.store.wall);
  assert.equal(mergeRefinancingWall(h.store.wall, [{ ...row, profile: { ...row.profile, cik: '0000000002' } }], iso()), h.store.wall);
});

test('500 buffered successes plus 5000 retry entries remain within the single bounded state object', async () => {
  const h = harness(500); h.deps.advance = async () => { throw new Error('Projection outage'); };
  const result = await h.run({ limit: 500 }); assert.equal(result.buffered, 500);
  const state = structuredClone(h.store.state);
  state.failures = Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [String(index + 1).padStart(10, '0'),
    { count: 16, retryAt: iso(86400000), code: 'SEC_HTTP_404' }]));
  assert.equal(validRefinancingBackfillState(state), true);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 2 * 1024 * 1024);
  assert.equal(validRefinancingBackfillState({ ...state, buffered: [...state.buffered, state.buffered[0]] }), false);
  state.failures['0000000001'].count = 17; assert.equal(validRefinancingBackfillState(state), false);
});

test('buffered schedules beyond 550 days are re-extracted after recovery even if source retention remains valid', async () => {
  const h = harness(1); const advance = h.deps.advance;
  h.deps.advance = async () => { throw new Error('Publication unavailable'); }; await h.run();
  const profile = h.store.state.buffered[0].refinancing;
  profile.context[1] = '2024-01-01'; profile.context[2] = '2024-02-01';
  h.deps.advance = advance; await h.run();
  assert.equal(h.store.sourceCalls.length, 2); assert.equal(h.store.wall.coverage.checkedCompanies, 1);
});

test('invalid or future private progress cannot be used to bypass source checks', async () => {
  const h = harness(1); h.deps.advance = async () => { throw new Error('Publication unavailable'); }; await h.run();
  h.store.state.buffered[0].refinancingSource.revalidatedAt = iso(120000);
  await assert.rejects(h.run(), /validation/); assert.equal(h.store.sourceCalls.length, 1);
});

test('successful projection publication survives a later progress-write failure without downloading again', async () => {
  const h = harness(3); const write = h.deps.write;
  h.deps.write = async () => { throw new Error('Progress unavailable'); };
  await assert.rejects(h.run(), /Progress unavailable/);
  assert.equal(h.store.wall.coverage.checkedCompanies, 3);
  h.deps.write = write; await h.run(); assert.equal(h.store.sourceCalls.length, 3);
});
