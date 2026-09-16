import test from 'node:test';
import assert from 'node:assert/strict';
import { create13FHistoryClient, historyClientSlot, settled13FHistorySlot } from '../src/utils/thirteenFHistoryClient.js';
import { get13FHoldingHistory, summarize13FHistory } from '../src/utils/thirteenFHistory.js';

const CIK = '0001747057', PERIOD = '2026-06-30';
const KEY = '00827B106|SECURITY|SH', OTHER = '02079K305|SECURITY|SH';
const signal = () => new AbortController().signal;
function projection(keys, { cik = CIK, period = PERIOD, ...overrides } = {}) {
  return { cik, period, trackedKeys: keys, positions: Object.fromEntries(keys.map(key => [key, null])), complete: true, comparable: true, confidentialOmitted: false, reportType: '13F HOLDINGS REPORT', totalValueUsd: 1000, positionCount: 8, filings: [{ accessionNumber: '0001747057-26-000001' }], ...overrides };
}
const response = (keys, overrides = {}) => Response.json({ manager: { cik: CIK }, selectedPeriod: PERIOD, status: 'ready', coverage: { selectedPeriodComplete: true }, projection: projection(keys), ...overrides });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

// These tests exercise response identity, cache reuse and abort races directly;
// no implementation-string assertions or live SEC requests are needed.
test('cache reuses only an exact manager/quarter/security match or a validated superset', async () => {
  let calls = 0;
  const client = create13FHistoryClient({ fetcher: async () => { calls++; return response([KEY, OTHER]); } });
  await client.fetchQuarter(CIK, PERIOD, [KEY, OTHER], signal());
  const selected = await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  assert.equal(calls, 1);
  assert.deepEqual(selected.projection.trackedKeys, [KEY, OTHER]);
  assert.equal(client.peek('0000000123', PERIOD, [KEY]), null);
  assert.equal(client.peek(CIK, '2026-03-31', [KEY]), null);
  assert.equal(client.peek(CIK, PERIOD, ['00827B106|PUT|SH']), null);
  assert.equal(client.peek(CIK, PERIOD, ['00827B106|SECURITY|PRN']), null);
});

test('changing positions keeps aggregate charts without inventing an absent holding', async () => {
  const client = create13FHistoryClient({ fetcher: async () => response([KEY]) });
  await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  const slot = historyClientSlot(client, CIK, PERIOD, [OTHER]);
  assert.equal(slot.status, 'ready');
  assert.equal(slot.requestStatus, 'pending');
  assert.equal(slot.projection.totalValueUsd, 1000);
  const observed = get13FHoldingHistory(summarize13FHistory([slot], { cik: CIK }), OTHER).observations[0];
  assert.equal(observed.status, 'unknown');
  assert.equal(observed.quantity, null);
  const original = historyClientSlot(client, CIK, PERIOD, [KEY]);
  assert.equal(original.requestStatus, 'ready');
});

test('separate projections never mix security observations across filing revisions', async () => {
  let calls = 0;
  const client = create13FHistoryClient({ fetcher: async () => ++calls === 1 ? response([KEY]) : response([OTHER], { projection: projection([OTHER], { totalValueUsd: 2000, filings: [{ accessionNumber: 'amended' }] }) }) });
  await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  await client.fetchQuarter(CIK, PERIOD, [OTHER], signal());
  assert.equal(client.peek(CIK, PERIOD, [KEY]), null, 'old observations expire when an amended quarter is seen');
  const replacement = historyClientSlot(client, CIK, PERIOD, [KEY]);
  assert.equal(replacement.projection.totalValueUsd, 2000);
  assert.equal(replacement.requestStatus, 'pending');
  assert.deepEqual(replacement.projection.trackedKeys, [OTHER]);
  const amended = client.peek(CIK, PERIOD, [OTHER]);
  assert.equal(amended.projection.totalValueUsd, 2000);
  assert.deepEqual(amended.projection.trackedKeys, [OTHER]);
  assert.equal(client.peek(CIK, PERIOD, [KEY, OTHER]), null);
});

test('failed selected detail preserves a previously observed quarter and remains retryable', async () => {
  let calls = 0;
  const client = create13FHistoryClient({ fetcher: async () => ++calls === 1 ? response([KEY]) : Response.json({ error: 'SEC temporarily unavailable' }, { status: 502 }) });
  await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  await client.fetchQuarter(CIK, PERIOD, [OTHER], signal());
  const slot = historyClientSlot(client, CIK, PERIOD, [OTHER]);
  assert.equal(slot.status, 'ready');
  assert.equal(slot.requestStatus, 'unavailable');
  assert.match(slot.detailReason, /SEC temporarily/);
  assert.equal(slot.projection.totalValueUsd, 1000);
  const retry = historyClientSlot(client, CIK, PERIOD, [OTHER], { force: true });
  assert.equal(retry.status, 'ready');
  assert.equal(retry.requestStatus, 'pending');
  await client.fetchQuarter(CIK, PERIOD, [OTHER], signal());
  assert.equal(calls, 2, 'a count toggle does not repeat a known failed request');
  await client.fetchQuarter(CIK, PERIOD, [OTHER], signal(), true);
  assert.equal(calls, 3, 'explicit retry bypasses the failure cache');
});

