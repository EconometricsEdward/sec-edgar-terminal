import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CFTC_LAUNCH_CATALOG } from '../src/utils/cftc.js';
import { buildCftcHistoryResponse } from '../src/utils/cftcServer.js';
import {
  buildPortfolioMarketComparison, createPortfolioMarketComparisonLoader,
  PORTFOLIO_MARKET_COMPARISON_CONCURRENCY, PORTFOLIO_MARKET_COMPARISON_LIMIT,
} from '../src/utils/portfolioMarketComparisonServer.js';

const now = new Date('2026-09-09T12:00:00Z');
const sourceFixtures = Object.fromEntries(['tff-gpe5-46if', 'disaggregated-72hh-3qpy'].map(name => [
  name.split('-')[0], JSON.parse(readFileSync(new URL(`./fixtures/cftc-${name}-v1.json`, import.meta.url), 'utf8'))[0],
]));
const histories = new Map();
function history({ family, code, group }) {
  const key = `${family}:${code}:${group}`;
  if (!histories.has(key)) {
    const rawRows = Array.from({ length: 53 }, (_, index) => ({
      ...sourceFixtures[family], id: `${code}-${index}`,
      cftc_contract_market_code: code,
      report_date_as_yyyy_mm_dd: new Date(Date.parse('2026-09-08T00:00:00Z') - index * 7 * 86_400_000).toISOString().slice(0, -1),
    }));
    histories.set(key, buildCftcHistoryResponse({ family, code, group, throughDate: '2026-09-08', window: '1y', rawRows, retrievedAt: now.toISOString() }));
  }
  return structuredClone(histories.get(key));
}
const build = options => buildPortfolioMarketComparison({ now, loadHistory: async selection => history(selection), ...options });

