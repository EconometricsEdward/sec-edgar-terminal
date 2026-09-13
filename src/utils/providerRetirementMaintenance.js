/** Bounded housekeeping adapter for the existing, versioned retirement plan.
 * This adds execution limits and lease fences; providerRetirement retains the
 * audited deletion scope, replacement-readiness checks and checkpoint phases.
 */
import { randomUUID } from 'node:crypto';
import { cacheGet, readCacheMaintenanceState } from './disposableCache.js';
import { createRedisMaintenanceTransport } from './redisMaintenance.js';
import { FUNDAMENTAL_UNIVERSE_CACHE } from './marketUniverseServer.js';
import { PROVIDER_RETIREMENT_VERSION, PROVIDER_RETIREMENT_PLAN_ID,
  RETIRED_CACHE_PREFIXES, RETIRED_RAW_KEYS, runProviderRetirementStep } from './providerRetirement.js';

const GLOBAL_DRAIN_MS = 600_000;
const MAX_RUN_MS = 20_000;
const FINALIZE_MS = 2000;
const MAX_KEYS = 200;
const MAX_PAGE_KEYS = 100;
const CHECKPOINT_TTL = 180 * 86400;
const CHECKPOINT_KEY = `warm:${PROVIDER_RETIREMENT_VERSION}:CHECKPOINT`;
const LEASE_KEY = `warm:lease:${PROVIDER_RETIREMENT_VERSION}:RUN`;
const WARM_PREFIXES = new Set(RETIRED_CACHE_PREFIXES);
const RAW_PREFIXES = new Set(['views:', 'rl:stock:', 'rl:market-signals-v1:', 'rl:factor-universe:']);
const EXACT_KEYS = new Set([
  ...Array.from({ length: 16 }, (_, index) => `warm:quant-coverage-v1:BATCH-${index}`),
  'warm:quant-coverage-v1:COMPACT-PRICE-STORAGE', ...RETIRED_RAW_KEYS,
]);
const fail = code => Object.assign(new Error(code), { code });
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const SAFE_ERRORS = new Set([
  'maintenance_deadline', 'redis_unconfigured', 'redis_auth', 'redis_oom', 'redis_maxmemory',
  'redis_storage_limit', 'redis_quota', 'redis_unsupported', 'redis_http', 'redis_response',
  'redis_response_size', 'redis_timeout', 'redis_connect_timeout', 'redis_transport',
  'retirement_scope', 'retirement_response', 'retirement_lease_lost', 'retirement_checkpoint',
]);

const SAVE_CHECKPOINT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('PTTL', KEYS[1]) <= 0 then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`;
const RELEASE_LEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;
// Validate the entire batch before deleting anything, including inside Redis.
// The only broader prefixes are the exact audited historical plan prefixes.
const DELETE_RETIRED = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('PTTL', KEYS[1]) <= 0 then return -1 end
local prefixes = {${[...WARM_PREFIXES].map(value => JSON.stringify(`warm:${value}:`)).concat([...RAW_PREFIXES].map(value => JSON.stringify(value))).join(',')}}
local exact = {${[...EXACT_KEYS].map(value => `[${JSON.stringify(value)}]=true`).join(',')}}
for index = 2, #KEYS do
  local allowed = exact[KEYS[index]] == true
  for _, prefix in ipairs(prefixes) do
    if string.sub(KEYS[index], 1, string.len(prefix)) == prefix then allowed = true end
  end
  if not allowed then return -2 end
end
local removed = 0
for index = 2, #KEYS do removed = removed + redis.call('DEL', KEYS[index]) end
return removed
`;

/** Aggregate-only status: checkpoint keys, cursor and lease tokens stay private. */
export function summarizeProviderRetirementState(state) {
  if (state?.version !== PROVIDER_RETIREMENT_VERSION || state?.plan_id !== PROVIDER_RETIREMENT_PLAN_ID) return null;
  return { phase: ['delete', 'verify'].includes(state.phase) ? state.phase : null,
    targetIndex: Number.isInteger(state.target_index) && state.target_index >= 0 && state.target_index <= WARM_PREFIXES.size + RAW_PREFIXES.size ? state.target_index : null,
    removed: safeCount(state.removed), scanned: safeCount(state.scanned), complete: state.complete === true,
    deletionNotBefore: safeTime(state.deletion_not_before), verificationNotBefore: safeTime(state.verification_not_before),
    updatedAt: safeTime(state.updated_at), completedAt: safeTime(state.completed_at) };
}

