import { createHash } from 'node:crypto';
import * as dataStore from './dataStore.js';
import * as preparedFinancialData from './preparedFinancialData.js';
import { SEC_PREPARED_COHORT } from './secDocumentStore.js';
import { migrationRetrySeconds } from './dataMigrationOperations.js';

export const SEC_COVERAGE_JOB_PREFIX = 'sec-coverage-v1:';
export const SEC_COVERAGE_SHARDS = 32;
const MAX_COMPANIES = 6;
const MAX_ISSUER_ATTEMPTS = 3;
const MIN_COMPANY_BUDGET_MS = 60_000;
const LEASE_SECONDS = 270;
const MAX_SHARD_COMPANIES = 64;
const successfulStatuses = new Set(['prepared', 'updated', 'unchanged']);

/** CIK, rather than a mutable ticker or a fund's holding order, owns the shard. */
export function secCoverageShard(cik) {
  const normalized = String(cik).padStart(10, '0');
  if (!/^\d{10}$/.test(normalized)) throw new Error('Invalid SEC coverage CIK.');
  return createHash('sha256').update(normalized).digest().readUInt32BE(0) % SEC_COVERAGE_SHARDS;
}

function universeFor(companies) {
  if (!Array.isArray(companies) || !companies.length || companies.length > 600) throw new Error('Invalid SEC coverage universe.');
  const seen = new Set();
  const sorted = companies.map(company => {
    const cik = String(company.cik).padStart(10, '0');
    if (!/^\d{10}$/.test(cik) || seen.has(cik) || !/^[A-Z0-9][A-Z0-9.-]{0,15}$/.test(company.ticker || '')) throw new Error('Invalid SEC coverage company.');
    seen.add(cik);
    return { ...company, cik };
  }).sort((a, b) => a.cik.localeCompare(b.cik));
  const version = createHash('sha256').update(JSON.stringify(sorted.map(({ cik, ticker }) => [cik, ticker]))).digest('hex').slice(0, 16);
  const shards = Array.from({ length: SEC_COVERAGE_SHARDS }, () => []);
  for (const company of sorted) shards[secCoverageShard(company.cik)].push(company);
  if (shards.some(shard => shard.length > MAX_SHARD_COMPANIES)) throw new Error('SEC coverage shard exceeds its work limit.');
  return { version, shards, count: sorted.length };
}

function safeCode(value, fallback = 'SEC_COVERAGE_COMPANY_FAILED') {
  return typeof value === 'string' && value.length ? value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) : fallback;
}

function validCheckpoint(checkpoint, shardSize) {
  const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  if (!checkpoint || checkpoint.schema !== 1 || !integer(checkpoint.shard, 0, SEC_COVERAGE_SHARDS - 1)
    || !/^\d{4}-\d{2}-\d{2}$/.test(checkpoint.cycle || '') || !/^[a-f0-9]{16}$/.test(checkpoint.universeVersion || '')
    || !integer(checkpoint.cursor, 0, shardSize) || !integer(checkpoint.succeeded, 0, shardSize)
    || !integer(checkpoint.workCount, 0, shardSize * MAX_ISSUER_ATTEMPTS)
    || !Array.isArray(checkpoint.retries) || !Array.isArray(checkpoint.failures)
    || checkpoint.retries.length + checkpoint.failures.length > shardSize) return false;
  const indices = new Set();
  for (const entry of [...checkpoint.retries, ...checkpoint.failures]) {
    if (!entry || !integer(entry.index, 0, checkpoint.cursor - 1) || indices.has(entry.index)
      || safeCode(entry.code) !== entry.code) return false;
    indices.add(entry.index);
  }
  if (checkpoint.retries.some(entry => !integer(entry.attempts, 1, MAX_ISSUER_ATTEMPTS - 1)
    || !Number.isSafeInteger(entry.nextAt) || entry.nextAt < 0)) return false;
  return checkpoint.succeeded + checkpoint.retries.length + checkpoint.failures.length === checkpoint.cursor;
}

function hasBusyWork(result) {
  return result?.status === 'busy' || result?.financial?.bases?.some(basis => basis.status === 'busy')
    || result?.bases?.some(basis => basis.status === 'busy');
}

