import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createDisposableCache, disposableCacheEnabled, disposableCachePolicy } from '../src/utils/disposableCache.js';
import { MARKET_VERSION } from '../src/utils/marketResearch.js';
import { MARKET_OVERVIEW_VERSION } from '../src/utils/marketOverview.js';
import { ANALYSIS_VERSION } from '../src/utils/analysisVersion.js';
import { COMPARE_VERSION } from '../src/utils/compareResearch.js';
import { RISK_VERSION } from '../src/utils/riskWorkspace.js';
import { CHANGE_VERSION } from '../src/utils/filingChanges.js';
import { QUANT_COVERAGE_VERSION } from '../src/utils/quantGroups.js';

const NOW = Date.parse('2026-09-13T18:00:00Z');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cik = '0000320193', accession = '0000320193-26-000001';
function record(id, payload, patch = {}) {
  const bytes = Buffer.from(JSON.stringify(payload)), gzip = gzipSync(bytes);
  return { id: id.toUpperCase(), gzipBase64: gzip.toString('base64'), rawSha256: hash(bytes), gzipSha256: hash(gzip), rawBytes: bytes.length,
    storedBytes: gzip.length, writtenAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString(), ...patch };
}
function setup({ response = () => [record('AAPL', { value: 1 })], env, ...options } = {}) {
  const calls = [];
  return { calls, cache: createDisposableCache({ env: env || { VERCEL_ENV: 'production' }, now: () => NOW, identityTokenImpl: async () => 'fixture.identity.token',
    fetchImpl: async (url, options) => { const params = JSON.parse(options.body); calls.push({ url, options, params }); return response(params, calls.length); },
    ...options,
  }) };
}

test('every reviewed live key builder selects the intended disposable family', () => {
  const rows = [
    [MARKET_VERSION, 'atlas', 'snapshot'], [MARKET_VERSION, 'observations', 'history'], [MARKET_OVERVIEW_VERSION, 'atlas', 'snapshot'],
    [`${MARKET_VERSION}:company:production`, 'AAPL', 'checkpoint'], ['market-v2', 'atlas', 'snapshot'],
    ['quant-atlas-v2:production', 'atlas-last-good', 'snapshot'], ['quant-atlas-v1', 'atlas', 'snapshot'],
    ['edgar.fundamental-universe.v2:production', 'quarter-last-good', 'snapshot'],
    [`${QUANT_COVERAGE_VERSION}:production`, 'membership', 'reference'], [`${QUANT_COVERAGE_VERSION}:production`, 'batch-12', 'checkpoint'],
    ['quant-coverage-v1', 'membership', 'reference'], ['quant-company-v1', cik, 'checkpoint'],
    ['quant-company-v2:production', cik, 'checkpoint'], ['quant-company-v2:production:attempts', cik, 'checkpoint'],
    ['sec-directory-v1', 'operating', 'reference'], ['sec-directory-v1', 'funds', 'reference'], ['submissions-cik', cik, 'research'],
    ['research-sec-v1', `/submissions/CIK${cik}.json`, 'research'], ['research-sec-v1', `/api/xbrl/companyfacts/CIK${cik}.json`, 'research'],
    ['research-sec-v1', `/submissions/CIK${cik}-submissions-001.json`, 'document'],
    ['filings-submissions-v1', `CIK${cik}.json`, 'research'], ['filings-submissions-v1', `CIK${cik}-submissions-001.json`, 'document'],
    ['analysis-research', `${ANALYSIS_VERSION}:BRK-B:annual:`, 'research'], ['compare-research', `${COMPARE_VERSION}:AAPL:quarter:2026-06-30`, 'research'],
    ['portfolio-company-v3-evidence-continuity', `portfolio-company-v3-evidence-continuity:${COMPARE_VERSION}:${ANALYSIS_VERSION}:${cik}:ttm`, 'research'],
    ['holders-v3', 'AAPL', 'document'], [RISK_VERSION, 'AAPL', 'research'], [`${RISK_VERSION}-scan`, accession, 'document'],
    ['filings-reader-text-v2', `${cik}:${accession}:aapl-20251231.htm`, 'document'], ['disclosure-text-v1', `${cik}:${accession}:aapl-20251231.htm`, 'document'],
    ['disclosure-history-v1', `${cik}:2025-01-01`, 'research'], ['disclosure-scan-v1', 'a'.repeat(64), 'research'],
    ['filing-changes', `${CHANGE_VERSION}:${cik}:${accession}:${accession}`, 'document'],
    ['edgar.company-exposure-sources.v1:production', 'AAPL:latest', 'research'], ['edgar.company-cftc-context.v1:production', 'AAPL:2026-01-01', 'research'],
    ['edgar.cftc-fcm.v1:production', 'latest', 'history'], ['fund-research-v1', 'IVV:latest', 'research'],
    ['fund-research-v1', `IVV:${accession}:${'a'.repeat(16)}:15`, 'research'], ['global-fund-discovery-v1', `search:${'a'.repeat(24)}`, 'research'],
    ['edgar.cftc-positioning.v1:production', 'markets:tff:latest', 'history'], ['edgar.cftc-positioning.v1:production', 'markets-last-good:disaggregated:2026-09-08', 'history'],
    ['edgar.cftc-positioning.v1:production', 'raw-history:tff:13874A:2026-09-08', 'cftc-history'],
    ['edgar.cftc-positioning.v1:production', 'history-last-good:tff:13874A:dealer:2026-09-08:5y', 'cftc-history'],
    ['edgar.cftc-positioning.v1:production', 'refresh-checkpoint', 'checkpoint'],
  ];
  for (const [type, id, family] of rows) {
    const policy = disposableCachePolicy(type, id);
    assert.equal(policy?.family, family, `${type}/${id}`);
    assert.equal(policy.id, id.toUpperCase());
    assert.deepEqual(disposableCachePolicy(type, id.toUpperCase()), policy);
  }
});

