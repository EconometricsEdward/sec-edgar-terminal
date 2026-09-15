import test from 'node:test';
import assert from 'node:assert/strict';
import { createThirteenFComparisonLoader, normalize13FComparisonRequest, POPULAR_13F_MANAGERS } from '../src/utils/thirteenFComparisonServer.js';
import { GET } from '../src/app/api/fund-13f/compare/route.js';

const NOW = Date.parse('2026-09-15T12:00:00Z');
const QUARTER = '2026-06-30';
const PREVIOUS = '2026-03-31';
const CIKS = POPULAR_13F_MANAGERS.map(manager => manager.cik);
function report(cik, { period = QUARTER, periods = [QUARTER, PREVIOUS], complete = true, value = 100, observed = NOW, expiry = observed + 300000, stale = false } = {}) {
  return {
    manager: { cik, name: `Manager ${Number(cik)}` }, status: 'ready', selectedPeriod: period,
    reports: periods.map(period => ({ period })), observedAt: new Date(observed).toISOString(),
    coverage: { selectedPeriodComplete: complete, historyComplete: true },
    cache: { status: 'source', checkedAt: new Date(observed).toISOString(), freshUntil: new Date(expiry).toISOString(), stale },
    portfolio: { cik, period, complete, comparable: true, reportType: '13F HOLDINGS REPORT', totalValueUsd: value, filings: [],
      holdings: [{ key: '123456789|SECURITY|SH', cusip: '123456789', issuer: 'Shared Company', classTitle: 'COM', putCall: null, quantityType: 'SH', quantity: 10, valueUsd: value }] },
  };
}

test('comparison request defaults to popular managers and rejects duplicate identities, excess managers, malformed and future quarters', () => {
  assert.deepEqual(normalize13FComparisonRequest(undefined, '', { now: NOW }), { ciks: CIKS, period: '' });
  assert.deepEqual(normalize13FComparisonRequest('1350694,1067983', QUARTER, { now: NOW }).ciks, CIKS.slice(0, 2));
  for (const ciks of ['', '1', '1,2,3,4,5', '1,0000000001', 'https://sec.gov,2', '1,2,']) assert.throws(() => normalize13FComparisonRequest(ciks, '', { now: NOW }));
  for (const period of ['2026-02-31', '2026-06-29', '2026-09-30', '0000-03-31']) assert.throws(() => normalize13FComparisonRequest('1,2', period, { now: NOW }));
});

test('four aligned latest reports use only two concurrent loaders and preserve requested manager order', async () => {
  let active = 0, peak = 0;
  const calls = [];
  const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async (cik, options) => {
    calls.push({ cik, period: options.period }); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return report(cik);
  } });
  const data = await load(CIKS);
  assert.equal(peak, 2);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.period === ''));
  assert.deepEqual(data.selection.managerCiks, CIKS);
  assert.deepEqual(data.managers.map(manager => manager.cik), CIKS);
  assert.equal(data.selectedPeriod, QUARTER);
  assert.equal(data.selection.alignmentScope, 'all-managers');
  assert.equal(data.coverage.allComplete, true);
  assert.equal(data.pairs.length, 6);
  assert.ok(!JSON.stringify(data).includes('"holdings":'));
});

test('automatic selection finds the newest common quarter and reloads only mismatched latest reports', async () => {
  const calls = [];
  const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async (cik, { period }) => {
    calls.push([cik, period]);
    const latest = cik === CIKS[1] ? PREVIOUS : QUARTER;
    return report(cik, { period: period || latest, periods: cik === CIKS[1] ? [PREVIOUS, '2025-12-31'] : [QUARTER, PREVIOUS] });
  } });
  const data = await load(CIKS.slice(0, 2));
  assert.equal(data.selectedPeriod, PREVIOUS);
  assert.deepEqual(data.availablePeriods, [PREVIOUS]);
  assert.deepEqual(calls, [[CIKS[0], ''], [CIKS[1], ''], [CIKS[0], PREVIOUS]]);
  assert.ok(data.managers.every(manager => manager.period === PREVIOUS));
});

