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