test('policy excludes coordination, arbitrary URLs, unknown and preview namespaces without a 500 company restriction', () => {
  for (const [type, id] of [
    ['quant-atlas-v2:production:chunks', 'atlas:123:0'], ['market-research-v3:company:preview-123', 'AAPL'],
    ['sec-directory-v1', 'https://attacker.example'], ['research-sec-v1', '/submissions/CIK0000000000.json'],
    ['research-sec-v1', '/submissions/CIK0000320193.json?next=evil'], ['research-sec-v1', 'https://data.sec.gov/submissions/CIK0000320193.json'],
    ['submissions-cik', '320193'], ['unknown', 'value'], ['rate-limit', 'AAPL'], ['auth', 'user'],
    ['edgar.cftc-positioning.v1:production', 'refresh'], ['edgar.cftc-positioning.v1:production', 'load:markets:tff:latest'],
    ['market-research-v3', 'lease:atlas'], ['quant-company-v2:production', `${cik}:generation`],
  ]) assert.equal(disposableCachePolicy(type, id), null, `${type}/${id}`);
  assert.equal(disposableCachePolicy('research-sec-v1', '/submissions/CIK0000012345.json').sourceCik, '0000012345');
  assert.equal(disposableCachePolicy('analysis-research', `${ANALYSIS_VERSION}:SMALL:annual:`).family, 'research');
});

test('filing text cache admits bounded manifest-relative nested documents without traversal or URL suffixes', () => {
  const prefix = `${cik}:${accession}:`;
  for (const [type, path] of [
    ['filings-reader-text-v2', 'xslF345X05/ownership.xml'],
    ['filings-reader-text-v2', 'reports/exhibits/annual-report.htm'],
    ['disclosure-text-v1', 'reports/annual-report.html'],
    ['disclosure-text-v1', 'reports/annual-report.txt'],
    ['filings-reader-text-v2', `${'a'.repeat(236)}.xml`],
  ]) {
    const policy = disposableCachePolicy(type, prefix + path);
    assert.equal(policy?.family, 'document', path);
    assert.equal(policy.id, (prefix + path).toUpperCase());
  }
  for (const type of ['filings-reader-text-v2', 'disclosure-text-v1']) {
    for (const path of ['/reports/annual.htm', 'reports//annual.htm', 'reports/../annual.htm', 'reports/./annual.htm',
      'reports/annual..htm', 'reports/annual.htm?download=1', 'reports/annual.htm#section', 'reports\\annual.htm',
      'reports/%2e%2e/annual.htm', 'https://www.sec.gov/annual.htm', 'reports/annual.pdf', `${'a'.repeat(237)}.htm`])
      assert.equal(disposableCachePolicy(type, prefix + path), null, `${type}/${path}`);
  }
  assert.equal(disposableCachePolicy('disclosure-text-v1', prefix + 'xslF345X05/ownership.xml'), null);
});

