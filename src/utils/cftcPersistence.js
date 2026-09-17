import { createHash } from 'node:crypto';
import { beginDatasetWrite, checkpointDataStoreJob, claimDataStoreJob, enqueueDataStoreJob, finishDataStoreJob, getDataStoreMode, publishDataset, readDataset, readDatasetSource, releaseDatasetWrite } from './dataStore.js';
import { CFTC_CALCULATION_VERSION, CFTC_FAMILIES, CFTC_REPORT_BASIS, CFTC_SCHEMA_VERSION, cftcDate, isCftcContractCode, isCftcFamily } from './cftc.js';

const SOURCE_SCHEMA = 'edgar.cftc-source-bundle.v1';
const MAX_AGE_MS = 15 * 86400_000;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_COMPARISONS_PER_HOUR = 8;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const CATALOG_CACHE = Object.freeze({ entries: 2, bytes: 1024 * 1024, entryBytes: 512 * 1024, ttlMs: 60_000, pending: 2 });

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

function catalogSourceKey(family, source) {
  const rawBytes = Number(source?.rawBytes), storedBytes = Number(source?.storedBytes);
  if (!/^[a-f0-9]{64}$/.test(source?.contentHash || '')
    || typeof source.objectPath !== 'string'
    || !new RegExp(`^[a-z0-9_-]{1,48}/cftc/source/${source.contentHash}\\.json\\.gz$`).test(source.objectPath)
    || !Number.isSafeInteger(rawBytes) || rawBytes <= 0 || rawBytes > MAX_SOURCE_BYTES
    || !Number.isSafeInteger(storedBytes) || storedBytes <= 0 || storedBytes > 6 * 1024 * 1024) return null;
  return JSON.stringify([family, source.objectPath, source.contentHash, rawBytes, storedBytes]);
}

function validCatalogSourceRows(rows, family) {
  const fields = new Set(CFTC_FAMILIES[family].fields);
  return Array.isArray(rows) && rows.length <= 1000 && rows.every(row => row && typeof row === 'object' && !Array.isArray(row)
    && Object.entries(row).every(([field, value]) => fields.has(field)
      && (value == null || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && Buffer.byteLength(value) <= 4096)));
}

