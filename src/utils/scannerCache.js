/** Reproducible disclosure scans use the bounded public-data cache in production.
 * Legacy Redis scan values are never read or renewed and expire naturally.
 */
import { createHash } from 'node:crypto';
import { cacheGet, cachePut, disposableCacheEnabled } from './disposableCache.js';

export const SCANNER_CACHE_NAMESPACE = 'scanner-results-v2';
export const SCANNER_INVALIDATION_NAMESPACE = 'scanner-invalidations-v1';
export const SCANNER_CACHE_TTL_SECONDS = 86400;
const INVALIDATION_TTL_SECONDS = 25 * 3600;
const SCHEMA = 2;
const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MEMORY_LIMITS = Object.freeze({ entries: 16, bytes: 8 * 1024 * 1024, entryBytes: 1024 * 1024 });
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function identity(ticker, signature = null) {
  if (typeof ticker !== 'string' || !TICKER.test(ticker.toUpperCase())) return null;
  const normalized = ticker.toUpperCase();
  if (signature === null) return { ticker: normalized, key: `${normalized}:SCAN` };
  if (typeof signature !== 'string' || !signature.length || signature.length > 8192) return null;
  return { ticker: normalized, key: `${normalized}:KW:${digest(signature)}` };
}

/** Injection supports fixture tests; production never obtains Redis credentials. */
export function createScannerCache({ env = process.env, read = cacheGet, put = cachePut, now = Date.now } = {}) {
  const memory = new Map();
  let memoryBytes = 0;
  const production = () => env.VERCEL_ENV === 'production';
  function remove(key) {
    const entry = memory.get(key);
    if (entry) { memoryBytes -= entry.bytes; memory.delete(key); }
  }
  function prune() {
    for (const [key, entry] of memory) if (entry.expiresAt <= now()) remove(key);
  }
  function memoryGet(key) {
    prune();
    const entry = memory.get(key);
    if (!entry) return null;
    memory.delete(key); memory.set(key, entry);
    return { payload: JSON.parse(entry.serialized), rawSha256: entry.hash, expiresAt: new Date(entry.expiresAt).toISOString() };
  }
  function memoryPut(key, payload, ttl, ifHash = null) {
    prune();
    const serialized = JSON.stringify(payload), bytes = Buffer.byteLength(serialized);
    if (bytes > MEMORY_LIMITS.entryBytes) return false;
    const prior = memory.get(key);
    if (ifHash === 'absent' ? Boolean(prior) : ifHash !== null && prior?.hash !== ifHash) return false;
    remove(key);
    while (memory.size && (memory.size >= MEMORY_LIMITS.entries || memoryBytes + bytes > MEMORY_LIMITS.bytes)) remove(memory.keys().next().value);
    memory.set(key, { serialized, bytes, hash: digest(serialized), expiresAt: now() + ttl * 1000 });
    memoryBytes += bytes;
    return true;
  }
  async function current(key) {
    if (!production()) return memoryGet(key);
    if (!disposableCacheEnabled(env)) return null;
    return read(SCANNER_CACHE_NAMESPACE, key);
  }
  async function invalidation(selected) {
    if (!production()) return null;
    const marker = await read(SCANNER_INVALIDATION_NAMESPACE, selected.key);
    if (!marker) return null;
    const payload = marker.payload, invalidatedAt = Date.parse(payload?.invalidatedAt);
    if (!object(payload) || payload.schema !== SCHEMA || payload.status !== 'invalidated' || payload.ticker !== selected.ticker
      || !HASH.test(marker.rawSha256 || '') || !Number.isFinite(invalidatedAt) || invalidatedAt <= 0
      || invalidatedAt > now() || !(Date.parse(marker.expiresAt) > now())) {
      throw new Error('Invalid scan cache invalidation marker.');
    }
    return { invalidatedAt, rawSha256: marker.rawSha256 };
  }
  function validReady(envelope, selected) {
    const payload = envelope?.payload;
    const age = now() - Date.parse(payload?.scannedAt);
    const startedAt = Date.parse(payload?.startedAt);
    return object(payload) && payload.schema === SCHEMA && payload.status === 'ready'
      && payload.ticker === selected.ticker && object(payload.result)
      && (payload.result.ticker === undefined || typeof payload.result.ticker === 'string' && payload.result.ticker.toUpperCase() === selected.ticker)
      && Number.isFinite(startedAt) && startedAt > 0 && startedAt <= Date.parse(payload.scannedAt)
      && Date.parse(payload.scannedAt) - startedAt <= 300000
      && Number.isFinite(age) && age >= 0 && age < SCANNER_CACHE_TTL_SECONDS * 1000
      && Date.parse(envelope.expiresAt) > now();
  }
  async function get(selected) {
    if (!selected) return null;
    try {
      const envelope = await current(selected.key);
      if (!validReady(envelope, selected)) return null;
      // The marker lives in a protected family, so result eviction cannot let
      // an old in-flight scan reappear. A marker read failure is a cache miss.
      const marker = await invalidation(selected);
      if (marker !== null && Date.parse(envelope.payload.startedAt) <= marker.invalidatedAt) return null;
      if (!validReady(envelope, selected)) return null;
      return { scannedAt: envelope.payload.scannedAt, result: envelope.payload.result };
    } catch { return null; } // No memory or Redis resurrection on a production failure.
  }
  async function set(selected, result, { startedAt = null } = {}) {
    if (!selected || !object(result) || result.ticker !== undefined && (typeof result.ticker !== 'string' || result.ticker.toUpperCase() !== selected.ticker)) return false;
    const completedAt = now();
    if (startedAt !== null && (!Number.isSafeInteger(startedAt) || startedAt <= 0 || startedAt > completedAt || completedAt - startedAt > 300000)) return false;
    let payload;
    try {
      payload = { schema: SCHEMA, status: 'ready', ticker: selected.ticker,
        scannedAt: new Date(completedAt).toISOString(), startedAt: new Date(startedAt ?? completedAt).toISOString(), result };
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RESULT_BYTES) return false;
    } catch { return false; }
    if (production() && !disposableCacheEnabled(env)) return false;
    try {
      const prior = await current(selected.key);
      if (prior && (!HASH.test(prior.rawSha256 || '') || !object(prior.payload))) return false;
      const marker = await invalidation(selected);
      if (marker !== null && (startedAt === null || startedAt <= marker.invalidatedAt)) return false;
      if (prior?.payload?.status === 'invalidated') {
        const invalidatedAt = Date.parse(prior.payload.invalidatedAt);
        // An older in-flight scan cannot refill a just-invalidated cache. A
        // caller without its actual start time must leave the tombstone alone.
        if (!Number.isFinite(invalidatedAt) || invalidatedAt > now() || startedAt === null || startedAt <= invalidatedAt) return false;
      }
      const priorStart = Date.parse(prior?.payload?.startedAt);
      if (startedAt !== null && Number.isFinite(priorStart) && priorStart > startedAt) return false;
      const ifHash = prior?.rawSha256 || 'absent';
      if (!production()) return memoryPut(selected.key, payload, SCANNER_CACHE_TTL_SECONDS, ifHash);
      return (await put(SCANNER_CACHE_NAMESPACE, selected.key, payload, SCANNER_CACHE_TTL_SECONDS, { ifHash }))?.stored === true;
    } catch { return false; } // A valid SEC result does not depend on storing it.
  }
  async function invalidate(selected) {
    if (!selected) return;
    const payload = { schema: SCHEMA, status: 'invalidated', ticker: selected.ticker, invalidatedAt: new Date(now()).toISOString() };
    if (!production()) { memoryPut(selected.key, payload, SCANNER_CACHE_TTL_SECONDS); return; }
    let stored = false;
    if (disposableCacheEnabled(env)) {
      // This family never evicts a live marker. Its lifetime exceeds the
      // maximum five-minute scan plus the result's 24-hour freshness window.
      try {
        const prior = await invalidation(selected);
        // A delayed invalidation must never replace a newer marker or renew it.
        // CAS also protects the gap between this read and the marker write.
        if (prior !== null && prior.invalidatedAt >= Date.parse(payload.invalidatedAt)) return;
        stored = (await put(SCANNER_INVALIDATION_NAMESPACE, selected.key, payload, INVALIDATION_TTL_SECONDS,
          { ifHash: prior?.rawSha256 || 'absent' }))?.stored === true;
      }
      catch { /* Do not acknowledge an invalidation the shared store did not accept. */ }
    }
    if (!stored) throw new Error('Shared scan cache invalidation could not be confirmed. Retry the request.');
  }
  return {
    getCachedScan: ticker => get(identity(ticker)),
    setCachedScan: (ticker, result, options) => set(identity(ticker), result, options),
    invalidateScan: ticker => invalidate(identity(ticker)),
    getCachedDisclosureScan: (ticker, signature) => get(identity(ticker, typeof signature === 'string' ? signature : '')),
    setCachedDisclosureScan: (ticker, signature, result, options) => set(identity(ticker, typeof signature === 'string' ? signature : ''), result, options),
    invalidateDisclosureScan: (ticker, signature) => invalidate(identity(ticker, typeof signature === 'string' ? signature : '')),
    getBackendType: async () => production() ? disposableCacheEnabled(env) ? 'supabase' : 'disabled' : 'memory',
    memoryStats: () => { prune(); return { entries: memory.size, bytes: memoryBytes, limits: MEMORY_LIMITS }; },
  };
}

const cache = createScannerCache();
export const { getCachedScan, setCachedScan, invalidateScan, getCachedDisclosureScan,
  setCachedDisclosureScan, invalidateDisclosureScan, getBackendType } = cache;
