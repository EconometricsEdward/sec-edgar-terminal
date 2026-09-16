import test from 'node:test';
import assert from 'node:assert/strict';
import { FUND_CATALOG } from '../src/utils/fundResearch.js';
import { PUBLIC_FUND_MANAGERS } from '../src/utils/fundPublicSelectors.js';
import { FUND_FRESH_MS } from '../src/utils/fundResearchCache.js';
import { THIRTEEN_F_FRESH_MS } from '../src/utils/thirteenFCache.js';
import { fundPrewarmCohort, prewarmFunds } from '../src/utils/fundPrewarm.js';

const NOW = Date.parse('2026-09-16T04:00:00Z');
const iso = value => new Date(value).toISOString();
function fund(ticker, checkedAt = iso(NOW), stale = false) {
  return { status: 'ready', ticker, cache: { checkedAt, stale } };
}
function manager(cik, checkedAt = iso(NOW), invalidatedAt) {
  return { checkedAt, ...(invalidatedAt ? { invalidatedAt } : {}), data: {
    status: 'ready', manager: { cik }, portfolio: { complete: true }, coverage: { selectedPeriodComplete: true },
  } };
}
const currentReaders = {
  readFund: async ticker => fund(ticker),
  readManager: async cik => manager(cik),
};

test('daily fund cohort is bounded, includes each public selection once, and rotates leading selections', () => {
  const first = fundPrewarmCohort(NOW);
  assert.equal(first.length, PUBLIC_FUND_MANAGERS.length + FUND_CATALOG.length);
  assert.deepEqual(first.filter(item => item.kind === '13f').map(item => item.cik).sort(), PUBLIC_FUND_MANAGERS.map(item => item.cik).sort());
  assert.deepEqual(first.filter(item => item.kind === 'nport').map(item => item.ticker).sort(), FUND_CATALOG.map(item => item.ticker).sort());
  const leading = Array.from({ length: 4 }, (_, index) => fundPrewarmCohort(NOW + index * 86400000).slice(0, 4));
  assert.equal(new Set(leading.flat().filter(item => item.kind === '13f').map(item => item.cik)).size, PUBLIC_FUND_MANAGERS.length);
  assert.equal(new Set(leading.flat().filter(item => item.kind === 'nport').map(item => item.ticker)).size, FUND_CATALOG.length);
});

test('current prepared funds perform no acquisition or publication', async () => {
  const prepare = () => assert.fail('Current reports must not trigger source work');
  const result = await prewarmFunds({ now: () => NOW, ...currentReaders, prepareFund: prepare, prepareManager: prepare });
  assert.equal(result.status, 'ready');
  assert.equal(result.current, PUBLIC_FUND_MANAGERS.length + FUND_CATALOG.length);
  assert.equal(result.refreshed, 0);
  assert.ok(result.results.every(row => row.checkedAt === iso(NOW)));
});

test('due reports use two bounded workers and confirm publication without forcing shared loaders', async () => {
  const fundRows = new Map(), managerRows = new Map();
  let active = 0, peak = 0, loads = 0;
  async function begin() {
    loads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
  }
  const result = await prewarmFunds({ now: () => NOW,
    readFund: async ticker => fundRows.get(ticker) || null,
    readManager: async cik => managerRows.get(cik) || null,
    prepareFund: async (ticker, accession, options) => {
      assert.equal(accession, ''); assert.ok(options.signal instanceof AbortSignal);
      assert.equal(Object.hasOwn(options, 'refresh'), false);
      await begin(); fundRows.set(ticker, fund(ticker)); return fund(ticker);
    },
    prepareManager: async (cik, options) => {
      assert.equal(Object.hasOwn(options, 'refresh'), false); assert.equal(Object.hasOwn(options, 'period'), false);
      await begin(); managerRows.set(cik, manager(cik)); return manager(cik).data;
    },
  });
  assert.equal(peak, 2);
  assert.equal(loads, PUBLIC_FUND_MANAGERS.length + FUND_CATALOG.length);
  assert.equal(result.status, 'ready'); assert.equal(result.refreshed, loads);
});

test('freshness rejects invalidated, stale, future-dated, or mismatched snapshots', async () => {
  const selected = new Set();
  const result = await prewarmFunds({ now: () => NOW,
    readFund: async ticker => {
      if (ticker === 'SPY') return fund(ticker, iso(NOW - FUND_FRESH_MS));
      if (ticker === 'VOO') return fund(ticker, iso(NOW + 1));
      if (ticker === 'VTI') return fund('WRONG');
      return fund(ticker);
    },
    readManager: async cik => {
      if (cik === PUBLIC_FUND_MANAGERS[0].cik) return manager(cik, iso(NOW), iso(NOW));
      if (cik === PUBLIC_FUND_MANAGERS[1].cik) return manager(cik, iso(NOW - THIRTEEN_F_FRESH_MS));
      return manager(cik);
    },
    prepareFund: async ticker => { selected.add(ticker); return fund(ticker); },
    prepareManager: async cik => { selected.add(cik); return manager(cik).data; },
  });
  assert.deepEqual([...selected].sort(), ['SPY', 'VOO', 'VTI', ...PUBLIC_FUND_MANAGERS.slice(0, 2).map(item => item.cik)].sort());
  assert.equal(result.status, 'partial'); assert.equal(result.stale, 4); assert.equal(result.unpersisted, 1);
  assert.equal(result.results.find(row => row.ticker === 'VOO').checkedAt, null);
});

test('valid local-only results, unavailable SEC coverage and failures are not advertised as prepared', async () => {
  const result = await prewarmFunds({ now: () => NOW,
    readFund: async () => null, readManager: async () => null,
    prepareFund: async ticker => ticker === 'SPY' ? { status: 'unavailable' } : fund(ticker),
    prepareManager: async () => { throw Object.assign(new Error('Provider failure with internal detail'), { code: 'SEC_13F_BUSY' }); },
  });
  assert.equal(result.status, 'partial'); assert.equal(result.refreshed, 0);
  assert.equal(result.unpersisted, FUND_CATALOG.length - 1); assert.equal(result.unavailable, 1);
  assert.equal(result.failed, PUBLIC_FUND_MANAGERS.length);
  assert.ok(!JSON.stringify(result).includes('internal detail'));
  assert.ok(result.results.filter(row => row.kind === '13f').every(row => row.code === 'SEC_13F_BUSY'));
});

test('deadline reserve prevents source work while still identifying current reports', async () => {
  const prepare = () => assert.fail('A source load needs its complete deadline window');
  const result = await prewarmFunds({ now: () => NOW, deadline: NOW + 59_999,
    readFund: async () => null, readManager: currentReaders.readManager,
    prepareFund: prepare, prepareManager: prepare,
  });
  assert.equal(result.status, 'partial'); assert.equal(result.current, PUBLIC_FUND_MANAGERS.length);
  assert.equal(result.skipped, FUND_CATALOG.length);
});

test('cancelled scheduler skips the entire cohort without reading or acquiring sources', async () => {
  const controller = new AbortController(); controller.abort();
  const unexpected = () => assert.fail('A cancelled scheduler cannot start work');
  const result = await prewarmFunds({ now: () => NOW, signal: controller.signal,
    readFund: unexpected, readManager: unexpected, prepareFund: unexpected, prepareManager: unexpected,
  });
  assert.equal(result.skipped, result.requested); assert.equal(result.status, 'partial');
});
