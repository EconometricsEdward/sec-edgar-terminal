import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { classifyRedisMaintenanceKey, createRedisMaintenanceTransport, maintainRedisCache, summarizeRedisMaintenanceState } from '../src/utils/redisMaintenance.js';

const digest = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const GENERATION = '11111111-1111-4111-8111-111111111111';
const OLD_GENERATION = '22222222-2222-4222-8222-222222222222';
const parentKey = 'warm:quant-atlas-v1:ATLAS';
const chunkKey = generation => `warm:quant-atlas-v1:chunks:ATLAS:${generation}:0`;

function fixture(entries = [], overrides = {}) {
  let time = Date.parse('2026-09-14T12:00:00Z');
  const values = new Map(entries.map(([key, value, ttl = 86400_000]) => [key, { raw: typeof value === 'string' ? value : JSON.stringify(value), expires: ttl === -1 ? null : time + ttl, type: 'string' }]));
  const control = { mode: 'inventory', modeChangedAt: new Date(time).toISOString(), state: {} };
  const durable = new Map(), calls = [], writes = [];
  let scanKeys = [], owner;
  function get(key) {
    const row = values.get(key);
    if (row?.expires != null && row.expires <= time) { values.delete(key); return null; }
    return row || null;
  }
  function ttl(key) { const row = get(key); return row ? row.expires == null ? -1 : row.expires - time : -2; }
  async function command(parts) {
    calls.push(parts);
    await overrides.beforeCommand?.(parts, { values, control, durable, time });
    const [kind, ...args] = parts;
    if (kind === 'SCAN') {
      if (args[0] === '0') scanKeys = [...values.keys()];
      const offset = Number(args[0]), count = overrides.pageSize || 100;
      return [offset + count >= scanKeys.length ? '0' : String(offset + count), scanKeys.slice(offset, offset + count)];
    }
    if (kind === 'TYPE') return get(args[0])?.type || 'none';
    if (kind === 'PTTL') return ttl(args[0]);
    if (kind === 'STRLEN') return Buffer.byteLength(get(args[0])?.raw || '');
    if (kind === 'INFO') return '# Memory\r\nused_memory:266338304\r\nmaxmemory:268435456\r\nsecret_field:DO_NOT_SHOW\r\n';
    if (kind === 'DBSIZE') return values.size;
    if (kind === 'EVAL_RO') return [get(args[2])?.raw || null, ttl(args[2])];
    if (kind === 'DELEX') {
      assert.equal(args.length, 3); assert.equal(args[1], 'IFEQ');
      if (get(args[0])?.raw !== args[2]) return 0;
      values.delete(args[0]); return 1;
    }
    if (kind === 'EVAL') {
      const [script, count, ...rest] = args, keys = rest.slice(0, count), hashes = rest.slice(count);
      const matches = (key, hash) => hash === 'absent' ? !get(key) : get(key) && digest(get(key).raw, 'sha1') === hash;
      if (!keys.every((key, index) => matches(key, hashes[index]))) return [0, 0];
      const removing = script.includes("ARGV[1] == 'absent'") ? keys.slice(1) : keys;
      const bytes = removing.reduce((sum, key) => sum + Buffer.byteLength(get(key)?.raw || ''), 0);
      removing.forEach(key => values.delete(key));
      return [removing.length, bytes];
    }
    throw new Error(`Unexpected fake command ${kind}`);
  }
  const injected = {
    now: () => time,
    readState: async () => structuredClone(control),
    claimState: async proposed => { owner = proposed; return { ...structuredClone(control), owner, leaseUntil: new Date(time + 45_000).toISOString() }; },
    saveState: async (claimed, state) => { assert.equal(claimed, owner); control.state = structuredClone(state); return { saved: true }; },
    redis: { command, pipeline: async commands => Promise.all(commands.map(command)) },
    cachePut: async (type, id, payload, seconds, options) => {
      writes.push({ type, id, payload, seconds, options });
      await overrides.beforePut?.({ type, id, payload, seconds, options, durable });
      const key = `${type}:${id}`;
      if (durable.has(key)) return { stored: false, reason: 'exists' };
      const row = { payload, rawSha256: digest(JSON.stringify(payload)), expiresAt: new Date(Math.min(time + seconds * 1000, Date.parse(options.expiresAt))).toISOString() };
      durable.set(key, row); return { stored: true, ...row };
    },
    cacheGet: async (type, id) => {
      const row = durable.get(`${type}:${id}`);
      return overrides.cacheGet ? overrides.cacheGet(row) : row || null;
    },
  };
  return { values, durable, calls, writes, control, injected,
    advance: milliseconds => { time += milliseconds; },
    run: () => maintainRedisCache({ deadline: time + 20_000 }, injected),
    migrate: () => { control.mode = 'migrate'; control.modeChangedAt = new Date(time - 600_001).toISOString(); },
  };
}

