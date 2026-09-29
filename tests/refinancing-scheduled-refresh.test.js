import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './fixtures/refinancing-market-summaries.json' with { type: 'json' };
import { PreparedSecUnavailableError, readPreparedSecDocument } from '../src/utils/secDocumentStore.js';
import { loadScheduledQuantDocument, refreshQuantBatch, publishQuantRefinancingUpdates } from '../src/utils/quantCoverageServer.js';
import { buildRefinancingWall, buildRefinancingCompany, mergeRefinancingWall, isRefinancingWall } from '../src/utils/refinancing/projection.js';
import { advanceRefinancingWall, publishRefinancingWall } from '../src/utils/refinancing/server.js';

const clock = Date.parse('2026-09-29T02:00:00.000Z'), iso = delta => new Date(clock + delta).toISOString();
const path = '/submissions/CIK0000320193.json';
const payload = { cik: 320193, filings: { recent: {} } };
const archive = { payload, metadata: { fetchedAt: iso(-4 * 86400000), revalidatedAt: iso(-3 * 86400000), expiresAt: iso(-2 * 86400000) } };
const fresh = { ...archive, metadata: { ...archive.metadata, revalidatedAt: iso(0), expiresAt: iso(86400000) } };
const sourceRead = extra => readPreparedSecDocument(path, { mode: 'supabase', now: clock, loadRegistry: async () => {}, ...extra });
const wall = (companies = fixtures.companies, generatedAt = iso(0)) => buildRefinancingWall({ companies, generatedAt, requested: companies.length });
const updated = (index, delta = 60000) => ({ ...fixtures.companies[index], checkedAt: iso(delta), factsRetrievedAt: iso(delta) });

test('prepared reads distinguish confirmed missing and expired sources from storage, registry and identity failures', async () => {
  for (const [read, state] of [[async () => null, 'missing'], [async () => archive, 'expired'],
    [async () => { throw new Error('storage down'); }, 'storage'],
    [async () => ({ ...archive, payload: { ...payload, cik: 9 } }), 'invalid'],
    [async () => ({ ...archive, metadata: { ...archive.metadata, fetchedAt: 'invalid' } }), 'invalid']]) {
    await assert.rejects(sourceRead({ read, allowStale: false }), error => error.sourceState === state);
  }
  let request;
  await assert.rejects(sourceRead({ requireRegistry: true, read: async () => { throw new Error('must not read'); },
    loadRegistry: async options => { request = options; throw new Error('registry unavailable'); } }), /registry unavailable/);
  assert.deepEqual(request, { required: true });
});

test('only scheduled ingestion repairs missing or expired archives through the fenced source refresher', async () => {
  for (const sourceState of ['missing', 'expired']) {
    const calls = [];
    const result = await loadScheduledQuantDocument(path, undefined, {
      prepared: async (_path, options) => { calls.push(['prepared', options]); throw new PreparedSecUnavailableError(undefined, { sourceState }); },
      refresh: async (...args) => { calls.push(['refresh', ...args]); return { envelope: fresh }; },
      fetchSec: async () => { throw new Error('unfenced source bypass'); },
    });
    assert.equal(result, fresh);
    assert.deepEqual(calls, [['prepared', { allowStale: false, requireRegistry: true }],
      ['refresh', path, { signal: undefined, minRecheckAgeMs: 20 * 3600000 }]]);
  }
});

test('storage, corrupt identity and registry outages never fall through to SEC; busy refreshes never retry directly', async () => {
  for (const prepared of [
    async () => { throw new PreparedSecUnavailableError(undefined, { sourceState: 'storage' }); },
    async () => { throw new PreparedSecUnavailableError(undefined, { sourceState: 'invalid' }); },
    async (resource, options) => readPreparedSecDocument(resource, { ...options, mode: 'supabase', now: clock,
      loadRegistry: async ({ required }) => { assert.equal(required, true); throw new Error('registry unavailable'); } }),
    async (resource, options) => readPreparedSecDocument(resource, { ...options, mode: 'supabase', now: clock,
      loadRegistry: async () => {}, read: async () => ({ ...archive, payload: { ...payload, cik: 9 } }) }),
  ]) {
    let refills = 0;
    await assert.rejects(loadScheduledQuantDocument(path, undefined, { prepared,
      refresh: async () => { refills++; }, fetchSec: async () => { refills++; } }));
    assert.equal(refills, 0);
  }
  let refreshes = 0, direct = 0;
  await assert.rejects(loadScheduledQuantDocument(path, undefined, {
    prepared: async () => { throw new PreparedSecUnavailableError(undefined, { sourceState: 'expired' }); },
    refresh: async () => { refreshes++; return { status: 'busy' }; }, fetchSec: async () => { direct++; },
  }), error => error.sourceState === 'busy');
  assert.equal(refreshes, 1); assert.equal(direct, 0);
});

