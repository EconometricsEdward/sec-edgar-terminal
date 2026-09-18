import test from 'node:test';
import assert from 'node:assert/strict';
import { companyCftcEvidence, matchesCompanyCftcHistory } from '../src/utils/companyCftcEvidence.js';
import { extractCompanyExposureMap } from '../src/utils/companyExposure.js';

const source = (role, overrides = {}) => ({ role, form: role === 'annual' ? '10-K' : '10-Q', accession: role === 'annual' ? '0000886982-26-000091' : '0000886982-26-000297', filed: role === 'annual' ? '2026-02-25' : '2026-08-03', reportDate: role === 'annual' ? '2025-12-31' : '2026-06-30', url: `https://www.sec.gov/Archives/edgar/data/886982/${role}.htm`, status: 'ready', ...overrides });
const annual = source('annual'), quarter = source('quarterly');
function bodyFor(ticker, annualText, quarterlyText = '') {
  const sources = [annual, ...(quarterlyText ? [quarter] : [])];
  const { rows } = extractCompanyExposureMap(sources.map((filing, index) => ({ filing, role: filing.role, text: index ? quarterlyText : annualText })), { ticker });
  return { schemaVersion: 'edgar.company-exposure-map.v1', ticker, cik: '0000886982', asOf: null, status: rows.length ? 'ready' : 'no_matches', rows, sources };
}

test('GS funding and investment disclosures remain visible without inventing a Treasury maturity', () => {
  const body = bodyFor('GS', 'We enter into interest rate swaps to convert a portion of our unsecured long-term borrowings into floating-rate obligations to manage our exposure to interest rates.', 'Our investment securities are exposed to interest rate risk and changes in market valuations.');
  const result = companyCftcEvidence(body, { ticker: 'GS', companyType: 'broker' });
  assert.deepEqual(result.rows.map(row => row.category), ['borrowing', 'investments']);
  assert.ok(result.rows.every(row => row.contract === '' && row.fit === 'unmapped'));
  assert.equal(result.rows[0].evidence[0].filed, annual.filed);
  assert.equal(result.rows[1].evidence[0].filed, quarter.filed);
});

test('supported benchmarks keep SEC business channels across varied industries', () => {
  const examples = [
    ['XOM', 'Our crude oil production revenue is priced using WTI benchmarks and changes in supply.', 'revenue', '067651', 'named-reference'],
    ['KO', 'We purchase coffee for our beverage operations and manage procurement costs through supplier contracts.', 'input-costs', '083731', 'proxy'],
    ['NEE', 'We purchase natural gas to operate our electricity generation facilities.', 'input-costs', '023651', 'proxy'],
    ['AAPL', 'Our euro-denominated debt creates exposure to foreign currency changes and funding costs.', 'currencies', '099741', 'proxy'],
    ['WMT', 'We purchase cotton for our private-label products and manage the related procurement costs.', 'input-costs', '033661', 'proxy'],
    ['AIG', 'Our investments in 10-year U.S. Treasury securities are exposed to changes in interest rates.', 'investments', '043602', 'named-reference'],
  ];
  for (const [ticker, text, category, contract, fit] of examples) {
    const result = companyCftcEvidence(bodyFor(ticker, text), { ticker });
    const row = result.rows.find(row => row.contract === contract);
    assert.ok(row, ticker); assert.equal(row.category, category, ticker); assert.equal(row.fit, fit, ticker);
    assert.equal(row.evidence[0].text, text); assert.equal(row.evidence[0].reportDate, annual.reportDate);
    assert.ok(row.group); assert.ok(row.family);
  }
});

test('annual selection cannot inherit a named benchmark introduced by a newer quarter', () => {
  const body = bodyFor('XOM', 'Our crude oil production revenue depends on realized prices and production volumes.', 'Our crude oil production revenue is priced using the WTI benchmark.');
  assert.equal(companyCftcEvidence(body, { ticker: 'XOM' }).rows[0].fit, 'named-reference');
  const selected = companyCftcEvidence(body, { ticker: 'XOM', basis: 'annual' });
  assert.equal(selected.rows[0].fit, 'proxy');
  assert.equal(selected.sources.length, 1);
  assert.ok(selected.rows[0].evidence.every(item => item.role === 'annual'));
});

