import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createScannerCache, SCANNER_CACHE_NAMESPACE, SCANNER_INVALIDATION_NAMESPACE, SCANNER_CACHE_TTL_SECONDS } from '../src/utils/scannerCache.js';
import { disposableCachePolicy } from '../supabase/functions/edgar-data-gateway/cachePolicy.js';

const NOW = Date.parse('2026-09-13T20:00:00Z');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const result = { ticker: 'SMALL', cik: '0000012345', matches: [{ excerpts: [{ fullText: 'Public SEC disclosure evidence' }] }] };
const signature = 'normalized-query|depth=35|match=any';

function fixture({ env = { VERCEL_ENV: 'production' }, beforePut, readFailure = false, putFailure = false } = {}) {
  let time = NOW;
  const rows = new Map(), markers = new Map(), reads = [], writes = [];
  const makeRow = (payload, ttl = 86400) => ({ payload, rawSha256: hash(payload), expiresAt: new Date(time + ttl * 1000).toISOString() });
  const cache = createScannerCache({ env, now: () => time,
    read: async (type, key) => {
      reads.push({ type, key });
      if (typeof readFailure === 'function' ? readFailure(type) : readFailure) throw new Error('Unavailable');
      const row = (type === SCANNER_INVALIDATION_NAMESPACE ? markers : rows).get(key);
      return row && Date.parse(row.expiresAt) > time ? row : null;
    },
    put: async (type, key, payload, ttl, options = {}) => {
      writes.push({ type, key, payload, ttl, options });
      await beforePut?.({ rows, markers, key, payload, makeRow });
      if (putFailure) return { stored: false };
      const target = type === SCANNER_INVALIDATION_NAMESPACE ? markers : rows;
      const prior = target.get(key);
      if (options.ifHash === 'absent' ? Boolean(prior) : options.ifHash != null && prior?.rawSha256 !== options.ifHash) return { stored: false };
      target.set(key, makeRow(payload, ttl)); return { stored: true };
    },
  });
  return { cache, rows, markers, reads, writes, env, makeRow, advance: ms => { time += ms; } };
}

test('production scanner uses the bounded research family for any valid ticker and preserves query identities', async () => {
  const f = fixture();
  assert.equal(await f.cache.setCachedDisclosureScan('small', signature, result, { startedAt: NOW - 1000 }), true);
  assert.equal(await f.cache.getBackendType(), 'supabase');
  assert.equal(f.writes[0].type, SCANNER_CACHE_NAMESPACE);
  assert.match(f.writes[0].key, /^SMALL:KW:[a-f0-9]{64}$/);
  assert.equal(f.writes[0].ttl, SCANNER_CACHE_TTL_SECONDS);
  assert.equal(disposableCachePolicy(f.writes[0].type, f.writes[0].key).family, 'research');
  assert.deepEqual((await f.cache.getCachedDisclosureScan('SMALL', signature)).result, result);
  assert.equal(await f.cache.getCachedDisclosureScan('SMALL', `${signature}|other`), null);
  assert.equal(await f.cache.getCachedDisclosureScan('OTHER', signature), null);
  assert.equal(await f.cache.getCachedDisclosureScan('SMALL'), null);
  assert.equal(f.cache.memoryStats().entries, 0);
});

test('scanner policy accepts only versioned ticker and exact signature shapes', () => {
  assert.equal(disposableCachePolicy(SCANNER_CACHE_NAMESPACE, 'BRK-B:SCAN').family, 'research');
  assert.equal(disposableCachePolicy(SCANNER_CACHE_NAMESPACE, `SMALL:KW:${'a'.repeat(64)}`).family, 'research');
  assert.equal(disposableCachePolicy(SCANNER_INVALIDATION_NAMESPACE, `SMALL:KW:${'a'.repeat(64)}`).family, 'reference');
  for (const [type, key] of [
    ['scanner-results-v1', 'SMALL:SCAN'], ['scanner-results-v2:preview', 'SMALL:SCAN'],
    [SCANNER_CACHE_NAMESPACE, `SMALL:KW:${'a'.repeat(24)}`], [SCANNER_CACHE_NAMESPACE, 'https://example.com:SCAN'],
    [SCANNER_CACHE_NAMESPACE, 'SMALL:SESSION'], [SCANNER_CACHE_NAMESPACE, 'SMALL:SCAN:extra'],
    [SCANNER_CACHE_NAMESPACE, 'A'.repeat(11) + ':SCAN'], ['auth', 'SMALL:SCAN'],
  ]) assert.equal(disposableCachePolicy(type, key), null);
});

test('scan freshness remains 24 hours even if a stored expiration is longer and reads do not renew it', async () => {
  const f = fixture();
  await f.cache.setCachedScan('SMALL', result);
  const row = f.rows.get('SMALL:SCAN'); row.expiresAt = new Date(NOW + 25 * 3600000).toISOString();
  f.advance(24 * 3600000 - 1);
  assert.ok(await f.cache.getCachedScan('SMALL'));
  assert.equal(f.writes.length, 1);
  f.advance(1);
  assert.equal(await f.cache.getCachedScan('SMALL'), null);
  assert.equal(f.writes.length, 1);
});

