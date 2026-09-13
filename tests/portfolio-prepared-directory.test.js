import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPortfolioDirectory, runPortfolioResearch } from '../src/utils/portfolioResearchServer.js';
import { createPortfolioRows, resolvePortfolioRows } from '../src/utils/portfolioModel.js';

const active = { issuers: [
  { cik: '0000320193', ticker: 'AAPL', aliases: ['AAPL'], name: 'Apple Inc.' },
  { cik: '0001652044', ticker: 'GOOGL', aliases: ['GOOG', 'GOOGL'], name: 'Alphabet Inc.' },
] };
const input = holdings => ({ holdings, row_choices: [] });
function options(overrides = {}) {
  return { mode: 'supabase', broad: true, loadRegistry: async () => ({ active }),
    loadOperating: async () => { throw new Error('Unexpected live operating directory'); },
    loadFunds: async () => { throw new Error('Unexpected live fund directory'); }, ...overrides };
}

test('fully prepared portfolios resolve without any live SEC directory fetch', async () => {
  const holdings = [{ ticker: 'AAPL' }, { ticker: 'GOOG' }, { cik: '1652044' }, { ticker: 'ACU' }];
  const directory = await loadPortfolioDirectory(input(holdings), options());
  const rows = resolvePortfolioRows(createPortfolioRows(holdings), directory);
  assert.deepEqual(rows.map(row => [row.resolution.cik, row.resolution.ticker]),
    [['0000320193', 'AAPL'], ['0001652044', 'GOOG'], ['0001652044', ''], ['0000002098', 'ACU']]);
  assert.ok(rows.every(row => row.resolution.kind === 'company'));
});

test('unknown tickers, funds, names, and identity conflicts retain full directory classification', async () => {
  for (const holdings of [[{ ticker: 'SPY' }], [{ company_name: 'Apple' }],
    [{ ticker: 'AAPL', cik: '1652044' }], [{ cik: '99999' }], [{ ticker: 'AAPL', company_name: 'Unrelated Company' }]]) {
    let operatingReads = 0, fundReads = 0;
    const directory = await loadPortfolioDirectory(input(holdings), options({
      loadOperating: async () => { operatingReads++; return { AAPL: { cik: '0000320193', name: 'Apple Inc.' } }; },
      loadFunds: async () => { fundReads++; return { SPY: { cik: '0000884394', name: 'SPY fund' } }; },
    }));
    assert.equal(operatingReads, 1); assert.equal(fundReads, 1); assert.equal(directory.SPY.isFund, true);
  }
});

test('a missing fund directory still fails for mixed portfolios instead of misclassifying funds', async () => {
  await assert.rejects(loadPortfolioDirectory(input([{ ticker: 'AAPL' }, { ticker: 'SPY' }]), options({
    loadOperating: async () => ({ AAPL: { cik: '0000320193', name: 'Apple Inc.' } }),
    loadFunds: async () => { throw new Error('Fund directory unavailable'); },
  })), /Fund directory unavailable/);
});

test('rollback and directory-only calls retain their existing complete directory path', async () => {
  for (const request of [undefined, input([{ ticker: 'AAPL' }])]) {
    let registryReads = 0;
    const result = await loadPortfolioDirectory(request, options({ broad: false,
      loadRegistry: async () => { registryReads++; throw new Error('Unused'); },
      loadOperating: async () => ({ AAPL: { cik: '0000320193', name: 'Apple Inc.' } }), loadFunds: async () => ({}),
    }));
    assert.equal(registryReads, 0); assert.equal(result.AAPL.isFund, false);
  }
});

test('portfolio entry point passes the validated request to its directory loader', async () => {
  let received;
  const result = await runPortfolioResearch({ schema_version: 'edgar.portfolio.v1', action: 'resolve', holdings: [{ ticker: ' AAPL ' }] }, {
    loadDirectory: async value => { received = value; return { AAPL: { cik: '0000320193', name: 'Apple Inc.' } }; },
  });
  assert.equal(received.holdings[0].ticker, 'AAPL'); assert.equal(result.coverage.resolvedRows, 1);
});
