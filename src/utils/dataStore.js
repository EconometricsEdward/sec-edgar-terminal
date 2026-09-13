/** Server-only durable public-data persistence. No browser/Supabase client SDK. */
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { getDataStoreIdentityToken } from './dataStoreIdentity.js';
import { promisify } from 'node:util';
import { DATA_STORE_LIMITS as LIMITS, DATA_STORE_REGISTRY, getDataStoreMode, validateDataStoreSource } from './dataStoreRegistry.js';
export { DATA_STORE_LIMITS, DATA_STORE_REGISTRY, getDataStoreMode } from './dataStoreRegistry.js';

const PRODUCTION_PROJECT = 'vvkihuduqqnxqahhbphs';
const BUCKET = 'edgar-durable-private';
const TRANSIENT_IDENTITY_FIELDS = new Set(['fetchedAt', 'retrievedAt', 'revalidatedAt', 'generatedAt', 'expiresAt']);
const unzip = promisify(gunzip);
// Only immutable, hash-verified JSON content is cached. Dataset heads, source
// age, revalidation and expiry are read from Postgres on every request. The byte
// budget measures decoded JSON input; parsed JavaScript objects use extra heap.
const OBJECT_CACHE = Object.freeze({ entries: 32, inputBytes: 32 * 1024 * 1024, entryBytes: 8 * 1024 * 1024, ttlMs: 60000, pending: 32 });
const SEC_DISPATCH_OPERATIONS = new Set(['edgar_acquire_sec_dispatch', 'edgar_release_sec_dispatch', 'edgar_publish_sec_cooldown']);
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function freezeJson(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

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
  const secret = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  const oidc = !secret && env.VERCEL_ENV === 'production';
  const rawUrl = env.SUPABASE_URL || (oidc ? `https://${PRODUCTION_PROJECT}.supabase.co` : undefined);
  if (!rawUrl || (!secret && !oidc)) throw new DataStoreError('not_configured');
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
  if (oidc && local) throw new DataStoreError('unapproved_identity_endpoint', 403);
  return { url: url.origin, secret, namespace, oidc,
    cacheScope: oidc ? 'vercel:prj_tjTGC2omKa1JOT7il31bFZ8ilk8f:production' : dataStoreContentHash(secret) };
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
function membershipClaimArguments(claim) {
  const generation = claim?.generation;
  if (!claim || typeof claim.owner !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(claim.owner)
    || !(typeof generation === 'string' && /^[1-9]\d{0,18}$/.test(generation)
      || Number.isSafeInteger(generation) && generation > 0)
    || BigInt(generation) > 9223372036854775807n) throw new DataStoreError('invalid_claim', 409);
  return { generation, owner: claim.owner };
}
function validCoverageCycle(cycle, shards) {
  return typeof cycle === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cycle) && Number.isFinite(Date.parse(cycle)) && new Date(cycle).toISOString().slice(0, 10) === cycle
    && (shards === null || Array.isArray(shards) && shards.length >= 1 && shards.length <= 32 && new Set(shards).size === shards.length
      && shards.every(shard => Number.isInteger(shard) && shard >= 0 && shard <= 31));
}

