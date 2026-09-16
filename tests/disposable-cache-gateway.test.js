import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { createGateway, TRUST } from '../supabase/functions/edgar-data-gateway/handler.js';

const BASE = 'https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway';
const NOW = Date.parse('2026-09-13T18:00:00Z');
const owner = '2dd38600-28e1-4b8c-8387-8a350226bdab';
const claims = overrides => ({ iss: TRUST.issuer, aud: TRUST.audience, sub: TRUST.subject, owner: TRUST.owner, owner_id: TRUST.ownerId,
  project: TRUST.project, project_id: TRUST.projectId, environment: 'production', iat: NOW / 1000 - 10, exp: NOW / 1000 + 7190, ...overrides });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function put(payload = { companies: [] }, overrides = {}) {
  const bytes = Buffer.from(JSON.stringify(payload)), zipped = gzipSync(bytes);
  return { p_namespace: 'production', p_family: 'snapshot', p_type: 'market-overview-v1', p_id: 'ATLAS',
    p_gzip_base64: zipped.toString('base64'), p_raw_sha256: hash(bytes), p_gzip_sha256: hash(zipped),
    p_raw_bytes: bytes.length, p_ttl_seconds: 7 * 86400, p_if_hash: 'absent', ...overrides };
}
function request(name, body, headers = {}) {
  return new Request(`${BASE}/rest/v1/rpc/${name}`, { method: 'POST', headers: { Authorization: 'Bearer fixture.identity.token', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function setup({ response = () => Response.json({ ok: true }), ...options } = {}) {
  const calls = [], environment = { SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co', SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_fixture_stays_inside_function' }) };
  const gateway = createGateway({ now: () => NOW, verifyToken: async () => claims(), env: key => environment[key],
    fetchImpl: async (url, init) => { calls.push({ url, init, params: JSON.parse(init.body) }); return response(url, init); }, ...options });
  return { gateway, calls };
}

test('cache gateway permits validated arbitrary SEC CIKs without broadening canonical dataset admission', async () => {
  const { gateway, calls } = setup();
  const c = '0000012345';
  const read = { p_family: 'research', p_type: 'research-sec-v1', p_ids: [`/API/XBRL/COMPANYFACTS/CIK${c}.JSON`] };
  assert.equal((await gateway(request('edgar_cache_get', read))).status, 200);
  const body = put({ cik: 12345, facts: {} }, { p_family: 'research', p_type: 'research-sec-v1', p_id: read.p_ids[0], p_ttl_seconds: 90000 });
  assert.equal((await gateway(request('edgar_cache_put', body))).status, 200);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => !call.url.includes('membership_admission')));
  assert.equal(calls[1].params.p_namespace, 'production');
  const wrongIssuer = put({ cik: 320193 }, { ...body, p_gzip_base64: undefined });
  const mismatch = put({ cik: 320193 }, { p_family: 'research', p_type: 'research-sec-v1', p_id: read.p_ids[0], p_ttl_seconds: 300 });
  assert.equal((await gateway(request('edgar_cache_put', mismatch))).status, 422);
  assert.equal((await gateway(request('edgar_cache_put', wrongIssuer))).status, 422);
  assert.equal(calls.length, 2);
});

test('cache key and family policy rejects unknown namespaces, coordination, previews, and malformed batches', async () => {
  const { gateway, calls } = setup();
  const good = { p_family: 'snapshot', p_type: 'market-overview-v1', p_ids: ['ATLAS'] };
  for (const patch of [{ p_family: 'document' }, { p_type: 'unknown' }, { p_ids: ['atlas'] }, { p_ids: ['REFRESH'] }, { p_ids: [] },
    { p_ids: Array(26).fill('ATLAS') }, { p_namespace: 'preview' }, { p_mode: 'purge' }, { p_type: 'quant-atlas-v2:preview-abc' }]) {
    assert.ok((await gateway(request('edgar_cache_get', { ...good, ...patch }))).status >= 400, JSON.stringify(patch));
  }
  assert.equal(calls.length, 0);
  const { gateway: preview, calls: previewCalls } = setup({ verifyToken: async () => claims({ environment: 'preview' }) });
  assert.equal((await preview(request('edgar_cache_get', good))).status, 401); assert.equal(previewCalls.length, 0);
});

