import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMarketAtlasForClient } from '../src/utils/marketClientProjection.js';

test('Browser Market projection removes server-only filing comparisons without mutating the warm atlas', () => {
  const atlas = {
    version: 'market-research-v3',
    generatedAt: '2026-09-09T00:00:00.000Z',
    cohorts: [{ id: 'software-security' }],
    companies: [{
      ticker: 'MSFT', name: 'Microsoft Corporation', cohorts: ['software-security'],
      metrics: { ttm: { revenue: 1 } }, reports: { ttm: { filed: '2026-07-30' } },
      filingComparisons: { ttm: { current: { accession: 'example' } } },
    }],
  };
  const projected = projectMarketAtlasForClient(atlas);
  assert.notEqual(projected, atlas);
  assert.equal(Object.hasOwn(projected.companies[0], 'filingComparisons'), false);
  assert.equal(projected.companies[0].metrics.ttm.revenue, 1);
  assert.equal(projected.cohorts[0].id, 'software-security');
  assert.equal(atlas.companies[0].filingComparisons.ttm.current.accession, 'example');
  assert.ok(JSON.stringify(projected).length < JSON.stringify(atlas).length);
});
