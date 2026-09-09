import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _test,
  compactFactorContext,
  factorComparisonCsv,
  factorComparisonSnapshot,
  factorContextText,
  factorFileStem,
  factorTidyCsv,
  parseFactorComparisons,
} from '../src/utils/marketFactorExports.js';

const fixture = {
  schema_version: 'edgar.market-signals.v1',
  methodology_version: 'market-signals-1.1.0',
  snapshot_id: 'market-v3:abc',
  data_through: '2026-09-08',
  request: { ticker: 'MSFT', window: '3y', basis: 'ttm', cohort: 'software-security', sector_proxy: 'XLK' },
  issuer: { ticker: 'MSFT', name: 'Microsoft Corporation' },
  estimates: {
    market_model: { beta: 1.05, beta_confidence_interval95: [0.98, 1.12], r_squared: 0.42, residual_volatility_annualized: 0.18 },
    conditional_beta: { upside: { beta: 0.9 }, downside: { beta: 1.2 } },
    independent_sector_sensitivity: { independent_sector_beta: 0.4 },
    beta_term_structure: [{ window: '1y', available: true, beta: 1.1 }],
    rolling_beta: { points: [{ date: '2026-09-08', beta: 1.02 }] },
  },
  edgar_snapshot: { filing_change_z: 0.7, components: [{ key: 'revenue', weighted_z: 0.2 }] },
  filing_event: { windows: { 20: { cumulative_abnormal_return: 0.03, standardized_response: 0.6, through: '2026-09-01' } } },
  evidence_gap: { evidence_gap: 0.1 },
  quality: { grade: 'A', gates: [{ id: 'sample', status: 'pass', value: '700', requirement: '126' }] },
  measurement: { returns: 'daily decimal log returns', filing_changes: 'percentage points' },
  provenance: {
    sec: { source: 'https://data.sec.gov/example', reporting_basis: 'ttm', point_in_time: true, current_filing: { accession: '0000000001-26-000001', filed: '2026-08-01' }, prior_filing: null },
    prices: { asset: { ticker: 'MSFT', provider: 'yahoo_finance', price_basis: 'adjusted_close', adjustment_coverage: 1, observations: 700, last_observation: '2026-09-08' } },
  },
  warnings: [],
  links: { api: 'https://secedgarterminal.com/api/v1/market-signals?ticker=MSFT', methodology: 'https://secedgarterminal.com/market/factors' },
  cite_as: 'EDGAR Terminal sample.',
};

test('Factor handoff uses deterministic reproducible names and a compact versioned context', () => {
  assert.equal(factorFileStem(fixture), 'MSFT-factor-lab-3y-ttm-XLK-2026-09-08');
  const context = compactFactorContext(fixture);
  assert.equal(context.format_version, 'edgar.factor-context.v1');
  assert.equal(context.identity.snapshot_id, fixture.snapshot_id);
  assert.equal(context.identity.methodology_version, fixture.methodology_version);
  assert.equal(context.measurement.returns, 'daily decimal log returns');
  assert.equal(context.provenance.prices.asset.provider, 'yahoo_finance');
  assert.equal(Object.hasOwn(context.headline.rolling_beta || {}, 'points'), false);
  assert.match(factorContextText(fixture), /prohibited_claims/);
});

test('Tidy CSV retains raw decimals, stable domains, CRLF rows, and spreadsheet-safe cells', () => {
  const output = factorTidyCsv(fixture);
  assert.match(output, /regression_summary,beta,3y,1.05,unitless/);
  assert.match(output, /filing_event,standardized_response,20,0.6,unitless/);
  assert.match(output, /rolling_beta,beta,2026-09-08,1.02,unitless/);
  assert.match(output, /conditional_beta,downside_beta/);
  assert.match(output, /price_provenance,asset\.observations/);
  assert.ok(output.endsWith('\r\n'));
  assert.equal(_test.csvCell(-0.43), '-0.43');
  assert.equal(_test.csvCell('-0.43'), "'-0.43");
  assert.equal(_test.csvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(_test.csvCell('\t=SUM(A1:A2)'), "'\t=SUM(A1:A2)");
  assert.equal(_test.csvCell('\r=SUM(A1:A2)'), '"\'\r=SUM(A1:A2)"');
  assert.equal(_test.csvCell(' =SUM(A1:A2)'), "' =SUM(A1:A2)");
  assert.equal(_test.csvCell('\uFEFF=SUM(A1:A2)'), "'\uFEFF=SUM(A1:A2)");
  assert.equal(_test.csvCell('a,"b"'), '"a,""b"""');
});

test('Comparison snapshots and CSV preserve like-for-like settings and identifiers', () => {
  const snapshot = factorComparisonSnapshot(fixture);
  assert.equal(snapshot.beta, 1.05);
  assert.equal(snapshot.downside_beta, 1.2);
  const output = factorComparisonCsv([snapshot]);
  assert.match(output, /MSFT,Microsoft Corporation,3y,ttm,software-security,XLK/);
  assert.match(output, /market-v3:abc/);
  assert.equal(parseFactorComparisons(JSON.stringify([snapshot]))[0].ticker, 'MSFT');
  assert.deepEqual(parseFactorComparisons('{not-json'), []);
  assert.deepEqual(parseFactorComparisons(JSON.stringify([{ ...snapshot, ticker: '=BAD' }])), []);
  assert.deepEqual(parseFactorComparisons('x'.repeat(100_001)), []);
});
