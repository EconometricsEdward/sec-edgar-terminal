import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarketAtlas } from '../src/utils/marketResearchValidation.js';

const factorMetrics = () => Object.fromEntries([
  'revenueGrowth', 'netMargin', 'operatingMargin', 'freeCashFlowMargin', 'equityToAssets', 'cashToAssets',
].map((key) => [key, null]));

function atlas() {
  return {
    version: 'market-research-v3',
    generatedAt: '2026-09-09T12:00:00.000Z',
    requested: 1,
    companies: [{
      version: 'market-research-v3',
      ticker: 'AAPL',
      name: 'Apple Inc.',
      cik: '0000320193',
      sic: '3571',
      observedAt: '2026-09-09T12:00:00.000Z',
      cohorts: ['technology'],
      metrics: { annual: {}, ttm: {} },
      reports: { annual: null, ttm: null },
      filingComparisons: { annual: null, ttm: null },
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
  assert.equal(isMarketAtlas(atlas(), 'market-research-v3'), true);
});

test('Market atlas validation rejects wrong versions and unsafe nested shapes', () => {
  const wrongVersion = atlas();
  wrongVersion.version = 'market-v1';
  assert.equal(isMarketAtlas(wrongVersion, 'market-research-v3'), false);

  const malformed = atlas();
  malformed.companies[0].cohorts = null;
  assert.equal(isMarketAtlas(malformed, 'market-research-v3'), false);
});

test('Market atlas validation checks compact filing comparisons and optional acceptance times', () => {
  const value = atlas();
  const point = {
    end: '2025-12-31', filed: '2026-02-01', acceptedAt: null, form: '10-K',
    accession: '0000000001-26-000001',
    source: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/',
    metrics: factorMetrics(),
    factorSourceAccessions: [],
    factorSourceMasks: Object.keys(factorMetrics()).map(() => '0'),
  };
  value.companies[0].filingComparisons.annual = {
    pointInTime: true,
    cutoff: { filed: point.filed, acceptedAt: null, accession: point.accession },
    current: point,
    prior: { ...point, end: '2024-12-31', filed: '2025-02-01', accession: '0000000001-25-000001', source: 'https://www.sec.gov/Archives/edgar/data/1/000000000125000001/' },
    gapDays: 365,
    changes: factorMetrics(),
  };
  assert.equal(isMarketAtlas(value, 'market-research-v3'), true);
  value.companies[0].filingComparisons.annual.current.acceptedAt = 'not-a-date';
  assert.equal(isMarketAtlas(value, 'market-research-v3'), false);
  value.companies[0].filingComparisons.annual.current.acceptedAt = null;
  delete value.companies[0].filingComparisons.annual.changes.revenueGrowth;
  assert.equal(isMarketAtlas(value, 'market-research-v3'), false);
});
