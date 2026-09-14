import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createDisposableCache, disposableCacheFencePolicy, disposableCachePolicy } from '../src/utils/disposableCache.js';
import { createGateway, TRUST } from '../supabase/functions/edgar-data-gateway/handler.js';

const NOW = Date.parse('2026-09-13T18:00:00Z'), owner = '2dd38600-28e1-4b8c-8387-8a350226bdab';
const cftc = 'edgar.cftc-positioning.v1:production';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const claim = (dataset, key, patch = {}) => ({ dataset, key, fenceId: key, owner, generation: '9223372036854775806', expiresAt: new Date(NOW + 120000).toISOString(), ...patch });
const bindings = [
  [cftc, 'markets:tff:latest', 'markets:tff:latest', 'cftc'],
  [cftc, 'markets:tff:latest', 'markets-last-good:tff:latest', 'cftc'],
  [cftc, 'markets:tff:latest', 'raw-history:tff:13874A:2026-09-08', 'cftc'],
  [cftc, 'markets:tff:latest', 'raw-history:tff:ABC+:2026-09-08', 'cftc'],
  [cftc, 'history:tff:13874A:dealer:2026-09-08:5y', 'raw-history:tff:13874A:2026-09-08', 'cftc'],
  ['research-sec-v1', 'sec-documents-v1:CIK0000320193:companyfacts', '/api/xbrl/companyfacts/CIK0000320193.json', 'sec'],
  ['submissions-cik', 'sec-documents-v1:CIK0000320193:submissions', '0000320193', 'sec'],
  ['analysis-research', 'financial-analysis-v1:analysis-v1.4:context-v3:CIK0000320193:annual:latest', 'analysis-v1.4:context-v3:AAPL:annual:', 'financial'],
  ['research-serving-v1', 'research-compare-v1:compare-v2:context-v3:CIK0000320193:annual:latest', 'research-compare-v1:compare-v2:context-v3:CIK0000320193:annual:latest', 'financial'],
  ['research-serving-v1', 'research-portfolio-v1:analysis-v1.4:context-v3:CIK0000002098:ytd:latest', 'research-portfolio-v1:analysis-v1.4:context-v3:CIK0000002098:ytd:latest', 'financial'],
];
test('shared fenced policy binds all existing mirror relationships, including post-publication research pilots', () => {
  for (const [type, key, id, dataset] of bindings) {
    assert.equal(disposableCacheFencePolicy(type, key)?.dataset, dataset, key);
    assert.equal(disposableCacheFencePolicy(type, key, id)?.dataset, dataset, `${key}/${id}`);
    assert.equal(disposableCacheFencePolicy(type, key, id)?.id, id.toUpperCase());
    assert.ok(disposableCachePolicy(type, id));
  }
  assert.equal(disposableCacheFencePolicy(cftc, 'history:tff:ABC+:dealer:2026-09-08:5y', 'raw-history:tff:ABC+:2026-09-08')?.dataset, 'cftc');
  for (const [type, key, id] of [
    [cftc, 'markets:tff:latest', 'markets:disaggregated:latest'],
    [cftc, 'markets:tff:2026-09-08', 'raw-history:tff:13874A:2026-09-01'],
    [cftc, 'history:tff:13874A:dealer:2026-09-08:5y', 'raw-history:tff:111111:2026-09-08'],
    [cftc, 'history:tff:13874A:managed-money:2026-09-08:5y', null],
    [cftc, 'markets:tff:latest', 'refresh-checkpoint'],
    ['research-sec-v1', 'sec-documents-v1:CIK0000320193:submissions', '/submissions/CIK0000789019.json'],
    ['research-sec-v1', 'sec-documents-v1:CIK0000012345:submissions', '/submissions/CIK0000012345.json'],
    ['analysis-research', bindings[7][1], 'analysis-v1.4:context-v3:MSFT:annual:'],
    ['research-serving-v1', 'research-compare-v1:compare-v2:context-v3:CIK0000320193:ytd:latest', null],
    ['research-serving-v1', 'research-compare-v1:analysis-v1.4:context-v3:CIK0000320193:annual:latest', null],
    ['research-serving-v1', 'research-portfolio-v1:analysis-v1.4:context-v3:CIK0000012345:annual:latest', null],
  ]) assert.equal(disposableCacheFencePolicy(type, key, id), null, `${key}/${id}`);
});

