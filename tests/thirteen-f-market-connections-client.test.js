import test from 'node:test';
import assert from 'node:assert/strict';
import { create13FMarketConnectionClient, create13FMarketConnectionSession, THIRTEEN_F_MARKET_CLIENT_LIMITS } from '../src/utils/thirteenFMarketConnectionsClient.js';

const CIK = '0001747057', PERIOD = '2026-06-30', ISSUER = '0001579091';
function holding(index = 0) {
  const cusip = String(100000000 + index);
  return { key: `${cusip}|SECURITY|SH`, cusip, issuer: `Issuer ${index}`, classTitle: 'COM', putCall: null, quantityType: 'SH', quantity: 100, valueUsd: 10000 - index };
}
function report(count = 1) {
  return { manager: { cik: CIK }, selectedPeriod: PERIOD, portfolio: { cik: CIK, period: PERIOD, complete: true, totalValueUsd: 1000000, holdings: Array.from({ length: count }, (_, index) => holding(index)) }, coverage: { selectedPeriodComplete: true } };
}
function result(item = holding(), overrides = {}) {
  return { schemaVersion: 'edgar.13f-market-connections.v1', manager: { cik: CIK }, selectedPeriod: PERIOD, holding: item, status: 'ready', observedAt: new Date().toISOString(),
    identity: { status: 'resolved', cusip: item.cusip, issuer: { cik: ISSUER, kind: 'company', name: 'Fixture Company' }, evidence: [{ cik: ISSUER, cusips: [item.cusip], url: 'https://www.sec.gov/Archives/edgar/data/1579091/000157909126000001/primary_doc.xml' }] },
    discovery: { schemaVersion: 'edgar.company-exposure-map.v1', cik: ISSUER, status: 'no_matches', checkedAt: new Date().toISOString(), sources: [], rows: [], coverage: { searchComplete: true } }, ...overrides };
}
const request = (item = holding(), extra = {}) => ({ cik: CIK, period: PERIOD, holding: item, signal: new AbortController().signal, ...extra });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function settle() { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); }
function deferredClient() {
  const calls = [];
  return { calls, load(args) { return new Promise((resolve, reject) => calls.push({ ...args, resolve, reject })); } };
}

test('Client cache accepts only the exact manager, quarter, and current holding identity', async () => {
  let calls = 0, current = result();
  const client = create13FMarketConnectionClient({ fetchImpl: async () => { calls++; return json(current); } });
  const first = await client.load(request());
  assert.equal(await client.load(request()), first);
  assert.equal(calls, 1);
  first.identity.cusip = '999999999';
  await client.load(request());
  assert.equal(calls, 2, 'A corrupted cache entry is revalidated and fetched again');
  await client.load(request(holding(), { force: true }));
  assert.equal(calls, 3);
  for (const modify of [value => { value.manager.cik = '0000000001'; }, value => { value.selectedPeriod = '2026-03-31'; }, value => { value.holding.valueUsd++; }, value => { value.identity.evidence[0].cusips = ['999999999']; }]) {
    current = result(); modify(current);
    await assert.rejects(client.load(request(holding(), { force: true })), /did not match/);
  }
  current = result({ ...holding(), valueUsd: 500 });
  await client.load(request(current.holding));
  assert.equal(calls, 8, 'A changed reported holding must have a separately checked response');
  current = result({ ...holding(), quantity: 500 });
  await client.load(request(current.holding));
  assert.equal(calls, 9, 'An amended quantity with unchanged value must not reuse earlier evidence');
});

test('Client cache expires and evicts by both entry and byte limits; failures and partial scans are not cached', async () => {
  let clock = Date.now(), calls = 0, partial = false;
  const sample = result(), bytes = new TextEncoder().encode(JSON.stringify(sample)).byteLength;
  const client = create13FMarketConnectionClient({ now: () => clock, limits: { ...THIRTEEN_F_MARKET_CLIENT_LIMITS, cacheEntries: 2, cacheBytes: bytes * 2 + 100 }, fetchImpl: async url => {
    calls++; const key = new URL(url, 'https://example.test').searchParams.get('key');
    const output = result(holding(Number(key.slice(0, 9)) - 100000000));
    if (partial) { output.discovery.status = 'partial'; output.discovery.coverage.searchComplete = false; }
    return json(output);
  } });
  for (let index = 0; index < 3; index++) await client.load(request(holding(index)));
  assert.equal(client.cacheSize().entries, 2);
  assert.ok(client.cacheSize().bytes <= bytes * 2 + 100);
  await client.load(request(holding(0))); assert.equal(calls, 4);
  clock += 300001;
  await client.load(request(holding(0))); assert.equal(calls, 5);
  partial = true;
  await client.load(request(holding(0), { force: true }));
  await client.load(request(holding(0))); assert.equal(calls, 7);
  const byteClient = create13FMarketConnectionClient({ limits: { ...THIRTEEN_F_MARKET_CLIENT_LIMITS, cacheBytes: bytes + 50 }, fetchImpl: async url => json(result(holding(new URL(url, 'https://example.test').searchParams.get('key').startsWith('100000001') ? 1 : 0))) });
  await byteClient.load(request()); await byteClient.load(request(holding(1)));
  assert.equal(byteClient.cacheSize().entries, 1);
});

