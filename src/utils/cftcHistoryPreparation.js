import { createHash } from 'node:crypto';
import * as dataStore from './dataStore.js';
import * as cftcServer from './cftcServer.js';
import { cftcPersistence } from './cftcPersistence.js';
import { CFTC_REPORT_BASIS, cftcDate, isCftcContractCode, isCftcFamily, normalizeCftcRows } from './cftc.js';

export const CFTC_HISTORY_JOB_PREFIX = 'cftc-history-v1:';
export const CFTC_HISTORY_SHARDS = 32;
const MAX_CATALOG_CONTRACTS = 1500;
const MAX_SHARD_CONTRACTS = Math.ceil(MAX_CATALOG_CONTRACTS / CFTC_HISTORY_SHARDS);
const MAX_CONTRACTS = 12;
const MAX_ENQUEUES = 16;
const MAX_CONTRACT_FAILURES = 3;
const ACKNOWLEDGMENT_RESERVE_MS = 18_000;
const MIN_CONTRACT_BUDGET_MS = 20_000 + ACKNOWLEDGMENT_RESERVE_MS;
const MAX_INVOCATION_MS = 180_000;
const LEASE_SECONDS = 210;
const MAX_CHECKPOINT_BYTES = 16_384;
const SOURCE_MAX_AGE_MS = 14 * 86_400_000;
const transientCodes = new Set(['CFTC_DURABLE_REFRESH_IN_PROGRESS', 'CFTC_REFRESH_IN_PROGRESS', 'CFTC_HISTORY_BUSY', 'CFTC_SOURCE_BUSY', 'CFTC_REQUEST_CANCELLED']);

const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const hashPattern = /^[a-f0-9]{64}$/;
const generationPattern = /^[1-9][0-9]{0,18}$/;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : 'CFTC_HISTORY_PREPARATION_FAILED';
const shardText = shard => String(shard).padStart(2, '0');
const resourceKey = (family, shard) => `history-refresh:futures-only:${family}:shard:${shardText(shard)}`;
const jobKey = checkpoint => `${CFTC_HISTORY_JOB_PREFIX}${checkpoint.reportDate}:${checkpoint.family}:${shardText(checkpoint.shard)}:${checkpoint.catalogHash.slice(0, 16)}`;

function workerError(code) {
  return Object.assign(new Error('CFTC history preparation could not finish this bounded step.'), { code });
}

/** A late queue mutation may have committed; never compensate it using an older local cursor. */
async function boundedCall(operation, signal, { mutation = false, code = 'CFTC_HISTORY_DEADLINE' } = {}) {
  if (signal.aborted) throw workerError(code);
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(workerError(code));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw workerError(code);
      return operation();
    }), cancelled]);
    if (signal.aborted) throw workerError(code);
    return value;
  } catch (error) {
    if (mutation) throw Object.assign(workerError(safeCode(error?.code)), { uncertainMutation: true });
    throw error;
  } finally { signal.removeEventListener('abort', onAbort); }
}

/** Rows, rather than names, retrieval times, or a changing list position, identify a catalog revision. */
export function frozenCftcHistoryCatalog(source, family, now = Date.now()) {
  const date = source?.report_date;
  if (!isCftcFamily(family) || source?.family !== family || source.report_basis !== CFTC_REPORT_BASIS
    || cftcDate(date) !== date || typeof date !== 'string' || !hashPattern.test(source.contentHash || '')
    || !generationPattern.test(String(source.generation || '')) || !Array.isArray(source.rows)
    || source.rows.length > 10_000 || !Number.isFinite(now)) return null;
  const age = now - Date.parse(`${date}T00:00:00Z`);
  const savedAge = now - Date.parse(source.savedAt), retrievedAge = now - Date.parse(source.retrievedAt);
  if (age < 0 || age > SOURCE_MAX_AGE_MS || !Number.isFinite(savedAge) || savedAge < 0 || savedAge > SOURCE_MAX_AGE_MS
    || !Number.isFinite(retrievedAge) || retrievedAge < 0 || retrievedAge > SOURCE_MAX_AGE_MS) return null;
  const normalized = normalizeCftcRows(source.rows, family);
  const selected = normalized.rows.filter(row => row.reportDate === date);
  if (!selected.length || selected.length > MAX_CATALOG_CONTRACTS || normalized.rows.some(row => row.reportDate !== date)) return null;
  const rows = [...selected].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const contracts = rows.map(row => [row.code, digest(row.raw)]);
  const catalogHash = digest({ family, reportBasis: CFTC_REPORT_BASIS, reportDate: date, contracts });
  // Every revision freezes a sorted list. Contiguous, evenly sized shards cap
  // even an adversarial code distribution without silently dropping a market.
  const size = Math.ceil(contracts.length / CFTC_HISTORY_SHARDS);
  const shards = Array.from({ length: CFTC_HISTORY_SHARDS }, (_, shard) => contracts.slice(shard * size, (shard + 1) * size));
  return { family, reportDate: date, catalogHash, sourceContentHash: source.contentHash,
    sourceGeneration: String(source.generation), contracts, shards, rows: new Map(rows.map(row => [row.code, row.raw])),
    quarantinedRows: normalized.quarantine.length };
}

