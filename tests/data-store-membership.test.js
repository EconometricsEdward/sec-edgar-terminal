import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createDataStore, dataStoreContentHash, DATA_STORE_LIMITS } from '../src/utils/dataStore.js';
import { SEC_COVERAGE_UNIVERSE } from '../src/utils/secCoverageUniverse.js';

const env = { VERCEL_ENV: 'production', EDGAR_DATASTORE_SEC: 'supabase', EDGAR_DATASTORE_FINANCIAL: 'supabase' };
const claim = { owner: 'a7cad2d2-3d8a-4b5f-bbfd-f9ab9866b00b', generation: '9007199254740993', expiresAt: '2099-01-01T00:00:00Z', unused: true };
const token = 'header.payload.signature';
const raw = Buffer.from('Ticker,Name\nAAPL,Apple Inc.\n');
const compressed = gzipSync(raw);
const evidence = { rawBytes: raw.length, rawSha256: dataStoreContentHash(raw), gzipSha256: dataStoreContentHash(compressed), gzipBase64: compressed.toString('base64') };
const snapshot = { ...SEC_COVERAGE_UNIVERSE, sourceSnapshot: { path: 'memberships/ivv/test.csv', sha256: evidence.rawSha256 } };
function fixture() {
  const calls = [];
  const store = createDataStore({ env, identityTokenImpl: async () => token, fetchImpl: async (url, options) => {
    calls.push({ url, ...options, params: JSON.parse(options.body) }); return Response.json({ ok: true });
  } });
  return { store, calls };
}

test('membership and operations wrappers send exact gateway contracts, strip claim extras and preserve bigint generations', async () => {
  const { store, calls } = fixture();
  await store.readCoverageRegistry();
  await store.beginCoverageMembershipCheck();
  await store.stageCoverageMembership(claim, snapshot, evidence);
  await store.activateCoverageMembership(claim, snapshot.id);
  await store.finishCoverageMembershipCheck(claim, 'MEMBERSHIP_SOURCE_UNAVAILABLE');
  await store.enqueueCurrentCoverageJobs({ cycle: '2026-09-13', shards: [0, 31] });
  await store.readCoverageOperations();
  await store.captureCoverageOperations();
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), [
    'edgar_coverage_registry', 'edgar_begin_membership_check', 'edgar_stage_membership', 'edgar_activate_membership',
    'edgar_finish_membership_check', 'edgar_enqueue_current_coverage_jobs', 'edgar_coverage_operations', 'edgar_capture_coverage_operations',
  ]);
  assert.ok(calls.every(call => call.url.startsWith('https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway/rest/v1/rpc/')));
  assert.ok(calls.every(call => call.params.p_namespace === 'production' && call.headers.Authorization === `Bearer ${token}` && call.redirect === 'error'));
  assert.match(calls[1].params.p_owner, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  for (const index of [2, 3, 4]) assert.deepEqual(calls[index].params.p_claim, { owner: claim.owner, generation: claim.generation });
  assert.deepEqual(calls[2].params.p_snapshot, snapshot);
  assert.deepEqual(calls[2].params.p_evidence, evidence);
  assert.deepEqual(calls[5].params, { p_namespace: 'production', p_cycle: '2026-09-13', p_shards: [0, 31] });
  assert.deepEqual(calls[6].params, { p_namespace: 'production', p_hours: 24 });
  assert.deepEqual(calls[7].params, { p_namespace: 'production' });
});

test('only membership evidence staging receives the extended bounded request timeout', async t => {
  const { store } = fixture(); const delays = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => { delays.push(delay); return original(callback, delay, ...args); });
  await store.stageCoverageMembership(claim, snapshot, evidence);
  await store.readCoverageRegistry();
  await store.readCoverageOperations();
  assert.deepEqual(delays, [20000, DATA_STORE_LIMITS.requestTimeoutMs, DATA_STORE_LIMITS.requestTimeoutMs]);
});

test('membership wrapper inputs are bounded before transport and error details never enter checkpoint storage', async () => {
  const { store, calls } = fixture();
  for (const generation of [0, -1, '9223372036854775808', '1.5', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.activateCoverageMembership({ ...claim, generation }, snapshot.id), { code: 'invalid_claim' });
  }
  for (const id of ['other', snapshot.id.replace('2026-09-08', '2026-02-31')]) await assert.rejects(store.activateCoverageMembership(claim, id), { code: 'invalid_membership' });
  for (const hours of [0, 169, 1.5, '24']) await assert.rejects(store.readCoverageOperations({ hours }), { code: 'invalid_hours' });
  await assert.rejects(store.enqueueCurrentCoverageJobs({ cycle: '2026-02-31' }), { code: 'invalid_coverage_jobs' });
  await assert.rejects(store.enqueueCurrentCoverageJobs({ cycle: '2026-09-13', shards: [1, 1] }), { code: 'invalid_coverage_jobs' });
  await assert.rejects(store.stageCoverageMembership(claim, null, evidence), { code: 'invalid_membership' });
  await assert.rejects(store.stageCoverageMembership(claim, { ...snapshot, invalid: Infinity }, evidence), { code: 'non_finite_value' });
  assert.equal(calls.length, 0);
  await store.finishCoverageMembershipCheck(claim, new Error('https://private.example?secret=do-not-store'));
  await store.finishCoverageMembershipCheck(claim, 'https://private.example?secret=do-not-store');
  await store.finishCoverageMembershipCheck(claim, 'MEMBERSHIP:ERROR-CODE');
  await store.finishCoverageMembershipCheck(claim);
  assert.deepEqual(calls.map(call => call.params.p_error), ['MEMBERSHIP_CHECK_FAILED', 'MEMBERSHIP_CHECK_FAILED', 'MEMBERSHIP_CHECK_FAILED', null]);
  assert.doesNotMatch(JSON.stringify(calls), /do-not-store|private\.example/);
});

test('disabled coverage prevents membership mutation and enqueue without obtaining configuration or identity', async () => {
  const store = createDataStore({ env: {}, identityTokenImpl: async () => { throw new Error('identity must not be requested'); }, fetchImpl: async () => { throw new Error('network must not be requested'); } });
  assert.equal(await store.beginCoverageMembershipCheck(), null);
  assert.equal(await store.stageCoverageMembership(claim, snapshot, evidence), null);
  assert.equal(await store.activateCoverageMembership(claim, snapshot.id), null);
  assert.equal(await store.finishCoverageMembershipCheck(claim), false);
  assert.equal(await store.enqueueCurrentCoverageJobs({ cycle: '2026-09-13' }), null);
});
