import test from 'node:test';
import assert from 'node:assert/strict';
import { cftcPositionChange, cftcContextChart, cftcCompanyResearchNote } from '../src/utils/cftcContextAnalytics.js';

const data = (points) => ({ selected: { reportDate: '2026-09-08' }, history: points });
test('context changes decompose reported longs and shorts without treating missing as zero', () => {
  const rows = [{ reportDate: '2026-09-01', long: 100, short: 200, netPctOi: -10 }, { reportDate: '2026-09-08', long: 120, short: 180, netPctOi: -5 }];
  const value = cftcPositionChange(data(rows));
  assert.equal(value.netChange, 40);
  assert.equal(value.longChange, 20);
  assert.equal(value.shortChange, -20);
  assert.equal(value.netPctChange, 5);
  assert.equal(cftcPositionChange(data([{ ...rows[0], long: null }, rows[1]])).available, false);
  assert.equal(cftcPositionChange(data([{ ...rows[0], reportDate: '2026-08-25' }, rows[1]])).available, false);
  assert.equal(cftcPositionChange(data([{ ...rows[0], long: 0 }, rows[1]])).available, true);
});
test('context change comparisons use exact four and thirteen week dates and reject unknown windows', () => {
  const points = ['2026-06-09', '2026-08-11', '2026-09-08'].map((date, i) => ({ reportDate: date, long: 100 + i * 10, short: 80, netPctOi: i }));
  assert.equal(cftcPositionChange(data(points), 13).netChange, 20);
  assert.equal(cftcPositionChange(data(points), 4).netChange, 10);
  assert.throws(() => cftcPositionChange(data(points), 3));
});
test('context chart splits missing reports and values and preserves a constant zero series', () => {
  const chart = cftcContextChart([{ reportDate: '2026-08-04', netPctOi: 1 }, { reportDate: '2026-08-11', netPctOi: 2 }, { reportDate: '2026-08-25', netPctOi: 3 }, { reportDate: '2026-09-01', netPctOi: null }, { reportDate: '2026-09-08', netPctOi: 4 }]);
  assert.equal(chart.paths.length, 3);
  assert.equal(chart.count, 4);
  assert.equal(cftcContextChart([{ reportDate: '2026-08-04', netPctOi: 0 }, { reportDate: '2026-08-11', netPctOi: 0 }]).count, 2);
  assert.equal(cftcContextChart([{ reportDate: '2026-08-04', netPctOi: 1 }]), null);
});
test('saved context keeps SEC evidence and CFTC observation dates distinct', () => {
  const history = { ...data([]), selected: { reportDate: '2026-09-08', contractName: 'Gold', exchange: 'COMEX', selectedGroup: { label: 'Managed Money', net: 0, long: 0, short: 0, netPctOi: 0 }, openInterest: 100 }, selection: { contract: '088691', group: 'managed-money', history_window: '1y' }, report_family: 'disaggregated', retrieved_at: '2026-09-13', status: 'ready', percentile: { required: 52, value: null }, source: { url: 'https://publicreporting.cftc.gov/' } };
  const note = cftcCompanyResearchNote({ ticker: 'TEST', history, asOf: '2025-12-31', candidate: { label: 'Gold', reason: 'Candidate only', evidence: [{ form: '10-K', filed: '2025-02-01', url: 'https://www.sec.gov/Archives/test', text: 'Our gold sales.' }] } });
  assert.match(note, /Reported longs: 0; shorts: 0; net: 0 contracts/);
  assert.match(note, /SEC 10-K filed 2025-02-01/);
  assert.match(note, /not information verified as available at that cutoff/);
  assert.match(note, /prior-report percentile: Unavailable/);
  assert.match(cftcCompanyResearchNote({ ticker: 'TEST', history }), /No company connection has been established/);
});