function marketPayload(extra = {}) {
  return { version: 'market-research-v3', generatedAt: '2026-09-14T11:00:00Z', requested: 1,
    companies: [{ version: 'market-research-v3', ticker: 'AAPL', name: 'Apple', cik: '0000320193', sic: '3571', observedAt: '2026-09-14T10:00:00Z',
      cohorts: [], metrics: { annual: {}, ttm: {} }, reports: { annual: null, ttm: null }, filingComparisons: { annual: null, ttm: null } }],
    cohorts: [], failures: [], observations: [], historyPersistence: true, ...extra };
}
function snapshotEntries(input, extra = [], { type = 'quant-atlas-v1', id = 'ATLAS', wrap = true } = {}) {
  const payload = wrap ? marketPayload(input) : input;
  const raw = JSON.stringify(payload), encoded = gzipSync(raw).toString('base64');
  const manifest = { format: 'gzip-chunks-v1', ids: [`${id}:${GENERATION}:0`], bytes: Buffer.byteLength(raw), sha256: digest(raw) };
  return [[`warm:${type}:${id}`, manifest, 86400_000], [`warm:${type}:chunks:${id}:${GENERATION}:0`, JSON.stringify(encoded), 90000_000], ...extra];
}

test('fixed classifier admits reviewed data and protects operational/unknown keys', () => {
  assert.equal(classifyRedisMaintenanceKey('warm:quant-company-v2:production:0000320193').family, 'checkpoint');
  assert.equal(classifyRedisMaintenanceKey('warm:market-research-v3:OBSERVATIONS').family, 'history');
  assert.equal(classifyRedisMaintenanceKey('warm:research-sec-v1:/SUBMISSIONS/CIK0000320193.JSON').sourceCik, '0000320193');
  assert.equal(classifyRedisMaintenanceKey(chunkKey(GENERATION)).family, 'snapshot-chunks');
  for (const key of ['rl:analysis:10.1.2.3', 'warm:lease:quant-coverage-v2:production:BATCH-1', 'warm:generation:analysis-research:ANYTHING', 'warm:provider-cooldown:SEC']) {
    assert.equal(classifyRedisMaintenanceKey(key).family, 'coordination');
  }
  for (const key of ['warm:quant-company-v2:preview-abc:0000320193', 'warm:quant-company-v2:production:0000000000', 'warm:user-notes:alice', 'anything:else', `${chunkKey(GENERATION)}:extra`]) {
    assert.equal(classifyRedisMaintenanceKey(key).family, 'unknown');
  }
});

test('inventory records metadata only, with no mutation and no secrets in summary', async () => {
  const f = fixture([['warm:quant-company-v1:0000320193', { company: 'large' }], ['rl:analysis:10.1.2.3', '4', 60_000], ['warm:market-research-v3:OBSERVATIONS', [{ at: 'prior' }], 90 * 86400_000]]);
  const result = await f.run();
  assert.equal(result.status, 'inventory_complete');
  assert.equal(result.inventory.keyObservations, 3);
  assert.equal(result.inventory.byFamily.history.expiresLater, 1);
  assert.equal(result.redis.usedMemoryBytes, 266338304);
  assert.equal(f.writes.length, 0);
  assert.ok(f.calls.every(call => !['GET', 'EVAL', 'DELEX', 'DEL', 'SET'].includes(call[0])));
  assert.doesNotMatch(JSON.stringify(result), /10\.1\.2\.3|DO_NOT_SHOW|0000320193/);
  const calls = f.calls.length; assert.equal((await f.run()).status, 'waiting'); assert.equal(f.calls.length, calls);
});