test('CFTC cache identity supports actual variable-length and plus-sign contract codes', () => {
  const namespace = 'edgar.cftc-positioning.v1:production';
  for (const code of ['12460+', '20974+', '13874+', 'ABC', 'ABCDEFGHIJKL']) {
    assert.equal(disposableCachePolicy(namespace, `raw-history:tff:${code}:2026-09-08`).family, 'cftc-history');
    assert.equal(disposableCachePolicy(namespace, `history-last-good:tff:${code}:leveraged-funds:2026-09-08:1y`).family, 'cftc-history');
  }
  for (const code of ['12', 'A'.repeat(13), '12/345', '12:345', '12?345', '12%345']) {
    assert.equal(disposableCachePolicy(namespace, `raw-history:tff:${code}:2026-09-08`), null);
    assert.equal(disposableCachePolicy(namespace, `history:tff:${code}:dealer:2026-09-08:1y`), null);
  }
  assert.equal(disposableCachePolicy('edgar.cftc-positioning.v1:preview-abc', 'raw-history:tff:12460+:2026-09-08'), null);
});

test('13F cache policy binds managers and filing fingerprints without admitting arbitrary or preview data', () => {
  const snapshot = 'edgar.13f-snapshot.v1:production', filing = 'edgar.13f-filing.v1:production';
  const comparison = 'edgar.13f-comparison.v1:production', fingerprint = 'a'.repeat(64);
  for (const period of ['latest', '2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31']) {
    const policy = disposableCachePolicy(snapshot, `${cik}:${period}`);
    assert.equal(policy.family, 'research'); assert.equal(policy.sourceCik, cik);
    assert.equal(policy.maxTtlSeconds, 25 * 3600);
  }
  const input = disposableCachePolicy(filing, `${cik}:${accession}:${fingerprint}`);
  assert.equal(input.family, 'document'); assert.equal(input.sourceCik, cik);
  assert.equal(input.maxTtlSeconds, 30 * 86400);
  assert.equal(disposableCachePolicy(comparison, fingerprint).family, 'research');
  for (const [type, id] of [
    [snapshot, '0000000000:latest'], [snapshot, '320193:latest'], [snapshot, `${cik}:2026-06-31`],
    [snapshot, `${cik}:2026-02-28`], [snapshot, `${cik}:latest:lease`], [snapshot, `${cik}:2026-06-30?refresh=1`],
    [filing, `${cik}:${accession}:${'g'.repeat(64)}`], [filing, `${cik}:${accession}:${'a'.repeat(63)}`],
    [filing, `${cik}:https://www.sec.gov/${accession}:${fingerprint}`],
    [filing.replace(':production', ':preview-123'), `${cik}:${accession}:${fingerprint}`],
    [snapshot.replace(':production', ':preview-123'), `${cik}:latest`],
    [comparison.replace(':production', ':preview-123'), fingerprint], [comparison, `${fingerprint}:latest`],
  ]) assert.equal(disposableCachePolicy(type, id), null, `${type}/${id}`);
});

test('13F cache writes verify the manager CIK before transmission and preserve freshness metadata', async () => {
  const type = 'edgar.13f-snapshot.v1:production', id = `${cik}:LATEST`;
  const payload = { cik, checkedAt: new Date(NOW - 30000).toISOString(), observedAt: new Date(NOW - 60000).toISOString() };
  const { cache, calls } = setup({ response: params => Response.json({ stored: true, rawSha256: params.p_raw_sha256, expiresAt: new Date(NOW + params.p_ttl_seconds * 1000).toISOString() }) });
  await assert.rejects(cache.cachePut(type, id, { ...payload, cik: '0001350694' }, 90000), /source_identity_mismatch/);
  assert.equal(calls.length, 0);
  assert.equal((await cache.cachePut(type, id, payload, 90000, { ifHash: 'absent' })).stored, true);
  assert.equal(calls[0].params.p_if_hash, 'absent');
  const read = setup({ response: () => Response.json([record(id, payload)]) });
  assert.deepEqual((await read.cache.cacheGet(type, id)).payload, payload);
  assert.equal(read.calls.length, 1);
});

