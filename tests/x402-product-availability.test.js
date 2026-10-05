import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductAvailabilityHandler } from '../src/utils/x402ProductAvailability.js';

test('free readiness reveals a fixed summary, withholding financial data, quotes and storage fields', async () => {
  const handler = createProductAvailabilityHandler({ example: { select: () => ({ format: 'csv' }), path: '/paid/example', read: async selection => {
    assert.equal(selection.format, 'json');
    return Response.json({ schemaVersion: 'paid.example.v1', stale: true, rows: [{ value: 123456, quote: 'PRIVATE_PAID_QUOTE' }], secret: 'storage-path' });
  } } });
  const response = await handler(new Request('https://example.test/api/x402/availability?product=example'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ready, true);
  assert.equal(body.resultCount, 1);
  assert.equal(body.stale, true);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_PAID_QUOTE|123456|storage-path/);
  assert.equal(response.headers.get('payment-required'), null);
  assert.match(response.headers.get('cache-control'), /no-store/);
});
test('readiness rejects payment credentials and invalid selectors before reading', async () => {
  let calls = 0;
  const handler = createProductAvailabilityHandler({ example: { select: request => new URL(request.url).searchParams.has('bad') ? null : {}, read: async () => { calls++; return Response.json({}); } } });
  for (const request of [new Request('https://example.test/?product=example', { headers: { 'PAYMENT-SIGNATURE': 'private' } }), new Request('https://example.test/?product=example&bad=1'), new Request('https://example.test/?product=missing'), new Request('https://example.test/?product=example&product=example')]) assert.equal((await handler(request)).status, 400);
  assert.equal(calls, 0);
});
test('readiness preserves no-data outcomes and bounds admission without wallet identifiers', async () => {
  const handler = createProductAvailabilityHandler({ example: { select: () => ({}), read: async () => Response.json({ code: 'NO_MATCHING_DATA', secret: 'hidden' }, { status: 404 }) } }, { now: () => 1000 });
  const request = new Request('https://example.test/?product=example');
  for (let i = 0; i < 30; i++) {
    const response = await handler(request);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NO_MATCHING_DATA');
  }
  assert.equal((await handler(request)).status, 429);
});

const request = (id = 'one', extra = '') => new Request(`https://example.test/?product=example&id=${id}${extra}`);
const selection = request => ({ id: new URL(request.url).searchParams.get('id'), format: new URL(request.url).searchParams.get('format') || 'json' });
const ready = () => Response.json({ schemaVersion: 'paid.example.v1', rows: [{ secret: 'PAID_CONTENT' }] });

test('ready summaries reuse JSON/CSV checks for 30 seconds without extending their observation time', async () => {
  let at = 1000, calls = 0;
  const handler = createProductAvailabilityHandler({ example: { select: selection, path: '/paid/example', read: async selected => {
    assert.equal(selected.format, 'json'); calls++;
    return Response.json({ schemaVersion: 'paid.example.v1', stale: false, rows: [{ quote: 'PAID_CONTENT' }] }, { headers: { 'X-Data-Stale': '1', 'X-Content-SHA256': 'private-storage-hash' } });
  } } }, { now: () => at });
  const first = await handler(request()), body = await first.json();
  assert.equal(body.checkedAt, new Date(1000).toISOString());
  assert.equal(body.stale, true);
  at = 30999;
  const hit = await handler(request('one', '&format=csv'));
  assert.deepEqual(await hit.json(), body);
  assert.equal(calls, 1);
  assert.equal(hit.headers.get('cache-control'), 'private, no-store');
  assert.equal(hit.headers.get('x-content-sha256'), null);
  at = 31000;
  const fresh = await (await handler(request())).json();
  assert.equal(calls, 2);
  assert.equal(fresh.checkedAt, new Date(31000).toISOString());
  assert.doesNotMatch(JSON.stringify(fresh), /PAID_CONTENT|private-storage-hash/);
});

test('summary keys use validated selectors and product identity, independent of property or query order', async () => {
  let calls = 0;
  const product = { select: request => {
    const params = new URL(request.url).searchParams;
    return params.has('reverse') ? { format: params.get('format'), filters: { end: '2026-06-30', start: '2026-01-01' }, tickers: ['AAPL', 'MSFT'] }
      : { tickers: ['AAPL', 'MSFT'], filters: { start: '2026-01-01', end: '2026-06-30' }, format: 'json' };
  }, read: async () => { calls++; return ready(); } };
  const handler = createProductAvailabilityHandler({ example: product, second: product }, { now: () => 1000 });
  assert.equal((await handler(request())).status, 200);
  assert.equal((await handler(request('one', '&reverse=1&format=csv'))).status, 200);
  assert.equal(calls, 1);
  const second = await (await handler(new Request('https://example.test/?product=second'))).json();
  assert.equal(second.product, 'second');
  assert.equal(calls, 2);
});

