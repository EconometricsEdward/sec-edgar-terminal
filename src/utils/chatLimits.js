import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

// All deployments share this namespace: preview traffic consumes the same budget.
// Do not change it to reset quotas when deploying another chat implementation.
const PREFIX = 'edgar:{chat-usage}:v1';
const DAY_MS = 86_400_000;
const LEASE_MS = 120_000;
const REQUEST_TIMEOUT_MS = 2_500;
const DAILY_BUDGET = 500_000; // Microdollars; $0.50 maximum per UTC day.
const MONTHLY_BUDGET = 5_000_000; // $5 maximum per UTC month.
const IP_MINUTE_MAX = 5;
const IP_DAY_MAX = 30;
const GLOBAL_DAY_MAX = 1_000;

// One EVAL checks every cap before charging anything. Redis supplies the lease
// clock. UTC key boundaries from the application are verified against that clock
// so delayed requests cannot spend against an already expired budget bucket.
const RESERVE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local minuteStart, dayStart, monthStart = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local minuteEnd, dayEnd, monthEnd = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
local cost, dayCap, monthCap = tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9])
local lease, leaseMs = ARGV[10], tonumber(ARGV[11])
local minuteMax, dayMax, globalMax = tonumber(ARGV[12]), tonumber(ARGV[13]), tonumber(ARGV[14])
if now < minuteStart or now >= minuteEnd or now < dayStart or now >= dayEnd or now < monthStart or now >= monthEnd then
  return {0, 8, 1, 0}
end
local function counter(key)
  local raw = redis.call('GET', key)
  if not raw then return 0 end
  local value = tonumber(raw)
  if not value or value < 0 or value ~= math.floor(value) or value > 9007199254740991 or redis.call('PTTL', key) <= 0 then return nil end
  return value
end
local counts = {}
for i = 1, 5 do
  counts[i] = counter(KEYS[i])
  if counts[i] == nil then return {0, 7, 30, 0} end
end
local function reject(code, expires)
  return {0, code, math.max(1, math.ceil((expires - now) / 1000)), 0}
end
if counts[1] + 1 > minuteMax then return reject(1, minuteEnd) end
if counts[2] + 1 > dayMax then return reject(2, dayEnd) end
if counts[3] + 1 > globalMax then return reject(3, dayEnd) end
if counts[4] + cost > dayCap then return reject(4, dayEnd) end
if counts[5] + cost > monthCap then return reject(5, monthEnd) end
-- Check both key types before purging or incrementing any state. A WRONGTYPE
-- error must never create an apparently accepted partial budget reservation.
for i = 6, 7 do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= 'zset' then return {0, 7, 30, 0} end
end
for i = 6, 7 do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now) end
for i = 6, 7 do
  local cap = i == 6 and 1 or 4
  if redis.call('ZCARD', KEYS[i]) >= cap then
    local first = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    return reject(6, math.min(tonumber(first[2]) or now + leaseMs, now + leaseMs))
  end
end
local expiries = {minuteEnd, dayEnd, dayEnd, dayEnd, monthEnd}
for i = 1, 5 do
  redis.call('INCRBY', KEYS[i], i <= 3 and 1 or cost)
  redis.call('PEXPIREAT', KEYS[i], expiries[i])
end
for i = 6, 7 do
  redis.call('ZADD', KEYS[i], now + leaseMs, lease)
  redis.call('PEXPIRE', KEYS[i], leaseMs)
end
return {1, 0, 0, math.min(minuteMax - counts[1] - 1, dayMax - counts[2] - 1)}
`;

const RELEASE_SCRIPT = `
-- A stale completion can remove only its own lease, never another request.
for i = 1, 2 do redis.call('ZREM', KEYS[i], ARGV[1]) end
return 1
`;

const REASONS = {
  1: 'CHAT_RATE_LIMITED',
  2: 'CHAT_DAILY_LIMIT',
  3: 'CHAT_DAILY_LIMIT',
  4: 'CHAT_BUDGET_EXHAUSTED',
  5: 'CHAT_BUDGET_EXHAUSTED',
  6: 'CHAT_BUSY',
  7: 'CHAT_LIMITS_UNAVAILABLE',
  8: 'CHAT_LIMITS_UNAVAILABLE',
};
const noopRelease = async () => {};
function unavailable() {
  return { allowed: false, code: 'CHAT_LIMITS_UNAVAILABLE', status: 503, retryAfter: 30, remaining: 0, release: noopRelease };
}

function configuredCap(env, name, ceiling) {
  const raw = env[name];
  if (raw === undefined) return ceiling;
  // Reject malformed or increased caps instead of silently falling back to a
  // larger allowance. Only a code-reviewed change can increase these ceilings.
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error('chat_invalid_budget');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > ceiling) throw new Error('chat_invalid_budget');
  return value;
}

function clientDigest(request, env) {
  // Vercel overwrites these headers at its edge. On another host there is no
  // assumed trusted proxy: all callers share an anonymous bucket, fail closed.
  // https://vercel.com/docs/headers/request-headers
  const forwarded = env.VERCEL === '1'
    ? request?.headers?.get('x-vercel-forwarded-for') || request?.headers?.get('x-forwarded-for')
    : null;
  let value = typeof forwarded === 'string' && forwarded.length <= 512 ? forwarded.split(',')[0].trim().toLowerCase() : '';
  const version = isIP(value);
  if (!version) value = 'anonymous';
  else if (version === 6) {
    // URL normalizes compressed/expanded IPv6 so alternate spellings cannot
    // create independent quotas for one address. Reject zone identifiers.
    if (value.includes('%')) value = 'anonymous';
    else value = new URL(`http://[${value}]/`).hostname;
  }
  return createHash('sha256').update(`edgar-chat-client:${value}`).digest('hex');
}

