import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarPeriods13F, project13FHistoryQuarter, summarize13FHistory, get13FHoldingHistory } from '../src/utils/thirteenFHistory.js';

const CIK = '0001747057';
const KEY = '00827B106|SECURITY|SH';
const OTHER_KEY = '02079K305|SECURITY|SH';
function position({ cusip = '00827B106', putCall = null, quantityType = 'SH', quantity = 10, valueUsd = 100, classTitle = 'COM CL A' } = {}) {
  return { key: `${cusip}|${putCall || 'SECURITY'}|${quantityType}`, cusip, issuer: 'Example issuer', classTitle, putCall, quantityType, quantity, valueUsd };
}
function portfolio(period, holdings = [position()], overrides = {}) {
  const totalValueUsd = holdings.reduce((sum, row) => sum + (row.valueUsd ?? 0), 0);
  return {
    cik: CIK, period, holdings: holdings.map((row) => ({ ...row, weightPct: totalValueUsd > 0 ? row.valueUsd / totalValueUsd * 100 : null })),
    complete: true, comparable: true, confidentialOmitted: false, reportType: '13F HOLDINGS REPORT',
    totalValueUsd, positionCount: holdings.length, entryCount: holdings.length, amendmentCount: 0, issues: [],
    filings: [{ accession: '0001747057-26-000001', filingDate: '2026-08-14', indexUrl: 'https://www.sec.gov/Archives/example-index.html', tableUrls: ['https://www.sec.gov/Archives/example.xml'] }],
    ...overrides,
  };
}
function slot(period, holdings, overrides, keys = [KEY]) {
  return { period, status: 'ready', projection: project13FHistoryQuarter(portfolio(period, holdings, overrides), keys) };
}
const historyFor = (slots) => summarize13FHistory(slots, { cik: CIK });

test('calendar history crosses year boundaries and accepts only bounded quarter-end windows', () => {
  assert.deepEqual(calendarPeriods13F('2026-06-30', 4), ['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30']);
  for (const [end, count] of [['2026-06-29', 4], ['2026-02-31', 4], ['2026-06-30', 0], ['2026-06-30', 13], ['2026-06-30', 1.5], ['0000-12-31', 1]]) {
    assert.throws(() => calendarPeriods13F(end, count), /Invalid SEC 13F history/);
  }
});

test('quarter projection is compact and explicitly distinguishes selected from unrequested securities', () => {
  const rows = [position(), position({ cusip: '02079K305', valueUsd: 300 }), position({ putCall: 'PUT', valueUsd: 50 }), position({ quantityType: 'PRN', valueUsd: 50 })];
  const full = portfolio('2026-06-30', rows);
  const projected = project13FHistoryQuarter(full, [KEY, '00827B106|CALL|SH']);
  assert.equal(Object.hasOwn(projected, 'holdings'), false);
  assert.deepEqual(projected.trackedKeys, [KEY, '00827B106|CALL|SH']);
  assert.equal(projected.positions[KEY].cusip, '00827B106');
  assert.equal(projected.positions[KEY].weightPct, 20);
  assert.equal(projected.positions['00827B106|CALL|SH'], null);
  assert.equal(Object.hasOwn(projected.positions, OTHER_KEY), false);
  assert.equal(projected.positionCount, 4);
  assert.equal(projected.totalValueUsd, 500);
  assert.equal(projected.largestWeightPct, 60);
  assert.equal(projected.top5Pct, 100);
  assert.deepEqual(projected.filings, full.filings);
  projected.filings[0].tableUrls.push('another');
  assert.equal(full.filings[0].tableUrls.length, 1);
});

test('quarter projection rejects malformed keys, duplicate assembled positions and invalid identities', () => {
  const full = portfolio('2026-06-30');
  for (const keys of [[KEY, '__proto__'], ['00827B106|SECURITY|SH|COM'], Array(33).fill(KEY), null]) assert.throws(() => project13FHistoryQuarter(full, keys), /keys/);
  assert.throws(() => project13FHistoryQuarter({ ...full, holdings: [position(), position()] }, [KEY]), /duplicate/);
  assert.throws(() => project13FHistoryQuarter({ ...full, cik: '0' }), /identity/);
  assert.throws(() => project13FHistoryQuarter({ ...full, period: '2026-06-29' }), /identity/);
  assert.deepEqual(project13FHistoryQuarter(full, [KEY, KEY]).trackedKeys, [KEY]);
});

