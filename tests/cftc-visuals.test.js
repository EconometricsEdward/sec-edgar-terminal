import test from 'node:test';
import assert from 'node:assert/strict';
import { positioningGroups, positioningHistoryChart, signedPlotExtent } from '../src/components/cftc/cftcVisualAnalytics.js';

const history = [
  { reportDate: '2026-08-18', long: 200, short: 600, openInterest: 1000, netPctOi: -40 },
  { reportDate: '2026-08-25', long: 600, short: 400, openInterest: 2000, netPctOi: 10 },
  { reportDate: '2026-09-01', long: 500, short: 700, openInterest: 2000, netPctOi: -10 },
];

test('long and short histories use each report denominator and one common axis', () => {
  const result = positioningHistoryChart(history, 'sides');
  assert.deepEqual(result.series[0].dots.map(point => point.value), [20, 30, 25]);
  assert.deepEqual(result.series[1].dots.map(point => point.value), [60, 20, 35]);
  assert.equal(result.min, 0);
  assert.equal(result.max, 60);
  assert.equal(result.series[0].dots[0].y, result.series[1].dots[1].y);
});

test('net axis retains sign and open-interest history retains contract counts', () => {
  const net = positioningHistoryChart(history);
  assert.equal(net.min, -40);
  assert.equal(net.max, 10);
  assert.ok(net.zeroY > 36 && net.zeroY < 218);
  const oi = positioningHistoryChart(history, 'interest');
  assert.deepEqual(oi.series[0].dots.map(point => point.value), [1000, 2000, 2000]);
  assert.equal(oi.min, 0);
});

test('missing reports and unavailable inputs break lines instead of connecting gaps', () => {
  const missingWeek = positioningHistoryChart([history[0], history[2]]);
  assert.equal(missingWeek.series[0].paths.length, 2);
  const missingInput = positioningHistoryChart(history.map((row, index) => index === 1 ? { ...row, long: null } : row), 'sides');
  assert.equal(missingInput.series[0].paths.length, 2);
  assert.equal(missingInput.series[1].paths.length, 1);
});

test('nonpositive or missing open interest never produces an invented long/short share', () => {
  assert.equal(positioningHistoryChart(history.map(row => ({ ...row, openInterest: 0 })), 'sides'), null);
  assert.equal(positioningHistoryChart(history.map(row => ({ ...row, openInterest: null })), 'sides'), null);
  const partlyMissing = positioningHistoryChart(history.map((row, index) => index === 1 ? { ...row, openInterest: -1 } : row), 'sides');
  assert.equal(partlyMissing.series[0].dots.length, 2);
  assert.equal(partlyMissing.series[0].paths.length, 2);
});

test('all-trader comparison preserves unavailable versus observed zero', () => {
  const result = positioningGroups({ groups: { a: { id: 'a', label: 'A', net: 0, netPctOi: 0 }, b: { id: 'b', label: 'B', net: null, netPctOi: null }, c: { id: 'c', label: 'C', net: -400, netPctOi: -40 } } });
  assert.deepEqual(result.map(row => row.value), [0, null, -40]);
  assert.equal(signedPlotExtent(result.map(row => row.value)), 40);
  assert.equal(signedPlotExtent([null, 0]), 5);
});

test('history preserves real temporal spacing and requires multiple dates', () => {
  const result = positioningHistoryChart([history[2], history[0], history[1]]);
  assert.deepEqual(result.positions.map(row => row.reportDate), history.map(row => row.reportDate));
  assert.equal(result.positions[1].x - result.positions[0].x, result.positions[2].x - result.positions[1].x);
  assert.equal(positioningHistoryChart([history[0]]), null);
  assert.equal(positioningHistoryChart([history[0], history[0]]), null);
});