test('explicit quarter requests load that quarter directly and never eagerly load latest or previous holdings', async () => {
  const calls = [];
  const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async (cik, options) => { calls.push(options); return report(cik, { period: options.period }); } });
  const data = await load(CIKS.slice(0, 2), { period: PREVIOUS });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.period === PREVIOUS));
  assert.equal(data.selection.automatic, false);
});

test('a failed manager remains unknown while available managers determine a shared reporting quarter', async () => {
  const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async cik => { if (cik === CIKS[2]) throw new Error('Unavailable'); return report(cik); } });
  const data = await load(CIKS.slice(0, 3));
  assert.equal(data.coverage.completeManagers, 2);
  assert.equal(data.coverage.unavailableManagers, 1);
  assert.equal(data.selection.alignmentScope, 'available-managers');
  assert.equal(data.selection.commonQuarter, false);
  assert.equal(data.sharedHoldings[0].cells[2].status, 'unknown');
  assert.equal(data.sharedHoldings[0].cells[2].sharePct, null);
  assert.equal(data.cache.freshUntil, null);
});

test('disjoint histories choose the widest available quarter without mixing report periods', async () => {
  const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async (cik, { period }) => {
    const available = cik === CIKS[2] ? PREVIOUS : QUARTER;
    if (period && period !== available) return { manager: { cik }, status: 'unavailable', selectedPeriod: period, reports: [{ period: available }], portfolio: null };
    return report(cik, { period: available, periods: [available] });
  } });
  const data = await load(CIKS.slice(0, 3));
  assert.equal(data.selectedPeriod, QUARTER);
  assert.equal(data.selection.alignmentScope, 'partial');
  assert.match(data.selection.note, /most managers/);
  assert.equal(data.coverage.completeManagers, 2);
  assert.equal(data.managers[2].status, 'unavailable');
  assert.deepEqual(data.availablePeriods, [QUARTER, PREVIOUS]);
});

test('all-source failure cannot invent an automatic reporting quarter', async () => {
  const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async () => { throw new Error('Unavailable'); } });
  await assert.rejects(load(CIKS.slice(0, 2)), { status: 503, message: 'No reporting quarter could be loaded for these managers. Retry the comparison or select a report quarter.' });
});

test('compact cache expires at its earliest underlying report expiry and never renews the check time', async () => {
  let clock = NOW, calls = 0;
  const load = createThirteenFComparisonLoader({ now: () => clock, reportLoader: async cik => {
    calls++; return report(cik, { observed: clock - (cik === CIKS[0] ? 120000 : 0), expiry: clock + (cik === CIKS[0] ? 10000 : 300000) });
  } });
  const first = await load(CIKS.slice(0, 2));
  clock += 5000;
  const cached = await load(CIKS.slice(0, 2));
  assert.equal(calls, 2);
  assert.equal(cached.cache.status, 'memory');
  assert.equal(cached.cache.checkedAt, first.cache.checkedAt);
  assert.equal(cached.cache.freshUntil, first.cache.freshUntil);
  clock += 5001;
  await load(CIKS.slice(0, 2));
  assert.equal(calls, 4);
});

test('refresh bypasses compact cache, reaches each report loader and exposes amended reported values', async () => {
  const calls = [];
  const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async (cik, options) => {
    calls.push(options.refresh); return report(cik, { value: options.refresh ? 250 : 100 });
  } });
  await load(CIKS.slice(0, 2));
  const updated = await load(CIKS.slice(0, 2), { refresh: true });
  assert.deepEqual(calls, [false, false, true, true]);
  assert.equal(updated.managers[0].totalValueUsd, 250);
  assert.equal((await load(CIKS.slice(0, 2))).managers[0].totalValueUsd, 250);
});

test('an older in-flight comparison cannot overwrite a refresh that already finished', async () => {
  let release;
  const oldGate = new Promise(resolve => { release = resolve; });
  const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async (cik, { refresh }) => {
    if (!refresh) await oldGate;
    return report(cik, { value: refresh ? 250 : 100 });
  } });
  const old = load(CIKS.slice(0, 2));
  assert.equal((await load(CIKS.slice(0, 2), { refresh: true })).managers[0].totalValueUsd, 250);
  release();
  assert.equal((await old).managers[0].totalValueUsd, 100);
  assert.equal((await load(CIKS.slice(0, 2))).managers[0].totalValueUsd, 250);
});

