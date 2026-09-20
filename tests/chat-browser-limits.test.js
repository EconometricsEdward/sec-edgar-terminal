import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveBrowserResearchUsage } from '../src/utils/chatBrowserLimits.js';

const NOW = Date.parse('2026-09-20T12:34:10Z');
const ENV = { VERCEL: '1', KV_REST_API_URL: 'https://redis.example', KV_REST_API_TOKEN: 'fixture-token' };
const request = headers => new Request('https://secedgarterminal.com/api/chat/research', {
  headers: { 'x-vercel-forwarded-for': '192.0.2.11', ...headers },
});
function setup({ env = ENV, response = command => Response.json({ result: command[2] === 2 ? 1 : [1, 0, 0, 5] }), ...options } = {}) {
  const calls = [];
  return { calls, reserve: (req = request(), extra = {}) => reserveBrowserResearchUsage(req, {
    env, now: NOW, fetchImpl: async (url, init) => {
      const command = JSON.parse(init.body);
      calls.push({ url, init, command });
      return response(command, calls.length, init);
    }, ...options, ...extra,
  }) };
}

test('source retrieval has isolated minute-only keys and never reserves hosted model spending', async () => {
  const { calls, reserve } = setup({ env: { ...ENV, CHAT_DAILY_BUDGET_MICRODOLLARS: '0', CHAT_MONTHLY_BUDGET_MICRODOLLARS: '0' } });
  const result = await reserve();
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 5);
  const { command, init, url } = calls[0];
  assert.equal(url, 'https://redis.example');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.equal(command[0], 'EVAL');
  assert.equal(command[2], 4);
  const keys = command.slice(3, 7), args = command.slice(7);
  assert.ok(keys.every(key => key.startsWith('edgar:{chat-browser-research}:v1:')));
  assert.match(keys[0], /^edgar:\{chat-browser-research\}:v1:ip:[a-f0-9]{64}:minute:/);
  assert.doesNotMatch(JSON.stringify(command), /192\.0\.2\.11|chat-usage|:cost:|:day:|:month:/);
  assert.deepEqual(args.slice(0, 2), [Date.parse('2026-09-20T12:34:00Z'), Date.parse('2026-09-20T12:35:00Z')]);
  assert.match(args[2], /^[a-f0-9-]{36}$/);
  assert.deepEqual(args.slice(3), [30000, 6, 120, 4]);
  const preview = setup({ env: { ...ENV, VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'other' } });
  await preview.reserve();
  assert.deepEqual(preview.calls[0].command.slice(3, 7), keys);
});

test('lease cleanup is idempotent, awaits completion and is independent of request cancellation', async () => {
  const controller = new AbortController();
  let complete;
  const cleanup = new Promise(resolve => { complete = resolve; });
  const { reserve, calls } = setup({ signal: controller.signal,
    response: (_command, count) => count === 1 ? Response.json({ result: [1, 0, 0, 5] }) : cleanup,
  });
  const result = await reserve();
  controller.abort();
  const first = result.release(), second = result.release();
  assert.equal(first, second);
  let finished = false;
  void second.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].command.slice(3), [calls[0].command[5], calls[0].command[6], calls[0].command[9]]);
  assert.doesNotMatch(calls[1].command[1], /INCR|DECR/);
  assert.equal(calls[1].init.signal.aborted, false);
  complete(Response.json({ result: 1 }));
  await first;
  assert.equal(finished, true);
  const failing = setup({ response: (_command, count) => { if (count === 2) throw new Error('secret'); return Response.json({ result: [1, 0, 0, 5] }); } });
  await assert.doesNotReject((await failing.reserve()).release());
});

test('data controls can reduce ceilings but invalid or increased configuration fails closed', async () => {
  const valid = setup({ env: { ...ENV, CHAT_BROWSER_CLIENT_PER_MINUTE: '2', CHAT_BROWSER_GLOBAL_PER_MINUTE: '20', CHAT_BROWSER_GLOBAL_CONCURRENT: '1' },
    response: () => Response.json({ result: [1, 0, 0, 1] }) });
  assert.equal((await valid.reserve()).allowed, true);
  assert.deepEqual(valid.calls[0].command.slice(-3), [2, 20, 1]);
  for (const [name, bad] of [
    ['CHAT_BROWSER_CLIENT_PER_MINUTE', '7'], ['CHAT_BROWSER_GLOBAL_PER_MINUTE', '121'], ['CHAT_BROWSER_GLOBAL_CONCURRENT', '5'],
    ...['-1', '1e2', '1.5', '', ' 2', 'NaN', 1].map(value => ['CHAT_BROWSER_CLIENT_PER_MINUTE', value]),
  ]) {
    const { reserve, calls } = setup({ env: { ...ENV, [name]: bad } });
    assert.equal((await reserve()).status, 503);
    assert.equal(calls.length, 0);
  }
});