export function cftcContractRawKey({ family, code, throughDate }) {
  if (!isCftcFamily(family) || !isCftcContractCode(code) || cftcDate(throughDate) !== throughDate) throw persistenceError('CFTC_DURABLE_VALIDATION_FAILED');
  return `raw-history-v1:futures-only:${family}:${code}:${throughDate}`;
}

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
  read = readDataset, publish = publishDataset, readSource = readDatasetSource, release = releaseDatasetWrite,
  enqueueJob = enqueueDataStoreJob, claimJob = claimDataStoreJob, finishJob = finishDataStoreJob, checkpointJob = checkpointDataStoreJob,
  now = () => Date.now(),
} = {}) {
  let comparisonHour = -1, comparisons = 0;
  // Cache only verified immutable catalog rows. The authorized current head and
  // its freshness are checked separately on every read, including cache hits.
  const catalogs = new Map(), pendingCatalogs = new Map();
  let catalogBytes = 0;
  const counters = { writes: 0, write_failures: 0, read_failures: 0, shadow_matches: 0, shadow_mismatches: 0, shadow_revision_skips: 0 };
  const increment = key => { counters[key] = Math.min(MAX_COUNTER, counters[key] + 1); };

  function removeCatalog(key) {
    const entry = catalogs.get(key);
    if (entry) { catalogBytes -= entry.bytes; catalogs.delete(key); }
  }

  function expireCatalogs() {
    for (const [key, entry] of catalogs) if (entry.until <= now()) removeCatalog(key);
  }

  async function catalogRows(record, family) {
    const descriptor = record._source ? { ...record._source } : null;
    const key = catalogSourceKey(family, descriptor);
    expireCatalogs();
    const cached = key && catalogs.get(key);
    if (cached) {
      catalogs.delete(key); catalogs.set(key, cached);
      return cached.rows;
    }
    if (key && pendingCatalogs.has(key)) return pendingCatalogs.get(key);
    const task = (async () => {
      const bytes = await readSource(key ? { ...record, _source: descriptor } : record);
      if (!bytes || bytes.byteLength > MAX_SOURCE_BYTES) return null;
      if (key && (bytes.byteLength !== Number(descriptor.rawBytes)
        || createHash('sha256').update(bytes).digest('hex') !== descriptor.contentHash)) return null;
      const source = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (source?.schema_version !== SOURCE_SCHEMA || !validCatalogSourceRows(source.latestRows, family)) return null;
      const rows = Object.freeze(source.latestRows.map(row => Object.freeze(row)));
      const rowBytes = Buffer.byteLength(JSON.stringify(rows));
      if (key && rowBytes <= CATALOG_CACHE.entryBytes) {
        expireCatalogs(); removeCatalog(key);
        while (catalogs.size >= CATALOG_CACHE.entries || catalogBytes + rowBytes > CATALOG_CACHE.bytes) removeCatalog(catalogs.keys().next().value);
        catalogs.set(key, { rows, bytes: rowBytes, until: now() + CATALOG_CACHE.ttlMs });
        catalogBytes += rowBytes;
      }
      return rows;
    })();
    const tracked = key && pendingCatalogs.size < CATALOG_CACHE.pending;
    if (tracked) pendingCatalogs.set(key, task);
    try { return await task; }
    finally { if (tracked && pendingCatalogs.get(key) === task) pendingCatalogs.delete(key); }
  }

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

  /** One contract archive is shared across participant groups and chart windows. */
  async function reserveContractRaw(selection) {
    return reserve(cftcContractRawKey(selection));
  }

  async function releaseContractRaw(selection, claim) {
    if (mode() === 'off' || !claim) return false;
    try { return await release('cftc', cftcContractRawKey(selection), claim); }
    catch { return false; }
  }

  async function contractRaw({ family, code, throughDate, validate, pointer = 'current' }) {
    if (mode() !== 'supabase') return null;
    try {
      const record = await read('cftc', cftcContractRawKey({ family, code, throughDate }), { allowStale: true, pointer });
      if (!record || record.metadata?.reportPeriod !== throughDate || record.metadata?.reportFamily !== family || record.metadata?.reportBasis !== CFTC_REPORT_BASIS || record.metadata?.entityId !== code) return null;
      const envelope = { ...record.payload, savedAt: validatedAt(record, record.metadata.originalSavedAt, now()), retrievedAt: record.metadata.originalRetrievedAt };
      return validate?.(envelope) ? envelope : null;
    } catch { increment('read_failures'); return null; }
  }

  async function saveContractRaw({ claim, envelope, validate, promoteLastGood = false }) {
    if (mode() === 'off' || !claim) return null;
    try {
      if (!validate?.(envelope) || envelope?.report_basis !== CFTC_REPORT_BASIS) throw persistenceError('CFTC_DURABLE_VALIDATION_FAILED');
      const { family, code, through_date: throughDate, savedAt, retrievedAt } = envelope;
      const { savedAt: _savedAt, retrievedAt: _retrievedAt, ...stable } = envelope;
      const key = cftcContractRawKey({ family, code, throughDate });
      const bytes = json(stable);
      if (Buffer.byteLength(bytes) > MAX_SOURCE_BYTES) throw persistenceError('CFTC_DURABLE_SOURCE_TOO_LARGE');
      const record = await publish({ dataset: 'cftc', key, claim, kind: 'source-document', payload: stable,
        identityInputs: { key, content: stable }, promoteLastGood,
        metadata: { sourceUrl: envelope.sourceUrl, sourceId: CFTC_FAMILIES[family].datasetId,
          entityId: code, reportPeriod: throughDate, fetchedAt: retrievedAt, publishedAt: null,
          revalidatedAt: savedAt, expiresAt: new Date(Date.parse(savedAt) + 26 * 3600_000).toISOString(),
          originalSavedAt: savedAt, originalRetrievedAt: retrievedAt,
          parserVersion: envelope.schema_version, calculationVersion: CFTC_CALCULATION_VERSION,
          reportBasis: CFTC_REPORT_BASIS, reportFamily: family },
        source: { bytes, url: envelope.sourceUrl, fetchedAt: retrievedAt, contentType: 'application/json' },
      });
      if (!record) throw persistenceError('CFTC_DURABLE_PUBLICATION_FAILED');
      increment('writes');
      return record;
    } catch {
      increment('write_failures');
      if (mode() === 'supabase') throw persistenceError('CFTC_DURABLE_PUBLICATION_FAILED');
      return null;
    }
  }

  /** The complete current catalog's source observations, including non-launch contracts. */
  async function catalogRaw(family, throughDate = null) {
    if (mode() !== 'supabase' || !isCftcFamily(family)) return null;
    try {
      const record = await read('cftc', `markets:${family}:latest`, { allowStale: true });
      const response = record?.payload?.response;
      const savedAt = validatedAt(record, record?.payload?.savedAt, now());
      const age = now() - Date.parse(savedAt);
      if (!record || response?.report_family !== family || response.report_basis !== CFTC_REPORT_BASIS
        || response.schema_version !== CFTC_SCHEMA_VERSION || response.calculation_version !== CFTC_CALCULATION_VERSION
        || record.metadata?.reportFamily !== family || record.metadata?.reportBasis !== CFTC_REPORT_BASIS
        || record.metadata?.reportPeriod !== response.report_date
        || cftcDate(response.report_date) !== response.report_date || response.report_date > new Date(now()).toISOString().slice(0, 10)
        || throughDate && response.report_date !== throughDate
        || age < 0 || age >= MAX_AGE_MS || !Number.isFinite(age)) return null;
      const rows = await catalogRows(record, family);
      if (!rows) return null;
      return { family, report_basis: CFTC_REPORT_BASIS, report_date: response.report_date,
        savedAt, retrievedAt: response.retrieved_at, rows,
        contentHash: record.metadata?.contentHash, generation: record.metadata?.generation };
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
      const sourcePeriod = response.retrieval?.source_report_date || reportPeriod;
      if (rawHistories.some(item => item.family !== family || item.through_date !== sourcePeriod || item.report_basis !== CFTC_REPORT_BASIS)) throw persistenceError('CFTC_DURABLE_VALIDATION_FAILED');
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

  return { mode, reserve, prepared, raw, save, reserveContractRaw, releaseContractRaw, contractRaw, saveContractRaw, catalogRaw, startRefreshJob, completeRefreshJob, checkpointRefreshJob,
    status: () => ({ mode: mode(), scope: 'current-process', comparison_limit_per_hour: MAX_COMPARISONS_PER_HOUR, ...counters,
      catalog_cache: { entries: catalogs.size, bytes: catalogBytes, pending: pendingCatalogs.size, limits: CATALOG_CACHE } }),
  };
}

export const cftcPersistence = createCftcPersistence();
