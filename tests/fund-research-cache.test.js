import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFundResearchCache, validPreparedFundData, FUND_CACHE_TYPE, FUND_RETENTION_MS } from '../src/utils/fundResearchCache.js';
import { createFundLoader } from '../src/utils/fundResearchServer.js';
import { parseNport, portfolioSummary } from '../src/utils/fundResearch.js';

const CIK = '0000036405', ACCESSION = '0000036405-26-000001', SERIES = 'S000002839', CLASS = 'C000007980';
const CLOCK = Date.parse('2026-09-16T12:00:00.000Z');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const document = (count = 3, series = SERIES) => `<edgarSubmission><genInfo><regCik>36405</regCik><regName>Test Trust</regName><seriesName>Correct Fund</seriesName><seriesId>${series}</seriesId><repPdDate>2026-06-30</repPdDate></genInfo><fundInfo><totAssets>1200</totAssets><totLiabs>200</totLiabs><netAssets>1000</netAssets><cshNotRptdInCorD>0</cshNotRptdInCorD></fundInfo><invstOrSecs>${Array.from({ length: count }, (_, i) => `<invstOrSec><name>Holding ${i}</name><cusip>123456789</cusip><balance>-2</balance><units>NC</units><valUSD>${i === 0 ? '-20' : i === 1 ? 'N/A' : '100'}</valUSD><assetCat>EC</assetCat><invCountry>US</invCountry><payoffProfile>Long</payoffProfile></invstOrSec>`).join('')}</invstOrSecs></edgarSubmission>`;
function fund(count = 3) {
  const root = `https://www.sec.gov/Archives/edgar/data/36405/${ACCESSION.replaceAll('-', '')}/`;
  const data = { ...parseNport(document(count), { cik: CIK, seriesId: SERIES }), ticker: 'TEST', classId: CLASS,
    isFund: true, family: null, status: 'ready', accession: ACCESSION, filingDate: '2026-08-20', form: 'NPORT-P',
    retrievedAt: new Date(CLOCK).toISOString(), identity: 'SEC series matched', sourceUrl: `${root}primary_doc.xml`,
    filingUrl: `${root}${ACCESSION}-index.html`, secUrl: `https://www.sec.gov/edgar/browse/?CIK=${SERIES}&owner=exclude`,
    reports: [{ accession: ACCESSION, filingDate: '2026-08-20', reportDate: '2026-06-30', form: 'NPORT-P' }], filings: [] };
  data.summary = portfolioSummary(data); return data;
}
function fixture(options = {}) {
  let clock = CLOCK; const records = new Map(), writes = [], reads = [];
  const now = () => clock;
  const create = () => createFundResearchCache({ enabled: () => true, now,
    read: async (type, id) => { assert.equal(type, FUND_CACHE_TYPE); reads.push(id); return records.get(id) || null; },
    write: async (type, id, payload, ttl, options) => {
      assert.equal(type, FUND_CACHE_TYPE);
      const old = records.get(id);
      if ((options.ifHash === 'absent' && old) || options.ifHash !== 'absent' && options.ifHash !== old?.rawSha256) return { stored: false };
      const row = { payload: structuredClone(payload), rawSha256: digest(payload), expiresAt: new Date(clock + ttl * 1000).toISOString() };
      writes.push({ id, payload, ttl }); records.set(id, row); return { stored: true };
    }, ...options });
  return { create, records, writes, reads, now, advance: ms => { clock += ms; } };
}

test('N-PORT latest and exact-accession views share one full body, preserving all 997 holdings', async () => {
  const f = fixture(), data = fund(997);
  assert.equal(await f.create().publish(data, { latest: true }), true);
  assert.equal(f.records.size, 2);
  assert.equal(f.records.get('TEST:LATEST').payload.data, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(f.records.get('TEST:LATEST').payload)) < 4096);
  const store = f.create(), latest = await store.readPrepared('test'), historic = await store.readPrepared('TEST', ACCESSION);
  assert.equal(latest.holdings.length, 997); assert.equal(historic.holdings.length, 997);
  assert.deepEqual(latest.holdings, data.holdings); assert.deepEqual(latest.summary, data.summary);
  assert.equal(latest.retrievedAt, data.retrievedAt); assert.equal(latest.cache.stale, false);
  assert.equal(f.writes.length, 2, 'Reads do not write or renew cache records');
});

