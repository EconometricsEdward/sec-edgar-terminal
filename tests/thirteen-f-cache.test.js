import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { create13FCache, THIRTEEN_F_SNAPSHOT_TYPE, THIRTEEN_F_FILING_TYPE, THIRTEEN_F_FRESH_MS, THIRTEEN_F_STALE_MS,
  valid13FSnapshot, valid13FFiling, thirteenFFilingCacheKey } from '../src/utils/thirteenFCache.js';
import { createThirteenFLoader } from '../src/utils/thirteenFServer.js';
import { summarize13FPortfolio } from '../src/utils/thirteenF.js';
import { GET } from '../src/app/api/fund-13f/route.js';

const CIK = '0001747057', PERIOD = '2026-06-30', START = Date.parse('2026-09-15T03:00:00Z');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const accession = index => `0001172661-26-${String(index).padStart(6, '0')}`;
const filing = (index = 1) => ({ accession: accession(index), form: index === 1 ? '13F-HR' : '13F-HR/A', filingDate: index === 1 ? '2026-08-14' : '2026-09-15', reportDate: PERIOD, primaryDoc: 'primary.xml' });
function transport(requests) {
  return async url => {
    requests.push(url);
    const path = new URL(url).pathname, name = path.split('/').at(-1), amendment = path.includes(accession(2).replaceAll('-', ''));
    if (name === 'index.json') return Response.json({ directory: { name: path.slice(0, -11), item: [{ name: 'primary.xml' }, { name: 'holdings.xml' }] } });
    if (name === 'primary.xml') return new Response(`<edgarSubmission><headerData><submissionType>${amendment ? '13F-HR/A' : '13F-HR'}</submissionType><filerInfo><filer><credentials><cik>${CIK}</cik></credentials></filer><periodOfReport>06-30-2026</periodOfReport></filerInfo></headerData><formData><coverPage><reportCalendarOrQuarter>06-30-2026</reportCalendarOrQuarter><isAmendment>${amendment}</isAmendment>${amendment ? '<amendmentNo>1</amendmentNo><amendmentInfo><amendmentType>NEW HOLDINGS</amendmentType></amendmentInfo>' : ''}<filingManager><name>Fixture Capital</name></filingManager><reportType>13F HOLDINGS REPORT</reportType></coverPage><summaryPage><tableEntryTotal>1</tableEntryTotal><tableValueTotal>1000</tableValueTotal><isConfidentialOmitted>false</isConfidentialOmitted></summaryPage></formData></edgarSubmission>`);
    return new Response(`<informationTable><infoTable><nameOfIssuer>Example company</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>${amendment ? '987654321' : '123456789'}</cusip><value>1000</value><shrsOrPrnAmt><sshPrnamt>20</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt><investmentDiscretion>SOLE</investmentDiscretion><votingAuthority><Sole>20</Sole><Shared>0</Shared><None>0</None></votingAuthority></infoTable></informationTable>`);
  };
}
function fixture() {
  let clock = START, failSource = false, amended = false, companyCalls = 0;
  const records = new Map(), writes = [], reads = [], requests = [];
  const now = () => clock;
  const read = async (type, id) => { reads.push([type, id]); return records.get(`${type}:${id}`) || null; };
  const write = async (type, id, payload, ttl, options) => {
    const key = `${type}:${id}`, old = records.get(key);
    if (options.ifHash === 'absent' ? old : old?.rawSha256 !== options.ifHash) return { stored: false, reason: 'compare_failed' };
    records.set(key, { payload: structuredClone(payload), rawSha256: hash(payload), expiresAt: options.expiresAt || new Date(clock + ttl * 1000).toISOString() }); writes.push({ type, id, ttl, options });
    return { stored: true };
  };
  const companyLoader = async () => {
    companyCalls++;
    if (failSource) throw Object.assign(new Error('SEC temporarily unavailable'), { status: 503 });
    return { cik: CIK, name: 'Fixture Capital', kind: 'filer', filings: amended ? [filing(), filing(2)] : [filing()], archives: [] };
  };
  const cache = () => create13FCache({ enabled: () => true, read, write, now });
  const loader = () => createThirteenFLoader({ now, sharedCache: cache(), companyLoader, fetchSec: transport(requests) });
  return { loader, cache, records, writes, reads, requests, now, read, write, companyCalls: () => companyCalls,
    advance: ms => { clock += ms; }, fail: () => { failSource = true; }, amend: () => { amended = true; } };
}

