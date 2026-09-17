import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPortfolioMarketComparison, clearPortfolioMarketComparison, readPortfolioMarketComparison, PORTFOLIO_MARKET_COMPARISON_PATH } from '../src/utils/portfolioMarketComparisonClient.js';

const row = { key: 'tff:134741:leveraged-funds', family: 'tff', contract: '134741', group: 'leveraged-funds', status: 'ready' };
const payload = () => ({ schemaVersion: 'edgar.portfolio-market-comparison.v1', status: 'partial', results: [{ ...row, summary: { ...row, netPctOi: 0, weeklyChangePp: 0 } }] });

test('comparison rejects wrong schema, duplicate identities and unmatched contracts', () => {
  for (const value of [{}, { ...payload(), schemaVersion: 'other' }, { ...payload(), results: [payload().results[0], payload().results[0]] },
    { ...payload(), results: [{ ...row, contract: '000000' }] }]) assert.throws(() => readPortfolioMarketComparison(value));
  const mismatch = payload();
  mismatch.results[0].summary.group = 'asset-manager';
  assert.equal(readPortfolioMarketComparison(mismatch).summaries[row.key].status, 'unavailable');
  assert.equal(readPortfolioMarketComparison(payload()).summaries[row.key].summary.netPctOi, 0);
});

test('all portfolios share one public request and a cancelled viewer does not cancel another', async () => {
  const originalFetch = globalThis.fetch;
  clearPortfolioMarketComparison();
  let calls = 0, complete;
  globalThis.fetch = async (path, options) => {
    calls++;
    assert.equal(path, PORTFOLIO_MARKET_COMPARISON_PATH);
    assert.equal(options.body, undefined);
    await new Promise(resolve => { complete = resolve; });
    return Response.json(payload());
  };
  try {
    const controller = new AbortController();
    const cancelled = loadPortfolioMarketComparison({ signal: controller.signal });
    const other = loadPortfolioMarketComparison();
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    complete();
    assert.equal((await other).summaries[row.key].summary.weeklyChangePp, 0);
    await loadPortfolioMarketComparison();
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; clearPortfolioMarketComparison(); }
});
