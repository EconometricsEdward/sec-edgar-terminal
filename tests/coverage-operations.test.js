import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageCounterDelta, summarizeCoverageOperations } from '../src/utils/coverageOperations.js';

const now = Date.parse('2026-09-13T15:10:00Z');
const database = { statsResetAt: '2026-09-01T00:00:00Z', transactionsCommitted: 100, transactionsRolledBack: 5,
  blocksRead: 10, blocksHit: 90, temporaryBytes: 100, temporaryFiles: 2, deadlocks: 0, connections: 7 };
const sample = (observedAt, db = database) => ({ observedAt, database: db });
const operations = () => ({ latest: {
  schema: 1, observedAt: '2026-09-13T15:07:00Z',
  coverageGroups: [{ prepared: 501, fresh: 501, stale: 0 }],
  maintenance: { membershipId: 'current-fixture', groups: [{ prepared: 501, fresh: 501, stale: 0, missing: 0 }] },
  work: { todayJobs: 32, pending: 0, deadJobs: 0 },
  cycles: [{ cycle: '2026-09-13', jobs: 32, done: 32, completed_at: '2026-09-13T08:28:00Z', failures: 0, dead: 0, superseded: 0 }],
  metricAvailability: { available: 110000, unavailable: 38000 },
}, history: [] });

test('counter deltas distinguish an actual interval from cumulative or reset values', () => {
  const before = sample('2026-09-13T14:07:00Z');
  const after = sample('2026-09-13T15:07:00Z', { ...database, transactionsCommitted: 110, blocksRead: 12, blocksHit: 108, temporaryBytes: 500 });
  const delta = coverageCounterDelta(before, after);
  assert.equal(delta.status, 'observed');
  assert.equal(delta.seconds, 3600);
  assert.equal(delta.transactionsCommitted, 10);
  assert.equal(delta.temporaryBytes, 400);
  assert.equal(delta.cacheHitRatio, 0.9);
  for (const invalid of [undefined, before, sample(after.observedAt, { ...after.database, statsResetAt: null }),
    sample(after.observedAt, { ...after.database, statsResetAt: '2026-09-13T14:55:00Z' }),
    sample(after.observedAt, { ...after.database, blocksHit: 5 })]) {
    assert.equal(coverageCounterDelta(before, invalid).status, 'unavailable');
  }
  assert.equal(coverageCounterDelta(before, sample(after.observedAt)).cacheHitRatio, null);
});

test('fresh completed coverage remains healthy when source metrics are unavailable', () => {
  const summary = summarizeCoverageOperations(operations(), { now });
  assert.equal(summary.status, 'healthy');
  assert.equal(summary.metricAvailability.unavailable, 38000);
  assert.equal(summary.refresh.completedCycles, 1);
  assert.equal(summary.coverage.freshnessSeconds, 90000);
  assert.equal(summary.capacity.concurrentVisitors, null);
  assert.equal(summary.billing.monthEgressBytes, null);
  assert.equal(summary.history.latestCounterInterval.status, 'unavailable');
});

test('delayed snapshots, stale publications and long sweeps produce actionable warnings', () => {
  const data = operations();
  data.latest.observedAt = '2026-09-13T13:00:00Z';
  data.latest.maintenance.groups[0] = { prepared: 501, fresh: 499, stale: 2 };
  Object.assign(data.latest.work, { pending: 5, oldestPendingAgeSeconds: 43201, expiredLeases: 1 });
  const summary = summarizeCoverageOperations(data, { now });
  assert.equal(summary.status, 'watch');
  assert.deepEqual(summary.issues.map(issue => issue.code), ['SNAPSHOT_DELAYED', 'STALE_PUBLICATIONS', 'EXPIRED_WORKER_LEASES', 'REFRESH_SWEEP_DELAYED']);
});

test('partial, superseded and incomplete cycles cannot masquerade as full completion', () => {
  const data = operations();
  const complete = data.latest.cycles[0];
  data.latest.cycles = [{ ...complete, failures: 1 }, { ...complete, superseded: 32 }, { ...complete, jobs: 31, done: 31 }];
  data.latest.work.unresolvedDeadJobs = 1;
  data.latest.work.unresolvedIssuerFailures = 1;
  const summary = summarizeCoverageOperations(data, { now });
  assert.equal(summary.status, 'attention');
  assert.equal(summary.refresh.completedCycles, 0);
  assert.deepEqual(summary.issues.map(issue => issue.code), ['DEAD_REFRESH_JOBS', 'ISSUERS_NEED_RETRY']);
});