/**
 * A daily, versioned universe becomes 32 small durable jobs. Every invocation
 * awaits and checkpoints each issuer separately; an individual issuer failure
 * moves to a bounded retry list while other issuers continue. Normal yields do
 * not consume the durable job's crash/failure retry allowance.
 */
export async function runSecCoverageJob({ shard, maxCompanies = MAX_COMPANIES, signal, deadline } = {}, {
  enqueue = dataStore.enqueueCoverageJobs,
  claimJob = dataStore.claimDataStoreJob,
  finish = dataStore.finishDataStoreJob,
  checkpointJob = dataStore.checkpointDataStoreJob,
  yieldJob = dataStore.yieldDataStoreJob,
  refresh = preparedFinancialData.refreshSecCoverageCompany,
  companies = SEC_PREPARED_COHORT,
  now = Date.now,
} = {}) {
  if (!Number.isInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > MAX_COMPANIES
    || shard !== undefined && (!Number.isInteger(shard) || shard < 0 || shard >= SEC_COVERAGE_SHARDS)) throw new Error('Unbounded SEC coverage invocation.');
  const startedAt = now();
  const stopAt = deadline ?? startedAt + 230_000;
  if (!Number.isFinite(startedAt) || !Number.isFinite(stopAt) || stopAt > startedAt + 230_000) throw new Error('Invalid SEC coverage deadline.');
  const universe = universeFor(companies);
  const cycle = new Date(startedAt).toISOString().slice(0, 10);
  const shardIndices = shard === undefined ? Array.from({ length: SEC_COVERAGE_SHARDS }, (_, index) => index) : [shard];
  const jobKey = index => `${SEC_COVERAGE_JOB_PREFIX}${cycle}:${String(index).padStart(2, '0')}:${universe.version}`;
  // One small RPC idempotently creates the 32 fixed shards. Enqueue before
  // claim also repairs an interrupted setup without per-issuer API calls.
  if (signal?.aborted || now() >= stopAt - MIN_COMPANY_BUDGET_MS) return { status: 'budget-exhausted', done: false, processed: 0 };
  await enqueue({ cycle, version: universe.version, shards: shardIndices });
  const claim = await claimJob({ dataset: 'sec', leaseSeconds: LEASE_SECONDS,
    ...(shard === undefined ? { prefix: SEC_COVERAGE_JOB_PREFIX } : { jobKey: jobKey(shard) }) });
  if (!claim) return { status: 'busy-or-finished', done: false, processed: 0, retryAfterSeconds: 30 };
  let checkpoint = structuredClone(claim.checkpoint || {});
  if (checkpoint.universeVersion !== universe.version) {
    const saved = await finish(claim, { status: 'done', checkpoint, errorCode: 'SEC_COVERAGE_SUPERSEDED' });
    if (!saved) throw new Error('SEC coverage job ownership expired.');
    return { status: 'superseded', done: true, processed: 0, jobId: claim.id };
  }
  const shardCompanies = universe.shards[checkpoint.shard];
  if (!shardCompanies || !validCheckpoint(checkpoint, shardCompanies.length)
    || claim.key !== `${SEC_COVERAGE_JOB_PREFIX}shard:${String(checkpoint.shard).padStart(2, '0')}`
    || claim.jobKey !== `${SEC_COVERAGE_JOB_PREFIX}${checkpoint.cycle}:${String(checkpoint.shard).padStart(2, '0')}:${universe.version}`) {
    await finish(claim, { status: 'dead', checkpoint: {}, errorCode: 'SEC_COVERAGE_INVALID_CHECKPOINT' });
    throw new Error('Invalid SEC coverage checkpoint.');
  }
  const results = [];
  try {
    while (results.length < maxCompanies && !signal?.aborted && stopAt - now() >= MIN_COMPANY_BUDGET_MS) {
      const isFirstAttempt = checkpoint.cursor < shardCompanies.length;
      const retryPosition = isFirstAttempt ? -1 : checkpoint.retries.findIndex(entry => entry.nextAt <= now());
      if (!isFirstAttempt && retryPosition < 0) break;
      const previous = retryPosition < 0 ? null : checkpoint.retries[retryPosition];
      const index = isFirstAttempt ? checkpoint.cursor : previous.index;
      const company = shardCompanies[index];
      const attempts = (previous?.attempts || 0) + 1;
      let result, failure;
      try {
        result = await refresh(company.ticker, { signal, deadline: stopAt });
        if (hasBusyWork(result)) failure = { code: 'SEC_COVERAGE_COMPANY_BUSY', retryAfter: result?.retryAfter || 30 };
        else if (!successfulStatuses.has(result?.status)) failure = { code: safeCode(result?.code), retryAfter: result?.retryAfter };
      } catch (error) {
        failure = { code: safeCode(error?.code, error?.name === 'AbortError' ? 'SEC_COVERAGE_COMPANY_DEADLINE' : undefined), retryAfter: error?.retryAfter };
      }
      const next = structuredClone(checkpoint);
      if (isFirstAttempt) next.cursor += 1;
      else next.retries.splice(retryPosition, 1);
      next.workCount += 1;
      const retrySeconds = failure ? Math.ceil(migrationRetrySeconds(failure, attempts, now())) : 0;
      const retrySupported = Number.isSafeInteger(retrySeconds) && retrySeconds <= 2147483647;
      if (!failure) next.succeeded += 1;
      else if (attempts < MAX_ISSUER_ATTEMPTS && retrySupported) next.retries.push({ index, attempts, code: failure.code,
        nextAt: now() + retrySeconds * 1000 });
      else next.failures.push({ index, code: retrySupported ? failure.code : 'SEC_COVERAGE_RETRY_REQUIRES_REVIEW' });
      // Fenced publication failure aborts the invocation. Do not record progress
      // locally until the database confirms it; redoing an issuer is idempotent.
      const acknowledged = await checkpointJob(claim, { checkpoint: next, leaseSeconds: LEASE_SECONDS });
      if (!acknowledged) throw new Error('SEC coverage checkpoint ownership expired.');
      checkpoint = next;
      results.push({ ticker: company.ticker, cik: company.cik, status: failure ? 'deferred' : result.status,
        ...(failure ? { code: failure.code, exhausted: attempts >= MAX_ISSUER_ATTEMPTS || !retrySupported } : {}) });
    }
    const done = checkpoint.cursor === shardCompanies.length && checkpoint.retries.length === 0;
    const nextRetryAt = checkpoint.cursor === shardCompanies.length && checkpoint.retries.length
      ? Math.min(...checkpoint.retries.map(entry => entry.nextAt)) : null;
    // The durable queue accepts a one-day delay. Longer provider cooldowns stay
    // in each issuer's absolute nextAt; an earlier scheduler wake cannot fetch it.
    const retryAfterSeconds = nextRetryAt === null ? 1 : Math.min(86400, Math.max(1, Math.ceil((nextRetryAt - now()) / 1000)));
    const acknowledged = done
      ? await finish(claim, { checkpoint, status: 'done', errorCode: checkpoint.failures.length ? 'SEC_COVERAGE_PARTIAL' : null })
      : await yieldJob(claim, { checkpoint, retryAfterSeconds });
    if (!acknowledged) throw new Error('SEC coverage job ownership expired before release.');
    return { status: done ? 'done' : 'resume-required', done, jobId: claim.id, cycle: checkpoint.cycle,
      shard: checkpoint.shard, universeCompanies: universe.count, universeVersion: universe.version, processed: results.length,
      coverage: { companies: shardCompanies.length, visited: checkpoint.cursor, succeeded: checkpoint.succeeded,
        pendingRetries: checkpoint.retries.length, failed: checkpoint.failures.length },
      ...(done ? {} : { retryAfterSeconds }), results };
  } catch (error) {
    await finish(claim, { checkpoint, status: 'retry', errorCode: 'SEC_COVERAGE_INVOCATION_FAILED',
      retryAfterSeconds: migrationRetrySeconds(error, claim.attempts, now()) }).catch(() => false);
    throw error;
  }
}
