import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveChatUsage } from '../src/utils/chatLimits.js';

const NOW = Date.parse('2026-09-20T12:34:10Z');
const ENV = { VERCEL: '1', KV_REST_API_URL: 'https://redis.example', KV_REST_API_TOKEN: 'fixture-token' };
const request = headers => new Request('https://secedgarterminal.com/api/chat', { headers: { 'x-vercel-forwarded-for': '192.0.2.11', ...headers } });
function setup({ env = ENV, response = () => Response.json({ result: [1, 0, 0, 4] }), ...options } = {}) {
  const calls = [];
  return {
    calls,
    reserve: (req = request(), extra = {}) => reserveChatUsage(req, {
      env, now: NOW, reservedMicrodollars: 1000,
      fetchImpl: async (url, init) => {
        const command = JSON.parse(init.body);
        calls.push({ url, init, command });
        return response(command, calls.length, init);
      }, ...options, ...extra,
    }),
  };
}

test('one atomic shared reservation applies conservative caps, fixed UTC expiries and no content or raw address', async () => {
  const { calls, reserve } = setup();
  const result = await reserve();
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 4);
  assert.equal(calls.length, 1);
  const { command, init, url } = calls[0];
  assert.equal(url, 'https://redis.example');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.equal(command[0], 'EVAL');
  assert.equal(command[2], 7);
  const keys = command.slice(3, 10), args = command.slice(10);
  assert.ok(keys.every(key => key.startsWith('edgar:{chat-usage}:v1:')));
  assert.match(keys[0], /^edgar:\{chat-usage\}:v1:ip:[a-f0-9]{64}:minute:/);
  assert.ok(!JSON.stringify(command).includes('192.0.2.11'));
  assert.deepEqual(args.slice(0, 9), [
    Date.parse('2026-09-20T12:34:00Z'), Date.parse('2026-09-20T00:00:00Z'), Date.parse('2026-09-01T00:00:00Z'),
    Date.parse('2026-09-20T12:35:00Z'), Date.parse('2026-09-21T00:00:00Z'), Date.parse('2026-10-01T00:00:00Z'),
    1000, 500000, 5000000,
  ]);
  assert.match(args[9], /^[a-f0-9-]{36}$/);
  assert.deepEqual(args.slice(10), [120000, 5, 30, 1000]);
  const other = setup({ env: { ...ENV, VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'another-deployment' } });
  await other.reserve();
  assert.deepEqual(other.calls[0].command.slice(3, 10), keys);
});

test('reservations release exactly their own lease once without refund, and cancellation cannot block cleanup', async () => {
  const controller = new AbortController();
  const { reserve, calls } = setup({ signal: controller.signal });
  const result = await reserve();
  controller.abort();
  await Promise.all([result.release(), result.release()]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command[0], 'EVAL');
  assert.equal(calls[1].command[2], 2);
  assert.deepEqual(calls[1].command.slice(3), [calls[0].command[8], calls[0].command[9], calls[0].command[19]]);
  assert.ok(!calls[1].command[1].includes('INCR'));
  assert.ok(!calls[1].init.signal.aborted);
  const cleanupFailure = setup({ response: (_command, count) => { if (count === 2) throw new Error('secret transport failure'); return Response.json({ result: [1, 0, 0, 4] }); } });
  await assert.doesNotReject((await cleanupFailure.reserve()).release());
});

test('budget configuration can only decrease the hard ceiling, including zero to pause usage', async () => {
  const valid = setup({ env: { ...ENV, CHAT_DAILY_BUDGET_MICRODOLLARS: '0', CHAT_MONTHLY_BUDGET_MICRODOLLARS: '25000' } });
  await valid.reserve();
  assert.deepEqual(valid.calls[0].command.slice(17, 19), [0, 25000]);
  for (const [name, values] of [
    ['CHAT_DAILY_BUDGET_MICRODOLLARS', ['500001', '-1', 'Infinity', 'NaN', '1e3', '12.5', '', ' 10', 100]],
    ['CHAT_MONTHLY_BUDGET_MICRODOLLARS', ['5000001', '9007199254740992']],
  ]) for (const value of values) {
    const { reserve, calls } = setup({ env: { ...ENV, [name]: value } });
    const result = await reserve();
    assert.equal(result.allowed, false, `${name}=${value}`);
    assert.equal(result.status, 503);
    assert.equal(calls.length, 0);
  }
});

