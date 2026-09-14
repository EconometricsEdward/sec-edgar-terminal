import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createDataStore } from '../src/utils/dataStore.js';
import { createGateway, TRUST } from '../supabase/functions/edgar-data-gateway/handler.js';
import { disposableCachePolicy, disposableCacheFencePolicy } from '../supabase/functions/edgar-data-gateway/cachePolicy.js';

const type = 'edgar.cftc-positioning.v1:production';
const owner = 'edca5b13-e35e-4021-ae9d-d2345752ccde';
const sourceKey = 'raw-history-v1:futures-only:tff:12460+:2026-09-08';
const id = 'RAW-HISTORY:TFF:12460+:2026-09-08';
const base = 'https://vvkihuduqqnxqahhbphs.supabase.co';
function setup() {
  const calls = []; const now = Date.now();
  const environment = { SUPABASE_URL: base, SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_fixture_private_only' }) };
  const gateway = createGateway({ now: () => now, env: key => environment[key], verifyToken: async () => ({
    iss: TRUST.issuer, aud: TRUST.audience, sub: TRUST.subject, owner: TRUST.owner, owner_id: TRUST.ownerId,
    project: TRUST.project, project_id: TRUST.projectId, environment: 'production', iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 7190,
  }), fetchImpl: async (url, init) => { calls.push({ url, params: JSON.parse(init.body) }); return Response.json(true); } });
  return { calls, send: (name, body) => gateway(new Request(`${base}/functions/v1/edgar-data-gateway/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { Authorization: 'Bearer fixture.identity.token', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })) };
}
const claim = { owner, generation: '1' };
const sha = x => createHash('sha256').update(x).digest('hex');
function putBody() {
  const raw = Buffer.from(JSON.stringify({ family: 'tff', code: '12460+', report_basis: 'futures_only' })); const gzip = gzipSync(raw);
  return { p_dataset: 'cftc', p_key: sourceKey, p_claim: claim, p_family: 'cftc-history', p_type: type, p_id: id,
    p_gzip_base64: gzip.toString('base64'), p_raw_sha256: sha(raw), p_gzip_sha256: sha(gzip), p_raw_bytes: raw.length, p_ttl_seconds: 1382400 };
}

test('dedicated CFTC history quota preserves protected market family and exact raw-only fence', () => {
  assert.equal(disposableCachePolicy(type, id).family, 'cftc-history');
  assert.equal(disposableCachePolicy(type, id).maxTtlSeconds, 16 * 86400);
  assert.equal(disposableCachePolicy(type, 'HISTORY:TFF:ABC+:dealer:2026-09-08:5y').family, 'cftc-history');
  assert.equal(disposableCachePolicy(type, 'MARKETS:TFF:LATEST').family, 'history');
  assert.equal(disposableCacheFencePolicy(type, sourceKey, id).dataset, 'cftc');
  for (const bad of ['RAW-HISTORY:DISAGGREGATED:12460+:2026-09-08', 'RAW-HISTORY:TFF:12460A:2026-09-08', 'RAW-HISTORY:TFF:12460+:2026-09-01', 'MARKETS:TFF:LATEST'])
    assert.equal(disposableCacheFencePolicy(type, sourceKey, bad), null);
  assert.equal(disposableCacheFencePolicy(type, sourceKey.replace('futures-only', 'combined'), id), null);
});

test('gateway admits validated raw canonical identity and rejects malformed basis, code, date, family and destination', async () => {
  const { send, calls } = setup();
  assert.equal((await send('edgar_begin_write', { p_dataset: 'cftc', p_key: sourceKey, p_owner: owner })).status, 200);
  assert.equal((await send('edgar_reserve_cache_generation', { p_dataset: 'cftc', p_key: sourceKey, p_claim: claim })).status, 200);
  assert.equal((await send('edgar_cache_put_fenced', putBody())).status, 200);
  assert.equal((await send('edgar_get_manifests', { p_dataset: 'cftc', p_keys: [sourceKey] })).status, 200);
  for (const bad of [sourceKey.replace('futures-only', 'combined'), sourceKey.replace('tff', 'legacy'), sourceKey.replace('12460+', 'ab'), sourceKey.replace('12460+', 'AAAAAAAAAAAAA'), sourceKey.replace('09-08', '02-31')])
    assert.equal((await send('edgar_begin_write', { p_dataset: 'cftc', p_key: bad, p_owner: owner })).status, 403);
  for (const patch of [{ p_family: 'history' }, { p_id: 'RAW-HISTORY:TFF:ABC+:2026-09-08' }, { p_ttl_seconds: 1382401 }])
    assert.ok((await send('edgar_cache_put_fenced', { ...putBody(), ...patch })).status >= 400);
  assert.equal(calls.length, 4);
});

test('gateway preserves draining legacy raw and derived families without allowing raw source claims into shared history', async () => {
  const { send, calls } = setup();
  assert.equal((await send('edgar_cache_get', { p_family:'history',p_type:type,p_ids:[id] })).status,200);
  const old={...putBody(),p_family:'history',p_key:'markets:tff:latest'};
  assert.equal((await send('edgar_cache_put_fenced',old)).status,200);
  const derived={...old,p_key:'history:tff:12460+:dealer:2026-09-08:5y',p_id:'HISTORY:TFF:12460+:DEALER:2026-09-08:5Y'};
  assert.equal((await send('edgar_cache_put_fenced',derived)).status,200);
  const {p_dataset:_dataset,p_key:_key,p_claim:_claim,...ordinary}=old;
  assert.equal((await send('edgar_cache_put',ordinary)).status,200);
  assert.equal((await send('edgar_cache_put_fenced',{...putBody(),p_family:'history'})).status,403);
  assert.ok((await send('edgar_cache_put',{...ordinary,p_ttl_seconds:1382401})).status>=400);
  assert.equal(calls.length,4);
});

test('gateway isolates CFTC history job prefix, exact family/shard resources and read-only status', async () => {
  const { send, calls } = setup();
  const job = { p_dataset: 'cftc', p_key: 'history-refresh:futures-only:tff:shard:31', p_job_key: `cftc-history-v1:2026-09-08:tff:31:${'a'.repeat(16)}`, p_checkpoint: {} };
  assert.equal((await send('edgar_enqueue_job', job)).status, 200);
  assert.equal((await send('edgar_claim_job_prefix', { p_dataset: 'cftc', p_prefix: 'cftc-history-v1:', p_owner: owner, p_lease_seconds: 270 })).status, 200);
  assert.equal((await send('edgar_cftc_history_status', {})).status, 200);
  for (const patch of [{ p_key: 'history-refresh:futures-only:tff:shard:30' }, { p_key: 'history-refresh:futures-only:disaggregated:shard:31' }, { p_key: 'refresh:tff-disaggregated' }, { p_job_key: job.p_job_key.replace(':31:', ':32:') }, { p_job_key: job.p_job_key.replace('09-08', '02-31') }, { p_job_key: 'cftc-refresh:2026-09-08' }])
    assert.ok((await send('edgar_enqueue_job', { ...job, ...patch })).status >= 400);
  for (const patch of [{ p_dataset: 'sec', p_prefix: 'cftc-history-v1:' }, { p_dataset: 'cftc', p_prefix: 'sec-coverage-v1:' }, { p_dataset: 'cftc', p_prefix: 'cftc-' }])
    assert.equal((await send('edgar_claim_job_prefix', { ...patch, p_owner: owner })).status, 403);
  assert.equal((await send('edgar_cftc_history_status', { enabled: true })).status, 422);
  assert.equal(calls.length, 3);
});

test('data store forwards isolated CFTC claims, successful yield and abortable read-only progress', async () => {
  const calls = []; const abort = new AbortController();
  const store = createDataStore({ env: { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: 'sb_secret_fixture', EDGAR_DATASTORE_NAMESPACE: 'production', EDGAR_DATASTORE_CFTC: 'supabase' },
    fetchImpl: async (url, init) => { calls.push({ url, params: JSON.parse(init.body), signal: init.signal }); return Response.json(true); } });
  await store.claimDataStoreJob({ dataset: 'cftc', prefix: 'cftc-history-v1:', leaseSeconds: 270 });
  await store.yieldDataStoreJob({ ...claim, id: owner }, { checkpoint: { cursor: 12 }, retryAfterSeconds: 2 });
  await store.readCftcHistoryStatus({ signal: abort.signal });
  assert.match(calls[0].url, /edgar_claim_job_prefix$/); assert.equal(calls[0].params.p_prefix, 'cftc-history-v1:');
  assert.match(calls[1].url, /edgar_yield_job$/); assert.equal(calls[1].params.p_checkpoint.cursor, 12);
  assert.match(calls[2].url, /edgar_cftc_history_status$/); assert.ok(calls[2].signal instanceof AbortSignal);
  await assert.rejects(store.claimDataStoreJob({ dataset: 'cftc', prefix: 'sec-coverage-v1:' }), { code: 'invalid_job_prefix' });
  assert.equal(calls.length, 3);
});
