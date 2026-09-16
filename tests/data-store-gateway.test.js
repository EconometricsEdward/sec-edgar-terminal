import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { assertProductionClaims, createGateway, createJwtVerifier, RPC_PARAMETERS, TRUST } from '../supabase/functions/edgar-data-gateway/handler.js';
import { APPROVED_SEC_CIKS, COVERAGE_MEMBERSHIP_ID, SUPPORTING_SOURCE_CIKS } from '../supabase/functions/edgar-data-gateway/coverage.js';
import { SEC_COVERAGE_COHORT, SEC_COVERAGE_MEMBERSHIP_ID, SEC_COVERAGE_UNIVERSE } from '../src/utils/secCoverageUniverse.js';
import { prepareDisclosureIndexDocument } from '../src/utils/disclosurePassageIndex.js';

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
    fetchImpl: async (...args) => { calls.push(args); return Response.json(args[0].endsWith('/edgar_membership_admission') ? { allowedCiks: [], sourceOnlyCiks: [] } : { ok: true }); }, ...options });
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

test('only the explicitly reviewed RPC names are supported and namespace is forced', async () => {
  assert.equal(Object.keys(RPC_PARAMETERS).length, 49);
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

test('disclosure index accepts bounded public filing records and rejects widened RPC/source/payload scope', async () => {
  const today = new Date(NOW).toISOString().slice(0, 10);
  const prepared = prepareDisclosureIndexDocument({ cik: '0000320193', ticker: 'AAPL', companyName: 'Apple Inc.',
    filing: { accession: '0000320193-26-000001', primaryDoc: 'aapl.htm', form: '10-K', filingDate: today },
    text: 'The company reported a material weakness and implemented remediation. No customer information was compromised during the reporting period.',
    sourceRetrievedAt: new Date(NOW).toISOString() });
  const { handler, calls } = setup();
  const body = { p_document: prepared.document, p_passages: prepared.passages };
  assert.equal((await handler(rpc('edgar_disclosure_replace', body))).status, 200);
  for (const invalid of [
    { ...body, p_document: { ...prepared.document, sourceUrl: 'https://attacker.example' } },
    { ...body, p_document: { ...prepared.document, primaryDoc: '../secret.htm' } },
    { ...body, p_document: { ...prepared.document, parserVersion: 999 } },
    { ...body, p_passages: Array.from({ length: 181 }, () => prepared.passages[0]) },
    { ...body, p_sql: 'select 1' },
  ]) assert.equal((await handler(rpc('edgar_disclosure_replace', invalid))).status, 422);
  const search = { p_terms: ['material weakness'], p_start: '2024-01-01', p_end: today, p_forms: ['10-K'], p_ciks: [], p_tickers: [], p_section: 'all', p_offset: 0, p_limit: 120, p_parser_version: 1 };
  assert.equal((await handler(rpc('edgar_disclosure_search', search))).status, 200);
  assert.equal((await handler(rpc('edgar_disclosure_search', { ...search, p_limit: 10000 }))).status, 422);
  assert.equal((await handler(rpc('edgar_disclosure_search', { ...search, p_namespace: 'preview' }))).status, 403);
  assert.equal(calls.length, 2, 'rejected records never reach the database');
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
    ['financial', 'research-compare-v1:compare-v2:context-v3:CIK0000320193:ttm:latest'],
    ['financial', 'research-portfolio-v1:analysis-v1.4:context-v3:CIK0000320193:ytd:latest'],
    ['financial', 'research-market-overview-v1:latest'],
    ['financial', 'research-company-v1:CIK0000320193'],
    ['cftc', 'markets:disaggregated:latest'], ['cftc', 'markets:tff:2026-09-08'],
    ['cftc', 'history:tff:098662:asset-manager:2026-09-08:5y'],
  ];
  for (const [dataset, resource] of valid) assert.equal((await handler(rpc('edgar_get_version', { p_dataset: dataset, p_key: resource }))).status, 200, resource);
  const invalid = [ ['other', key], ['sec', 'sec-documents-v1:CIK0000000000:companyfacts'], ['sec', 'financial-cohort-v1'], ['cftc', 'markets:legacy:latest'], ['cftc', 'markets:tff:2026-02-31'], ['cftc', 'history:tff:098662:managed-money:2026-09-08:5y'], ['cftc', 'history:tff:098662:asset-manager:2026-09-08:all'] ];
  for (const [dataset, resource] of invalid) assert.equal((await handler(rpc('edgar_get_version', { p_dataset: dataset, p_key: resource }))).status, 403, resource);
  assert.equal(calls.length, valid.length);
});

test('gateway eligibility exactly matches the dated 500 issuer universe plus retained ACU', async () => {
  const expected = [...new Set([...SEC_COVERAGE_COHORT.map(row => row.cik), '0000002098'])].sort();
  assert.deepEqual(APPROVED_SEC_CIKS, expected);
  assert.equal(APPROVED_SEC_CIKS.length, 501);
  assert.equal(COVERAGE_MEMBERSHIP_ID, SEC_COVERAGE_MEMBERSHIP_ID);
  const { handler, calls } = setup();
  for (const cik of APPROVED_SEC_CIKS) {
    assert.equal((await handler(rpc('edgar_get_version', { p_dataset: 'sec', p_key: `sec-documents-v1:CIK${cik}:submissions` }))).status, 200);
  }
  assert.equal((await handler(rpc('edgar_get_version', { p_dataset: 'financial', p_key: 'research-compare-v1:compare-v2:context-v3:CIK9999999999:annual:latest' }))).status, 403);
  assert.equal((await handler(rpc('edgar_get_version', { p_dataset: 'financial', p_key: 'research-portfolio-v1:analysis-v1.4:context-v3:CIK0000320193:annual:2020-01-01' }))).status, 403);
  assert.equal(calls.length, 502);
  assert.equal(calls.at(-1)[0], `${URL}/rest/v1/rpc/edgar_membership_admission`);
});

test('historical XOM continuity access is confined to its two SEC source documents', async () => {
  assert.deepEqual(SUPPORTING_SOURCE_CIKS,['0000034088']);
  const { handler, calls } = setup();
  for (const resource of ['submissions','companyfacts']) {
    assert.equal((await handler(rpc('edgar_get_version',{p_dataset:'sec',p_key:`sec-documents-v1:CIK0000034088:${resource}`}))).status,200);
  }
  for (const key of ['financial-analysis-v1:analysis-v1.4:context-v3:CIK0000034088:annual:latest', 'research-portfolio-v1:analysis-v1.4:context-v3:CIK0000034088:annual:latest', 'research-company-v1:CIK0000034088']) {
    assert.equal((await handler(rpc('edgar_get_version',{p_dataset:'financial',p_key:key}))).status,403);
  }
  assert.equal(calls.length,2);
});

test('coverage enqueue batches one cycle with bounded unique shards and immutable version format', async () => {
  const { handler, calls } = setup();
  const params = { p_cycle:'2026-09-13', p_version:'a'.repeat(16), p_shards:[0,31] };
  assert.equal((await handler(rpc('edgar_enqueue_coverage_jobs',params))).status,200);
  assert.equal((await handler(rpc('edgar_enqueue_coverage_jobs',{...params,p_shards:null}))).status,200);
  for (const patch of [{p_cycle:'2026-02-31'},{p_version:'a'.repeat(64)},{p_shards:[1,1]},{p_shards:[32]},{p_shards:[]}]) {
    assert.equal((await handler(rpc('edgar_enqueue_coverage_jobs',{...params,...patch}))).status,422);
  }
  assert.equal(calls.length,2);
});

test('schedule verification RPC accepts only narrow signature fields and the forced namespace', async()=>{
  const {handler,calls}=setup();
  const params={p_timestamp:1789300800,p_nonce:'38621c4e-3538-4fbb-83c4-c6fb10799020',p_signature:HASH};
  assert.equal((await handler(rpc('edgar_authorize_coverage_schedule',params))).status,200);
  for(const patch of [{p_timestamp:'1789300800'},{p_nonce:'invalid'},{p_signature:'f'.repeat(65)},
    {secret_name:'another-secret'},{p_namespace:'rehearsal'},{url:'https://attacker.example'}]) {
    assert.ok((await handler(rpc('edgar_authorize_coverage_schedule',{...params,...patch}))).status>=400);
  }
  assert.equal(calls.length,1); assert.equal(JSON.parse(calls[0][1].body).p_namespace,'production');
});

test('manifest and compact batch gates enforce every key, exact parameters, and independent caps', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(rpc('edgar_get_manifests', { p_dataset: 'sec', p_keys: Array(100).fill(key) }))).status, 200);
  assert.equal((await handler(rpc('edgar_get_compact_batch', { p_dataset: 'sec', p_keys: Array(5).fill(key) }))).status, 200);
  for (const [name, keys] of [['edgar_get_manifests', Array(101).fill(key)], ['edgar_get_compact_batch', Array(6).fill(key)],
    ['edgar_get_manifests', [key, 'sec-documents-v1:CIK0000000000:companyfacts']], ['edgar_get_manifests', null]]) {
    assert.equal((await handler(rpc(name, { p_dataset: 'sec', p_keys: keys }))).status, 403);
  }
  assert.equal((await handler(rpc('edgar_get_manifests', { p_dataset: 'sec', p_keys: [key], include_payload: true }))).status, 422);
  assert.equal(calls.length, 2);
});

