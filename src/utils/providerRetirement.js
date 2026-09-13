import { warmAcquireLease, warmCacheEnabled, warmDeleteMany, warmDeleteRawMany, warmDeleteRawPrefix, warmDeleteTypePrefix, warmGet, warmReleaseLease, warmSet } from './warmCache.js';
import { FUNDAMENTAL_UNIVERSE_CACHE, isUniverseSnapshot } from './marketUniverseServer.js';
import { UNIVERSE_FRESH_MS } from './marketUniverse.js';
import { readSnapshot } from './snapshotCache.js';

export const PROVIDER_RETIREMENT_VERSION = 'edgar.provider-retirement.v1';
export const PROVIDER_RETIREMENT_PLAN_ID = 'security-price-retirement-2026-09-r4';
const WRITER_QUIESCENCE_MS = 360_000;
const VERIFY_DELAY_MS = 15_000;

// Audited reproducible caches only. SEC facts, CFTC snapshots, portfolios,
// notes, evidence, identifiers, allocations, Form 4 values, and user data are
// intentionally absent. Provider names remain here solely to erase old keys.
export const RETIRED_CACHE_PREFIXES = [
  'stock-raw-yahoo', 'stock-price-failure-v1', 'price-provider-cooldown',
  'lease:price-provider-start', 'lease:stock-price-refresh',
  'quant-adjusted-prices-v1', 'market-signal-result-v1',
  'market-signal-last-eligible-v1', 'lease:market-signal-result',
  'edgar.factor-universe.v1', 'edgar.quant-universe.v1',
  'lease:edgar.factor-universe.v1', 'lease:quant-coverage-v1',
];

const TARGETS = [
  ...RETIRED_CACHE_PREFIXES.map(prefix => ({ kind: 'warm', prefix })),
  { kind: 'raw', prefix: 'views:' },
  { kind: 'raw', prefix: 'rl:stock:' },
  { kind: 'raw', prefix: 'rl:market-signals-v1:' },
  { kind: 'raw', prefix: 'rl:factor-universe:' },
];
const RETIRED_QUANT_IDS = [...Array.from({ length: 16 }, (_, index) => `batch-${index}`), 'compact-price-storage'];
export const RETIRED_RAW_KEYS = ['hot_tickers'];

function validCheckpoint(value) {
  const common = value?.version === PROVIDER_RETIREMENT_VERSION
    && value?.plan_id === PROVIDER_RETIREMENT_PLAN_ID
    && ['delete', 'verify'].includes(value.phase)
    && Number.isSafeInteger(value.target_index) && value.target_index >= 0 && value.target_index <= TARGETS.length
    && /^\d+$/.test(String(value.cursor))
    && Number.isSafeInteger(value.removed) && value.removed >= 0
    && Number.isSafeInteger(value.scanned) && value.scanned >= 0
    && typeof value.exact_cleaned === 'boolean'
    && typeof value.complete === 'boolean'
    && Number.isFinite(Date.parse(value.updated_at))
    && Number.isFinite(Date.parse(value.deletion_not_before))
    && value.ready_proof?.namespace === FUNDAMENTAL_UNIVERSE_CACHE
    && Number.isFinite(Date.parse(value.ready_proof?.checked_at))
    && ['ttm', 'annual'].every(basis => Number.isFinite(Date.parse(value.ready_proof?.[basis]?.generated_at)) && Number.isSafeInteger(value.ready_proof?.[basis]?.issuers));
  if (!common) return false;
  if (value.phase === 'delete') return !value.complete && !value.exact_cleaned && value.target_index <= TARGETS.length && value.verification_not_before == null && value.completed_at == null;
  if (!value.exact_cleaned || !Number.isFinite(Date.parse(value.verification_not_before))) return false;
  if (!value.complete) return value.target_index <= TARGETS.length && value.completed_at == null && Number.isSafeInteger(value.verification_removed) && value.verification_removed >= 0;
  return value.target_index === TARGETS.length && value.cursor === '0' && Number.isFinite(Date.parse(value.completed_at));
}