test('unsupported inputs, generic FX and explicit negative updates are not silently dropped or benchmarked', () => {
  const body = bodyFor('KO', 'Our sugar procurement costs depend on supply conditions and customer demand. Our international revenues are exposed to foreign currency exchange rate changes. Our natural gas purchases are exposed to changes in fuel prices.', 'We no longer purchase natural gas for our bottling operations.');
  const selected = companyCftcEvidence(body, { ticker: 'KO' });
  for (const marketId of ['sugar', 'foreign-currencies']) {
    const row = selected.rows.find(item => item.marketId === marketId);
    assert.ok(row, marketId); assert.equal(row.contract, ''); assert.equal(row.benchmark, null);
  }
  assert.ok(selected.rows.find(item => item.marketId === 'natural-gas').evidence.some(item => item.disclosureDirection === 'qualifying-or-negative'));
});

test('company, CIK, cutoff, filing identity and individual evidence dates must agree', () => {
  const body = bodyFor('XOM', 'Our crude oil production revenue is priced using the WTI benchmark.');
  for (const settings of [{ ticker: 'GS' }, { ticker: 'XOM', cik: '320193' }, { ticker: 'XOM', asOf: '2025-12-31' }]) assert.throws(() => companyCftcEvidence(body, settings));
  for (const mutate of [
    item => { item.rows[0].evidence[0].url = 'https://example.com/other.htm'; },
    item => { item.rows[0].evidence[0].reportDate = '2026-09-01'; },
    item => { item.rows[0].evidence[0].filed = '2026-02-30'; },
    item => { item.sources[0].status = 'unavailable'; },
    item => { item.rows[0].evidence[0].sourceCik = '0000034088'; },
    item => { item.asOf = '2025-12-31'; },
  ]) {
    const changed = structuredClone(body); mutate(changed);
    assert.throws(() => companyCftcEvidence(changed, { ticker: 'XOM', asOf: changed.asOf || '' }));
  }
});

test('invalid contract or trader metadata never becomes a company CFTC link', () => {
  for (const mutation of [{ contract: '123456' }, { group: 'dealer' }, { fit: 'exact-exposure' }]) {
    const body = bodyFor('XOM', 'Our crude oil production revenue is priced using the WTI benchmark.');
    Object.assign(body.rows[0].evidence[0].benchmark, mutation);
    const row = companyCftcEvidence(body, { ticker: 'XOM' }).rows[0];
    assert.equal(row.benchmark, null); assert.equal(row.contract, '');
  }
});

test('CFTC observations require matching family, group, report basis, date, and prior-report horizon', () => {
  const selection = { family: 'tff', contract: '043602', group: 'leveraged-funds', window: '1y' };
  const history = { report_family: 'tff', report_basis: 'futures_only', selection: { contract: '043602', group: 'leveraged-funds', report_date: '2026-09-15', history_window: '1y', required_prior_reports: 52 }, selected: { code: '043602', reportDate: '2026-09-15', selectedGroup: { id: 'leveraged-funds' } }, percentile: { required: 52 }, history: [{ reportDate: '2026-09-15' }] };
  assert.equal(matchesCompanyCftcHistory(history, selection), true);
  for (const mutate of [
    item => { item.report_family = 'disaggregated'; }, item => { item.report_basis = 'combined'; },
    item => { item.selected.selectedGroup.id = 'dealer'; }, item => { item.selection.report_date = '2026-09-08'; },
    item => { item.percentile.required = 156; }, item => { item.history[0].reportDate = '2026-09-22'; },
    item => { item.selected.reportDate = '2026-02-30'; }, item => { item.history = []; },
  ]) {
    const changed = structuredClone(history); mutate(changed);
    assert.equal(matchesCompanyCftcHistory(changed, selection), false);
  }
});
