import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExposureInstrumentGroups, compactInstrumentLabel } from '../src/utils/exposureInstruments.js';

const fact = value => ({ value, end: '2026-06-30' });
const row = (id, instrument, value, extra = {}) => ({ id, label: instrument, kind: 'derivative_notional', category: 'other_derivative', unit: 'USD', current: fact(value), prior: fact(value / 2), dimensions: [{ axis: 'us-gaap:DerivativeInstrumentRiskAxis', member: `us-gaap:${instrument}Member`, label: instrument }], ...extra });

test('asset classes classify the instrument dimension and retain every independent notional', () => {
  const rows = [row('cds-total', 'CreditDefaultSwap', 100), row('cds-grade', 'CreditDefaultSwap', 70), row('oil', 'CommodityFutureAndForward', 12), row('fx', 'ForeignExchangeContract', 20), row('rate', 'InterestRateContract', 30), row('other', 'EquityContract', 40)];
  const groups = buildExposureInstrumentGroups(rows);
  assert.deepEqual(groups.map(group => [group.id, group.rows.length]), [['interest_rate', 1], ['foreign_exchange', 1], ['credit', 2], ['commodity', 1], ['other', 1]]);
  assert.deepEqual(groups.find(group => group.id === 'credit').rows.map(item => item.current.value), [100, 70]);
  assert.equal(groups.flatMap(group => group.rows).length, rows.length);
  assert.ok(groups.every(group => !Object.hasOwn(group, 'total')));
});

test('a credit-grade or customer dimension cannot classify an unknown instrument as a credit derivative', () => {
  const item = row('x', 'OtherContract', 100);
  item.dimensions.push({ axis: 'company:CreditGradeAxis', member: 'company:CreditDefaultSwapMember', label: 'Credit default swap customer' });
  assert.equal(buildExposureInstrumentGroups([item])[0].id, 'other');
});

test('credit percentages retain denominator groups even when counterparties overlap', () => {
  const concentration = (id, benchmark, value) => row(id, 'Customer One', value, { kind: 'credit_concentration', unit: 'pure', dimensions: [{ axis: 'us-gaap:ConcentrationRiskByBenchmarkAxis', member: `us-gaap:${benchmark}Member`, label: benchmark }] });
  const [group] = buildExposureInstrumentGroups([concentration('a', 'TradeAccountsReceivable', .8), concentration('b', 'TradeAccountsReceivable', .7), concentration('c', 'NonTradeReceivable', .9)]);
  assert.equal(group.rows.length, 3);
  assert.equal(group.balances.length, 2);
  assert.deepEqual(group.balances[0].rows.map(item => item.current.value), [.8, .7]);
});

test('invalid facts and unsupported units are omitted; zero remains a reported value', () => {
  const items = [row('zero', 'InterestRateContract', 0), row('negative', 'CreditDefaultSwap', -1), row('infinite', 'CreditDefaultSwap', Infinity), row('eur', 'CreditDefaultSwap', 9, { unit: 'EUR' }), row('gap', 'CreditDefaultSwap', 9, { prior: { value: NaN } }), row('missing', 'CreditDefaultSwap', 9, { current: null })];
  assert.deepEqual(buildExposureInstrumentGroups(items).flatMap(group => group.rows).map(item => item.id), ['zero']);
  const invalidShare = row('over', 'Customer One', 1.1, { kind: 'credit_concentration', unit: 'pure' });
  assert.deepEqual(buildExposureInstrumentGroups([invalidShare]), []);
});

test('compact labels preserve purchased/sold protection and internal rating distinctions', () => {
  assert.equal(compactInstrumentLabel({ label: 'Credit Default Swap · Credit Default Swap Selling Protection · Internal Noninvestment Grade' }), 'CDS · Protection sold · Internal non-investment grade');
  assert.equal(compactInstrumentLabel({ label: 'Foreign exchange · Accounting hedges' }), 'Foreign exchange · Accounting hedges');
});
