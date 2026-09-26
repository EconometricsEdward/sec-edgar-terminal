import test from 'node:test';
import assert from 'node:assert/strict';
import { organizationProfile, organizationDate, organizationPeers, organizationOffices, parentSecCandidates } from '../src/utils/bank/organizationModel.js';
import { createOrganizationService, organizationSourceUrl } from '../src/utils/bank/organizationService.js';
import { createOrganizationApi } from '../src/utils/bank/organizationApi.js';

const bank = { FED_RSSD: '451965', CERT: 3511, NAME: 'Example Bank', ACTIVE: 1, CALLFORM: 31, RSSDHCR: '1120754', NAMEHCR: 'EXAMPLE&COMPANY', REPDTE: '06/30/2026', RUNDATE: '09/25/2026', ESTYMD: '01/01/1870', INSDATE: '01/01/1934', OFFICES: 2 };
const reply = (rows, total = rows.length) => Response.json({ meta: { total, index: { name: 'source_20260925', createTimestamp: '2026-09-25T11:00:00Z' } }, data: rows.map(data => ({ data })) });
const directory = async () => ({ data: {}, stale: false, fetchedAt: '2026-09-26T00:00:00Z' });

test('current legal bank is linked only to its reported regulatory top holder with an independent source date', () => {
  const value = organizationProfile(bank, 451965);
  assert.equal(value.parent.rssd, 1120754);
  assert.equal(value.parent.relationship, 'regulatory_top_holder');
  assert.equal(value.parent.reportedAt, '2026-06-30');
  assert.equal(value.snapshotDate, '2026-09-25');
  assert.equal(value.offices.domestic, null);
  assert.equal(value.nicUrl, 'https://www.ffiec.gov/npw/Institution/Profile/451965');
  assert.throws(() => organizationProfile(bank, 1));
  assert.throws(() => organizationProfile({ ...bank, ACTIVE: 0 }, 451965));
  // A recycled/historical FDIC certificate must not win over the current bank.
  assert.match(new URL(organizationSourceUrl('profile', 451965)).searchParams.get('filters'), /FED_RSSD:451965 AND ACTIVE:1/);
});

test('missing, self and incomplete parent records never imply independence or create a false parent', () => {
  for (const override of [{ RSSDHCR: 0 }, { RSSDHCR: 451965 }, { NAMEHCR: '' }, { RSSDHCR: 'invalid' }]) {
    const value = organizationProfile({ ...bank, ...override }, 451965);
    assert.equal(value.parent, null); assert.equal(value.parentStatus, 'not_reported');
  }
  assert.equal(organizationDate('02/30/2026'), null);
  assert.equal(organizationDate('12/31/9999'), null);
});

test('SEC discovery deduplicates CIKs and never uses fuzzy names or a stale directory as a verified join', () => {
  const snapshot = { stale: false, data: { EX: { name: 'Example & Company/DE', cik: '0000000001' }, 'EX-A': { name: 'Example & Company/DE', cik: '0000000001' }, OTH: { name: 'Example & Company Trust', cik: '0000000002' } } };
  const matches = parentSecCandidates({ name: 'EXAMPLE&COMPANY' }, snapshot);
  assert.equal(matches.length, 1); assert.deepEqual(matches[0].tickers, ['EX', 'EX-A']);
  assert.deepEqual(parentSecCandidates({ name: 'EXAMPLE&COMPANY' }, { ...snapshot, stale: true }), []);
  assert.deepEqual(parentSecCandidates({ name: 'EXAMPLE BANK' }, snapshot), []);
  assert.equal(parentSecCandidates({ name: 'FIRST INTERNET BCORP' }, { data: { INBK: { name: 'First Internet Bancorp', cik: '0001562463' } } }).length, 1);
});

test('office counts reject wrong certificates and duplicates; related banks must share the exact parent', () => {
  assert.deepEqual(organizationOffices([{ UNINUM: 10, CERT: '3511', STALP: 'IN' }, { UNINUM: 11, CERT: 3511, STALP: 'IN' }], 3511), { total: 2, regions: [{ region: 'IN', offices: 2 }] });
  assert.throws(() => organizationOffices([{ UNINUM: 10, CERT: 1 }], 3511));
  assert.throws(() => organizationOffices([{ UNINUM: 10, CERT: 3511 }, { UNINUM: 10, CERT: 3511 }], 3511));
  assert.throws(() => organizationPeers([{ ...bank, RSSDHCR: 1 }], 1120754, 451965));
  assert.throws(() => organizationPeers([bank, bank], 1120754, 451965));
  const peers = organizationPeers([bank], 1120754, 451965);
  assert.equal(peers[0].selected, true); assert.equal(peers[0].eligible, true);
});

test('coalesced reads retain source clocks, expire, and isolate optional SEC outages', async () => {
  let clock = Date.parse('2026-09-26'), reads = 0;
  const service = createOrganizationService({ now: () => clock, directory: async () => { throw new Error('SEC down'); }, fetchImpl: async () => { reads++; return reply([bank]); } });
  const results = await Promise.all([service(451965, 'sec'), service(451965, 'sec')]);
  assert.equal(reads, 1); assert.equal(results[0].parentRssd, 1120754); assert.equal(results[0].sec.status, 'unavailable');
  clock += 1000;
  assert.equal((await service(451965)).source.retrievedAt, results[0].source.retrievedAt);
  clock += 3600000; await service(451965); assert.equal(reads, 2);
});

test('truncated or ambiguous source results fail closed and never become charts', async () => {
  const partial = createOrganizationService({ directory, fetchImpl: async () => reply([bank], 2) });
  await assert.rejects(partial(451965), /Incomplete/);
  const ambiguous = createOrganizationService({ directory, fetchImpl: async () => reply([bank, { ...bank, CERT: 1230 }]) });
  await assert.rejects(ambiguous(451965), /Incomplete/);
});

test('network failures preserve valid related banks, do not invent office zeros and do not fetch SEC', async () => {
  const service = createOrganizationService({ directory: async () => { throw new Error('Must not run'); }, fetchImpl: async url => {
    if (url.includes('/locations?')) return new Response('Unavailable', { status: 503 });
    return reply([bank]);
  } });
  const result = await service(451965, 'network');
  assert.equal(result.offices, null); assert.deepEqual(result.missing, ['offices']);
  assert.equal(result.peers.banks[0].rssd, 451965);
});

test('API rejects injected identities, duplicate selectors and historical dates before fetching', async () => {
  let reads = 0;
  const api = createOrganizationApi({ rateLimit: async () => ({ allowed: true }), read: async () => { reads++; return { rssd: 451965 }; } });
  for (const query of ['rssd=0', 'rssd=1&rssd=2', 'rssd=1&part=wrong', 'rssd=1&period=2025-03-31', 'rssd=1%20OR%20ACTIVE:1']) {
    const response = await api(new Request(`https://example.com/api?${query}`)); assert.equal(response.status, 400);
  }
  assert.equal(reads, 0);
  assert.equal((await api(new Request('https://example.com/api?rssd=451965'))).status, 200);
  assert.equal(reads, 1);
});

test('missing and degraded organization responses are never publicly cached as complete data', async () => {
  for (const data of [{ unavailable: 'institution_not_found' }, { missing: ['peers'] }, { sec: { status: 'unavailable' } }]) {
    const api = createOrganizationApi({ rateLimit: async () => ({ allowed: true }), read: async () => data });
    assert.equal((await api(new Request('https://example.com/api?rssd=451965'))).headers.get('cache-control'), 'private, no-store');
  }
});