test('coverage jobs are limited to reviewed prefixes, shard bounds and fenced yields', async () => {
  const { handler, calls } = setup();
  const body = { p_dataset: 'sec', p_key: 'sec-coverage-v1:shard:31', p_job_key: `sec-coverage-v1:2026-09-13:31:${HASH}`, p_checkpoint: { cursor: 0 }, p_max_attempts: 3 };
  assert.equal((await handler(rpc('edgar_enqueue_job', body))).status, 200);
  for (const patch of [{ p_key: 'sec-coverage-v1:shard:32' }, { p_job_key: `sec-coverage-v1:2026-02-31:31:${HASH}` }, { p_job_key: `sec-coverage-v1:2026-09-13:99:${HASH}` }]) {
    assert.equal((await handler(rpc('edgar_enqueue_job', { ...body, ...patch }))).status, patch.p_key ? 403 : 422);
  }
  assert.equal((await handler(rpc('edgar_claim_job_prefix', { p_dataset: 'sec', p_owner: UUID, p_prefix: 'sec-coverage-v1:', p_lease_seconds: 270 }))).status, 200);
  assert.equal((await handler(rpc('edgar_claim_job_prefix', { p_dataset: 'sec', p_owner: UUID, p_prefix: 'sec-', p_lease_seconds: 270 }))).status, 403);
  assert.equal((await handler(rpc('edgar_claim_job_prefix', { p_dataset: 'cftc', p_owner: UUID, p_prefix: 'sec-coverage-v1:' }))).status, 403);
  const claim = { id: UUID, owner: UUID, generation: 1 };
  assert.equal((await handler(rpc('edgar_yield_job', { p_claim: claim, p_checkpoint: { cursor: 4 }, p_delay_seconds: 1 }))).status, 200);
  assert.equal((await handler(rpc('edgar_yield_job', { p_claim: claim, p_checkpoint: {}, p_delay_seconds: 0 }))).status, 422);
  assert.equal((await handler(rpc('edgar_yield_job', { p_claim: claim, p_checkpoint: { payload: 'x'.repeat(16384) }, p_delay_seconds: 1 }))).status, 413);
  assert.equal(calls.length, 3);
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

test('new membership admits exact SEC and financial families through one private lookup per request', async () => {
  const cik = '0001999999';
  const calls = [];
  const { handler } = setup({ fetchImpl: async (...args) => {
    calls.push(args);
    return Response.json(args[0].endsWith('/edgar_membership_admission') ? { allowedCiks: [cik], sourceOnlyCiks: [] } : { ok: true });
  } });
  const resources = [
    ['sec', `sec-documents-v1:CIK${cik}:companyfacts`],
    ['financial', `financial-analysis-v1:analysis-v1.4:context-v3:CIK${cik}:ytd:latest`],
    ['financial', `research-compare-v1:compare-v2:context-v3:CIK${cik}:annual:latest`],
    ['financial', `research-portfolio-v1:analysis-v1.4:context-v3:CIK${cik}:ttm:latest`],
    ['financial', `research-company-v1:CIK${cik}`],
  ];
  for (const [p_dataset, p_key] of resources) assert.equal((await handler(rpc('edgar_get_version', { p_dataset, p_key }))).status, 200);
  assert.equal(calls.length, resources.length * 2);
  for (let index = 0; index < calls.length; index += 2) {
    assert.equal(calls[index][0], `${URL}/rest/v1/rpc/edgar_membership_admission`);
    assert.deepEqual(JSON.parse(calls[index][1].body), { p_namespace: 'production', p_ciks: [cik] });
    assert.equal(calls[index][1].headers.apikey, JSON.parse(environment.SUPABASE_SECRET_KEYS).default);
    assert.equal(calls[index][1].redirect, 'error');
    assert.equal(calls[index + 1][0], `${URL}/rest/v1/rpc/edgar_get_version`);
  }
  assert.equal((await handler(rpc('edgar_membership_admission', { p_ciks: [cik] }))).status, 403);
  assert.equal(calls.length, resources.length * 2, 'internal admission cannot be invoked as a caller-selected RPC');
});

test('batch admission deduplicates unknown issuers and denies the entire batch if any is absent', async () => {
  const first = '0001999999', second = '0001888888';
  const calls = []; let admitted = [first, second];
  const { handler } = setup({ fetchImpl: async (...args) => {
    calls.push(args);
    return Response.json(args[0].endsWith('/edgar_membership_admission') ? { allowedCiks: admitted, sourceOnlyCiks: [] } : { ok: true });
  } });
  const params = { p_dataset: 'sec', p_keys: [key, `sec-documents-v1:CIK${first}:companyfacts`, `sec-documents-v1:CIK${first}:submissions`, `sec-documents-v1:CIK${second}:submissions`] };
  assert.equal((await handler(rpc('edgar_get_manifests', params))).status, 200);
  assert.deepEqual(JSON.parse(calls[0][1].body).p_ciks, [first, second]);
  assert.equal(calls.length, 2);
  admitted = [first];
  assert.equal((await handler(rpc('edgar_get_manifests', params))).status, 403);
  assert.equal(calls.length, 3, 'recheck uses no process-wide positive cache and never forwards a partially admitted batch');
  assert.equal((await handler(rpc('edgar_get_manifests', { ...params, p_keys: Array(101).fill(params.p_keys[1]) }))).status, 403);
  assert.equal((await handler(rpc('edgar_get_manifests', { ...params, include_payload: true }))).status, 422);
  assert.equal(calls.length, 3, 'all structural validation completes before admission');
});

test('dynamic source-only admission cannot grant research access; preview JWT cannot query admission', async () => {
  const cik = '0001999999'; const calls = [];
  const { handler } = setup({ fetchImpl: async (...args) => {
    calls.push(args);
    return Response.json(args[0].endsWith('/edgar_membership_admission') ? { allowedCiks: [], sourceOnlyCiks: [cik] } : { ok: true });
  } });
  assert.equal((await handler(rpc('edgar_get_version', { p_dataset: 'sec', p_key: `sec-documents-v1:CIK${cik}:submissions` }))).status, 200);
  assert.equal((await handler(rpc('edgar_get_version', { p_dataset: 'financial', p_key: `research-company-v1:CIK${cik}` }))).status, 403);
  assert.equal(calls.length, 3);
  const preview = setup({ verifyToken: async () => claims({ environment: 'preview' }) });
  assert.equal((await preview.handler(rpc('edgar_get_version', { p_dataset: 'sec', p_key: `sec-documents-v1:CIK${cik}:submissions` }))).status, 401);
  assert.equal(preview.calls.length, 0);
});

test('membership admission errors and unexpected response shapes fail closed without forwarding', async () => {
  const cik = '0001999999';
  const responses = [
    () => Response.json({ allowedCiks: [cik] }),
    () => Response.json({ allowedCiks: [cik, cik], sourceOnlyCiks: [] }),
    () => Response.json({ allowedCiks: ['0001888888'], sourceOnlyCiks: [] }),
    () => Response.json({ allowedCiks: [cik], sourceOnlyCiks: [], override: true }),
    () => Response.json({ message: environment.SUPABASE_SECRET_KEYS }, { status: 500 }),
    () => new Response('not JSON'),
    () => { throw new Error(environment.SUPABASE_SECRET_KEYS); },
  ];
  for (const respond of responses) {
    let count = 0;
    const { handler } = setup({ fetchImpl: async () => { count += 1; return respond(); } });
    const response = await handler(rpc('edgar_get_version', { p_dataset: 'sec', p_key: `sec-documents-v1:CIK${cik}:submissions` }));
    assert.equal(response.status, 503); assert.equal(count, 1);
    assert.doesNotMatch(await response.text(), /sb_secret|SUPABASE|this_value/);
  }
});

function membershipStage(raw = Buffer.from('Ticker,Name\nAAPL,Apple Inc.\n')) {
  const snapshot = structuredClone(SEC_COVERAGE_UNIVERSE);
  const compressed = gzipSync(raw);
  const rawSha256 = createHash('sha256').update(raw).digest('hex');
  snapshot.sourceSnapshot = { path: `memberships/ivv/${snapshot.reference.asOf}/${rawSha256}.csv`, sha256: rawSha256 };
  snapshot.mapping.sourceSha256 = 'b'.repeat(64);
  snapshot.mapping.checkedAt = new Date(NOW).toISOString();
  return { p_claim: { generation: '9007199254740993', owner: UUID }, p_snapshot: snapshot,
    p_evidence: { rawSha256, rawBytes: raw.byteLength, gzipSha256: createHash('sha256').update(compressed).digest('hex'), gzipBase64: compressed.toString('base64') } };
}

test('membership staging forwards only validated snapshots and independently hash-verified raw evidence', async () => {
  const { handler, calls } = setup();
  const params = membershipStage();
  assert.equal((await handler(rpc('edgar_stage_membership', params))).status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0][1].body), { ...params, p_namespace: 'production' });
  const changes = [
    value => { value.p_evidence.rawBytes += 1; },
    value => { value.p_evidence.rawSha256 = 'c'.repeat(64); value.p_snapshot.sourceSnapshot.sha256 = value.p_evidence.rawSha256; },
    value => { value.p_evidence.gzipSha256 = 'c'.repeat(64); },
    value => { value.p_evidence.gzipBase64 = 'not base64'; },
    value => { value.p_snapshot.issuers[0].name = 'Changed after fingerprint'; },
    value => { value.p_snapshot.issuers[0].aliases.push(value.p_snapshot.issuers[1].ticker); },
    value => { value.p_snapshot.reference.url = 'https://attacker.example/holdings.csv'; },
    value => { value.p_snapshot.mapping.sourceUrl = 'https://attacker.example/tickers.json'; },
    value => { value.p_snapshot.mapping.sourceSha256 = 'invalid'; },
    value => { value.p_snapshot.mapping.checkedAt = new Date(NOW + 120000).toISOString(); },
    value => { value.p_snapshot.reference.checkedAt = new Date(NOW + 120000).toISOString(); },
    value => { value.p_snapshot.reference.asOf = '2026-02-31'; },
    value => { value.p_snapshot.issuers.pop(); },
    value => { value.p_snapshot.unreviewed = true; },
    value => { value.p_claim.expiresAt = new Date(NOW).toISOString(); },
    value => { value.p_claim.generation = '9223372036854775808'; },
  ];
  for (const change of changes) {
    const invalid = structuredClone(params); change(invalid);
    assert.equal((await handler(rpc('edgar_stage_membership', invalid))).status, 422, change.toString());
  }
  assert.equal(calls.length, 1, 'invalid evidence and snapshots never reach SQL');
});