test('market review caches admit bounded proof and exact CIK disclosure keys only in production', () => {
  const proof = 'edgar.13f-issuer-evidence.v1:production';
  const review = 'edgar.13f-market-connections.v1:production';
  const sources = 'edgar.company-exposure-sources.v1:production';
  const id = `${cik}:2026-06-30:${'a'.repeat(64)}`;
  assert.equal(disposableCachePolicy(proof, '037833100').maxRawBytes, 128 * 1024);
  assert.equal(disposableCachePolicy(proof, '037833100').maxTtlSeconds, 21600);
  assert.equal(disposableCachePolicy(review, id).sourceCik, cik);
  assert.equal(disposableCachePolicy(review, id).maxRawBytes, 1024 * 1024);
  assert.equal(disposableCachePolicy(review, id).maxTtlSeconds, 21600);
  for (const suffix of ['latest', '2026-09-16'])
    assert.equal(disposableCachePolicy(sources, `cik:${cik}:${suffix}`).family, 'research');
  for (const [type, key] of [
    [proof, '037833100:latest'], [proof, '03783310'], [proof, '000000000'], [proof, 'https://x'],
    [review, id.replace(cik, '0000000000')], [review, id.replace('06-30', '06-29')], [review, id + ':refresh'],
    [sources, 'cik:320193:latest'], [sources, 'cik:0000000000:latest'], [sources, `cik:${cik}:latest?refresh=1`],
    ['edgar.company-cftc-context.v1:production', `cik:${cik}:latest`],
    [proof.replace('production', 'preview'), '037833100'], [review.replace('production', 'preview'), id],
  ]) assert.equal(disposableCachePolicy(type, key), null, `${type}/${key}`);
});

test('production-only adapter uses fixed OIDC endpoint and never service credentials', async () => {
  for (const env of [{}, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'production', EDGAR_DISPOSABLE_CACHE_MODE: 'off' }]) {
    assert.equal(disposableCacheEnabled(env), false);
    const { cache, calls } = setup({ env }); assert.equal(await cache.cacheGet('holders-v3', 'AAPL'), null); assert.equal(calls.length, 0);
  }
  const { cache, calls } = setup({ env: { VERCEL_ENV: 'production', SUPABASE_URL: 'https://evil.invalid', SUPABASE_SERVICE_ROLE_KEY: 'must-not-leave' }, response: () => Response.json([record('AAPL', { value: 1 })]) });
  assert.equal((await cache.cacheGet('holders-v3', 'aapl')).payload.value, 1);
  assert.match(calls[0].url, /^https:\/\/vvkihuduqqnxqahhbphs\.supabase\.co\/functions\/v1\/edgar-data-gateway\/rest\/v1\/rpc\/edgar_cache_get$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture.identity.token');
  assert.equal(calls[0].options.headers.apikey, undefined); assert.deepEqual(calls[0].params.p_ids, ['AAPL']);
  assert.equal(calls[0].params.p_namespace, 'production'); assert.equal(calls[0].options.redirect, 'error');
});

test('read verifies compressed and raw integrity, identity, expiry and immutable payloads without renewing TTL', async () => {
  const good = record('AAPL', { values: [1, 2] });
  const { cache, calls } = setup({ response: () => Response.json([good]) });
  const value = await cache.cacheGet('holders-v3', 'AAPL');
  assert.equal(value.expiresAt, good.expiresAt); assert.ok(Object.isFrozen(value.payload.values)); assert.equal(calls.length, 1);
  for (const patch of [{ id: 'MSFT' }, { rawSha256: 'b'.repeat(64) }, { gzipSha256: 'b'.repeat(64) }, { rawBytes: good.rawBytes + 1 }, { storedBytes: good.storedBytes + 1 }, { gzipBase64: 'nope' }]) {
    const { cache: broken } = setup({ response: () => Response.json([{ ...good, ...patch }]) });
    await assert.rejects(broken.cacheGet('holders-v3', 'AAPL'), /invalid_record|integrity_mismatch/);
  }
  const { cache: expired } = setup({ response: () => Response.json([record('AAPL', {}, { expiresAt: new Date(NOW - 1).toISOString() })]) });
  assert.equal(await expired.cacheGet('holders-v3', 'AAPL'), null);
});