test('SCAN count overflow is resumed without dropping page keys', async () => {
  const entries = Array.from({ length: 250 }, (_, index) => [`unknown:${index}`, 'x']);
  const f = fixture(entries, { pageSize: 250 });
  assert.equal((await f.run()).inventory.keyObservations, 200);
  assert.equal(f.control.state.pending.length, 50);
  assert.equal((await f.run()).inventory.keyObservations, 250);
  assert.equal(f.control.state.pending.length, 0);
  assert.equal(f.calls.filter(call => call[0] === 'SCAN').length, 1);
});

test('unknown inventory groups only bounded safe type prefixes without exposing IDs or changing admission', async () => {
  const entries = [['warm:old-company-v0:0000320193', 'large'], ['warm:old-company-v0:0000789019', 'large'],
    ['warm:user-notes:alice', 'private'], ['warm:auth-session:secret', 'protected'], ['warm:ALICE:email@example.com', 'private'],
    ...Array.from({ length: 30 }, (_, index) => [`warm:legacy-type-${index}:sensitive-${index}`, 'other'])];
  const f = fixture(entries); const result = await f.run();
  assert.equal(result.inventory.byUnknownType['old-company-v0'].keyObservations, 2);
  assert.equal(Object.keys(result.inventory.byUnknownType).filter(key => key !== 'other').length, 24);
  assert.ok(result.inventory.byUnknownType.other.keyObservations > 0);
  assert.doesNotMatch(JSON.stringify(result), /0000320193|0000789019|alice|email@example|sensitive|user-notes|auth-session/);
  assert.equal(classifyRedisMaintenanceKey('warm:old-company-v0:0000320193').family, 'unknown');
});

test('migration preserves verified data including history and deletes only reviewed source values', async () => {
  const dataKey = 'warm:quant-company-v1:0000320193';
  const historyKey = 'warm:market-research-v3:OBSERVATIONS';
  const f = fixture([[dataKey, { company: { cik: '0000320193' } }, 30 * 86400_000], [historyKey, [{ day: '2026-09-01' }], 90 * 86400_000], ['rl:analysis:ip', '2'], ['warm:generation:research:CIK1', 'immutable', -1]]);
  await f.run(); f.migrate();
  const result = await f.run();
  assert.equal(result.counters.removed, 2);
  assert.equal(f.values.has(dataKey), false); assert.equal(f.values.has(historyKey), false);
  assert.equal(f.values.has('rl:analysis:ip'), true); assert.equal(f.values.has('warm:generation:research:CIK1'), true);
  assert.deepEqual(f.durable.get('market-research-v3:OBSERVATIONS').payload, [{ day: '2026-09-01' }]);
  assert.equal(f.writes.find(row => row.type === 'quant-company-v1').seconds, 14 * 86400);
  assert.ok(f.writes.every(row => row.options.ifHash === 'absent' && Number.isFinite(Date.parse(row.options.expiresAt))));
});

test('fresh runtime handoff imports but never deletes before ten minutes', async () => {
  const key = 'warm:quant-company-v1:0000320193';
  const f = fixture([[key, { company: 'safe' }]]);
  await f.run(); f.control.mode = 'migrate';
  const result = await f.run();
  assert.equal(result.counters.migrated, 1); assert.equal(result.counters.removed, 0);
  assert.equal(f.values.has(key), true); assert.ok(!f.calls.some(call => ['EVAL', 'DELEX', 'DEL'].includes(call[0])));
});