function transport(env, fetchImpl) {
  const rawUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!rawUrl || typeof token !== 'string' || !token.trim()) throw new Error('chat_limits_unconfigured');
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('chat_limits_unconfigured');
  return async (command, signal) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetchImpl(url.origin, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      cache: 'no-store',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error('chat_limits_unavailable');
    // Redis only returns a tiny tuple. Reject oversized/unexpected replies.
    const text = await response.text();
    if (text.length > 4096) throw new Error('chat_limits_invalid_response');
    const body = JSON.parse(text);
    if (!body || Array.isArray(body) || typeof body !== 'object' || body.error || !Object.hasOwn(body, 'result')) throw new Error('chat_limits_invalid_response');
    return body.result;
  };
}

/**
 * Reserve the maximum possible provider cost BEFORE retrieval/inference.
 * All costs are positive integer microdollars, never user-supplied estimates.
 * Reservations are never refunded (including provider errors/cancellation).
 * Call release() in finally; it releases concurrency only and ignores a failed
 * cleanup because a 120-second lease safely expires. The provider request MUST
 * have a shorter maximum lifetime than the lease (recommended <= 90 seconds).
 * Missing credentials, invalid config, Redis failure and bad replies fail closed.
 * No messages or other conversation content are stored here.
 */
export async function reserveChatUsage(request, {
  reservedMicrodollars,
  signal,
  now = Date.now(),
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  if (!Number.isSafeInteger(reservedMicrodollars) || reservedMicrodollars <= 0 || reservedMicrodollars > DAILY_BUDGET) {
    throw new TypeError('chat_invalid_reservation');
  }
  try {
    if (signal?.aborted || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) return unavailable();
    const dayCap = configuredCap(env, 'CHAT_DAILY_BUDGET_MICRODOLLARS', DAILY_BUDGET);
    const monthCap = configuredCap(env, 'CHAT_MONTHLY_BUDGET_MICRODOLLARS', MONTHLY_BUDGET);
    const command = transport(env, fetchImpl);
    const date = new Date(now);
    const minuteStart = Math.floor(now / 60_000) * 60_000;
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    if (![monthStart, monthEnd].every(Number.isSafeInteger)) return unavailable();
    const ip = clientDigest(request, env);
    const lease = randomUUID();
    const keys = [
      `${PREFIX}:ip:${ip}:minute:${minuteStart}`,
      `${PREFIX}:ip:${ip}:day:${dayStart}`,
      `${PREFIX}:requests:${dayStart}`,
      `${PREFIX}:cost:day:${dayStart}`,
      `${PREFIX}:cost:month:${monthStart}`,
      `${PREFIX}:ip:${ip}:active`,
      `${PREFIX}:active`,
    ];
    const result = await command(['EVAL', RESERVE_SCRIPT, keys.length, ...keys,
      minuteStart, dayStart, monthStart, minuteStart + 60_000, dayStart + DAY_MS, monthEnd,
      reservedMicrodollars, dayCap, monthCap, lease, LEASE_MS, IP_MINUTE_MAX, IP_DAY_MAX, GLOBAL_DAY_MAX], signal);
    if (!Array.isArray(result) || result.length !== 4 || !result.every(Number.isSafeInteger)) return unavailable();
    const [accepted, reason, retryAfter, remaining] = result;
    if (accepted === 0 && REASONS[reason] && retryAfter >= 1 && retryAfter <= 31 * 86400 && remaining === 0) {
      return { allowed: false, code: REASONS[reason], status: reason >= 7 ? 503 : 429, retryAfter, remaining: 0, release: noopRelease };
    }
    if (accepted !== 1 || reason !== 0 || retryAfter !== 0 || remaining < 0 || remaining >= IP_MINUTE_MAX) return unavailable();
    let releasePromise;
    return {
      allowed: true, code: 'CHAT_ALLOWED', status: 200, retryAfter: 0, remaining,
      // All callers await the same cleanup, including stream completion racing
      // browser cancellation or the platform's response-finished callback.
      release: () => releasePromise ||= (async () => {
        try {
          // Deliberately independent of a cancelled HTTP request's signal.
          if (await command(['EVAL', RELEASE_SCRIPT, 2, keys[5], keys[6], lease]) !== 1) throw new Error('invalid_release');
        } catch {
          // The lease expires; never refund or log keys, IPs or provider text.
          console.warn('edgar_chat_release_failed');
        }
      })(),
    };
  } catch {
    return unavailable();
  }
}
