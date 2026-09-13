/** Server-only bounded cache of reproducible public data, separate from research provenance. */
import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { getDataStoreIdentityToken } from './dataStoreIdentity.js';
import { DISPOSABLE_CACHE_LIMITS as LIMITS, disposableCachePolicy } from '../../supabase/functions/edgar-data-gateway/cachePolicy.js';
export { disposableCachePolicy } from '../../supabase/functions/edgar-data-gateway/cachePolicy.js';

const BASE = 'https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway/rest/v1/rpc/';
const zip = promisify(gzip), unzip = promisify(gunzip);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// A repeated four-character capture can exhaust RegExp's stack at multi-MiB sizes.
const base64 = value => value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const validDate = value => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

export class DisposableCacheError extends Error {
  constructor(code, status = 503) { super(`Public data cache: ${code}`); this.name = 'DisposableCacheError'; this.code = code; this.status = status; }
}
export function disposableCacheEnabled(env = process.env) {
  return typeof window === 'undefined' && env.VERCEL_ENV === 'production' && env.EDGAR_DISPOSABLE_CACHE_MODE !== 'off';
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function boundedBytes(response, limit, signal) {
  const announced = response.headers.get('content-length');
  if (announced !== null && (!/^\d+$/.test(announced) || Number(announced) > limit)) {
    await response.body?.cancel().catch(() => {});
    throw new DisposableCacheError('response_too_large', 502);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let count = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      count += value.byteLength;
      if (count > limit) throw new DisposableCacheError('response_too_large', 502);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, count);
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); }
}

