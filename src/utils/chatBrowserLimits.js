import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

// Browser inference does not spend the hosted model allowance. These short-lived
// keys protect public-data retrieval only; paid chat's keys are never touched.
const PREFIX = 'edgar:{chat-browser-research}:v1';
const MINUTE_MS = 60_000;
const LEASE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 2_500;
const CLIENT_MINUTE_MAX = 6;
const GLOBAL_MINUTE_MAX = 120;
const GLOBAL_CONCURRENT_MAX = 4;

const RESERVE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local minuteStart, minuteEnd = tonumber(ARGV[1]), tonumber(ARGV[2])
local lease, leaseMs = ARGV[3], tonumber(ARGV[4])
local clientMax, globalMax, concurrentMax = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
if now < minuteStart or now >= minuteEnd then return {0, 4, 1, 0} end
local counts = {}
-- Validate every key before any mutation; corrupt or non-expiring state fails
-- closed and cannot leave a partially accepted reservation behind.
for i = 1, 4 do
  local kind = redis.call('TYPE', KEYS[i]).ok
  local expected = i <= 2 and 'string' or 'zset'
  if kind ~= 'none' and (kind ~= expected or redis.call('PTTL', KEYS[i]) <= 0) then return {0, 4, 30, 0} end
  if i <= 2 then
    local raw = redis.call('GET', KEYS[i])
    local value = 0
    if raw then value = tonumber(raw) end
    if not value or value < 0 or value ~= math.floor(value) or value > 9007199254740991 then return {0, 4, 30, 0} end
    counts[i] = value
  end
end
local function reject(code, expires)
  return {0, code, math.max(1, math.ceil((expires - now) / 1000)), 0}
end
if counts[1] + 1 > clientMax then return reject(1, minuteEnd) end
if counts[2] + 1 > globalMax then return reject(2, minuteEnd) end
for i = 3, 4 do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now) end
for i = 3, 4 do
  local cap = i == 3 and 1 or concurrentMax
  if redis.call('ZCARD', KEYS[i]) >= cap then
    local first = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    return reject(3, math.min(tonumber(first[2]) or now + leaseMs, now + leaseMs))
  end
end
for i = 1, 2 do
  redis.call('INCRBY', KEYS[i], 1)
  redis.call('PEXPIREAT', KEYS[i], minuteEnd)
end
for i = 3, 4 do
  redis.call('ZADD', KEYS[i], now + leaseMs, lease)
  redis.call('PEXPIRE', KEYS[i], leaseMs)
end
return {1, 0, 0, clientMax - counts[1] - 1}
`;

const RELEASE_SCRIPT = `
-- A disconnected or late completion can remove only its own lease.
for i = 1, 2 do redis.call('ZREM', KEYS[i], ARGV[1]) end
return 1
`;
const REASONS = {
  1: 'CHAT_BROWSER_RATE_LIMITED',
  2: 'CHAT_BROWSER_RATE_LIMITED',
  3: 'CHAT_BROWSER_BUSY',
  4: 'CHAT_BROWSER_LIMITS_UNAVAILABLE',
};
const noopRelease = async () => {};
function unavailable() {
  return { allowed: false, code: 'CHAT_BROWSER_LIMITS_UNAVAILABLE', status: 503, retryAfter: 30, remaining: 0, release: noopRelease };
}

function configuredCap(env, name, maximum) {
  const raw = env[name];
  if (raw === undefined) return maximum;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error('invalid_browser_research_cap');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error('invalid_browser_research_cap');
  return value;
}

function clientDigest(request, env) {
  // Trust only addresses rewritten by the Vercel edge. Other hosting shares a
  // restrictive anonymous bucket until its trusted proxy is explicitly added.
  const forwarded = env.VERCEL === '1'
    ? request?.headers?.get('x-vercel-forwarded-for') || request?.headers?.get('x-forwarded-for')
    : null;
  let value = typeof forwarded === 'string' && forwarded.length <= 512 ? forwarded.split(',')[0].trim().toLowerCase() : '';
  const version = isIP(value);
  if (!version) value = 'anonymous';
  else if (version === 6) value = value.includes('%') ? 'anonymous' : new URL(`http://[${value}]/`).hostname;
  return createHash('sha256').update(`edgar-browser-research-client:${value}`).digest('hex');
}