async function assertReplacementReady(read = readSnapshot, now = Date.now()) {
  const [ttm, annual] = await Promise.all([
    read(FUNDAMENTAL_UNIVERSE_CACHE, 'ttm'),
    read(FUNDAMENTAL_UNIVERSE_CACHE, 'annual'),
  ]);
  const ready = (value, basis) => isUniverseSnapshot(value) && value.basis === basis && value.status === 'ready' && value.sec_stale === false
    && value.rows.length >= 8 && value.universe?.issuers === value.rows.length && value.universe?.issuer_coverage >= .95
    && now - Date.parse(value.generated_at) >= 0 && now - Date.parse(value.generated_at) <= UNIVERSE_FRESH_MS
    && now - Date.parse(value.sec_snapshot_at) >= 0 && now - Date.parse(value.sec_snapshot_at) <= UNIVERSE_FRESH_MS;
  if (!ready(ttm, 'ttm') || !ready(annual, 'annual')) {
    throw Object.assign(new Error('Both SEC-only Fundamental Lab v2 snapshots must be valid before legacy caches are removed.'), { status: 503 });
  }
  return {
    namespace: FUNDAMENTAL_UNIVERSE_CACHE, checked_at: new Date(now).toISOString(),
    ttm: { generated_at: ttm.generated_at, sec_snapshot_at: ttm.sec_snapshot_at, issuers: ttm.rows.length },
    annual: { generated_at: annual.generated_at, sec_snapshot_at: annual.sec_snapshot_at, issuers: annual.rows.length },
  };
}