function adapter(response) {
  const calls = [];
  const cache = createDisposableCache({ env: { VERCEL_ENV: 'production' }, now: () => NOW, identityTokenImpl: async () => 'fixture.identity.token',
    fetchImpl: async (url, init) => { const params = JSON.parse(init.body); calls.push({ url, params }); return response(url, params); } });
  return { cache, calls };
}
test('adapter sends only canonical binding plus owner/generation and preserves post-publication claim expiry', async () => {
  const { cache, calls } = adapter((url, params) => Response.json(url.endsWith('edgar_reserve_cache_generation') ? true
    : { stored: true, rawSha256: params.p_raw_sha256, expiresAt: new Date(NOW + 3600000).toISOString() }));
  const prepared = claim('cftc', 'markets:tff:latest');
  assert.equal(await cache.cacheReserveGeneration(cftc, prepared.key, prepared), true);
  assert.equal((await cache.cachePutFenced(cftc, 'markets-last-good:tff:latest', { response: {} }, 3600, prepared)).stored, true);
  assert.deepEqual(calls.map(call => call.params.p_claim), [{ generation: prepared.generation, owner }, { generation: prepared.generation, owner }]);
  assert.equal(calls[0].params.p_key, prepared.key); assert.equal(calls[1].params.p_id, 'MARKETS-LAST-GOOD:TFF:LATEST');
  assert.equal(calls[0].params.p_namespace, 'production');
  assert.deepEqual(Object.keys(calls[0].params).sort(), ['p_claim', 'p_dataset', 'p_key', 'p_namespace']);
  for (const patch of [{ dataset: 'sec' }, { key: 'markets:disaggregated:latest' }, { fenceId: 'markets:disaggregated:latest' }, { owner: 'bad' },
    { generation: Number.MAX_SAFE_INTEGER + 1 }, { generation: '9223372036854775808' }, { expiresAt: new Date(NOW - 1).toISOString() },
    { expiresAt: new Date(NOW + 960001).toISOString() }]) {
    await assert.rejects(cache.cacheReserveGeneration(cftc, prepared.key, { ...prepared, ...patch }), /invalid_generation_claim/);
  }
  assert.equal(calls.length, 2);
});

test('fenced adapter preserves stale-generation rejection without any unfenced retry', async () => {
  const { cache, calls } = adapter(() => Response.json({ code: '40001' }, { status: 409 }));
  await assert.rejects(cache.cachePutFenced(cftc, 'markets:tff:latest', {}, 3600, claim('cftc', 'markets:tff:latest')), error => error.code === 'stale_generation');
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('edgar_cache_put_fenced'));
});

