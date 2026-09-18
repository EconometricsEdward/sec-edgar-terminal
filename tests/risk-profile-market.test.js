import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRiskProfileHistory, riskProfileExposureRows, riskProfileMarketChannel, riskProfileReferenceMarkets } from '../src/app/risk/riskProfileMarket.js';

const euro = { family: 'tff', contract: '099741', label: 'Euro FX', group: 'leveraged-funds', fit: 'named-reference' };
const proof = (role, benchmark = null, extra = {}) => ({ id: role, text: 'A supported company disclosure.', url: 'https://www.sec.gov/filing.htm', filed: role === 'annual' ? '2025-10-31' : '2026-07-31', role, benchmark, ...extra });
const row = (extra = {}) => ({ id: 'currencies:euro', category: 'currencies', marketId: 'euro', marketLabel: 'Euro', benchmark: euro, evidence: [proof('annual'), proof('quarterly', euro)], ...extra });
const body = (rows, extra = {}) => ({ schemaVersion: 'edgar.company-exposure-map.v1', ticker: 'AAPL', asOf: null, rows, sources: [], ...extra });

test('a quarterly benchmark cannot bleed into annual-basis evidence', () => {
  assert.equal(riskProfileExposureRows(body([row()]), { ticker: 'AAPL' })[0].benchmark.contract, '099741');
  const annual = riskProfileExposureRows(body([row()]), { ticker: 'AAPL', basis: 'annual' })[0];
  assert.equal(annual.benchmark, null);
  assert.equal(annual.evidence.length, 1);
  assert.equal(annual.evidence[0].role, 'annual');
});

test('generic currency and rate disclosures never acquire automatic CFTC benchmarks', () => {
  const generic = row({ marketId: 'foreign-currencies', marketLabel: 'Foreign currencies — pair unspecified', evidence: [proof('annual')], benchmark: null });
  const selected = riskProfileExposureRows(body([generic]), { ticker: 'AAPL' })[0];
  assert.equal(selected.benchmark, null);
  assert.ok(riskProfileReferenceMarkets(selected).every(item => item.category === 'currencies'));
  assert.ok(riskProfileReferenceMarkets({ category: 'borrowing', marketId: 'interest-rates' }).every(item => item.category === 'rates'));
});

test('qualifying evidence stays visible while unavailable and invalid benchmarks stay unassigned', () => {
  const negative = proof('quarterly', null, { disclosureDirection: 'qualifying-or-negative' });
  const invalid = { ...euro, contract: 'invalid-code' };
  const rows = riskProfileExposureRows(body([row({ evidence: [proof('annual', invalid), negative] })]), { ticker: 'AAPL' });
  assert.equal(rows[0].benchmark, null);
  assert.equal(rows[0].evidence[0].disclosureDirection, 'qualifying-or-negative');
});

test('exposure responses must match company and SEC cutoff', () => {
  assert.throws(() => riskProfileExposureRows(body([row()]), { ticker: 'JPM' }), /does not match/);
  assert.throws(() => riskProfileExposureRows(body([row()]), { ticker: 'AAPL', asOf: '2025-12-31' }), /does not match/);
  assert.throws(() => riskProfileExposureRows(body([{ id: 'broken' }]), { ticker: 'AAPL' }), /does not match/);
});

test('financial institution transmission respects bank repricing and broker collateral risk', () => {
  assert.match(riskProfileMarketChannel({ category: 'borrowing' }, 'bank').effect, /net interest income/);
  assert.match(riskProfileMarketChannel({ category: 'investments' }, 'broker').effect, /collateral/);
  assert.match(riskProfileMarketChannel({ category: 'borrowing' }, 'broker').connection, /margin calls/);
});

test('a bank funding channel takes precedence over a peripheral commodity proxy', () => {
  const gas = { family: 'disaggregated', contract: '023651', label: 'Natural gas', group: 'managed-money', fit: 'proxy' };
  const rows = riskProfileExposureRows(body([
    row({ id: 'gas', category: 'investments', marketId: 'natural-gas', marketLabel: 'Natural gas', evidence: [proof('annual', gas)] }),
    row({ id: 'rates', category: 'borrowing', marketId: 'interest-rates', marketLabel: 'Interest rates', evidence: [proof('annual')] }),
  ], { ticker: 'JPM' }), { ticker: 'JPM', companyType: 'bank' });
  assert.equal(rows[0].id, 'rates');
  assert.equal(rows[0].benchmark, null);
  assert.equal(rows[1].benchmark.contract, '023651');
});

test('CFTC history cannot display a different contract, trader, basis or comparison window', () => {
  const selection = { family: 'tff', contract: '099741', group: 'leveraged-funds' };
  const data = { selected: { code: '099741', selectedGroup: { id: 'leveraged-funds' } }, selection: { contract: '099741', group: 'leveraged-funds', history_window: '1y' }, report_family: 'tff', report_basis: 'futures_only', percentile: { required: 52 }, history: [] };
  assert.equal(matchesRiskProfileHistory(data, selection), true);
  assert.equal(matchesRiskProfileHistory({ ...data, selected: { ...data.selected, code: '097741' } }, selection), false);
  assert.equal(matchesRiskProfileHistory({ ...data, report_basis: 'combined' }, selection), false);
  assert.equal(matchesRiskProfileHistory({ ...data, percentile: { required: 156 } }, selection), false);
  assert.equal(matchesRiskProfileHistory(data, { ...selection, group: 'dealer' }), false);
});
