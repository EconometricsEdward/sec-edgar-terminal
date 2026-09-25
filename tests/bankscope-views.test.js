import test from 'node:test';
import assert from 'node:assert/strict';
import { bankMetric, metricChange, bankPageOptions, bankHref, formatBankMetric, quarterLabel } from '../src/utils/bank/viewModel.js';
import { safeInternalPath, entityFromRoute } from '../src/utils/siteRoutes.js';
const report = (date, value, passed = true) => ({ id_rssd: 101, report_date: date, validation: { passed }, metrics: [{ key: 'net_income', unit: 'USD', period: 'ytd', value }] });
test('quarterly earnings subtract same-year YTD and never cross the year boundary or fill a missing quarter', () => {
  const state = { reports: [report('2025-09-30', 60e6), report('2025-12-31', 90e6), report('2026-03-31', 18e6), report('2026-06-30', 42e6)] };
  assert.equal(bankMetric(state, 101, '2025-09-30', 'net_income', 'quarterly').value, null);
  assert.equal(bankMetric(state, 101, '2025-12-31', 'net_income', 'quarterly').value, 30e6);
  assert.equal(bankMetric(state, 101, '2026-03-31', 'net_income', 'quarterly').value, 18e6);
  assert.equal(bankMetric(state, 101, '2026-06-30', 'net_income', 'quarterly').value, 24e6);
  assert.equal(bankMetric(state, 101, '2026-06-30', 'net_income', 'ytd').value, 42e6);
  assert.equal(bankMetric(state, 102, '2026-06-30', 'net_income').value, null);
  assert.equal(bankMetric(state, 101, '2026-09-30', 'net_income').value, null);
  state.reports[2].validation.passed = false;
  assert.equal(bankMetric(state, 101, '2026-06-30', 'net_income', 'quarterly').value, null);
});
test('capital changes use percentage points and loss-to-profit does not invent growth', () => {
  assert.deepEqual(metricChange({ value: 12.3, unit: 'percent' }, { value: 10.3, unit: 'percent' }), { value: 2, unit: 'pp' });
  assert.equal(metricChange({ value: 3, unit: 'USD' }, { value: -1 }), null);
  assert.equal(metricChange({ value: 3, unit: 'USD' }, { value: 0 }), null);
  assert.equal(metricChange({ value: 3, unit: 'USD' }, { value: null }), null);
  assert.equal(metricChange({ value: 3, unit: 'USD' }, { value: 2 }).value, 50);
  assert.equal(formatBankMetric({ value: 0, unit: 'USD' }), '0.0');
  assert.equal(formatBankMetric({ value: null, reason: 'not_required_under_cblr' }), 'N/A');
});
test('bank links preserve selected view and RSSDs without becoming SEC tickers', () => {
  const options = bankPageOptions('101', { view: 'compare', peers: '102,101,102,103,104,105,bad', period: '2026-06-30', basis: 'quarterly' });
  assert.deepEqual(options.peers, ['102', '103', '104']);
  const href = bankHref('101', options);
  assert.equal(safeInternalPath(href), href);
  assert.equal(safeInternalPath('/analysis/banks'), '/analysis/banks');
  assert.equal(entityFromRoute('/analysis/banks'), null);
  assert.equal(entityFromRoute('/analysis/banks/101'), null);
  assert.equal(safeInternalPath('/analysis/banks/0'), null);
  assert.equal(quarterLabel('2026-06-30'), 'Q2 2026');
});