test('13F cache gateway preserves manager identity, bounded retention and production isolation', async () => {
  const { gateway, calls } = setup(), cik = '0001350694', fingerprint = 'A'.repeat(64);
  const records = [
    { p_family: 'snapshot', p_type: 'edgar.13f-snapshot.v2:production', p_id: `${cik}:LATEST`, p_ttl_seconds: 7 * 86400 },
    { p_family: 'snapshot', p_type: 'edgar.13f-snapshot.v2:production', p_id: `${cik}:2026-06-30`, p_ttl_seconds: 7 * 86400 },
    { p_family: 'research', p_type: 'edgar.13f-snapshot.v1:production', p_id: `${cik}:2026-06-30`, p_ttl_seconds: 90000 },
    { p_family: 'document', p_type: 'edgar.13f-filing.v1:production', p_id: `${cik}:0001350694-26-000001:${fingerprint}`, p_ttl_seconds: 30 * 86400 },
  ];
  for (const record of records) {
    assert.equal((await gateway(request('edgar_cache_put', put({ cik }, record)))).status, 200);
    assert.equal((await gateway(request('edgar_cache_put', put({ cik: '0000320193' }, record)))).status, 422);
    assert.equal((await gateway(request('edgar_cache_put', put({ cik }, { ...record, p_ttl_seconds: record.p_ttl_seconds + 1 })))).status, 422);
    assert.equal((await gateway(request('edgar_cache_get', { p_family: record.p_family, p_type: record.p_type.replace(':production', ':preview'), p_ids: [record.p_id] }))).status, 403);
  }
  assert.equal(calls.length, 4);
  const comparison = { p_family: 'research', p_type: 'edgar.13f-comparison.v1:production', p_ids: [fingerprint] };
  assert.equal((await gateway(request('edgar_cache_get', comparison))).status, 200);
  const { gateway: preview, calls: previewCalls } = setup({ verifyToken: async () => claims({ environment: 'preview' }) });
  assert.equal((await preview(request('edgar_cache_get', comparison))).status, 401);
  assert.equal(previewCalls.length, 0);
});

test('compact 13F publication bounds do not admit holdings-sized heads or arbitrary variants', async () => {
  const { gateway, calls } = setup();
  const record = { p_family: 'snapshot', p_type: 'edgar.13f-snapshot.v2:production', p_id: '0001350694:LATEST', p_ttl_seconds: 604800 };
  assert.equal((await gateway(request('edgar_cache_put', put({ cik: '0001350694', value: 'x'.repeat(16 * 1024) }, record)))).status, 422);
  for (const p_id of ['0001350694:LATEST:PAGE2', '0001350694:LATEST?sort=value', '0000000000:LATEST', '0001350694:2026-06-29']) {
    assert.equal((await gateway(request('edgar_cache_get', { p_family: record.p_family, p_type: record.p_type, p_ids: [p_id] }))).status, 403);
  }
  assert.equal(calls.length, 0);
});

test('prepared market proof gateway enforces size, TTL, manager identity and exact CIK source keys', async () => {
  const { gateway, calls } = setup(), cik = '0002012383';
  const proof = { p_family: 'research', p_type: 'edgar.13f-issuer-evidence.v1:production', p_id: '037833100', p_ttl_seconds: 21600 };
  const review = { ...proof, p_type: 'edgar.13f-market-connections.v1:production', p_id: `${cik}:2026-06-30:${'A'.repeat(64)}` };
  assert.equal((await gateway(request('edgar_cache_put', put({ cusip: '037833100' }, proof)))).status, 200);
  assert.equal((await gateway(request('edgar_cache_put', put({ cik }, review)))).status, 200);
  assert.equal((await gateway(request('edgar_cache_put', put({ cik: '0000320193' }, review)))).status, 422);
  for (const record of [proof, review]) {
    assert.equal((await gateway(request('edgar_cache_put', put({ cik }, { ...record, p_ttl_seconds: 21601 })))).status, 422);
    assert.equal((await gateway(request('edgar_cache_get', { p_family: record.p_family, p_type: record.p_type.replace('production', 'preview'), p_ids: [record.p_id] }))).status, 403);
  }
  assert.equal((await gateway(request('edgar_cache_put', put({ value: 'x'.repeat(128 * 1024) }, proof)))).status, 422);
  assert.equal((await gateway(request('edgar_cache_put', put({ cik, value: 'x'.repeat(1024 * 1024) }, review)))).status, 422);
  const sources = { p_family: 'research', p_type: 'edgar.company-exposure-sources.v1:production', p_ids: ['CIK:0000320193:LATEST'] };
  assert.equal((await gateway(request('edgar_cache_get', sources))).status, 200);
  assert.equal((await gateway(request('edgar_cache_get', { ...sources, p_ids: ['CIK:0000000000:LATEST'] }))).status, 403);
  assert.equal((await gateway(request('edgar_cache_put', put({ cik: '0000000099' }, {
    p_family: sources.p_family, p_type: sources.p_type, p_id: sources.p_ids[0], p_ttl_seconds: 3600,
  })))).status, 422);
  assert.equal(calls.length, 3);
});