test('failures and stale snapshots expire sooner than fresh complete snapshots', async () => {
  let clock = 0, calls = 0;
  const client = create13FHistoryClient({ now: () => clock, fetcher: async () => ++calls === 1 ? Response.json({ error: 'Retry later' }, { status: 502 }) : response([KEY]) });
  await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  clock = 60001;
  assert.equal(client.peek(CIK, PERIOD, [KEY]), null);
  await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  clock += 60001;
  assert.equal(client.peek(CIK, PERIOD, [KEY]).status, 'ready');
  const stale = create13FHistoryClient({ now: () => clock, fetcher: async () => response([KEY], { projection: projection([KEY], { stale: true }) }) });
  await stale.fetchQuarter(CIK, PERIOD, [KEY], signal());
  clock += 60001;
  assert.equal(stale.peek(CIK, PERIOD, [KEY]), null);
});

test('entry bounds evict the least recently used projection', async () => {
  let clock = 0;
  const client = create13FHistoryClient({ now: () => ++clock, maxEntries: 2, fetcher: async url => {
    const query = new URL(url, 'https://example.com').searchParams;
    return response(JSON.parse(query.get('keys')));
  } });
  const put = '00827B106|PUT|SH';
  await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  await client.fetchQuarter(CIK, PERIOD, [OTHER], signal());
  client.peek(CIK, PERIOD, [KEY]);
  await client.fetchQuarter(CIK, PERIOD, [put], signal());
  assert.equal(client.peek(CIK, PERIOD, [OTHER]), null);
  assert.ok(client.peek(CIK, PERIOD, [KEY]));
  assert.ok(client.peek(CIK, PERIOD, [put]));
});

test('malformed or mismatched observations cannot enter the projection cache', async () => {
  for (const broken of [
    { manager: { cik: '0000000123' } },
    { selectedPeriod: '2026-03-31' },
    { projection: projection([OTHER]) },
    { projection: projection([KEY], { positions: {} }) },
    { projection: projection([KEY], { positions: { [KEY]: { key: OTHER } } }) },
  ]) {
    const client = create13FHistoryClient({ fetcher: async () => response([KEY], broken) });
    const result = await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
    assert.equal(result.status, 'unavailable');
    assert.equal(client.peekSummary(CIK, PERIOD), null);
  }
});

test('aborting one consumer leaves another consumer of the same request active', async () => {
  const pending = deferred();
  let calls = 0, upstream;
  const client = create13FHistoryClient({ fetcher: (url, options) => { calls++; upstream = options.signal; return pending.promise; } });
  const a = new AbortController(), b = new AbortController();
  const first = client.fetchQuarter(CIK, PERIOD, [KEY], a.signal);
  const second = client.fetchQuarter(CIK, PERIOD, [KEY], b.signal);
  const aborted = assert.rejects(first, { name: 'AbortError' });
  a.abort();
  await aborted;
  assert.equal(upstream.aborted, false);
  pending.resolve(response([KEY]));
  assert.equal((await second).status, 'ready');
  assert.equal(calls, 1);
});

test('a changed history window can resubscribe before its compatible request is canceled', async () => {
  const pending = deferred();
  let calls = 0, upstream;
  const client = create13FHistoryClient({ fetcher: (url, options) => { calls++; upstream = options.signal; return pending.promise; } });
  const oldWindow = new AbortController();
  const first = client.fetchQuarter(CIK, PERIOD, [KEY], oldWindow.signal);
  const aborted = assert.rejects(first, { name: 'AbortError' });
  oldWindow.abort();
  const replacement = client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  await aborted;
  assert.equal(upstream.aborted, false);
  pending.resolve(response([KEY]));
  assert.equal((await replacement).status, 'ready');
  assert.equal(calls, 1);
});

test('a late response from an abandoned request cannot populate the cache', async () => {
  const pending = deferred();
  let upstream;
  const client = create13FHistoryClient({ fetcher: (url, options) => { upstream = options.signal; return pending.promise; } });
  const controller = new AbortController();
  const request = client.fetchQuarter(CIK, PERIOD, [KEY], controller.signal);
  const aborted = assert.rejects(request, { name: 'AbortError' });
  controller.abort();
  await aborted;
  await Promise.resolve();
  assert.equal(upstream.aborted, true);
  pending.resolve(response([KEY]));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(client.peek(CIK, PERIOD, [KEY]), null);
});

