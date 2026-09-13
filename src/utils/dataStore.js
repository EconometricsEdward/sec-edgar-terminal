/** Server-only durable public-data persistence. No browser/Supabase client SDK. */
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { DATA_STORE_LIMITS as LIMITS, DATA_STORE_REGISTRY, getDataStoreMode, validateDataStoreSource } from './dataStoreRegistry.js';
export { DATA_STORE_LIMITS, DATA_STORE_REGISTRY, getDataStoreMode } from './dataStoreRegistry.js';

const PRODUCTION_PROJECT = 'vvkihuduqqnxqahhbphs';
const BUCKET = 'edgar-durable-private';
const TRANSIENT_IDENTITY_FIELDS = new Set(['fetchedAt', 'retrievedAt', 'revalidatedAt', 'generatedAt', 'expiresAt']);

export class DataStoreError extends Error {
  constructor(code, status = 503) { super(`Durable data store: ${code}`); this.name = 'DataStoreError'; this.code = code; this.status = status; }
}
function canonical(value, stripTransient = false) {
  if (Array.isArray(value)) return value.map((item) => canonical(item, stripTransient));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => !stripTransient || !TRANSIENT_IDENTITY_FIELDS.has(key)).map((key) => [key, canonical(value[key], stripTransient)]));
  if (typeof value === 'number' && !Number.isFinite(value)) throw new DataStoreError('non_finite_value', 422);
  return value;
}
export function stableDataStoreJson(value, { stripTransient = false } = {}) {
  const text = JSON.stringify(canonical(value, stripTransient));
  if (typeof text !== 'string') throw new DataStoreError('invalid_json', 422);
  return text;
}
export function dataStoreContentHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function validTimestamp(value, required = false) {
  if (value == null && !required) return null;
  if (!value || !Number.isFinite(Date.parse(value))) throw new DataStoreError('invalid_timestamp', 422);
  return new Date(value).toISOString();
}
function checkDataset(dataset, key) {
  if (!Object.hasOwn(DATA_STORE_REGISTRY, dataset)) throw new DataStoreError('unregistered_dataset', 422);
  if (key != null && (typeof key !== 'string' || !key.length || key.length > 512)) throw new DataStoreError('invalid_resource_key', 422);
}
function getConfiguration(env) {
  if (typeof window !== 'undefined') throw new DataStoreError('server_only', 403);
  const rawUrl = env.SUPABASE_URL;
  const secret = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !secret) throw new DataStoreError('not_configured');
  let url;
  try { url = new URL(rawUrl); } catch { throw new DataStoreError('invalid_endpoint'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const isProductionProject = url.hostname === `${PRODUCTION_PROJECT}.supabase.co`;
  if ((!local && (!isProductionProject || url.protocol !== 'https:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new DataStoreError('unapproved_endpoint', 403);
  // A namespace is not a security boundary for a privileged production key.
  // Untrusted Vercel previews must use fixtures; production credentials are denied
  // even if someone mistakenly injects them into a Preview deployment.
  if (env.VERCEL_ENV === 'preview' && !local) throw new DataStoreError('preview_production_credentials_denied', 403);
  if (!local && env.VERCEL_ENV !== 'production' && env.EDGAR_DATASTORE_TRUSTED_INGEST !== '1') throw new DataStoreError('untrusted_runtime', 403);
  const namespace = env.EDGAR_DATASTORE_NAMESPACE || (env.VERCEL_ENV === 'production' ? 'production' : 'rehearsal');
  if (!/^[a-z0-9_-]{1,48}$/.test(namespace)) throw new DataStoreError('invalid_namespace', 422);
  if (env.VERCEL_ENV === 'production' && namespace !== 'production') throw new DataStoreError('production_namespace_mismatch', 403);
  return { url: url.origin, secret, namespace };
}
async function boundedBytes(response, maxBytes) {
  const announced = Number(response.headers.get('content-length'));
  if (announced > maxBytes) { await response.body?.cancel(); throw new DataStoreError('response_too_large', 502); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new DataStoreError('response_too_large', 502);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); }
}
function pack(bytes) {
  if (!bytes.length || bytes.length > LIMITS.decodedBytes) throw new DataStoreError('source_too_large', 413);
  const gzip = gzipSync(bytes, { level: 6 });
  if (gzip.length > LIMITS.objectBytes) throw new DataStoreError('compressed_source_too_large', 413);
  return gzip;
}
function sourceBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new DataStoreError('invalid_source_bytes', 422);
}
function claimArguments(claim) {
  if (!claim || !Number.isSafeInteger(Number(claim.generation)) || Number(claim.generation) < 1 || !/^[a-f0-9-]{36}$/i.test(claim.owner || '')) throw new DataStoreError('invalid_claim', 409);
  return { generation: claim.generation, owner: claim.owner };
}

/** Injection is for local fixture/rehearsal tests; production uses the exports below. */
export function createDataStore({ env = process.env, fetchImpl = (...args) => fetch(...args) } = {}) {
  function enabled(dataset) { checkDataset(dataset); return getDataStoreMode(dataset, env) !== 'off'; }
  async function request(path, { method = 'POST', body, raw = false, allowDuplicate = false } = {}) {
    const config = getConfiguration(env);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIMITS.requestTimeoutMs);
    try {
      const headers = { apikey: config.secret };
      // New secret keys authenticate with apikey. Legacy JWT service keys also
      // carry Authorization; never send a non-JWT secret as a bearer JWT.
      if (!config.secret.startsWith('sb_secret_')) headers.Authorization = `Bearer ${config.secret}`;
      if (body != null) headers['Content-Type'] = raw ? 'application/gzip' : 'application/json';
      const upload = raw && body != null && body.byteLength > LIMITS.compactBytes;
      const requestBody = body == null ? undefined : raw ? (upload ? Readable.toWeb(Readable.from([body])) : body) : JSON.stringify(body);
      if (!raw && requestBody && Buffer.byteLength(requestBody) > LIMITS.rpcBytes) throw new DataStoreError('request_too_large', 413);
      const response = await fetchImpl(`${config.url}${path}`, { method, headers, body: requestBody, ...(upload ? { duplex: 'half' } : {}), signal: controller.signal, cache: 'no-store', redirect: 'error' });
      const bytes = await boundedBytes(response, method === 'GET' && raw ? LIMITS.objectBytes : LIMITS.rpcBytes);
      if (!response.ok && !(allowDuplicate && [400, 409].includes(response.status))) {
        let code; try { code = JSON.parse(bytes.toString()).code; } catch { /* omit untrusted API error text */ }
        throw new DataStoreError(code === '40001' ? 'stale_generation' : `http_${response.status}`, response.status);
      }
      if (raw && method === 'GET') return bytes;
      if (!bytes.length) return null;
      try { return JSON.parse(bytes.toString('utf8')); } catch { throw new DataStoreError('invalid_response', 502); }
    } catch (error) {
      if (error instanceof DataStoreError) throw error;
      throw new DataStoreError(error?.name === 'AbortError' ? 'timeout' : 'transport_failure');
    } finally { clearTimeout(timeout); }
  }
  async function rpc(name, params = {}) {
    const config = getConfiguration(env);
    return request(`/rest/v1/rpc/${name}`, { body: { p_namespace: config.namespace, ...params } });
  }
  function pathFor(dataset, type, hash) {
    const { namespace } = getConfiguration(env);
    return `${namespace}/${dataset}/${type}/${hash}.json.gz`;
  }
  function safeObjectPath(path) {
    const { namespace } = getConfiguration(env);
    if (typeof path !== 'string' || !path.startsWith(`${namespace}/`) || !/^[a-z0-9_/-]+\/[a-f0-9]{64}\.json\.gz$/.test(path)) throw new DataStoreError('invalid_object_reference', 502);
    return path.split('/').map(encodeURIComponent).join('/');
  }
  async function readObject(asset) {
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.contentHash || '') || asset.rawBytes > LIMITS.decodedBytes || asset.storedBytes > LIMITS.objectBytes) throw new DataStoreError('invalid_object_manifest', 502);
    const compressed = await request(`/storage/v1/object/authenticated/${BUCKET}/${safeObjectPath(asset.objectPath)}`, { method: 'GET', raw: true });
    let bytes;
    try { bytes = gunzipSync(compressed, { maxOutputLength: LIMITS.decodedBytes }); } catch { throw new DataStoreError('invalid_compressed_object', 502); }
    if (bytes.length !== Number(asset.rawBytes) || dataStoreContentHash(bytes) !== asset.contentHash) throw new DataStoreError('object_integrity_mismatch', 502);
    return bytes;
  }
  async function putVerifiedObject(dataset, kind, bytes, hash = dataStoreContentHash(bytes)) {
    const compressed = pack(bytes); const objectPath = pathFor(dataset, kind, hash);
    await request(`/storage/v1/object/${BUCKET}/${safeObjectPath(objectPath)}`, { raw: true, body: compressed, allowDuplicate: true });
    const asset = { objectPath, contentHash: hash, rawBytes: bytes.length, storedBytes: compressed.length };
    // A successful upload response is not sufficient to publish a pointer.
    await readObject(asset);
    return asset;
  }
  async function envelope(row) {
    if (!row) return null;
    let payload = row.payload;
    if (row.objectPath) {
      const bytes = await readObject(row);
      try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw new DataStoreError('invalid_snapshot_json', 502); }
    } else if (dataStoreContentHash(stableDataStoreJson(payload)) !== row.contentHash) {
      throw new DataStoreError('compact_integrity_mismatch', 502);
    }
    const metadata = { ...row.metadata, contentHash: row.contentHash, identityHash: row.identityHash, versionId: row.id, generation: row.generation };
    if (row.revalidatedAt) metadata.revalidatedAt = row.revalidatedAt;
    if (row.expiresAt) metadata.expiresAt = row.expiresAt;
    return { payload, metadata, stale: !!metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now(), _source: row.source || null };
  }
  async function readDataset(dataset, key, { allowStale = true, pointer = 'current' } = {}) {
    checkDataset(dataset, key); if (!enabled(dataset)) return null;
    if (!['current', 'last-good', 'rollback'].includes(pointer)) throw new DataStoreError('invalid_pointer', 422);
    const row = await rpc('edgar_get_version', { p_dataset: dataset, p_key: key, p_pointer: pointer });
    if (!row) return null;
    if (!allowStale && row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null;
    return envelope(row);
  }
  async function beginDatasetWrite(dataset, key, { leaseSeconds = 120 } = {}) {
    checkDataset(dataset, key); if (!enabled(dataset)) return null;
    return rpc('edgar_begin_write', { p_dataset: dataset, p_key: key, p_owner: randomUUID(), p_lease_seconds: Math.max(10, Math.min(900, Math.floor(leaseSeconds))) });
  }
  async function publishDataset({ dataset, key, claim, payload, metadata = {}, source, kind = 'snapshot', promoteLastGood = true, observations = [], identityInputs }) {
    checkDataset(dataset, key); if (!enabled(dataset)) return null;
    const token = claimArguments(claim);
    if (claim.dataset !== dataset || claim.key !== key) throw new DataStoreError('claim_resource_mismatch', 409);
    if (!['snapshot', 'source-document'].includes(kind)) throw new DataStoreError('invalid_asset_kind', 422);
    const fetchedAt = validTimestamp(metadata.fetchedAt, true);
    const cleanMetadata = { ...metadata, fetchedAt, ...(metadata.publishedAt ? { publishedAt: validTimestamp(metadata.publishedAt) } : {}), ...(metadata.expiresAt ? { expiresAt: validTimestamp(metadata.expiresAt) } : {}) };
    if (metadata.sourceUrl) validateDataStoreSource(dataset, metadata.sourceUrl);
    if (Buffer.byteLength(JSON.stringify(cleanMetadata, null, 1)) > LIMITS.metadataBytes) throw new DataStoreError('metadata_too_large', 413);
    if (!Array.isArray(observations) || observations.length > LIMITS.observations) throw new DataStoreError('too_many_observations', 413);
    // Check numeric NaN/Infinity before JSON can turn them into misleading nulls.
    stableDataStoreJson(observations);
    const payloadBytes = Buffer.from(stableDataStoreJson(payload));
    if (!payloadBytes.length || payloadBytes.length > LIMITS.decodedBytes) throw new DataStoreError('snapshot_too_large', 413);
    let sourceBytes; let sourceHash;
    if (source) {
      validateDataStoreSource(dataset, source.url);
      validTimestamp(source.fetchedAt || fetchedAt, true);
      sourceBytes = sourceBuffer(source.bytes);
      if (!sourceBytes.length || sourceBytes.length > LIMITS.decodedBytes) throw new DataStoreError('source_too_large', 413);
      sourceHash = dataStoreContentHash(sourceBytes);
    }
    if (kind === 'source-document') {
      if (!sourceBytes) throw new DataStoreError('source_document_bytes_required', 422);
      let sourceJson; try { sourceJson = JSON.parse(sourceBytes.toString('utf8')); } catch { throw new DataStoreError('invalid_source_json', 422); }
      if (stableDataStoreJson(sourceJson) !== payloadBytes.toString()) throw new DataStoreError('source_payload_mismatch', 422);
    }
    const identityBody = identityInputs == null ? { payload, metadata: cleanMetadata, sourceHash: sourceHash || null, schemaVersion: DATA_STORE_REGISTRY[dataset].schemaVersion, kind }
      : { identityInputs, sourceHash: sourceHash || null, schemaVersion: DATA_STORE_REGISTRY[dataset].schemaVersion, kind };
    const identityHash = dataStoreContentHash(stableDataStoreJson(identityBody, { stripTransient: identityInputs == null }));
    const existing = await rpc('edgar_get_version', { p_dataset: dataset, p_key: key, p_identity: identityHash });
    let record;
    if (existing) {
      // An unchanged response reuses both manifest and original object. Retrieval
      // metadata is updated on the head; immutable evidence keeps its first age.
      record = { identityHash, metadata: cleanMetadata };
    } else {
      let sourceAsset;
      if (sourceBytes) sourceAsset = { ...await putVerifiedObject(dataset, 'source', sourceBytes, sourceHash), url: source.url, fetchedAt: source.fetchedAt || fetchedAt, publishedAt: source.publishedAt || null, contentType: source.contentType || 'application/json' };
      let stored;
      if (kind === 'source-document') stored = { ...sourceAsset, payload: null };
      else if (Buffer.byteLength(JSON.stringify(payload, null, 1)) <= LIMITS.compactBytes) stored = { payload: JSON.parse(payloadBytes.toString()), contentHash: dataStoreContentHash(payloadBytes), rawBytes: payloadBytes.length, storedBytes: payloadBytes.length };
      else stored = { ...await putVerifiedObject(dataset, 'snapshot', payloadBytes), payload: null };
      record = { ...stored, identityHash, schemaVersion: DATA_STORE_REGISTRY[dataset].schemaVersion, metadata: cleanMetadata, source: sourceAsset || null, observations };
    }
    await rpc('edgar_publish', { p_dataset: dataset, p_key: key, p_claim: token, p_record: record, p_promote_good: !!promoteLastGood });
    return envelope(await rpc('edgar_get_version', { p_dataset: dataset, p_key: key, p_identity: identityHash }));
  }
  async function revalidateDataset(dataset, key, { claim, revalidatedAt, expiresAt, etag, lastModified }) {
    checkDataset(dataset, key); if (!enabled(dataset)) return null;
    if (claim.dataset !== dataset || claim.key !== key) throw new DataStoreError('claim_resource_mismatch', 409);
    const ok = await rpc('edgar_revalidate', { p_dataset: dataset, p_key: key, p_claim: claimArguments(claim), p_metadata: { revalidatedAt: validTimestamp(revalidatedAt, true), expiresAt: validTimestamp(expiresAt), ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) } });
    if (!ok) throw new DataStoreError('stale_generation', 409);
    return true;
  }
  async function releaseDatasetWrite(dataset, key, claim) {
    checkDataset(dataset, key); if (!enabled(dataset) || !claim) return false;
    return rpc('edgar_release_write', { p_dataset: dataset, p_key: key, p_claim: claimArguments(claim) });
  }
  async function enqueueDataStoreJob({ dataset, key, jobKey, checkpoint = {}, maxAttempts = 4 }) {
    checkDataset(dataset, key); if (!enabled(dataset)) return null;
    if (Buffer.byteLength(stableDataStoreJson(checkpoint)) > 16384) throw new DataStoreError('checkpoint_too_large', 413);
    return rpc('edgar_enqueue_job', { p_dataset: dataset, p_key: key, p_job_key: jobKey, p_checkpoint: checkpoint, p_max_attempts: maxAttempts });
  }
  async function claimDataStoreJob({ dataset, leaseSeconds = 120, jobKey = null }) {
    if (!enabled(dataset)) return null;
    return rpc('edgar_claim_job', { p_dataset: dataset, p_owner: randomUUID(), p_lease_seconds: leaseSeconds, p_job_key: jobKey });
  }
  async function finishDataStoreJob(claim, { checkpoint = {}, status = 'done', errorCode = null, retryAfterSeconds = 0 } = {}) {
    claimArguments(claim);
    const backoff = Math.min(3600, 15 * 2 ** Math.min(claim.attempts || 1, 8));
    const delay = Math.max(Number(retryAfterSeconds) || 0, Math.floor(backoff + Math.random() * backoff * 0.25));
    // Store a small machine code, never exception bodies, URLs, or credentials.
    const safeError = errorCode ? String(errorCode).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) : null;
    return rpc('edgar_finish_job', { p_claim: { ...claimArguments(claim), id: claim.id }, p_status: delay > 2147483647 ? 'dead' : status, p_checkpoint: checkpoint, p_error: delay > 2147483647 ? 'retry_after_requires_manual_review' : safeError, p_delay_seconds: Math.min(2147483647, delay) });
  }
  return {
    readDataset, beginDatasetWrite, publishDataset, revalidateDataset, releaseDatasetWrite,
    readDatasetVersion: async (dataset, key, identityHash) => {
      checkDataset(dataset, key); if (!enabled(dataset)) return null;
      if (!/^[a-f0-9]{64}$/.test(identityHash || '')) throw new DataStoreError('invalid_version_identity', 422);
      return envelope(await rpc('edgar_get_version', { p_dataset: dataset, p_key: key, p_identity: identityHash }));
    },
    readDatasetSource: (record) => record?._source ? readObject(record._source) : Promise.resolve(null),
    enqueueDataStoreJob, claimDataStoreJob, finishDataStoreJob,
    checkpointDataStoreJob: async (claim, { checkpoint, leaseSeconds = 120 }) => {
      if (Buffer.byteLength(stableDataStoreJson(checkpoint)) > 16384) throw new DataStoreError('checkpoint_too_large', 413);
      const ok = await rpc('edgar_checkpoint_job', { p_claim: { ...claimArguments(claim), id: claim.id }, p_checkpoint: checkpoint, p_lease_seconds: leaseSeconds });
      if (!ok) throw new DataStoreError('stale_job_generation', 409);
      return true;
    },
    readDataStoreStatus: () => rpc('edgar_store_status'),
    readFinancialMetrics: (versionId) => rpc('edgar_read_financial_metrics', { p_version: versionId }),
    exportDataStoreManifests: ({ after = null, limit = 100 } = {}) => rpc('edgar_export_manifests', { p_after: after, p_limit: Math.max(1, Math.min(100, limit)) }),
    dataStoreRetentionDryRun: ({ before = new Date(Date.now() - 30 * 86400000).toISOString(), limit = 100 } = {}) => rpc('edgar_retention_dry_run', { p_before: validTimestamp(before, true), p_limit: Math.max(1, Math.min(100, limit)) }),
    dataStoreOrphanDryRun: ({ before = new Date(Date.now() - 86400000).toISOString(), limit = 100 } = {}) => rpc('edgar_orphan_dry_run', { p_before: validTimestamp(before, true), p_limit: Math.max(1, Math.min(100, limit)) }),
  };
}
const defaultStore = createDataStore();
export const { readDataset, readDatasetVersion, beginDatasetWrite, publishDataset, revalidateDataset, releaseDatasetWrite, readDatasetSource, enqueueDataStoreJob, claimDataStoreJob, finishDataStoreJob, checkpointDataStoreJob, readDataStoreStatus, readFinancialMetrics, exportDataStoreManifests, dataStoreRetentionDryRun, dataStoreOrphanDryRun } = defaultStore;