test('cache writes require bounded retention, exact compressed/raw hashes and CAS values', async () => {
  const { gateway, calls } = setup();
  const good = put();
  for (const patch of [{ p_raw_sha256: 'b'.repeat(64) }, { p_gzip_sha256: 'b'.repeat(64) }, { p_raw_bytes: good.p_raw_bytes + 1 },
    { p_ttl_seconds: 7 * 86400 + 1 }, { p_ttl_seconds: 0 }, { p_if_hash: 'arbitrary' }, { p_gzip_base64: 'abcd' },
    { p_expires_at: 'tomorrow' }, { p_raw_bytes: 32 * 1024 * 1024 + 1 }, { p_owner: owner }]) {
    assert.ok((await gateway(request('edgar_cache_put', { ...good, ...patch }))).status >= 400);
  }
  assert.equal(calls.length, 0);
  const cap = new Date(NOW + 300000).toISOString();
  assert.equal((await gateway(request('edgar_cache_put', { ...good, p_if_hash: 'a'.repeat(64), p_expires_at: cap }))).status, 200);
  assert.equal(calls[0].params.p_expires_at, cap);
  assert.equal(calls[0].params.p_if_hash, 'a'.repeat(64));
});

test('prepared demo gateway admits only fixed records and enforces per-record raw limits and issuer identity', async () => {
  const { gateway, calls } = setup();
  const type = 'edgar.portfolio-cftc-prepared.v1:production';
  const base = { p_family: 'checkpoint', p_type: type, p_ttl_seconds: 14 * 86400 };
  assert.equal((await gateway(request('edgar_cache_put', put({ cik: '0000320193', context: {} }, { ...base, p_id: 'CIK0000320193' })))).status, 200);
  assert.equal((await gateway(request('edgar_cache_put', put({ cik: '0000019617' }, { ...base, p_id: 'CIK0000320193' })))).status, 422);
  assert.equal((await gateway(request('edgar_cache_put', put({ cik: '0000000001' }, { ...base, p_id: 'CIK0000000001' })))).status, 403);
  assert.equal((await gateway(request('edgar_cache_put', put({ data: 'x'.repeat(16 * 1024) }, { ...base, p_id: 'DEMO-STATE' })))).status, 422);
  assert.equal((await gateway(request('edgar_cache_put', put({ cik: '0000320193', data: 'x'.repeat(48 * 1024) }, { ...base, p_id: 'CIK0000320193' })))).status, 422);
  assert.equal((await gateway(request('edgar_cache_put', put({ data: 'x'.repeat(2 * 1024 * 1024) }, { ...base, p_id: 'DEMO-CURRENT' })))).status, 422);
  assert.equal(calls.length, 1);
});

test('only cache data RPCs receive 9 MiB transport bounds; decoded bombs and generic enlargement fail', async () => {
  const payload = { data: randomBytes(600000).toString('base64') };
  const { gateway, calls } = setup({ response: () => Response.json(payload) });
  const large = put(payload);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 512 * 1024);
  assert.equal((await gateway(request('edgar_cache_put', large))).status, 200);
  assert.equal((await gateway(request('edgar_cache_get', { p_family: 'snapshot', p_type: 'market-overview-v1', p_ids: ['ATLAS'] }))).status, 200);
  assert.equal((await gateway(request('edgar_store_status', {}))).status, 413);
  assert.equal((await gateway(request('edgar_store_status', payload))).status, 413);
  assert.equal(calls.length, 3);
  const bomb = put({ data: 'x'.repeat(32 * 1024 * 1024) });
  assert.equal((await gateway(request('edgar_cache_put', { ...bomb, p_raw_bytes: 16 }))).status, 413);
  assert.equal(calls.length, 3);
});

test('cache batch overflow is narrowly sanitized for splitting and other upstream messages remain hidden', async () => {
  for (const [error, expected] of [[{ code: '22023', message: 'cache_response_too_large' }, 'cache_response_too_large'],
    [{ code: '22023', message: 'credentials in private diagnostic' }, 'upstream_failure']]) {
    const { gateway } = setup({ response: () => Response.json(error, { status: 400 }) });
    const result = await gateway(request('edgar_cache_get', { p_family: 'snapshot', p_type: 'market-overview-v1', p_ids: ['ATLAS'] }));
    assert.deepEqual(await result.json(), { code: expected });
  }
});

test('maintenance reads and fenced updates cannot arm modes or accept unbounded state', async () => {
  const { gateway, calls } = setup();
  for (const body of [{ p_action: 'read' }, { p_action: 'claim', p_owner: owner }, { p_action: 'save', p_owner: owner, p_state: { cursor: '0' } }])
    assert.equal((await gateway(request('edgar_cache_maintenance', body))).status, 200);
  assert.equal(calls.length, 3);
  for (const body of [{ p_action: 'arm' }, { p_action: 'read', p_owner: owner }, { p_action: 'claim', p_owner: owner, p_mode: 'purge' },
    { p_action: 'claim', p_owner: owner, p_state: {} }, { p_action: 'save', p_state: {} },
    { p_action: 'save', p_owner: owner, p_state: [] }, { p_action: 'save', p_owner: owner, p_state: { data: 'x'.repeat(65536) } }])
    assert.ok((await gateway(request('edgar_cache_maintenance', body))).status >= 400);
  assert.equal(calls.length, 3);
});