test('an already aborted consumer starts no request', () => {
  let calls = 0;
  const client = create13FHistoryClient({ fetcher: async () => { calls++; return response([KEY]); } });
  const controller = new AbortController(); controller.abort();
  assert.throws(() => client.fetchQuarter(CIK, PERIOD, [KEY], controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('oversized responses become bounded retryable gaps', async () => {
  const client = create13FHistoryClient({ fetcher: async () => new Response('large', { headers: { 'content-length': String(600 * 1024) } }) });
  const result = await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /supported size/);
});


test('source freshness deadline caps a newly read cache entry without rewriting its dates', async () => {
  let clock = Date.parse('2026-09-16T12:00:00Z');
  const checkedAt = '2026-09-16T11:56:00Z';
  const client = create13FHistoryClient({ now: () => clock, fetcher: async () => response([KEY], { observedAt: checkedAt, cache: { checkedAt, freshUntil: '2026-09-16T12:01:00Z' } }) });
  const result = await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  assert.equal(result.projection.checkedAt, checkedAt);
  assert.equal(result.projection.stale, false);
  clock += 61000;
  assert.equal(client.peek(CIK, PERIOD, [KEY]), null);
  const expired = await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  assert.equal(expired.projection.checkedAt, checkedAt);
  assert.equal(expired.projection.stale, true);
});

test('server coverage and stale metadata cannot become a fresh complete cache entry', async () => {
  for (const overrides of [{ coverage: { selectedPeriodComplete: false } }, { cache: { stale: true } }]) {
    let clock = 0;
    const client = create13FHistoryClient({ now: () => clock, fetcher: async () => response([KEY], overrides) });
    await client.fetchQuarter(CIK, PERIOD, [KEY], signal());
    clock = 60001;
    assert.equal(client.peek(CIK, PERIOD, [KEY]), null);
  }
});


test('a delayed older filing revision cannot evict or deliver over a newer quarter', async () => {
  for (const field of ['checkedAt', 'observedAt']) {
    const oldResponse = deferred();
    const newResponse = deferred();
    let calls = 0;
    const client = create13FHistoryClient({ fetcher: () => ++calls === 1 ? oldResponse.promise : newResponse.promise });
    const older = client.fetchQuarter(CIK, PERIOD, [KEY], signal());
    const newer = client.fetchQuarter(CIK, PERIOD, [OTHER], signal());
    newResponse.resolve(response([OTHER], { projection: projection([OTHER], { [field]: '2026-09-16T20:00:00Z', totalValueUsd: 2000, filings: [{ accessionNumber: 'new-amendment' }] }) }));
    assert.equal((await newer).projection.totalValueUsd, 2000);
    oldResponse.resolve(response([KEY], { projection: projection([KEY], { [field]: '2026-09-16T19:00:00Z', totalValueUsd: 1000, filings: [{ accessionNumber: 'old-original' }] }) }));
    const rejected = await older;
    assert.equal(rejected.status, 'unavailable');
    assert.equal(rejected.projection, undefined, 'the older aggregate is never delivered as a successful result');
    assert.match(rejected.reason, /newer filing snapshot/);
    assert.equal(client.peekSummary(CIK, PERIOD).projection.totalValueUsd, 2000);
    assert.equal(client.peek(CIK, PERIOD, [OTHER]).projection.totalValueUsd, 2000);
    assert.equal(client.peek(CIK, PERIOD, [KEY]).status, 'unavailable');
    const delivered = settled13FHistorySlot(client, CIK, PERIOD, rejected, { status: 'ready', period: PERIOD, projection: projection([KEY], { totalValueUsd: 1000 }) });
    assert.equal(delivered.projection.totalValueUsd, 2000, 'hook settlement uses the newest retained summary, not its pre-request slot');
    assert.equal(delivered.requestStatus, 'unavailable');
    assert.match(delivered.detailReason, /newer filing snapshot/);
    const selected = get13FHoldingHistory(summarize13FHistory([delivered], { cik: CIK }), KEY).observations[0];
    assert.equal(selected.status, 'unknown');
    assert.equal(selected.quantity, null);
    assert.equal(historyClientSlot(client, CIK, PERIOD, [KEY], { force: true }).requestStatus, 'pending');
  }
});

test('a superseded response can return an already saved newer observation for the same security', async () => {
  const pending = deferred();
  let calls = 0;
  const client = create13FHistoryClient({ fetcher: () => ++calls === 1 ? pending.promise : Promise.resolve(response([KEY, OTHER], { projection: projection([KEY, OTHER], { checkedAt: '2026-09-16T20:00:00Z', totalValueUsd: 2000 }) })) });
  const old = client.fetchQuarter(CIK, PERIOD, [KEY], signal());
  await client.fetchQuarter(CIK, PERIOD, [KEY, OTHER], signal());
  pending.resolve(response([KEY], { projection: projection([KEY], { checkedAt: '2026-09-16T19:00:00Z', totalValueUsd: 1000 }) }));
  const result = await old;
  assert.equal(result.status, 'ready');
  assert.equal(result.projection.totalValueUsd, 2000);
  assert.equal(client.peekSummary(CIK, PERIOD).projection.totalValueUsd, 2000);
});
