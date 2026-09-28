import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { unstable_cache } from 'next/cache.js';
import { bankScopeStore, isBankScopeEnvironment } from './scopeStore.js';
import { BankDataError } from './errors.js';
import { PEER_MODEL_VERSION } from './peerSource.js';

const zip = promisify(gzip), unzip = promisify(gunzip);
const VERSION = 'bankscope-peer-universe-v1';
const MODEL = PEER_MODEL_VERSION;
const MAX_AGE = 300000;
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

class UnsharedUniverse extends Error {
  constructor(data) {
    super('Public peer snapshot is not reusable in the shared cache.');
    Object.defineProperty(this, 'data', { value: data });
  }
}

/** Four quarterly public datasets, compressed below Next's 2 MiB entry limit.
 * No credentials, source XML, mutation results, or per-user state are retained.
 * Cache expiry is an absolute bound, including when revalidation fails.
 */
export function createBankPeerUniverse({ store = bankScopeStore, cache = unstable_cache, env = process.env,
  now = Date.now, maxSharedBytes = MAX_SHARED_BYTES } = {}) {
  const producing = new Map(), reading = new Map(), recent = new Map(), failures = new Map();
  const scope = () => JSON.stringify([env.VERCEL_ENV, env.VERCEL_GIT_COMMIT_REF || '']);
  function failed(key) {
    if (failures.size >= 8) failures.delete(failures.keys().next().value);
    const retryAt = now() + 5000; failures.set(key, retryAt);
    return new BankDataError('database_failure', { retryAt: new Date(retryAt).toISOString() });
  }
  function guard(expectedScope) {
    if (typeof window !== 'undefined' || !isBankScopeEnvironment(env) || expectedScope !== scope()) throw new BankDataError('bank_service_unavailable');
  }
  async function produce(deployment, period) {
    guard(deployment);
    const key = `${deployment}:${period}`, hit = recent.get(key);
    if (hit?.until > now()) return hit.value;
    if (producing.has(key)) return producing.get(key);
    if (failures.get(key) > now()) throw new BankDataError('database_failure');
    if (producing.size >= 8) throw new BankDataError('database_failure');
    const task = (async () => {
      const data = await store('peer_universe', { period });
      if (!validPeerUniverse(data, period)) throw new BankDataError('database_failure');
      if (!data.snapshot) throw new UnsharedUniverse(data);
      const raw = Buffer.from(JSON.stringify({ snapshot: data.snapshot, profiles: data.profiles }));
      if (raw.length > MAX_RAW_BYTES) throw new BankDataError('response_too_large');
      const packed = await zip(raw);
      const value = { version: VERSION, deployment, period, checkedAt: now(), rawBytes: raw.length,
        sha256: hash(raw), gzipBase64: packed.toString('base64') };
      // Exception carries the already-fetched public data to this caller only;
      // missing/oversized snapshots never become persistent cache entries.
      if (Buffer.byteLength(JSON.stringify(value)) > maxSharedBytes) throw new UnsharedUniverse(data);
      if (recent.size >= 4) recent.delete(recent.keys().next().value);
      recent.set(key, { value, until: now() + 2000 });
      return value;
    })().catch(error => { if (error instanceof UnsharedUniverse) throw error; throw failed(key); })
      .finally(() => producing.delete(key));
    producing.set(key, task);
    return task;
  }
  const shared = cache(produce, [VERSION, MODEL], { revalidate: 300 });
  async function decode(entry, deployment, period) {
    if (!object(entry) || entry.version !== VERSION || entry.deployment !== deployment || entry.period !== period
      || !Number.isFinite(entry.checkedAt) || now() - entry.checkedAt < 0 || now() - entry.checkedAt >= MAX_AGE
      || !Number.isSafeInteger(entry.rawBytes) || entry.rawBytes < 1 || entry.rawBytes > MAX_RAW_BYTES
      || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || typeof entry.gzipBase64 !== 'string'
      || entry.gzipBase64.length > maxSharedBytes || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.gzipBase64)) throw new BankDataError('database_failure');
    const raw = await unzip(Buffer.from(entry.gzipBase64, 'base64'), { maxOutputLength: MAX_RAW_BYTES });
    if (raw.length !== entry.rawBytes || hash(raw) !== entry.sha256) throw new BankDataError('database_failure');
    const data = JSON.parse(raw.toString('utf8'));
    if (!validPeerUniverse(data, period)) throw new BankDataError('database_failure');
    return { ...data, cacheExpiresAt: entry.checkedAt + MAX_AGE };
  }
  return async period => {
    const deployment = scope(); guard(deployment);
    if (!quarter(period)) throw new BankDataError('invalid_request', { status: 400 });
    const key = `${deployment}:${period}`;
    if (reading.has(key)) return structuredClone(await reading.get(key));
    if (failures.get(key) > now() || reading.size >= 8) throw new BankDataError('database_failure', { retryAt: new Date(now() + 5000).toISOString() });
    const task = (async () => {
      let entry;
      try { entry = env.VERCEL_ENV === 'production' ? await shared(deployment, period) : await produce(deployment, period); }
      catch (error) {
        if (error instanceof UnsharedUniverse || failures.get(key) > now()) throw error;
        // A shared-cache outage may fall back once. A failed source read is
        // already on cooldown; a successful read is reused after write failure.
        entry = await produce(deployment, period);
      }
      try { return await decode(entry, deployment, period); }
      catch {
        // Repair an expired or malformed shared entry with one coalesced fresh
        // read. Never return an indefinitely stale snapshot during an outage.
        return decode(await produce(deployment, period), deployment, period);
      }
    })().catch(error => {
      if (error instanceof UnsharedUniverse) return { ...error.data, cacheExpiresAt: now() + 30000 };
      throw failed(key);
    }).finally(() => reading.delete(key));
    reading.set(key, task);
    return structuredClone(await task);
  };
}

export const getBankPeerUniverse = createBankPeerUniverse();