test('rate and concurrency rejections have short bounded retries and never mutate on release', async () => {
  for (const [reason, code] of [[1, 'CHAT_BROWSER_RATE_LIMITED'], [2, 'CHAT_BROWSER_RATE_LIMITED'], [3, 'CHAT_BROWSER_BUSY'], [4, 'CHAT_BROWSER_LIMITS_UNAVAILABLE']]) {
    const { reserve, calls } = setup({ response: () => Response.json({ result: [0, reason, 20, 0] }) });
    const result = await reserve();
    assert.equal(result.code, code);
    assert.equal(result.status, reason === 4 ? 503 : 429);
    assert.equal(result.retryAfter, 20);
    assert.equal(result.allowed, false);
    await result.release();
    assert.equal(calls.length, 1);
  }
});

test('missing credentials, timeouts, corruption and unexpected Redis replies fail closed without leaking details', async () => {
  for (const env of [{}, { ...ENV, KV_REST_API_TOKEN: '' }, { ...ENV, KV_REST_API_URL: 'http://redis.example' }, { ...ENV, KV_REST_API_URL: 'https://redis.example/?secret=abc' }]) {
    const { reserve, calls } = setup({ env });
    assert.equal((await reserve()).status, 503);
    assert.equal(calls.length, 0);
  }
  for (const response of [
    () => { throw new Error('private credential'); }, () => new Response('secret', { status: 500 }),
    () => new Response('not json'), () => Response.json({ error: 'NOAUTH secret' }), () => new Response(' '.repeat(4097)),
    ...[[1, 0, 0, 6], [1, 0, 0, -1], [1, 1, 0, 5], [1, 0, 1, 5], [1, 0, 0, '5'], [1, 0, 0, 5, 1],
      [0, 1, 61, 0], [0, 1, 0, 0], [0, 1, 5, 1], [0, 99, 5, 0], null, { allowed: true }].map(result => () => Response.json({ result })),
  ]) {
    const { reserve } = setup({ response });
    const result = await reserve();
    assert.deepEqual({ ...result, release: undefined }, { allowed: false, code: 'CHAT_BROWSER_LIMITS_UNAVAILABLE', status: 503, retryAfter: 30, remaining: 0, release: undefined });
  }
  for (const extra of [{ signal: AbortSignal.abort() }, { now: NaN }, { now: Infinity }, { now: -1 }]) {
    const { reserve, calls } = setup(extra);
    assert.equal((await reserve()).allowed, false);
    assert.equal(calls.length, 0);
  }
});

test('trusted client identity cannot be changed with unrelated forwarded headers or IPv6 spelling', async () => {
  async function key(headers, env = ENV) {
    const fixture = setup({ env });
    await fixture.reserve(request(headers));
    return fixture.calls[0].command[3];
  }
  assert.equal(await key({ 'x-forwarded-for': '203.0.113.88' }), await key({ 'x-forwarded-for': '198.51.100.99' }));
  assert.notEqual(await key({ 'x-vercel-forwarded-for': '203.0.113.88' }), await key({ 'x-vercel-forwarded-for': '198.51.100.99' }));
  assert.equal(await key({ 'x-vercel-forwarded-for': '2001:db8::1' }), await key({ 'x-vercel-forwarded-for': '2001:0db8:0:0:0:0:0:1' }));
  assert.equal(await key({ 'x-vercel-forwarded-for': 'invalid' }), await key({ 'x-vercel-forwarded-for': 'x'.repeat(513) }));
  const local = { ...ENV, VERCEL: undefined };
  assert.equal(await key({ 'x-vercel-forwarded-for': '203.0.113.88' }, local), await key({ 'x-vercel-forwarded-for': '198.51.100.99' }, local));
  const aliases = setup({ env: { VERCEL: '1', UPSTASH_REDIS_REST_URL: ENV.KV_REST_API_URL, UPSTASH_REDIS_REST_TOKEN: ENV.KV_REST_API_TOKEN } });
  assert.equal((await aliases.reserve()).allowed, true);
});