test('A complete report survives a cold loader through shared storage and latest warms its exact quarter', async () => {
  const f = fixture(), first = await f.loader()(CIK);
  assert.equal(f.requests.length, 3);
  assert.equal(f.writes.filter(row => row.type === THIRTEEN_F_SNAPSHOT_TYPE).length, 2);
  assert.equal(f.writes.find(row => row.type === THIRTEEN_F_FILING_TYPE).ttl, 30 * 86400);
  const repeat = await f.loader()(CIK, { period: PERIOD });
  assert.equal(repeat.cache.status, 'shared');
  assert.equal(repeat.observedAt, first.observedAt);
  assert.equal(repeat.cache.checkedAt, first.cache.checkedAt);
  assert.equal(f.companyCalls(), 1);
  assert.equal(f.requests.length, 3);
});

test('Expired heads recheck metadata, reuse accession documents, and include newly filed amendments', async () => {
  const f = fixture(), load = f.loader();
  await load(CIK);
  f.advance(THIRTEEN_F_FRESH_MS + 1); f.amend();
  const amended = await load(CIK);
  assert.equal(amended.portfolio.totalValueUsd, 2000);
  assert.equal(amended.portfolio.filings.length, 2);
  assert.equal(amended.portfolio.complete, true);
  assert.equal(f.companyCalls(), 2);
  assert.equal(f.requests.length, 6, 'Only the three new accession documents were downloaded');
  assert.equal(amended.cache.status, 'source');
  assert.equal(amended.cache.checkedAt, new Date(f.now()).toISOString());
});

test('Explicit refresh bypasses a fresh head while retaining verified parsed filing documents', async () => {
  const f = fixture(), load = f.loader(); await load(CIK);
  const refreshed = await load(CIK, { refresh: true });
  assert.equal(refreshed.cache.status, 'source');
  assert.equal(f.companyCalls(), 2);
  assert.equal(f.requests.length, 3);
});

test('A failed refresh keeps a clearly stale complete snapshot without renewing its original check or expiry', async () => {
  const f = fixture(), first = await f.loader()(CIK);
  f.advance(THIRTEEN_F_FRESH_MS + 1); f.fail();
  const stale = await f.loader()(CIK);
  assert.equal(stale.cache.status, 'stale'); assert.equal(stale.cache.stale, true);
  assert.equal(stale.cache.checkedAt, first.cache.checkedAt);
  assert.equal(stale.cache.freshUntil, first.cache.freshUntil);
  assert.equal(stale.observedAt, first.observedAt);
  assert.match(stale.cache.message, /last complete report/);
  assert.equal(f.writes.filter(row => row.type === THIRTEEN_F_SNAPSHOT_TYPE).length, 2);
  f.advance(THIRTEEN_F_STALE_MS);
  await assert.rejects(f.loader()(CIK), /SEC temporarily unavailable/);
});