test('invalid provider cost never reaches storage', async () => {
  const { reserve, calls } = setup();
  for (const reservedMicrodollars of [undefined, null, 0, -1, 1.5, '1000', NaN, Infinity, 500001, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(reserve(request(), { reservedMicrodollars }), /chat_invalid_reservation/);
  }
  assert.equal(calls.length, 0);
});

test('all distributed caps produce bounded retries and cannot release or refund rejected requests', async () => {
  const expected = ['CHAT_RATE_LIMITED', 'CHAT_DAILY_LIMIT', 'CHAT_DAILY_LIMIT', 'CHAT_BUDGET_EXHAUSTED', 'CHAT_BUDGET_EXHAUSTED', 'CHAT_BUSY', 'CHAT_LIMITS_UNAVAILABLE', 'CHAT_LIMITS_UNAVAILABLE'];
  for (let reason = 1; reason <= expected.length; reason++) {
    const { reserve, calls } = setup({ response: () => Response.json({ result: [0, reason, 22, 0] }) });
    const result = await reserve();
    assert.equal(result.allowed, false);
    assert.equal(result.code, expected[reason - 1]);
    assert.equal(result.status, reason >= 7 ? 503 : 429);
    assert.equal(result.retryAfter, 22);
    await result.release();
    assert.equal(calls.length, 1);
  }
});

test('missing credentials, bad transport, rejected or malformed Redis replies always fail closed', async () => {
  for (const env of [{}, { VERCEL_ENV: 'development' }, { ...ENV, KV_REST_API_TOKEN: '' }, { ...ENV, KV_REST_API_URL: 'http://redis.example' }, { ...ENV, KV_REST_API_URL: 'https://redis.example/?secret=abc' }]) {
    const { reserve, calls } = setup({ env });
    assert.equal((await reserve()).status, 503);
    assert.equal(calls.length, 0);
  }
  for (const response of [
    () => { throw new Error('private credential error'); },
    () => new Response('private credential error', { status: 500 }),
    () => new Response('not json'),
    () => Response.json({ error: 'NOAUTH private credential' }),
    () => Response.json({}),
    () => Response.json([{ result: [1, 0, 0, 4] }]),
    ...[[1, 0, 0, 4, 1], [1, 0, 0, 5], [1, 1, 0, 4], [1, 0, 0, -1], [1, 0, 0, '4'], [1, 0, 1, 4], [0, 99, 10, 0], [0, 1, 0, 0], [0, 1, 2678401, 0], [0, 1, 10, 1], { allowed: true }, null].map(result => () => Response.json({ result })),
    () => new Response(' '.repeat(4097)),
  ]) {
    const { reserve, calls } = setup({ response });
    const result = await reserve();
    assert.deepEqual({ ...result, release: undefined }, { allowed: false, code: 'CHAT_LIMITS_UNAVAILABLE', status: 503, retryAfter: 30, remaining: 0, release: undefined });
    assert.equal(calls.length, 1);
  }
});

test('only trusted Vercel addresses select IP buckets; missing or malformed addresses share the restrictive anonymous bucket', async () => {
  async function keyFor(headers, env = ENV) {
    const { reserve, calls } = setup({ env });
    await reserve(request(headers));
    return calls[0].command[3];
  }
  assert.equal(await keyFor({ 'x-forwarded-for': '203.0.113.88' }), await keyFor({ 'x-forwarded-for': '198.51.100.99' }));
  assert.notEqual(await keyFor({ 'x-vercel-forwarded-for': '203.0.113.88' }), await keyFor({ 'x-vercel-forwarded-for': '198.51.100.99' }));
  assert.equal(await keyFor({ 'x-vercel-forwarded-for': '', 'x-forwarded-for': '203.0.113.88' }), await keyFor({ 'x-vercel-forwarded-for': '203.0.113.88' }));
  assert.equal(await keyFor({ 'x-vercel-forwarded-for': '2001:db8::1' }), await keyFor({ 'x-vercel-forwarded-for': '2001:0db8:0:0:0:0:0:1' }));
  assert.equal(await keyFor({ 'x-vercel-forwarded-for': 'garbage' }), await keyFor({ 'x-vercel-forwarded-for': 'x'.repeat(513) }));
  const env = { ...ENV, VERCEL: undefined };
  assert.equal(await keyFor({ 'x-vercel-forwarded-for': '203.0.113.88' }, env), await keyFor({ 'x-vercel-forwarded-for': '198.51.100.99' }, env));
});

test('aborted requests and invalid clocks never spend or send storage commands', async () => {
  for (const options of [{ signal: AbortSignal.abort() }, { now: Infinity }, { now: NaN }, { now: -1 }, { now: 8_640_000_000_000_001 }]) {
    const { reserve, calls } = setup(options);
    assert.equal((await reserve()).allowed, false);
    assert.equal(calls.length, 0);
  }
  const aliases = setup({ env: { VERCEL: '1', UPSTASH_REDIS_REST_URL: ENV.KV_REST_API_URL, UPSTASH_REDIS_REST_TOKEN: ENV.KV_REST_API_TOKEN } });
  assert.equal((await aliases.reserve()).allowed, true);
});

// Run the actual shipped Lua script against an in-memory Redis command fixture
// when Lua is available. This verifies the state machine rather than reimplementing
// it in JavaScript. CI without Lua still exercises the entire REST contract above.
const luaAvailable = spawnSync('luatex', ['--version'], { encoding: 'utf8' }).status === 0;
function lua(value) {
  if (Array.isArray(value)) return `{${value.map(lua).join(',')}}`;
  if (typeof value === 'number') return String(value);
  return `[========[${value}]========]`;
}
test('Lua enforces concurrent, minute, daily and monthly limits atomically, expires leases and rejects corrupt state', { skip: !luaAvailable }, async () => {
  const { reserve, calls } = setup();
  await reserve();
  const payload = calls[0].command;
  const folder = await mkdtemp(join(tmpdir(), 'chat-limits-lua-'));
  const file = join(folder, 'verify.lua');
  try {
    await writeFile(file, `
local now = ${NOW}
local db = {}
redis = {}
local function item(key)
  local entry = db[key]
  if entry and entry.expires and entry.expires <= now then db[key] = nil; return nil end
  return entry
end
function redis.call(command, key, a, b, c)
  if command == 'TIME' then return {math.floor(now / 1000), (now % 1000) * 1000} end
  local entry = item(key)
  if command == 'GET' then assert(not entry or entry.kind == 'string'); return entry and tostring(entry.value) or false end
  if command == 'PTTL' then return entry and (entry.expires and entry.expires - now or -1) or -2 end
  if command == 'TYPE' then return {ok = entry and entry.kind or 'none'} end
  if command == 'INCRBY' then
    if not entry then entry = {kind = 'string', value = 0}; db[key] = entry end
    entry.value = entry.value + a; return entry.value
  end
  if command == 'PEXPIREAT' then if entry then entry.expires = a end; return 1 end
  if command == 'PEXPIRE' then if entry then entry.expires = now + a end; return 1 end
  if command == 'ZADD' then
    if not entry then entry = {kind = 'zset', value = {}}; db[key] = entry end
    entry.value[b] = a; return 1
  end
  if command == 'ZCARD' then local count = 0; if entry then for _ in pairs(entry.value) do count = count + 1 end end; return count end
  if command == 'ZREMRANGEBYSCORE' then if entry then for member, score in pairs(entry.value) do if score <= b then entry.value[member] = nil end end end; return 1 end
  if command == 'ZREM' then if entry then entry.value[a] = nil end; return 1 end
  if command == 'ZRANGE' then
    local members = {}; if entry then for member, score in pairs(entry.value) do table.insert(members, {member, score}) end end
    table.sort(members, function(x, y) return x[2] < y[2] end)
    return members[1] or {}
  end
  error('Unsupported fixture command ' .. command)
end
KEYS = ${lua(payload.slice(3, 10))}
ARGV = ${lua(payload.slice(10))}
local reserve = assert(load(${lua(payload[1])}))
local function clear() db = {}; now = ${NOW}; ARGV[7] = 1000; ARGV[8] = 500000; ARGV[9] = 5000000 end
local function count(key) return item(key) and item(key).value or 0 end
local function release() redis.call('ZREM', KEYS[6], ARGV[10]); redis.call('ZREM', KEYS[7], ARGV[10]) end
local function preset(index, value) db[KEYS[index]] = {kind = 'string', value = value, expires = ARGV[index == 1 and 4 or index == 5 and 6 or 5]} end
assert(reserve()[1] == 1)
assert(reserve()[2] == 6, 'One request per IP concurrently')
assert(count(KEYS[4]) == 1000, 'Rejections do not charge')
release()
for n = 2, 5 do assert(reserve()[1] == 1); release() end
assert(reserve()[2] == 1, 'Five accepted requests per minute')
assert(count(KEYS[4]) == 5000)
clear(); preset(2, 30); assert(reserve()[2] == 2); assert(not item(KEYS[4]))
clear(); preset(3, 1000); assert(reserve()[2] == 3); assert(not item(KEYS[4]))
clear(); preset(4, 499001); assert(reserve()[2] == 4); assert(not item(KEYS[1]))
clear(); preset(5, 4999001); assert(reserve()[2] == 5); assert(not item(KEYS[1]))
clear(); ARGV[8] = 0; assert(reserve()[2] == 4)
clear(); preset(4, 499000); assert(reserve()[1] == 1); assert(count(KEYS[4]) == 500000)
assert(db[KEYS[1]].expires == ARGV[4]); assert(db[KEYS[2]].expires == ARGV[5]); assert(db[KEYS[5]].expires == ARGV[6])
clear(); for n = 1, 4 do redis.call('ZADD', KEYS[7], now + 120000, 'other-' .. n) end
assert(reserve()[2] == 6, 'Four global concurrent leases'); assert(not item(KEYS[1]))
clear(); redis.call('ZADD', KEYS[6], now, 'expired'); redis.call('ZADD', KEYS[7], now, 'expired')
assert(reserve()[1] == 1, 'Expired leases are purged')
assert(redis.call('ZCARD', KEYS[6]) == 1); assert(redis.call('ZCARD', KEYS[7]) == 1)
assert(db[KEYS[6]].expires == now + 120000)
redis.call('ZADD', KEYS[7], now + 120000, 'other-active'); release(); assert(redis.call('ZCARD', KEYS[7]) == 1)
clear(); preset(4, -1); assert(reserve()[2] == 7); assert(not item(KEYS[1]))
clear(); preset(4, 'garbage'); assert(reserve()[2] == 7)
clear(); preset(4, 0); db[KEYS[4]].expires = nil; assert(reserve()[2] == 7)
clear(); db[KEYS[7]] = {kind = 'string', value = 0}; assert(reserve()[2] == 7); assert(not item(KEYS[1]))
clear(); now = ARGV[4]; assert(reserve()[2] == 8, 'Delayed request cannot reuse an expired bucket')
print('All atomic Lua reservation scenarios passed')
`);
    const result = spawnSync('luatex', ['--luaonly', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /All atomic Lua reservation scenarios passed/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