/** Injection is for local fixture/rehearsal tests; production uses the exports below. */
export function createDataStore({ env = process.env, fetchImpl = (...args) => fetch(...args), identityTokenImpl = getDataStoreIdentityToken } = {}) {
  const decodedObjects = new Map(), pendingObjects = new Map();
  let decodedInputBytes = 0;
  function enabled(dataset) { checkDataset(dataset); return getDataStoreMode(dataset, env) !== 'off'; }
  async function request(path, { method = 'POST', body, raw = false, allowDuplicate = false, timeoutMs = LIMITS.requestTimeoutMs, signal } = {}) {
    const config = getConfiguration(env);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {};
      // New secret keys authenticate with apikey. Legacy JWT service keys also
      // carry Authorization; never send a non-JWT secret as a bearer JWT.
      if (config.oidc) {
        headers.Authorization = `Bearer ${await identityTokenImpl()}`;
        headers['x-region'] = 'us-east-1';
      } else {
        headers.apikey = config.secret;
        if (!config.secret.startsWith('sb_secret_')) headers.Authorization = `Bearer ${config.secret}`;
      }
      if (body != null) headers['Content-Type'] = raw ? 'application/gzip' : 'application/json';
      const upload = raw && body != null && body.byteLength > LIMITS.compactBytes;
      const requestBody = body == null ? undefined : raw ? (upload ? Readable.toWeb(Readable.from([body])) : body) : JSON.stringify(body);
      if (!raw && requestBody && Buffer.byteLength(requestBody) > LIMITS.rpcBytes) throw new DataStoreError('request_too_large', 413);
      const prefix = config.oidc ? '/functions/v1/edgar-data-gateway' : '';
      const response = await fetchImpl(`${config.url}${prefix}${path}`, { method, headers, body: requestBody, ...(upload ? { duplex: 'half' } : {}),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, cache: 'no-store', redirect: 'error' });
      const bytes = await boundedBytes(response, method === 'GET' && raw ? LIMITS.objectBytes : LIMITS.rpcBytes);
      if (!response.ok && !(allowDuplicate && [400, 409].includes(response.status))) {
        let code; try { code = JSON.parse(bytes.toString()).code; } catch { /* omit untrusted API error text */ }
        throw new DataStoreError(code === '40001' ? 'stale_generation' : `http_${response.status}`, response.status);
      }
      if (raw && method === 'GET') return bytes;
      if (!bytes.length) return null;
      try { return JSON.parse(bytes.toString('utf8')); } catch { throw new DataStoreError('invalid_response', 502); }
    } catch (error) {
      if (env.VERCEL_ENV === 'production') {
        const operation = /^\/rest\/v1\/rpc\/(edgar_[a-z_]+)$/.exec(path)?.[1]
          || (method === 'GET' ? 'object_read' : 'object_write');
        console.warn('[Durable store] request failed', { operation,
          code: error instanceof DataStoreError ? error.code : error?.name === 'AbortError' ? 'timeout' : 'transport_failure' });
      }
      if (error instanceof DataStoreError) throw error;
      throw new DataStoreError(error?.name === 'AbortError' ? 'timeout' : 'transport_failure');
    } finally { clearTimeout(timeout); }
  }
  async function rpc(name, params = {}, { signal } = {}) {
    const config = getConfiguration(env);
    return request(`/rest/v1/rpc/${name}`, { body: { p_namespace: config.namespace, ...params }, signal,
      ...(name === 'edgar_stage_membership' ? { timeoutMs: 20000 } : SEC_DISPATCH_OPERATIONS.has(name) ? { timeoutMs: 2000 } : {}) });
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
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.contentHash || '') || !Number.isSafeInteger(Number(asset.rawBytes)) || Number(asset.rawBytes) <= 0 || asset.rawBytes > LIMITS.decodedBytes || !Number.isSafeInteger(Number(asset.storedBytes)) || Number(asset.storedBytes) <= 0 || asset.storedBytes > LIMITS.objectBytes) throw new DataStoreError('invalid_object_manifest', 502);
    const compressed = await request(`/storage/v1/object/authenticated/${BUCKET}/${safeObjectPath(asset.objectPath)}`, { method: 'GET', raw: true });
    let bytes;
    try { bytes = await unzip(compressed, { maxOutputLength: LIMITS.decodedBytes }); } catch { throw new DataStoreError('invalid_compressed_object', 502); }
    if (bytes.length !== Number(asset.rawBytes) || dataStoreContentHash(bytes) !== asset.contentHash) throw new DataStoreError('object_integrity_mismatch', 502);
    return bytes;
  }
  function removeDecoded(key) {
    const entry = decodedObjects.get(key);
    if (entry) { decodedInputBytes -= entry.inputBytes; decodedObjects.delete(key); }
  }
  async function readObjectPayload(asset) {
    const config = getConfiguration(env);
    const path = safeObjectPath(asset.objectPath);
    // Scope an instance even if its injected runtime configuration is changed.
    // Never retain a secret itself in a cache key or return it in diagnostics.
    const key = `${config.url}:${config.namespace}:${config.cacheScope}:${path}:${asset.contentHash}:${asset.rawBytes}:${asset.storedBytes}`;
    const now = Date.now();
    for (const [oldKey, entry] of decodedObjects) if (entry.until <= now) removeDecoded(oldKey);
    const cached = decodedObjects.get(key);
    if (cached) {
      decodedObjects.delete(key); decodedObjects.set(key, cached);
      return cached.content;
    }
    if (pendingObjects.has(key)) return pendingObjects.get(key);
    const pending = (async () => {
      const bytes = await readObject(asset);
      const serializedPayload = bytes.toString('utf8');
      let payload;
      try { payload = freezeJson(JSON.parse(serializedPayload)); } catch { throw new DataStoreError('invalid_snapshot_json', 502); }
      const content = Object.freeze({ payload, serializedPayload });
      if (bytes.length <= OBJECT_CACHE.entryBytes) {
        removeDecoded(key);
        while (decodedObjects.size >= OBJECT_CACHE.entries || decodedInputBytes + bytes.length > OBJECT_CACHE.inputBytes) removeDecoded(decodedObjects.keys().next().value);
        decodedObjects.set(key, { content, inputBytes: bytes.length, until: Date.now() + OBJECT_CACHE.ttlMs });
        decodedInputBytes += bytes.length;
      }
      return content;
    })();
    // Excess distinct requests remain bounded by each request's existing byte
    // and timeout limits; they do not grow the coalescing registry indefinitely.
    const tracked = pendingObjects.size < OBJECT_CACHE.pending;
    if (tracked) pendingObjects.set(key, pending);
    try { return await pending; }
    finally { if (tracked && pendingObjects.get(key) === pending) pendingObjects.delete(key); }
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
    let payload = row.payload, serializedPayload;
    if (row.objectPath) {
      ({ payload, serializedPayload } = await readObjectPayload(row));
    } else {
      serializedPayload = stableDataStoreJson(payload);
      if (dataStoreContentHash(serializedPayload) !== row.contentHash) throw new DataStoreError('compact_integrity_mismatch', 502);
    }
    const metadata = { ...row.metadata, contentHash: row.contentHash, identityHash: row.identityHash, versionId: row.id, generation: row.generation };
    if (row.revalidatedAt) metadata.revalidatedAt = row.revalidatedAt;
    if (row.expiresAt) metadata.expiresAt = row.expiresAt;
    return { payload, serializedPayload, metadata, stale: !!metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now(), _source: row.source || null };
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
  function batchKeys(dataset, keys) {
    checkDataset(dataset);
    if (!Array.isArray(keys) || keys.length > 100) throw new DataStoreError('invalid_batch_keys', 422);
    for (const key of keys) {
      if (key == null) throw new DataStoreError('invalid_resource_key', 422);
      checkDataset(dataset, key);
    }
  }
  /** Current pointers and selected provenance, without loading any source object. */
  async function readDatasetManifests(dataset, keys) {
    batchKeys(dataset, keys);
    if (!keys.length || !enabled(dataset)) return keys.map(() => null);
    const rows = await rpc('edgar_get_manifests', { p_dataset: dataset, p_keys: keys });
    if (!Array.isArray(rows) || rows.length !== keys.length || rows.some((row, i) => row !== null && (!row || typeof row !== 'object' || row.key !== keys[i]))) {
      throw new DataStoreError('invalid_manifest_batch', 502);
    }
    return rows.map(row => row === null ? null : { ...row, stale: !!row.expiresAt && Date.parse(row.expiresAt) <= Date.now() });
  }
  /** Compact serving rows only. Object-backed detail uses an explicit readDataset. */
  async function readDatasetBatch(dataset, keys, { allowStale = true } = {}) {
    batchKeys(dataset, keys);
    if (!keys.length || !enabled(dataset)) return keys.map(() => null);
    const output = new Array(keys.length);
    const batches = [];
    for (let offset = 0; offset < keys.length; offset += 5) batches.push({ offset, keys: keys.slice(offset, offset + 5) });
    const workers = Array.from({ length: Math.min(3, batches.length) }, async () => {
      while (batches.length) {
        const batch = batches.shift();
        const rows = await rpc('edgar_get_compact_batch', { p_dataset: dataset, p_keys: batch.keys });
        if (!Array.isArray(rows) || rows.length !== batch.keys.length || rows.some(row => row !== null && (!row || typeof row !== 'object' || row.objectPath != null || row.payload == null))) {
          throw new DataStoreError('invalid_compact_batch', 502);
        }
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          output[batch.offset + i] = !row || (!allowStale && row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) ? null : await envelope(row);
        }
      }
    });
    const completed = await Promise.allSettled(workers);
    const failure = completed.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return output;
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
  async function enqueueCoverageJobs({ cycle, version, shards = null }) {
    if (!enabled('sec')) return null;
    if (!validCoverageCycle(cycle, shards) || typeof version !== 'string' || !/^[a-f0-9]{16}$/.test(version)) {
      throw new DataStoreError('invalid_coverage_jobs', 422);
    }
    return rpc('edgar_enqueue_coverage_jobs', { p_cycle: cycle, p_version: version, p_shards: shards });
  }
  async function enqueueCurrentCoverageJobs({ cycle, shards = null }) {
    if (!enabled('sec')) return null;
    if (!validCoverageCycle(cycle, shards)) throw new DataStoreError('invalid_coverage_jobs', 422);
    return rpc('edgar_enqueue_current_coverage_jobs', { p_cycle: cycle, p_shards: shards });
  }
  async function beginCoverageMembershipCheck() {
    if (!enabled('sec') || !enabled('financial')) return null;
    return rpc('edgar_begin_membership_check', { p_owner: randomUUID() });
  }
  async function stageCoverageMembership(claim, snapshot, evidence) {
    if (!enabled('sec') || !enabled('financial')) return null;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new DataStoreError('invalid_membership', 422);
    // Canonical validation rejects non-finite numbers before JSON serialization
    // could silently replace them with null. Gateway and SQL validate semantics.
    stableDataStoreJson(snapshot); stableDataStoreJson(evidence);
    return rpc('edgar_stage_membership', { p_claim: membershipClaimArguments(claim), p_snapshot: snapshot, p_evidence: evidence });
  }
  async function activateCoverageMembership(claim, id) {
    if (!enabled('sec') || !enabled('financial')) return null;
    const match = typeof id === 'string' && /^sec-coverage-v1:ivv:(\d{4}-\d{2}-\d{2}):[a-f0-9]{16}$/.exec(id);
    if (!match || !validCoverageCycle(match[1], null)) throw new DataStoreError('invalid_membership', 422);
    return rpc('edgar_activate_membership', { p_claim: membershipClaimArguments(claim), p_id: id });
  }
  async function finishCoverageMembershipCheck(claim, error = null) {
    if (!enabled('sec') || !enabled('financial')) return false;
    const safeError = error === null ? null : typeof error === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(error) ? error : 'MEMBERSHIP_CHECK_FAILED';
    return rpc('edgar_finish_membership_check', { p_claim: membershipClaimArguments(claim), p_error: safeError });
  }
  async function readCoverageOperations({ hours = 24 } = {}) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new DataStoreError('invalid_hours', 422);
    return rpc('edgar_coverage_operations', { p_hours: hours });
  }
  async function acquireSecDispatchPermit(owner, { signal } = {}) {
    if (typeof owner !== 'string' || !UUID_PATTERN.test(owner)) throw new DataStoreError('invalid_sec_dispatch_owner', 422);
    if (signal?.aborted) throw new DataStoreError('sec_dispatch_aborted', 503);
    const result = await rpc('edgar_acquire_sec_dispatch', { p_owner: owner }, { signal });
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).some(key => !['allowed', 'owner', 'acquiredAt', 'expiresAt', 'leaseMs', 'waitMs', 'cooldown'].includes(key))
      || typeof result.allowed !== 'boolean' || typeof result.cooldown !== 'boolean' || result.leaseMs !== 5000
      || !Number.isSafeInteger(result.waitMs) || result.waitMs < 0 || result.waitMs > 600000
      || (result.allowed ? typeof result.owner !== 'string' || result.owner.toLowerCase() !== owner.toLowerCase() || result.waitMs !== 0 || result.cooldown
          || typeof result.acquiredAt !== 'string' || typeof result.expiresAt !== 'string'
          || !Number.isFinite(Date.parse(result.acquiredAt)) || Date.parse(result.expiresAt) - Date.parse(result.acquiredAt) !== 5000
        : result.owner !== null || result.acquiredAt !== null || result.expiresAt !== null || result.waitMs < 1)) throw new DataStoreError('invalid_sec_dispatch_response', 502);
    return result;
  }
  async function releaseSecDispatchPermit(owner, { cooldownMs = 0 } = {}) {
    if (typeof owner !== 'string' || !UUID_PATTERN.test(owner)) throw new DataStoreError('invalid_sec_dispatch_owner', 422);
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 300000) throw new DataStoreError('invalid_sec_cooldown', 422);
    const result = await rpc('edgar_release_sec_dispatch', { p_owner: owner, p_cooldown_ms: cooldownMs });
    if (typeof result !== 'boolean') throw new DataStoreError('invalid_sec_dispatch_response', 502);
    return result;
  }
  async function publishSecDispatchCooldown(delayMs) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 300000) throw new DataStoreError('invalid_sec_cooldown', 422);
    const result = await rpc('edgar_publish_sec_cooldown', { p_cooldown_ms: delayMs });
    if (typeof result !== 'boolean') throw new DataStoreError('invalid_sec_dispatch_response', 502);
    return result;
  }
  async function verifyCoverageScheduleSignature({ timestamp, nonce, signature }) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 1000000000 || timestamp > 9999999999
      || typeof nonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce)
      || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) throw new DataStoreError('invalid_schedule_signature',422);
    // This verifies only the fixed scheduler message and consumes its nonce.
    // The Vault signing key never crosses the RPC or gateway response boundary.
    return await rpc('edgar_authorize_coverage_schedule', { p_timestamp: timestamp, p_nonce: nonce, p_signature: signature }) === true;
  }
  async function claimDataStoreJob({ dataset, leaseSeconds = 120, jobKey = null, prefix = null }) {
    if (!enabled(dataset)) return null;
    if (prefix !== null) {
      if (jobKey !== null || dataset !== 'sec' || !['sec-financial-cohort-v1:', 'sec-coverage-v1:'].includes(prefix)) throw new DataStoreError('invalid_job_prefix', 422);
      return rpc('edgar_claim_job_prefix', { p_dataset: dataset, p_owner: randomUUID(), p_prefix: prefix, p_lease_seconds: leaseSeconds });
    }
    return rpc('edgar_claim_job', { p_dataset: dataset, p_owner: randomUUID(), p_lease_seconds: leaseSeconds, p_job_key: jobKey });
  }
  async function yieldDataStoreJob(claim, { checkpoint = {}, retryAfterSeconds = 1 } = {}) {
    claimArguments(claim);
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint) || Buffer.byteLength(stableDataStoreJson(checkpoint)) > 16384
      || !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 86400) throw new DataStoreError('invalid_job_yield', 422);
    return rpc('edgar_yield_job', { p_claim: { ...claimArguments(claim), id: claim.id }, p_checkpoint: checkpoint, p_delay_seconds: retryAfterSeconds });
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
    readDataset, readDatasetManifests, readDatasetBatch, beginDatasetWrite, publishDataset, revalidateDataset, releaseDatasetWrite,
    readDatasetVersion: async (dataset, key, identityHash) => {
      checkDataset(dataset, key); if (!enabled(dataset)) return null;
      if (!/^[a-f0-9]{64}$/.test(identityHash || '')) throw new DataStoreError('invalid_version_identity', 422);
      return envelope(await rpc('edgar_get_version', { p_dataset: dataset, p_key: key, p_identity: identityHash }));
    },
    readDatasetSource: (record) => record?._source ? readObject(record._source) : Promise.resolve(null),
    enqueueDataStoreJob, enqueueCoverageJobs, enqueueCurrentCoverageJobs,
    beginCoverageMembershipCheck, stageCoverageMembership, activateCoverageMembership, finishCoverageMembershipCheck,
    readCoverageRegistry: () => rpc('edgar_coverage_registry'),
    readCoverageOperations, captureCoverageOperations: () => rpc('edgar_capture_coverage_operations'),
    acquireSecDispatchPermit, releaseSecDispatchPermit, publishSecDispatchCooldown,
    verifyCoverageScheduleSignature, claimDataStoreJob, finishDataStoreJob, yieldDataStoreJob,
    checkpointDataStoreJob: async (claim, { checkpoint, leaseSeconds = 120 }) => {
      if (Buffer.byteLength(stableDataStoreJson(checkpoint)) > 16384) throw new DataStoreError('checkpoint_too_large', 413);
      const ok = await rpc('edgar_checkpoint_job', { p_claim: { ...claimArguments(claim), id: claim.id }, p_checkpoint: checkpoint, p_lease_seconds: leaseSeconds });
      if (!ok) throw new DataStoreError('stale_job_generation', 409);
      return true;
    },
    readDataStoreStatus: () => rpc('edgar_store_status'),
    readDataStoreCoverageStatus: () => rpc('edgar_coverage_status'),
    readFinancialMetrics: (versionId) => rpc('edgar_read_financial_metrics', { p_version: versionId }),
    exportDataStoreManifests: ({ after = null, limit = 100 } = {}) => rpc('edgar_export_manifests', { p_after: after, p_limit: Math.max(1, Math.min(100, limit)) }),
    dataStoreRetentionDryRun: ({ before = new Date(Date.now() - 30 * 86400000).toISOString(), limit = 100 } = {}) => rpc('edgar_retention_dry_run', { p_before: validTimestamp(before, true), p_limit: Math.max(1, Math.min(100, limit)) }),
    dataStoreOrphanDryRun: ({ before = new Date(Date.now() - 86400000).toISOString(), limit = 100 } = {}) => rpc('edgar_orphan_dry_run', { p_before: validTimestamp(before, true), p_limit: Math.max(1, Math.min(100, limit)) }),
  };
}
const defaultStore = createDataStore();
export const { readDataset, readDatasetManifests, readDatasetBatch, readDatasetVersion, beginDatasetWrite, publishDataset, revalidateDataset, releaseDatasetWrite, readDatasetSource, enqueueDataStoreJob, enqueueCoverageJobs, enqueueCurrentCoverageJobs, readCoverageRegistry, beginCoverageMembershipCheck, stageCoverageMembership, activateCoverageMembership, finishCoverageMembershipCheck, readCoverageOperations, captureCoverageOperations, acquireSecDispatchPermit, releaseSecDispatchPermit, publishSecDispatchCooldown, verifyCoverageScheduleSignature, claimDataStoreJob, finishDataStoreJob, yieldDataStoreJob, checkpointDataStoreJob, readDataStoreStatus, readDataStoreCoverageStatus, readFinancialMetrics, exportDataStoreManifests, dataStoreRetentionDryRun, dataStoreOrphanDryRun } = defaultStore;