const luaAvailable = spawnSync('luatex', ['--version'], { encoding: 'utf8' }).status === 0;
function lua(value) {
  if (Array.isArray(value)) return `{${value.map(lua).join(',')}}`;
  if (typeof value === 'number') return String(value);
  return `[========[${value}]========]`;
}
test('actual Lua atomically enforces source rate limits, bounds TTLs, expires leases and rejects corrupt state', { skip: !luaAvailable }, async () => {
  const { reserve, calls } = setup();
  await reserve();
  const payload = calls[0].command;
  const folder = await mkdtemp(join(tmpdir(), 'browser-research-limits-'));
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
function redis.call(command, key, a, b)
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
KEYS = ${lua(payload.slice(3, 7))}
ARGV = ${lua(payload.slice(7))}
local reserve = assert(load(${lua(payload[1])}))
local function clear() db = {}; now = ${NOW}; ARGV[5] = 6; ARGV[6] = 120; ARGV[7] = 4 end
local function count(key) return item(key) and item(key).value or 0 end
local function release() redis.call('ZREM', KEYS[3], ARGV[3]); redis.call('ZREM', KEYS[4], ARGV[3]) end
local function preset(index, value) db[KEYS[index]] = {kind = 'string', value = value, expires = ARGV[2]} end
assert(reserve()[1] == 1)
assert(reserve()[2] == 3, 'One active request per client')
assert(count(KEYS[1]) == 1 and count(KEYS[2]) == 1, 'Rejected work cannot consume source allowance')
assert(db[KEYS[1]].expires == ARGV[2] and db[KEYS[2]].expires == ARGV[2])
assert(db[KEYS[3]].expires == now + 30000 and db[KEYS[4]].expires == now + 30000)
release()
for n = 2, 6 do assert(reserve()[1] == 1); release() end
assert(reserve()[2] == 1, 'Six requests per minute')
assert(count(KEYS[2]) == 6)
clear(); preset(2, 120); assert(reserve()[2] == 2); assert(not item(KEYS[1]))
clear(); for n = 1, 4 do redis.call('ZADD', KEYS[4], now + 30000, 'other-' .. n) end
redis.call('PEXPIRE', KEYS[4], 30000)
assert(reserve()[2] == 3, 'Four global concurrent leases'); assert(not item(KEYS[1]))
clear(); redis.call('ZADD', KEYS[3], now, 'expired'); redis.call('ZADD', KEYS[4], now, 'expired')
redis.call('PEXPIRE', KEYS[3], 30000); redis.call('PEXPIRE', KEYS[4], 30000)
assert(reserve()[1] == 1, 'Expired lease members are purged')
assert(redis.call('ZCARD', KEYS[3]) == 1 and redis.call('ZCARD', KEYS[4]) == 1)
redis.call('ZADD', KEYS[4], now + 30000, 'other-active'); release(); assert(redis.call('ZCARD', KEYS[4]) == 1)
clear(); preset(1, -1); assert(reserve()[2] == 4); assert(not item(KEYS[2]))
clear(); preset(2, 'garbage'); assert(reserve()[2] == 4); assert(not item(KEYS[1]))
clear(); preset(2, 0); db[KEYS[2]].expires = nil; assert(reserve()[2] == 4)
clear(); db[KEYS[4]] = {kind = 'string', value = 0}; assert(reserve()[2] == 4); assert(not item(KEYS[1]))
clear(); redis.call('ZADD', KEYS[4], now + 30000, 'no-key-ttl'); assert(reserve()[2] == 4)
clear(); now = ARGV[2]; assert(reserve()[2] == 4, 'Delayed requests cannot reuse an expired minute')
clear(); ARGV[5] = 0; assert(reserve()[2] == 1)
clear(); ARGV[6] = 0; assert(reserve()[2] == 2)
clear(); ARGV[7] = 0; assert(reserve()[2] == 3)
print('Browser research Lua limits passed')
`);
    const result = spawnSync('luatex', ['--luaonly', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Browser research Lua limits passed/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