test('incomplete reports retain actual observed rows but never chart incomplete totals as zero', () => {
  const partial = slot('2026-06-30', [position()], { complete: false, comparable: false, totalValueUsd: null, issues: ['Missing attachment'] });
  const history = historyFor([partial]);
  const quarter = history.quarters[0];
  assert.equal(quarter.status, 'incomplete');
  assert.equal(quarter.observedPositionCount, 1);
  for (const field of ['totalValueUsd', 'positionCount', 'top5Pct', 'top10Pct', 'largestWeightPct']) assert.equal(quarter[field], null);
  const observation = get13FHoldingHistory(history, KEY).observations[0];
  assert.equal(observation.status, 'reported');
  assert.equal(observation.valueUsd, 100);
  assert.equal(observation.quantity, 10);
  assert.equal(observation.weightPct, null);
  assert.equal(history.coverage.incompleteQuarters, 1);
});

test('history sorts quarters and inserts calendar gaps instead of bridging missing reports', () => {
  const june = slot('2026-06-30', [position({ quantity: 20 })]);
  const december = slot('2025-12-31');
  const original = JSON.stringify([june, december]);
  const history = historyFor([june, december]);
  assert.deepEqual(history.quarters.map((quarter) => quarter.period), ['2025-12-31', '2026-03-31', '2026-06-30']);
  assert.equal(history.quarters[1].status, 'unavailable');
  assert.equal(history.quarters[1].positionCount, null);
  assert.equal(history.coverage.unavailableQuarters, 1);
  const selected = get13FHoldingHistory(history, KEY);
  assert.deepEqual(selected.observations.map((observation) => observation.status), ['reported', 'unknown', 'reported']);
  assert.equal(selected.observations[2].quantityChange, null);
  assert.equal(selected.quantityChanges.comparablePairs, 0);
  assert.equal(selected.persistence.consecutiveObservedQuarters, 1);
  assert.equal(JSON.stringify([june, december]), original);
});

test('history rejects ambiguous quarter records, mixed managers and mismatched observation identities', () => {
  const june = slot('2026-06-30');
  assert.throws(() => historyFor([june, june]), /duplicate/);
  assert.throws(() => historyFor([{ ...june, projection: { ...june.projection, cik: '0000000123' } }]), /manager/);
  assert.throws(() => historyFor([{ ...june, projection: { ...june.projection, period: '2026-03-31' } }]), /quarter/);
  assert.throws(() => historyFor([{ ...june, projection: { ...june.projection, positions: {} } }]), /observation/);
  assert.throws(() => historyFor([{ ...june, projection: { ...june.projection, positions: { [KEY]: { key: OTHER_KEY } } } }]), /identity/);
  assert.throws(() => summarize13FHistory([june], { cik: 'AAPL' }), /CIK/);
});

test('position history measures observed persistence and repeated quantity changes within the loaded window', () => {
  const history = historyFor([
    slot('2025-09-30', [position({ quantity: 10 })]),
    slot('2025-12-31', [position({ quantity: 15 })]),
    slot('2026-03-31', [position({ quantity: 20 })]),
    slot('2026-06-30', [position({ quantity: 12 })]),
  ]);
  const selected = get13FHoldingHistory(history, KEY);
  assert.deepEqual(selected.observations.map((observation) => observation.changeStatus), ['unavailable', 'increased', 'increased', 'decreased']);
  assert.deepEqual(selected.persistence, { firstObservedPeriod: '2025-09-30', lastObservedPeriod: '2026-06-30', observedQuarters: 4, consecutiveObservedQuarters: 4, observedAtWindowStart: true });
  assert.deepEqual(selected.quantityChanges, { increased: 2, decreased: 1, unchanged: 0, newlyReported: 0, noLongerReported: 0, comparablePairs: 3, increaseStreak: 0, decreaseStreak: 1 });
  assert.equal(selected.observations[1].quantityChangePct, 50);
  assert.equal(selected.observations[3].quantityChangePct, -40);
  assert.match(selected.notes.join(' '), /do not establish when/);
  assert.match(selected.notes.join(' '), /Corporate actions/);
});