test('Shared report validation rejects identity, future checks, totals, duplicate holdings and altered source chains', async () => {
  const f = fixture(); await f.loader()(CIK);
  const source = await f.cache().readSnapshot(CIK, '');
  assert.equal(valid13FSnapshot(source, CIK, '', f.now()), true);
  for (const mutate of [
    value => { value.cik = '0000000099'; },
    value => { value.data.manager.cik = '0000000099'; },
    value => { value.checkedAt = new Date(f.now() + 1000).toISOString(); },
    value => { value.data.portfolio.totalValueUsd++; },
    value => { value.data.portfolio.holdings.push(value.data.portfolio.holdings[0]); },
    value => { value.data.portfolio.filings[0].tableUrls[0] = 'https://www.sec.gov/other.xml'; },
    value => { value.data.coverage.selectedPeriodComplete = false; },
    value => { value.data.portfolio.complete = false; },
    value => { value.schemaVersion = 'old-parser'; },
  ]) {
    const bad = structuredClone(source); mutate(bad);
    assert.equal(valid13FSnapshot(bad, CIK, '', f.now()), false);
  }
  assert.equal(valid13FSnapshot(source, CIK, '2026-03-31', f.now()), false);
});

test('Parsed filing cache binds parser version, metadata hash, exact cover identity and source reconciliation', async () => {
  const f = fixture(); await f.loader()(CIK);
  const key = thirteenFFilingCacheKey(CIK, filing()), source = f.records.get(`${THIRTEEN_F_FILING_TYPE}:${key}`).payload;
  assert.equal(valid13FFiling(source, CIK, filing(), f.now()), true);
  assert.notEqual(key, thirteenFFilingCacheKey(CIK, { ...filing(), primaryDoc: 'different.xml' }));
  assert.equal(valid13FFiling(source, CIK, filing(2), f.now()), false);
  for (const mutate of [
    value => { value.report.cover.cik = '0000000099'; },
    value => { value.report.cover.tableValueTotalUsd++; },
    value => { value.report.holdings[0].quantityType = 'USD'; },
    value => { value.report.complete = false; },
    value => { value.report.filing.primaryUrl = 'https://www.sec.gov/other.xml'; },
  ]) { const bad = structuredClone(source); mutate(bad); assert.equal(valid13FFiling(bad, CIK, filing(), f.now()), false); }
});

test('A partial source result cannot replace a complete shared snapshot', async () => {
  const f = fixture(), data = await f.loader()(CIK);
  const partial = structuredClone(data); partial.portfolio.complete = false; partial.coverage.selectedPeriodComplete = false;
  assert.equal(await f.cache().writeSnapshot(partial, '', data.cache.checkedAt), false);
  assert.equal(f.writes.filter(row => row.type === THIRTEEN_F_SNAPSHOT_TYPE).length, 2);
});

test('Older snapshot publication cannot roll back a later successful check', async () => {
  const f = fixture(), old = await f.loader()(CIK);
  f.advance(1000); const latest = await f.loader()(CIK, { refresh: true });
  assert.equal(await f.cache().writeSnapshot(old, '', old.cache.checkedAt), false);
  assert.equal((await f.cache().readSnapshot(CIK, '')).checkedAt, latest.cache.checkedAt);
});

test('Preview cache adapter uses bounded local parsed entries without shared reads or writes', async () => {
  let calls = 0;
  const store = create13FCache({ enabled: () => false, read: async () => { calls++; }, write: async () => { calls++; } });
  assert.equal(await store.readSnapshot(CIK, ''), null);
  assert.equal(await store.readFiling(CIK, filing()), null);
  assert.equal(calls, 0);
});

test('Known incomplete evidence invalidates both shared aliases without extending the previous snapshot lifetime', async () => {
  const f = fixture(), old = await f.loader()(CIK);
  const originalExpiry = f.records.get(`${THIRTEEN_F_SNAPSHOT_TYPE}:${CIK}:LATEST`).expiresAt;
  f.advance(1000);
  const store = f.cache(), invalidatedAt = new Date(f.now()).toISOString();
  for (const period of ['', PERIOD]) assert.equal(await store.invalidateSnapshot(CIK, period, PERIOD, invalidatedAt), true);
  assert.equal(f.records.get(`${THIRTEEN_F_SNAPSHOT_TYPE}:${CIK}:LATEST`).expiresAt, originalExpiry);
  assert.equal(await store.writeSnapshot(old, '', old.cache.checkedAt), false);
  f.fail();
  for (const period of ['', PERIOD]) {
    const result = await f.loader()(CIK, { period });
    assert.equal(result.cache.stale, true, 'A formerly fresh head must recheck once later evidence was incomplete');
    assert.equal(result.cache.checkedAt, old.cache.checkedAt);
  }
});

