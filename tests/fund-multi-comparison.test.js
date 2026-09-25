import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAllFundHoldings, multiFundComparisonCsv } from '../src/utils/fundMultiComparison.js';
import { recentFundFilings } from '../src/utils/fundRecentFilings.js';
import { fundSearchSuggestions } from '../src/utils/fundDiscovery.js';
import { readFundWorkspaceSettings } from '../src/utils/fundWorkspaceSettings.js';

const position = (cusip, weight = 5, value = 50, extra = {}) => ({ name: `Security ${cusip}`, cusip, pctOfNav: weight, value, payoffProfile: 'Long', assetCat: 'EC', ...extra });
const fund = (ticker, holdings) => ({ ticker, cik: '0000000001', seriesId: `S${ticker}`, asOf: '2026-06-30', filingDate: '2026-08-20', accession: '0000000001-26-000001', fundInfo: { netAssets: 1000 }, summary: { count: holdings.length }, holdings });

test('every selected fund participates, including third/fourth-only positions and correct USD totals', () => {
  const portfolios = [fund('AAA', [position('000000001'), position('000000001', 2, 20), position('000000002')]),
    fund('BBB', [position('000000001', 3, 30)]), fund('CCC', [position('000000001'), position('000000003', 9, 90)]),
    fund('DDD', [position('000000001'), position('000000004', 0, 0)])];
  const result = compareAllFundHoldings(portfolios);
  assert.equal(result.counts.every, 1); assert.equal(result.counts.unique, 3); assert.equal(result.pairs.length, 6);
  const common = result.rows.find(r => r.kind === 'every');
  assert.equal(common.funds.length, 4); assert.equal(common.funds[0].pctOfNav, 7); assert.equal(common.funds[0].value, 70);
  assert.equal(result.rows.find(r => r.ids.includes('CUSIP:000000004')).funds[0].value, 0);
  assert.equal(compareAllFundHoldings(portfolios, { scope: 'unique', fund: 'CCC' }).rows[0].funds[0].value, 90);
  const csv = multiFundComparisonCsv(result);
  assert.match(csv, /DDD NAV weight %/); assert.match(csv, /DDD value USD/);
});

test('failed fund keeps full selection denominator and never implies all-fund agreement or uniqueness', () => {
  const result = compareAllFundHoldings([fund('AAA', [position('000000001')]), fund('BBB', [position('000000001'), position('000000002')])], { tickers: ['AAA', 'BBB', 'CCC'] });
  assert.equal(result.complete, false); assert.equal(result.counts.every, null); assert.equal(result.counts.unique, null);
  assert.equal(result.rows.find(r => r.fundCount === 1).kind, 'unconfirmed');
  assert.match(multiFundComparisonCsv(result), /Report unavailable/);
});

test('missing values remain unknown, identifier aliases connect, and names alone never match', () => {
  const result = compareAllFundHoldings([fund('AAA', [position('037833100', 2, 20, { isin: 'US0378331005' }), position('037833100', null, null), position(null, 1, 10, { name: 'Apple' })]),
    fund('BBB', [position(null, 1, 10, { isin: 'US0378331005' }), position(null, 1, 10, { name: 'Apple' })])]);
  assert.equal(result.counts.every, 1); assert.equal(result.counts.unmatched, 2);
  const a = result.rows.find(r => r.kind === 'every').funds.find(f => f.ticker === 'AAA');
  assert.equal(a.value, null); assert.equal(a.knownValue, 20); assert.equal(a.pctOfNav, null);
  assert.equal(result.counts.unique, 0);
});

test('one-year filing history excludes old, future, non-NPORT and duplicate filings and sorts newest first', () => {
  const report = (accession, filingDate, form = 'NPORT-P') => ({ accession, filingDate, form });
  const reports = [report('old', '2025-09-24'), report('boundary', '2025-09-25'), report('new', '2026-09-25'), report('future', '2026-09-26'), report('new', '2026-09-25'), report('other', '2026-09-20', '497'), report('amended', '2026-09-24', 'NPORT-P/A')];
  assert.deepEqual(recentFundFilings({ reports }, Date.parse('2026-09-25T12:00:00Z')).map(r => r.accession), ['new', 'amended', 'boundary']);
});

test('derivative underlying identifiers cannot create false agreement with a physical holding', () => {
  const result = compareAllFundHoldings([fund('AAA', [position('037833100')]), fund('BBB', [position('037833100', 1, 10, { assetCat: 'DE' })])]);
  assert.equal(result.counts.every, 0); assert.equal(result.counts.shared, 0); assert.equal(result.counts.unmatched, 1);
  assert.match(result.rows.find(r => r.kind === 'unmatched').matchNote, /Derivative contract/);
});

test('fund discovery searches the directory beyond the catalog and distinguishes company holding searches', () => {
  const directory = { IBOT: { name: 'Robotics ETF', isFund: true }, IBM: { name: 'International Business Machines', isFund: false }, AAPL: { name: 'Apple Inc.', isFund: false } };
  assert.equal(fundSearchSuggestions('ibot', directory)[0].ticker, 'IBOT');
  assert.equal(fundSearchSuggestions('apple', directory, 'holding')[0].kind, 'company');
  assert.equal(fundSearchSuggestions('ib', directory, 'fund').length, 1);
  assert.equal(fundSearchSuggestions('robot', directory)[0].ticker, 'IBOT');
});

test('retired N-PORT views lead to current research while 13F views stay intact', () => {
  assert.equal(readFundWorkspaceSettings('view=allocation&tickers=VOO,VTI').view, 'compare');
  assert.equal(readFundWorkspaceSettings('view=changes&tickers=VOO').view, 'filings');
  assert.equal(readFundWorkspaceSettings('view=13f&managerCik=123&managerView=changes').managerView, 'changes');
});