test('partial merges preserve membership and untouched source clocks, rejecting old or future issuer evidence', () => {
  const previous = wall(fixtures.companies.map(company => ({ ...company, refinancing: null })));
  const update = buildRefinancingCompany(updated(0));
  const next = mergeRefinancingWall(previous, [update, { ...update, cik: '9999999999' }], iso(60000));
  assert.equal(isRefinancingWall(next), true);
  assert.equal(next.coverage.checkedCompanies, 1);
  assert.equal(next.sourceSnapshotAt, previous.sourceSnapshotAt);
  assert.equal(next.membershipId, previous.membershipId);
  assert.equal(next.companies.length, previous.companies.length);
  assert.equal(next.companies.find(row => row.cik === fixtures.companies[1].cik).checkedAt, iso(0));
  assert.equal(mergeRefinancingWall(next, [{ ...update, checkedAt: iso(0), factsRetrievedAt: iso(0) }], iso(120000)), next);
  assert.equal(mergeRefinancingWall(next, [{ ...update, checkedAt: iso(10000000), factsRetrievedAt: iso(10000000) }], iso(120000)), next);
  assert.equal(mergeRefinancingWall(next, [{ ...update, profile: { ...update.profile, cik: '9999999999' } }], iso(120000)), next);
});

test('incremental publication reads after its lease and simultaneous shards cannot lose another shard update', async () => {
  let current = wall(fixtures.companies.map(company => ({ ...company, refinancing: null }))), owned = false;
  let count = 0; const order = [];
  const deps = { mode: 'supabase', now: () => clock + 120000,
    begin: async () => { order.push('begin'); if (owned) return null; owned = true; return { owner: 'lease', generation: ++count }; },
    read: async () => { assert.equal(owned, true); order.push('read'); return { payload: current }; },
    release: async () => { order.push('release'); owned = false; },
    publish: async value => { assert.equal(owned, true); order.push('publish'); current = value.payload; owned = false; },
  };
  const results = await Promise.all([advanceRefinancingWall([updated(0)], deps), advanceRefinancingWall([updated(1)], deps)]);
  assert.equal(results.filter(result => result.status === 'published').length, 1);
  assert.equal(results.filter(result => result.reason === 'busy').length, 1);
  assert.equal(order.filter(step => step === 'read').length, 1);
  await advanceRefinancingWall([updated(1)], deps);
  assert.equal(current.coverage.checkedCompanies, 2);
  assert.equal(current.sourceSnapshotAt, iso(0));
  assert.equal(current.generatedAt, iso(120000));
});

test('newer full atlas generation preserves newer incremental issuer evidence and hashes changed data', async () => {
  const pending = fixtures.companies.map(company => ({ ...company, refinancing: null }));
  const retained = mergeRefinancingWall(wall(pending), [buildRefinancingCompany(updated(0))], iso(60000));
  const writes = [];
  const deps = { mode: 'supabase', now: () => clock + 120000, begin: async () => ({ owner: 'lease', generation: 1 }),
    read: async () => ({ payload: retained }), release: async () => {}, publish: async value => writes.push(value) };
  const result = await publishRefinancingWall({ companies: pending, requested: pending.length, generatedAt: iso(120000) }, deps);
  assert.equal(result.coverage.checkedCompanies, 1);
  assert.equal(result.companies.find(row => row.cik === fixtures.companies[0].cik).checkedAt, iso(60000));
  assert.match(writes[0].identityInputs.contentHash, /^[a-f0-9]{64}$/);
  const unchanged = await publishRefinancingWall({ companies: pending, requested: pending.length, generatedAt: iso(120000) },
    { ...deps, read: async () => ({ payload: result }) });
  assert.equal(unchanged.coverage.checkedCompanies, 1);
  assert.equal(writes.length, 1, 'identical full snapshots do not publish an extra generation');
});

test('optional publication failure does not fail successful checkpoints or create work beyond its deadline', async () => {
  const failure = await publishQuantRefinancingUpdates([updated(0)], { publish: async () => { throw new Error('snapshot unavailable'); } });
  assert.equal(failure.status, 'deferred');
  let reads = 0;
  const skipped = await advanceRefinancingWall([updated(0)], { mode: 'supabase', now: () => clock,
    deadline: clock + 10000, begin: async () => { reads++; } });
  assert.equal(skipped.reason, 'deadline'); assert.equal(reads, 0);
  await assert.rejects(advanceRefinancingWall(Array(501).fill(updated(0))), /Unbounded/);
});

test('a saturated Quant shard reserves time for its single prepared publication and checkpoints successful work', async () => {
  let elapsed = 0, sourceCalls = 0, publicationBudget = null, stored = null;
  const rows = Array.from({ length: 4 }, (_, index) => ({ cik: String((index + 1) * 16).padStart(10, '0'),
    ticker: `T${index}`, sector: 'Information Technology', fund: 'IVV' }));
  const result = await refreshQuantBatch(0, { deadline: clock + 100000 }, {
    enabled: () => true, now: () => clock + elapsed, acquire: async () => 'lease', release: async () => {},
    membershipRead: async () => ({ rows }), checkpoints: async ids => ids.map(() => null), readMany: async (_type, ids) => ids.map(() => null),
    refresh: async entry => { sourceCalls++; elapsed += 30000; return { company: { ...fixtures.companies[0], ...entry }, checkedAt: iso(elapsed), factsRetrievedAt: iso(elapsed) }; },
    publishUpdates: async (updates, options) => { publicationBudget = options.deadline - (clock + elapsed);
      assert.equal(updates.length, 2); return publishQuantRefinancingUpdates(updates, { publish: async () => { throw new Error('optional outage'); } }); },
    write: async (_type, _id, data) => { stored = data; return true; },
  });
  assert.equal(sourceCalls, 2); assert.equal(result.checked, 2); assert.equal(result.failed, 0);
  assert.equal(result.skipped, 2); assert.equal(publicationBudget, 40000);
  assert.equal(stored.refinancing.status, 'deferred');
});
