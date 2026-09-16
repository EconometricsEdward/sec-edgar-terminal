import test from 'node:test';
import assert from 'node:assert/strict';
import { publicFundResponse } from '../src/utils/fundPublicResponse.js';
const now = Date.parse('2026-09-16T12:00:00Z');
const summary = { status: 'ready', stale: false, freshUntil: new Date(now + 3600000).toISOString(), checkedAt: new Date(now).toISOString() };
const request = etag => new Request('https://example.com/api/v1/managers/0001350694', { headers: etag ? { 'If-None-Match': etag } : {} });

test('unchanged public research supports conditional GET without sending its body again', async () => {
  const first = publicFundResponse(request(), summary, now), etag = first.headers.get('etag');
  assert.deepEqual(await first.json(), summary);
  const unchanged = publicFundResponse(request(`"other", ${etag}`), summary, now);
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  assert.equal(publicFundResponse(request(etag), { ...summary, stale: true }, now).status, 200);
});

test('shared caching cannot extend a fresh flag past its original check window', () => {
  assert.match(publicFundResponse(request(), summary, now).headers.get('cache-control'), /s-maxage=300, stale-while-revalidate=60/);
  const soon = { ...summary, freshUntil: new Date(now + 20000).toISOString() };
  assert.match(publicFundResponse(request(), soon, now).headers.get('cache-control'), /s-maxage=20, stale-while-revalidate=0/);
  assert.match(publicFundResponse(request(), { ...summary, stale: true }, now).headers.get('cache-control'), /s-maxage=60, stale-while-revalidate=60/);
  assert.match(publicFundResponse(request(), { ...summary, freshUntil: null }, now).headers.get('cache-control'), /s-maxage=0, stale-while-revalidate=0/);
});
