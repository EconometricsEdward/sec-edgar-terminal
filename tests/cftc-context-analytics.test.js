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

test('scenario research notes retain all selected annual and quarterly evidence, contract fit and baseline timing', () => {
  const history = { selected: { reportDate: '2026-09-08', contractName: 'Euro FX', selectedGroup: { label: 'Asset Manager', long: 10, short: 5, net: 5, netPctOi: 1 }, openInterest: 500 }, selection: { contract: '099741', group: 'asset-manager', history_window: '3y' }, report_family: 'tff', report_basis: 'futures_only', retrieved_at: '2026-09-14', status: 'stale', percentile: { required: 156, value: null }, freshness: { cache_status: 'stale-last-good', source_report_age_days: 10 }, refresh_warning: 'Awaiting scheduled revalidation.', history: [] };
  const evidence = [0, 1, 2, 3].map(index => ({ form: index < 2 ? '10-Q' : '10-K', filed: index < 2 ? '2026-08-01' : '2026-02-01', reportDate: index < 2 ? '2026-06-30' : '2025-12-31', accession: `accession-${index}`, url: `https://www.sec.gov/Archives/${index}`, text: `Exact disclosure ${index}`, disclosureDirection: index === 0 ? 'qualifying-or-negative' : 'connection' }));
  const note = cftcCompanyResearchNote({ ticker: 'TEST', history, basis: 'quarter', periodEnd: '2026-06-30', asOf: '2026-08-15', candidate: { label: 'Euro', categoryLabel: 'Currencies', fit: 'proxy', reason: 'Currency pair may differ.', evidence } });
  assert.match(note, /Trader category ID: asset-manager · History window: 3y/);
  assert.match(note, /Benchmark fit: proxy/);
  assert.match(note, /Qualification or negative disclosure: Exact disclosure 0/);
  assert.match(note, /Period 2025-12-31 · Accession accession-3/);
  assert.match(note, /postdates the financial baseline/);
  assert.match(note, /SEC filing cutoff: 2026-08-15/);
  assert.match(note, /stale-last-good/);
  assert.match(note, /Awaiting scheduled revalidation/);
  assert.match(note, /group=asset-manager&date=2026-09-08&history=3y/);
});