test('concurrent changed Redis writer survives native exact-value compare-delete', async () => {
  const key = 'warm:quant-company-v1:0000320193';
  const f = fixture([[key, { version: 1 }]], {
    beforeCommand(parts, { values }) { if (parts[0] === 'DELEX') values.get(key).raw = JSON.stringify({ version: 2 }); },
  });
  await f.run(); f.migrate();
  const result = await f.run();
  assert.equal(result.counters.removed, 0);
  assert.equal(result.counters.removedStringValueBytes, 0);
  assert.equal(JSON.parse(f.values.get(key).raw).version, 2);
});

test('native compare-delete frees verified standalone bytes when capacity rejects every write script', async () => {
  const key = 'warm:quant-company-v1:0000320193', raw = ' {\n "company": "Café" }\n';
  const f = fixture(snapshotEntries({}, [[key, raw]]), {
    beforeCommand(parts) { if (parts[0] === 'EVAL') throw Object.assign(new Error('private capacity diagnostic'), { code: 'redis_storage_limit' }); },
  });
  await f.run(); f.migrate(); const result = await f.run();
  assert.equal(f.values.has(key), false); assert.equal(f.values.has(parentKey), true); assert.equal(f.values.has(chunkKey(GENERATION)), true);
  assert.equal(result.counters.removed, 1); assert.equal(result.counters.removedStringValueBytes, Buffer.byteLength(raw));
  assert.equal(result.errors.redis_storage_limit, 1);
  assert.deepEqual(f.calls.find(call => call[0] === 'DELEX'), ['DELEX', key, 'IFEQ', raw]);
  assert.deepEqual(f.durable.get('quant-company-v1:0000320193').payload, { company: 'Café' });
  assert.ok(!f.calls.some(call => call[0] === 'DEL'));
});

test('invalid native acknowledgements or unsupported command preserve accounting with no unconditional fallback', async () => {
  const key = 'warm:quant-company-v1:0000320193';
  for (const reply of [-1, 2, '1', null, 'unsupported']) {
    const f = fixture([[key, { company: 'safe' }]]);
    const original = f.injected.redis.command;
    f.injected.redis.command = async parts => {
      if (parts[0] !== 'DELEX') return original(parts);
      f.calls.push(parts);
      if (reply === 'unsupported') throw Object.assign(new Error('unknown command private information'), { code: 'redis_unsupported' });
      return reply;
    };
    await f.run(); f.migrate(); const result = await f.run();
    assert.equal(result.counters.removed, 0); assert.equal(result.counters.removedStringValueBytes, 0);
    assert.equal(f.values.has(key), true);
    assert.equal(result.errors[reply === 'unsupported' ? 'redis_unsupported' : 'redis_delete_response'], 1);
    assert.ok(!f.calls.some(call => ['DEL', 'EVAL'].includes(call[0])));
    assert.doesNotMatch(JSON.stringify(result), /private information/);
  }
});

test('durable mismatch or write failure preserves Redis', async () => {
  const key = 'warm:quant-company-v1:0000320193';
  for (const overrides of [{ cacheGet: row => ({ ...row, rawSha256: 'f'.repeat(64) }) },
    { cacheGet: () => null }, { cacheGet: row => ({ ...row, expiresAt: '2026-09-14T11:59:59Z' }) },
    { beforePut: () => { throw new Error('private secret error'); } }]) {
    const f = fixture([[key, { version: 1 }]], overrides);
    await f.run(); f.migrate(); const result = await f.run();
    assert.equal(f.values.has(key), true); assert.equal(result.counters.removed, 0);
    assert.ok(!f.calls.some(call => ['DELEX', 'DEL'].includes(call[0])));
    assert.doesNotMatch(JSON.stringify(result), /private secret/);
  }
});

