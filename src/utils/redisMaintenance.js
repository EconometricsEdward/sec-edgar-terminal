/** Private, bounded migration of reviewed public-data caches. No credentials,
 * raw keys, source bodies, or arbitrary commands are exposed by this module.
 * Redis continues to own leases, generation fences, cooldowns and rate limits.
 */
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { disposableCachePolicy } from '../../supabase/functions/edgar-data-gateway/cachePolicy.js';

const VERSION = 1;
const DRAIN_MS = 10 * 60_000;
const WEEK_MS = 7 * 86400_000;
const MAX_STATE_BYTES = 60 * 1024;
const MAX_RAW_BYTES = 32 * 1024 * 1024;
const MAX_KEYS = 200;
const MAX_ORPHANS = 96;
const MAX_UNKNOWN_TYPES = 24;
const READ_ONLY_COMMANDS = new Set(['SCAN', 'TYPE', 'STRLEN', 'PTTL', 'INFO', 'DBSIZE', 'EVAL_RO']);
const SHA256 = /^[a-f0-9]{64}$/;
const GENERATION = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{64})$/i;
const MODES = new Set(['inventory', 'migrate', 'steady']);
const sha = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const finiteTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const redisKey = (type, id) => `warm:${type}:${id.toUpperCase()}`;
const fail = code => Object.assign(new Error(code), { code });

export const REDIS_SNAPSHOT_TARGETS = Object.freeze([
  ...['quant-atlas-v1', 'quant-atlas-v2:production', 'market-v2', 'market-research-v3'].flatMap(type => ['ATLAS', 'ATLAS-LAST-GOOD'].map(id => ({ type, id }))),
  ...['ANNUAL', 'QUARTER', 'TTM'].flatMap(basis => [basis, `${basis}-LAST-GOOD`].map(id => ({ type: 'edgar.fundamental-universe.v2:production', id }))),
  { type: 'market-overview-v1', id: 'ATLAS' },
]);

let marketValidators, universeValidators;
/** A newer cache publication may establish orphan safety, but never authorizes
 * deleting a differing current Redis manifest. Validate the actual UI contract
 * and source publication time, rather than treating any dated JSON as ready.
 */
async function snapshotPublication(targetIndex, payload, now) {
  const target = REDIS_SNAPSHOT_TARGETS[targetIndex];
  if (!target) return null;
  let sourceTime, schema, basis = null, valid = false;
  if (['quant-atlas-v1', 'quant-atlas-v2:production', 'market-research-v3', 'market-overview-v1'].includes(target.type)) {
    marketValidators ||= Promise.all([import('./marketResearchValidation.js'), import('./marketResearch.js')]);
    const [validators, { MARKET_VERSION }] = await marketValidators;
    valid = target.type === 'market-overview-v1' ? validators.isMarketOverview(payload) : validators.isMarketAtlas(payload, MARKET_VERSION);
    if (valid && (!payload.companies.length || payload.companies.length > payload.requested)) valid = false;
    schema = target.type === 'market-overview-v1' ? 'market-overview-v1' : MARKET_VERSION;
    sourceTime = payload?.generatedAt;
  } else if (target.type === 'edgar.fundamental-universe.v2:production') {
    universeValidators ||= import('./marketUniverseServer.js');
    const { isUniverseSnapshot } = await universeValidators;
    basis = target.id.replace(/-LAST-GOOD$/, '').toLowerCase();
    valid = isUniverseSnapshot(payload, basis); schema = payload?.schema_version; sourceTime = payload?.generated_at;
  }
  const timestamp = finiteTime(sourceTime) ? Date.parse(sourceTime) : NaN;
  if (!valid || !Number.isFinite(timestamp) || timestamp > now || now - timestamp > WEEK_MS) return null;
  return { target: targetIndex, schema, basis, publicationTime: new Date(timestamp).toISOString() };
}