function initialCheckpoint(catalog, shard) {
  return { schema: 1, reportBasis: CFTC_REPORT_BASIS, family: catalog.family, reportDate: catalog.reportDate,
    catalogHash: catalog.catalogHash, sourceContentHash: catalog.sourceContentHash, sourceGeneration: catalog.sourceGeneration,
    catalogContracts: catalog.contracts.length, shard, contracts: catalog.shards[shard], cursor: 0,
    prepared: 0, limited: 0, workCount: 0, retries: [], failures: [] };
}

export function validCftcHistoryCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint) || bytes(checkpoint) > MAX_CHECKPOINT_BYTES
    || checkpoint.schema !== 1 || checkpoint.reportBasis !== CFTC_REPORT_BASIS || !isCftcFamily(checkpoint.family)
    || typeof checkpoint.reportDate !== 'string' || cftcDate(checkpoint.reportDate) !== checkpoint.reportDate
    || !hashPattern.test(checkpoint.catalogHash || '') || !hashPattern.test(checkpoint.sourceContentHash || '')
    || !generationPattern.test(checkpoint.sourceGeneration || '') || !integer(checkpoint.catalogContracts, 1, MAX_CATALOG_CONTRACTS)
    || !integer(checkpoint.shard, 0, CFTC_HISTORY_SHARDS - 1) || !Array.isArray(checkpoint.contracts)
    || checkpoint.contracts.length > MAX_SHARD_CONTRACTS || !integer(checkpoint.cursor, 0, checkpoint.contracts.length)
    || !integer(checkpoint.prepared, 0, checkpoint.cursor) || !integer(checkpoint.limited, 0, checkpoint.prepared)
    || !integer(checkpoint.workCount, checkpoint.cursor, Number.MAX_SAFE_INTEGER)
    || !Array.isArray(checkpoint.retries) || !Array.isArray(checkpoint.failures)
    || checkpoint.prepared + checkpoint.retries.length + checkpoint.failures.length !== checkpoint.cursor) return false;
  let previous = '';
  for (const contract of checkpoint.contracts) {
    if (!Array.isArray(contract) || contract.length !== 2 || !isCftcContractCode(contract[0])
      || contract[0] <= previous || !hashPattern.test(contract[1] || '')) return false;
    previous = contract[0];
  }
  const seen = new Set();
  for (const entry of [...checkpoint.retries, ...checkpoint.failures]) {
    if (!entry || !integer(entry.index, 0, checkpoint.cursor - 1) || seen.has(entry.index) || safeCode(entry.code) !== entry.code) return false;
    seen.add(entry.index);
  }
  return checkpoint.retries.every(entry => integer(entry.attempts, 0, MAX_CONTRACT_FAILURES - 1)
    && Number.isSafeInteger(entry.nextAt) && entry.nextAt >= 0);
}

function validPreparedResult(result, family, code, reportDate) {
  return result?.family === family && result.report_basis === CFTC_REPORT_BASIS && result.code === code && result.report_date === reportDate
    && ['ready', 'partial'].includes(result.status) && integer(result.rows, 1, 600) && integer(result.pages, 1, 3)
    && result.coverage?.required_prior_reports === 520 && typeof result.coverage.sufficient === 'boolean'
    && integer(result.coverage.prior_observations, 0, 599) && typeof result.coverage.source_exhausted === 'boolean'
    && typeof result.coverage.cap_reached === 'boolean' && integer(result.coverage.quarantined_rows, 0, 600)
    && result.durable_receipt?.key === `raw-history-v1:futures-only:${family}:${code}:${reportDate}`
    && generationPattern.test(String(result.durable_receipt.generation || '')) && hashPattern.test(result.durable_receipt.content_hash || '');
}