test('only known DisposableCacheError codes become safe cache diagnostics', async () => {
  for (const [code, name, expected] of [
    ['timeout', 'DisposableCacheError', 'cache_timeout'], ['transport_failure', 'DisposableCacheError', 'cache_transport_failure'],
    ['http_503', 'DisposableCacheError', 'cache_http_error'], ['integrity_mismatch', 'DisposableCacheError', 'cache_integrity_mismatch'],
    ['deadline', 'DisposableCacheError', 'cache_deadline'], ['private_secret', 'DisposableCacheError', 'maintenance_operation'],
    ['timeout', 'Error', 'maintenance_operation'],
  ]) {
    const f = fixture();
    f.injected.readState = async () => { throw Object.assign(new Error('private raw provider message'), { name, code }); };
    const result = await f.run(); assert.equal(result.code, expected);
    assert.doesNotMatch(JSON.stringify(result), /private|raw provider/);
  }
});

test('permanent values are preserved and expired values are never re-created', async () => {
  const permanent = 'warm:quant-company-v1:0000320193', expiring = 'warm:quant-company-v1:0000789019';
  const f = fixture([[permanent, { permanent: true }, -1], [expiring, { ephemeral: true }, 1]]);
  await f.run(); f.advance(2); f.migrate(); await f.run();
  assert.equal(f.values.has(permanent), true); assert.equal(f.writes.length, 0);
});

test('complete snapshot import verifies original checksum and removes exact manifest plus chunks', async () => {
  const payload = { rows: [{ cik: '0000320193', value: 123 }], generatedAt: '2026-09-14T10:00:00Z' };
  const f = fixture(snapshotEntries(payload));
  await f.run(); f.migrate(); const result = await f.run();
  assert.deepEqual(f.durable.get('quant-atlas-v1:ATLAS').payload, marketPayload(payload));
  assert.equal(result.counters.removed, 2);
  assert.equal(f.values.size, 0);
});

test('missing, corrupt or cross-parent chunks preserve the complete legacy snapshot', async () => {
  for (const change of ['missing', 'corrupt', 'cross-parent']) {
    const f = fixture(snapshotEntries({ x: 'original' }));
    if (change === 'missing') f.values.delete(chunkKey(GENERATION));
    if (change === 'corrupt') f.values.get(chunkKey(GENERATION)).raw = JSON.stringify('invalid_base64');
    if (change === 'cross-parent') {
      const manifest = JSON.parse(f.values.get(parentKey).raw); manifest.ids[0] = `ATLAS-LAST-GOOD:${GENERATION}:0`; f.values.get(parentKey).raw = JSON.stringify(manifest);
    }
    await f.run(); f.migrate(); const result = await f.run();
    assert.equal(f.values.has(parentKey), true); assert.equal(f.writes.length, 0); assert.equal(result.counters.removed, 0);
    assert.ok(result.counters.errors > 0);
  }
});

test('parent publication race prevents deleting the previous snapshot chunks', async () => {
  const f = fixture(snapshotEntries({ x: 1 }), {
    beforeCommand(parts, { values }) { if (parts[0] === 'EVAL' && parts[1].includes('#KEYS')) values.get(parentKey).raw = JSON.stringify({ new: 'publication' }); },
  });
  await f.run(); f.migrate(); await f.run();
  assert.equal(f.values.has(chunkKey(GENERATION)), true); assert.equal(f.values.has(parentKey), true);
});

test('unreferenced generation is kept for ten minutes then fenced and removed', async () => {
  const orphan = chunkKey(OLD_GENERATION);
  const f = fixture(snapshotEntries({ rows: [1, 2, 3] }, [[orphan, JSON.stringify('b2xk'), 86400_000]]));
  await f.run(); f.migrate(); await f.run();
  assert.equal(f.values.has(orphan), true);
  f.advance(599_999); assert.equal((await f.run()).status, 'waiting'); assert.equal(f.values.has(orphan), true);
  f.advance(2); const result = await f.run();
  assert.equal(f.values.has(orphan), false); assert.equal(result.counters.removed, 3);
});

