/** Summaries are operational evidence, never a billing or traffic-capacity claim. */
const HOUR = 60 * 60 * 1000;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => finite(value) ? value : 0;

/** Counter intervals are valid only when neither a reset nor a decrease occurred. */
export function coverageCounterDelta(previous, current) {
  const start = Date.parse(previous?.observedAt);
  const end = Date.parse(current?.observedAt);
  const before = previous?.database;
  const after = current?.database;
  const fields = ['transactionsCommitted', 'transactionsRolledBack', 'blocksRead', 'blocksHit', 'temporaryBytes', 'temporaryFiles', 'deadlocks'];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !before || !after
    || !before.statsResetAt || before.statsResetAt !== after.statsResetAt
    || fields.some(key => !finite(before[key]) || !finite(after[key]) || after[key] < before[key])) {
    return { status: 'unavailable', reason: 'Insufficient compatible samples or database counters reset.' };
  }
  const delta = Object.fromEntries(fields.map(key => [key, after[key] - before[key]]));
  const blockAccesses = delta.blocksRead + delta.blocksHit;
  return {
    status: 'observed', from: previous.observedAt, to: current.observedAt, seconds: (end - start) / 1000,
    ...delta, cacheHitRatio: blockAccesses > 0 ? delta.blocksHit / blockAccesses : null,
  };
}