export async function runProviderRetirementStep({ maxKeys = 1000, now = Date.now(), operations = {} } = {}) {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 2500) throw Object.assign(new Error('Retirement maxKeys must be an integer from 1 to 2500.'), { status: 400 });
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') throw Object.assign(new Error('Legacy provider cleanup is restricted to the production deployment.'), { status: 403 });
  const enabled = operations.enabled || warmCacheEnabled;
  const get = operations.get || warmGet, set = operations.set || warmSet;
  const acquire = operations.acquire || warmAcquireLease, release = operations.release || warmReleaseLease;
  const deleteWarmPrefix = operations.deleteWarmPrefix || warmDeleteTypePrefix;
  const deleteRawPrefix = operations.deleteRawPrefix || warmDeleteRawPrefix;
  const deleteWarmMany = operations.deleteWarmMany || warmDeleteMany;
  const deleteRawMany = operations.deleteRawMany || warmDeleteRawMany;
  if (!enabled()) throw Object.assign(new Error('Shared cache storage is unavailable.'), { status: 503 });

  // The scheduled route remains installed so a deployment cannot strand an
  // armed migration. Once verification completes, each later run is one
  // read-only checkpoint lookup and performs no lease or deletion work.
  const completed = await get(PROVIDER_RETIREMENT_VERSION, 'checkpoint');
  if (validCheckpoint(completed) && completed.complete) return completed;

  const token = await acquire(PROVIDER_RETIREMENT_VERSION, 'run', 360_000);
  if (!token) return { version: PROVIDER_RETIREMENT_VERSION, plan_id: PROVIDER_RETIREMENT_PLAN_ID, skipped: 'Retirement cleanup is already running or coordination is unavailable.', complete: false };
  try {
    let prior = await get(PROVIDER_RETIREMENT_VERSION, 'checkpoint');
    if (validCheckpoint(prior) && prior.complete) return prior;
    if (!validCheckpoint(prior)) prior = null;
    if (!prior) {
      const readyProof = await assertReplacementReady(operations.readSnapshot || readSnapshot, now);
      const initial = {
        version: PROVIDER_RETIREMENT_VERSION, plan_id: PROVIDER_RETIREMENT_PLAN_ID,
        phase: 'delete', target_index: 0, cursor: '0', removed: 0, scanned: 0,
        exact_cleaned: false, complete: false, ready_proof: readyProof,
        deletion_not_before: new Date(now + WRITER_QUIESCENCE_MS).toISOString(), updated_at: new Date(now).toISOString(),
      };
      if (!await set(PROVIDER_RETIREMENT_VERSION, 'checkpoint', initial, 180 * 86400)) throw new Error('Retirement readiness checkpoint could not be persisted.');
      return initial;
    }
    const state = { ...prior };
    if (now < Date.parse(state.deletion_not_before)) return state;
    if (state.phase === 'verify' && Number.isFinite(Date.parse(state.verification_not_before)) && now < Date.parse(state.verification_not_before)) return state;
    if (state.phase === 'delete') state.ready_proof = await assertReplacementReady(operations.readSnapshot || readSnapshot, now);

    let remaining = maxKeys, pages = 0;
    while (state.target_index < TARGETS.length && remaining > 0 && pages < 32) {
      const target = TARGETS[state.target_index];
      const result = target.kind === 'warm'
        ? await deleteWarmPrefix(target.prefix, state.cursor, remaining)
        : await deleteRawPrefix(target.prefix, state.cursor, remaining);
      if (!result || !Number.isSafeInteger(result.matched) || !Number.isSafeInteger(result.removed) || result.matched < 0 || result.removed < 0 || result.removed > result.matched || result.matched > remaining || typeof result.complete !== 'boolean' || !/^\d+$/.test(String(result.cursor))) throw new Error(`Retirement cleanup could not scan target ${state.target_index}.`);
      state.removed += result.removed;
      state.scanned += result.matched;
      if (state.phase === 'verify') state.verification_removed += result.removed;
      remaining -= result.matched;
      pages += 1;
      if (result.complete) { state.target_index += 1; state.cursor = '0'; }
      else state.cursor = result.cursor;
      state.updated_at = new Date(now).toISOString();
      if (!await set(PROVIDER_RETIREMENT_VERSION, 'checkpoint', state, 180 * 86400)) throw new Error('Retirement cleanup checkpoint could not be persisted.');
    }

    if (state.target_index >= TARGETS.length && state.phase === 'delete') {
      const quantRemoved = await deleteWarmMany('quant-coverage-v1', RETIRED_QUANT_IDS);
      const rawRemoved = await deleteRawMany(RETIRED_RAW_KEYS);
      if (!Number.isSafeInteger(quantRemoved) || quantRemoved < 0 || quantRemoved > RETIRED_QUANT_IDS.length || !Number.isSafeInteger(rawRemoved) || rawRemoved < 0 || rawRemoved > RETIRED_RAW_KEYS.length) throw new Error('Retirement cleanup could not remove exact legacy keys.');
      state.removed += quantRemoved + rawRemoved;
      state.exact_cleaned = true;
      state.phase = 'verify';
      state.target_index = 0;
      state.cursor = '0';
      state.verification_removed = 0;
      state.verification_not_before = new Date(now + VERIFY_DELAY_MS).toISOString();
    } else if (state.target_index >= TARGETS.length && state.phase === 'verify') {
      const quantRemoved = await deleteWarmMany('quant-coverage-v1', RETIRED_QUANT_IDS);
      const rawRemoved = await deleteRawMany(RETIRED_RAW_KEYS);
      if (!Number.isSafeInteger(quantRemoved) || quantRemoved < 0 || quantRemoved > RETIRED_QUANT_IDS.length || !Number.isSafeInteger(rawRemoved) || rawRemoved < 0 || rawRemoved > RETIRED_RAW_KEYS.length) throw new Error('Retirement verification could not recheck exact legacy keys.');
      state.removed += quantRemoved + rawRemoved;
      state.verification_removed += quantRemoved + rawRemoved;
      if (state.verification_removed > 0) {
        state.target_index = 0; state.cursor = '0'; state.verification_removed = 0;
        state.verification_not_before = new Date(now + VERIFY_DELAY_MS).toISOString();
      } else {
        state.complete = true;
        state.completed_at = new Date(now).toISOString();
      }
    }

    state.updated_at = new Date(now).toISOString();
    if (!await set(PROVIDER_RETIREMENT_VERSION, 'checkpoint', state, 180 * 86400)) throw new Error('Retirement cleanup checkpoint could not be persisted.');
    return state;
  } finally {
    await release(PROVIDER_RETIREMENT_VERSION, 'run', token);
  }
}
