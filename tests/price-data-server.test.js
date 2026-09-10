import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PriceDataError,
  loadPriceSeries,
  normalizePriceTicker,
  parsePriceRetryAfter,
  readBoundedPriceText,
  parseStooqCsv,
  parseYahooPayload,
  warmYahooSeries,
  yahooWarmEnvelope,
} from '../src/utils/priceDataServer.js';

test('Yahoo parsing preserves adjusted and raw closes with separate provenance semantics', () => {
  const result = parseYahooPayload({ chart: { result: [{
    timestamp: [Date.parse('2026-01-02T00:00:00Z') / 1000, Date.parse('2026-01-05T00:00:00Z') / 1000],
    indicators: {
      quote: [{ open: [99, 103], high: [102, 105], low: [98, 101], close: [100, 104], volume: [10, 20] }],
      adjclose: [{ adjclose: [50, 52] }],
    },
  }] } }, '2026-01-01');
  assert.equal(result.provider, 'yahoo_finance');
  assert.equal(result.priceBasis, 'adjusted_close');
  assert.equal(result.adjustmentCoverage, 1);
  assert.deepEqual(result.prices.map((row) => [row.close, row.adjustedClose, row.rawClose]), [[50, 50, 100], [52, 52, 104]]);
});

test('Yahoo mixed adjusted coverage is explicit instead of silently claiming adjusted close', () => {
  const result = parseYahooPayload({ chart: { result: [{
    timestamp: [Date.parse('2026-01-02T00:00:00Z') / 1000, Date.parse('2026-01-05T00:00:00Z') / 1000],
    indicators: { quote: [{ close: [100, 104] }], adjclose: [{ adjclose: [50, null] }] },
  }] } });
  assert.equal(result.priceBasis, 'mixed_adjusted_and_raw_close');
  assert.equal(result.adjustmentCoverage, 0.5);
  assert.deepEqual(result.prices.map((row) => row.close), [50, 104]);
});

test('Warm Yahoo caches retain a fixed completed-session boundary', () => {
  const raw = { chart: { result: [{
    timestamp: [Date.parse('2026-01-02T00:00:00Z') / 1000, Date.parse('2026-01-05T00:00:00Z') / 1000],
    indicators: {
      quote: [{ close: [100, 104] }],
      adjclose: [{ adjclose: [100, 104] }],
    },
  }] } };
  const parsed = parseYahooPayload(raw, '2026-01-01');
  const envelope = yahooWarmEnvelope(raw, parsed, '2026-01-05', '2026-01-05T19:00:00.000Z');
  assert.equal(envelope.completedThrough, '2026-01-02');
  const warm = warmYahooSeries(envelope, '2026-01-01');
  assert.deepEqual(warm.prices.map((row) => row.date), ['2026-01-02']);
  assert.equal(warm.retrievedAt, '2026-01-05T19:00:00.000Z');
  assert.throws(
    () => warmYahooSeries(raw, '2026-01-01'),
    (error) => error.code === 'PRICE_WARM_CACHE_LEGACY',
  );
});

test('Stooq parsing marks its adjustment treatment unverified and rejects invalid calendar dates', () => {
  const csv = [
    'Date,Open,High,Low,Close,Volume',
    '2026-02-30,1,2,1,2,10',
    '2026-03-02,10,11,9,10.5,1200',
  ].join('\n').padEnd(80, ' ');
  const result = parseStooqCsv(csv, '2026-01-01');
  assert.equal(result.provider, 'stooq');
  assert.equal(result.priceBasis, 'provider_close_adjustment_unverified');
  assert.equal(result.adjustmentCoverage, 0);
  assert.deepEqual(result.prices.map((row) => row.date), ['2026-03-02']);
});

test('Price parser errors and ticker validation are stable and explicit', () => {
  assert.equal(normalizePriceTicker(' brk.b '), 'BRK.B');
  assert.equal(normalizePriceTicker('../spy'), null);
  assert.throws(() => parseYahooPayload({ chart: { result: [] } }), PriceDataError);
  assert.throws(() => parseStooqCsv('<html>blocked</html>'), PriceDataError);
});

test('Price-provider Retry-After parsing accepts seconds and HTTP dates with a bounded cooldown', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z');
  assert.equal(parsePriceRetryAfter('7', now), 7_000);
  assert.equal(parsePriceRetryAfter('Wed, 09 Sep 2026 12:00:09 GMT', now), 9_000);
  assert.equal(parsePriceRetryAfter('999999', now), 300_000);
  assert.equal(parsePriceRetryAfter('invalid', now), null);
});

test('Price-provider bodies are rejected before or during consumption when they exceed the cap', async () => {
  await assert.rejects(
    readBoundedPriceText(new Response('too large', { headers: { 'Content-Length': '9' } }), 8),
    (error) => error.code === 'PRICE_PROVIDER_RESPONSE_TOO_LARGE',
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('1234'));
      controller.enqueue(new TextEncoder().encode('5678'));
      controller.close();
    },
  });
  await assert.rejects(
    readBoundedPriceText(new Response(stream), 7),
    (error) => error.code === 'PRICE_PROVIDER_RESPONSE_TOO_LARGE',
  );
});

test('adjusted-only universe refresh does not contact an unverified fallback provider', async () => {
  const original=globalThis.fetch, urls=[];
  globalThis.fetch=async url=>{urls.push(String(url));return new Response('{}',{status:404});};
  try{await assert.rejects(loadPriceSeries({ticker:'ADJTEST',fromIso:'2025-01-01',now:new Date('2026-09-10'),forceRefresh:true,allowUnverifiedFallback:false}));assert.ok(urls.length>0);assert.ok(urls.every(url=>url.includes('finance.yahoo.com')));}
  finally{globalThis.fetch=original;}
});
