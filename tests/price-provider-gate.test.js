import test from 'node:test';
import assert from 'node:assert/strict';

test('A deployed cache miss fails closed before contacting price providers when shared coordination is absent', async () => {
  const originalVercel = process.env.VERCEL;
  const originalKvUrl = process.env.KV_REST_API_URL;
  const originalKvToken = process.env.KV_REST_API_TOKEN;
  const originalUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.VERCEL = '1';
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('No upstream call was expected.');
  };
  try {
    const { loadPriceSeries } = await import(`../src/utils/priceDataServer.js?fail-closed=${Date.now()}`);
    await assert.rejects(
      loadPriceSeries({ ticker: 'AAPL', fromIso: '2025-01-01', now: new Date('2026-09-09T12:00:00.000Z') }),
      (error) => error.code === 'PRICE_PROVIDER_GATE_UNAVAILABLE' && error.status === 503,
    );
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = originalVercel;
    if (originalKvUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = originalKvUrl;
    if (originalKvToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = originalKvToken;
    if (originalUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = originalUpstashUrl;
    if (originalUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = originalUpstashToken;
  }
});
