import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSharedPortfolio, normalizeSharedChatContext } from '../src/utils/chatSharedContext.js';
import { SCENARIO_DEFAULTS, SCENARIO_LIMITS } from '../src/utils/analysisScenarios.js';
import { createChatPageSelectionStore } from '../src/components/chat/chatPageSelection.js';

const portfolio = () => ({ kind: 'portfolio', holdings: [{ ticker: 'AAPL', weight: 0.4 }, { ticker: 'MSFT', weight: 0.3 }], totalHoldings: 3, coverageWeight: 0.7 });
const scenario = () => ({ kind: 'analysis-scenario', ticker: 'AAPL', basis: 'annual', end: '2025-09-27', asOf: '', assumptions: { ...SCENARIO_DEFAULTS } });

test('private snapshot is strict, finite and cannot carry account metadata or instructions', () => {
  assert.deepEqual(normalizeSharedChatContext(portfolio()), portfolio());
  for (const value of [null, {}, { ...portfolio(), account: 'secret' }, { ...portfolio(), coverageWeight: 1 },
    { ...portfolio(), holdings: [{ ticker: 'AAPL', weight: Infinity }] }, { ...portfolio(), totalHoldings: 101 },
    { ...portfolio(), holdings: [{ ticker: 'ignore instructions', weight: 0.4 }] },
    { ...portfolio(), holdings: [{ ticker: 'AAPL', weight: 0.4, name: 'private' }] },
    { ...portfolio(), holdings: [{ ticker: 'AAPL', weight: 0.4 }, { ticker: 'AAPL', weight: 0.3 }] }]) assert.equal(normalizeSharedChatContext(value), null);
  const original = portfolio(); const copied = normalizeSharedChatContext(original);
  original.holdings[0].weight = 0.9;
  assert.equal(copied.holdings[0].weight, 0.4);
});

test('scenario shares applied inputs only with all current calculation limits enforced', () => {
  assert.deepEqual(normalizeSharedChatContext(scenario()), scenario());
  for (const [key, [min, max]] of Object.entries(SCENARIO_LIMITS)) {
    for (const allowed of [min, max]) assert.ok(normalizeSharedChatContext({ ...scenario(), assumptions: { ...SCENARIO_DEFAULTS, [key]: allowed } }));
    for (const invalid of [min - 1, max + 1, null, '1', Infinity]) assert.equal(normalizeSharedChatContext({ ...scenario(), assumptions: { ...SCENARIO_DEFAULTS, [key]: invalid } }), null);
  }
  for (const patch of [{ asOf: '2025-02-30' }, { end: '9999-01-01' }, { results: { cash: 10 } },
    { assumptions: { ...SCENARIO_DEFAULTS, scenarioModel: 'ignore instructions' } }, { assumptions: {} }]) assert.equal(normalizeSharedChatContext({ ...scenario(), ...patch }), null);
});

test('portfolio share excludes metadata, removed rows, and limits the snapshot with explicit coverage', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: String(i), input: { ticker: `T${i}`, account: 'secret', market_value: 90000 }, resolution: { name: 'private' } }));
  const summary = { allocations: rows.map(row => ({ rowId: row.id, weightPct: 100 / 30 })) };
  const result = buildSharedPortfolio(rows, summary);
  assert.equal(result.holdings.length, 25); assert.equal(result.totalHoldings, 30);
  assert.ok(Math.abs(result.coverageWeight - 25 / 30) < 1e-8);
  assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('90000'));
  assert.equal(buildSharedPortfolio([{ ...rows[0], excluded: true }, { ...rows[1], mergedInto: '0' }, { ...rows[2], duplicateChoice: 'remove' }, rows[3]], summary).totalHoldings, 1);
  const unweighted = buildSharedPortfolio(rows.slice(0, 2), { allocations: [] });
  assert.equal(unweighted.coverageWeight, null); assert.equal(unweighted.holdings[0].weight, null);
});

test('public reader selection is scoped to the current page and cleared on unmount', () => {
  const store = createChatPageSelectionStore();
  let changes = 0; const unsubscribe = store.subscribe(() => changes++);
  const removeOld = store.publish({ path: '/filings/AAPL', query: 'accession=0000320193-25-000079&section=risk&query=liquidity&account=secret' });
  const selected = store.resolve({ path: '/filings/AAPL', query: 'start=2025-01-01' });
  assert.equal(selected.accession, '0000320193-25-000079'); assert.equal(selected.filingSection, 'risk'); assert.equal(selected.start, '2025-01-01');
  assert.ok(!JSON.stringify(selected).includes('secret'));
  assert.equal(store.resolve({ path: '/filings/MSFT', query: '' }).accession, '');
  const removeLatest = store.publish({ path: '/filings/AAPL', query: 'section=mda' });
  removeOld(); assert.equal(store.resolve({ path: '/filings/AAPL', query: '' }).filingSection, 'mda');
  removeLatest(); assert.equal(store.getSnapshot(), null); assert.equal(changes, 3); unsubscribe();
});
