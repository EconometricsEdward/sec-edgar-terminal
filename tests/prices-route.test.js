import test from 'node:test';
import assert from 'node:assert/strict';
import { GET, parsePriceRequest } from '../src/app/api/prices/route.js';

const now = new Date('2026-09-09T12:00:00.000Z');

test('Price requests have one bounded canonical query representation', () => {
  assert.deepEqual(parsePriceRequest('https://example.test/api/prices?ticker=AAPL', now), {
    ticker: 'AAPL',
    from: '2016-09-09',
    canonicalUrl: 'https://example.test/api/prices?ticker=AAPL',
    isCanonical: true,
  });
  const normalized = parsePriceRequest('https://example.test/api/prices?from=2016-09-09&ticker=aapl', now);
  assert.equal(normalized.canonicalUrl, 'https://example.test/api/prices?ticker=AAPL');
  assert.equal(normalized.isCanonical, false);
});

test('Price requests reject unknown, duplicate, malformed, future, and unbounded dates', () => {
  for (const [query, code] of [
    ['ticker=AAPL&junk=1', 'UNKNOWN_QUERY_PARAMETER'],
    ['ticker=AAPL&ticker=MSFT', 'DUPLICATE_QUERY_PARAMETER'],
    ['ticker=AAPL&from=09-01-2026', 'INVALID_FROM_DATE'],
    ['ticker=AAPL&from=2026-09-09', 'FROM_DATE_NOT_COMPLETE'],
    ['ticker=AAPL&from=2016-09-08', 'LOOKBACK_TOO_LARGE'],
  ]) {
    assert.throws(() => parsePriceRequest(`https://example.test/api/prices?${query}`, now), (error) => error.code === code);
  }
});

test('The public route redirects equivalent valid URLs and returns non-cacheable request errors', async () => {
  const redirect = await GET(new Request('https://example.test/api/prices?ticker=aapl'));
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), 'https://example.test/api/prices?ticker=AAPL');
  const invalid = await GET(new Request('https://example.test/api/prices?ticker=AAPL&from=1900-01-01'));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('cache-control'), 'private, no-store');
});