test('membership evidence rejects corrupt gzip and bounds decompressed bytes independently of declarations', async () => {
  const { handler, calls } = setup();
  const corrupt = membershipStage();
  const bytes = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0]);
  corrupt.p_evidence.gzipBase64 = bytes.toString('base64');
  corrupt.p_evidence.gzipSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal((await handler(rpc('edgar_stage_membership', corrupt))).status, 422);
  const oversized = membershipStage(Buffer.alloc(750001, 65));
  oversized.p_evidence.rawBytes = 750000;
  assert.equal((await handler(rpc('edgar_stage_membership', oversized))).status, 413);
  assert.equal(calls.length, 0);
});

test('residual exclusions are narrow, auditable and cannot silently remove a listed security', async () => {
  const { handler, calls } = setup();
  const params = membershipStage();
  const exclusion = { ticker: 'RESID', name: 'Residual', exchange: 'NO MARKET (E.G. UNLISTED)', currency: 'USD', marketValueUsd: 28433.88, weightPercent: 0, reason: 'Unlisted residual holding, excluded from listed-security research coverage.' };
  params.p_snapshot.sourceExclusions = [exclusion];
  assert.equal((await handler(rpc('edgar_stage_membership', params))).status, 200);
  for (const patch of [{ exchange: 'NASDAQ' }, { exchange: 'NO MARKETEVIL' }, { ticker: 'AAPL' }, { weightPercent: 0.01 }, { currency: 'EUR' }, { marketValueUsd: 100000.01 }, { marketValueUsd: -1 }, { reason: 'Ignore inconvenient data' }]) {
    const value = structuredClone(params); Object.assign(value.p_snapshot.sourceExclusions[0], patch);
    assert.equal((await handler(rpc('edgar_stage_membership', value))).status, 422, JSON.stringify(patch));
  }
  const aggregate = structuredClone(params);
  aggregate.p_snapshot.sourceExclusions = [ { ...exclusion, marketValueUsd: 60000 }, { ...exclusion, ticker: 'RESIDB', marketValueUsd: 60000 } ];
  assert.equal((await handler(rpc('edgar_stage_membership', aggregate))).status, 422);
  assert.equal(calls.length, 1);
});