/** Pure bounded formatter for the protected operator endpoint. */
export function summarizeCoverageOperations(operations, { now = Date.now() } = {}) {
  const latest = operations?.latest;
  const observed = Date.parse(latest?.observedAt);
  if (latest?.schema !== 1 || !Number.isFinite(observed) || !Number.isFinite(now) || observed > now + 30000) {
    return { status: 'unknown', issues: [{ code: 'NO_VALID_SNAPSHOT', severity: 'warning' }],
      capacity: { status: 'unmeasured', concurrentVisitors: null } };
  }
  const ageSeconds = Math.max(0, (now - observed) / 1000);
  const maintenance = latest.maintenance;
  const groups = Array.isArray(maintenance?.groups) ? maintenance.groups.slice(0, 32) : [];
  const prepared = groups.reduce((sum, group) => sum + count(group.prepared), 0);
  const fresh = groups.reduce((sum, group) => sum + count(group.fresh), 0);
  const stale = groups.reduce((sum, group) => sum + count(group.stale), 0);
  const missing = groups.reduce((sum, group) => sum + count(group.missing), 0);
  const inventory = Array.isArray(latest.coverageGroups) ? latest.coverageGroups.slice(0, 32) : [];
  const work = latest.work || {};
  const membership = latest.membership || {};
  const cycles = Array.isArray(latest.cycles) ? latest.cycles.slice(0, 7) : [];
  const issues = [];
  if (ageSeconds > 90 * 60) issues.push({ code: 'SNAPSHOT_DELAYED', severity: 'warning' });
  if (!maintenance?.membershipId) issues.push({ code: 'MAINTENANCE_SCOPE_UNAVAILABLE', severity: 'warning' });
  else if (!prepared) issues.push({ code: 'NO_PREPARED_RECORDS', severity: 'warning' });
  if (missing) issues.push({ code: 'MISSING_MAINTAINED_PUBLICATIONS', severity: 'critical', count: missing });
  if (stale > 0) issues.push({ code: 'STALE_PUBLICATIONS', severity: 'warning', count: stale });
  if (count(work.expiredLeases)) issues.push({ code: 'EXPIRED_WORKER_LEASES', severity: 'warning', count: work.expiredLeases });
  if (count(work.oldestPendingAgeSeconds) > 12 * 3600) issues.push({ code: 'REFRESH_SWEEP_DELAYED', severity: 'warning' });
  if (count(work.unresolvedDeadJobs)) issues.push({ code: 'DEAD_REFRESH_JOBS', severity: 'critical', count: work.unresolvedDeadJobs });
  const cycleFailures = count(work.unresolvedIssuerFailures);
  if (cycleFailures) issues.push({ code: 'ISSUERS_NEED_RETRY', severity: 'critical', count: cycleFailures });
  const membershipDue = Date.parse(membership.nextCheckAt);
  const membershipSource = Date.parse(membership.activeSourceAsOf);
  const candidateSince = Date.parse(membership.candidateSince);
  if (Number.isFinite(membershipDue) && observed - membershipDue > 2 * HOUR) {
    issues.push({ code: 'MEMBERSHIP_CHECK_DELAYED', severity: 'warning' });
  }
  if (Number.isFinite(membershipSource) && observed - membershipSource > 14 * 24 * HOUR) {
    issues.push({ code: 'MEMBERSHIP_SOURCE_OLD', severity: 'warning' });
  }
  if (membership.lastError || count(membership.errorCount)) {
    issues.push({ code: 'MEMBERSHIP_CHECK_ERROR', severity: 'warning', count: count(membership.errorCount) });
  }
  if (membership.candidateId && Number.isFinite(candidateSince) && observed - candidateSince > 24 * HOUR) {
    issues.push({ code: 'MEMBERSHIP_CANDIDATE_DELAYED', severity: 'warning' });
  }
  // Use the snapshot's own clock: a snapshot taken before midnight must not
  // incorrectly report that today's 00:05 daily enqueue failed to occur.
  const observedDate = new Date(observed);
  const sinceMidnight = observedDate.getUTCHours() * 60 + observedDate.getUTCMinutes();
  if (sinceMidnight >= 20 && !count(work.todayJobs)) issues.push({ code: 'DAILY_CYCLE_NOT_RECORDED', severity: 'warning' });
  const completed = cycles.filter(cycle => cycle.jobs === 32 && cycle.done === 32 && cycle.completed_at
    && !count(cycle.failures) && !count(cycle.dead) && !count(cycle.superseded));
  const samples = Array.isArray(operations.history) ? operations.history.slice(-169) : [];
  const intervals = samples.slice(1).map((sample, index) => coverageCounterDelta(samples[index], sample));
  const dayWindow = samples.filter(sample => Date.parse(sample?.observedAt) >= observed - 24 * HOUR);
  return {
    status: issues.some(issue => issue.severity === 'critical') ? 'attention'
      : issues.length ? 'watch' : 'healthy',
    observedAt: latest.observedAt, snapshotAgeSeconds: ageSeconds, issues,
    membership,
    coverage: { membershipId: maintenance?.membershipId || null, prepared, fresh, stale, missing,
      retainedIssuers: count(maintenance?.retainedIssuerCount), freshnessSeconds: 25 * 3600 },
    inventory: { prepared: inventory.reduce((sum, group) => sum + count(group.prepared), 0),
      fresh: inventory.reduce((sum, group) => sum + count(group.fresh), 0),
      stale: inventory.reduce((sum, group) => sum + count(group.stale), 0) },
    refresh: { pending: count(work.pending), oldestPendingAgeSeconds: count(work.oldestPendingAgeSeconds),
      completedCycles: completed.length, latestCompletedCycle: completed[0] || null,
      unresolvedDeadJobs: count(work.unresolvedDeadJobs), unresolvedIssuerFailures: count(work.unresolvedIssuerFailures),
      historicalDeadJobs: count(work.historicalDeadJobs), historicalIssuerFailures: count(work.historicalIssuerFailures),
      source: 'Stored job checkpoints; scheduled versus manual invocation is not identified.' },
    history: { samples: samples.length,
      spanSeconds: samples.length > 1 ? Math.max(0, (Date.parse(samples.at(-1).observedAt) - Date.parse(samples[0].observedAt)) / 1000) : 0,
      daySamples: dayWindow.length,
      samplesWithStalePublications: dayWindow.filter(sample => count(sample.stale) > 0).length,
      samplesWithMissingPublications: dayWindow.filter(sample => count(sample.missing) > 0).length,
      samplesWithPendingWork: dayWindow.filter(sample => count(sample.pending) > 0).length,
      maximumObservedConnections: dayWindow.reduce((max, sample) => Math.max(max, count(sample.database?.connections)), 0),
      latestCounterInterval: intervals.at(-1) || { status: 'unavailable', reason: 'At least two snapshots are required.' } },
    metricAvailability: latest.metricAvailability || null,
    capacity: { status: 'unmeasured', concurrentVisitors: null },
    billing: { status: 'unmeasured', monthEgressBytes: null, monthEdgeInvocations: null },
  };
}
