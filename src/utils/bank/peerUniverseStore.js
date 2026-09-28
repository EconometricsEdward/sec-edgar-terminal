import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { unstable_cache } from 'next/cache.js';
import { bankScopeStore, isBankScopeEnvironment } from './scopeStore.js';
import { BankDataError } from './errors.js';
import { PEER_MODEL_VERSION } from './peerSource.js';

const zip = promisify(gzip), unzip = promisify(gunzip);
const VERSION = 'bankscope-peer-universe-v2';
const MODEL = PEER_MODEL_VERSION;
const MAX_AGE = 300000;
const UNIVERSE_MAX_AGE = 86400000;
const MANIFEST_RETRY_AGE = 30000;
const MANIFEST_VERSION = `${VERSION}-manifest`;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_RAW_BYTES = 12 * 1024 * 1024;
const MAX_SHARED_BYTES = 1536 * 1024;
const quarter = value => typeof value === 'string' && /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(value);
const number = value => value === null || typeof value === 'number' && Number.isFinite(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

export function validPeerUniverse(data, period) {
  if (!object(data) || data.error || data.code || !Array.isArray(data.profiles) || data.profiles.length > 15000) return false;
  if (!data.snapshot) return data.profiles.length === 0;
  const s = data.snapshot;
  if (!uuid(s.id) || s.report_date !== period || s.model_version !== MODEL || !Number.isFinite(Date.parse(s.completed_at))
    || !/^[a-f0-9]{64}$/.test(s.source_sha256 || '') || 'owner' in s
    || !Number.isSafeInteger(s.matched_count) || s.matched_count !== data.profiles.length || !s.matched_count) return false;
  const ids = new Set();
  return data.profiles.every(p => {
    if (!object(p) || !Number.isSafeInteger(p.rssd) || p.rssd <= 0 || ids.has(p.rssd)
      || !Number.isSafeInteger(p.cert) || p.cert <= 0 || typeof p.name !== 'string' || !p.name.trim()
      || 'raw_source' in p || !number(p.assets) || !number(p.loanShare)
      || ![null, true, false].includes(p.cblr) || !object(p.metrics)
      || Object.values(p.metrics).some(value => !number(value))) return false;
    ids.add(p.rssd);
    return [[p.loanMix, 4], [p.funding, 3]].every(([values, length]) => values === null
      || Array.isArray(values) && values.length === length && values.every(number));
  });
}

/** The lightweight SQL status operation returns publication metadata plus queue
 * counts. Retain only bounded snapshot metadata, never mutable queue details. */
function manifestSnapshots(data) {
  if (!object(data) || data.error || data.code || !Array.isArray(data.snapshots) || data.snapshots.length > 128) return null;
  const dates = new Set(), snapshots = [];
  for (const s of data.snapshots) {
    if (!object(s) || !quarter(s.report_date) || dates.has(s.report_date)
      || !Number.isFinite(Date.parse(s.completed_at))
      || !Number.isSafeInteger(s.matched_count) || s.matched_count < 1 || s.matched_count > 15000
      || typeof s.model_version !== 'string' || !s.model_version.length || s.model_version.length > 100
      || typeof s.source_index !== 'string' || !s.source_index.length || s.source_index.length > 512
      || s.source_updated_at !== null && !Number.isFinite(Date.parse(s.source_updated_at))) return null;
    dates.add(s.report_date);
    snapshots.push({ report_date: s.report_date, completed_at: new Date(Date.parse(s.completed_at)).toISOString(),
      matched_count: s.matched_count, model_version: s.model_version, source_index: s.source_index,
      source_updated_at: s.source_updated_at === null ? null : new Date(Date.parse(s.source_updated_at)).toISOString() });
  }
  return snapshots;
}

class UnsharedUniverse extends Error {
  constructor(data) {
    super('Public peer snapshot is not reusable in the shared cache.');
    Object.defineProperty(this, 'data', { value: data });
  }
}

/** Refresh the small publication manifest every five minutes. Reuse compressed
 * quarterly data by publication for a day; unchanged publications do not repeat
 * the expensive SQL aggregate. During source outages, an existing validated
 * publication remains usable for at most a day, with thirty-second recovery
 * checks and explicit stale metadata. Cold misses still require a healthy source.
 */
export function createBankPeerUniverse({ store = bankScopeStore, cache = unstable_cache, env = process.env,
  now = Date.now, maxSharedBytes = MAX_SHARED_BYTES } = {}) {
  const producing = new Map(), reading = new Map(), manifestReading = new Map(), recent = new Map(), failures = new Map();
  const previousManifests = new Map(), manifestSourceFailures = new Map(), sourceAllowedUntil = new Map();
  const scope = () => JSON.stringify([env.VERCEL_ENV, env.VERCEL_GIT_COMMIT_REF || '']);
  const manifestKey = deployment => `manifest:${deployment}`;
  const universeKey = (deployment, period, publication) => JSON.stringify(['universe', deployment, period, publication]);
  function failed(key) {
    if (failures.size >= 8) failures.delete(failures.keys().next().value);
    const retryAt = now() + 5000; failures.set(key, retryAt);
    return new BankDataError('database_failure', { retryAt: new Date(retryAt).toISOString() });
  }
  function guard(expectedScope) {
    if (typeof window !== 'undefined' || !isBankScopeEnvironment(env) || expectedScope !== scope()) throw new BankDataError('bank_service_unavailable');
  }
  function produceOnce(key, load) {
    const hit = recent.get(key);
    if (hit?.until > now()) return Promise.resolve(hit.value);
    if (producing.has(key)) return producing.get(key);
    if (failures.get(key) > now() || producing.size >= 8) return Promise.reject(new BankDataError('database_failure'));
    const task = (async () => {
      const value = await load();
      // Coalesce a cache's background refresh and the foreground hard-expiry
      // repair, including the case where writing a freshly produced entry fails.
      if (recent.size >= 8) recent.delete(recent.keys().next().value);
      recent.set(key, { value, until: now() + 2000 });
      return value;
    })().catch(error => { if (error instanceof UnsharedUniverse) throw error; throw failed(key); })
      .finally(() => producing.delete(key));
    producing.set(key, task);
    return task;
  }
  function produceManifest(deployment) {
    guard(deployment);
    const key = manifestKey(deployment);
    if (manifestSourceFailures.get(key) > now()) throw new BankDataError('database_failure');
    return produceOnce(manifestKey(deployment), async () => {
      let data;
      try { data = await store('peer_status'); }
      catch (error) {
        // Only an unavailable source permits reuse. A returned malformed
        // manifest must fail validation rather than hide behind an old entry.
        if (!(error instanceof BankDataError) || error.code === 'database_failure') {
          if (manifestSourceFailures.size >= 4 && !manifestSourceFailures.has(key)) manifestSourceFailures.delete(manifestSourceFailures.keys().next().value);
          manifestSourceFailures.set(key, now() + MANIFEST_RETRY_AGE);
        }
        throw error;
      }
      manifestSourceFailures.delete(key);
      const snapshots = manifestSnapshots(data);
      if (!snapshots) throw new BankDataError('database_failure');
      const value = { version: MANIFEST_VERSION, deployment, checkedAt: now(), snapshots };
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_MANIFEST_BYTES) throw new BankDataError('response_too_large');
      return value;
    });
  }
  function produceUniverse(deployment, period, publication) {
    guard(deployment);
    const key = universeKey(deployment, period, publication);
    // During a metadata outage, use only an already cached, validated snapshot.
    // Do not turn a stale manifest into a fresh expensive database read.
    if (!(sourceAllowedUntil.get(key) > now())) throw new BankDataError('database_failure');
    return produceOnce(key, async () => {
      const data = await store('peer_universe', { period });
      if (!validPeerUniverse(data, period)) throw new BankDataError('database_failure');
      if (!data.snapshot) throw new UnsharedUniverse(data);
      // A publication can advance between manifest and data reads. A newer
      // complete snapshot is safe; an older one must not masquerade as current.
      if (Date.parse(data.snapshot.completed_at) < publication) throw new BankDataError('database_failure');
      const raw = Buffer.from(JSON.stringify({ snapshot: data.snapshot, profiles: data.profiles }));
      if (raw.length > MAX_RAW_BYTES) throw new BankDataError('response_too_large');
      const packed = await zip(raw);
      const value = { version: VERSION, deployment, period, publication, checkedAt: now(), rawBytes: raw.length,
        sha256: hash(raw), gzipBase64: packed.toString('base64') };
      if (Buffer.byteLength(JSON.stringify(value)) > maxSharedBytes) throw new UnsharedUniverse(data);
      return value;
    });
  }
  const sharedManifest = cache(produceManifest, [MANIFEST_VERSION, MODEL], { revalidate: 300 });
  const sharedUniverse = cache(produceUniverse, [VERSION, MODEL], { revalidate: 86400 });
  async function cachedOrProduce(shared, produce, key, args) {
    try { return env.VERCEL_ENV === 'production' ? await shared(...args) : await produce(...args); }
    catch (error) {
      if (error instanceof UnsharedUniverse || failures.get(key) > now()) throw error;
      return produce(...args);
    }
  }
  function validManifest(entry, deployment, maxAge = MAX_AGE) {
    return object(entry) && entry.version === MANIFEST_VERSION && entry.deployment === deployment
      && Number.isFinite(entry.checkedAt) && now() - entry.checkedAt >= 0 && now() - entry.checkedAt < maxAge
      && Buffer.byteLength(JSON.stringify(entry)) <= MAX_MANIFEST_BYTES && manifestSnapshots(entry) !== null;
  }
  function retainManifest(key, entry) {
    if (previousManifests.size >= 4 && !previousManifests.has(key)) previousManifests.delete(previousManifests.keys().next().value);
    previousManifests.set(key, entry);
    return entry;
  }
  function staleManifest(key, entry, deployment) {
    const retryAt = manifestSourceFailures.get(key);
    return retryAt > now() && validManifest(entry, deployment, UNIVERSE_MAX_AGE)
      ? { ...entry, stale: true, retryAt: Math.min(retryAt, entry.checkedAt + UNIVERSE_MAX_AGE) } : null;
  }
  async function readManifest(deployment) {
    const key = manifestKey(deployment);
    if (manifestReading.has(key)) return manifestReading.get(key);
    const fallback = staleManifest(key, previousManifests.get(key), deployment);
    if (fallback) return fallback;
    if (failures.get(key) > now() || manifestReading.size >= 8) throw new BankDataError('database_failure');
    const task = (async () => {
      let candidate = previousManifests.get(key);
      try {
        let value = await cachedOrProduce(sharedManifest, produceManifest, key, [deployment]);
        candidate = validManifest(value, deployment, UNIVERSE_MAX_AGE) ? retainManifest(key, value) : null;
        if (!validManifest(value, deployment)) value = await produceManifest(deployment);
        if (!validManifest(value, deployment)) throw new BankDataError('database_failure');
        return retainManifest(key, value);
      } catch (error) {
        const stale = staleManifest(key, candidate, deployment);
        if (stale) return stale;
        throw error;
      }
    })().finally(() => manifestReading.delete(key));
    manifestReading.set(key, task);
    return task;
  }
  async function decode(entry, deployment, period, publication) {
    if (!object(entry) || entry.version !== VERSION || entry.deployment !== deployment || entry.period !== period
      || entry.publication !== publication || !Number.isFinite(entry.checkedAt)
      || now() - entry.checkedAt < 0 || now() - entry.checkedAt >= UNIVERSE_MAX_AGE
      || !Number.isSafeInteger(entry.rawBytes) || entry.rawBytes < 1 || entry.rawBytes > MAX_RAW_BYTES
      || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || typeof entry.gzipBase64 !== 'string'
      || entry.gzipBase64.length > maxSharedBytes || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.gzipBase64)) throw new BankDataError('database_failure');
    const raw = await unzip(Buffer.from(entry.gzipBase64, 'base64'), { maxOutputLength: MAX_RAW_BYTES });
    if (raw.length !== entry.rawBytes || hash(raw) !== entry.sha256) throw new BankDataError('database_failure');
    const data = JSON.parse(raw.toString('utf8'));
    if (!data.snapshot || !validPeerUniverse(data, period) || Date.parse(data.snapshot.completed_at) < publication) throw new BankDataError('database_failure');
    return data;
  }
  return async period => {
    const deployment = scope(); guard(deployment);
    if (!quarter(period)) throw new BankDataError('invalid_request', { status: 400 });
    const key = `${deployment}:${period}`;
    if (reading.has(key)) return structuredClone(await reading.get(key));
    if (failures.get(key) > now() || reading.size >= 8) throw new BankDataError('database_failure', { retryAt: new Date(now() + 5000).toISOString() });
    const task = (async () => {
      let manifest = await readManifest(deployment);
      let publication = manifest.snapshots.find(s => s.report_date === period && s.model_version === MODEL);
      // Preserve the existing short retry window for a not-yet-published period.
      if (!publication && !manifest.stale && now() - manifest.checkedAt >= 30000) {
        manifest = await produceManifest(deployment);
        publication = manifest.snapshots.find(s => s.report_date === period && s.model_version === MODEL);
      }
      const cacheExpiresAt = manifest.stale ? manifest.retryAt : manifest.checkedAt + MAX_AGE;
      const publicPeerCache = { checkedAt: new Date(manifest.checkedAt).toISOString(), stale: manifest.stale === true };
      if (manifest.stale && !publication) throw new BankDataError('database_failure');
      if (!publication) return { profiles: [], cacheExpiresAt: Math.min(cacheExpiresAt, now() + 30000) };
      const publishedAt = Date.parse(publication.completed_at), sourceKey = universeKey(deployment, period, publishedAt);
      if (!manifest.stale) {
        if (sourceAllowedUntil.size >= 8 && !sourceAllowedUntil.has(sourceKey)) sourceAllowedUntil.delete(sourceAllowedUntil.keys().next().value);
        sourceAllowedUntil.set(sourceKey, cacheExpiresAt);
      }
      try {
        const entry = await cachedOrProduce(sharedUniverse, produceUniverse, sourceKey, [deployment, period, publishedAt]);
        let data;
        try { data = await decode(entry, deployment, period, publishedAt); }
        catch { data = await decode(await produceUniverse(deployment, period, publishedAt), deployment, period, publishedAt); }
        return { ...data, cacheExpiresAt, publicPeerCache };
      } catch (error) {
        if (error instanceof UnsharedUniverse) return { ...error.data, cacheExpiresAt: Math.min(cacheExpiresAt, now() + 30000), publicPeerCache };
        throw error;
      }
    })().catch(() => { throw failed(key); }).finally(() => reading.delete(key));
    reading.set(key, task);
    return structuredClone(await task);
  };
}

export const getBankPeerUniverse = createBankPeerUniverse();