/** Dependency injection is fixture-only. Production uses the fixed OIDC gateway. */
export function createDisposableCache({ env = process.env, fetchImpl = (...args) => fetch(...args), identityTokenImpl = getDataStoreIdentityToken, now = Date.now } = {}) {
  function enabled() { return disposableCacheEnabled(env); }
  async function request(operation, params, { signal, deadline = Infinity, timeoutMs = 10000 } = {}) {
    if (!enabled()) throw new DisposableCacheError('disabled');
    if (signal?.aborted) signal.throwIfAborted();
    const remaining = Math.min(timeoutMs, deadline - now());
    if (!(remaining > 0)) throw new DisposableCacheError('deadline');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const body = JSON.stringify({ p_namespace: 'production', ...params });
      const limit = ['edgar_cache_get', 'edgar_cache_put'].includes(operation) ? LIMITS.rpcBytes : 512 * 1024;
      if (Buffer.byteLength(body) > limit) throw new DisposableCacheError('request_too_large', 413);
      let identityAbort;
      const interruptedIdentity = new Promise((_, reject) => {
        identityAbort = () => reject(new DisposableCacheError('timeout'));
        requestSignal.addEventListener('abort', identityAbort, { once: true });
      });
      let token;
      try { token = await Promise.race([identityTokenImpl(), interruptedIdentity]); }
      finally { requestSignal.removeEventListener('abort', identityAbort); }
      requestSignal.throwIfAborted();
      if (typeof token !== 'string' || !token.length || token.length > 12288 || /[\r\n]/.test(token)) throw new DisposableCacheError('identity_unavailable');
      const response = await fetchImpl(`${BASE}${operation}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-region': 'us-east-1' },
        body, signal: requestSignal, redirect: 'error', cache: 'no-store',
      });
      const bytes = await boundedBytes(response, limit, requestSignal);
      let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new DisposableCacheError('invalid_response', 502); }
      if (!response.ok) {
        const code = ['cache_response_too_large', 'body_too_large'].includes(value?.code) ? 'response_too_large' : `http_${response.status}`;
        throw new DisposableCacheError(code, response.status);
      }
      return value;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (error instanceof DisposableCacheError) throw error;
      throw new DisposableCacheError(controller.signal.aborted || error?.name === 'AbortError' ? 'timeout' : 'transport_failure');
    } finally { clearTimeout(timer); }
  }
  function policy(type, id) { return disposableCachePolicy(type, typeof id === 'number' ? String(id) : id); }
  async function decode(row, expectedId) {
    if (row === null) return null;
    if (!object(row) || row.id !== expectedId || !HASH.test(row.rawSha256 || '') || !HASH.test(row.gzipSha256 || '')
      || !integer(row.rawBytes, 1, LIMITS.rawBytes) || !integer(row.storedBytes, 1, LIMITS.gzipBytes)
      || !validDate(row.writtenAt) || !validDate(row.expiresAt) || Date.parse(row.expiresAt) <= Date.parse(row.writtenAt)
      || Date.parse(row.writtenAt) > now() + 60000 || typeof row.gzipBase64 !== 'string'
      || row.gzipBase64.length > Math.ceil(LIMITS.gzipBytes / 3) * 4 || !base64(row.gzipBase64)) throw new DisposableCacheError('invalid_record', 502);
    // Never extend storage expiry by caching or reading a record.
    if (Date.parse(row.expiresAt) <= now()) return null;
    const compressed = Buffer.from(row.gzipBase64, 'base64');
    if (compressed.length !== row.storedBytes || compressed.toString('base64') !== row.gzipBase64 || hash(compressed) !== row.gzipSha256) throw new DisposableCacheError('integrity_mismatch', 502);
    let bytes; try { bytes = await unzip(compressed, { maxOutputLength: LIMITS.rawBytes }); }
    catch { throw new DisposableCacheError('invalid_gzip', 502); }
    if (bytes.length !== row.rawBytes || hash(bytes) !== row.rawSha256) throw new DisposableCacheError('integrity_mismatch', 502);
    let payload; try { payload = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch { throw new DisposableCacheError('invalid_json', 502); }
    return Object.freeze({ payload, rawSha256: row.rawSha256, gzipSha256: row.gzipSha256, rawBytes: row.rawBytes,
      storedBytes: row.storedBytes, writtenAt: row.writtenAt, expiresAt: row.expiresAt });
  }
  async function getBatch(selected, options) {
    try {
      const rows = await request('edgar_cache_get', { p_family: selected[0].family, p_type: selected[0].type, p_ids: selected.map(p => p.id) }, options);
      if (!Array.isArray(rows) || rows.length !== selected.length) throw new DisposableCacheError('incomplete_batch', 502);
      // Sequential decoding prevents 25 large compressed records expanding simultaneously.
      const result = []; for (let i = 0; i < rows.length; i++) result.push(await decode(rows[i], selected[i].id));
      return result;
    } catch (error) {
      if (error?.code !== 'response_too_large' || selected.length <= 1) throw error;
      const middle = Math.floor(selected.length / 2);
      return [...await getBatch(selected.slice(0, middle), options), ...await getBatch(selected.slice(middle), options)];
    }
  }
  async function cacheGetMany(type, ids, options = {}) {
    if (!Array.isArray(ids) || ids.length > 2000) throw new DisposableCacheError('invalid_batch', 422);
    if (!enabled()) return ids.map(() => null);
    const results = ids.map(() => null), groups = new Map();
    ids.forEach((id, index) => {
      const p = policy(type, id); if (!p) return;
      const key = `${p.family}:${p.type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ p, index });
    });
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += LIMITS.batch) {
        const batch = group.slice(offset, offset + LIMITS.batch);
        const values = await getBatch(batch.map(entry => entry.p), options);
        values.forEach((value, i) => { results[batch[i].index] = value; });
      }
    }
    return results;
  }
  async function cacheGet(type, id, options = {}) { return (await cacheGetMany(type, [id], options))[0]; }
  async function cachePut(type, id, payload, ttlSeconds, { ifHash = null, expiresAt = null, ...options } = {}) {
    const p = policy(type, id);
    if (!enabled() || !p) return { stored: false, reason: 'disabled' };
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1 || ![null, 'absent'].includes(ifHash) && !HASH.test(ifHash || '')
      || expiresAt !== null && !validDate(expiresAt)) throw new DisposableCacheError('invalid_write', 422);
    if (expiresAt !== null && Date.parse(expiresAt) <= now()) return { stored: false, reason: 'expired' };
    let raw; try { const text = JSON.stringify(payload); if (typeof text !== 'string') throw new Error(); raw = Buffer.from(text); }
    catch { throw new DisposableCacheError('invalid_json', 422); }
    if (raw.length < 1 || raw.length > LIMITS.rawBytes) throw new DisposableCacheError('raw_too_large', 413);
    if (p.sourceCik && String(payload?.cik || '').padStart(10, '0') !== p.sourceCik) throw new DisposableCacheError('source_identity_mismatch', 422);
    const compressed = await zip(raw, { level: 6 });
    if (compressed.length > LIMITS.gzipBytes) throw new DisposableCacheError('compressed_too_large', 413);
    const rawSha256 = hash(raw);
    const ack = await request('edgar_cache_put', { p_family: p.family, p_type: p.type, p_id: p.id,
      p_gzip_base64: compressed.toString('base64'), p_raw_sha256: rawSha256, p_gzip_sha256: hash(compressed),
      p_raw_bytes: raw.length, p_ttl_seconds: Math.min(Math.floor(ttlSeconds), p.maxTtlSeconds), p_if_hash: ifHash, p_expires_at: expiresAt }, options);
    if (!object(ack) || typeof ack.stored !== 'boolean' || ack.stored && (ack.rawSha256 !== rawSha256 || !validDate(ack.expiresAt) || Date.parse(ack.expiresAt) <= now())
      || ack.stored && expiresAt !== null && Date.parse(ack.expiresAt) > Date.parse(expiresAt)
      || !ack.stored && (typeof ack.reason !== 'string' || !/^[a-z_]{1,64}$/.test(ack.reason))) throw new DisposableCacheError('invalid_acknowledgement', 502);
    return ack;
  }
  async function cacheStatus(options = {}) { return request('edgar_cache_status', {}, options); }
  async function readCacheMaintenanceState(options = {}) { return request('edgar_cache_maintenance', { p_action: 'read' }, options); }
  async function claimCacheMaintenanceState(owner, options = {}) {
    if (!UUID.test(owner || '')) throw new DisposableCacheError('invalid_owner', 422);
    return request('edgar_cache_maintenance', { p_action: 'claim', p_owner: owner }, options);
  }
  async function saveCacheMaintenanceState(owner, state, options = {}) {
    if (!UUID.test(owner || '') || !object(state) || Buffer.byteLength(JSON.stringify(state)) > LIMITS.stateBytes) throw new DisposableCacheError('invalid_state', 422);
    return request('edgar_cache_maintenance', { p_action: 'save', p_owner: owner, p_state: state }, options);
  }
  return { disposableCacheEnabled: enabled, disposableCachePolicy: policy, cacheGet, cacheGetMany, cachePut, cacheStatus,
    readCacheMaintenanceState, claimCacheMaintenanceState, saveCacheMaintenanceState };
}
const productionCache = createDisposableCache();
export const { cacheGet, cacheGetMany, cachePut, cacheStatus, readCacheMaintenanceState, claimCacheMaintenanceState, saveCacheMaintenanceState } = productionCache;