test('A slow older build cannot overwrite a newer in-memory or shared observation', async () => {
  const f = fixture(); let first = true, release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const start = new Promise(resolve => { entered = resolve; });
  const load = createThirteenFLoader({ now: f.now, sharedCache: f.cache(), fetchSec: transport(f.requests), companyLoader: async (_cik, options) => {
    assert.equal(options.refresh, true, 'Rebuilds refresh mutable SEC metadata');
    const isFirst = first; first = false;
    if (isFirst) { entered(); await gate; }
    return { cik: CIK, name: isFirst ? 'Older observation' : 'Newer observation', kind: 'filer', filings: [filing()], archives: [] };
  } });
  const older = load(CIK); await start; f.advance(1000);
  const newer = await load(CIK, { refresh: true });
  release(); await older;
  assert.equal((await load(CIK)).manager.name, 'Newer observation');
  assert.equal((await f.cache().readSnapshot(CIK, '')).data.manager.name, 'Newer observation');
  assert.equal(newer.cache.checkedAt, new Date(f.now()).toISOString());
});

test('An incomplete newly discovered quarter invalidates latest while preserving the older exact quarter', async () => {
  const f = fixture(); await f.loader()(CIK);
  const parsed = f.records.get(`${THIRTEEN_F_FILING_TYPE}:${thirteenFFilingCacheKey(CIK, filing())}`).payload.report;
  f.records.clear();
  const previous = '2026-03-31'; let current = previous, failed = false;
  const store = f.cache();
  const load = createThirteenFLoader({ now: f.now, sharedCache: { ...store, readFiling: async () => {
    const result = structuredClone(parsed); result.cover.period = current; result.filing.reportDate = current;
    if (current === PERIOD) { result.complete = false; result.issues = ['New-quarter information table could not reconcile.']; }
    return result;
  } }, companyLoader: async () => {
    if (failed) throw Object.assign(new Error('SEC temporarily unavailable'), { status: 503 });
    return { cik: CIK, name: 'Fixture Capital', kind: 'filer', filings: [{ ...filing(), reportDate: current }], archives: [] };
  }, fetchSec: async () => { throw new Error('No uncached filing request expected'); } });
  const old = await load(CIK);
  assert.equal(old.selectedPeriod, previous);
  f.advance(1000); current = PERIOD;
  const partial = await load(CIK, { refresh: true });
  assert.equal(partial.portfolio.complete, false);
  assert.equal((await store.readSnapshot(CIK, '')).invalidatedAt, partial.cache.checkedAt);
  assert.equal((await store.readSnapshot(CIK, previous)).invalidatedAt, undefined);
  failed = true;
  assert.equal((await load(CIK)).cache.stale, true);
  assert.equal((await load(CIK, { period: previous })).cache.stale, false);
});

