import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThirteenFComparison, THIRTEEN_F_COMPARISON_SCHEMA } from '../src/utils/thirteenFComparison.js';

const period = '2026-06-30', now = Date.parse('2026-09-16T12:00:00Z');
const A = '0001747057', B = '0001350694', C = '0001067983', D = '0001037389';
const X = '00827B106', Y = '02079K305', Z = '037833100';
const key = (cusip, putCall = null, quantityType = 'SH') => `${cusip}|${putCall || 'SECURITY'}|${quantityType}`;
function holding(cusip = X, valueUsd = 100, overrides = {}) {
  const row = { cusip, valueUsd, quantity: 10, putCall: null, quantityType: 'SH', issuer: `Issuer ${cusip}`, classTitle: 'COM', ...overrides };
  return { ...row, key: key(row.cusip, row.putCall, row.quantityType), weightPct: 999 };
}
function report(cik = A, holdings = [holding()], overrides = {}) {
  return {
    status: 'ready', manager: { cik, name: `Manager ${cik}` }, selectedPeriod: period, observedAt: '2026-09-15T12:00:00Z',
    coverage: { selectedPeriodComplete: true }, summary: { totalValueUsd: 123, top10Pct: 999 },
    portfolio: {
      cik, period, holdings, totalValueUsd: holdings.reduce((total, row) => total + (row.valueUsd ?? 0), 0),
      complete: true, comparable: true, confidentialOmitted: false, reportType: '13F HOLDINGS REPORT',
      amendmentCount: 0, entryCount: holdings.length, issues: [],
      filings: [{ accession: `${cik}-26-000001`, filingDate: '2026-08-14', indexUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${cik}26000001/form-index.html`, tableUrls: ['https://www.sec.gov/example.xml'] }],
      ...overrides,
    },
  };
}
const build = (slots, options = {}) => buildThirteenFComparison(slots, { period, now, ...options });

test('same-quarter overlap uses complete denominators, ignores supplied summaries and is symmetric', () => {
  const a = report(A, [holding(X, 60), holding(Y, 40)]);
  const b = report(B, [holding(X, 20), holding(Z, 80)]);
  const model = build([a, b]), pair = model.pairs[0];
  assert.equal(model.schemaVersion, THIRTEEN_F_COMPARISON_SCHEMA);
  assert.equal(pair.sharedCount, 1); assert.equal(pair.unionCount, 3);
  assert.ok(Math.abs(pair.jaccardPct - 100 / 3) < 1e-10); assert.equal(pair.overlapPct, 20);
  assert.equal(pair.leftCommonSharePct, 60); assert.equal(pair.rightCommonSharePct, 20);
  assert.equal(pair.leftCommonValueUsd, 60); assert.equal(pair.rightCommonValueUsd, 20);
  assert.equal(pair.largestContributor.key, key(X)); assert.equal(pair.largestContributor.contributionPct, 20);
  assert.equal(model.managers[0].largestWeightPct, 60);
  assert.equal(model.sharedHoldings[0].cells[0].sharePct, 60);
  assert.equal(build([b, a]).pairs[0].overlapPct, pair.overlapPct);
  assert.equal(build([b, a]).pairs[0].key, pair.key);
  assert.match(model.findings.find(finding => finding.id === 'largest-overlap').text, /weighted overlap is 20.0%/);
});

test('options, principal amounts and share classes remain distinct without guessed issuer matching', () => {
  const a = report(A, [holding(X, 10), holding(X, 20, { putCall: 'PUT' }), holding(X, 30, { putCall: 'CALL' }), holding(X, 40, { quantityType: 'PRN' }), holding(Y, 100, { issuer: 'Same company', classTitle: 'CLASS A' })]);
  const b = report(B, [holding(X, 50, { classTitle: 'COMMON STOCK' }), holding(X, 50, { putCall: 'PUT' }), holding(Z, 100, { issuer: 'Same company', classTitle: 'CLASS B' })]);
  const model = build([a, b]);
  assert.equal(model.pairs[0].sharedCount, 2); assert.equal(model.pairs[0].overlapPct, 15);
  assert.deepEqual(model.sharedHoldings.map(row => row.key), [key(X, 'PUT'), key(X)]);
  assert.equal(model.managers[0].putSharePct, 10); assert.equal(model.managers[0].callSharePct, 15); assert.equal(model.managers[0].principalSharePct, 20);
  assert.equal(model.sharedHoldings.find(row => row.key === key(X)).cells[1].classTitle, 'COMMON STOCK');
});

test('incomplete tables retain actual matching rows but withhold complete overlap counts and percentages', () => {
  const a = report(A, [holding(X, 60), holding(Y, 40)]);
  const partial = report(B, [holding(X, 20)], { complete: false, totalValueUsd: null, issues: ['Missing information table'] });
  const model = build([a, partial]), pair = model.pairs[0];
  assert.equal(pair.sharedCount, null); assert.equal(pair.observedSharedCount, 1);
  assert.equal(pair.overlapPct, null); assert.equal(pair.jaccardPct, null); assert.equal(pair.leftCommonSharePct, null);
  assert.equal(pair.observedLeftCommonValueUsd, 60); assert.equal(pair.observedRightCommonValueUsd, 20);
  assert.equal(model.sharedHoldings[0].cells[0].sharePct, 60); assert.equal(model.sharedHoldings[0].cells[1].sharePct, null);
  assert.equal(model.managers[1].totalValueUsd, null); assert.equal(model.managers[1].observedValueUsd, 20);
  assert.equal(model.managers[1].positionCount, null); assert.equal(model.managers[1].observedPositionCount, 1);
  assert.equal(model.coverage.incompleteManagers, 1); assert.equal(model.findings.some(row => row.id === 'coverage-gap'), true);
});

test('missing and still-loading managers are explicit gaps and cannot become zero holdings', () => {
  const a = report(A), b = report(B);
  const model = build([a, b, { cik: C, name: 'Missing manager', status: 'unavailable', reason: 'SEC temporarily unavailable.' }, { cik: D, name: 'Loading manager', status: 'loading' }]);
  assert.equal(model.managers[2].observedPositionCount, null); assert.equal(model.managers[3].status, 'loading');
  assert.deepEqual(model.sharedHoldings[0].cells.slice(2).map(row => [row.status, row.valueUsd, row.sharePct]), [['unknown', null, null], ['unknown', null, null]]);
  assert.equal(model.pairs.filter(pair => pair.observedSharedCount === null).length, 5);
  assert.equal(model.coverage.weightedPairs, 1); assert.equal(model.coverage.totalPairs, 6);
  assert.equal(model.managers[2].reason, 'SEC temporarily unavailable.');
  // A stale report attached to an unfinished request does not become a result.
  const stale = build([{ cik: A, status: 'loading', data: a }, b]);
  assert.equal(stale.managers[0].positionCount, null); assert.equal(stale.pairs[0].observedSharedCount, null);
  const neverFiled = build([a, { status: 'unavailable', manager: { cik: B }, selectedPeriod: null, portfolio: null, reason: 'No 13F filings were found.' }]);
  assert.equal(neverFiled.managers[1].status, 'unavailable'); assert.equal(neverFiled.managers[1].reason, 'No 13F filings were found.');
});

test('zero reported values and complete empty tables differ from missing information', () => {
  const zero = report(A, [holding(X, 0)]), nonzero = report(B, [holding(X, 100)]);
  const model = build([zero, nonzero]);
  assert.equal(model.pairs[0].sharedCount, 1); assert.equal(model.pairs[0].jaccardPct, 100); assert.equal(model.pairs[0].overlapPct, null);
  assert.equal(model.sharedHoldings[0].cells[0].status, 'reported'); assert.equal(model.sharedHoldings[0].cells[0].valueUsd, 0);
  assert.equal(model.managers[0].totalValueUsd, 0); assert.equal(model.managers[0].top10Pct, null);
  const empty = build([report(A, []), report(B, [])]);
  assert.equal(empty.pairs[0].sharedCount, 0); assert.equal(empty.pairs[0].observedSharedCount, 0);
  assert.equal(empty.pairs[0].jaccardPct, null); assert.equal(empty.pairs[0].overlapPct, null);
  assert.equal(empty.managers[0].positionCount, 0); assert.equal(empty.coverage.allComplete, true);
});

test('confidential and combination scope retain public overlap while absence remains unknown', () => {
  for (const limited of [{ confidentialOmitted: true }, { reportType: '13F COMBINATION REPORT' }, { comparable: false }]) {
    const model = build([report(A, [holding(X)]), report(B, [holding(X)]), report(C, [holding(Y)], limited)]);
    assert.equal(model.pairs[0].overlapPct, 100); assert.equal(model.pairs[1].overlapPct, 0);
    assert.equal(model.pairs[1].publicScopeLimited, true);
    assert.equal(model.managers[2].totalValueUsd, 100); assert.equal(model.managers[2].absenceKnown, false);
    assert.equal(model.sharedHoldings[0].cells[2].status, 'unknown'); assert.equal(model.sharedHoldings[0].cells[2].valueUsd, null);
    assert.match(model.managers[2].scopeNote, /disclosed table only/);
  }
  const complete = build([report(A), report(B), report(C, [holding(Y)])]);
  assert.deepEqual(complete.sharedHoldings[0].cells[2], { cik: C, status: 'not-reported', issuer: null, classTitle: null, quantity: 0, valueUsd: 0, sharePct: 0 });
});

test('period, identity, duplicate, future snapshot and size guards fail closed', () => {
  const a = report(A), b = report(B);
  assert.throws(() => build([a]), /two and four/);
  assert.throws(() => build([a, b, report(C), report(D), a]), /two and four/);
  assert.throws(() => build([a, a]), /itself/);
  assert.throws(() => build([a, { ...b, selectedPeriod: '2026-03-31' }]), /selected quarter/);
  assert.throws(() => build([a, report(B, [holding()], { period: '2026-03-31' })]), /portfolio identity/);
  assert.throws(() => build([{ cik: C, data: a }, b]), /manager identity/);
  assert.throws(() => build([report(A, [holding(), holding()]), b]), /duplicate/);
  assert.throws(() => build([report(A, [{ ...holding(), key: key(Y) }]), b]), /security key/);
  assert.throws(() => build([a, { ...b, observedAt: '2027-01-01T00:00:00Z' }]), /snapshot timestamp/);
  assert.throws(() => build([a, b], { period: '2026-06-29' }), /report quarter/);
  assert.throws(() => build([a, b], { period: '2027-06-30' }), /report quarter/);
  assert.throws(() => build([a, b], { maxSharedHoldings: 201 }), /display limit/);
  assert.throws(() => build([report(A, Array(20001).fill(holding())), b]), /excessive/);
});

test('unknown values, precision overflow, mismatched totals and incomplete archives withhold denominators', () => {
  const cases = [
    report(A, [holding(X, null)], { totalValueUsd: 100 }),
    report(A, [holding(X, 100)], { totalValueUsd: 101 }),
    report(A, [holding(X, Number.MAX_SAFE_INTEGER), holding(Y, 100)]),
    { ...report(A), coverage: { selectedPeriodComplete: false } },
  ];
  for (const first of cases) {
    const model = build([first, report(B)]);
    assert.equal(model.managers[0].status, 'incomplete'); assert.equal(model.managers[0].totalValueUsd, null);
    assert.equal(model.managers[0].top10Pct, null); assert.equal(model.pairs[0].overlapPct, null);
    assert.equal(model.sharedHoldings[0].cells[0].sharePct, null);
  }
  assert.equal(build([cases[0], report(B)]).sharedHoldings[0].cells[0].valueUsd, null);
});

test('amendments and observation times remain traceable without mutating source reports', () => {
  const a = report(A), b = report(B), copy = structuredClone(a);
  b.observedAt = '2026-09-16T10:00:00Z'; b.portfolio.amendmentCount = 1;
  b.portfolio.filings[0].superseded = true;
  b.portfolio.filings.push({ accession: `${B}-26-000002`, filingDate: '2026-09-16', isAmendment: true, amendmentType: 'RESTATEMENT', amendmentNumber: 1, tableUrls: ['https://www.sec.gov/new.xml'] });
  const model = build([a, b]);
  assert.equal(model.snapshot.earliestObservedAt, a.observedAt); assert.equal(model.snapshot.latestObservedAt, b.observedAt);
  assert.deepEqual(model.snapshot.observations[1].activeAccessions, [`${B}-26-000002`]);
  assert.equal(model.snapshot.observations[1].amendmentCount, 1);
  model.managers[0].filings[0].tableUrls.push('unrelated');
  assert.deepEqual(a, copy);
  assert.equal(model.managers[1].filings[1].amendmentType, 'RESTATEMENT');
});

test('research anchors use one actual complete report and preserve its exact security fields', () => {
  const partial = report(A, [holding(X, 20, { classTitle: 'PARTIAL DESCRIPTION' })], { complete: false, totalValueUsd: null });
  const full = report(B, [holding(X, 80, { classTitle: 'COMMON STOCK', quantity: 123 })]);
  const first = build([partial, full]).sharedHoldings[0];
  assert.equal(first.anchorCik, B);
  assert.deepEqual(first.anchorHolding, { key: key(X), cusip: X, issuer: `Issuer ${X}`, classTitle: 'COMMON STOCK', quantity: 123, quantityType: 'SH', putCall: null, valueUsd: 80 });
  const noCompleteAnchor = build([partial, report(B, [holding()], { complete: false, totalValueUsd: null })]).sharedHoldings[0];
  assert.equal(noCompleteAnchor.anchorCik, null); assert.equal(noCompleteAnchor.anchorHolding, null);
  first.anchorHolding.valueUsd = 0;
  assert.equal(full.portfolio.holdings[0].valueUsd, 80);
});

test('shared rows are bounded while counts and overlap still include the full portfolios', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => holding(String(index).padStart(9, '0'), index + 1));
  const model = build([report(A, rows), report(B, rows)], { maxSharedHoldings: 12 });
  assert.equal(model.sharedHoldings.length, 12); assert.equal(model.totalSharedHoldings, 1000);
  assert.equal(model.sharedHoldingsTruncated, true); assert.equal(model.pairs[0].sharedCount, 1000);
  assert.ok(Math.abs(model.pairs[0].overlapPct - 100) < 1e-10);
  assert.equal(model.sharedHoldings[0].cusip, '000000999');
  assert.equal(model.managers[0].positionCount, 1000);
  assert.equal(Object.hasOwn(model.managers[0], 'positions'), false);
});

test('pair-specific top holdings use all matching securities before the global display limit', () => {
  const a = report(A, [holding(X, 40), holding(Y, 30), holding(Z, 30)]);
  const b = report(B, [holding(X, 100), holding(Y, 100), holding(Z, 800)]);
  const c = report(C, [holding(X, 100)]);
  const model = build([a, b, c], { maxSharedHoldings: 1 });
  assert.equal(model.sharedHoldings[0].key, key(X)); // The only holding reported by all three.
  assert.equal(model.pairs[0].sharedHoldings[0].key, key(Z)); // Largest minimum share for A/B.
  assert.equal(model.pairs[0].sharedHoldings.length, 3);
  assert.equal(model.pairs[0].sharedHoldingsTruncated, false);
  assert.equal(model.pairs[0].sharedHoldings[0].cells.length, 3);
  assert.equal(model.pairs[0].sharedHoldings[0].anchorCik, A);
  const rows = Array.from({ length: 21 }, (_, index) => holding(String(index).padStart(9, '0'), index + 1));
  const bounded = build([report(A, rows), report(B, rows)], { maxSharedHoldings: 1 });
  assert.equal(bounded.pairs[0].sharedCount, 21); assert.equal(bounded.pairs[0].sharedHoldings.length, 20);
  assert.equal(bounded.pairs[0].sharedHoldingsTruncated, true);
});

test('finding objects remain deterministic, use available evidence and distinguish matching from exposure', () => {
  const a = report(A, [holding(X, 100)]), b = report(B, [holding(X, 20), holding(Y, 80)]), c = report(C, [holding(Y, 100)]);
  const first = build([a, b, c]), second = build([a, b, c]);
  assert.deepEqual(first, second);
  assert.equal(first.findings[0].pairKey, [B, C].sort().join(':'));
  assert.equal(first.findings[0].metric.value, 80);
  assert.equal(first.findings.find(row => row.id === 'shared-security').holdingKey, key(Y));
  assert.ok(first.findings.every(finding => typeof finding.text === 'string' && finding.managerCiks.length));
  assert.match(first.notes.join(' '), /not current portfolios/);
  assert.match(first.notes.join(' '), /not expanded/);
});
