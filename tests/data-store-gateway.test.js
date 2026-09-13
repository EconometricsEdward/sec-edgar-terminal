import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { assertProductionClaims, createGateway, createJwtVerifier, RPC_PARAMETERS, TRUST } from '../supabase/functions/edgar-data-gateway/handler.js';

const BASE = 'https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway';
const URL = 'https://vvkihuduqqnxqahhbphs.supabase.co';
const TOKEN = 'header.payload.signature';
const NOW = Date.now();
const UUID = 'edca5b13-e35e-4021-ae9d-d2345752ccde';
const HASH = 'a'.repeat(64);
const key = 'sec-documents-v1:CIK0000320193:companyfacts';
const claims = (overrides = {}) => ({ iss: TRUST.issuer, aud: TRUST.audience, sub: TRUST.subject, owner: TRUST.owner, owner_id: TRUST.ownerId, project: TRUST.project, project_id: TRUST.projectId, environment: 'production', iat: Math.floor(NOW / 1000) - 10, nbf: Math.floor(NOW / 1000) - 10, exp: Math.floor(NOW / 1000) + 7190, ...overrides });
const environment = { SUPABASE_URL: URL, SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_this_value_never_leaves_the_function' }) };
function setup(options = {}) {
  const calls = [];
  const handler = createGateway({ verifyToken: async () => claims(), now: () => NOW, env: name => environment[name],
    fetchImpl: async (...args) => { calls.push(args); return Response.json({ ok: true }); }, ...options });
  return { calls, handler };
}
function request(path, body, options = {}) {
  const method = options.method || (body === undefined ? 'GET' : 'POST');
  return new Request(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    ...(body === undefined ? {} : { body: options.raw ? body : JSON.stringify(body) }) });
}
const rpc = (name, body, options) => request(`/rest/v1/rpc/${name}`, body, options);
const path = `production/sec/source/${HASH}.json.gz`;
const storePath = `/storage/v1/object/edgar-durable-private/${path}`;
const downloadPath = `/storage/v1/object/authenticated/edgar-durable-private/${path}`;

test('gateway authenticates before reading body, env, or upstream', async () => {
  let accessed = false;
  const { handler } = setup({ env: () => { accessed = true; throw new Error('secret'); }, fetchImpl: () => { accessed = true; throw new Error('secret'); } });
  const fakeRequest = { headers: new Headers(), get body() { accessed = true; throw new Error('body read'); } };
  const response = await handler(fakeRequest);
  assert.equal(response.status, 401); assert.equal(accessed, false);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('health requires exact production identity and reveals no credentials', async () => {
  const { handler, calls } = setup();
  const response = await handler(request('/health'));
  assert.equal(response.status, 200); assert.equal(calls.length, 0);
  const body = await response.text();
  assert.match(body, /vercel-oidc/); assert.doesNotMatch(body, /sb_secret|SUPABASE|team_|prj_/);
});

test('all identity claims and token lifetime are enforced including optional nbf', async () => {
  const expired = Math.floor(NOW / 1000) - 60;
  const invalid = [{ iss: 'https://oidc.vercel.com/attacker' }, { aud: 'https://attacker.example' }, { sub: 'other' }, { owner: 'other' }, { owner_id: 'other' }, { project: 'other' }, { project_id: 'other' }, { environment: 'preview' }, { environment: 'development' }, { exp: expired }, { iat: Math.floor(NOW / 1000) + 60 }, { exp: Math.floor(NOW / 1000) + 86400 }, { nbf: Math.floor(NOW / 1000) + 60 }, { exp: undefined }, { iat: undefined }];
  for (const patch of invalid) {
    const { handler, calls } = setup({ verifyToken: async () => claims(patch) });
    assert.equal((await handler(request('/health'))).status, 401, JSON.stringify(patch)); assert.equal(calls.length, 0);
  }
  const withoutNbf = claims(); delete withoutNbf.nbf;
  assert.doesNotThrow(() => assertProductionClaims(withoutNbf, NOW));
});

test('cryptographic verifier accepts valid RS256 and rejects forged, wrong audience, expired and HS tokens', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' };
  const verifier = createJwtVerifier(jwtVerify, createLocalJWKSet({ keys: [jwk] }));
  const signed = async (payload) => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
  const valid = await signed(claims());
  assert.equal((await verifier(valid)).project_id, TRUST.projectId);
  const segments = valid.split('.');
  segments[1] = Buffer.from(JSON.stringify(claims({ project_id: 'attacker' }))).toString('base64url');
  await assert.rejects(verifier(segments.join('.')));
  await assert.rejects(verifier(await signed(claims({ aud: 'https://attacker.example' }))));
  await assert.rejects(verifier(await signed(claims({ exp: Math.floor(NOW / 1000) - 60 }))));
  const hs = await new SignJWT(claims()).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
  await assert.rejects(verifier(hs));
});

test('only the frozen 14 RPC names are supported and namespace is forced', async () => {
  assert.equal(Object.keys(RPC_PARAMETERS).length, 14);
  const { handler, calls } = setup();
  assert.equal((await handler(rpc('edgar_get_version', { p_dataset: 'sec', p_key: key }))).status, 200);
  assert.equal(calls[0][0], `${URL}/rest/v1/rpc/edgar_get_version`);
  assert.equal(JSON.parse(calls[0][1].body).p_namespace, 'production');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].headers.apikey, JSON.parse(environment.SUPABASE_SECRET_KEYS).default);
  assert.equal(calls[0][1].headers.Authorization, undefined);
  for (const body of [{ p_namespace: 'rehearsal' }, { target: 'https://attacker.example' }, { p_unexpected: true }]) {
    assert.ok((await handler(rpc('edgar_store_status', body))).status >= 400);
  }
  assert.equal((await handler(rpc('arbitrary_sql', { query: 'drop table' }))).status, 403);
  assert.equal(calls.length, 1);
});

