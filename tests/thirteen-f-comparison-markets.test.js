import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCompanyExposureMap } from '../src/utils/companyExposure.js';
import { THIRTEEN_F_MARKET_SCHEMA } from '../src/utils/thirteenFMarketConnections.js';
import { comparisonMarketScope, buildComparisonMarkets } from '../src/utils/thirteenFComparisonMarkets.js';

const now = Date.parse('2026-09-15T12:00:00Z'), period = '2026-06-30', cik = '0001747057', otherCik = '0001350694', issuerCik = '0000001234';
const annual = { accession: '0000001234-26-000001', form: '10-K', filed: '2026-02-20', reportDate: '2025-12-31', url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000001/report.htm' };
const quarterly = { accession: '0000001234-26-000002', form: '10-Q', filed: '2026-08-05', reportDate: '2026-06-30', url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000002/report.htm' };
function row(cusip = '123456789', values = [200, 500]) {
  const anchorHolding = { key: `${cusip}|SECURITY|SH`, cusip, issuer: 'Example Corporation', classTitle: 'COM', putCall: null, quantity: 100, quantityType: 'SH', valueUsd: values[0] };
  return { key: anchorHolding.key, cusip, anchorCik: cik, anchorHolding, managerCount: 2, aggregateReportedValueUsd: values[0] + values[1], cells: [cik, otherCik].map((managerCik, index) => ({ cik: managerCik, status: 'reported', valueUsd: values[index], sharePct: index ? 50 : 20 })) };
}
function comparison(rows = [row()]) { return { period, managers: [cik, otherCik].map((managerCik, index) => ({ cik: managerCik, name: `Manager ${index + 1}`, complete: true, percentagesAvailable: true, totalValueUsd: index ? 10000 : 1000 })), sharedHoldings: rows }; }
function result(position = row(), text = 'Our borrowings accrue interest based on SOFR and expose us to changing funding costs.', newer = '') {
  const inputs = [{ text, filing: annual, role: 'annual' }, ...(newer ? [{ text: newer, filing: quarterly, role: 'quarterly' }] : [])];
  const extracted = extractCompanyExposureMap(inputs, { companyName: 'Example Corporation' });
  return { schemaVersion: THIRTEEN_F_MARKET_SCHEMA, status: 'ready', manager: { cik }, selectedPeriod: period, holding: position.anchorHolding, observedAt: new Date(now).toISOString(), identity: { status: 'resolved', cusip: position.cusip, issuer: { cik: issuerCik, name: 'Example Corporation', tickers: ['EXAMPLE'] }, evidence: [{ cik: issuerCik, cusips: [position.cusip] }] }, discovery: { schemaVersion: 'edgar.company-exposure-map.v1', cik: issuerCik, status: extracted.rows.length ? 'ready' : 'no_matches', checkedAt: new Date(now).toISOString(), sources: inputs.map(input => ({ ...input.filing, role: input.role, status: 'ready' })), rows: extracted.rows, coverage: { ...extracted.coverage, searchComplete: true } } };
}
const build = (data, results) => buildComparisonMarkets(data, results, { now });

test('shared market shares use each full manager denominator, never scan totals or transmitted cell weights', () => {
  const model = build(comparison(), [result()]);
  assert.equal(model.markets.length, 1);
  assert.deepEqual(model.markets[0].managers.map(manager => manager.sharePct), [20, 5]);
  assert.deepEqual(model.markets[0].managers.map(manager => manager.valueUsd), [200, 500]);
});

test('the same security contributes once across duplicate channels while different markets retain qualifiers', () => {
  const response = result(row(), 'Our copper purchases and euro-denominated sales create exposure to price and currency changes that affect our costs and revenue.', 'Our exposure to copper purchases is not material to our costs.');
  response.discovery.rows.push(structuredClone(response.discovery.rows[0]));
  const model = build(comparison(), [response, response]);
  assert.equal(model.coverage.linked, 1);
  assert.ok(model.markets.length >= 2);
  assert.ok(model.markets.every(market => market.count === 1 && market.managers[0].sharePct === 20));
  assert.ok(model.markets.some(market => market.members[0].evidence.some(passage => passage.disclosureDirection === 'qualifying-or-negative' && !passage.benchmark)));
});

test('wrong manager, revised holding, mismatched quarter and spoofed passage benchmark cannot establish links', () => {
  const mutations = [value => { value.manager.cik = otherCik; }, value => { value.selectedPeriod = '2026-03-31'; }, value => { value.holding.valueUsd = 201; }, value => { value.discovery.rows[0].evidence[0].benchmark.contract = '043602'; }];
  for (const mutate of mutations) {
    const response = structuredClone(result()); mutate(response);
    const model = build(comparison(), [response]);
    assert.equal(model.markets.length, 0); assert.equal(model.coverage.unavailable, 1);
  }
});

test('unknown comparison coverage stays unknown and incomplete denominators withhold percentages', () => {
  const first = row(), second = row('987654321', [100, 500]);
  second.cells[1] = { cik: otherCik, status: 'unknown', valueUsd: null, sharePct: null };
  const data = comparison([first, second]); data.managers[0].percentagesAvailable = false;
  const model = build(data, [result(first), result(second)]);
  assert.equal(model.markets[0].managers[0].sharePct, null);
  assert.equal(model.markets[0].managers[1].sharePct, null);
  assert.equal(model.markets[0].managers[1].valueUsd, null);
  assert.equal(model.markets[0].managers[1].unknown, true);
});

test('scan is capped, value-prioritized, requires a complete original anchor and excludes options, debt and identified ETFs', () => {
  const rows = Array.from({ length: 14 }, (_, index) => row(String(100000000 + index), [index + 1, index + 1]));
  const options = row('999999991'); options.key = options.anchorHolding.key = '999999991|CALL|SH'; options.anchorHolding.putCall = 'CALL';
  const debt = row('999999992'); debt.key = debt.anchorHolding.key = '999999992|SECURITY|PRN'; debt.anchorHolding.quantityType = 'PRN';
  const etf = row('999999993'); etf.anchorHolding.issuer = 'ISHARES TR';
  const unbound = row('999999994'); unbound.anchorCik = '0000000001';
  const scope = comparisonMarketScope(comparison([...rows, options, debt, etf, unbound]));
  assert.equal(scope.rows.length, 10); assert.equal(scope.eligibleCount, 14);
  assert.equal(scope.rows[0].key, rows.at(-1).key);
  assert.ok(scope.rows.every(position => rows.includes(position)));
});

test('generic drivers remain available without inventing a CFTC market, and source failures differ from no matches', () => {
  const first = row(), second = row('987654321');
  const response = result(first, 'Our variable-rate debt creates interest rate risk through changes in borrowing costs.');
  const model = build(comparison([first, second]), [response, { key: second.key, status: 'unavailable', message: 'SEC temporarily unavailable.' }]);
  assert.equal(model.markets.length, 0); assert.ok(model.drivers.length > 0);
  assert.equal(model.coverage.disclosureOnly, 1); assert.equal(model.coverage.unavailable, 1); assert.equal(model.coverage.noMatches, 0);
});