test('put clamps retention, preserves CAS and validates raw SEC issuer identity', async () => {
  const { cache, calls } = setup({ response: params => Response.json({ stored: true, rawSha256: params.p_raw_sha256, expiresAt: new Date(NOW + params.p_ttl_seconds * 1000).toISOString() }) });
  assert.equal((await cache.cachePut('quant-company-v2:production', cik, { facts: 1 }, 30 * 86400, { ifHash: 'absent' })).stored, true);
  assert.equal(calls[0].params.p_ttl_seconds, 14 * 86400); assert.equal(calls[0].params.p_if_hash, 'absent');
  await cache.cachePut('market-overview-v1', 'atlas', {}, 17.9, { ifHash: 'a'.repeat(64) });
  assert.equal(calls[1].params.p_ttl_seconds, 17); assert.equal(calls[1].params.p_if_hash, 'a'.repeat(64));
  await assert.rejects(cache.cachePut('research-sec-v1', `/submissions/CIK${cik}.json`, { cik: 123 }, 300), /source_identity_mismatch/);
  assert.equal(calls.length, 2);
  await cache.cachePut('research-sec-v1', `/submissions/CIK${cik}.json`, { cik: Number(cik) }, 300);
  assert.equal(calls[2].params.p_id, `/SUBMISSIONS/CIK${cik}.JSON`);
});

test('ordered batches split only on bounded overflow and preserve misses and unknown keys', async () => {
  const { cache, calls } = setup({ response: params => params.p_ids.length > 2 ? Response.json({ code: 'cache_response_too_large' }, { status: 400 })
    : Response.json(params.p_ids.map(id => id === 'MSFT' ? null : record(id, { ticker: id }))) });
  const values = await cache.cacheGetMany('holders-v3', ['AAPL', 'MSFT', 'AMZN', 'NVDA', 'invalid key']);
  assert.deepEqual(values.map(value => value?.payload?.ticker || null), ['AAPL', null, 'AMZN', 'NVDA', null]);
  assert.deepEqual(calls.map(call => call.params.p_ids.length), [4, 2, 2]);
});

test('legacy copies preserve the absolute expiry and reject acknowledgements that extend it', async () => {
  const expiresAt = new Date(NOW + 120000).toISOString();
  const { cache, calls } = setup({ response: params => Response.json({ stored: true, rawSha256: params.p_raw_sha256, expiresAt: params.p_expires_at }) });
  await cache.cachePut('market-overview-v1', 'atlas', { values: [] }, 120, { ifHash: 'absent', expiresAt });
  assert.equal(calls[0].params.p_expires_at, expiresAt);
  assert.equal(calls[0].params.p_if_hash, 'absent');
  assert.deepEqual(await cache.cachePut('market-overview-v1', 'atlas', {}, 1, { expiresAt: new Date(NOW - 1).toISOString() }), { stored: false, reason: 'expired' });
  assert.equal(calls.length, 1);
  const { cache: bad } = setup({ response: params => Response.json({ stored: true, rawSha256: params.p_raw_sha256, expiresAt: new Date(NOW + 121000).toISOString() }) });
  await assert.rejects(bad.cachePut('market-overview-v1', 'atlas', {}, 120, { expiresAt }), /invalid_acknowledgement/);
});

