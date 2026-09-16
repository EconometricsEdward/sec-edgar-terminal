import test from 'node:test';
import assert from 'node:assert/strict';
import { project13FHistoryQuarter, summarize13FHistory } from '../src/utils/thirteenFHistory.js';
import { get13FQuarterComparison, get13FHoldingQuarterComparison, create13FHistoryCsv } from '../src/utils/thirteenFHistoryInsights.js';

const CIK = '0001747057';
const KEY = '00827B106|SECURITY|SH';
const OTHER_KEY = '02079K305|SECURITY|SH';
function slot(period, { quantity = 10, valueUsd = 100, present = true, keys = [KEY], ...overrides } = {}) {
  const holdings = present ? [{ key: KEY, cusip: '00827B106', issuer: 'Example issuer', classTitle: 'COM', quantityType: 'SH', putCall: null, quantity, valueUsd }] : [];
  return { period, status: 'ready', projection: project13FHistoryQuarter({
    cik: CIK, period, holdings, complete: true, comparable: true, confidentialOmitted: false, reportType: '13F HOLDINGS REPORT',
    totalValueUsd: present ? valueUsd : 0, entryCount: holdings.length, amendmentCount: 0,
    filings: [{ accessionNumber: '0001747057-26-000001', filingDate: '2026-08-14', filingUrl: 'https://www.sec.gov/Archives/example-index.html', tableUrls: ['https://www.sec.gov/Archives/example.xml'] }],
    issues: [], ...overrides,
  }, keys) };
}
const historyFor = (slots) => summarize13FHistory(slots, { cik: CIK });

function readCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\r' || char === '\n')) {
      row.push(cell); cell = '';
      if (char !== ',') {
        rows.push(row); row = [];
        if (char === '\r' && text[index + 1] === '\n') index += 1;
      }
    } else cell += char;
  }
  const [headings, ...values] = rows;
  return values.map((values) => Object.fromEntries(headings.map((key, index) => [key, values[index]])));
}

test('quarter comparisons use the selected quarter and exact adjacent calendar baseline across years', () => {
  const history = historyFor([slot('2025-12-31', { valueUsd: 100 }), slot('2026-03-31', { valueUsd: 150 }), slot('2026-06-30', { valueUsd: 90 })]);
  Object.assign(history.quarters[0], { positionCount: 20, top5Pct: 25, top10Pct: 50 });
  Object.assign(history.quarters[1], { positionCount: 18, top5Pct: 30, top10Pct: 55 });
  const original = JSON.stringify(history);
  const comparison = get13FQuarterComparison(history, '2026-03-31');
  assert.equal(comparison.available, true);
  assert.equal(comparison.status, 'available');
  assert.equal(comparison.baselinePeriod, '2025-12-31');
  assert.equal(comparison.reason, null);
  assert.deepEqual(comparison.deltas.totalValueUsd, { change: 50, changePct: 50 });
  assert.deepEqual(comparison.deltas.positionCount, { change: -2, changePct: -10 });
  assert.deepEqual(comparison.deltas.top5Pct, { change: 5, changePct: 20 });
  assert.deepEqual(comparison.deltas.top10Pct, { change: 5, changePct: 10 });
  assert.equal(JSON.stringify(history), original);
});

test('a missing or out-of-window quarter never becomes an older available comparison', () => {
  const history = historyFor([slot('2025-12-31'), slot('2026-06-30', { valueUsd: 200 })]);
  const missing = get13FQuarterComparison(history, '2026-06-30');
  assert.equal(missing.available, false);
  assert.equal(missing.baselinePeriod, '2026-03-31');
  assert.equal(missing.baseline.status, 'unavailable');
  assert.equal(missing.deltas.totalValueUsd.change, null);
  const outside = get13FQuarterComparison(history, '2025-12-31');
  assert.equal(outside.available, false);
  assert.equal(outside.baselinePeriod, '2025-09-30');
  assert.equal(outside.baseline, null);
  assert.match(outside.reason, /outside/);
  assert.match(get13FQuarterComparison(history, '2026-09-30').reason, /selected quarter/);
});

test('partial, loading and stale failed snapshots never yield quarterly changes', () => {
  for (const invalidSlot of [
    slot('2026-03-31', { complete: false, comparable: false }),
    { ...slot('2026-03-31'), status: 'loading' },
    { ...slot('2026-03-31'), status: 'unavailable' },
  ]) {
    const history = historyFor([invalidSlot, slot('2026-06-30')]);
    assert.equal(get13FQuarterComparison(history, '2026-06-30').available, false);
    for (const delta of Object.values(get13FQuarterComparison(history, '2026-06-30').deltas)) assert.deepEqual(delta, { change: null, changePct: null });
  }
});