/** Fixed allowlist classification, including narrow legacy chunk identities. */
export function classifyRedisMaintenanceKey(rawKey) {
  if (typeof rawKey !== 'string' || rawKey.length > 1200) return { family: 'unknown' };
  if (/^(?:rl:|warm:(?:lease:|generation:))/.test(rawKey)
    || /(?:^|[:_-])(?:cooldown|auth|session|token)(?:[:_-]|$)/i.test(rawKey)) return { family: 'coordination' };
  for (let target = 0; target < REDIS_SNAPSHOT_TARGETS.length; target++) {
    const { type, id } = REDIS_SNAPSHOT_TARGETS[target];
    const prefix = redisKey(`${type}:chunks`, `${id}:`);
    if (!rawKey.startsWith(prefix)) continue;
    const parts = rawKey.slice(prefix.length).split(':');
    if (parts.length === 2 && GENERATION.test(parts[0]) && /^(?:0|[1-9][0-9]?)$/.test(parts[1])) {
      return { family: 'snapshot-chunks', target, generation: parts[0].toUpperCase(), index: Number(parts[1]) };
    }
    return { family: 'unknown' };
  }
  if (!rawKey.startsWith('warm:')) return { family: rawKey.startsWith('scan:') ? 'legacy-scan' : 'unknown' };
  const value = rawKey.slice(5);
  for (let position = value.lastIndexOf(':'); position > 0; position = value.lastIndexOf(':', position - 1)) {
    const policy = disposableCachePolicy(value.slice(0, position), value.slice(position + 1));
    if (policy && redisKey(policy.type, policy.id) === rawKey) return policy;
  }
  return { family: 'unknown' };
}

function safeProviderCode(body, status) {
  const text = typeof body?.error === 'string' ? body.error : '';
  if (status === 401 || /WRONGPASS|NOAUTH|NOPERM/i.test(text)) return 'redis_auth';
  if (/\bOOM\b/i.test(text)) return 'redis_oom';
  if (/maxmemory|max.*memory|memory.*limit/i.test(text)) return 'redis_maxmemory';
  if (/DB capacity quota exceeded|max.*(?:data|size)|storage.*limit|data.*size.*limit/i.test(text)) return 'redis_storage_limit';
  if (status === 429 || /quota|request.*limit|command.*limit/i.test(text)) return 'redis_quota';
  if (/unknown command|unsupported/i.test(text)) return 'redis_unsupported';
  return status >= 400 ? 'redis_http' : 'redis_response';
}

async function boundedResponse(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw fail('redis_response_size');
  if (!response.body) throw fail('redis_response');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > maximum) throw fail('redis_response_size');
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
    catch { throw fail('redis_response'); }
  } finally { await reader.cancel().catch(() => {}); }
}

