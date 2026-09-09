import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKET_SIGNALS_METHODOLOGY_VERSION,
  MARKET_SIGNALS_SCHEMA_VERSION,
  validateMarketSignalOptions,
} from '../src/utils/marketSignalsServer.js';

test('Market signal request options normalize and constrain the public model surface', () => {
  assert.equal(MARKET_SIGNALS_SCHEMA_VERSION, 'edgar.market-signals.v1');
  assert.equal(MARKET_SIGNALS_METHODOLOGY_VERSION, 'market-signals-1.1.0');
  assert.deepEqual(validateMarketSignalOptions({ ticker: ' nvda ', window: '5y', basis: 'annual', cohort: 'ai-infrastructure', sectorProxy: 'xlk' }), {
    ticker: 'NVDA', window: '5y', basis: 'annual', cohort: 'ai-infrastructure', sectorProxy: 'XLK',
  });
  assert.deepEqual(validateMarketSignalOptions({ ticker: 'JPM' }), {
    ticker: 'JPM', window: '3y', basis: 'ttm', cohort: 'auto', sectorProxy: 'auto',
  });
  assert.equal(validateMarketSignalOptions({ ticker: 'NVDA', sectorProxy: 'AUTO' }).sectorProxy, 'auto');
  assert.equal(validateMarketSignalOptions({ ticker: 'NVDA', sectorProxy: 'auto' }).sectorProxy, 'auto');
});

test('Market signal request options reject unbounded symbols and settings', () => {
  for (const input of [
    { ticker: '../SPY' },
    { ticker: 'NVDA', window: '10y' },
    { ticker: 'NVDA', basis: 'quarterly' },
    { ticker: 'NVDA', cohort: 'made-up' },
    { ticker: 'NVDA', sectorProxy: 'QQQ' },
  ]) assert.throws(() => validateMarketSignalOptions(input), (error) => error.status === 400 && typeof error.code === 'string');
});