test('cache errors are sanitized, no blind retries, deadlines include identity and caller cancellation', async () => {
  const { cache, calls } = setup({ response: () => Response.json({ code: 'secret_error', message: 'privileged token' }, { status: 500 }) });
  await assert.rejects(cache.cacheGet('holders-v3', 'AAPL'), error => error.code === 'http_500' && !error.message.includes('token')); assert.equal(calls.length, 1);
  const { cache: blocked } = setup({ identityTokenImpl: () => new Promise(() => {}) });
  await assert.rejects(blocked.cacheGet('holders-v3', 'AAPL', { timeoutMs: 10 }), /timeout/);
  await assert.rejects(cache.cacheGet('holders-v3', 'AAPL', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

test('maintenance has only bounded read/claim/save operations and no arming parameter', async () => {
  const owner = '2dd38600-28e1-4b8c-8387-8a350226bdab';
  const { cache, calls } = setup({ response: () => Response.json({ saved: true }) });
  await cache.readCacheMaintenanceState(); await cache.claimCacheMaintenanceState(owner); await cache.saveCacheMaintenanceState(owner, { cursor: '0' });
  assert.deepEqual(calls.map(call => call.params.p_action), ['read', 'claim', 'save']);
  await assert.rejects(cache.saveCacheMaintenanceState(owner, { data: 'x'.repeat(65536) }), /invalid_state/);
  await assert.rejects(cache.claimCacheMaintenanceState('fake'), /invalid_owner/);
  assert.equal(calls.length, 3);
});

test('CFTC family cutover reads a retained raw/history value once without rewriting or extending expiry', async () => {
  const type = 'edgar.cftc-positioning.v1:production';
  for (const id of ['RAW-HISTORY:TFF:12460+:2026-09-08', 'HISTORY:TFF:12460+:DEALER:2026-09-08:5Y']) {
    const retained = record(id, { prepared: true });
    const { cache, calls } = setup({ response: params => Response.json(params.p_family === 'cftc-history' ? [null] : [retained]) });
    const value = await cache.cacheGet(type, id);
    assert.deepEqual(value.payload, { prepared: true }); assert.equal(value.expiresAt, retained.expiresAt); assert.equal(value.rawSha256, retained.rawSha256);
    assert.deepEqual(calls.map(call => call.params.p_family), ['cftc-history', 'history']);
    assert.ok(calls.every(call => call.url.endsWith('edgar_cache_get')));
  }
});

test('CFTC new-family hits and unrelated misses never perform a legacy read', async () => {
  const type = 'edgar.cftc-positioning.v1:production', id = 'RAW-HISTORY:TFF:12460+:2026-09-08';
  const hit = setup({ response: () => Response.json([record(id, { current: true })]) });
  assert.equal((await hit.cache.cacheGet(type, id)).payload.current, true); assert.equal(hit.calls.length, 1);
  for (const [otherType, otherId] of [['holders-v3', 'AAPL'], [type, 'MARKETS:TFF:LATEST']]) {
    const miss = setup({ response: () => Response.json([null]) });
    assert.equal(await miss.cache.cacheGet(otherType, otherId), null); assert.equal(miss.calls.length, 1);
  }
});

test('expired retained CFTC rows remain misses and malformed new rows cannot hide behind old data', async () => {
  const type = 'edgar.cftc-positioning.v1:production', id = 'RAW-HISTORY:TFF:12460+:2026-09-08';
  const expired = setup({ response: params => Response.json(params.p_family === 'cftc-history' ? [null]
    : [record(id, {}, { expiresAt: new Date(NOW - 1).toISOString() })]) });
  assert.equal(await expired.cache.cacheGet(type, id), null); assert.equal(expired.calls.length, 2);
  for (const response of [() => Response.json([record(id, {}, { gzipSha256: 'b'.repeat(64) })]), () => Response.json({ code: 'failed' }, { status: 503 })]) {
    const broken = setup({ response });
    await assert.rejects(broken.cache.cacheGet(type, id)); assert.equal(broken.calls.length, 1);
  }
});

test('legacy CFTC lookup shares the first read deadline and does not add a new timeout window', async () => {
  const type = 'edgar.cftc-positioning.v1:production', id = 'RAW-HISTORY:TFF:12460+:2026-09-08';
  let clock = NOW;
  const fixture = setup({ now: () => clock, response: () => { clock += 101; return Response.json([null]); } });
  await assert.rejects(fixture.cache.cacheGet(type, id, { timeoutMs: 100 }), { code: 'deadline' });
  assert.equal(fixture.calls.length, 1);
});