test('Prepared public reads retain dated stale results while interactive latest checks expire after one hour', async () => {
  const f = fixture(), data = fund(); await f.create().publish(data, { latest: true });
  f.advance(3600001); const store = f.create();
  assert.equal(await store.readPrepared('TEST', '', { allowStale: false }), null);
  const stale = await store.readPrepared('TEST');
  assert.equal(stale.cache.stale, true); assert.equal(stale.retrievedAt, data.retrievedAt);
  assert.equal(stale.cache.checkedAt, data.retrievedAt);
  assert.equal((await store.readPrepared('TEST', ACCESSION, { allowStale: false })).holdings.length, 3);
  f.advance(FUND_RETENTION_MS); assert.equal(await store.readPrepared('TEST'), null);
});

test('A long-lived reader observes another instance replacing the head and the same accession body', async () => {
  const f = fixture(), original = fund(); await f.create().publish(original, { latest: true });
  const reader = f.create(); await reader.readPrepared('TEST');
  f.advance(3600001);
  const newer = { ...original, registrant: 'New SEC registrant label' };
  assert.equal(await f.create().publish(newer, { latest: true, checkedAt: new Date(f.now()).toISOString() }), true);
  const observed = await reader.readPrepared('TEST', '', { allowStale: false });
  assert.equal(observed.registrant, newer.registrant);
  assert.equal(observed.cache.checkedAt, new Date(f.now()).toISOString());
  assert.equal(observed.retrievedAt, original.retrievedAt);
});

test('Prepared records reject head/body identity mismatches, missing bodies, corrupted summaries and future dates', async () => {
  for (const mutate of [
    records => { records.get('TEST:LATEST').payload.seriesId = 'S000002846'; },
    records => { records.get('TEST:LATEST').payload.cik = '0000000001'; },
    records => { records.get('TEST:LATEST').payload.accession = '0000036405-26-999999'; },
    records => { records.get(`TEST:${ACCESSION}`).payload.data.summary.count = 100; },
    records => { records.get(`TEST:${ACCESSION}`).payload.data.sourceUrl = 'https://example.com/primary_doc.xml'; },
    records => { records.get(`TEST:${ACCESSION}`).payload.data.retrievedAt = '2099-01-01T00:00:00Z'; },
    records => { records.get(`TEST:${ACCESSION}`).payload.data.holdings[0].id = 0; },
    records => { records.delete(`TEST:${ACCESSION}`); },
  ]) {
    const f = fixture(); await f.create().publish(fund(), { latest: true }); mutate(f.records);
    assert.equal(await f.create().readPrepared('TEST'), null);
  }
});

test('Cache validation retains negative and missing positions and rejects changed totals or calculated weights', () => {
  const data = fund(); assert.equal(validPreparedFundData(data, 'TEST', ACCESSION, CLOCK), true);
  assert.ok(data.holdings.some(row => row.value === null && row.pctOfNav === null));
  assert.ok(data.holdings.some(row => row.value === -20 && row.pctOfNav === -2));
  const changed = structuredClone(data); changed.holdings[0].pctOfNav = 99; changed.summary = portfolioSummary(changed);
  assert.equal(validPreparedFundData(changed, 'TEST', ACCESSION, CLOCK), false);
});

test('Older publication cannot replace a newer head; local storage has a byte bound', async () => {
  const f = fixture(), data = fund(); await f.create().publish(data, { latest: true });
  f.advance(3600000); const newer = f.create();
  await newer.publish(data, { latest: true, checkedAt: new Date(f.now()).toISOString() });
  assert.equal(await f.create().publish(data, { latest: true, checkedAt: data.retrievedAt }), false);
  const small = createFundResearchCache({ enabled: () => false, now: f.now, maxLocalBytes: 1000 });
  await small.publish(fund(997), { latest: true }); assert.ok(small.memoryUsage().bytes <= 1000);
  assert.equal(await small.readPrepared('TEST'), null, 'A head without its oversized body is not a complete result');
});