function coverage(checkpoint) {
  return { contracts: checkpoint.contracts.length, visited: checkpoint.cursor, prepared: checkpoint.prepared,
    limited: checkpoint.limited, pendingRetries: checkpoint.retries.length, failed: checkpoint.failures.length };
}

function retrySeconds(error, failures) {
  // CFTC transport retryAfter values are milliseconds, unlike the SEC helper.
  const providerMs = Number(error?.retryAfter);
  const lowerBound = Number.isFinite(providerMs) && providerMs >= 0 ? Math.ceil(providerMs / 1000) : 0;
  return Math.min(86_400, Math.max(lowerBound, Math.min(3600, 30 * 2 ** Math.min(failures, 6))));
}

/**
 * Scheduler-only preparation. Queue manifests contain no raw rows or source
 * URLs; each contract publication is acknowledged before its cursor advances.
 * Existing successful shards survive invocations, deployments, and crashes.
 */
export async function runCftcHistoryPreparation({ signal, deadline, maxContracts = MAX_CONTRACTS, maxJobs = 8 } = {}, {
  mode = () => dataStore.getDataStoreMode('cftc'), readStatus = dataStore.readCftcHistoryStatus,
  catalogRaw = (...args) => cftcPersistence.catalogRaw(...args), prepare = cftcServer.prepareCftcContractRawHistory,
  enqueue = dataStore.enqueueDataStoreJob, claimJob = dataStore.claimDataStoreJob,
  checkpointJob = dataStore.checkpointDataStoreJob, finish = dataStore.finishDataStoreJob,
  yieldJob = dataStore.yieldDataStoreJob, now = Date.now, timeoutSignal = milliseconds => AbortSignal.timeout(milliseconds),
} = {}) {
  const startedAt = now(), stopAt = deadline ?? startedAt + MAX_INVOCATION_MS;
  if (!integer(maxContracts, 1, MAX_CONTRACTS) || !integer(maxJobs, 1, 8) || !Number.isFinite(startedAt) || !Number.isFinite(stopAt)
    || stopAt > startedAt + MAX_INVOCATION_MS) throw workerError('CFTC_HISTORY_INVALID_BUDGET');
  if (mode() !== 'supabase') return { status: 'disabled', processed: 0 };
  if (signal?.aborted || stopAt - now() < MIN_CONTRACT_BUDGET_MS) return { status: 'budget-exhausted', processed: 0 };
  const timeout = timeoutSignal(Math.max(1, Math.ceil(stopAt - now())));
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const status = await boundedCall(() => readStatus({ signal }), signal);
  if (status?.enabled !== true) return { status: 'awaiting-sec-verification', processed: 0 };
  const catalogs = new Map();
  for (const family of ['tff', 'disaggregated']) {
    if (signal?.aborted || stopAt - now() < MIN_CONTRACT_BUDGET_MS) break;
    const catalog = frozenCftcHistoryCatalog(await boundedCall(() => catalogRaw(family), signal), family, now());
    if (catalog) catalogs.set(family, catalog);
  }
  let enqueued = 0;
  for (const catalog of catalogs.values()) {
    const existing = Array.isArray(status.jobs) ? status.jobs.find(item => item.family === catalog.family
      && item.reportDate === catalog.reportDate && item.catalogHash === catalog.catalogHash) : null;
    const known = new Set(Array.isArray(existing?.shardIndexes) ? existing.shardIndexes.filter(index => integer(index, 0, CFTC_HISTORY_SHARDS - 1)) : []);
    for (let shard = 0; shard < CFTC_HISTORY_SHARDS; shard += 1) {
      if (enqueued >= MAX_ENQUEUES || signal?.aborted || stopAt - now() < MIN_CONTRACT_BUDGET_MS) break;
      if (known.has(shard)) continue;
      const checkpoint = initialCheckpoint(catalog, shard);
      if (!validCftcHistoryCheckpoint(checkpoint)) throw workerError('CFTC_HISTORY_INVALID_CATALOG');
      const acknowledged = await boundedCall(() => enqueue({ dataset: 'cftc', key: resourceKey(catalog.family, shard), jobKey: jobKey(checkpoint), checkpoint, maxAttempts: 4 }), signal, { mutation: true });
      if (!acknowledged) throw workerError('CFTC_HISTORY_ENQUEUE_FAILED');
      enqueued += 1;
    }
  }
  if (signal?.aborted || stopAt - now() < MIN_CONTRACT_BUDGET_MS) return { status: 'budget-exhausted', processed: 0, enqueued };
  const batches = [];
  let processed = 0;
  while (batches.length < maxJobs && processed < maxContracts && !signal?.aborted && stopAt - now() >= MIN_CONTRACT_BUDGET_MS) {
    const claim = await boundedCall(() => claimJob({ dataset: 'cftc', prefix: CFTC_HISTORY_JOB_PREFIX, leaseSeconds: LEASE_SECONDS }), signal, { mutation: true });
    if (!claim) break;
    const batch = await processHistoryClaim({ claim, catalogs, signal, stopAt, maxContracts: maxContracts - processed },
      { prepare, checkpointJob, finish, yieldJob, now, timeoutSignal });
    batches.push(batch); processed += batch.processed;
    if (['catalog-unavailable', 'superseded', 'invalid-checkpoint'].includes(batch.status)) break;
  }
  if (batches.length === 1) return { ...batches[0], enqueued, batches: 1 };
  return { status: batches.length ? 'progress' : catalogs.size ? 'busy-or-finished' : 'catalog-unavailable',
    processed, enqueued, batches: batches.length, jobs: batches };
}