test('orphan cleanup preserves a chunk referenced by a racing parent', async () => {
  const orphan = chunkKey(OLD_GENERATION);
  const f = fixture(snapshotEntries({ rows: [1] }, [[orphan, JSON.stringify('b2xk'), 86400_000]]), {
    beforeCommand(parts, { values, time }) {
      if (parts[0] === 'EVAL' && parts[1].includes("ARGV[1] == 'absent'")) {
        values.set(parentKey, { raw: JSON.stringify({ format: 'gzip-chunks-v1', ids: [`ATLAS:${OLD_GENERATION}:0`] }), type: 'string', expires: time + 86400_000 });
      }
    },
  });
  await f.run(); f.migrate(); await f.run(); f.advance(600_001); await f.run();
  assert.equal(f.values.has(orphan), true);
});

test('newer validated durable publication permits only orphan deletion, preserving differing current Redis snapshot', async () => {
  const orphan = chunkKey(OLD_GENERATION);
  const f = fixture(snapshotEntries({}, [[orphan, JSON.stringify('b2xk'), 86400_000]]));
  const newer = marketPayload({ generatedAt: '2026-09-14T11:30:00Z' });
  f.durable.set('quant-atlas-v1:ATLAS', { payload: newer, rawSha256: digest(JSON.stringify(newer)), expiresAt: '2026-09-15T12:00:00Z' });
  await f.run(); f.migrate(); await f.run();
  assert.equal(f.values.has(parentKey), true); assert.equal(f.values.has(chunkKey(GENERATION)), true);
  f.advance(600_001); await f.run();
  assert.equal(f.values.has(orphan), false);
  assert.equal(f.values.has(parentKey), true); assert.equal(f.values.has(chunkKey(GENERATION)), true);
  assert.equal(f.control.state.snapshotProofs[0].publicationTime, '2026-09-14T11:30:00.000Z');
});

test('refresh during orphan grace advances a validated proof and cannot strand obsolete chunks', async () => {
  const orphan = chunkKey(OLD_GENERATION);
  const f = fixture(snapshotEntries({}, [[orphan, JSON.stringify('b2xk'), 86400_000]]));
  await f.run(); f.migrate(); await f.run();
  const newer = marketPayload({ generatedAt: '2026-09-14T11:45:00Z' });
  f.durable.set('quant-atlas-v1:ATLAS', { payload: newer, rawSha256: digest(JSON.stringify(newer)), expiresAt: '2026-09-15T12:00:00Z' });
  f.advance(600_001); await f.run(); assert.equal(f.values.has(orphan), false);
  assert.equal(f.control.state.snapshotProofs[0].publicationTime, '2026-09-14T11:45:00.000Z');
});

test('an exact older import cannot roll back a previously validated orphan publication time', async () => {
  const f = fixture(snapshotEntries({}));
  await f.run(); f.migrate();
  f.control.state.snapshotProofs[0] = { target: 0, schema: 'market-research-v3', basis: null,
    publicationTime: '2026-09-14T11:45:00.000Z', rawSha256: 'a'.repeat(64), expiresAt: '2026-09-15T12:00:00Z' };
  await f.run();
  assert.equal(f.control.state.snapshotProofs[0].publicationTime, '2026-09-14T11:45:00.000Z');
  assert.equal(f.control.state.snapshotProofs[0].rawSha256, 'a'.repeat(64));
});

test('older, invalid, future, stale or wrong-version replacement cannot authorize orphan cleanup', async () => {
  const invalid = [marketPayload({ generatedAt: '2026-09-14T10:30:00Z' }), { generatedAt: '2026-09-14T11:30:00Z' },
    marketPayload({ generatedAt: '2026-09-14T13:00:00Z' }), marketPayload({ generatedAt: '2026-09-01T12:00:00Z' }), marketPayload({ version: 'legacy-unknown' })];
  for (const replacement of invalid) {
    const orphan = chunkKey(OLD_GENERATION);
    const f = fixture(snapshotEntries({}, [[orphan, JSON.stringify('b2xk'), 86400_000]]));
    f.durable.set('quant-atlas-v1:ATLAS', { payload: replacement, rawSha256: digest(JSON.stringify(replacement)), expiresAt: '2026-09-15T12:00:00Z' });
    await f.run(); f.migrate(); await f.run(); f.advance(600_001); await f.run();
    assert.equal(f.values.has(parentKey), true); assert.equal(f.values.has(chunkKey(GENERATION)), true); assert.equal(f.values.has(orphan), true);
  }
});

