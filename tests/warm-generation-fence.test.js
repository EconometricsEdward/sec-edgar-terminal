import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEC_MIGRATION_COHORT } from '../src/utils/secDocumentStore.js';

const owner = '12345678-1234-4234-8234-123456789abc';
const type = 'edgar.cftc-positioning.v1:local';
const fenceId = 'markets:tff:latest';
const now = Date.now();
const claim = { fenceId, generation: 1, owner, expiresAt: new Date(now + 120000).toISOString() };

async function withCache(run) {
  const originalFetch = globalThis.fetch;
  const names = ['KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.KV_REST_API_URL = 'https://redis.example.test';
  process.env.KV_REST_API_TOKEN = 'test-only-token';
  const commands = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://redis.example.test');
    commands.push(JSON.parse(options.body));
    return Response.json({ result: 1 });
  };
  try { return await run(await import(`../src/utils/warmCache.js?fence=${crypto.randomUUID()}`), commands); }
  finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}

test('only audited dataset/target pairs can reserve and mirror with a generation', async () => withCache(async (cache, commands) => {
  assert.equal(await cache.warmReserveGeneration(type, fenceId, 1, claim), true);
  assert.equal(await cache.warmSetGeneration(type, fenceId, { prepared: true }, 86400, claim), true);
  assert.equal(await cache.warmSetGeneration(type, 'markets-last-good:tff:latest', { prepared: true }, 86400, claim), true);
  assert.equal(await cache.warmSetGeneration(type, 'raw-history:tff:13874A:2026-09-08', {}, 86400, claim), true);
  const validCount = commands.length;
  for (const badClaim of [{ ...claim, generation: null }, { ...claim, generation: 0 }, { ...claim, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...claim, generation: '9223372036854775808' }, { ...claim, expiresAt: '' }, { ...claim, owner: '' }]) {
    assert.equal(await cache.warmReserveGeneration(type, fenceId, badClaim.generation, badClaim), false);
  }
  assert.equal(await cache.warmReserveGeneration('portfolios', fenceId, 1, claim), false);
  assert.equal(await cache.warmReserveGeneration(type, 'credentials', 1, claim), false);
  assert.equal(await cache.warmSetGeneration(type, 'markets:disaggregated:latest', {}, 86400, claim), false);
  assert.equal(await cache.warmSetGeneration(type, 'refresh-checkpoint', {}, 86400, claim), false);
  assert.equal(await cache.warmSetGeneration(type, undefined, {}, 86400, claim), false);
  assert.equal(await cache.warmSetGeneration(type, fenceId, {}, 0, claim), false);
  assert.equal(await cache.warmSetGeneration(type, fenceId, 'x'.repeat(900001), 86400, claim), false);
  assert.equal(commands.length, validCount, 'invalid inputs never issue Redis commands');
}));

test('SEC and financial mirrors require the exact cohort resource and response key', async () => withCache(async (cache, commands) => {
  const sec = { ...claim, fenceId: 'sec-documents-v1:CIK0000320193:submissions' };
  assert.equal(await cache.warmReserveGeneration('submissions-cik', sec.fenceId, sec.generation, sec), true);
  assert.equal(await cache.warmSetGeneration('submissions-cik', '0000320193', { cik: 320193 }, 90000, sec), true);
  assert.equal(await cache.warmSetGeneration('submissions-cik', '0000789019', {}, 90000, sec), false);
  assert.equal(await cache.warmSetGeneration('research-sec-v1', '/submissions/CIK0000320193.json', {}, 300, sec), true);
  const financial = { ...claim, fenceId: 'financial-analysis-v1:analysis-v1.4:xbrl-v1:CIK0000320193:annual:latest' };
  assert.equal(await cache.warmReserveGeneration('analysis-research', financial.fenceId, 1, financial), true);
  assert.equal(await cache.warmSetGeneration('analysis-research', 'analysis-v1.4:xbrl-v1:AAPL:annual:', {}, 90000, financial), true);
  assert.equal(await cache.warmSetGeneration('analysis-research', 'analysis-v1.4:xbrl-v1:MSFT:annual:', {}, 90000, financial), false);
  assert.ok(commands.every(command => command[0] === 'EVAL'));
}));

test('every current cohort member supports both source and prepared rollback mirrors', async () => withCache(async (cache) => {
  for (const { cik, ticker } of SEC_MIGRATION_COHORT) {
    const sec = { ...claim, fenceId: `sec-documents-v1:CIK${cik}:submissions` };
    assert.equal(await cache.warmReserveGeneration('submissions-cik', sec.fenceId, 1, sec), true, ticker);
    assert.equal(await cache.warmSetGeneration('submissions-cik', cik, {}, 90000, sec), true, ticker);
    const financial = { ...claim, fenceId: `financial-analysis-v1:analysis-v1.4:xbrl-v1:CIK${cik}:annual:latest` };
    assert.equal(await cache.warmReserveGeneration('analysis-research', financial.fenceId, 1, financial), true, ticker);
    assert.equal(await cache.warmSetGeneration('analysis-research', `analysis-v1.4:xbrl-v1:${ticker}:annual:`, {}, 90000, financial), true, ticker);
  }
}));