test('identical in-flight checks share one reader while distinct checks retain the four-read concurrency limit', async () => {
  const finish = new Map(); let calls = 0;
  const handler = createProductAvailabilityHandler({ example: { select: selection, read: async ({ id }) => {
    calls++;
    await new Promise(resolve => finish.set(id, resolve));
    return ready();
  } } }, { now: () => 1000 });
  const shared = [handler(request()), handler(request('one', '&format=csv')), handler(request())];
  const distinct = ['two', 'three', 'four'].map(id => handler(request(id)));
  await Promise.resolve();
  assert.equal(calls, 4);
  assert.equal((await handler(request('five'))).status, 429);
  for (const resolve of finish.values()) resolve();
  const responses = await Promise.all([...shared, ...distinct]);
  assert.ok(responses.every(response => response.status === 200));
  assert.deepEqual(await responses[0].json(), await responses[1].json());
  assert.equal(calls, 4);
  assert.equal((await handler(request('four'))).status, 200);
  assert.equal(calls, 4);
});

test('cache hits do not consume reader-start admission and still succeed when the start budget is exhausted', async () => {
  let calls = 0;
  const handler = createProductAvailabilityHandler({ example: { select: selection, read: async () => { calls++; return ready(); } } }, { now: () => 1000 });
  for (let i = 0; i < 60; i++) assert.equal((await handler(request())).status, 200);
  assert.equal(calls, 1);
  for (let i = 1; i < 30; i++) assert.equal((await handler(request(String(i)))).status, 200);
  const busy = await handler(request('31'));
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '60');
  assert.equal(calls, 30);
  assert.equal((await handler(request())).status, 200);
  assert.equal(calls, 30);
});

test('bounded summary storage evicts the least recently used selection and rejects limits above 96', async () => {
  let calls = 0;
  const products = { example: { select: selection, read: async () => { calls++; return ready(); } } };
  const handler = createProductAvailabilityHandler(products, { now: () => 1000, summaryCacheMaxEntries: 3 });
  for (const id of ['one', 'two', 'three', 'one', 'four', 'one']) assert.equal((await handler(request(id))).status, 200);
  assert.equal(calls, 4);
  assert.equal((await handler(request('two'))).status, 200);
  assert.equal(calls, 5);
  for (const limit of [0, 97, 1.5]) assert.throws(() => createProductAvailabilityHandler(products, { summaryCacheMaxEntries: limit }), RangeError);
});

test('no-data and thrown reader errors are never reused, and an expired ready summary cannot hide a failure', async () => {
  let at = 1000, calls = 0;
  const handler = createProductAvailabilityHandler({ example: { select: selection, read: async () => {
    calls++;
    if (calls === 1) return Response.json({ code: 'NO_MATCHING_DATA', secret: 'PAID_CONTENT' }, { status: 404 });
    if (calls === 2) throw new Error('storage credentials');
    if (calls === 4) return Response.json({ code: 'DATA_NOT_PREPARED' }, { status: 503 });
    return ready();
  } } }, { now: () => at });
  const absent = await handler(request());
  assert.equal(absent.status, 404);
  assert.doesNotMatch(JSON.stringify(await absent.json()), /PAID_CONTENT/);
  const failed = await handler(request());
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, 'DATA_NOT_PREPARED');
  assert.equal((await handler(request())).status, 200);
  assert.equal(calls, 3);
  at = 31000;
  assert.equal((await handler(request())).status, 503);
  assert.equal(calls, 4);
  assert.equal((await handler(request())).status, 200);
  assert.equal(calls, 5);
});

test('payment headers and invalid selections cannot use an already warmed summary', async () => {
  let calls = 0;
  const handler = createProductAvailabilityHandler({ example: { select: request => new URL(request.url).searchParams.has('bad') ? null : selection(request), read: async () => { calls++; return ready(); } } });
  assert.equal((await handler(request())).status, 200);
  for (const name of ['PAYMENT-SIGNATURE', 'X-PAYMENT', 'X-X402-Recovery-Token']) {
    assert.equal((await handler(new Request(request(), { headers: { [name]: 'private' } }))).status, 400);
  }
  for (const extra of ['&bad=1', '&product=example']) assert.equal((await handler(request('one', extra))).status, 400);
  assert.equal(calls, 1);
  assert.equal((await handler(request())).status, 200);
  assert.equal(calls, 1);
});

test('data versions require a stable lowercase 64-hex snapshot identity and new cohort arrays remain summaries', async () => {
  const version = 'a'.repeat(64);
  const fixtures = [
    { snapshot: version, banks: [{ name: 'PAID_BANK_DATA' }, {}] },
    { snapshot: { id: version, storage: 'PAID_STORAGE' }, issuers: [{ quote: 'PAID_QUOTE' }] },
    { snapshot: { id: 'invalid', hash: version } },
    { snapshot: 'a'.repeat(63) }, { snapshot: 'A'.repeat(64) }, { snapshot: { id: 'private-storage-path' } },
    { pagination: { snapshot: version } }, { evidenceCatalog: [{ text: 'PAID_EVIDENCE' }, {}, {}] },
  ];
  const handler = createProductAvailabilityHandler({ example: { select: selection, read: async ({ id }) => Response.json({ schemaVersion: 'paid.example.v1', ...fixtures[Number(id)] }) } });
  for (let i = 0; i < fixtures.length; i++) {
    const body = await (await handler(request(String(i)))).json();
    assert.equal(body.dataVersion, i < 3 ? version : undefined);
    assert.equal(body.resultCount, i === 0 ? 2 : i === 1 ? 1 : i === 7 ? 3 : null);
    assert.doesNotMatch(JSON.stringify(body), /PAID_BANK_DATA|PAID_STORAGE|PAID_QUOTE|PAID_EVIDENCE|private-storage-path/);
  }
});