test('Fundamental Lab replacement must match the parent reporting basis', async () => {
  const { buildUniverseSnapshot } = await import('../src/utils/marketUniverse.js');
  const { isUniverseSnapshot } = await import('../src/utils/marketUniverseServer.js');
  const type = 'edgar.fundamental-universe.v2:production', id = 'ANNUAL';
  const base = marketPayload(); base.companies[0].researchGroup = { id: 'technology' }; base.groups = [{ id: 'technology', label: 'Technology' }];
  const annual = buildUniverseSnapshot(base, {}, { basis: 'annual', now: new Date('2026-09-14T11:00:00Z') });
  const wrong = buildUniverseSnapshot(base, {}, { basis: 'ttm', now: new Date('2026-09-14T11:30:00Z') });
  assert.equal(isUniverseSnapshot(annual, 'annual'), true); assert.equal(isUniverseSnapshot(wrong, 'ttm'), true);
  const orphan = `warm:${type}:chunks:${id}:${OLD_GENERATION}:0`;
  const f = fixture(snapshotEntries(annual, [[orphan, JSON.stringify('b2xk'), 86400_000]], { type, id, wrap: false }));
  f.durable.set(`${type}:${id}`, { payload: wrong, rawSha256: digest(JSON.stringify(wrong)), expiresAt: '2026-09-15T12:00:00Z' });
  await f.run(); f.migrate(); await f.run(); f.advance(600_001); await f.run();
  assert.equal(f.values.has(`warm:${type}:${id}`), true); assert.equal(f.values.has(orphan), true);
  assert.equal(f.control.state.snapshotProofs[8], undefined);
});

test('steady mode performs no repeated scan between weekly inventories', async () => {
  const f = fixture([['unknown:one', 'value']]);
  await f.run(); f.control.mode = 'steady';
  const initial = f.calls.length; assert.equal((await f.run()).status, 'waiting'); assert.equal(f.calls.length, initial);
  f.advance(7 * 86400_000 + 1); const next = await f.run();
  assert.equal(next.status, 'inventory_complete'); assert.equal(next.phase, 'steady');
  const after = f.calls.length; await f.run(); assert.equal(f.calls.length, after);
});

test('deadline stops before another page and keeps queued work for a later claim', async () => {
  const f = fixture(Array.from({ length: 120 }, (_, index) => [`unknown:${index}`, 'value']));
  const original = f.injected.redis.pipeline;
  f.injected.redis.pipeline = async commands => {
    const results = await original(commands);
    if (commands[0]?.[0] === 'STRLEN') f.advance(18_000);
    return results;
  };
  const partial = await f.run();
  assert.equal(partial.inventory.keyObservations, 100);
  assert.equal(f.control.state.cursor, '100');
  f.injected.redis.pipeline = original;
  const completed = await f.run(); assert.equal(completed.inventory.keyObservations, 120); assert.equal(completed.status, 'inventory_complete');
});

test('malformed claim and failed checkpoint save do not report committed success', async () => {
  const f = fixture([['unknown:one', 'value']]);
  f.injected.claimState = async owner => ({ ...f.control, owner, leaseUntil: 'invalid' });
  assert.equal((await f.run()).code, 'maintenance_claim'); assert.equal(f.calls.length, 0);
  const other = fixture([['unknown:one', 'value']]);
  other.injected.saveState = async () => ({ saved: false });
  assert.equal((await other.run()).status, 'uncommitted'); assert.equal(other.control.state.version, undefined);
});

test('transport caps streamed response bodies rather than trusting content length', async () => {
  const transport = createRedisMaintenanceTransport({ env: { KV_REST_API_URL: 'https://example.invalid', KV_REST_API_TOKEN: 'secret' },
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(2048))); controller.close(); } })) });
  await assert.rejects(transport.command(['INFO', 'memory'], { maxBytes: 1024 }), error => error.code === 'redis_response_size');
});

