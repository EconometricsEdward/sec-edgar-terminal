import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisDirectory } from '../src/utils/analysisDirectory.js';
import { getActiveSecCoverageCompanies } from '../src/utils/secCoverageRegistry.js';

test('Analysis discovery ships at most three examples per sector, using current registry identities', () => {
  const registry = getActiveSecCoverageCompanies();
  const directory = buildAnalysisDirectory(registry);
  assert.equal(directory.length, 11);
  assert.equal(directory[0].sector, 'Information Technology');
  assert.equal(directory.flatMap(group => group.companies).length, 33);
  for (const group of directory) {
    assert.equal(group.companies.length, 3);
    for (const company of group.companies) {
      const current = registry.find(row => row.cik === company.cik);
      assert.equal(company.ticker, current.ticker);
      assert.equal(company.name, current.name);
      assert.equal(group.sector, current.sector);
    }
  }
  const apple = directory[0].companies.find(company => company.ticker === 'AAPL');
  assert.equal(apple.sic, '3571');
  assert.equal(apple.industry, 'Electronic Computers');
});

test('sampler preserves sparse sectors, deduplicates issuers and never invents an industry for unknown identities', () => {
  const members = [{ cik: '0000320193', ticker: 'UPDATED', name: 'Updated identity', sector: 'New sector' },
    { cik: '0000320193', ticker: 'ALIAS', name: 'Duplicate', sector: 'New sector' },
    { cik: '9999999999', ticker: 'AAPL', name: 'Different issuer', sector: 'Unknown' }];
  const before = structuredClone(members);
  const directory = buildAnalysisDirectory(members);
  assert.deepEqual(members, before);
  assert.equal(directory.flatMap(row => row.companies).length, 2);
  assert.equal(directory[0].companies[0].ticker, 'UPDATED');
  assert.equal(directory[0].companies[0].sic, '3571');
  assert.equal(directory[1].companies[0].industry, '');
  assert.deepEqual(buildAnalysisDirectory([]), []);
});