test('gateway rejects queries, method changes, encoded paths and arbitrary services', async () => {
  const { handler, calls } = setup();
  for (const route of ['/health?namespace=rehearsal', '/rest/v1/edgar_dataset_heads', '/rest/v1/rpc/%65dgar_store_status', '/auth/v1/admin/users', '/storage/v1/object/list/edgar-durable-private']) {
    assert.equal((await handler(request(route))).status, 403, route);
  }
  assert.equal((await handler(request('/rest/v1/rpc/edgar_store_status'))).status, 405);
  assert.equal(calls.length, 0);
});

test('hosted function prefix and full local prefix route identically; prefix lookalikes fail closed', async () => {
  const { handler, calls } = setup();
  const invoke = (prefix, path, body) => handler(new Request(`${URL}${prefix}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  for (const prefix of ['/edgar-data-gateway', '/functions/v1/edgar-data-gateway']) {
    assert.equal((await invoke(prefix, '/health')).status, 200);
    assert.equal((await invoke(prefix, '/rest/v1/rpc/edgar_store_status', { p_namespace: 'production' })).status, 200);
    assert.equal((await invoke(prefix, '/rest/v1/rpc/edgar_store_status', { p_namespace: 'rehearsal' })).status, 403);
  }
  for (const prefix of ['/other/edgar-data-gateway', '/edgar-data-gateway-extra', '/functions/v1/other/edgar-data-gateway', '/functions/v1/edgar-data-gateway-extra', '/edgar-data-gateway/edgar-data-gateway', '']) {
    assert.equal((await invoke(prefix, '/health')).status, 403, prefix);
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], `${URL}/rest/v1/rpc/edgar_store_status`);
  assert.equal(calls[1][0], calls[0][0]);
});

test('gateway permits only approved dataset/resource/cohort formats', async () => {
  const { handler, calls } = setup();
  const valid = [
    ['sec', key], ['sec', 'sec-documents-v1:CIK0000002098:submissions'],
    ['financial', 'financial-analysis-v1:analysis-v1.4:context-v3:CIK0000019617:ytd:latest'],
    ['cftc', 'markets:disaggregated:latest'], ['cftc', 'markets:tff:2026-09-08'],
    ['cftc', 'history:tff:098662:asset-manager:2026-09-08:5y'],
  ];
  for (const [dataset, resource] of valid) assert.equal((await handler(rpc('edgar_get_version', { p_dataset: dataset, p_key: resource }))).status, 200, resource);
  const invalid = [ ['other', key], ['sec', 'sec-documents-v1:CIK9999999999:companyfacts'], ['sec', 'financial-cohort-v1'], ['cftc', 'markets:legacy:latest'], ['cftc', 'markets:tff:2026-02-31'], ['cftc', 'history:tff:098662:managed-money:2026-09-08:5y'], ['cftc', 'history:tff:098662:asset-manager:2026-09-08:all'] ];
  for (const [dataset, resource] of invalid) assert.equal((await handler(rpc('edgar_get_version', { p_dataset: dataset, p_key: resource }))).status, 403, resource);
  assert.equal(calls.length, valid.length);
});

test('private object uploads remain immutable and downloads forward only bounded bytes', async () => {
  const compressed = gzipSync('{"ok":true}');
  const { handler, calls } = setup({ fetchImpl: async (...args) => { calls.push(args); return args[1].method === 'GET' ? new Response(compressed, { headers: { 'x-sensitive': 'not-forwarded' } }) : Response.json({ Key: path }); } });
  assert.equal((await handler(request(storePath, compressed, { raw: true, headers: { 'Content-Type': 'application/gzip' } }))).status, 200);
  assert.deepEqual(new Uint8Array(calls[0][1].body), new Uint8Array(compressed));
  assert.equal(calls[0][1].headers['x-upsert'], undefined);
  const response = await handler(request(downloadPath));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), compressed);
  assert.equal(response.headers.get('content-type'), 'application/gzip');
  assert.equal(response.headers.get('x-sensitive'), null);
  assert.equal((await handler(request(storePath, compressed, { raw: true, headers: { 'Content-Type': 'application/gzip', 'x-upsert': 'true' } }))).status, 400);
  assert.equal((await handler(request(storePath, undefined, { method: 'DELETE' }))).status, 405);
  assert.equal((await handler(request(storePath, compressed, { raw: true, method: 'PUT', headers: { 'Content-Type': 'application/gzip' } }))).status, 405);
  assert.equal(calls.length, 2);
});

test('storage scope cannot cross namespace/bucket/dataset or traverse paths', async () => {
  const { handler, calls } = setup();
  for (const route of [downloadPath.replace('production/', 'rehearsal/'), downloadPath.replace('edgar-durable-private/', 'other-bucket/'), downloadPath.replace('/sec/', '/other/'), downloadPath.replace('/source/', '/../../'), downloadPath.replace(HASH, 'f'.repeat(63)), '/storage/v1/object/sign/edgar-durable-private/production/sec/source/a']) {
    assert.ok((await handler(request(route))).status >= 400, route);
  }
  assert.equal(calls.length, 0);
});

function record() {
  return { identityHash: HASH, contentHash: HASH, objectPath: path, rawBytes: 200000, storedBytes: 20000, schemaVersion: '1', payload: null,
    metadata: { fetchedAt: new Date(NOW).toISOString() }, observations: [], source: { objectPath: path, contentHash: HASH, rawBytes: 200000, storedBytes: 20000, url: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json', fetchedAt: new Date(NOW).toISOString(), publishedAt: null, contentType: 'application/json' } };
}
const publish = value => rpc('edgar_publish', { p_dataset: 'sec', p_key: key, p_claim: { generation: '9007199254740993', owner: UUID }, p_record: value, p_promote_good: true });

test('publish validates nested source and snapshot object scope before SQL', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(publish(record()))).status, 200);
  const cases = [
    value => { value.source.objectPath = path.replace('production/', 'rehearsal/'); },
    value => { value.objectPath = path.replace('production/', 'rehearsal/'); },
    value => { value.source.objectPath = path.replace('/sec/', '/financial/'); },
    value => { value.source.objectPath = path.replace('/source/', '/snapshot/'); },
    value => { value.source.url = 'https://attacker.example/file'; },
    value => { value.source.contentHash = 'b'.repeat(64); },
    value => { value.source.storedBytes = 7 * 1024 * 1024; },
  ];
  for (const patch of cases) { const value = record(); patch(value); assert.equal((await handler(publish(value))).status, 422); }
  assert.equal(calls.length, 1);
});

test('compact records and immutable identity revalidations retain supported shapes', async () => {
  const { handler, calls } = setup();
  const metadata = { fetchedAt: new Date(NOW).toISOString() };
  assert.equal((await handler(publish({ identityHash: HASH, metadata }))).status, 200);
  const payload = { ok: true }; const serialized = JSON.stringify(payload);
  const compact = { identityHash: HASH, metadata, contentHash: createHash('sha256').update(serialized).digest('hex'), schemaVersion: '1', payload, rawBytes: serialized.length, storedBytes: serialized.length, source: null, observations: [] };
  assert.equal((await handler(publish(compact))).status, 200);
  const oversized = { ...compact, payload: { text: 'a'.repeat(65536) } };
  assert.equal((await handler(publish(oversized))).status, 422);
  assert.equal(calls.length, 2);
});

test('fenced RPC and job fields are bounded and preserve exact bigint claim strings', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(rpc('edgar_begin_write', { p_dataset: 'sec', p_key: key, p_owner: UUID, p_lease_seconds: 120 }))).status, 200);
  assert.equal((await handler(rpc('edgar_enqueue_job', { p_dataset: 'sec', p_key: 'financial-cohort-v1', p_job_key: 'sec-financial-cohort-v1:2026-09-13', p_checkpoint: { cursor: 0 }, p_max_attempts: 10 }))).status, 200);
  assert.equal((await handler(rpc('edgar_claim_job', { p_dataset: 'sec', p_owner: UUID, p_job_key: null, p_lease_seconds: 300 }))).status, 200);
  const claim = { id: UUID, owner: UUID, generation: '9007199254740993' };
  assert.equal((await handler(rpc('edgar_checkpoint_job', { p_claim: claim, p_checkpoint: { cursor: 2 }, p_lease_seconds: 300 }))).status, 200);
  assert.equal(JSON.parse(calls.at(-1)[1].body).p_claim.generation, '9007199254740993');
  assert.equal((await handler(rpc('edgar_finish_job', { p_claim: claim, p_checkpoint: {}, p_status: 'retry', p_error: 'SEC_COHORT_REFRESH_FAILED', p_delay_seconds: 30 }))).status, 200);
  for (const generation of [null, 0, -1, 1.5, '9223372036854775808']) {
    assert.equal((await handler(rpc('edgar_checkpoint_job', { p_claim: { ...claim, generation }, p_checkpoint: {}, p_lease_seconds: 300 }))).status, 422);
  }
  assert.equal((await handler(rpc('edgar_export_manifests', { p_limit: 100000 }))).status, 422);
  assert.equal((await handler(rpc('edgar_enqueue_job', { p_dataset: 'financial', p_key: 'other', p_job_key: 'other' }))).status, 403);
});

test('oversized input/output and invalid encodings fail with sanitized errors', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(rpc('edgar_store_status', { giant: 'a'.repeat(512 * 1024) }))).status, 413);
  assert.equal((await handler(rpc('edgar_store_status', {}, { headers: { 'Content-Encoding': 'gzip' } }))).status, 400);
  assert.equal((await handler(request(storePath, new Uint8Array(6 * 1024 * 1024 + 1), { raw: true, headers: { 'Content-Type': 'application/gzip' } }))).status, 413);
  assert.equal(calls.length, 0);
  const large = setup({ fetchImpl: async () => new Response('a'.repeat(512 * 1024 + 1)) });
  assert.equal((await large.handler(rpc('edgar_store_status', {}))).status, 413);
  const failed = setup({ fetchImpl: async () => Response.json({ code: 'unexpected', message: environment.SUPABASE_SECRET_KEYS, details: 'database password' }, { status: 500 }) });
  const response = await failed.handler(rpc('edgar_store_status', {}));
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { code: 'upstream_failure' });
});

test('upstream fencing marker survives without leaking messages or response headers', async () => {
  const { handler } = setup({ fetchImpl: async () => Response.json({ code: '40001', message: environment.SUPABASE_SECRET_KEYS }, { status: 400, headers: { 'set-cookie': 'secret' } }) });
  const response = await handler(rpc('edgar_store_status', {}));
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { code: '40001' });
  assert.equal(response.headers.get('set-cookie'), null);
});

test('legacy service keys stay internal and wrong project configuration fails closed', async () => {
  const legacy = 'legacy.header.signature_long_enough';
  const { handler, calls } = setup({ env: name => ({ SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: legacy })[name] });
  assert.equal((await handler(rpc('edgar_store_status', {}))).status, 200);
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${legacy}`);
  const wrong = setup({ env: name => ({ ...environment, SUPABASE_URL: 'https://other.supabase.co' })[name] });
  assert.equal((await wrong.handler(request('/health'))).status, 503);
});

test('slow request streams are cancelled within the gateway deadline', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull() {}, cancel() { cancelled = true; } });
  const { handler, calls } = setup({ timeoutMs: 20 });
  const incoming = new Request(`${BASE}/rest/v1/rpc/edgar_store_status`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body, duplex: 'half' });
  assert.equal((await handler(incoming)).status, 504); assert.equal(cancelled, true); assert.equal(calls.length, 0);
});