async function processHistoryClaim({ claim, catalogs, signal, stopAt, maxContracts }, { prepare, checkpointJob, finish, yieldJob, now, timeoutSignal }) {
  let checkpoint = structuredClone(claim.checkpoint || {});
  if (!validCftcHistoryCheckpoint(checkpoint) || claim.key !== resourceKey(checkpoint.family, checkpoint.shard) || claim.jobKey !== jobKey(checkpoint)) {
    const acknowledged = await boundedCall(() => finish(claim, { status: 'dead', checkpoint: {}, errorCode: 'CFTC_HISTORY_INVALID_CHECKPOINT' }), signal, { mutation: true });
    if (!acknowledged) throw workerError('CFTC_HISTORY_JOB_FENCE_LOST');
    return { status: 'invalid-checkpoint', processed: 0 };
  }
  let processed = 0;
  try {
    const catalog = catalogs.get(checkpoint.family);
    if (!catalog) {
      const acknowledged = await boundedCall(() => yieldJob(claim, { checkpoint, retryAfterSeconds: 300 }), signal, { mutation: true });
      if (!acknowledged) throw workerError('CFTC_HISTORY_JOB_FENCE_LOST');
      return { status: 'catalog-unavailable', processed };
    }
    if (catalog.reportDate !== checkpoint.reportDate || catalog.catalogHash !== checkpoint.catalogHash) {
      const acknowledged = await boundedCall(() => finish(claim, { checkpoint, status: 'done', errorCode: 'CFTC_HISTORY_SUPERSEDED' }), signal, { mutation: true });
      if (!acknowledged) throw workerError('CFTC_HISTORY_JOB_FENCE_LOST');
      return { status: 'superseded', processed };
    }
    if (catalog.contracts.length !== checkpoint.catalogContracts
      || JSON.stringify(catalog.shards[checkpoint.shard]) !== JSON.stringify(checkpoint.contracts)) throw workerError('CFTC_HISTORY_MANIFEST_MISMATCH');
    while (processed < maxContracts && !signal?.aborted && stopAt - now() >= MIN_CONTRACT_BUDGET_MS) {
      const firstAttempt = checkpoint.cursor < checkpoint.contracts.length;
      const retryIndex = firstAttempt ? -1 : checkpoint.retries.findIndex(entry => entry.nextAt <= now());
      if (!firstAttempt && retryIndex < 0) break;
      const previous = retryIndex < 0 ? null : checkpoint.retries[retryIndex];
      const index = firstAttempt ? checkpoint.cursor : previous.index;
      const [code, expectedHash] = checkpoint.contracts[index], raw = catalog.rows.get(code);
      if (!raw || digest(raw) !== expectedHash) throw workerError('CFTC_HISTORY_MANIFEST_MISMATCH');
      const contractTimeout = timeoutSignal(Math.max(1, Math.floor(Math.min(45_000, stopAt - now() - ACKNOWLEDGMENT_RESERVE_MS))));
      const contractSignal = signal ? AbortSignal.any([signal, contractTimeout]) : contractTimeout;
      let result, failure = null;
      try {
        result = await boundedCall(() => prepare({ family: checkpoint.family, code, throughDate: checkpoint.reportDate,
          expectedSelectedRaw: raw, count: 520, signal: contractSignal }), contractSignal, { code: 'CFTC_HISTORY_CONTRACT_DEADLINE' });
        if (!validPreparedResult(result, checkpoint.family, code, checkpoint.reportDate)) throw workerError('CFTC_HISTORY_INVALID_RECEIPT');
      } catch (error) { failure = error; }
      if (signal.aborted || now() >= stopAt) throw workerError('CFTC_HISTORY_DEADLINE');
      const next = structuredClone(checkpoint);
      if (firstAttempt) next.cursor += 1;
      else next.retries.splice(retryIndex, 1);
      next.workCount += 1;
      if (!failure) {
        next.prepared += 1;
        // The worker collects extra evidence (520 prior reports), while the
        // longest public chart/percentile needs 260. A younger source with
        // 300 complete observations already supports every public window.
        if (result.coverage.prior_observations < 260 || result.status === 'partial'
          || result.coverage.cap_reached || result.coverage.quarantined_rows > 0) next.limited += 1;
      } else {
        const code = safeCode(failure?.code);
        const failures = (previous?.attempts || 0) + (transientCodes.has(code) || signal?.aborted ? 0 : 1);
        if (failures < MAX_CONTRACT_FAILURES) next.retries.push({ index, attempts: failures, code,
          nextAt: now() + retrySeconds(failure, failures) * 1000 });
        else next.failures.push({ index, code });
      }
      if (!validCftcHistoryCheckpoint(next)) throw workerError('CFTC_HISTORY_INVALID_CHECKPOINT');
      const acknowledged = await boundedCall(() => checkpointJob(claim, { checkpoint: next, leaseSeconds: LEASE_SECONDS }), signal, { mutation: true });
      if (!acknowledged) throw workerError('CFTC_HISTORY_JOB_FENCE_LOST');
      checkpoint = next;
      processed += 1;
    }
    const done = checkpoint.cursor === checkpoint.contracts.length && checkpoint.retries.length === 0;
    const nextAt = checkpoint.cursor === checkpoint.contracts.length && checkpoint.retries.length
      ? Math.min(...checkpoint.retries.map(entry => entry.nextAt)) : null;
    const retryAfterSeconds = nextAt === null ? 1 : Math.min(86_400, Math.max(1, Math.ceil((nextAt - now()) / 1000)));
    const acknowledged = done
      ? await boundedCall(() => finish(claim, { checkpoint, status: 'done', errorCode: checkpoint.failures.length ? 'CFTC_HISTORY_PARTIAL' : null }), signal, { mutation: true })
      : await boundedCall(() => yieldJob(claim, { checkpoint, retryAfterSeconds }), signal, { mutation: true });
    if (!acknowledged) throw workerError('CFTC_HISTORY_JOB_FENCE_LOST');
    return { status: done ? 'done' : 'resume-required', processed, family: checkpoint.family,
      reportDate: checkpoint.reportDate, shard: checkpoint.shard, coverage: coverage(checkpoint), ...(done ? {} : { retryAfterSeconds }) };
  } catch (error) {
    // If a mutation's acknowledgment was lost, its fenced server-side write
    // may still complete. Leave the lease to expire and resume from the stored
    // checkpoint; a compensating finish could overwrite that newer progress.
    if (!signal.aborted && !error?.uncertainMutation && now() < stopAt) {
      await boundedCall(() => finish(claim, { checkpoint, status: 'retry', errorCode: safeCode(error?.code), retryAfterSeconds: 60 }), signal, { mutation: true }).catch(() => false);
    }
    throw workerError(safeCode(error?.code));
  }
}
