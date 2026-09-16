import test from 'node:test';
import assert from 'node:assert/strict';
import { createThirteenFInitialChartLoader } from '../src/utils/thirteenFInitialChart.js';

const market = { family: 'tff', contract: '099741', group: 'leveraged-funds' };
const chart = { report_family: 'tff', selection: { contract: '099741', group: 'leveraged-funds', history_window: '1y' }, retrieved_at: '2026-09-09T12:00:00Z' };

test('initial chart reuses prepared data with source dates intact and bounded return-visit memory', async () => {
  let calls = 0, clock = 0;
  const loader = createThirteenFInitialChartLoader({ now: () => clock, load: async options => {
    calls++; assert.equal(options.preparedOnly, true); assert.equal(options.deadlineMs, 1000); return chart;
  } });
  assert.deepEqual(await loader(market), chart);
  assert.deepEqual(await loader(market), chart); assert.equal(calls, 1);
  clock = 300001; await loader(market); assert.equal(calls, 2);
});

test('initial chart deadline releases the research snapshot even if a store read ignores cancellation', async () => {
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

test('canonical prepared chart reads skip optional hot probes without increasing the summary deadline', async () => {
  const persistence = { mode: () => 'supabase' };
  const loader = createThirteenFInitialChartLoader({ persistence,
    cacheGet: async () => { assert.fail('The optional hot cache cannot precede canonical chart reads.'); },
    load: async options => {
      assert.strictEqual(options.persistence, persistence); assert.equal(options.preparedOnly, true);
      assert.equal(options.deadlineMs, 1000); assert.equal(await options.cacheGet('ignored', 'ignored'), null);
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