test('one fixed public comparison returns exactly 25 distinct default-group identities and compact summaries', async () => {
  const calls = [];
  const result = await build({ loadHistory: async selection => { calls.push(selection); return history(selection); } });
  assert.equal(result.schemaVersion, 'edgar.portfolio-market-comparison.v1');
  assert.equal(result.generatedAt, now.toISOString());
  assert.equal(result.status, 'ready');
  assert.equal(result.results.length, PORTFOLIO_MARKET_COMPARISON_LIMIT);
  assert.equal(new Set(result.results.map(row => row.key)).size, 25);
  assert.deepEqual(calls.map(call => [call.family, call.code]), CFTC_LAUNCH_CATALOG.map(item => [item.family, item.code]));
  for (const [index, call] of calls.entries()) {
    assert.equal(call.preparedOnly, true);
    assert.equal(call.window, '1y');
    assert.equal(call.reportDate, 'latest');
    assert.equal(call.group, call.family === 'tff' ? 'leveraged-funds' : 'managed-money');
    assert.equal(Object.hasOwn(call, 'forceRefresh'), false);
    assert.ok(call.signal instanceof AbortSignal);
    assert.ok(call.deadlineMs <= 12_000);
    const row = result.results[index];
    assert.equal(row.status, 'ready');
    assert.equal(row.summary.key, row.key);
    assert.equal(row.summary.reportDate, '2026-09-08');
    assert.match(row.summary.sourceUrl, /^https:\/\/publicreporting\.cftc\.gov\//);
    assert.equal(Object.hasOwn(row.summary, 'history'), false);
    assert.equal(Object.hasOwn(row.summary, 'selected'), false);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 40_000);
  assert.doesNotMatch(JSON.stringify(result), /"raw"|"portfolio"|"allocation"|"weights"/);
});

test('prepared comparison permits no more than three simultaneous history reads', async () => {
  let active = 0, maximum = 0, count = 0;
  const result = await build({ loadHistory: async selection => {
    count++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return history(selection);
  } });
  assert.equal(count, 25);
  assert.equal(maximum, PORTFOLIO_MARKET_COMPARISON_CONCURRENCY);
  assert.equal(result.status, 'ready');
});

test('cache misses remain explicit and source failures never leak provider details', async () => {
  let count = 0;
  const result = await build({ loadHistory: async selection => {
    count++;
    if (count === 1) throw Object.assign(new Error('private source credentials'), { code: 'CFTC_REPORT_NOT_PREPARED' });
    if (count === 2) throw Object.assign(new Error('private source credentials'), { code: 'INTERNAL_PRIVATE_CODE' });
    return history(selection);
  } });
  assert.equal(result.status, 'partial');
  assert.equal(result.results[0].errorCode, 'CFTC_REPORT_NOT_PREPARED');
  assert.equal(result.results[1].errorCode, 'CFTC_UNAVAILABLE');
  assert.equal(result.results[0].summary, null);
  assert.doesNotMatch(JSON.stringify(result), /private|credentials|INTERNAL_PRIVATE_CODE/);
  const unavailable = await build({ loadHistory: async () => null });
  assert.equal(unavailable.status, 'unavailable');
  assert.ok(unavailable.results.every(row => row.summary === null && row.errorCode === 'CFTC_COMPARISON_INVALID'));
});

test('a valid history for another contract or participant group cannot be labeled ready', async () => {
  for (const mutate of [
    selection => ({ ...selection, code: selection.code === '13874A' ? '209742' : '13874A' }),
    selection => ({ ...selection, group: selection.family === 'tff' ? 'asset-manager' : 'producer-merchant' }),
  ]) {
    const result = await build({ loadHistory: async selection => history(mutate(selection)) });
    assert.equal(result.status, 'unavailable');
    assert.ok(result.results.every(row => row.status === 'unavailable' && row.errorCode === 'CFTC_COMPARISON_INVALID'));
  }
});

test('stale or incomplete usable data makes the public snapshot partial, never ready', async () => {
  const stale = await build({ now: new Date('2026-10-01T12:00:00Z') });
  assert.equal(stale.status, 'partial');
  assert.ok(stale.results.every(row => row.summary.stale));
  const incomplete = await build({ loadHistory: async selection => {
    const value = history(selection); value.status = 'partial'; return value;
  } });
  assert.equal(incomplete.status, 'partial');
  assert.ok(incomplete.results.every(row => row.summary.incomplete));
});

test('the shared deadline returns all 25 outcomes when readers ignore cancellation and starts no queued work', async () => {
  let calls = 0;
  const started = Date.now();
  const result = await build({ deadlineMs: 25, loadHistory: async selection => {
    calls++;
    return selection.code === '13874A' ? history(selection) : new Promise(() => {});
  } });
  assert.ok(Date.now() - started < 750);
  assert.equal(calls, 4);
  assert.equal(result.status, 'partial');
  assert.equal(result.results.length, 25);
  assert.equal(result.results[0].status, 'ready');
  assert.ok(result.results.slice(1).every(row => row.status === 'unavailable' && row.errorCode === 'CFTC_TIMEOUT'));
});

test('already cancelled work performs no reads and retains every market identity', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = await build({ signal: controller.signal, loadHistory: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.results.length, 25);
  assert.ok(result.results.every(row => row.errorCode === 'CFTC_REQUEST_CANCELLED'));
});

test('one brief cache coalesces callers, clones responses, expires, and respects the feature switch', async () => {
  let clock = Number(now), calls = 0, enabled = true;
  const load = createPortfolioMarketComparisonLoader({ now: () => clock, enabled: () => enabled, loadHistory: async selection => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 1));
    return history(selection);
  } });
  const [first, second] = await Promise.all([load(), load()]);
  assert.equal(calls, 25);
  assert.deepEqual(first, second);
  first.results[0].summary.netPctOi = 999;
  assert.notEqual((await load()).results[0].summary.netPctOi, 999);
  assert.equal(calls, 25);
  clock += 300_001;
  await load();
  assert.equal(calls, 50);
  enabled = false;
  await assert.rejects(load(), { code: 'CFTC_DISABLED' });
  assert.equal(calls, 50);
});

test('partial snapshots expire after a minute and cancellation does not poison another caller', async () => {
  let clock = Number(now), calls = 0;
  const load = createPortfolioMarketComparisonLoader({ now: () => clock, loadHistory: async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 2));
    return null;
  } });
  const controller = new AbortController();
  const cancelled = load({ signal: controller.signal });
  const stillWaiting = load();
  controller.abort();
  await assert.rejects(cancelled, { code: 'CFTC_REQUEST_CANCELLED' });
  assert.equal((await stillWaiting).status, 'unavailable');
  assert.equal(calls, 25);
  clock += 59_000;
  await load();
  assert.equal(calls, 25);
  clock += 1001;
  await load();
  assert.equal(calls, 50);
});