test('13F API accepts only one exact refresh flag and does not treat arbitrary cache busters as supported input', async () => {
  for (const query of ['refresh=0', 'refresh=true', 'refresh=1&refresh=1', 'refresh=', 'fresh=1']) {
    const response = await GET(new Request(`https://example.com/api/fund-13f?cik=${CIK}&${query}`));
    assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});


test('Latest retains a compact pointer while both aliases return all 997 positions from one complete quarter body', async () => {
  const f = fixture(), data = structuredClone(await f.loader()(CIK));
  f.records.clear(); f.writes.length = 0;
  const row = data.portfolio.holdings[0];
  data.portfolio.holdings = Array.from({ length: 997 }, (_, i) => {
    const cusip = String(i).padStart(9, '0');
    return { ...row, cusip, key: `${cusip}|SECURITY|SH` };
  });
  data.portfolio.totalValueUsd = 997000;
  data.portfolio.positionCount = data.portfolio.entryCount = 997;
  data.portfolio.holdings.forEach(holding => { holding.weightPct = holding.valueUsd / data.portfolio.totalValueUsd * 100; });
  data.summary = summarize13FPortfolio(data.portfolio); delete data.summary.holdings;
  const store = f.cache();
  assert.deepEqual(await Promise.all([
    store.writeSnapshot(data, '', data.cache.checkedAt), store.writeSnapshot(data, PERIOD, data.cache.checkedAt),
  ]), [true, true]);
  const snapshots = [...f.records].filter(([key]) => key.startsWith(`${THIRTEEN_F_SNAPSHOT_TYPE}:`));
  assert.equal(snapshots.length, 2);
  const pointer = f.records.get(`${THIRTEEN_F_SNAPSHOT_TYPE}:${CIK}:LATEST`).payload;
  assert.equal(pointer.data, undefined);
  assert.equal(pointer.selectedPeriod, PERIOD);
  assert.ok(Buffer.byteLength(JSON.stringify(pointer)) < 600);
  assert.equal(snapshots.filter(([, record]) => record.payload.data?.portfolio?.holdings).length, 1);
  for (const period of ['', PERIOD]) {
    const restored = await store.readSnapshot(CIK, period);
    assert.equal(restored.data.portfolio.holdings.length, 997);
    assert.deepEqual(restored.data, data);
  }
  assert.equal(f.writes.length, 2, 'Hydration reads do not write or renew either record');
});

test('Legacy full latest snapshots remain readable and migrate only after a valid source check', async () => {
  const f = fixture(); await f.loader()(CIK);
  const source = structuredClone(await f.cache().readSnapshot(CIK, ''));
  const key = `${THIRTEEN_F_SNAPSHOT_TYPE}:${CIK}:LATEST`;
  const legacy = { ...f.records.get(key), payload: source, rawSha256: hash(source) };
  f.records.set(key, legacy);
  const writes = f.writes.length;
  assert.deepEqual(await f.cache().readSnapshot(CIK, ''), source);
  assert.equal(f.writes.length, writes);
  f.advance(1000);
  await f.loader()(CIK, { refresh: true });
  assert.equal(f.records.get(key).payload.schemaVersion, 'edgar.13f-latest-pointer.v1');
  assert.equal(f.records.get(key).payload.data, undefined);
  assert.equal((await f.cache().readSnapshot(CIK, '')).checkedAt, new Date(f.now()).toISOString());
});

test('Latest pointers reject absent, altered, mismatched and expired quarter bodies without fetching sources', async () => {
  const f = fixture(); await f.loader()(CIK);
  const pointerKey = `${THIRTEEN_F_SNAPSHOT_TYPE}:${CIK}:LATEST`, bodyKey = `${THIRTEEN_F_SNAPSHOT_TYPE}:${CIK}:${PERIOD}`;
  const originalPointer = structuredClone(f.records.get(pointerKey)), originalBody = structuredClone(f.records.get(bodyKey));
  const store = f.cache(), writes = f.writes.length, requests = f.requests.length;
  for (const mutate of [
    () => { f.records.delete(bodyKey); },
    () => { f.records.get(pointerKey).payload.dataHash = '0'.repeat(64); },
    () => { f.records.get(pointerKey).payload.sourceChainHash = '0'.repeat(64); },
    () => { f.records.get(pointerKey).payload.selectedPeriod = '2026-03-31'; },
    () => { f.records.get(pointerKey).payload.cik = '0000000001'; },
    () => { f.records.get(pointerKey).payload.checkedAt = new Date(f.now() + 1).toISOString(); },
    () => { f.records.get(bodyKey).payload.data.manager.name = 'Altered manager'; },
    () => { f.records.get(bodyKey).payload.data.portfolio.totalValueUsd++; },
  ]) {
    f.records.set(pointerKey, structuredClone(originalPointer)); f.records.set(bodyKey, structuredClone(originalBody));
    mutate();
    assert.equal(await store.readSnapshot(CIK, ''), null);
  }
  f.records.set(pointerKey, originalPointer); f.records.set(bodyKey, originalBody);
  f.advance(THIRTEEN_F_STALE_MS + 1);
  assert.equal(await store.readSnapshot(CIK, ''), null);
  assert.equal(f.writes.length, writes);
  assert.equal(f.requests.length, requests);
});

test('Failed body persistence never publishes a latest pointer or replaces a legacy fallback', async () => {
  const f = fixture(), data = await f.loader()(CIK);
  const latestKey = `${THIRTEEN_F_SNAPSHOT_TYPE}:${CIK}:LATEST`, bodyKey = `${THIRTEEN_F_SNAPSHOT_TYPE}:${CIK}:${PERIOD}`;
  const legacy = await f.cache().readSnapshot(CIK, '');
  f.records.set(latestKey, { ...f.records.get(latestKey), payload: legacy, rawSha256: hash(legacy) });
  f.records.delete(bodyKey);
  const writes = f.writes.length;
  const store = create13FCache({ enabled: () => true, now: f.now, read: f.read,
    write: async (type, id, ...args) => id === `${CIK}:${PERIOD}` ? { stored: false, reason: 'capacity' } : f.write(type, id, ...args),
  });
  assert.equal(await store.writeSnapshot(data, '', data.cache.checkedAt), false);
  assert.deepEqual(await store.readSnapshot(CIK, ''), legacy);
  assert.equal(f.writes.length, writes);
  f.records.delete(latestKey);
  assert.equal(await store.writeSnapshot(data, '', data.cache.checkedAt), false);
  assert.equal(await store.readSnapshot(CIK, ''), null);
});

test('Independent workers accept only an identical CAS winner before publishing the latest pointer', async () => {
  const f = fixture(), data = await f.loader()(CIK);
  f.records.clear(); f.writes.length = 0;
  let bodyReads = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const read = async (type, id) => {
    if (id === `${CIK}:${PERIOD}` && bodyReads < 2) {
      bodyReads++;
      if (bodyReads === 2) release();
      await barrier; return null;
    }
    return f.read(type, id);
  };
  const caches = [0, 1].map(() => create13FCache({ enabled: () => true, now: f.now, read, write: f.write }));
  assert.deepEqual(await Promise.all(caches.map(store => store.writeSnapshot(data, '', data.cache.checkedAt))), [true, true]);
  assert.equal(f.writes.filter(row => row.id === `${CIK}:${PERIOD}`).length, 1);
  assert.equal(f.writes.filter(row => row.id === `${CIK}:LATEST`).length, 1);
  assert.deepEqual((await caches[0].readSnapshot(CIK, '')).data, data);
});

test('Quarter invalidation reaches latest hydration even when its separate alias invalidation did not persist', async () => {
  const f = fixture(), first = await f.loader()(CIK), store = f.cache();
  f.advance(1000);
  const invalidatedAt = new Date(f.now()).toISOString();
  assert.equal(await store.invalidateSnapshot(CIK, PERIOD, PERIOD, invalidatedAt), true);
  assert.equal(f.records.get(`${THIRTEEN_F_SNAPSHOT_TYPE}:${CIK}:LATEST`).payload.invalidatedAt, undefined);
  const restored = await store.readSnapshot(CIK, '');
  assert.equal(restored.invalidatedAt, invalidatedAt);
  assert.equal(restored.checkedAt, first.cache.checkedAt);
  assert.equal(await store.writeSnapshot(first, '', first.cache.checkedAt), false);
});
