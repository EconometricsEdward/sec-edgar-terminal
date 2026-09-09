import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, rateLimitHeaders, rateLimitedResponse } from '../src/utils/rateLimit.js';

test('rate-limit responses are non-cacheable and expose standard quota headers', async () => {
  const info = { limit: 20, remaining: 0, resetAt: Date.now() + 2500 };
  const headers = rateLimitHeaders(info);
  assert.equal(headers['RateLimit-Limit'], '20');
  assert.equal(headers['RateLimit-Remaining'], '0');
  assert.ok(Number(headers['RateLimit-Reset']) >= 1);

  const response = rateLimitedResponse(info);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('ratelimit-limit'), '20');
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
  assert.match((await response.json()).error, /Rate limit exceeded/);
});

test('weighted limits reject fractional costs before touching storage', async () => {
  await assert.rejects(
    checkRateLimit({ key: 'test', windowMs: 1000, max: 10, cost: 1.5 }),
    /positive safe integer/,
  );
});
