import test from 'node:test';
import assert from 'node:assert/strict';
import { createFundSnapshotClient, validFundSnapshot, fundSnapshotIsStale } from '../src/utils/fundSnapshotClient.js';
import { parseNport, portfolioSummary, fundDiscoverySummary } from '../src/utils/fundResearch.js';

const CLOCK = Date.parse('2026-09-18T12:00:00Z');
const ACCESSION = '0000036405-26-000001';
function fund(ticker = 'VOO', accession = ACCESSION) {
  const xml = `<edgarSubmission><genInfo><regCik>36405</regCik><regName>Test Trust</regName><seriesName>Correct Fund</seriesName><seriesId>S000002839</seriesId><repPdDate>2026-06-30</repPdDate></genInfo><fundInfo><totAssets>1200</totAssets><totLiabs>200</totLiabs><netAssets>1000</netAssets><cshNotRptdInCorD>0</cshNotRptdInCorD></fundInfo><invstOrSecs>${[100, -20, 'N/A'].map((value, i) => `<invstOrSec><name>Position ${i}</name><valUSD>${value}</valUSD><assetCat>EC</assetCat><invCountry>US</invCountry></invstOrSec>`).join('')}</invstOrSecs></edgarSubmission>`;
  const root = `https://www.sec.gov/Archives/edgar/data/36405/${accession.replaceAll('-', '')}/`;
  const data = { ...parseNport(xml, { cik: '0000036405', seriesId: 'S000002839' }), ticker, classId: 'C000007980',
    status: 'ready', isFund: true, family: null, accession, filingDate: '2026-08-20', form: 'NPORT-P',
    identity: 'SEC series matched', sourceUrl: `${root}primary_doc.xml`, filingUrl: `${root}${accession}-index.html`,
    secUrl: 'https://www.sec.gov/edgar/browse/?CIK=S000002839&owner=exclude', retrievedAt: new Date(CLOCK).toISOString(),
    reports: [{ accession, filingDate: '2026-08-20', reportDate: '2026-06-30', form: 'NPORT-P' }], filings: [] };
  data.summary = portfolioSummary(data);
  return fundDiscoverySummary(data);
}
const response = data => ({ ok: true, json: async () => data });
const pause = () => new Promise(resolve => setImmediate(resolve));

test('compact summaries retain negative and missing data while binding the SEC series, accession, dates and full-portfolio scope', () => {
  const data = fund();
  assert.equal(validFundSnapshot(data, 'VOO', '', CLOCK), true);
  assert.equal(data.topHoldings[1].value, -20);
  assert.equal(data.topHoldings[2].value, null);
  for (const mutate of [
    value => { value.ticker = 'VTI'; },
    value => { value.cik = '0000000001'; },
    value => { value.seriesId = 'S000000001'; },
    value => { value.sourceUrl = 'https://example.com/primary_doc.xml'; },
    value => { value.asOf = '2026-02-31'; },
    value => { value.filingDate = '2026-01-01'; },
    value => { value.retrievedAt = '2027-01-01T00:00:00Z'; },
    value => { value.summaryScope = 'visible-page'; },
    value => { value.summary.assets[0].count = 10; },
    value => { value.holdings = []; },
    value => { value.topHoldings = Array(7).fill(value.topHoldings[0]); },
  ]) {
    const invalid = structuredClone(data); mutate(invalid);
    assert.equal(validFundSnapshot(invalid, 'VOO', '', CLOCK), false);
  }
  assert.equal(validFundSnapshot(data, 'VOO', '0000036405-26-000002', CLOCK), false);
});

test('overlapping loads join the same summary request and continue through a maximum of two active reads', async () => {
  const pending = [], seen = [];
  let active = 0, maxActive = 0, latestProgress;
  const client = createFundSnapshotClient({ now: () => CLOCK, onProgress: value => { latestProgress = value; },
    fetcher: url => {
      const p = new URL(url, 'https://example.com').searchParams;
      assert.equal(p.get('view'), 'summary');
      seen.push(p.get('ticker'));
      active++; maxActive = Math.max(maxActive, active);
      return new Promise(resolve => pending.push(() => { active--; resolve(response(fund(p.get('ticker')))); }));
    } });
  const first = client.load(['VOO', 'VTI', 'VOO', 'BND']);
  const second = client.load(['VTI', 'AGG']);
  assert.deepEqual(seen, ['VOO', 'VTI']);
  assert.equal(client.getStates()['BND:latest'].status, 'loading');
  while (pending.length) { pending.shift()(); await pause(); }
  assert.equal(await first, true); assert.equal(await second, true);
  assert.deepEqual(seen, ['VOO', 'VTI', 'BND', 'AGG']);
  assert.equal(maxActive, 2);
  assert.deepEqual(latestProgress, { busy: false, total: 4, completed: 4, ticker: '', cancelled: false });
  await client.load(['VOO']);
  await client.load(['VOO'], { VOO: ACCESSION });
  assert.equal(seen.length, 4, 'latest responses can reuse the exact report body without another request');
});

