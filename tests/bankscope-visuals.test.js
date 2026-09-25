import test from 'node:test';
import assert from 'node:assert/strict';
import { visualMetric, chartPoints, compactMetric } from '../src/utils/bank/visuals.js';
import { bankPageOptions, bankHref } from '../src/utils/bank/viewModel.js';
const date = '2026-06-30';
function stateFor(values, passed = true) {
  return { periods: [date], reports: [{ id_rssd: 101, report_date: date, validation: { passed }, metrics: Object.entries(values).map(([key, value]) => ({ key, value, unit: 'USD', period: 'instant' })) }] };
}
test('visual ratios keep loan, reserve and domestic-deposit denominators distinct', () => {
  const state = stateFor({ loans: 120e6, loans_hfi: 100e6, deposits: 200e6, domestic_deposits: 150e6, brokered_deposits: 15e6, nonaccrual: 2e6, past_due_90: 1e6, allowance: 4e6 });
  assert.equal(visualMetric(state, 101, date, 'loans_to_deposits').value, 60);
  assert.equal(visualMetric(state, 101, date, 'nonperforming_ratio').value, 2.5);
  assert.equal(visualMetric(state, 101, date, 'allowance_ratio').value, 4);
  assert.equal(visualMetric(state, 101, date, 'brokered_ratio').value, 10);
  assert.equal(visualMetric(state, 102, date, 'loans_to_deposits').value, null);
  assert.equal(visualMetric(state, 101, '2026-03-31', 'loans_to_deposits').value, null);
});
test('missing or nonpositive denominators and review-required reports never become plotted ratios', () => {
  for (const denominator of [null, 0, -1, Infinity]) {
    assert.equal(visualMetric(stateFor({ loans: 100, deposits: denominator }), 101, date, 'loans_to_deposits').value, null);
  }
  assert.equal(visualMetric(stateFor({ loans: 100, nonaccrual: 2 }), 101, date, 'nonperforming_ratio').value, null);
  assert.equal(visualMetric(stateFor({ loans: 100, deposits: 200 }, false), 101, date, 'loans_to_deposits').value, null);
  assert.equal(visualMetric(stateFor({ loans: 100, nonaccrual: 0, past_due_90: 0 }), 101, date, 'nonperforming_ratio').value, 0);
});
test('multi-series chart data retains missing quarters, negative flows, zero values and percentage units', () => {
  const state = { periods: [date, '2026-03-31', '2025-12-31', '2025-09-30'], reports: [] };
  for (const [period, income] of [['2025-09-30', 60e6], ['2025-12-31', 50e6], ['2026-03-31', 0], [date, 3e6]]) {
    state.reports.push({ id_rssd: 101, report_date: period, validation: { passed: true }, metrics: [{ key: 'net_income', value: income, unit: 'USD', period: 'ytd' }, { key: 'leverage_ratio', value: 9.5, unit: 'percent', period: 'instant' }] });
  }
  const points = chartPoints(state, 101, ['net_income', 'leverage_ratio', 'assets']);
  assert.deepEqual(points.map(p => p.net_income), [null, -10, 0, 3]);
  assert.deepEqual(points.map(p => p.leverage_ratio), [9.5, 9.5, 9.5, 9.5]);
  assert.ok(points.every(p => p.assets === null));
  assert.equal(state.periods[0], date);
  assert.equal(compactMetric({ value: 1250000000, unit: 'USD' }), '$1.25B');
  assert.equal(compactMetric({ value: 0, unit: 'percent' }), '0.00%');
});
test('trend links default to quarterly flows and preserve an explicit YTD choice', () => {
  assert.equal(bankPageOptions('101', { view: 'trends' }).basis, 'quarterly');
  assert.equal(bankPageOptions('101', { view: 'compare' }).basis, 'ytd');
  for (const basis of ['quarterly', 'ytd']) {
    const href = bankHref('101', { view: 'trends', basis });
    assert.equal(bankPageOptions('101', Object.fromEntries(new URL(href, 'https://example.test').searchParams)).basis, basis);
  }
});
