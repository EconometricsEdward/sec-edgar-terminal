import test from 'node:test';
import assert from 'node:assert/strict';
import { createThirteenFInitialChartLoader } from '../src/utils/thirteenFInitialChart.js';

const market = { family: 'tff', contract: '099741', group: 'leveraged-funds' };
const chart = { report_family: 'tff', selection: { contract: '099741', group: 'leveraged-funds', history_window: '1y' }, retrieved_at: '2026-09-09T12:00:00Z' };

test('initial chart reuses prepared data with source dates intact and bounded return-visit memory', async () => {
  let calls = 0, clock = 0;
  const loader = createThirteenFInitialChartLoader({ now: () => clock, load: async options => {
    calls++; assert.equal(options.preparedOnly, true); assert.equal(options.deadlineMs, 3000); return chart;
  } });
  assert.equal(loader.peek(market), null); assert.equal(calls, 0);
  assert.deepEqual(await loader(market), chart);
  assert.deepEqual(loader.peek(market), chart);
  assert.deepEqual(await loader(market), chart); assert.equal(calls, 1);
  clock = 300001; assert.equal(loader.peek(market), null);
  await loader(market); assert.equal(calls, 2);
});

test('chart background task has a deadline even if a store read ignores cancellation', async () => {
  const loader = createThirteenFInitialChartLoader({ budgetMs: 15, load: async () => new Promise(() => {}) });
  assert.equal(await loader(market), null);
});

test('chart identity mismatches, oversized responses and missing publications stay optional', async () => {
  for (const value of [{ ...chart, report_family: 'disaggregated' }, { ...chart, selection: { ...chart.selection, contract: '13874A' } },
    { ...chart, extra: 'x'.repeat(200000) }, null]) {
    const loader = createThirteenFInitialChartLoader({ load: async () => value });
    assert.equal(await loader(market), null);
  }
});

test('canonical prepared chart reads skip optional hot probes within the background deadline', async () => {
  const persistence = { mode: () => 'supabase' };
  const loader = createThirteenFInitialChartLoader({ persistence,
    cacheGet: async () => { assert.fail('The optional hot cache cannot precede canonical chart reads.'); },
    load: async options => {
      assert.strictEqual(options.persistence, persistence); assert.equal(options.preparedOnly, true);
      assert.equal(options.deadlineMs, 3000); assert.equal(await options.cacheGet('ignored', 'ignored'), null);
      return chart;
    },
  });
  assert.deepEqual(await loader(market), chart);
});

test('noncanonical modes preserve the injected prepared cache reader', async () => {
  for (const mode of ['off', 'shadow']) {
    const cacheGet = async () => ({ preserved: mode }), persistence = { mode: () => mode };
    const loader = createThirteenFInitialChartLoader({ persistence, cacheGet, load: async options => {
      assert.strictEqual(options.cacheGet, cacheGet); assert.strictEqual(options.persistence, persistence);
      return chart;
    } });
    assert.deepEqual(await loader(market), chart);
  }
});

test('simultaneous visitors share one read while synchronous peeks never wait or fetch', async () => {
  let calls = 0, release;
  const loader = createThirteenFInitialChartLoader({ load: async () => {
    calls++; return new Promise(resolve => { release = resolve; });
  } });
  const first = loader(market), second = loader(market);
  assert.equal(loader.peek(market), null);
  await Promise.resolve(); assert.equal(calls, 1);
  release(chart);
  assert.deepEqual(await Promise.all([first, second]), [chart, chart]);
  assert.deepEqual(loader.peek(market), chart);
  assert.equal(calls, 1);
});

test('failed prepared reads are cooled down without giving misses fabricated chart data', async () => {
  let calls = 0, clock = 0;
  const loader = createThirteenFInitialChartLoader({ now: () => clock, load: async () => { calls++; return null; } });
  assert.equal(await loader(market), null);
  assert.equal(loader.peek(market), null);
  assert.equal(await loader(market), null); assert.equal(calls, 1);
  clock = 60001;
  assert.equal(await loader(market), null); assert.equal(calls, 2);
});

test('actual reads stay bounded after deadlines when storage ignores cancellation', async () => {
  let calls = 0, clock = 0;
  const releases = [];
  const loader = createThirteenFInitialChartLoader({ budgetMs: 5, now: () => clock, load: async () => {
    calls++; return new Promise(resolve => { releases.push(resolve); });
  } });
  const markets = Array.from({ length: 8 }, (_, index) => ({ ...market, contract: String(index).padStart(6, '0') }));
  assert.deepEqual(await Promise.all(markets.map(value => loader(value))), Array(8).fill(null));
  assert.equal(calls, 4);
  clock = 60001;
  assert.deepEqual(await Promise.all(markets.map(value => loader(value))), Array(8).fill(null));
  assert.equal(calls, 4, 'A timed-out read must retain its slot until the adapter settles.');
  releases.forEach(resolve => resolve(chart));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loader.peek(markets[0]), null, 'Late aborted responses cannot enter the warm cache.');
  await loader(markets[4]); assert.equal(calls, 5, 'Settled reads release their slots.');
  releases.at(-1)(null);
});

test('aborted callers do not start prepared reads and cancellation releases the managed wait', async () => {
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  let calls = 0;
  const loader = createThirteenFInitialChartLoader({ load: async ({ signal }) => {
    calls++;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }));
  } });
  await assert.rejects(loader(market, { signal: alreadyAborted.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const controller = new AbortController(), pending = loader(market, { signal: controller.signal });
  await Promise.resolve(); controller.abort();
  assert.equal(await pending, null); assert.equal(calls, 1);
  assert.equal(loader.peek(market), null);
});

test('cache evicts the least recently used chart without exceeding its entry bound', async () => {
  let calls = 0;
  const loader = createThirteenFInitialChartLoader({ maxEntries: 2, load: async ({ code }) => {
    calls++; return { ...chart, selection: { ...chart.selection, contract: code } };
  } });
  const second = { ...market, contract: '13874A' }, third = { ...market, contract: '13874B' };
  await loader(market); await loader(second); loader.peek(market);
  await loader(third);
  assert.deepEqual(loader.peek(market), chart);
  assert.equal(loader.peek(second), null);
  assert.ok(loader.peek(third)); assert.equal(calls, 3);
});