test('Redis errors and missing acknowledgements fail closed without an ordinary SET fallback', async () => withCache(async (cache) => {
  for (const result of [new Response('', { status: 503 }), Response.json({ error: 'denied' }), Response.json({ result: 0 }), Response.json({ result: 'OK' })]) {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return result; };
    assert.equal(await cache.warmSetGeneration(type, fenceId, {}, 3600, claim), false);
    assert.equal(calls, 1);
  }
  globalThis.fetch = async () => { throw new Error('unavailable'); };
  assert.equal(await cache.warmReserveGeneration(type, fenceId, 1, claim), false);
}));

// Execute the actual Lua with a deterministic Redis command harness when a Lua
// interpreter is installed. This checks control flow, integer comparison and
// interruption order; it is not a production Redis throughput benchmark.
function runLua(t, command, scenario) {
  const interpreter = ['texlua', 'lua', 'lua5.4'].find(executable => !spawnSync(executable, ['-v']).error);
  if (!interpreter) { t.skip('Lua interpreter unavailable; generation script execution not verified in this environment.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'edgar-fence-'));
  const path = join(dir, 'fence.lua');
  const script = `
local now = ${now}
local values, expiry = {}, {}
redis = {call = function(operation, name, value, mode, ttl)
  if operation == 'TIME' then return {tostring(math.floor(now / 1000)), tostring((now % 1000) * 1000)} end
  if expiry[name] and expiry[name] <= now then values[name] = nil; expiry[name] = nil end
  if operation == 'GET' then return values[name] end
  if operation == 'SET' then values[name] = value; expiry[name] = mode == 'EX' and now + tonumber(ttl) * 1000 or nil; return 'OK' end
  error('Unexpected Redis operation ' .. operation)
end}
local function evaluate(KEYS, ARGV)
${command[1]}
end
local marker, primary, good = 'fence', 'primary', 'last-good'
local owner, expires = ${JSON.stringify(owner)}, tostring(now + 120000)
local function reserve(generation, token, deadline)
  return evaluate({marker}, {generation, token or owner, deadline or expires, 'reserve'})
end
local function write(target, generation, body, token, deadline)
  return evaluate({marker, target}, {generation, token or owner, deadline or expires, 'write', body, '1'})
end
${scenario}
print('verified')
`;
  try {
    writeFileSync(path, script);
    const result = spawnSync(interpreter, [path], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /verified/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('actual Lua rejects stale stage/final writes and keeps the generation after cache expiry', async t => withCache(async (cache, commands) => {
  await cache.warmReserveGeneration(type, fenceId, 1, claim);
  runLua(t, commands[0], `
assert(write(primary, '1', 'unreserved') == 0)
assert(reserve('1') == 1)
assert(write(primary, '1', 'staged-old') == 1)
assert(reserve('2') == 1)
assert(write(primary, '2', 'new') == 1)
assert(write(good, '2', 'new') == 1)
assert(write(primary, '1', 'late-final') == 0)
assert(write(good, '1', 'late-good') == 0)
assert(values[primary] == 'new' and values[good] == 'new')
assert(expiry[marker] == nil)
now = now + 2000
assert(redis.call('GET', primary) == nil)
assert(reserve('1') == 0)
assert(write(primary, '1', 'resurrected-old') == 0)
assert(write(primary, '2', 'renewed-current') == 1)
now = tonumber(expires)
assert(write(primary, '2', 'expired') == 0)
assert(reserve('2') == 0)
`);
}));

test('actual Lua compares bigint generations exactly and rejects owner/lease changes and corrupt markers', async t => withCache(async (cache, commands) => {
  await cache.warmReserveGeneration(type, fenceId, 1, claim);
  runLua(t, commands[0], `
assert(reserve('9007199254740992') == 1)
assert(reserve('9007199254740993') == 1)
assert(reserve('9007199254740992') == 0)
assert(reserve('9007199254740993', 'different-owner') == 0)
assert(reserve('9007199254740993', owner, tostring(tonumber(expires) + 1)) == 0)
assert(write(primary, '9007199254740992', 'old') == 0)
assert(write(primary, '9007199254740993', 'current') == 1)
values[marker] = 'corrupt'
assert(reserve('9223372036854775807') == 0)
assert(write(primary, '9223372036854775807', 'bad') == 0)
`);
}));