/** Call only from authenticated production housekeeping. The private operator
 * mode cannot be armed here. Twenty seconds includes a final two-second reserve
 * for checkpoint persistence and releasing only this invocation's lease.
 */
export async function maintainProviderRetirement({ signal, deadline } = {}, injected = {}) {
  const now = injected.now || Date.now;
  const started = now();
  const hardDeadline = Math.min(Number.isFinite(deadline) ? deadline : started + MAX_RUN_MS, started + MAX_RUN_MS);
  const workDeadline = hardDeadline - FINALIZE_MS;
  const transport = injected.transport || createRedisMaintenanceTransport({ now });
  const readControl = injected.readControl || readCacheMaintenanceState;
  const readCache = injected.cacheGet || cacheGet;
  let checkpoint = null, owner = null;
  const reads = new Set();
  const result = (status, code = null) => ({ status, ...(code ? { code } : {}), ...summarizeProviderRetirementState(checkpoint) });
  const checkBudget = () => {
    if (signal?.aborted || now() >= workDeadline) throw fail('maintenance_deadline');
  };
  const command = (args, finalize = false) => {
    if (!finalize) checkBudget();
    return transport.command(args, { signal: finalize ? undefined : signal,
      deadline: finalize ? hardDeadline : workDeadline, maxBytes: 128 * 1024 });
  };
  const requireIdentity = (type, id, expectedId) => {
    if (type !== PROVIDER_RETIREMENT_VERSION || id !== expectedId) throw fail('retirement_scope');
  };
  const remove = async keys => {
    if (!owner || keys.length > MAX_PAGE_KEYS || keys.some(key => !EXACT_KEYS.has(key)
      && ![...WARM_PREFIXES].some(prefix => key.startsWith(`warm:${prefix}:`))
      && ![...RAW_PREFIXES].some(prefix => key.startsWith(prefix)))) throw fail('retirement_scope');
    if (!keys.length) return 0;
    const removed = await command(['EVAL', DELETE_RETIRED, keys.length + 1, LEASE_KEY, ...keys, owner]);
    if (removed === -1) throw fail('retirement_lease_lost');
    if (removed === -2) throw fail('retirement_scope');
    if (!Number.isSafeInteger(removed) || removed < 0 || removed > keys.length) throw fail('retirement_response');
    return removed;
  };
  const deletePrefix = async (kind, prefix, cursor, remaining) => {
    if (!(kind === 'warm' ? WARM_PREFIXES : RAW_PREFIXES).has(prefix)
      || !/^\d{1,30}$/.test(String(cursor)) || !Number.isSafeInteger(remaining) || remaining < 1 || remaining > MAX_KEYS) throw fail('retirement_scope');
    const fullPrefix = kind === 'warm' ? `warm:${prefix}:` : prefix;
    const limit = Math.min(remaining, MAX_PAGE_KEYS);
    const page = await command(['SCAN', String(cursor), 'MATCH', `${fullPrefix}*`, 'COUNT', String(limit)]);
    if (!Array.isArray(page) || page.length !== 2 || !/^\d{1,30}$/.test(String(page[0]))
      || !Array.isArray(page[1]) || page[1].some(key => typeof key !== 'string' || key.length > 1200 || !key.startsWith(fullPrefix))) throw fail('retirement_response');
    const found = [...new Set(page[1])], keys = found.slice(0, limit);
    const removed = await remove(keys);
    // COUNT is a hint. An overfull page must never advance past an unprocessed
    // tail. Restart this prefix; acknowledged deletions make subsequent passes
    // converge, and the existing final verification catches concurrent changes.
    const overflow = found.length > keys.length;
    return { cursor: overflow ? '0' : String(page[0]), matched: keys.length, removed,
      complete: !overflow && String(page[0]) === '0' };
  };

  try {
    checkBudget();
    if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') return result('blocked', 'retirement_environment');
    const control = await readControl({ signal, deadline: workDeadline, timeoutMs: 5000 });
    const armedAt = typeof control?.modeChangedAt === 'string' ? Date.parse(control.modeChangedAt) : NaN;
    if (control?.mode !== 'migrate') return result('blocked', 'retirement_mode');
    if (!Number.isFinite(armedAt) || now() - armedAt < GLOBAL_DRAIN_MS) return result('blocked', 'retirement_drain');
    if (!(safeCount(control?.state?.counters?.removed) > 0)) return result('blocked', 'retirement_waiting_for_space');

    const state = await runProviderRetirementStep({ now: now(), maxKeys: MAX_KEYS, operations: {
      enabled: () => true,
      get: async (type, id) => {
        requireIdentity(type, id, 'checkpoint');
        const raw = await command(['GET', CHECKPOINT_KEY]);
        if (raw === null) return null;
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024) throw fail('retirement_checkpoint');
        try { checkpoint = JSON.parse(raw); } catch { throw fail('retirement_checkpoint'); }
        return checkpoint;
      },
      acquire: async (type, id, ttlMs) => {
        requireIdentity(type, id, 'run');
        if (ttlMs !== 360_000) throw fail('retirement_scope');
        const token = randomUUID();
        const acquired = await command(['SET', LEASE_KEY, token, 'NX', 'PX', ttlMs]);
        if (acquired === null) return null;
        if (acquired !== 'OK') throw fail('retirement_response');
        owner = token; return token;
      },
      release: async (type, id, token) => {
        requireIdentity(type, id, 'run');
        if (!owner || token !== owner) throw fail('retirement_scope');
        // A release timeout must not hide an acknowledged saved checkpoint.
        // The existing lease has its own expiry if transport is unavailable.
        try { return await command(['EVAL', RELEASE_LEASE, 1, LEASE_KEY, owner], true) === 1; }
        catch { return false; }
      },
      set: async (type, id, value, ttlSeconds) => {
        requireIdentity(type, id, 'checkpoint');
        if (!owner || ttlSeconds !== CHECKPOINT_TTL || value?.version !== PROVIDER_RETIREMENT_VERSION
          || value?.plan_id !== PROVIDER_RETIREMENT_PLAN_ID) throw fail('retirement_scope');
        const raw = JSON.stringify(value);
        if (Buffer.byteLength(raw) > 64 * 1024) throw fail('retirement_checkpoint');
        const saved = await command(['EVAL', SAVE_CHECKPOINT, 2, LEASE_KEY, CHECKPOINT_KEY, owner, raw, ttlSeconds], true);
        if (saved !== 1) throw fail('retirement_lease_lost');
        checkpoint = structuredClone(value); return true;
      },
      readSnapshot: (type, id) => {
        requireReplacement(type, id); checkBudget();
        // This is deliberately stricter than a legacy fallback: both current
        // replacement publications must be verified in the new shared store.
        const pending = Promise.resolve(readCache(type, id, { signal, deadline: workDeadline, timeoutMs: 5000 }))
          .then(envelope => envelope?.payload ?? null);
        reads.add(pending);
        pending.then(() => reads.delete(pending), () => reads.delete(pending));
        return pending;
      },
      deleteWarmPrefix: (prefix, cursor, remaining) => deletePrefix('warm', prefix, cursor, remaining),
      deleteRawPrefix: (prefix, cursor, remaining) => deletePrefix('raw', prefix, cursor, remaining),
      deleteWarmMany: (type, ids) => {
        if (type !== 'quant-coverage-v1' || !Array.isArray(ids) || ids.length > 17
          || ids.some(id => typeof id !== 'string' || !EXACT_KEYS.has(`warm:${type}:${id.toUpperCase()}`))) throw fail('retirement_scope');
        return remove([...new Set(ids.map(id => `warm:${type}:${id.toUpperCase()}`))]);
      },
      deleteRawMany: keys => {
        if (!Array.isArray(keys) || keys.some(key => !RETIRED_RAW_KEYS.includes(key))) throw fail('retirement_scope');
        return remove([...new Set(keys)]);
      },
    } });
    if (state?.skipped) return result('deferred', 'retirement_lease_busy');
    checkpoint = state;
    return result(state.complete ? 'complete' : 'progress');
  } catch (error) {
    if (error?.status === 503 && !error?.code) return result('blocked', 'retirement_replacement_unready');
    const code = SAFE_ERRORS.has(error?.code) ? error.code
      : ['deadline', 'timeout'].includes(error?.code) || signal?.aborted || now() >= workDeadline ? 'maintenance_deadline' : 'retirement_unavailable';
    return result('deferred', code);
  } finally {
    // The readiness check starts two bounded reads concurrently. Await any
    // sibling read after a failure; no abandoned asynchronous work survives.
    await Promise.allSettled([...reads]);
  }
}

function requireReplacement(type, id) {
  if (type !== FUNDAMENTAL_UNIVERSE_CACHE || !['ttm', 'annual'].includes(id)) throw fail('retirement_scope');
}