test('safe summary strips unknown fields, keys, proofs and invalid metrics', () => {
  const result = summarizeRedisMaintenanceState({ version: 1, phase: 'inventory', pending: ['rl:secret-ip'], snapshotProofs: { secret: 'raw' },
    inventory: { keyObservations: 2, byFamily: { checkpoint: { keyObservations: 1, stringValueBytes: -1 }, 'secret:key': { keyObservations: 1 } } },
    counters: { removed: 'secret' }, errors: { redis_oom: 1, 'secret:error': 7 } });
  assert.doesNotMatch(JSON.stringify(result), /secret|raw|pending|snapshotProofs/);
  assert.equal(result.inventory.byFamily.checkpoint.stringValueBytes, null); assert.deepEqual(result.errors, { redis_oom: 1 });
});

test('Redis transport uses existing credential internally and exposes only classified provider errors', async () => {
  for (const [error, code] of [['OOM command not allowed', 'redis_oom'], ['maxmemory limit exceeded', 'redis_maxmemory'], ['max data size limit exceeded', 'redis_storage_limit'], ['max command limit exceeded', 'redis_quota'], ['WRONGPASS token top-secret', 'redis_auth']]) {
    const transport = createRedisMaintenanceTransport({ env: { KV_REST_API_URL: 'https://example.invalid', KV_REST_API_TOKEN: 'top-secret' },
      fetchImpl: async (_url, options) => { assert.equal(options.headers.Authorization, 'Bearer top-secret'); return Response.json({ error }, { status: 400 }); } });
    await assert.rejects(transport.command(['INFO', 'memory']), problem => problem.code === code && !problem.message.includes('top-secret'));
  }
});

test('cold metadata reads receive five seconds while deletes and the total deadline stay bounded', async () => {
  const durations = [];
  const transport = createRedisMaintenanceTransport({ env: { KV_REST_API_URL: 'https://example.invalid', KV_REST_API_TOKEN: 'secret' }, now: () => 1000,
    timeoutSignal: milliseconds => { durations.push(milliseconds); return new AbortController().signal; },
    fetchImpl: async (_url, options) => Response.json(Array.isArray(JSON.parse(options.body)[0]) ? [{ result: 'string' }, { result: 4000 }] : { result: 1 }) });
  await transport.command(['SCAN', '0', 'COUNT', '100'], { deadline: 21_000 });
  await transport.pipeline([['TYPE', 'warm:known:ID'], ['PTTL', 'warm:known:ID']], { deadline: 21_000 });
  await transport.command(['EVAL', 'return 0', 1, 'warm:known:ID'], { deadline: 21_000 });
  await transport.command(['DELEX', 'warm:known:ID', 'IFEQ', 'original'], { deadline: 21_000 });
  await transport.command(['SCAN', '0', 'COUNT', '100'], { deadline: 1800 });
  assert.deepEqual(durations, [5000, 5000, 2000, 2000, 800]);
});

test('maintenance transport distinguishes request timeout, total deadline and network errors', async () => {
  const cases = [
    { deadline: 21_000, abort: true, expected: 'redis_timeout' },
    { deadline: 1800, abort: true, expected: 'maintenance_deadline' },
    { deadline: 21_000, abort: false, expected: 'redis_transport' },
  ];
  for (const scenario of cases) {
    const controller = new AbortController();
    const transport = createRedisMaintenanceTransport({ env: { KV_REST_API_URL: 'https://example.invalid', KV_REST_API_TOKEN: 'secret' }, now: () => 1000,
      timeoutSignal: () => controller.signal,
      fetchImpl: async () => { if (scenario.abort) controller.abort(); throw new Error('private connection details'); } });
    await assert.rejects(transport.command(['SCAN', '0', 'COUNT', '100'], { deadline: scenario.deadline }), error => error.code === scenario.expected && !error.message.includes('private'));
  }
});
