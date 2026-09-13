import test from 'node:test';
import assert from 'node:assert/strict';
import { createTickerDirectoryCache } from '../src/utils/tickerMap.js';

const DAY = 86400000, instant = Date.parse('2026-09-13T12:00:00Z');
const company = { ZZZZ: { cik: '0001234567', name: 'Company outside maintained coverage' } };
const envelope = (kind, data, fetched = instant) => ({ schema: 1, kind, data, fetchedAt: new Date(fetched).toISOString(), expiresAt: new Date(fetched + DAY).toISOString() });

test('a cold instance resolves an outside-500 issuer from the shared full directory without SEC calls or TTL renewal', async () => {
  const cache = createTickerDirectoryCache({ now: () => instant,
    read: async (type, id) => { assert.equal(type, 'sec-directory-v1'); assert.equal(id, 'operating'); return envelope('operating', company); },
    write: async () => { throw new Error('reads do not renew'); }, fetchSec: async () => { throw new Error('must not fetch'); } });
  assert.equal((await cache.get('operating')).ZZZZ.cik, '0001234567');
});

test('directory source fetches are coalesced and persist fresh24h/retained7d metadata after validation', async () => {
  let calls = 0, writes = 0;
  const cache = createTickerDirectoryCache({ now: () => instant, read: async () => null,
    fetchSec: async (url, options) => { calls++; assert.match(url, /company_tickers\.json$/); assert.equal(options.maxBytes, 32 * 1024 * 1024); await new Promise(resolve => setImmediate(resolve)); return Response.json({ 0: { cik_str: 1234567, title: company.ZZZZ.name, ticker: 'ZZZZ' } }); },
    write: async (_type, _id, value, ttl) => { writes++; assert.equal(ttl, 7 * 86400); assert.equal(Date.parse(value.expiresAt) - Date.parse(value.fetchedAt), DAY); return true; } });
  const results = await Promise.all([cache.get('operating'), cache.get('operating')]);
  assert.equal(calls, 1); assert.equal(writes, 1); assert.equal(results[0].ZZZZ.cik, '0001234567');
});

test('directory outage fallback never retains identities past seven days from retrieval', async () => {
  let clock = instant; const prior = envelope('operating', company, instant - 6 * DAY);
  const cache = createTickerDirectoryCache({ now: () => clock, read: async () => prior,
    fetchSec: async () => { throw new Error('SEC down'); }, write: async () => { throw new Error('no stale writes'); } });
  assert.equal((await cache.get('operating')).ZZZZ.cik, '0001234567');
  clock += DAY;
  await assert.rejects(cache.get('operating'), /SEC down/);
});

test('fund directory preserves registrant, series and class identity and rejects ambiguous tickers', async () => {
  const row = [1234567, 'S000000001', 'C000000002', 'ABCFX'];
  let raw = { fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [row] };
  let writes = 0;
  const build = () => createTickerDirectoryCache({ now: () => instant, read: async () => null,
    fetchSec: async () => Response.json(raw), write: async () => { writes++; } });
  assert.deepEqual((await build().get('funds')).ABCFX, { cik: '0001234567', seriesId: 'S000000001', classId: 'C000000002' });
  raw = { ...raw, data: [row, [1234567, 'S000000009', 'C000000008', 'ABCFX']] };
  await assert.rejects(build().get('funds'), /ambiguous/);
  raw = { ...raw, data: [[0, 'S000000001', 'C000000002', 'ABCFX']] };
  await assert.rejects(build().get('funds'), /identity/); assert.equal(writes, 1);
});

test('parenthesized SEC fund aliases remain exact and never overwrite an unparenthesized security', async () => {
  const cache = createTickerDirectoryCache({ now: () => instant, read: async () => null,
    fetchSec: async () => Response.json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [
      [1234567, 'S000000001', 'C000000002', '(NWAKX)'], [1234567, 'S000000001', 'C000000003', 'NWAKX'],
    ] }), write: async () => true });
  const result = await cache.get('funds');
  assert.equal(result['(NWAKX)'].classId, 'C000000002'); assert.equal(result.NWAKX.classId, 'C000000003');
});

test('malformed shared directory falls through to a validated source and never poisons local identity', async () => {
  const cache = createTickerDirectoryCache({ now: () => instant,
    read: async () => envelope('operating', { ZZZZ: { cik: '0000000000', name: 'Wrong' } }),
    fetchSec: async () => Response.json({ 0: { cik_str: 1234567, title: 'Correct', ticker: 'ZZZZ' } }), write: async () => false });
  assert.equal((await cache.get('operating')).ZZZZ.name, 'Correct');
});