test('confidential and combination reporting scopes preserve values but suppress changes', () => {
  for (const scope of [{ confidentialOmitted: true }, { reportType: '13F COMBINATION REPORT' }, { comparable: false }]) {
    const history = historyFor([slot('2026-03-31'), slot('2026-06-30', { valueUsd: 250, ...scope })]);
    const comparison = get13FQuarterComparison(history, '2026-06-30');
    assert.equal(comparison.current.totalValueUsd, 250);
    assert.equal(comparison.available, false);
    assert.equal(comparison.deltas.totalValueUsd.change, null);
  }
});

test('manager identity mismatch and malformed histories do not create comparisons', () => {
  const history = historyFor([slot('2026-03-31'), slot('2026-06-30')]);
  history.quarters[0].cik = '0000000123';
  assert.equal(get13FQuarterComparison(history, '2026-06-30').available, false);
  assert.match(get13FQuarterComparison(history, '2026-06-30').reason, /manager identity/);
  assert.throws(() => create13FHistoryCsv(history), /another manager/);
  assert.throws(() => get13FQuarterComparison({ ...history, quarters: [history.quarters[0], history.quarters[0]] }, '2026-06-30'), /duplicate/);
  assert.throws(() => get13FQuarterComparison(history, '2026-06-29'), /calendar/);
});

test('zero baseline retains the absolute change without inventing an infinite percentage', () => {
  const history = historyFor([slot('2026-03-31', { valueUsd: 0 }), slot('2026-06-30', { valueUsd: 150 })]);
  const comparison = get13FQuarterComparison(history, '2026-06-30');
  assert.deepEqual(comparison.deltas.totalValueUsd, { change: 150, changePct: null });
  assert.deepEqual(comparison.deltas.top10Pct, { change: null, changePct: null });
  history.quarters[1].totalValueUsd = Infinity;
  assert.deepEqual(get13FQuarterComparison(history, '2026-06-30').deltas.totalValueUsd, { change: null, changePct: null });
});

test('holding comparisons separate quantity, reported value, and portfolio share', () => {
  const history = historyFor([slot('2026-03-31', { quantity: 10, valueUsd: 100 }), slot('2026-06-30', { quantity: 12, valueUsd: 90 })]);
  const comparison = get13FHoldingQuarterComparison(history, KEY, '2026-06-30');
  assert.equal(comparison.available, true);
  assert.equal(comparison.changeStatus, 'increased');
  assert.deepEqual(comparison.deltas.quantity, { change: 2, changePct: 20 });
  assert.deepEqual(comparison.deltas.valueUsd, { change: -10, changePct: -10 });
  assert.deepEqual(comparison.deltas.weightPct, { change: 0, changePct: 0 });
});

test('holding entry, exit and zero quantities are distinguished without buy or sell claims', () => {
  const history = historyFor([slot('2025-12-31', { present: false }), slot('2026-03-31', { quantity: 0 }), slot('2026-06-30', { present: false })]);
  const entry = get13FHoldingQuarterComparison(history, KEY, '2026-03-31');
  assert.equal(entry.changeStatus, 'newly-reported');
  assert.deepEqual(entry.deltas.quantity, { change: 0, changePct: null });
  assert.equal(entry.baseline.status, 'not-reported');
  assert.equal(entry.current.status, 'reported');
  const exit = get13FHoldingQuarterComparison(history, KEY, '2026-06-30');
  assert.equal(exit.changeStatus, 'no-longer-reported');
  assert.equal(exit.deltas.valueUsd.change, -100);
  assert.equal(exit.deltas.weightPct.change, null);
});

test('unrequested securities and missing quarter observations are unknown, never zero exits', () => {
  const history = historyFor([slot('2026-03-31'), slot('2026-06-30', { keys: [OTHER_KEY] })]);
  const unrequested = get13FHoldingQuarterComparison(history, KEY, '2026-06-30');
  assert.equal(unrequested.available, false);
  assert.equal(unrequested.current.status, 'unknown');
  assert.equal(unrequested.deltas.quantity.change, null);
  const missing = historyFor([slot('2025-12-31'), slot('2026-06-30')]);
  assert.equal(get13FHoldingQuarterComparison(missing, KEY, '2026-06-30').available, false);
});