function gateway(response = () => Response.json(true)) {
  const calls = [];
  const environment = { SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co', SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_fixture_remains_private' }) };
  return { calls, handler: createGateway({ now: () => NOW, verifyToken: async () => ({ iss: TRUST.issuer, aud: TRUST.audience, sub: TRUST.subject,
    owner: TRUST.owner, owner_id: TRUST.ownerId, project: TRUST.project, project_id: TRUST.projectId, environment: 'production', iat: NOW / 1000 - 10, exp: NOW / 1000 + 7190 }),
    env: key => environment[key], fetchImpl: async (url, init) => { calls.push({ url, params: JSON.parse(init.body) }); return response(url, init); } }) };
}
function rpc(name, body) { return new Request(`https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway/rest/v1/rpc/${name}`,
  { method: 'POST', headers: { Authorization: 'Bearer fixture.identity.token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
function fencedBody(type, key, id, dataset, payload = {}) {
  const bytes = Buffer.from(JSON.stringify(payload)), compressed = gzipSync(bytes);
  return { p_dataset: dataset, p_key: key, p_claim: { owner, generation: '9223372036854775806' },
    p_family: disposableCachePolicy(type, id)?.family, p_type: type, p_id: id.toUpperCase(), p_gzip_base64: compressed.toString('base64'),
    p_raw_sha256: hash(bytes), p_gzip_sha256: hash(compressed), p_raw_bytes: bytes.length, p_ttl_seconds: 3600 };
}
test('gateway reserves only reviewed canonical claims and rejects lease overrides or non-pilot cache reservations', async () => {
  const { handler, calls } = gateway();
  for (const [, key, , dataset] of bindings) {
    const response = await handler(rpc('edgar_reserve_cache_generation', { p_dataset: dataset, p_key: key, p_claim: { owner, generation: '1' } }));
    assert.equal(response.status, 200, key);
  }
  const good = { p_dataset: 'sec', p_key: 'sec-documents-v1:CIK0000320193:submissions', p_claim: { owner, generation: '1' } };
  const count = calls.length;
  for (const patch of [{ p_key: 'sec-documents-v1:CIK0000012345:submissions' }, { p_dataset: 'financial' },
    { p_claim: { ...good.p_claim, expiresAt: new Date(NOW + 900000).toISOString() } }, { p_lease_seconds: 900 }, { p_namespace: 'preview' }]) {
    assert.ok((await handler(rpc('edgar_reserve_cache_generation', { ...good, ...patch }))).status >= 400);
  }
  assert.equal(calls.length, count);
});

test('gateway validates fenced destination binding and payload before SQL, preserving bounded large writes', async () => {
  const { handler, calls } = gateway();
  const payload = { response: randomBytes(600000).toString('base64') };
  const good = fencedBody(cftc, 'markets:tff:latest', 'markets-last-good:tff:latest', 'cftc', payload);
  assert.ok(Buffer.byteLength(JSON.stringify(good)) > 512 * 1024);
  assert.equal((await handler(rpc('edgar_cache_put_fenced', good))).status, 200);
  assert.equal(calls[0].params.p_id, 'MARKETS-LAST-GOOD:TFF:LATEST');
  for (const patch of [{ p_id: 'MARKETS:DISAGGREGATED:LATEST' }, { p_key: 'markets:disaggregated:latest' }, { p_type: 'market-v2' },
    { p_family: 'snapshot' }, { p_gzip_sha256: 'a'.repeat(64) }, { p_raw_sha256: 'b'.repeat(64) }, { p_claim: { owner, generation: '0' } }])
    assert.ok((await handler(rpc('edgar_cache_put_fenced', { ...good, ...patch }))).status >= 400);
  assert.equal(calls.length, 1);
  assert.equal((await handler(rpc('edgar_reserve_cache_generation', { data: 'x'.repeat(512 * 1024) }))).status, 413);
  assert.equal(calls.length, 1);
});

test('market and canonical history claims accept the same bounded plus-code identities', async () => {
  const { handler, calls } = gateway();
  const good = fencedBody(cftc, 'markets:tff:latest', 'raw-history:tff:ABC+:2026-09-08', 'cftc', { family: 'tff', code: 'ABC+' });
  assert.equal((await handler(rpc('edgar_cache_put_fenced', good))).status, 200);
  assert.equal(calls[0].params.p_id, 'RAW-HISTORY:TFF:ABC+:2026-09-08');
  assert.equal((await handler(rpc('edgar_cache_put_fenced', { ...good, p_id: 'RAW-HISTORY:DISAGGREGATED:ABC+:2026-09-08' }))).status, 403);
  assert.equal((await handler(rpc('edgar_reserve_cache_generation', { p_dataset: 'cftc', p_key: 'history:tff:ABC+:dealer:2026-09-08:5y', p_claim: good.p_claim }))).status, 200);
  assert.equal(calls.length, 2);
});
