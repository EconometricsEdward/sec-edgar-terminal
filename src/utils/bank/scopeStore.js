import { BankDataError } from './errors.js';
import { limitedText } from './client.js';
import { isBankDirectory } from './directory.js';
import { bankReadSelection, isBankReadResult, bankReadTtl } from './readResult.js';

const SEARCH_TTL = 30000;
const DIRECTORY_TTL = 300000;
const FAILURE_COOLDOWN = 5000;
const MAX_ENTRIES = 100;
const MAX_CACHED_BYTES = 64 * 1024;
const MAX_READ_ENTRIES = 32;
const MAX_READ_BYTES = 512 * 1024;
const INVALIDATES_READS = new Set(['request', 'begin', 'finish', 'periods', 'catalog', 'claim', 'publish', 'job_error', 'cooldown']);
const OPERATIONS = new Set(['status', 'search', 'read', 'source', 'lineage', 'request', 'begin', 'reserve', 'cooldown', 'periods', 'catalog', 'claim', 'publish', 'job_error', 'finish', 'peer_status', 'peer_universe', 'peer_history', 'peer_start', 'peer_batch', 'peer_complete', 'ubpr_read', 'ubpr_source', 'ubpr_claim', 'ubpr_save', 'ubpr_error']);

export function isBankScopeEnvironment(env = process.env) {
  return env.VERCEL_ENV === 'production' || (env.VERCEL_ENV === 'preview' && env.VERCEL_GIT_COMMIT_REF === 'feat/ffiec-bank-pilot');
}

function cacheableSearch(operation, payload) {
  if (operation !== 'search' || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => key !== 'query') || typeof (payload.query ?? '') !== 'string') return null;
  const query = (payload.query ?? '').trim().toLowerCase();
  if (query.length > 100 || query.length === 1 || /[\x00-\x1f]/.test(query)) return null;
  return query;
}

function validSearchResult(data) {
  return isBankDirectory(data) && !data.error && !data.code;
}

function remember(cache, key, value, limit = MAX_ENTRIES) {
  cache.delete(key);
  if (cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/** Bounded reuse of validated public directory/profile reads; never retain credentials or writes. */
export function createBankScopeStore({ env = process.env, fetchImpl = fetch,
  identity = async () => (await import('@vercel/oidc')).getVercelOidcToken(), now = Date.now,
  logger = event => console.warn('bankscope_gateway_failure', event) } = {}) {
  const searches = new Map();
  const reads = new Map();
  const pending = new Map();
  const failures = new Map();
  let generation = 0;
  function invalidate() {
    generation++;
    searches.clear(); reads.clear(); failures.clear();
    // Keep in-flight work counted, but its generation can neither be joined nor
    // repopulate a cache after a preparation/publication changes the database.
  }

  async function request(operation, payload, validate) {
    let category = 'identity';
    let status = null;
    try {
      const token = await identity();
      category = 'network';
      const response = await fetchImpl('https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/bankscope-gateway', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-region': 'us-east-1' },
        body: JSON.stringify({ operation, payload }), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25000),
      });
      status = response.status;
      if (!response.ok) { category = 'http'; throw new BankDataError('database_failure'); }
      category = 'response_invalid';
      const data = JSON.parse(await limitedText(response));
      if (validate && !validate(data)) throw new BankDataError('database_failure');
      return data;
    } catch (error) {
      if (error instanceof BankDataError && error.code === 'response_too_large') category = 'response_too_large';
      // Never log payloads, queries, credentials, upstream bodies, or exception messages.
      try { logger({ operation: OPERATIONS.has(operation) ? operation : 'unknown', status, category }); } catch { /* Diagnostics must not change request behavior. */ }
      if (error instanceof BankDataError) throw error;
      throw new BankDataError('database_failure');
    }
  }

  const store = async (operation, payload = {}) => {
    // Check before cache lookup, so switching environment cannot expose a production result.
    if (typeof window !== 'undefined' || !isBankScopeEnvironment(env)) throw new BankDataError('bank_service_unavailable');
    if (INVALIDATES_READS.has(operation)) {
      invalidate();
      try { return await request(operation, payload); }
      finally { invalidate(); }
    }
    const query = cacheableSearch(operation, payload);
    const ids = operation === 'read' ? bankReadSelection(payload) : null;
    if (query === null && !ids) return request(operation, payload);
    const cache = ids ? reads : searches;
    const limit = ids ? MAX_READ_ENTRIES : MAX_ENTRIES;
    const currentGeneration = generation;

    const key = JSON.stringify([env.VERCEL_ENV, env.VERCEL_GIT_COMMIT_REF || '', operation, ids || query, currentGeneration]);
    const timestamp = now();
    const hit = cache.get(key);
    if (hit && hit.until > timestamp) {
      remember(cache, key, hit, limit);
      return JSON.parse(hit.json);
    }
    cache.delete(key);
    const retryAt = failures.get(key);
    if (retryAt > timestamp) throw new BankDataError('database_failure', { retryAt: new Date(retryAt).toISOString() });
    failures.delete(key);
    if (pending.has(key)) return structuredClone(await pending.get(key));
    // Arbitrary searches/selections cannot create unbounded in-flight work.
    if (pending.size >= MAX_ENTRIES) throw new BankDataError('database_failure', { retryAt: new Date(timestamp + FAILURE_COOLDOWN).toISOString() });

    const task = request(operation, ids ? { rssds: ids } : payload, ids ? data => isBankReadResult(data, ids) : validSearchResult).then(data => {
      const json = JSON.stringify(data);
      if (currentGeneration === generation && Buffer.byteLength(json, 'utf8') <= (ids ? MAX_READ_BYTES : MAX_CACHED_BYTES)) {
        const ttl = ids ? bankReadTtl(data, ids) : query ? SEARCH_TTL : DIRECTORY_TTL;
        remember(cache, key, { json, until: now() + ttl }, limit);
      }
      return data;
    }).catch(error => {
      const until = now() + FAILURE_COOLDOWN;
      if (currentGeneration === generation) remember(failures, key, until);
      throw new BankDataError(error.code, { status: error.status, retryAt: new Date(until).toISOString() });
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return structuredClone(await task);
  };
  // Shared-cache refreshes must observe the database directly. An instance's
  // short local cache may predate a publication invalidated on another server.
  store.readFresh = async payload => {
    if (typeof window !== 'undefined' || !isBankScopeEnvironment(env)) throw new BankDataError('bank_service_unavailable');
    const ids = bankReadSelection(payload);
    if (!ids) throw new BankDataError('invalid_selection', { status: 400 });
    return request('read', { rssds: ids }, data => isBankReadResult(data, ids));
  };
  return store;
}

export const bankScopeStore = createBankScopeStore();