test('an explicit failed refresh invalidates the previous compact cache immediately', async () => {
  let calls = 0, unavailable = false;
  const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async cik => {
    calls++;
    if (unavailable) throw new Error('Unavailable');
    return report(cik);
  } });
  await load(CIKS.slice(0, 2));
  unavailable = true;
  await assert.rejects(load(CIKS.slice(0, 2), { refresh: true }), { status: 503 });
  await assert.rejects(load(CIKS.slice(0, 2)), { status: 503 });
  assert.equal(calls, 6);
});

test('incomplete and stale source reports are never cached as complete fresh comparisons', async () => {
  for (const options of [{ complete: false }, { stale: true, observed: NOW - 600000, expiry: NOW - 300000 }]) {
    let calls = 0;
    const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async cik => { calls++; return report(cik, options); } });
    const first = await load(CIKS.slice(0, 2));
    await load(CIKS.slice(0, 2));
    assert.equal(calls, 4);
    assert.equal(first.cache.freshUntil, null);
    if (options.stale) { assert.equal(first.cache.stale, true); assert.equal(first.snapshot.earliestObservedAt, new Date(options.observed).toISOString()); }
  }
});

test('caller cancellation does not cancel another reader’s coalesced comparison', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const load = createThirteenFComparisonLoader({ now: () => NOW, reportLoader: async cik => { calls++; await gate; return report(cik); } });
  const controller = new AbortController();
  const first = load(CIKS.slice(0, 2), { signal: controller.signal });
  const second = load(CIKS.slice(0, 2));
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  release();
  assert.equal((await second).coverage.allComplete, true);
  assert.equal(calls, 2);
});

test('request work budget preserves completed reports and skips a late alignment request', async () => {
  let clock = NOW;
  const calls = [];
  const load = createThirteenFComparisonLoader({ now: () => clock, workBudgetMs: 100, reportLoader: async (cik, { period }) => {
    calls.push([cik, period]);
    if (cik === CIKS[1]) clock += 101;
    return report(cik, { period: cik === CIKS[0] ? QUARTER : PREVIOUS, periods: [QUARTER, PREVIOUS] });
  } });
  const data = await load(CIKS.slice(0, 2));
  assert.equal(calls.length, 2);
  assert.equal(data.selectedPeriod, QUARTER);
  assert.equal(data.coverage.completeManagers, 1);
  assert.match(data.managers[1].reason, /still being prepared/);
});

test('one report wait timeout leaves successful managers usable within the overall request budget', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const load = createThirteenFComparisonLoader({ now: () => NOW, reportTimeoutMs: 5, reportLoader: async cik => {
      if (cik === CIKS[1]) return new Promise(() => {});
      return report(cik);
    } });
    const data = await load(CIKS.slice(0, 3));
    assert.equal(data.coverage.completeManagers, 2);
    assert.match(data.managers[1].reason, /timed out/);
  } finally { clearTimeout(keepAlive); }
});

test('expired waits do not start more source jobs when the first two reports continue preparing', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  const started = [];
  try {
    // A fixed cache clock deliberately remains before deadlineAt. This verifies
    // the source-slot guard independently of wall-clock or timer rounding.
    const load = createThirteenFComparisonLoader({ now: () => NOW, workBudgetMs: 5, reportLoader: async cik => {
      started.push(cik);
      return new Promise(() => {}); // Source work ignores reader cancellation.
    } });
    const data = await load(CIKS, { period: QUARTER });
    assert.deepEqual(started, CIKS.slice(0, 2));
    assert.equal(data.coverage.unavailableManagers, 4);
    assert.match(data.managers[2].reason, /still being prepared/);
    assert.match(data.managers[3].reason, /still being prepared/);
  } finally { clearTimeout(keepAlive); }
});

test('comparison route rejects duplicate, oversized, unsupported and malformed requests before any source work', async () => {
  for (const query of ['ciks=1', 'ciks=1,1', 'ciks=1,2,3,4,5', 'ciks=1,2&ciks=3,4', 'ciks=1,2&period=2026-02-30', 'ciks=1,2&refresh=0', 'ciks=1,2&refresh=1&refresh=1', 'url=https://sec.gov']) {
    const response = await GET(new Request(`https://example.test/api/fund-13f/compare?${query}`));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
});