test('current increase streak stops at any unknown quarter and resumes only on subsequent comparable pairs', () => {
  const history = historyFor([
    slot('2025-06-30', [position({ quantity: 10 })]),
    { period: '2025-09-30', status: 'unavailable', reason: 'Missing original report' },
    slot('2025-12-31', [position({ quantity: 20 })]),
    slot('2026-03-31', [position({ quantity: 30 })]),
    slot('2026-06-30', [position({ quantity: 40 })]),
  ]);
  const selected = get13FHoldingHistory(history, KEY);
  assert.equal(selected.quantityChanges.increased, 2);
  assert.equal(selected.quantityChanges.increaseStreak, 2);
  assert.equal(selected.persistence.consecutiveObservedQuarters, 3);
  assert.equal(selected.observations[2].changeStatus, 'unavailable');
  const latestMissing = historyFor([...history.quarters.map((projection) => ({ period: projection.period, status: projection.status, ...(['ready', 'incomplete'].includes(projection.status) ? { projection } : {}) })), { period: '2026-09-30', status: 'loading' }]);
  const unavailable = get13FHoldingHistory(latestMissing, KEY);
  assert.equal(unavailable.quantityChanges.increaseStreak, 0);
  assert.equal(unavailable.persistence.consecutiveObservedQuarters, 0);
});

test('absence is zero only for a tracked position in a complete comparable public report', () => {
  const history = historyFor([
    slot('2025-09-30', [position({ cusip: '02079K305' })]),
    slot('2025-12-31'),
    slot('2026-03-31', [position({ cusip: '02079K305' })]),
    slot('2026-06-30', []),
  ]);
  const selected = get13FHoldingHistory(history, KEY);
  assert.deepEqual(selected.observations.map((observation) => observation.status), ['not-reported', 'reported', 'not-reported', 'not-reported']);
  assert.deepEqual(selected.observations.map((observation) => observation.changeStatus), ['unavailable', 'newly-reported', 'no-longer-reported', 'not-reported']);
  assert.equal(selected.observations[0].valueUsd, 0);
  assert.equal(selected.observations[0].weightPct, 0);
  assert.equal(selected.observations[3].weightPct, null); // A zero report has no meaningful weight denominator.
  assert.equal(selected.quantityChanges.newlyReported, 1);
  assert.equal(selected.quantityChanges.noLongerReported, 1);
  assert.equal(selected.quantityChanges.comparablePairs, 2);
  assert.equal(selected.persistence.observedAtWindowStart, false);
  assert.equal(selected.persistence.firstObservedPeriod, '2025-12-31');
  assert.equal(selected.persistence.consecutiveObservedQuarters, 0);
});

test('unrequested positions cannot become fabricated exits or quantity zeros', () => {
  const history = historyFor([
    slot('2025-12-31'),
    slot('2026-03-31', [position({ quantity: 20 })], {}, []),
    slot('2026-06-30', [position({ quantity: 30 })]),
  ]);
  const selected = get13FHoldingHistory(history, KEY);
  assert.equal(selected.observations[1].status, 'unknown');
  assert.equal(selected.observations[1].quantity, null);
  assert.match(selected.observations[1].reason, /not requested/);
  assert.equal(selected.quantityChanges.comparablePairs, 0);
  assert.equal(selected.quantityChanges.newlyReported, 0);
  assert.equal(selected.quantityChanges.noLongerReported, 0);
});

test('confidential and combination scopes preserve public summary statistics but prevent absence and changes', () => {
  for (const scope of [{ confidentialOmitted: true, comparable: false }, { reportType: '13F COMBINATION REPORT', comparable: false }, { reportType: '13F COMBINATION REPORT', comparable: true }]) {
    const history = historyFor([slot('2026-03-31'), slot('2026-06-30', [position({ cusip: '02079K305', valueUsd: 300 })], scope)]);
    assert.equal(history.quarters[1].totalValueUsd, 300);
    assert.equal(history.quarters[1].top10Pct, 100);
    assert.equal(history.quarters[1].comparable, false);
    const selected = get13FHoldingHistory(history, KEY);
    assert.equal(selected.observations[1].status, 'unknown');
    assert.equal(selected.observations[1].valueUsd, null);
    assert.equal(selected.quantityChanges.comparablePairs, 0);
  }
  const present = get13FHoldingHistory(historyFor([slot('2026-03-31'), slot('2026-06-30', [position({ quantity: 20 })], { confidentialOmitted: true })]), KEY);
  assert.equal(present.observations[1].status, 'reported');
  assert.equal(present.observations[1].quantity, 20);
  assert.equal(present.observations[1].changeStatus, 'unavailable');
});