test('retired inventory and resolved historical failures do not make current maintenance unhealthy', () => {
  const data = operations();
  data.latest.coverageGroups[0] = { prepared: 503, fresh: 501, stale: 2 };
  data.latest.maintenance.retainedIssuerCount = 2;
  Object.assign(data.latest.work, { historicalDeadJobs: 4, historicalIssuerFailures: 3, unresolvedDeadJobs: 0, unresolvedIssuerFailures: 0 });
  data.latest.cycles.push({ cycle: '2026-09-12', jobs: 32, done: 31, failures: 3, dead: 1 });
  const summary = summarizeCoverageOperations(data, { now });
  assert.equal(summary.status, 'healthy');
  assert.equal(summary.inventory.stale, 2);
  assert.equal(summary.coverage.stale, 0);
  assert.equal(summary.coverage.retainedIssuers, 2);
  assert.equal(summary.refresh.historicalDeadJobs, 4);
  assert.equal(summary.refresh.historicalIssuerFailures, 3);
  data.latest.maintenance.groups[0].missing = 1;
  assert.equal(summarizeCoverageOperations(data, { now }).issues[0].code, 'MISSING_MAINTAINED_PUBLICATIONS');
});

test('missing daily cycle uses snapshot date rather than crossing midnight with viewer clock', () => {
  const data = operations();
  data.latest.work.todayJobs = 0;
  data.latest.observedAt = '2026-09-14T00:07:00Z';
  assert.equal(summarizeCoverageOperations(data, { now: Date.parse('2026-09-14T00:25:00Z') }).issues.length, 0);
  data.latest.observedAt = '2026-09-14T01:07:00Z';
  assert.equal(summarizeCoverageOperations(data, { now: Date.parse('2026-09-14T01:10:00Z') }).issues[0].code, 'DAILY_CYCLE_NOT_RECORDED');
  assert.equal(summarizeCoverageOperations(null, { now }).status, 'unknown');
  assert.equal(summarizeCoverageOperations(data, { now }).status, 'unknown');
});

test('history summarizes observed hours without inventing an unobserved full day', () => {
  const data = operations();
  data.history = [sample('2026-09-13T14:07:00Z'), { ...sample('2026-09-13T15:07:00Z', { ...database, connections: 9 }), stale: 2, pending: 3 }];
  const summary = summarizeCoverageOperations(data, { now });
  assert.equal(summary.history.spanSeconds, 3600);
  assert.equal(summary.history.daySamples, 2);
  assert.equal(summary.history.samplesWithStalePublications, 1);
  assert.equal(summary.history.maximumObservedConnections, 9);
});

test('membership warnings respect first-run grace, source date, errors and candidate preparation time', () => {
  const data = operations();
  data.latest.membership = { activeId: 'seed', activeSourceAsOf: '2026-09-08', lastCheckedAt: null,
    nextCheckAt: '2026-09-13T15:00:00Z', lastError: null, errorCount: 0 };
  assert.equal(summarizeCoverageOperations(data, { now }).status, 'healthy', 'a seed check due seven minutes ago is not late');
  Object.assign(data.latest.membership, { activeSourceAsOf: '2026-08-20', nextCheckAt: '2026-09-13T12:00:00Z',
    lastError: 'HOLDINGS_FETCH_FAILED', errorCount: 2, candidateId: 'pending', candidateSince: '2026-09-12T14:00:00Z' });
  const summary = summarizeCoverageOperations(data, { now });
  assert.equal(summary.status, 'watch');
  assert.deepEqual(summary.issues.map(issue => issue.code), ['MEMBERSHIP_CHECK_DELAYED', 'MEMBERSHIP_SOURCE_OLD', 'MEMBERSHIP_CHECK_ERROR', 'MEMBERSHIP_CANDIDATE_DELAYED']);
  assert.equal(summary.membership.lastError, 'HOLDINGS_FETCH_FAILED');
  assert.equal(summary.coverage.missing, 0, 'pending membership preparation is independent of current publication coverage');
});