test('Client caps declared and streamed responses and has an abortable request deadline', async () => {
  const over = THIRTEEN_F_MARKET_CLIENT_LIMITS.responseBytes + 1;
  let cancelled = false;
  const declared = create13FMarketConnectionClient({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(over) } }) });
  await assert.rejects(declared.load(request()), /supported size/); assert.equal(cancelled, true);
  const streamed = create13FMarketConnectionClient({ fetchImpl: async () => new Response(new Uint8Array(over)) });
  await assert.rejects(streamed.load(request()), /supported size/);
  const timed = create13FMarketConnectionClient({ limits: { ...THIRTEEN_F_MARKET_CLIENT_LIMITS, requestMs: 2 }, fetchImpl: async (_url, { signal }) => { await new Promise(resolve => setTimeout(resolve, 10)); signal.throwIfAborted(); return json(result()); } });
  await assert.rejects(timed.load(request()), { name: 'TimeoutError' });
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const aborted = create13FMarketConnectionClient({ fetchImpl: async () => { calls++; return json(result()); } });
  await assert.rejects(aborted.load(request(holding(), { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('Report session starts only when active, limits the initial scope to 20, and runs at most two requests', async () => {
  let running = 0, max = 0, total = 0;
  const data = report(45);
  const session = create13FMarketConnectionSession(data, { client: { async load({ holding: item }) {
    running++; total++; max = Math.max(max, running);
    await new Promise(resolve => setImmediate(resolve)); running--;
    return result(item);
  } } });
  assert.equal(total, 0); assert.equal(session.getSnapshot().limit, 20);
  session.setActive(true); await settle(); await settle();
  assert.equal(total, 20); assert.equal(max, 2);
  assert.equal(session.getSnapshot().progress, 100);
  assert.equal(session.getSnapshot().results.length, 20);
  session.scanNext(); await settle(); await settle();
  assert.equal(total, 40); assert.equal(session.getSnapshot().limit, 40);
  session.startAll(); await settle();
  assert.equal(total, 45); assert.equal(session.getSnapshot().limit, 45);
});

test('Pause and tab exit abort work; late responses cannot change evidence and resume does not repeat completed holdings', async () => {
  const client = deferredClient(), session = create13FMarketConnectionSession(report(4), { client });
  session.setActive(true); await settle();
  client.calls[0].resolve(result(client.calls[0].holding)); await settle();
  assert.equal(session.getSnapshot().results.length, 1);
  session.pause();
  assert.equal(session.getSnapshot().paused, true); assert.equal(session.getSnapshot().pending, false);
  assert.equal(client.calls[1].signal.aborted, true); assert.equal(client.calls[2].signal.aborted, true);
  client.calls[1].resolve(result(client.calls[1].holding)); await settle();
  assert.equal(session.getSnapshot().results.length, 1);
  session.resume(); await settle();
  assert.equal(client.calls.length, 5);
  assert.ok(client.calls.slice(3).every(call => call.holding.key !== client.calls[0].holding.key));
  session.setActive(false);
  assert.ok(client.calls.slice(3).every(call => call.signal.aborted));
  assert.equal(session.getSnapshot().results.length, 1);
});

test('Retry targets failed or partial holdings without removing completed results or scanning beyond the selected scope', async () => {
  const client = deferredClient(), session = create13FMarketConnectionSession(report(3), { client });
  session.setActive(true); await settle();
  client.calls[0].resolve(result(client.calls[0].holding)); client.calls[1].reject(new Error('SEC temporary failure')); await settle();
  const partial = result(client.calls[2].holding); partial.discovery.status = 'partial'; partial.discovery.coverage.searchComplete = false;
  client.calls[2].resolve(partial); await settle();
  session.retry('999999999|SECURITY|SH'); await settle(); assert.equal(client.calls.length, 3);
  session.retry(); await settle();
  assert.equal(client.calls.length, 5); assert.ok(client.calls.slice(3).every(call => call.force));
  assert.equal(session.getSnapshot().results.length, 3, 'All existing evidence remains visible during retry');
  client.calls[3].resolve(result(client.calls[3].holding)); await settle();
  assert.equal(session.getSnapshot().results.length, 3, 'The first new response does not reset unrelated results');
  client.calls[4].resolve(result(client.calls[4].holding)); await settle();
  assert.ok(session.getSnapshot().results.every(value => value.status === 'ready'));
  assert.equal(session.getSnapshot().progress, 100);
});

test('Refresh retains previous verified evidence on errors and retry can recover that evidence', async () => {
  const client = deferredClient(), session = create13FMarketConnectionSession(report(2), { client });
  session.setActive(true); await settle();
  for (const call of client.calls) call.resolve(result(call.holding)); await settle();
  const originals = session.getSnapshot().results;
  session.refresh(); await settle();
  assert.deepEqual(session.getSnapshot().results, originals);
  client.calls[2].reject(new Error('Temporary refresh failure'));
  const unavailable = result(client.calls[3].holding); unavailable.status = 'unavailable'; unavailable.discovery.status = 'unavailable';
  client.calls[3].resolve(unavailable); await settle();
  assert.deepEqual(session.getSnapshot().results, originals);
  assert.match(session.getSnapshot().error, /Could not refresh 2 holdings/);
  session.retry(); await settle(); assert.equal(client.calls.length, 6);
  for (const call of client.calls.slice(4)) call.resolve(result(call.holding)); await settle();
  assert.equal(session.getSnapshot().error, null);
});

test('Explicit refresh and retry resume a paused scan, and new partial evidence replaces earlier partial evidence', async () => {
  const client = deferredClient(), session = create13FMarketConnectionSession(report(2), { client });
  session.setActive(true); await settle();
  const first = result(client.calls[0].holding); first.discovery.status = 'partial'; first.discovery.coverage.searchComplete = false; first.discovery.message = 'Earlier source coverage';
  client.calls[0].resolve(first); client.calls[1].resolve(result(client.calls[1].holding)); await settle();
  const unchanged = session.getSnapshot().results[1];
  session.pause(); session.retry(); await settle();
  assert.equal(session.getSnapshot().paused, false); assert.equal(client.calls.length, 3);
  const second = result(client.calls[2].holding); second.discovery.status = 'partial'; second.discovery.coverage.searchComplete = false; second.discovery.message = 'New source coverage';
  client.calls[2].resolve(second); await settle();
  assert.equal(session.getSnapshot().results[0].discovery.message, 'New source coverage');
  assert.equal(session.getSnapshot().results[1], unchanged);
  assert.equal(session.getSnapshot().error, null);
  session.pause(); session.refresh(); await settle();
  assert.equal(session.getSnapshot().paused, false); assert.equal(client.calls.length, 5);
  session.setActive(false);
});

test('Sessions reject cross-report results and do not carry observations into a different quarter', async () => {
  const client = deferredClient(), original = report(), next = report(); next.selectedPeriod = '2026-03-31'; next.portfolio.period = next.selectedPeriod;
  const session = create13FMarketConnectionSession(original, { client }); session.setActive(true); await settle();
  session.setActive(false);
  const replacement = create13FMarketConnectionSession(next, { client }); replacement.setActive(true); await settle();
  client.calls[0].resolve(result()); client.calls[1].resolve(result()); await settle();
  assert.equal(session.getSnapshot().results.length, 0);
  assert.equal(replacement.getSnapshot().results[0].status, 'unavailable');
  assert.match(replacement.getSnapshot().results[0].message, /did not match/);
});

test('Active evidence has an explicit memory ceiling that preserves completed research and stops requests', async () => {
  const sampleBytes = new TextEncoder().encode(JSON.stringify(result())).byteLength;
  const client = deferredClient(), session = create13FMarketConnectionSession(report(5), { client, resultsBytes: sampleBytes + 50 });
  session.setActive(true); await settle();
  client.calls[0].resolve(result(client.calls[0].holding)); await settle();
  client.calls[1].resolve(result(client.calls[1].holding)); await settle();
  assert.equal(session.getSnapshot().results.length, 1);
  assert.equal(session.getSnapshot().blocked, true); assert.equal(session.getSnapshot().paused, true);
  assert.match(session.getSnapshot().error, /browser’s evidence limit/);
  assert.equal(client.calls[2].signal.aborted, true);
  session.resume(); session.startAll(); session.scanNext(); await settle();
  assert.equal(client.calls.length, 3);
});