/** Factory is injectable for offline tests. Never returns its runtime secrets. */
export function createRedisMaintenanceTransport({ env = process.env, fetchImpl = (...args) => fetch(...args), now = Date.now, timeoutSignal = milliseconds => AbortSignal.timeout(milliseconds) } = {}) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  async function send(commands, { signal, deadline = now() + 5000, pipeline = false, maxBytes = 2 * 1024 * 1024 } = {}) {
    if (!url || !token) throw fail('redis_unconfigured');
    // Cold SCAN pages can load Redis's persisted key index. Give read-only
    // maintenance five seconds while preserving the caller's overall budget;
    // deletion scripts keep their smaller two-second bound.
    const readOnly = pipeline ? commands.every(command => READ_ONLY_COMMANDS.has(command[0])) : READ_ONLY_COMMANDS.has(commands[0]);
    const timeoutMs = readOnly ? 5000 : 2000;
    const budgetMs = deadline - now(), remaining = Math.min(timeoutMs, budgetMs);
    if (remaining <= 0 || signal?.aborted) throw fail('maintenance_deadline');
    const timeout = timeoutSignal(remaining);
    try {
      const response = await fetchImpl(`${url}${pipeline ? '/pipeline' : ''}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands), redirect: 'error', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const result = await boundedResponse(response, maxBytes);
      if (!response.ok || result?.error) throw fail(safeProviderCode(result, response.status));
      if (!pipeline) {
        if (!result || !Object.hasOwn(result, 'result')) throw fail('redis_response');
        return result.result;
      }
      if (!Array.isArray(result) || result.length !== commands.length || result.some(item => !item || !Object.hasOwn(item, 'result') || item.error)) {
        throw fail(safeProviderCode(result?.find?.(item => item?.error), response.status));
      }
      return result.map(item => item.result);
    } catch (error) {
      if (signal?.aborted || timeout.aborted && budgetMs < timeoutMs) throw fail('maintenance_deadline');
      if (timeout.aborted || error?.name === 'TimeoutError') throw fail('redis_timeout');
      if (error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') throw fail('redis_connect_timeout');
      if (typeof error?.code === 'string' && /^redis_[a-z_]{1,48}$/.test(error.code)) throw error;
      throw fail('redis_transport');
    }
  }
  return { command: (command, options) => send(command, options), pipeline: (commands, options) => send(commands, { ...options, pipeline: true }) };
}

function initialState(now) {
  return { version: VERSION, phase: 'inventory', cursor: '0', pending: [], snapshotIndex: 0,
    startedAt: new Date(now).toISOString(), inventory: { pages: 0, keyObservations: 0, stringValueBytes: 0, byFamily: {}, byUnknownType: {} },
    counters: { inspected: 0, migrated: 0, removed: 0, removedStringValueBytes: 0, preserved: 0, errors: 0 },
    snapshotProofs: {}, orphans: {}, errors: {}, completedAt: null, nextAt: null };
}

function checkedState(value, now) {
  if (value == null || Object.keys(value).length === 0) return initialState(now);
  if (value.version !== VERSION || !['inventory', 'migration', 'steady'].includes(value.phase)
    || !/^\d{1,30}$/.test(value.cursor) || !Array.isArray(value.pending) || value.pending.length > 1000
    || value.pending.some(key => typeof key !== 'string' || key.length > 1200)
    || !Number.isInteger(value.snapshotIndex) || value.snapshotIndex < 0 || value.snapshotIndex > REDIS_SNAPSHOT_TARGETS.length
    || !value.inventory?.byFamily || !value.counters || !value.snapshotProofs || !value.orphans || !value.errors
    || Buffer.byteLength(JSON.stringify(value)) > MAX_STATE_BYTES) throw fail('maintenance_state');
  return structuredClone(value);
}

const FAMILY_NAMES = new Set(['unknown', 'coordination', 'legacy-scan', 'snapshot-chunks', 'snapshot', 'checkpoint', 'research', 'document', 'reference', 'history']);
const numberOrNull = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeUnknownType = value => typeof value === 'string' && /^[a-z][a-z0-9._-]{2,63}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value)
  && !/(?:auth|session|token|lease|generation|cooldown|user|account|credential|secret|password|login|profile|note)/i.test(value);
function unknownTypeLabel(rawKey) {
  const type = /^warm:([^:]+):/.exec(rawKey)?.[1];
  return safeUnknownType(type) ? type : 'other';
}
/** Safe operator display: no Redis keys, queues, hashes or raw error text. */
export function summarizeRedisMaintenanceState(state) {
  if (!state || state.version !== VERSION) return null;
  const counters = Object.fromEntries(['inspected', 'migrated', 'removed', 'removedStringValueBytes', 'preserved', 'errors'].map(key => [key, numberOrNull(state.counters?.[key])]));
  const byFamily = {};
  for (const [family, values] of Object.entries(state.inventory?.byFamily || {})) {
    if (!FAMILY_NAMES.has(family)) continue;
    byFamily[family] = Object.fromEntries(['keyObservations', 'stringValueBytes', 'persistent', 'expiresWithinDay', 'expiresLater'].map(key => [key, numberOrNull(values?.[key])]));
  }
  const byUnknownType = {};
  for (const [type, values] of Object.entries(state.inventory?.byUnknownType || {})) {
    if (!safeUnknownType(type) || Object.keys(byUnknownType).filter(key => key !== 'other').length >= MAX_UNKNOWN_TYPES && type !== 'other') continue;
    byUnknownType[type] = { keyObservations: numberOrNull(values?.keyObservations), stringValueBytes: numberOrNull(values?.stringValueBytes) };
  }
  return { version: VERSION, phase: ['inventory', 'migration', 'steady'].includes(state.phase) ? state.phase : null, counters,
    inventory: { pages: numberOrNull(state.inventory?.pages), keyObservations: numberOrNull(state.inventory?.keyObservations),
      stringValueBytes: numberOrNull(state.inventory?.stringValueBytes), byFamily, byUnknownType,
      basis: 'SCAN observations; duplicate visits and concurrent changes are possible; string bytes exclude Redis overhead.' },
    errors: Object.fromEntries(Object.entries(state.errors || {}).filter(([key, count]) => /^(?:redis|cache|maintenance|snapshot|migration)_[a-z_]{1,48}$/.test(key) && numberOrNull(count) !== null).slice(0, 32)),
    redis: state.redis ? { checkedAt: finiteTime(state.redis.checkedAt) ? state.redis.checkedAt : null,
      usedMemoryBytes: numberOrNull(state.redis.usedMemoryBytes), maxMemoryBytes: numberOrNull(state.redis.maxMemoryBytes), keyCount: numberOrNull(state.redis.keyCount) } : null,
    completedAt: finiteTime(state.completedAt) ? state.completedAt : null, nextAt: finiteTime(state.nextAt) ? state.nextAt : null };
}
function summary(state, control, status = 'progress', code = null) {
  return { ...summarizeRedisMaintenanceState(state), status, mode: control.mode, ...(code ? { code } : {}) };
}

const READ_STRING = `
local value = redis.call('GET', KEYS[1])
if not value then return {false, -2} end
return {value, redis.call('PTTL', KEYS[1])}
`;

const COMPARE_DELETE = `
local value = redis.call('GET', KEYS[1])
if not value or redis.sha1hex(value) ~= ARGV[1] then return {0, 0} end
local bytes = string.len(value)
return {redis.call('DEL', KEYS[1]), bytes}
`;

// Parent and every individual chunk are fenced. A renewed/changed Redis writer
// cannot lose its data after our independent Supabase read-back verification.
const DELETE_SNAPSHOT = `
local parent = redis.call('GET', KEYS[1])
if not parent or redis.sha1hex(parent) ~= ARGV[1] then return {0, 0} end
for i = 2, #KEYS do
  local value = redis.call('GET', KEYS[i])
  if not value or redis.sha1hex(value) ~= ARGV[i] then return {0, 0} end
end
local count, bytes = 0, string.len(parent)
for i = 2, #KEYS do bytes = bytes + redis.call('STRLEN', KEYS[i]) end
for i = 1, #KEYS do count = count + redis.call('DEL', KEYS[i]) end
return {count, bytes}
`;

const DELETE_ORPHAN = `
local parent = redis.call('GET', KEYS[1])
if ARGV[1] == 'absent' then
  if parent then return {0, 0} end
elseif not parent or redis.sha1hex(parent) ~= ARGV[1] then return {0, 0} end
local value = redis.call('GET', KEYS[2])
if not value or redis.sha1hex(value) ~= ARGV[2] then return {0, 0} end
local bytes = string.len(value)
return {redis.call('DEL', KEYS[2]), bytes}
`;

function addDeletion(state, result, maximum) {
  if (!Array.isArray(result) || result.length !== 2 || !Number.isSafeInteger(result[0]) || result[0] < 0 || result[0] > maximum
    || !Number.isSafeInteger(result[1]) || result[1] < 0 || result[1] > 48 * 1024 * 1024) throw fail('redis_delete_response');
  state.counters.removed += result[0];
  if (result[0]) state.counters.removedStringValueBytes += result[1];
}

function errorCode(error) {
  return typeof error?.code === 'string' && /^(?:redis|cache|maintenance|snapshot|migration)_[a-z_]{1,48}$/.test(error.code) ? error.code : 'maintenance_operation';
}
function recordError(state, error) {
  const code = errorCode(error); state.counters.errors++;
  state.errors[code] = (state.errors[code] || 0) + 1; state.lastError = code; return code;
}

/** One trusted signed-scheduler step. Operator-only DB mode changes authorize
 * migration; production must be ready before modeChangedAt starts its drain.
 */
export async function maintainRedisCache({ signal, deadline = Date.now() + 20_000 } = {}, injected = {}) {
  const now = injected.now || Date.now;
  const defaults = injected.readState ? null : await import('./disposableCache.js');
  const readState = injected.readState || defaults.readCacheMaintenanceState;
  const claimState = injected.claimState || defaults.claimCacheMaintenanceState;
  const saveState = injected.saveState || defaults.saveCacheMaintenanceState;
  const cachePut = injected.cachePut || defaults?.cachePut;
  const cacheGet = injected.cacheGet || defaults?.cacheGet;
  const transport = injected.redis || createRedisMaintenanceTransport();
  const options = { signal, deadline };
  let control;
  try { control = await readState(options); }
  catch (error) { return { version: VERSION, status: 'unavailable', code: errorCode(error) }; }
  if (!MODES.has(control?.mode) || !finiteTime(control?.modeChangedAt)) return { version: VERSION, status: 'unavailable', code: 'maintenance_control' };
  let state;
  try { state = checkedState(control.state, now()); }
  catch (error) { return { version: VERSION, status: 'unavailable', code: errorCode(error) }; }
  const modeTransition = control.mode === 'migrate' && state.phase === 'inventory' && state.completedAt;
  if (!modeTransition && finiteTime(state.nextAt) && now() < Date.parse(state.nextAt)) return summary(state, control, 'waiting');
  const owner = randomUUID();
  try { control = await claimState(owner, options); }
  catch (error) { return { version: VERSION, status: 'unavailable', code: errorCode(error) }; }
  if (!control) return { version: VERSION, status: 'busy' };
  if (control.owner !== owner || !MODES.has(control.mode) || !finiteTime(control.modeChangedAt)
    || !finiteTime(control.leaseUntil) || Date.parse(control.leaseUntil) <= now()) return { version: VERSION, status: 'unavailable', code: 'maintenance_claim' };
  try { state = checkedState(control.state, now()); }
  catch (error) { return { version: VERSION, status: 'unavailable', code: errorCode(error) }; }
  const remaining = () => !signal?.aborted && now() < Math.min(deadline, Date.parse(control.leaseUntil)) - 2500;
  const command = (value, extra = {}) => transport.command(value, { ...options, ...extra });
  const pipeline = values => transport.pipeline(values, options);
  const drainComplete = () => control.mode === 'migrate' && now() >= Date.parse(control.modeChangedAt) + DRAIN_MS;
  let status = 'progress', code = null;

  async function captureRedisInfo() {
    try {
      const [info, size] = await pipeline([['INFO', 'memory'], ['DBSIZE']]);
      const fields = typeof info === 'string' ? Object.fromEntries(info.split(/\r?\n/).map(line => line.split(':', 2))) : {};
      const number = name => /^\d+$/.test(fields[name] || '') && Number.isSafeInteger(Number(fields[name])) ? Number(fields[name]) : null;
      state.redis = { checkedAt: new Date(now()).toISOString(), usedMemoryBytes: number('used_memory'), maxMemoryBytes: number('maxmemory'),
        keyCount: Number.isSafeInteger(size) && size >= 0 ? size : null };
    } catch (error) { recordError(state, error); }
  }

  async function nextPage() {
    if (state.pending.length) return;
    const result = await command(['SCAN', state.cursor, 'COUNT', '100'], { maxBytes: 128 * 1024 });
    if (!Array.isArray(result) || result.length !== 2 || !/^\d{1,30}$/.test(String(result[0])) || !Array.isArray(result[1])
      || result[1].length > 1000 || result[1].some(key => typeof key !== 'string' || key.length > 1200)) throw fail('redis_scan_response');
    // SCAN COUNT is a hint, not a limit. Keep every returned key before moving
    // the cursor so bounded processing never silently skips a large page.
    const pending = [...new Set(result[1])];
    if (Buffer.byteLength(JSON.stringify({ ...state, pending })) > MAX_STATE_BYTES) throw fail('maintenance_scan_page_size');
    state.cursor = String(result[0]); state.pending = pending; state.inventory.pages++;
  }

  async function inventoryPage(keys) {
    const metadata = await pipeline(keys.flatMap(key => [['TYPE', key], ['PTTL', key]]));
    if (!Array.isArray(metadata) || metadata.length !== keys.length * 2) throw fail('redis_inventory_response');
    const strings = keys.filter((_, index) => metadata[index * 2] === 'string');
    const lengths = strings.length ? await pipeline(strings.map(key => ['STRLEN', key])) : [];
    let stringIndex = 0;
    keys.forEach((key, index) => {
      const kind = metadata[index * 2], ttl = metadata[index * 2 + 1];
      if (typeof kind !== 'string' || !Number.isSafeInteger(ttl) || ttl < -2) throw fail('redis_inventory_response');
      const bytes = kind === 'string' ? lengths[stringIndex++] : 0;
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw fail('redis_inventory_response');
      const family = classifyRedisMaintenanceKey(key).family;
      const total = state.inventory.byFamily[family] ||= { keyObservations: 0, stringValueBytes: 0, persistent: 0, expiresWithinDay: 0, expiresLater: 0 };
      total.keyObservations++; total.stringValueBytes += bytes;
      if (family === 'unknown') {
        const types = state.inventory.byUnknownType ||= {};
        let type = unknownTypeLabel(key);
        if (!Object.hasOwn(types, type) && Object.keys(types).filter(key => key !== 'other').length >= MAX_UNKNOWN_TYPES) type = 'other';
        const summary = types[type] ||= { keyObservations: 0, stringValueBytes: 0 };
        summary.keyObservations++; summary.stringValueBytes += bytes;
      }
      if (ttl === -1) total.persistent++; else if (ttl >= 0 && ttl <= 86400_000) total.expiresWithinDay++; else if (ttl > 86400_000) total.expiresLater++;
      state.inventory.keyObservations++; state.inventory.stringValueBytes += bytes; state.counters.inspected++;
    });
  }

  async function readString(key) {
    const observedAt = now();
    const result = await command(['EVAL_RO', READ_STRING, 1, key]);
    if (!Array.isArray(result) || result.length !== 2) throw fail('redis_value_response');
    const [raw, ttlMs] = result;
    if (raw == null || ttlMs === -2) return null;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024 || !Number.isSafeInteger(ttlMs)) throw fail('redis_value_response');
    return { raw, sha1: sha(raw, 'sha1'), expiresAt: ttlMs > 0 ? observedAt + ttlMs : null };
  }

  async function preserve(type, id, payload, expiresAt) {
    const policy = disposableCachePolicy(type, id);
    const ttl = Math.floor(Math.min(policy?.maxTtlSeconds || 0, (expiresAt - now()) / 1000));
    if (!policy || !Number.isFinite(expiresAt) || ttl < 1 || !remaining()) return false;
    const rawSha256 = sha(JSON.stringify(payload));
    await cachePut(type, id, payload, ttl, { ...options, ifHash: 'absent', expiresAt: new Date(expiresAt).toISOString() });
    if (!remaining()) return false;
    const verified = await cacheGet(type, id, options);
    if (!verified || verified.rawSha256 !== rawSha256 || !finiteTime(verified.expiresAt) || Date.parse(verified.expiresAt) <= now()) return false;
    return { rawSha256, expiresAt: verified.expiresAt };
  }

  async function refreshOrphanProof(targetIndex, reference, envelope = null) {
    if (!reference || reference.target !== targetIndex || !finiteTime(reference.publicationTime) || !remaining()) return null;
    const { type, id } = REDIS_SNAPSHOT_TARGETS[targetIndex];
    const current = envelope || await cacheGet(type, id, options);
    if (!current || !SHA256.test(current.rawSha256) || !finiteTime(current.expiresAt) || Date.parse(current.expiresAt) <= now()) return null;
    const publication = await snapshotPublication(targetIndex, current.payload, now());
    if (!publication || publication.schema !== reference.schema || publication.basis !== reference.basis
      || Date.parse(publication.publicationTime) < Date.parse(reference.publicationTime)
      || sha(JSON.stringify(current.payload)) !== current.rawSha256) return null;
    const latest = state.snapshotProofs[targetIndex];
    if (latest && finiteTime(latest.publicationTime) && Date.parse(publication.publicationTime) < Date.parse(latest.publicationTime)) return null;
    const proof = { ...publication, rawSha256: current.rawSha256, expiresAt: current.expiresAt, verifiedAt: new Date(now()).toISOString() };
    state.snapshotProofs[targetIndex] = proof;
    return proof;
  }

  async function migrateSnapshot(targetIndex) {
    const { type, id } = REDIS_SNAPSHOT_TARGETS[targetIndex];
    const parentKey = redisKey(type, id), parent = await readString(parentKey);
    if (!parent || !parent.expiresAt) return;
    let manifest; try { manifest = JSON.parse(parent.raw); } catch { throw fail('snapshot_manifest'); }
    if (manifest?.format !== 'gzip-chunks-v1') return;
    if (!Array.isArray(manifest.ids) || manifest.ids.length < 1 || manifest.ids.length > 100 || !SHA256.test(manifest.sha256)
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_RAW_BYTES) throw fail('snapshot_manifest');
    let generation = null;
    const keys = manifest.ids.map((chunkId, index) => {
      if (typeof chunkId !== 'string') throw fail('snapshot_manifest');
      const parts = chunkId.toUpperCase().split(':');
      if (parts.length !== 3 || parts[0] !== id || !GENERATION.test(parts[1]) || parts[2] !== String(index)
        || generation && parts[1] !== generation) throw fail('snapshot_manifest');
      generation = parts[1]; return redisKey(`${type}:chunks`, chunkId);
    });
    const records = [], chunks = []; let expiresAt = parent.expiresAt;
    for (let offset = 0; offset < keys.length; offset += 4) {
      if (!remaining()) throw fail('maintenance_deadline');
      const rows = await Promise.all(keys.slice(offset, offset + 4).map(readString));
      for (const row of rows) {
        if (!row || !row.expiresAt) throw fail('snapshot_partial');
        let chunk; try { chunk = JSON.parse(row.raw); } catch { throw fail('snapshot_partial'); }
        if (typeof chunk !== 'string' || chunk.length > 400_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)) throw fail('snapshot_partial');
        chunks.push(chunk); records.push(row); expiresAt = Math.min(expiresAt, row.expiresAt);
      }
    }
    let raw, payload;
    try { raw = gunzipSync(Buffer.from(chunks.join(''), 'base64'), { maxOutputLength: MAX_RAW_BYTES }); payload = JSON.parse(raw.toString('utf8')); }
    catch { throw fail('snapshot_decode'); }
    if (raw.length !== manifest.bytes || sha(raw) !== manifest.sha256) throw fail('snapshot_hash');
    const publication = await snapshotPublication(targetIndex, payload, now());
    if (!publication) throw fail('snapshot_schema');
    const proof = await preserve(type, id, payload, expiresAt);
    if (!proof) {
      state.counters.preserved++;
      const previous = state.snapshotProofs[targetIndex];
      const minimum = previous && finiteTime(previous.publicationTime) && Date.parse(previous.publicationTime) > Date.parse(publication.publicationTime) ? previous : publication;
      await refreshOrphanProof(targetIndex, minimum);
      return;
    }
    state.counters.migrated++;
    const previousProof = state.snapshotProofs[targetIndex];
    if (!previousProof || !finiteTime(previousProof.publicationTime) || Date.parse(publication.publicationTime) >= Date.parse(previousProof.publicationTime)) {
      state.snapshotProofs[targetIndex] = { ...proof, ...publication, verifiedAt: new Date(now()).toISOString() };
    }
    if (!drainComplete() || !remaining()) return;
    const result = await command(['EVAL', DELETE_SNAPSHOT, keys.length + 1, parentKey, ...keys, parent.sha1, ...records.map(row => row.sha1)]);
    addDeletion(state, result, keys.length + 1);
  }

  async function migrateOrphan(key, classification) {
    const { target, generation } = classification;
    const proof = state.snapshotProofs[target];
    if (!proof || proof.target !== target || !finiteTime(proof.publicationTime)) return;
    const parentTarget = REDIS_SNAPSHOT_TARGETS[target];
    const parentKey = redisKey(parentTarget.type, parentTarget.id);
    const parent = await readString(parentKey);
    if (parent) {
      let manifest; try { manifest = JSON.parse(parent.raw); } catch { return; }
      if (manifest?.format !== 'gzip-chunks-v1' || !Array.isArray(manifest.ids) || manifest.ids.length > 100
        || manifest.ids.some(id => typeof id !== 'string')) return;
      if (manifest.ids.some(id => redisKey(`${parentTarget.type}:chunks`, id) === key)) return;
    }
    const candidateKey = `${target}:${generation}`;
    const previous = state.orphans[candidateKey];
    if (!previous) {
      if (Object.keys(state.orphans).length < MAX_ORPHANS) state.orphans[candidateKey] = { firstSeenAt: new Date(now()).toISOString(), seenPass: state.migrationPass || 0 };
      return;
    }
    previous.seenPass = state.migrationPass || 0;
    if (!finiteTime(previous.firstSeenAt) || now() - Date.parse(previous.firstSeenAt) < DRAIN_MS || !drainComplete() || !remaining()) return;
    // Verify that our preserved complete snapshot still exists before retiring
    // an orphan from this parent. Expired disposable storage is not a proof.
    if (!await refreshOrphanProof(target, proof)) return;
    const chunk = await readString(key);
    if (!chunk) return;
    addDeletion(state, await command(['EVAL', DELETE_ORPHAN, 2, parentKey, key, parent?.sha1 || 'absent', chunk.sha1]), 1);
  }

  async function migrateKey(key) {
    const classification = classifyRedisMaintenanceKey(key);
    if (classification.family === 'snapshot-chunks') return migrateOrphan(key, classification);
    if (!classification.type) return;
    const row = await readString(key);
    if (!row || !row.expiresAt) { state.counters.preserved++; return; }
    let payload; try { payload = JSON.parse(row.raw); } catch { state.counters.preserved++; return; }
    if (payload?.format === 'gzip-chunks-v1') return; // Full snapshot phase owns these.
    const proof = await preserve(classification.type, classification.id, payload, row.expiresAt);
    if (!proof) { state.counters.preserved++; return; }
    state.counters.migrated++;
    if (drainComplete() && remaining()) addDeletion(state, await command(['EVAL', COMPARE_DELETE, 1, key, row.sha1]), 1);
  }

  try {
    if (control.mode === 'steady' && state.phase === 'migration') {
      state.phase = 'steady'; state.completedAt = new Date(now()).toISOString(); state.nextAt = new Date(now() + WEEK_MS).toISOString();
    }
    if (control.mode === 'migrate' && state.phase === 'inventory' && state.completedAt) {
      state.phase = 'migration'; state.cursor = '0'; state.pending = []; state.snapshotIndex = 0;
      state.completedAt = null; state.nextAt = null; state.migrationPass = 0;
    }
    if ((state.phase === 'steady' || state.phase === 'inventory' && state.completedAt)
      && control.mode !== 'migrate' && (!finiteTime(state.nextAt) || now() >= Date.parse(state.nextAt))) {
      state.phase = 'inventory'; state.cursor = '0'; state.pending = []; state.completedAt = null;
      state.inventory = initialState(now()).inventory; state.nextAt = null;
    }
    if (!state.redis || !state.inventory.pages) await captureRedisInfo();
    if (state.phase === 'inventory') {
      let processed = 0, pages = 0;
      while (remaining() && processed < MAX_KEYS && pages < 8 && !state.completedAt) {
        if (!state.pending.length) pages++;
        await nextPage();
        const keys = state.pending.slice(0, Math.min(100, MAX_KEYS - processed));
        if (keys.length) { await inventoryPage(keys); state.pending.splice(0, keys.length); processed += keys.length; }
        if (!state.pending.length && state.cursor === '0') {
          state.completedAt = new Date(now()).toISOString(); state.nextAt = new Date(now() + WEEK_MS).toISOString();
          if (control.mode === 'steady') state.phase = 'steady';
          status = 'inventory_complete'; break;
        }
      }
    } else if (state.phase === 'migration' && control.mode === 'migrate') {
      while (remaining() && state.snapshotIndex < REDIS_SNAPSHOT_TARGETS.length) {
        try { await migrateSnapshot(state.snapshotIndex); }
        catch (error) { if (errorCode(error) === 'maintenance_deadline') break; recordError(state, error); }
        state.snapshotIndex++;
      }
      let processed = 0, pages = 0;
      while (remaining() && state.snapshotIndex === REDIS_SNAPSHOT_TARGETS.length && processed < MAX_KEYS && pages < 8) {
        if (!state.pending.length) pages++;
        await nextPage();
        const keys = state.pending.slice(0, Math.min(3, MAX_KEYS - processed));
        const results = await Promise.allSettled(keys.map(migrateKey));
        results.forEach(result => { if (result.status === 'rejected') recordError(state, result.reason); });
        state.pending.splice(0, keys.length); processed += keys.length;
        if (!state.pending.length && state.cursor === '0') {
          for (const [candidate, observation] of Object.entries(state.orphans)) {
            if (observation.seenPass !== (state.migrationPass || 0)) delete state.orphans[candidate];
          }
          state.migrationPass = (state.migrationPass || 0) + 1;
          // A second pass after the observation grace retires old orphan UUIDs.
          // Refresh the fixed snapshot proofs on every pass; never retain a
          // stale proof indefinitely or let the candidate cap starve others.
          state.snapshotIndex = 0;
          state.nextAt = new Date(now() + DRAIN_MS).toISOString();
          await captureRedisInfo(); status = 'migration_pass_complete'; break;
        }
      }
    }
    state.updatedAt = new Date(now()).toISOString();
  } catch (error) { code = recordError(state, error); status = 'partial'; }
  try {
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) throw fail('maintenance_state_size');
    const saved = await saveState(owner, state, { signal, deadline: Math.min(deadline + 2000, Date.parse(control.leaseUntil)) });
    if (saved?.saved !== true) throw fail('maintenance_save');
  } catch (error) { return summary(state, control, 'uncommitted', errorCode(error)); }
  return summary(state, control, status, code);
}