test('registry, membership fences and operations expose only exact bounded parameters', async () => {
  const { handler, calls } = setup();
  const claim = { owner: UUID, generation: '9007199254740993' };
  const valid = [
    ['edgar_coverage_registry', {}], ['edgar_begin_membership_check', { p_owner: UUID }],
    ['edgar_activate_membership', { p_claim: claim, p_id: SEC_COVERAGE_MEMBERSHIP_ID }],
    ['edgar_finish_membership_check', { p_claim: claim, p_error: 'MEMBERSHIP_SOURCE_UNAVAILABLE' }],
    ['edgar_enqueue_current_coverage_jobs', { p_cycle: '2026-09-13', p_shards: [0, 31] }],
    ['edgar_coverage_operations', {}], ['edgar_coverage_operations', { p_hours: 168 }],
    ['edgar_capture_coverage_operations', {}],
  ];
  for (const [name, params] of valid) assert.equal((await handler(rpc(name, params))).status, 200, name);
  const invalid = [
    ['edgar_coverage_registry', { rawEvidence: true }], ['edgar_begin_membership_check', { p_owner: 'other' }],
    ['edgar_activate_membership', { p_claim: claim, p_id: SEC_COVERAGE_MEMBERSHIP_ID.replace('2026-09-08', '2026-02-31') }],
    ['edgar_finish_membership_check', { p_claim: claim, p_error: 'https://private.example?secret=value' }],
    ['edgar_finish_membership_check', { p_claim: claim, p_error: 'MEMBERSHIP:ERROR-CODE' }],
    ['edgar_enqueue_current_coverage_jobs', { p_cycle: '2026-09-13', p_shards: [0, 0] }],
    ['edgar_enqueue_current_coverage_jobs', { p_cycle: '2026-09-13', p_version: 'a'.repeat(16) }],
    ['edgar_coverage_operations', { p_hours: 169 }], ['edgar_coverage_operations', { p_hours: 0 }],
    ['edgar_capture_coverage_operations', { target: 'other' }],
  ];
  for (const [name, params] of invalid) assert.equal((await handler(rpc(name, params))).status, 422, name);
  assert.equal(calls.length, valid.length);
  assert.ok(calls.every(([, options]) => JSON.parse(options.body).p_namespace === 'production'));
});

