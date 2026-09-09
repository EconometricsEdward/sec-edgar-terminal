import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarketAtlas } from '../src/utils/marketResearchValidation.js';

function atlas() {
  return {
    version: 'market-v2',
    generatedAt: '2026-09-09T12:00:00.000Z',
    requested: 1,
    companies: [{
      version: 'market-v2',
      ticker: 'AAPL',
      name: 'Apple Inc.',
      cik: '0000320193',
      sic: '3571',
      observedAt: '2026-09-09T12:00:00.000Z',
      cohorts: ['technology'],
      metrics: { annual: {}, ttm: {} },
      reports: { annual: null, ttm: null },
    }],
    cohorts: [{
      id: 'technology',
      label: 'Technology',
      title: 'Technology',
      description: 'Technology issuers',
      disclosureTerms: 'technology',
      tickers: ['AAPL'],
    }],
    failures: [],
    observations: [{
      observedAt: '2026-09-09T12:00:00.000Z',
      companies: 1,
      tickers: ['AAPL'],
      revenueGrowth: { count: 1, median: 2 },
      netMargin: { count: 1, median: 20 },
    }],
    historyPersistence: true,
  };
}

test('Market atlas validation accepts fields consumed by the UI', () => {
  assert.equal(isMarketAtlas(atlas(), 'market-v2'), true);
});

test('Market atlas validation rejects wrong versions and unsafe nested shapes', () => {
  const wrongVersion = atlas();
  wrongVersion.version = 'market-v1';
  assert.equal(isMarketAtlas(wrongVersion, 'market-v2'), false);

  const malformed = atlas();
  malformed.companies[0].cohorts = null;
  assert.equal(isMarketAtlas(malformed, 'market-v2'), false);
});
