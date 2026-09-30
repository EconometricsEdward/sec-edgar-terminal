import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBankApiReadCache, bankApiRefresh } from '../src/utils/bank/apiReadCache.js';
import { createPeerApi } from '../src/utils/bank/peerApi.js';
import { createOrganizationApi } from '../src/utils/bank/organizationApi.js';
import { organizationProfile } from '../src/utils/bank/organizationModel.js';
import { parseUbprXbrl } from '../src/utils/bank/ubpr.js';

const rssd = 451965, period = '2026-06-30', hash = 'a'.repeat(64);
const source = { url: 'https://api.fdic.gov/banks/institutions', index: 'official', retrievedAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', sha256: hash };
const profile = () => ({ rssd, version: 'bankscope-organization-1', source, bank: organizationProfile({ FED_RSSD: rssd, CERT: 3511, NAME: 'Example Bank', ACTIVE: 1 }, rssd) });
const peers = () => ({ period, bank: { rssd }, snapshot: { id: 'selected', completed_at: source.updatedAt }, peers: [], benchmarks: [], universeCount: 1, eligibleCount: 1, status: 'small_cohort' });
const history = () => ({ rssd: String(rssd), period, snapshotId: 'selected', snapshots: [{ report_date: period }], metrics: [{ points: [{ period, sourceAvailable: true, value: null }] }] });
const reference = () => ({ rssd, period, ubpr: { status: 'ready', report: { id_rssd: rssd, report_date: period, source_sha256: hash, retrieved_at: source.retrievedAt,
  data: parseUbprXbrl(readFileSync(new URL('./fixtures/ubpr-451965-2026-06-30.xml', import.meta.url), 'utf8'), { rssd, period }) } } });
const peerRequest = (suffix = '', options) => new Request(`https://example.test/api/banks/peers?rssd=${rssd}&period=${period}${suffix}`, options);
const organizationRequest = (part = 'profile', options) => new Request(`https://example.test/api/banks/organization?rssd=${rssd}&part=${part}`, options);
const keep = { reusable: () => true };

test('public API reads coalesce, isolate caller mutations, preserve source dates, and expire absolutely', async () => {
  let calls = 0, clock = 0;
  const read = createBankApiReadCache({ now: () => clock });
  const load = async () => { calls++; return profile(); };
  const values = await Promise.all(Array.from({ length: 20 }, () => read('profile', load, keep)));
  assert.equal(calls, 1);
  values[0].data.bank.name = 'mutated';
  clock = 10000;
  const cached = await read('profile', load, keep);
  assert.equal(cached.data.bank.name, 'Example Bank'); assert.equal(cached.ageMs, 10000);
  assert.deepEqual(cached.data.source, source);
  clock = 30000; await read('profile', load, keep); assert.equal(calls, 2);
  clock = 29999; await read('profile', load, keep); assert.equal(calls, 3);
});

test('errors, incomplete results and oversized bodies never become reusable API reads', async () => {
  const read = createBankApiReadCache({ maxEntryBytes: 100 }); let calls = 0;
  for (const load of [async () => { calls++; throw Error('offline'); }, async () => { calls++; return { unavailable: true }; }, async () => { calls++; return { text: 'a'.repeat(101) }; }]) {
    for (let i = 0; i < 2; i++) await read('key', load, { reusable: body => !body.unavailable }).catch(() => {});
  }
  assert.equal(calls, 6);
});

test('explicit refresh supersedes earlier in-flight reads and failed refresh has no stale fallback', async () => {
  const read = createBankApiReadCache(); let finish;
  const ordinary = read('key', () => new Promise(resolve => { finish = resolve; }), keep);
  const fresh = await read('key', async () => ({ version: 2 }), { ...keep, refresh: true });
  finish({ version: 1 }); assert.equal((await ordinary).data.version, 1);
  assert.equal(fresh.data.version, 2);
  assert.equal((await read('key', () => assert.fail('fresh entry lost'), keep)).data.version, 2);
  await assert.rejects(read('key', async () => { throw Error('offline'); }, { ...keep, refresh: true }));
  assert.equal((await read('key', async () => ({ version: 3 }), keep)).data.version, 3);
});

test('a failed refresh cannot send subsequent readers back to a superseded pending result', async () => {
  const read = createBankApiReadCache({ maxInFlight: 2 }); let finish;
  const ordinary = read('key', () => new Promise(resolve => { finish = resolve; }), keep);
  await assert.rejects(read('key', async () => { throw Error('offline'); }, { ...keep, refresh: true }));
  assert.equal((await read('key', async () => ({ version: 2 }), keep)).data.version, 2);
  finish({ version: 1 }); await ordinary;
  assert.equal((await read('key', () => assert.fail('new entry lost'), keep)).data.version, 2);
});

test('entry count, byte budget and independent in-flight API reads are bounded', async () => {
  let calls = 0; const load = async () => { calls++; return { value: 1 }; };
  for (const limits of [{ maxEntries: 1 }, { maxBytes: 15 }, { maxEntries: 0 }]) {
    const read = createBankApiReadCache(limits), before = calls;
    await read('one', load, keep); await read('two', load, keep); await read('one', load, keep);
    assert.equal(calls - before, 3);
  }
  const read = createBankApiReadCache({ maxInFlight: 1 }); let finish;
  const a = read('one', () => new Promise(resolve => { finish = resolve; }), keep);
  const b = read('one', () => assert.fail('duplicate read'), keep);
  await assert.rejects(read('two', load, keep), /in progress/);
  finish({ value: 1 }); assert.deepEqual(await a, await b);
});

test('all supported browser refresh directives bypass completed request reuse', () => {
  for (const options of [{ cache: 'no-cache' }, { cache: 'no-store' }, { cache: 'reload' },
    { headers: { 'cache-control': 'max-age=0' } }, { headers: { 'cache-control': 'no-cache' } }, { headers: { pragma: 'no-cache' } }]) {
    assert.equal(bankApiRefresh(peerRequest('', options)), true);
  }
  assert.equal(bankApiRefresh(peerRequest()), false);
});

test('peer matching, history and validated references reuse independently after per-request rate checks', async () => {
  const calls = { peers: 0, history: 0, reference: 0 }; let rates = 0, allowed = true, clock = 0;
  const api = createPeerApi({ now: () => clock, rateLimit: async () => { rates++; return { allowed, resetAt: Date.now() + 60000 }; },
    analyze: async () => { calls.peers++; return peers(); }, history: async () => { calls.history++; return history(); }, reference: async () => { calls.reference++; return reference(); } });
  for (const [kind, suffix] of [['peers', ''], ['history', '&history=1'], ['reference', '&reference=1']]) {
    const responses = await Promise.all(Array.from({ length: 8 }, () => api(peerRequest(suffix))));
    assert.ok(responses.every(response => response.status === 200));
    assert.equal(calls[kind], 1);
  }
  assert.equal(rates, 24);
  clock = 9000;
  assert.match((await api(peerRequest())).headers.get('cache-control'), /s-maxage=21,/);
  allowed = false; assert.equal((await api(peerRequest())).status, 429); assert.equal(calls.peers, 1);
  allowed = true; await api(peerRequest('', { cache: 'no-cache' })); assert.equal(calls.peers, 2);
  clock = 30000; await api(peerRequest('&history=1')); assert.equal(calls.history, 2);
});

test('peer API never retains preparation, stale or failed results and caps reuse at source freshness', async () => {
  let clock = 0, calls = 0, body = { ...peers(), publicPeerCache: { checkedAt: new Date(-299000).toISOString(), stale: false } };
  const api = createPeerApi({ now: () => clock, rateLimit: async () => ({ allowed: true }), analyze: async () => { calls++; return body; } });
  await api(peerRequest()); clock = 1000; await api(peerRequest()); assert.equal(calls, 2);
  for (const next of [{ ...peers(), status: 'preparing' }, { ...peers(), publicPeerCache: { stale: true } }]) {
    body = next;
    const before = calls;
    assert.equal((await api(peerRequest('', { cache: 'no-cache' }))).headers.get('cache-control'), 'private, no-store');
    await api(peerRequest()); assert.equal(calls - before, 2);
  }
  const unavailable = createPeerApi({ rateLimit: async () => ({ allowed: true }), reference: async () => ({ rssd, period, ubpr: { status: 'running', report: null } }) });
  assert.equal((await unavailable(peerRequest('&reference=1'))).headers.get('cache-control'), 'private, no-store');
});

test('organization API reuses only complete selected parts without extending browser or CDN freshness', async () => {
  let clock = 0, reads = 0, rates = 0, body = profile();
  const api = createOrganizationApi({ now: () => clock, rateLimit: async () => { rates++; return { allowed: true }; }, read: async () => { reads++; return body; } });
  await Promise.all(Array.from({ length: 10 }, () => api(organizationRequest()))); assert.equal(reads, 1); assert.equal(rates, 10);
  clock = 5000;
  const response = await api(organizationRequest());
  assert.equal(response.headers.get('cache-control'), 'public, max-age=55, s-maxage=895');
  assert.deepEqual((await response.json()).source, source);
  body = { ...profile(), bank: { ...profile().bank, name: 'Refreshed Bank' } };
  assert.equal((await (await api(organizationRequest('profile', { cache: 'no-cache' }))).json()).bank.name, 'Refreshed Bank');
  assert.equal(reads, 2);
  body = { rssd, version: 'bankscope-organization-1', source, unavailable: 'institution_not_found' };
  await api(organizationRequest('profile', { cache: 'no-cache' })); await api(organizationRequest()); assert.equal(reads, 4);
  body = { ...profile(), rssd: 2 };
  assert.equal((await api(organizationRequest())).headers.get('cache-control'), 'private, no-store');
  await api(organizationRequest()); assert.equal(reads, 6);
});