test('SEC dispatch gateway exposes only fixed global coordination with bounded owner and provider cooldown fields', async () => {
  const { handler, calls } = setup();
  const valid = [
    ['edgar_acquire_sec_dispatch', { p_owner: UUID }],
    ['edgar_release_sec_dispatch', { p_owner: UUID, p_cooldown_ms: 0 }],
    ['edgar_release_sec_dispatch', { p_owner: UUID, p_cooldown_ms: 300000 }],
    ['edgar_publish_sec_cooldown', { p_cooldown_ms: 300000 }],
  ];
  for (const [name, params] of valid) assert.equal((await handler(rpc(name, params))).status, 200, name);
  const invalid = [
    ['edgar_acquire_sec_dispatch', { p_owner: UUID, p_rate: 100 }],
    ['edgar_acquire_sec_dispatch', { p_owner: UUID, p_host: 'another-provider' }],
    ['edgar_acquire_sec_dispatch', { p_owner: UUID, p_lease_ms: 0 }],
    ['edgar_acquire_sec_dispatch', { p_owner: UUID, p_handoff_ms: 0 }],
    ['edgar_acquire_sec_dispatch', { p_owner: 'arbitrary' }],
    ['edgar_release_sec_dispatch', { p_owner: UUID, p_cooldown_ms: 600000 }],
    ['edgar_release_sec_dispatch', { p_owner: UUID, p_cooldown_ms: -1 }],
    ['edgar_publish_sec_cooldown', { p_cooldown_ms: 0 }],
    ['edgar_publish_sec_cooldown', { p_cooldown_ms: 300001 }],
    ['edgar_publish_sec_cooldown', { p_cooldown_ms: '1000' }],
  ];
  for (const [name, params] of invalid) assert.equal((await handler(rpc(name, params))).status, 422, name);
  assert.equal((await handler(rpc('edgar_acquire_sec_dispatch', { p_owner: UUID, p_namespace: 'rehearsal' }))).status, 403);
  assert.equal((await handler(rpc('edgar_arm_sec_dispatch', {}))).status, 403);
  assert.equal(calls.length, valid.length);
});