test('invalidation leaves a protected marker and an older in-flight scan cannot refill the result', async () => {
  const f = fixture();
  await f.cache.setCachedDisclosureScan('SMALL', signature, result, { startedAt: NOW - 1000 });
  await f.cache.invalidateDisclosureScan('SMALL', signature);
  assert.equal([...f.markers.values()][0].payload.status, 'invalidated');
  assert.equal(f.writes.at(-1).ttl, 25 * 3600);
  assert.equal(await f.cache.getCachedDisclosureScan('SMALL', signature), null);
  f.advance(1000);
  assert.equal(await f.cache.setCachedDisclosureScan('SMALL', signature, result, { startedAt: NOW - 1000 }), false);
  assert.equal(await f.cache.setCachedDisclosureScan('SMALL', signature, result), false);
  assert.equal(await f.cache.setCachedDisclosureScan('SMALL', signature, result, { startedAt: NOW + 1 }), true);
  assert.deepEqual((await f.cache.getCachedDisclosureScan('SMALL', signature)).result, result);
});

test('CAS rejects a scan when another publication arrives between its read and write', async () => {
  let invalidationTime = null;
  const f = fixture({ beforePut: ({ rows, key, payload, makeRow }) => {
    if (payload.status === 'ready' && invalidationTime) rows.set(key, makeRow({ ...payload, newerPublication: true }));
  } });
  await f.cache.setCachedScan('SMALL', result, { startedAt: NOW - 1000 });
  invalidationTime = new Date(NOW).toISOString();
  f.advance(1000);
  assert.equal(await f.cache.setCachedScan('SMALL', result, { startedAt: NOW - 500 }), false);
  assert.ok(await f.cache.getCachedScan('SMALL'));
  assert.equal(f.rows.get('SMALL:SCAN').payload.newerPublication, true);
});

test('future or malformed invalidation timestamps cannot be overridden by a new scan', async () => {
  for (const invalidatedAt of ['bad', new Date(NOW + 60000).toISOString()]) {
    const f = fixture();
    f.markers.set('SMALL:SCAN', f.makeRow({ schema: 2, status: 'invalidated', ticker: 'SMALL', invalidatedAt }));
    assert.equal(await f.cache.setCachedScan('SMALL', result, { startedAt: NOW - 1000 }), false);
    assert.equal(f.writes.length, 0);
  }
});

test('result eviction cannot erase an acknowledged invalidation', async () => {
  const f = fixture();
  await f.cache.setCachedScan('SMALL', result, { startedAt: NOW - 1000 });
  await f.cache.invalidateScan('SMALL');
  f.rows.clear();
  f.advance(1000);
  assert.equal(await f.cache.setCachedScan('SMALL', result, { startedAt: NOW - 500 }), false);
  assert.equal(await f.cache.getCachedScan('SMALL'), null);
  assert.equal(f.rows.size, 0); assert.equal(f.markers.size, 1);
});

test('invalidation after a marker read still suppresses a late successful publication', async () => {
  let invalidateDuringWrite = false;
  const f = fixture({ beforePut: ({ markers, key, payload, makeRow }) => {
    if (payload.status === 'ready' && invalidateDuringWrite) markers.set(key, makeRow({ schema: 2, status: 'invalidated', ticker: 'SMALL', invalidatedAt: new Date(NOW).toISOString() }, 25 * 3600));
  } });
  invalidateDuringWrite = true;
  assert.equal(await f.cache.setCachedScan('SMALL', result, { startedAt: NOW - 1000 }), true);
  assert.equal(await f.cache.getCachedScan('SMALL'), null);
  f.advance(25 * 3600000);
  assert.equal(await f.cache.getCachedScan('SMALL'), null);
});

test('overlapping invalidations cannot replace a newer marker with the delayed older request', async () => {
  let entered, resume;
  const waiting = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  const f = fixture({ beforePut: async ({ payload }) => {
    if (payload.status === 'invalidated' && Date.parse(payload.invalidatedAt) === NOW) {
      entered(); await released;
    }
  } });
  const older = assert.rejects(f.cache.invalidateScan('SMALL'), /invalidation could not be confirmed/);
  await waiting;
  f.advance(1000);
  await f.cache.invalidateScan('SMALL');
  f.rows.set('SMALL:SCAN', f.makeRow({ schema: 2, status: 'ready', ticker: 'SMALL',
    scannedAt: new Date(NOW + 1000).toISOString(), startedAt: new Date(NOW + 500).toISOString(), result }));
  resume(); await older;
  assert.equal(Date.parse(f.markers.get('SMALL:SCAN').payload.invalidatedAt), NOW + 1000);
  assert.equal(await f.cache.getCachedScan('SMALL'), null);
  assert.equal(await f.cache.setCachedScan('SMALL', result, { startedAt: NOW + 500 }), false);
  assert.ok(f.writes.every(write => write.options.ifHash === 'absent'));
});