function loaderFixture({ xml = document(), cache, now = () => CLOCK, ...options } = {}) {
  const calls = [];
  const load = createFundLoader({ fundLookup: async () => ({ cik: CIK, seriesId: SERIES, classId: CLASS }),
    operatingLookup: async () => { throw new Error('Unexpected operating-company lookup'); }, cache, now,
    fetchSec: async (url, options) => {
      assert.ok(options.signal); assert.equal(options.cache, 'no-store'); calls.push(url);
      if (url.includes('/submissions/')) return Response.json({ cik: 36405, name: 'Test Trust', filings: { recent: {
        form: ['NPORT-P'], accessionNumber: [ACCESSION], filingDate: ['2026-08-20'], reportDate: ['2026-06-30'], primaryDocument: ['primary_doc.xml'] } } });
      if (url.includes('browse-edgar')) return new Response(`<feed><entry><accession-number>${ACCESSION}</accession-number><filing-date>2026-08-20</filing-date><filing-type>NPORT-P</filing-type></entry></feed>`);
      return new Response(xml);
    }, ...options });
  return { load, calls };
}

test('An expired latest head rechecks SEC metadata and reuses immutable accession holdings without renewing retrieval time', async () => {
  const f = fixture(), cache = f.create(), { load, calls } = loaderFixture({ cache, now: f.now });
  const initial = await load('TEST'); assert.equal(calls.length, 3);
  await load('TEST', ACCESSION); assert.equal(calls.length, 3);
  f.advance(3600001); const refreshed = await load('TEST');
  assert.equal(calls.length, 5, 'Only submissions and series feed need rechecking');
  assert.equal(refreshed.retrievedAt, initial.retrievedAt);
  assert.equal((await cache.readPrepared('TEST')).cache.checkedAt, new Date(f.now()).toISOString());
  assert.deepEqual(refreshed.holdings, initial.holdings);
});

test('Wrong SEC series and identity are rejected before publication', async () => {
  const f = fixture(), { load } = loaderFixture({ cache: f.create(), xml: document(3, 'S000002846') });
  await assert.rejects(load('TEST'), /series does not match/); assert.equal(f.writes.length, 0);
});

test('Optional cache outages preserve successful source retrieval and cache-only reads do no source work', async () => {
  const cache = createFundResearchCache({ enabled: () => true, now: () => CLOCK,
    read: async () => { throw new Error('offline'); }, write: async () => { throw new Error('offline'); } });
  const { load, calls } = loaderFixture({ cache });
  assert.equal(await cache.readPrepared('TEST'), null); assert.equal(calls.length, 0);
  assert.equal((await load('TEST')).holdings.length, 3); assert.equal(calls.length, 3);
  assert.equal((await load('TEST')).holdings.length, 3); assert.equal(calls.length, 3, 'A cache outage does not repeat source acquisition for every table request');
});

test('Outage fallback never masks a newer shared head and does not treat a successful miss as an outage', async () => {
  const f = fixture(); let online = false;
  const fallback = createFundResearchCache({ enabled: () => true, now: f.now,
    read: async (_type, id) => { if (!online) throw new Error('offline'); return f.records.get(id) || null; },
    write: async () => { throw new Error('offline'); } });
  const original = fund(); await fallback.publish(original, { latest: true });
  assert.ok(await fallback.readPrepared('TEST'));
  online = true; assert.equal(await fallback.readPrepared('TEST'), null, 'A confirmed shared miss is not an outage');
  f.advance(1000); const updated = { ...original, registrant: 'Updated outside this process' };
  await f.create().publish(updated, { latest: true });
  assert.equal((await fallback.readPrepared('TEST')).registrant, updated.registrant);
  online = false; f.advance(3600001);
  assert.equal(await fallback.readPrepared('TEST'), null, 'Local outage fallback does not create a new hour of freshness');
});

test('Unique pending fund loads are bounded and duplicate requests coalesce', async () => {
  const cache = createFundResearchCache({ enabled: () => false, now: () => CLOCK });
  let release; const gate = new Promise(resolve => { release = resolve; }); let lookups = 0;
  const { load } = loaderFixture({ cache, maxPending: 1, fundLookup: async () => { lookups++; await gate; return { cik: CIK, seriesId: SERIES, classId: CLASS }; } });
  const first = load('TEST'), repeat = load('TEST');
  await assert.rejects(load('OTHER'), /already loading/); release();
  assert.equal((await first).holdings.length, 3); assert.equal((await repeat).holdings.length, 3); assert.equal(lookups, 1);
});

test('An overall deadline cancels a stalled directory lookup', async () => {
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const cache = createFundResearchCache({ enabled: () => false, now: () => CLOCK });
    const { load } = loaderFixture({ cache, deadlineMs: 10, fundLookup: async () => new Promise(() => {}) });
    await assert.rejects(load('TEST'), error => error.name === 'TimeoutError');
  } finally { clearTimeout(keepAlive); }
});