test('source staleness survives local reuse and latest requests become eligible again after the short retention', async () => {
  let clock = CLOCK, calls = 0;
  const data = fund();
  data.cache = { checkedAt: new Date(CLOCK).toISOString(), freshUntil: new Date(CLOCK + 1000).toISOString(), stale: true };
  const client = createFundSnapshotClient({ now: () => clock, fetcher: async () => { calls++; return response(data); } });
  await client.load(['VOO']); await client.load(['VOO']);
  assert.equal(calls, 1);
  assert.equal(fundSnapshotIsStale(client.getStates()['VOO:latest'].data, clock), true);
  assert.equal(client.getStates()['VOO:latest'].data.cache.checkedAt, data.cache.checkedAt);
  clock += 60001; await client.load(['VOO']);
  assert.equal(calls, 2);
  assert.equal(fundSnapshotIsStale({ cache: { stale: false, freshUntil: data.cache.freshUntil } }, clock), true);
});

test('only an explicit refresh asks the server to revalidate; discovery and exact-report requests use the prepared read', async () => {
  const requests = [];
  const client = createFundSnapshotClient({ now: () => CLOCK, fetcher: async url => {
    const p = new URL(url, 'https://example.com').searchParams;
    requests.push(Object.fromEntries(p));
    return response(fund(p.get('ticker'), p.get('accession') || ACCESSION));
  } });
  await client.load(['VOO']);
  await client.load(['VOO'], {}, true);
  await client.load(['VTI'], { VTI: ACCESSION });
  assert.equal(requests[0].refresh, undefined);
  assert.equal(requests[1].refresh, '1');
  assert.equal(requests[2].refresh, undefined);
  assert.equal(requests[2].accession, ACCESSION);
  assert.ok(requests.every(row => row.view === 'summary'));
});

test('a malformed response never enters either latest or historical state and automatic retries have a cooldown', async () => {
  let calls = 0;
  const client = createFundSnapshotClient({ now: () => CLOCK, fetcher: async () => { calls++; return response(fund('VTI')); } });
  assert.equal(await client.load(['VOO']), false);
  assert.equal(client.getStates()['VOO:latest'].status, 'error');
  assert.equal(client.getStates()[`VOO:${ACCESSION}`], undefined);
  await client.load(['VOO']); assert.equal(calls, 1);
  await client.load(['VOO'], {}, true); assert.equal(calls, 2);
});

test('a failed refresh keeps the last verified facts and exposes the refresh error', async () => {
  let fail = false;
  const client = createFundSnapshotClient({ now: () => CLOCK, fetcher: async () => {
    if (fail) throw new Error('SEC source temporarily unavailable.');
    return response(fund());
  } });
  await client.load(['VOO']); fail = true;
  assert.equal(await client.load(['VOO'], {}, true), false);
  const state = client.getStates()['VOO:latest'];
  assert.equal(state.status, 'ready');
  assert.equal(state.data.summary.count, 3);
  assert.equal(state.error, 'SEC source temporarily unavailable.');
  assert.equal(state.refreshing, undefined);
});

