import { unstable_cache, revalidateTag } from 'next/cache.js';
import { bankScopeStore, isBankScopeEnvironment } from './scopeStore.js';
import { bankReadSelection, isBankReadResult, bankReadTtl } from './readResult.js';
import { SCOPE_MAPPING_VERSION } from './catalog.js';
import { BankDataError } from './errors.js';

const VERSION = 'bankscope-public-read-v1';
const FRESH_MS = 5 * 60 * 1000;
const MAX_STALE_MS = 6 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
const MAX_PENDING = 64;
const FAILURE_MS = 5000;
const deploymentKey = env => JSON.stringify([env.VERCEL_ENV || '', env.VERCEL_GIT_COMMIT_REF || '']);
const bankTag = (env, rssd) => `${VERSION}:${env.VERCEL_ENV}:${Number(rssd)}`;
const ready = (data, ids) => isBankReadResult(data, ids) && bankReadTtl(data, ids) === 30000
  && data.reports.every(report => report.validation.passed);
const bounded = entry => Buffer.byteLength(JSON.stringify(entry), 'utf8') <= MAX_BYTES;

// Returning changing queue states from unstable_cache would persist them. Throw
// them through the cache boundary instead, then return them only to this caller.
class UncachedBankRead extends Error {
  constructor(entry) { super('Uncached public bank read'); this.entry = entry; }
}

/** Shared, validated public reports. No raw sources, credentials or write payloads. */
export function createCachedBankRead({ store = bankScopeStore, cache = unstable_cache,
  invalidateTag = revalidateTag, env = process.env, now = Date.now } = {}) {
  const pending = new Map();
  const sources = new Map();
  const failures = new Map();
  let generation = 0;

  const read = async payload => {
    if (typeof window !== 'undefined' || !isBankScopeEnvironment(env)) throw new BankDataError('bank_service_unavailable');
    const ids = bankReadSelection(payload);
    if (!ids) throw new BankDataError('invalid_selection', { status: 400 });
    const deployment = deploymentKey(env);
    const parts = [VERSION, deployment, SCOPE_MAPPING_VERSION, ids.join(',')];
    const key = JSON.stringify(parts);
    if (pending.has(key)) return structuredClone(await pending.get(key).promise);
    if (pending.size >= MAX_PENDING) throw new BankDataError('database_failure', { retryAt: new Date(now() + FAILURE_MS).toISOString() });
    const currentGeneration = generation;
    const state = { ids, promise: null };
    state.promise = (async () => {
      let sourcePromise;
      const fresh = () => sourcePromise ||= (async () => {
        const failedUntil = failures.get(key);
        // Background SWR failures also cool down. Cache hits can still serve a
        // validated saved report; the cooldown only suppresses backend calls.
        if (failedUntil > now()) throw new BankDataError('database_failure', { retryAt: new Date(failedUntil).toISOString() });
        failures.delete(key);
        const existing = sources.get(key);
        if (existing?.generation === currentGeneration) return existing.promise;
        if (sources.size >= MAX_PENDING) throw new BankDataError('database_failure', { retryAt: new Date(now() + FAILURE_MS).toISOString() });
        const source = { generation: currentGeneration, promise: null };
        source.promise = (async () => {
          const payload = { rssds: ids };
          const result = await (typeof store.readFresh === 'function' ? store.readFresh(payload) : store('read', payload));
          if (!isBankReadResult(result, ids)) throw new BankDataError('database_failure');
          // Keep only the public envelope, including source identities and report
          // validation. Cache metadata never changes the source retrieval date.
          const { banks, reports, jobs, periods, directoryAt = null, cooldownUntil = null } = result;
          return { version: VERSION, deployment, ids, checkedAt: now(),
            data: { banks, reports, jobs, periods, directoryAt, cooldownUntil } };
        })().catch(error => {
          if (generation === currentGeneration) {
            if (failures.size >= MAX_PENDING) failures.delete(failures.keys().next().value);
            failures.set(key, now() + FAILURE_MS);
          }
          throw error;
        }).finally(() => { if (sources.get(key) === source) sources.delete(key); });
        sources.set(key, source);
        return source.promise;
      })();
      const load = async () => {
        const entry = await fresh();
        if (!ready(entry.data, ids) || !bounded(entry) || generation !== currentGeneration) throw new UncachedBankRead(entry);
        return entry;
      };
      const valid = entry => entry?.version === VERSION && entry.deployment === deployment
        && Array.isArray(entry.ids) && JSON.stringify(entry.ids) === JSON.stringify(ids)
        && Number.isFinite(entry.checkedAt) && now() >= entry.checkedAt
        && now() - entry.checkedAt <= MAX_STALE_MS && ready(entry.data, ids) && bounded(entry);
      let entry;
      if (env.VERCEL_ENV !== 'production') entry = await fresh();
      else {
        try {
          entry = await cache(load, parts, { revalidate: FRESH_MS / 1000, tags: ids.map(id => bankTag(env, id)) })();
          // Next may keep the last successful entry while revalidation fails.
          // Enforce a hard age limit and revalidate identities on every hit.
          if (!valid(entry)) entry = await fresh();
        } catch (error) {
          if (error instanceof UncachedBankRead) entry = error.entry;
          else entry = await fresh(); // Memoization prevents repeating a failed source request.
        }
      }
      if (!isBankReadResult(entry.data, ids)) throw new BankDataError('database_failure');
      return { ...entry.data, publicReadCache: { checkedAt: new Date(entry.checkedAt).toISOString(), stale: now() - entry.checkedAt >= FRESH_MS } };
    })().finally(() => { if (pending.get(key) === state) pending.delete(key); });
    pending.set(key, state);
    return structuredClone(await state.promise);
  };

  read.invalidate = async rssd => {
    if (typeof window !== 'undefined' || !isBankScopeEnvironment(env)) return;
    const ids = bankReadSelection({ rssds: [rssd] });
    if (!ids) return;
    generation++;
    for (const [key, state] of pending) if (state.ids.includes(ids[0])) pending.delete(key);
    for (const key of failures.keys()) if (JSON.parse(key)[3].split(',').includes(String(ids[0]))) failures.delete(key);
    if (env.VERCEL_ENV === 'production') await invalidateTag(bankTag(env, ids[0]), { expire: 0 });
  };
  return read;
}

export const getBankPublicRead = createCachedBankRead();
export const invalidateBankPublicRead = rssd => getBankPublicRead.invalidate(rssd);
