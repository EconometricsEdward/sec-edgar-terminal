import { createHash } from 'node:crypto';
import { beginDatasetWrite, checkpointDataStoreJob, claimDataStoreJob, enqueueDataStoreJob, finishDataStoreJob, getDataStoreMode, publishDataset, readDataset, readDatasetSource } from './dataStore.js';
import { CFTC_CALCULATION_VERSION, CFTC_FAMILIES, CFTC_REPORT_BASIS, CFTC_SCHEMA_VERSION } from './cftc.js';

const SOURCE_SCHEMA = 'edgar.cftc-source-bundle.v1';
const MAX_AGE_MS = 15 * 86400_000;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_COMPARISONS_PER_HOUR = 8;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

function persistenceError(code) {
  // Provider exceptions can contain request details; never expose those through public routes.
  return Object.assign(new Error('Prepared CFTC storage is temporarily unavailable.'), { code, status: 503 });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function json(value) { return JSON.stringify(canonical(value)); }
function digest(value) { return createHash('sha256').update(json(value)).digest('hex'); }

export function cftcSnapshotIdentity(key, envelope) {
  const { retrieved_at: _retrieved, freshness: _freshness, cache_publication: _publication,
    refresh_warning: _warning, status: _status, ...content } = envelope.response;
  // Report dates, raw observations, formula/calculation versions, coverage and
  // quarantine stay in the identity. Runtime cache presentation does not.
  return { key, content };
}

function validatedAt(record, original, now) {
  const revalidated = Date.parse(record?.metadata?.revalidatedAt);
  return Number.isFinite(revalidated) && revalidated <= now && revalidated > Date.parse(original)
    ? record.metadata.revalidatedAt : original;
}

/** Exact raw envelopes are reconstructed with their original retrieval times, never the read time. */
export function cftcSourceBundle(rawHistories = [], latestRows = []) {
  const times = [];
  const histories = rawHistories.map(envelope => {
    const { savedAt, retrievedAt, ...stable } = envelope;
    times.push({ code: envelope.code, savedAt, retrievedAt });
    return stable;
  });
  return { bytes: json({ schema_version: SOURCE_SCHEMA, rawHistories: histories, latestRows }), times };
}

/** Only the CFTC integration calls this adapter; no generic Redis namespace migration. */
export function createCftcPersistence({
  mode = () => getDataStoreMode('cftc'), begin = beginDatasetWrite,
  read = readDataset, publish = publishDataset, readSource = readDatasetSource,
  enqueueJob = enqueueDataStoreJob, claimJob = claimDataStoreJob, finishJob = finishDataStoreJob, checkpointJob = checkpointDataStoreJob,
  now = () => Date.now(),
} = {}) {
  let comparisonHour = -1, comparisons = 0;
  const counters = { writes: 0, write_failures: 0, read_failures: 0, shadow_matches: 0, shadow_mismatches: 0, shadow_revision_skips: 0 };
  const increment = key => { counters[key] = Math.min(MAX_COUNTER, counters[key] + 1); };

  async function reserve(key) {
    if (mode() === 'off') return null;
    try {
      const claim = await begin('cftc', key, { leaseSeconds: 120 });
      if (!claim) throw persistenceError('CFTC_DURABLE_REFRESH_IN_PROGRESS');
      return claim;
    } catch {
      increment('write_failures');
      if (mode() === 'supabase') throw persistenceError('CFTC_DURABLE_REFRESH_IN_PROGRESS');
      return null;
    }
  }

  async function prepared(key, { validate, pointer = 'current' } = {}) {
    if (mode() !== 'supabase') return null;
    try {
      const record = await read('cftc', key, { allowStale: true, pointer });
      const envelope = record?.payload ? { ...record.payload, savedAt: validatedAt(record, record.payload.savedAt, now()) } : null;
      const age = now() - Date.parse(envelope?.savedAt);
      if (!record || age < 0 || age >= MAX_AGE_MS || !validate?.(envelope)) return null;
      return envelope;
    } catch { increment('read_failures'); return null; }
  }

  async function raw(key, { family, code, throughDate, validate, pointer = 'current' } = {}) {
    if (mode() !== 'supabase') return null;
    try {
      const record = await read('cftc', key, { allowStale: true, pointer });
      if (!record || record.metadata?.reportPeriod !== throughDate || record.payload?.response?.report_family !== family) return null;
      const bytes = await readSource(record);
      if (!bytes || bytes.byteLength > MAX_SOURCE_BYTES) return null;
      const source = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (source?.schema_version !== SOURCE_SCHEMA || !Array.isArray(source.rawHistories)) return null;
      const stable = source.rawHistories.find(item => item.code === code && item.family === family && item.through_date === throughDate);
      const times = record.metadata?.rawHistoryTimes?.find(item => item.code === code);
      if (!stable || !times) return null;
      const envelope = { ...stable, savedAt: validatedAt(record, times.savedAt, now()), retrievedAt: times.retrievedAt };
      return validate?.(envelope) ? envelope : null;
    } catch { increment('read_failures'); return null; }
  }

  async function comparePublished(key, envelope, written) {
    if (mode() !== 'shadow') return;
    const hour = Math.floor(now() / 3600_000);
    if (hour !== comparisonHour) { comparisonHour = hour; comparisons = 0; }
    if (comparisons >= MAX_COMPARISONS_PER_HOUR) return;
    comparisons += 1;
    try {
      const candidate = await read('cftc', key, { allowStale: true });
      // A newer legitimate source revision is neither a match nor a storage mismatch.
      if (!candidate || candidate.metadata?.generation !== written?.metadata?.generation
        || candidate.metadata?.contentHash !== written?.metadata?.contentHash) { increment('shadow_revision_skips'); return; }
      increment(digest(cftcSnapshotIdentity(key, candidate.payload)) === digest(cftcSnapshotIdentity(key, envelope)) ? 'shadow_matches' : 'shadow_mismatches');
    } catch { increment('read_failures'); }
  }

  async function save({ key, claim, envelope, rawHistories = [], latestRows = [], validate, validateRaw, promoteLastGood = false }) {
    if (mode() === 'off' || !claim) return null;
    try {
      if (!validate?.(envelope) || rawHistories.some(item => !validateRaw?.(item))) throw persistenceError('CFTC_DURABLE_VALIDATION_FAILED');
      const response = envelope.response, family = response.report_family;
      const fields = new Set(CFTC_FAMILIES[family]?.fields || []);
      if (!Array.isArray(latestRows) || latestRows.length > 10_000 || latestRows.some(row => !row || typeof row !== 'object' || Array.isArray(row)
        || Object.entries(row).some(([field, value]) => !fields.has(field) || !(value == null || typeof value === 'number' && Number.isFinite(value)
          || typeof value === 'string' && Buffer.byteLength(value) <= 4096)))) throw persistenceError('CFTC_DURABLE_VALIDATION_FAILED');
      const rawCodes = new Set(rawHistories.map(item => item.code));
      const expectedCodes = response.selection ? [response.selection.contract] : response.latest.map(item => item.code);
      if (rawCodes.size !== rawHistories.length || promoteLastGood && (rawHistories.length < (response.cache_publication?.raw_history_expected || 0)
        || expectedCodes.some(code => !rawCodes.has(code)))) throw persistenceError('CFTC_DURABLE_RAW_HISTORY_MISSING');
      const reportPeriod = response.report_date || response.selection?.report_date;
      if (rawHistories.some(item => item.family !== family || item.through_date !== reportPeriod || item.report_basis !== CFTC_REPORT_BASIS)) throw persistenceError('CFTC_DURABLE_VALIDATION_FAILED');
      const bundle = cftcSourceBundle(rawHistories, latestRows);
      if (Buffer.byteLength(bundle.bytes) > MAX_SOURCE_BYTES) throw persistenceError('CFTC_DURABLE_SOURCE_TOO_LARGE');
      const record = await publish({ dataset: 'cftc', key, claim, payload: envelope, promoteLastGood,
        identityInputs: cftcSnapshotIdentity(key, envelope),
        metadata: {
          sourceUrl: response.source.url, sourceId: CFTC_FAMILIES[family].datasetId,
          entityId: response.selection?.contract || family, reportPeriod,
          fetchedAt: response.retrieved_at, publishedAt: null,
          revalidatedAt: envelope.savedAt,
          expiresAt: new Date(Date.parse(envelope.savedAt) + 26 * 3600_000).toISOString(),
          parserVersion: CFTC_SCHEMA_VERSION, calculationVersion: CFTC_CALCULATION_VERSION,
          reportBasis: CFTC_REPORT_BASIS, reportFamily: family,
          rawHistoryTimes: bundle.times,
        },
        source: { bytes: bundle.bytes, url: response.source.url, fetchedAt: response.retrieved_at, contentType: 'application/json' },
      });
      if (!record) throw persistenceError('CFTC_DURABLE_PUBLICATION_FAILED');
      increment('writes');
      await comparePublished(key, envelope, record);
      return record;
    } catch {
      increment('write_failures');
      if (mode() === 'supabase') throw persistenceError('CFTC_DURABLE_PUBLICATION_FAILED');
      return null;
    }
  }

  async function startRefreshJob(checkpoint) {
    if (mode() === 'off') return null;
    try {
      const started = Date.parse(checkpoint?.started_at);
      const anchor = Number.isFinite(started) && started <= now() && now() - started < 48 * 3600_000 ? started : now();
      const jobKey = `cftc-refresh:${new Date(anchor).toISOString().slice(0, 10)}`;
      // Recover a prior bounded job even when Redis lost its family checkpoint.
      // Only the two existing resume-horizon dates are considered; never scan jobs.
      const candidates = new Set([jobKey, ...[0, 1, 2].map(offset => `cftc-refresh:${new Date(now() - offset * 86400_000).toISOString().slice(0, 10)}`)]);
      for (const candidate of candidates) {
        const existing = await claimJob({ dataset: 'cftc', jobKey: candidate, leaseSeconds: 300 });
        if (existing) return existing;
      }
      await enqueueJob({ dataset: 'cftc', key: 'refresh:tff-disaggregated', jobKey, checkpoint: { refresh_checkpoint: checkpoint }, maxAttempts: 4 });
      return await claimJob({ dataset: 'cftc', jobKey, leaseSeconds: 300 });
    } catch { throw persistenceError('CFTC_DURABLE_JOB_UNAVAILABLE'); }
  }

  async function completeRefreshJob(claim, checkpoint, errorCode = null) {
    if (!claim) return;
    try {
      const stored = await finishJob(claim, { checkpoint: { refresh_checkpoint: checkpoint }, status: checkpoint.complete && !errorCode ? 'done' : 'retry', errorCode });
      if (!stored) throw persistenceError('CFTC_DURABLE_JOB_SUPERSEDED');
    } catch { throw persistenceError('CFTC_DURABLE_JOB_UNAVAILABLE'); }
  }

  async function checkpointRefreshJob(claim, checkpoint) {
    if (!claim) return;
    try {
      await checkpointJob(claim, { checkpoint: { refresh_checkpoint: checkpoint }, leaseSeconds: 300 });
    } catch { throw persistenceError('CFTC_DURABLE_JOB_UNAVAILABLE'); }
  }

  return { mode, reserve, prepared, raw, save, startRefreshJob, completeRefreshJob, checkpointRefreshJob,
    status: () => ({ mode: mode(), scope: 'current-process', comparison_limit_per_hour: MAX_COMPARISONS_PER_HOUR, ...counters }),
  };
}

export const cftcPersistence = createCftcPersistence();