function transport(env, fetchImpl) {
  const rawUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!rawUrl || typeof token !== 'string' || !token.trim()) throw new Error('browser_research_limits_unconfigured');
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('browser_research_limits_unconfigured');
  return async (command, signal) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetchImpl(url.origin, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command), cache: 'no-store', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error('browser_research_limits_unavailable');
    const text = await response.text();
    if (text.length > 4096) throw new Error('browser_research_limits_invalid_response');
    const body = JSON.parse(text);
    if (!body || Array.isArray(body) || typeof body !== 'object' || body.error || !Object.hasOwn(body, 'result')) throw new Error('browser_research_limits_invalid_response');
    return body.result;
  };
}

/** Reserve bounded public-data work, independently of the hosted AI budget.
 * Six requests/minute/client, 120/minute globally, one concurrent/client and four
 * globally. There is no daily/monthly allowance and no provider-cost counter.
 * All state expires within one minute; no questions, URLs or data are stored.
 * Every caller must release its lease after at most 22 seconds of data work.
 */
export async function reserveBrowserResearchUsage(request, {
  signal, now = Date.now(), fetchImpl = fetch, env = process.env,
} = {}) {
  try {
    if (signal?.aborted || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - MINUTE_MS) return unavailable();
    const clientMax = configuredCap(env, 'CHAT_BROWSER_CLIENT_PER_MINUTE', CLIENT_MINUTE_MAX);
    const globalMax = configuredCap(env, 'CHAT_BROWSER_GLOBAL_PER_MINUTE', GLOBAL_MINUTE_MAX);
    const concurrentMax = configuredCap(env, 'CHAT_BROWSER_GLOBAL_CONCURRENT', GLOBAL_CONCURRENT_MAX);
    const command = transport(env, fetchImpl);
    const minuteStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const ip = clientDigest(request, env);
    const lease = randomUUID();
    const keys = [
      `${PREFIX}:ip:${ip}:minute:${minuteStart}`, `${PREFIX}:minute:${minuteStart}`,
      `${PREFIX}:ip:${ip}:active`, `${PREFIX}:active`,
    ];
    const result = await command(['EVAL', RESERVE_SCRIPT, keys.length, ...keys,
      minuteStart, minuteStart + MINUTE_MS, lease, LEASE_MS, clientMax, globalMax, concurrentMax], signal);
    if (!Array.isArray(result) || result.length !== 4 || !result.every(Number.isSafeInteger)) return unavailable();
    const [accepted, reason, retryAfter, remaining] = result;
    if (accepted === 0 && REASONS[reason] && retryAfter >= 1 && retryAfter <= 60 && remaining === 0) {
      return { allowed: false, code: REASONS[reason], status: reason === 4 ? 503 : 429, retryAfter, remaining: 0, release: noopRelease };
    }
    if (accepted !== 1 || reason !== 0 || retryAfter !== 0 || remaining < 0 || remaining >= clientMax) return unavailable();
    let releasePromise;
    return {
      allowed: true, code: 'CHAT_BROWSER_ALLOWED', status: 200, retryAfter: 0, remaining,
      release: () => releasePromise ||= (async () => {
        try {
          // Cleanup remains possible after the browser disconnects. A failed
          // cleanup leaves only a 30-second lease; never refund rate counters.
          await command(['EVAL', RELEASE_SCRIPT, 2, keys[2], keys[3], lease]);
        } catch { /* Lease expires. Never log addresses, questions or secrets. */ }
      })(),
    };
  } catch {
    return unavailable();
  }
}