test('options, principal units and share classes are distinct while descriptive class wording may change', () => {
  const putKey = '00827B106|PUT|SH';
  const principalKey = '00827B106|SECURITY|PRN';
  const keys = [KEY, putKey, principalKey, OTHER_KEY];
  const history = historyFor([
    slot('2026-03-31', [position({ quantity: 10 }), position({ putCall: 'PUT', quantity: 90 }), position({ quantityType: 'PRN', quantity: 1000 }), position({ cusip: '02079K305', quantity: 50 })], {}, keys),
    slot('2026-06-30', [position({ classTitle: 'CLASS A COMMON STOCK', quantity: 20 }), position({ putCall: 'PUT', quantity: 80 }), position({ quantityType: 'PRN', quantity: 1000 }), position({ cusip: '02079K305', quantity: 50 })], {}, keys),
  ]);
  assert.equal(get13FHoldingHistory(history, KEY).quantityChanges.increased, 1);
  assert.equal(get13FHoldingHistory(history, putKey).quantityChanges.decreased, 1);
  assert.equal(get13FHoldingHistory(history, principalKey).quantityChanges.unchanged, 1);
  assert.equal(get13FHoldingHistory(history, OTHER_KEY).quantityChanges.unchanged, 1);
  assert.equal(get13FHoldingHistory(history, KEY).identity.classTitle, 'CLASS A COMMON STOCK');
});

test('actual zero quantity is still a reported row and never produces infinite percentage changes', () => {
  const history = historyFor([slot('2026-03-31', [position({ quantity: 0, valueUsd: 0 })]), slot('2026-06-30', [position({ quantity: 10 })])]);
  const selected = get13FHoldingHistory(history, KEY);
  assert.equal(selected.observations[0].status, 'reported');
  assert.equal(selected.observations[0].quantity, 0);
  assert.equal(selected.observations[0].weightPct, null);
  assert.equal(selected.observations[1].changeStatus, 'increased');
  assert.equal(selected.observations[1].quantityChangePct, null);
});

test('a bounded truncated history never claims lifetime holding tenure', () => {
  const slots = Array.from({ length: 16 }, (_, index) => {
    const year = 2023 + Math.floor(index / 4);
    const end = ['03-31', '06-30', '09-30', '12-31'][index % 4];
    return slot(`${year}-${end}`);
  });
  const history = historyFor(slots);
  assert.equal(history.quarters.length, 12);
  assert.equal(history.coverage.historyTruncated, true);
  assert.equal(history.coverage.firstPeriod, '2024-03-31');
  const selected = get13FHoldingHistory(history, KEY);
  assert.equal(selected.persistence.firstObservedPeriod, '2024-03-31');
  assert.equal(selected.persistence.observedQuarters, 12);
  assert.equal(selected.persistence.observedAtWindowStart, true);
  assert.match(selected.notes[0], /loaded window/);
});

test('failed and loading slots do not reuse stale projections as observed history', () => {
  const stale = slot('2026-03-31');
  const history = historyFor([{ ...stale, status: 'unavailable', reason: 'SEC temporarily unavailable' }, { ...slot('2026-06-30'), status: 'pending' }]);
  assert.deepEqual(history.quarters.map((quarter) => quarter.status), ['unavailable', 'loading']);
  assert.equal(history.coverage.loadedQuarters, 0);
  assert.equal(history.coverage.loadingQuarters, 1);
  const selected = get13FHoldingHistory(history, KEY);
  assert.deepEqual(selected.observations.map((observation) => observation.status), ['unknown', 'unknown']);
  assert.equal(selected.persistence.observedQuarters, 0);
});

test('empty history is usable before the first response arrives', () => {
  const history = summarize13FHistory([], { cik: '1747057' });
  assert.equal(history.cik, CIK);
  assert.equal(history.quarters.length, 0);
  assert.equal(history.coverage.firstPeriod, null);
  const selected = get13FHoldingHistory(history, KEY);
  assert.equal(selected.identity, null);
  assert.equal(selected.observations.length, 0);
  assert.equal(selected.persistence.firstObservedPeriod, null);
  assert.equal(selected.persistence.observedAtWindowStart, false);
});