test('cancel resolves queued and active work, ignores late responses and permits an explicit replacement request', async () => {
  const held = [], calls = [];
  const client = createFundSnapshotClient({ now: () => CLOCK, fetcher: (url, { signal }) => {
    const ticker = new URL(url, 'https://example.com').searchParams.get('ticker'); calls.push(ticker);
    return new Promise(resolve => held.push({ ticker, signal, resolve }));
  } });
  const first = client.load(['VOO', 'VTI', 'BND']);
  client.cancel();
  assert.equal(await first, false);
  assert.deepEqual(calls, ['VOO', 'VTI']);
  assert.ok(held.every(row => row.signal.aborted));
  assert.ok(Object.values(client.getStates()).every(row => row.status === 'cancelled'));
  const next = client.load(['VOO']);
  await pause();
  assert.equal(held.length, 3);
  held[0].resolve(response(fund('VOO', '0000036405-26-000002')));
  held[1].resolve(response(fund('VTI')));
  held[2].resolve(response(fund('VOO')));
  assert.equal(await next, true);
  assert.equal(client.getStates()['VOO:latest'].data.accession, ACCESSION);
  assert.equal(client.getStates()['VTI:latest'].status, 'cancelled');
});

test('an unresponsive transport has a deadline and does not block another fund', async () => {
  const client = createFundSnapshotClient({ now: () => CLOCK, timeoutMs: 10,
    fetcher: url => new URL(url, 'https://example.com').searchParams.get('ticker') === 'VOO'
      ? new Promise(() => {}) : Promise.resolve(response(fund('VTI'))) });
  assert.equal(await client.load(['VOO', 'VTI']), false);
  assert.match(client.getStates()['VOO:latest'].error, /timed out/);
  assert.equal(client.getStates()['VTI:latest'].status, 'ready');
});

test('comparison metadata is validated and retained only under its exact report; state size is bounded', async () => {
  let calls = 0;
  const client = createFundSnapshotClient({ now: () => CLOCK, maxEntries: 4, fetcher: async url => {
    calls++; return response(fund(new URL(url, 'https://example.com').searchParams.get('ticker')));
  } });
  const metadata = fund(); delete metadata.responseScope; delete metadata.topHoldings;
  client.ingest([metadata, { ...metadata, ticker: 'WRONG', cik: '0000000001' }]);
  assert.equal(client.getStates()['VOO:latest'], undefined);
  assert.equal(client.getStates()[`WRONG:${ACCESSION}`], undefined);
  await client.load(['VOO'], { VOO: ACCESSION }); assert.equal(calls, 0);
  await client.load(['VOO', 'VTI', 'BND', 'AGG']);
  assert.ok(Object.keys(client.getStates()).length <= 4);
});

test('explore to compare and back preserves verified leading positions for the same report at equal or newer source checks', async () => {
  let clock = CLOCK;
  const snapshot = fund();
  const client = createFundSnapshotClient({ now: () => clock, fetcher: async () => response(snapshot) });
  await client.load(['VOO']);
  const metadata = structuredClone(snapshot);
  delete metadata.responseScope; delete metadata.topHoldings;
  client.ingest([metadata]);
  assert.deepEqual(client.getStates()[`VOO:${ACCESSION}`].data.topHoldings, snapshot.topHoldings);
  clock += 1000;
  metadata.cache = { checkedAt: new Date(clock).toISOString(), freshUntil: new Date(clock + 3600000).toISOString(), stale: false };
  client.ingest([metadata]);
  const restored = client.getStates()[`VOO:${ACCESSION}`].data;
  assert.deepEqual(restored.topHoldings, snapshot.topHoldings);
  assert.equal(restored.cache.checkedAt, metadata.cache.checkedAt, 'retain the newer source check alongside the compatible preview');
  assert.equal(metadata.topHoldings, undefined, 'do not mutate the ingested API response');
});

test('preview positions never transfer across reports or changed full-portfolio summaries', async () => {
  const snapshot = fund();
  const client = createFundSnapshotClient({ now: () => CLOCK, fetcher: async () => response(snapshot) });
  await client.load(['VOO']);
  const other = fund('VOO', '0000036405-26-000002');
  delete other.responseScope; delete other.topHoldings;
  client.ingest([other]);
  assert.equal(client.getStates()[`VOO:${other.accession}`].data.topHoldings, undefined);
  assert.deepEqual(client.getStates()[`VOO:${ACCESSION}`].data.topHoldings, snapshot.topHoldings);
  const revised = structuredClone(snapshot);
  delete revised.responseScope; delete revised.topHoldings;
  revised.summary.value += 1;
  revised.summary.assets[0].value += 1;
  revised.summary.countries[0].value += 1;
  client.ingest([revised]);
  assert.equal(client.getStates()[`VOO:${ACCESSION}`].data.topHoldings, undefined);
});
