import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCompanyExposureMap } from '../src/utils/companyExposure.js';
import { buildThirteenFMarketConnections, is13FMarketConnectionResult, THIRTEEN_F_MARKET_SCHEMA } from '../src/utils/thirteenFMarketConnections.js';

const now = Date.parse('2026-09-15T12:00:00Z'), cik = '0001747057', issuerCik = '0000001234', period = '2026-06-30';
const annual = { accession: '0000001234-26-000001', form: '10-K', filed: '2026-02-20', reportDate: '2025-12-31', url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000001/report.htm' };
const quarterly = { accession: '0000001234-26-000002', form: '10-Q', filed: '2026-08-05', reportDate: '2026-06-30', url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000002/report.htm' };
const holding = (cusip = '123456789', valueUsd = 200, putCall = null) => ({ key: `${cusip}|${putCall || 'SECURITY'}|SH`, cusip, issuer: 'Example Corporation', classTitle: 'COM', putCall, quantityType: 'SH', valueUsd });
function report(holdings = [holding(), holding('987654321', 800)]) { return { manager: { cik }, selectedPeriod: period, portfolio: { cik, period, holdings, totalValueUsd: holdings.reduce((sum, row) => sum + row.valueUsd, 0), complete: true, comparable: false }, coverage: { selectedPeriodComplete: true } }; }
function result(position = holding(), text = 'Our borrowings accrue interest based on SOFR and expose us to changing funding costs.', newer = '') {
  const inputs = [{ text, filing: annual, role: 'annual' }, ...(newer ? [{ text: newer, filing: quarterly, role: 'quarterly' }] : [])];
  const extracted = extractCompanyExposureMap(inputs, { companyName: 'Example Corporation' });
  return { schemaVersion: THIRTEEN_F_MARKET_SCHEMA, status: 'ready', manager: { cik }, selectedPeriod: period, holding: position, observedAt: new Date(now).toISOString(),
    identity: { status: 'resolved', cusip: position.cusip, issuer: { cik: issuerCik, name: 'Example Corporation', tickers: ['EXAMPLE'] }, evidence: [{ cik: issuerCik, cusips: [position.cusip] }] },
    discovery: { schemaVersion: 'edgar.company-exposure-map.v1', cik: issuerCik, companyName: 'Example Corporation', status: extracted.rows.length ? 'ready' : 'no_matches', checkedAt: new Date(now).toISOString(), generatedAt: new Date(now).toISOString(),
      sources: inputs.map(input => ({ ...input.filing, role: input.role, status: 'ready' })), rows: extracted.rows, coverage: { ...extracted.coverage, searchComplete: true } } };
}
const build = (data, results) => buildThirteenFMarketConnections(data, results, { now });

test('a partial scan retains the full public 13F denominator, even when reports are not comparable', () => {
  const data = report(), model = build(data, [result()]);
  assert.equal(model.denominatorUsd, 1000);
  assert.equal(model.markets.length, 1);
  assert.equal(model.markets[0].sharePct, 20);
  assert.equal(model.coverage.linkedSharePct, 20);
  assert.equal(model.coverage.checkedSharePct, 20);
  assert.equal(model.coverage.unchecked, 1);
  assert.equal(model.positions[0].status, 'unchecked'); // Value priority remains visible.
});

test('duplicate channels, passages and overlapping markets never inflate linked holdings', () => {
  const response = result(holding(), 'Our SOFR-linked borrowings and investments create exposure to changes in interest rates. Our euro-denominated sales expose us to movements in currency exchange rates.');
  assert.ok(response.discovery.rows.length >= 3);
  const model = build(report(), [response, response]);
  assert.equal(model.coverage.linked, 1);
  assert.equal(model.coverage.linkedSharePct, 20);
  assert.equal(model.markets.length, 2);
  assert.ok(model.markets.every(market => market.count === 1 && market.sharePct === 20));
});

test('separate share classes and put/call positions count once each without netting options', () => {
  const rows = [holding('123456789', 100), holding('123456789', 200, 'PUT'), holding('987654321', 300), holding('456789123', 400)];
  const model = build(report(rows), rows.slice(0, 3).map(item => result(item)));
  assert.equal(model.markets[0].count, 3);
  assert.equal(model.markets[0].issuerCount, 1);
  assert.equal(model.markets[0].valueUsd, 600);
  assert.equal(model.markets[0].sharePct, 60);
  assert.equal(model.markets[0].members.find(member => member.putCall === 'PUT').sharePct, 20);
});

test('an incomplete public portfolio withholds every percentage while preserving SEC links', () => {
  const data = report(); data.portfolio.complete = false;
  const model = build(data, [result()]);
  assert.equal(model.percentagesAvailable, false);
  assert.equal(model.coverage.linkedSharePct, null);
  assert.equal(model.markets[0].sharePct, null);
  assert.equal(model.markets[0].members[0].sharePct, null);
  assert.ok(model.markets[0].members[0].evidence.length);
});

test('generic rates, Brent and LNG remain useful SEC drivers without substituted CFTC contracts', () => {
  const response = result(holding(), 'Our variable-rate debt creates interest rate risk through changes in borrowing costs. Our crude oil production is sold under prices linked to Brent. Our liquefied natural gas sales are linked to TTF pricing in European markets.');
  const model = build(report(), [response]);
  assert.equal(model.markets.length, 0);
  assert.ok(model.unmapped.some(driver => driver.key === 'unmapped:interest-rates'));
  assert.ok(model.unmapped.some(driver => driver.key === 'unmapped:brent'));
  assert.ok(model.unmapped.some(driver => driver.key === 'unmapped:lng'));
  assert.equal(model.coverage.disclosureOnly, 1);
  assert.equal(model.coverage.linkedSharePct, 0);
});

test('later qualifications remain attached to the original connection with their own date', () => {
  const response = result(holding(), 'Our copper purchases are subject to price changes and increase our manufacturing costs.', 'Our exposure to copper purchases is not material to our costs.');
  const model = build(report(), [response]), member = model.markets[0].members[0];
  assert.equal(member.qualifierCount, 1);
  assert.equal(member.evidence[0].disclosureDirection, 'qualifying-or-negative');
  assert.equal(member.evidence[0].filed, '2026-08-05');
  assert.equal(member.evidence[0].benchmark, null);
  assert.ok(member.evidence.some(evidence => evidence.disclosureDirection === 'connection' && evidence.benchmark.contract === '085692'));
});

test('benchmark attribution follows the supporting passage, never a row-level inherited label', () => {
  const response = result();
  const other = result(holding(), 'Our euro-denominated sales expose us to currency movements and affect our revenue.').discovery.rows[0].benchmark;
  response.discovery.rows[0].benchmark = other;
  const model = build(report(), [response]);
  assert.deepEqual(model.markets.map(market => market.contract), ['134741']);
});

test('wrong manager, quarter, security, issuer, source document and future evidence are withheld', () => {
  const changes = [value => { value.manager.cik = '0000000001'; }, value => { value.selectedPeriod = '2026-03-31'; },
    value => { value.holding.valueUsd = 201; }, value => { value.holding.quantity = 42; }, value => { value.status = 'unavailable'; }, value => { value.identity.evidence[0].cik = '0000009999'; },
    value => { value.discovery.cik = '0000009999'; }, value => { value.discovery.rows[0].evidence[0].url = 'https://example.com/report.htm'; },
    value => { value.discovery.rows[0].evidence[0].filed = '2027-01-01'; }, value => { value.discovery.rows[0].evidence[0].benchmark.contract = '043602'; }];
  for (const change of changes) {
    const response = result(); change(response);
    assert.equal(is13FMarketConnectionResult(response, { cik, period, holding: holding(), now }), false);
    const model = build(report(), [response]);
    assert.equal(model.markets.length, 0); assert.equal(model.coverage.unavailable, 1);
  }
});

test('partial discovery preserves sourced connections and makes the remaining coverage explicit', () => {
  const response = result(); response.discovery.status = 'partial'; response.discovery.coverage.searchComplete = false;
  const model = build(report(), [response]);
  assert.equal(model.markets.length, 1); assert.equal(model.coverage.partial, 1);
  assert.equal(model.positions.find(item => item.holding.key === holding().key).status, 'partial');
});

test('unresolved funds, no filings and no matches stay distinct from source failures', () => {
  const a = holding('123456789', 100), b = holding('987654321', 200), c = holding('456789123', 300), d = holding('147258369', 400);
  const unresolved = { ...result(a), status: 'unresolved', identity: { status: 'unresolved', cusip: a.cusip, reason: 'Fund security; no operating issuer is assumed.' }, discovery: null };
  const noFiling = result(b); noFiling.discovery.status = 'no_filing'; noFiling.discovery.rows = [];
  const noMatch = result(c, 'Our business includes services to companies in many industries throughout the year.');
  const failed = { key: d.key, holding: d, status: 'unavailable', message: 'SEC temporarily unavailable.' };
  const model = build(report([a, b, c, d]), [unresolved, noFiling, noMatch, failed]);
  assert.deepEqual([model.coverage.unresolved, model.coverage.noFiling, model.coverage.noMatches, model.coverage.unavailable], [1, 1, 1, 1]);
  assert.equal(model.coverage.checked, 1); assert.equal(model.coverage.linkedSharePct, 0);
});
