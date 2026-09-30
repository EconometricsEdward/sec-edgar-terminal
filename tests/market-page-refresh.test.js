import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRefreshMarketPage, MARKET_PAGE_RECHECK_MS } from '../src/utils/marketPlumbing/clientRefresh.js';
const now = Date.parse('2026-09-29T23:00:00Z');
const ready = { availability: 'ready' };
test('fresh ISR snapshot requires no duplicate hydration download', () => {
  assert.equal(shouldRefreshMarketPage(ready, new Date(now).toISOString(), now), false);
  assert.equal(shouldRefreshMarketPage(ready, new Date(now - MARKET_PAGE_RECHECK_MS + 1).toISOString(), now), false);
});
test('expired, future, missing or retained snapshots still refresh', () => {
  for (const checkedAt of [undefined, '', 'invalid', new Date(now + 1).toISOString(), new Date(now - MARKET_PAGE_RECHECK_MS).toISOString()]) {
    assert.equal(shouldRefreshMarketPage(ready, checkedAt, now), true);
  }
  assert.equal(shouldRefreshMarketPage({ availability: 'retained' }, new Date(now).toISOString(), now), true);
  assert.equal(shouldRefreshMarketPage(null, new Date(now).toISOString(), now), true);
});