test('an already acknowledged equal invalidation is not rewritten or renewed', async () => {
  const f = fixture();
  await f.cache.invalidateScan('SMALL');
  const first = f.markers.get('SMALL:SCAN');
  await f.cache.invalidateScan('SMALL');
  assert.equal(f.writes.length, 1);
  assert.equal(f.markers.get('SMALL:SCAN'), first);
  f.advance(1000);
  await f.cache.invalidateScan('SMALL');
  assert.equal(f.writes.at(-1).options.ifHash, first.rawSha256);
  assert.equal(Date.parse(f.markers.get('SMALL:SCAN').payload.invalidatedAt), NOW + 1000);
});

test('invalidation marker read failure refuses an otherwise valid cache hit or new write', async () => {
  const f = fixture({ readFailure: type => type === SCANNER_INVALIDATION_NAMESPACE });
  f.rows.set('SMALL:SCAN', f.makeRow({ schema: 2, status: 'ready', ticker: 'SMALL', scannedAt: new Date(NOW).toISOString(), startedAt: new Date(NOW - 1000).toISOString(), result }));
  assert.equal(await f.cache.getCachedScan('SMALL'), null);
  assert.equal(await f.cache.setCachedScan('SMALL', result, { startedAt: NOW }), false);
  assert.equal(f.writes.length, 0);
});

test('failed writes are not acknowledged and a failed invalidation is reported', async () => {
  const f = fixture({ putFailure: true });
  assert.equal(await f.cache.setCachedScan('SMALL', result), false);
  await assert.rejects(f.cache.invalidateScan('SMALL'), /invalidation could not be confirmed/);
  assert.equal(f.cache.memoryStats().entries, 0);
});

test('production failures and disabled mode never return or refill a local fallback', async () => {
  const env = { VERCEL_ENV: 'preview' }, f = fixture({ env, readFailure: true });
  assert.equal(await f.cache.setCachedScan('SMALL', result), true);
  assert.ok(await f.cache.getCachedScan('SMALL'));
  env.VERCEL_ENV = 'production';
  assert.equal(await f.cache.getCachedScan('SMALL'), null);
  assert.equal(await f.cache.setCachedScan('SMALL', result), false);
  env.EDGAR_DISPOSABLE_CACHE_MODE = 'off';
  assert.equal(await f.cache.getCachedScan('SMALL'), null);
  assert.equal(await f.cache.setCachedScan('SMALL', result), false);
  assert.equal(await f.cache.getBackendType(), 'disabled');
  await assert.rejects(f.cache.invalidateScan('SMALL'), /invalidation could not be confirmed/);
  assert.equal(f.writes.length, 0);
});

test('local scan memory enforces entry, aggregate byte and TTL bounds', async () => {
  const f = fixture({ env: { VERCEL_ENV: 'preview' } });
  for (let i = 0; i < 20; i++) await f.cache.setCachedScan(`C${i}`, { ticker: `C${i}`, text: 'x'.repeat(600000) });
  const stats = f.cache.memoryStats();
  assert.ok(stats.entries <= stats.limits.entries);
  assert.ok(stats.bytes <= stats.limits.bytes);
  assert.equal(await f.cache.getCachedScan('C0'), null);
  assert.equal(await f.cache.setCachedScan('LARGE', { text: 'x'.repeat(1024 * 1024) }), false);
  f.advance(86400000);
  assert.deepEqual(f.cache.memoryStats(), { entries: 0, bytes: 0, limits: stats.limits });
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});

test('local cached values are isolated from later caller mutation and invalidation', async () => {
  const f = fixture({ env: {} });
  await f.cache.setCachedScan('SMALL', result);
  const first = await f.cache.getCachedScan('SMALL'); first.result.matches.length = 0;
  assert.equal((await f.cache.getCachedScan('SMALL')).result.matches.length, 1);
  await f.cache.invalidateScan('SMALL');
  assert.equal(await f.cache.getCachedScan('SMALL'), null);
  assert.equal(await f.cache.setCachedScan('SMALL', result), false);
});

test('invalid identities, cross-company results and oversized scans are rejected before storage', async () => {
  const f = fixture();
  assert.equal(await f.cache.setCachedScan('SMALL', { ...result, ticker: 'OTHER' }), false);
  assert.equal(await f.cache.setCachedScan('invalid/path', result), false);
  assert.equal(await f.cache.setCachedDisclosureScan('SMALL', '', result), false);
  assert.equal(await f.cache.setCachedDisclosureScan('SMALL', 'x'.repeat(8193), result), false);
  assert.equal(await f.cache.setCachedScan('SMALL', { text: 'x'.repeat(4 * 1024 * 1024) }), false);
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});