test('security classes, option types and quantity units remain distinct in holding comparisons', () => {
  for (const key of ['00827B106|PUT|SH', '00827B106|SECURITY|PRN', OTHER_KEY]) {
    const history = historyFor([slot('2026-03-31', { keys: [KEY, key] }), slot('2026-06-30', { keys: [KEY, key] })]);
    const comparison = get13FHoldingQuarterComparison(history, key, '2026-06-30');
    assert.equal(comparison.changeStatus, 'not-reported');
    assert.equal(comparison.deltas.quantity.change, 0);
  }
});

test('CSV preserves exact USD metrics, explicit gaps, zero values, and valid source links', () => {
  const history = historyFor([
    slot('2025-12-31', { valueUsd: 123456789.125 }),
    { period: '2026-03-31', status: 'unavailable', reason: 'Report unavailable' },
    slot('2026-06-30', { valueUsd: 0 }),
  ]);
  Object.assign(history.quarters[0], { checkedAt: '2026-09-16T20:00:00Z', observedAt: '2026-09-16T19:30:00Z', stale: true });
  const csv = create13FHistoryCsv(history);
  const rows = readCsv(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].manager_cik, CIK);
  assert.equal(rows[0].total_reported_value_usd, '123456789.125');
  assert.equal(rows[0].checked_at, '2026-09-16T20:00:00Z');
  assert.equal(rows[0].observed_at, '2026-09-16T19:30:00Z');
  assert.equal(rows[0].stale, 'true');
  assert.equal(rows[1].stale, '');
  assert.equal(rows[0].source_accessions, '0001747057-26-000001');
  assert.equal(rows[0].source_filing_dates, '2026-08-14');
  assert.match(rows[0].source_urls, /https:\/\/www.sec.gov\/Archives\/example.xml/);
  assert.equal(rows[1].snapshot_status, 'unavailable');
  assert.equal(rows[1].total_reported_value_usd, '');
  assert.equal(rows[1].reported_positions, '');
  assert.equal(rows[2].total_reported_value_usd, '0');
  assert.equal(rows[2].comparison_baseline_quarter, '2026-03-31');
  assert.equal(rows[2].comparison_status, 'unavailable');
  assert.equal(rows[2].total_reported_value_change_usd, '');
  assert.ok(csv.endsWith('\r\n'));
});

test('CSV retains partial observed counts without exporting unreconciled totals', () => {
  const history = historyFor([slot('2026-03-31'), slot('2026-06-30', { complete: false, valueUsd: 500, issues: ['Missing information table'] })]);
  const rows = readCsv(create13FHistoryCsv(history));
  assert.equal(rows[1].snapshot_status, 'incomplete');
  assert.equal(rows[1].observed_positions, '1');
  assert.equal(rows[1].reported_positions, '');
  assert.equal(rows[1].total_reported_value_usd, '');
  assert.equal(rows[1].comparison_status, 'unavailable');
});

test('CSV escapes source text and rejects formula injection and unsafe source URLs', () => {
  const history = historyFor([slot('2026-06-30', {
    issues: ['=HYPERLINK("https://example.com", "unsafe")'],
    filings: [{ accession: '@SUM(1+1)', filingDate: '+1', filingUrl: 'javascript:alert(1)', indexUrl: 'https://sec.gov.evil.example/a', tableUrls: ['https://www.sec.gov/Archives/safe.xml', 'https://name:password@www.sec.gov/Archives/private.xml', 'http://www.sec.gov/Archives/insecure.xml'] }],
  })]);
  const [row] = readCsv(create13FHistoryCsv(history));
  assert.equal(row.source_accessions, "'@SUM(1+1)");
  assert.equal(row.source_filing_dates, "'+1");
  assert.equal(row.coverage_note, '\'=HYPERLINK("https://example.com", "unsafe")');
  assert.equal(row.source_urls, 'https://www.sec.gov/Archives/safe.xml');
});

test('CSV quarterly changes use unrounded units and suppress noncomparable pairs', () => {
  const history = historyFor([slot('2026-03-31', { valueUsd: 300 }), slot('2026-06-30', { valueUsd: 299.75 })]);
  history.quarters[0].top10Pct = 20.125;
  history.quarters[1].top10Pct = 20.5;
  const [first, second] = readCsv(create13FHistoryCsv(history));
  assert.equal(first.comparison_status, 'unavailable');
  assert.equal(second.total_reported_value_change_usd, '-0.25');
  assert.equal(second.top_10_share_change_percentage_points, '0.375');
  history.quarters[1].confidentialOmitted = true;
  const limited = readCsv(create13FHistoryCsv(history))[1];
  assert.equal(limited.comparable_public_scope, 'false');
  assert.equal(limited.total_reported_value_change_usd, '');
  assert.equal(limited.total_reported_value_usd, '299.75');
});
