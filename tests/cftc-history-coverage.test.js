import test from 'node:test';
import assert from 'node:assert/strict';
import { publicCftcHistoryCoverage, selectCftcHistoryCoverage } from '../src/utils/cftcHistoryCoverage.js';

const reportDate = '2026-09-08';
const served = { status: 'ready', families: [
  { family: 'tff', status: 'ready', report_date: reportDate },
  { family: 'disaggregated', status: 'ready', report_date: reportDate },
] };
function job(patch = {}) {
  return { family: 'tff', reportDate, catalogHash: 'a'.repeat(64), shards: 32,
    shardIndexes: Array.from({ length: 32 }, (_, index) => index),
    counters: { contracts: 100, visited: 64, prepared: 60, limited: 15, failed: 4 },
    running: 3, owner: 'must-remain-private', lastProgressAt: '2026-09-14T12:00:00Z', ...patch };
}
function status(...jobs) { return { enabled: true, jobs, initialSecCycle: 'private', enabledAt: 'private' }; }
const expected = { family: 'tff', report_basis: 'futures_only', report_date: reportDate,
  contracts_total: 100, contracts_prepared: 60, contracts_limited: 15, contracts_pending: 36, contracts_unavailable: 4 };

test('public coverage separates unfinished and unavailable contracts while limited is a prepared subset', () => {
  const result = publicCftcHistoryCoverage(status(job()), served);
  assert.deepEqual(result, [expected]);
  assert.equal(result[0].contracts_prepared + result[0].contracts_pending + result[0].contracts_unavailable, result[0].contracts_total);
  assert.doesNotMatch(JSON.stringify(result), /owner|catalogHash|shards|visited|running|enabledAt|initialSecCycle|private/);
});

test('dead shards before their first contract are unavailable rather than permanently pending', () => {
  const terminal = job({ dead: 32, done: 0, running: 0,
    counters: { contracts: 100, visited: 100, prepared: 0, limited: 0, failed: 100 } });
  assert.deepEqual(publicCftcHistoryCoverage(status(terminal), served), [{ ...expected,
    contracts_prepared: 0, contracts_limited: 0, contracts_pending: 0, contracts_unavailable: 100 }]);
});

test('partially prepared terminal catalogs preserve limited history without double counting it as unavailable', () => {
  const terminal = job({ dead: 12, done: 20, running: 0,
    counters: { contracts: 100, visited: 100, prepared: 60, limited: 15, failed: 40 } });
  const [summary] = publicCftcHistoryCoverage(status(terminal), served);
  assert.deepEqual(summary, { ...expected, contracts_pending: 0, contracts_unavailable: 40 });
  assert.equal(summary.contracts_prepared + summary.contracts_unavailable, summary.contracts_total);
});

test('unprojected terminal failure counts are omitted rather than described as ongoing preparation', () => {
  const unstarted = job({ dead: 32, done: 0, running: 0,
    counters: { contracts: 100, visited: 0, prepared: 0, limited: 0, failed: 0 } });
  const partial = job({ dead: 12, done: 20, running: 0 });
  assert.deepEqual(publicCftcHistoryCoverage(status(unstarted), served), []);
  assert.deepEqual(publicCftcHistoryCoverage(status(partial), served), []);
  const active = job({ dead: 12, done: 12, running: 8 });
  assert.deepEqual(publicCftcHistoryCoverage(status(active), served), [expected]);
});

test('public coverage never presents partial shard discovery as a full catalog', () => {
  for (const patch of [
    { shards: 31 }, { shardIndexes: Array.from({ length: 31 }, (_, i) => i) },
    { shardIndexes: Array(32).fill(0) }, { shardIndexes: Array.from({ length: 32 }, (_, i) => i + 1) },
    { catalogHash: '' },
  ]) assert.deepEqual(publicCftcHistoryCoverage(status(job(patch)), served), []);
});

test('coverage keeps report families, dates, and catalog revisions separate', () => {
  const older = job({ reportDate: '2026-09-01' });
  const disaggregated = job({ family: 'disaggregated', catalogHash: 'b'.repeat(64) });
  assert.deepEqual(publicCftcHistoryCoverage(status(older, disaggregated), served), [{ ...expected, family: 'disaggregated' }]);
  assert.deepEqual(publicCftcHistoryCoverage(status(job(), job({ catalogHash: 'c'.repeat(64) })), served), []);
  assert.deepEqual(publicCftcHistoryCoverage(status(job(), job({ catalogHash: 'c'.repeat(64), shards: 1 })), served), []);
  assert.deepEqual(publicCftcHistoryCoverage(status(job()), { families: [{ family: 'tff', status: 'missing', report_date: reportDate }] }), []);
});

test('invalid aggregates cannot manufacture available history or negative pending counts', () => {
  for (const counters of [
    { contracts: 0, visited: 0, prepared: 0, limited: 0, failed: 0 },
    { contracts: 1001, visited: 0, prepared: 0, limited: 0, failed: 0 },
    { contracts: 100, visited: 101, prepared: 60, limited: 15, failed: 4 },
    { contracts: 100, visited: 50, prepared: 60, limited: 15, failed: 4 },
    { contracts: 100, visited: 64, prepared: 60, limited: 61, failed: 4 },
    { contracts: 100, visited: 64, prepared: 60, limited: 15, failed: -1 },
    { contracts: 100, visited: 64, prepared: 60.5, limited: 15, failed: 4 },
    { contracts: '100', visited: 64, prepared: 60, limited: 15, failed: 4 },
  ]) assert.deepEqual(publicCftcHistoryCoverage(status(job({ counters })), served), []);
});

test('missing, disabled, malformed, or excessive job summaries are optional', () => {
  for (const value of [null, {}, { enabled: false, jobs: [job()] }, { enabled: true, jobs: {} }, status(...Array(65).fill(job()))]) {
    assert.deepEqual(publicCftcHistoryCoverage(value, served), []);
  }
  assert.deepEqual(publicCftcHistoryCoverage(status(job()), null), []);
});

test('the UI only selects valid counts for its exact current family, date, basis, and catalog size', () => {
  assert.deepEqual(selectCftcHistoryCoverage([expected], 'tff', reportDate, 100), expected);
  for (const [summaries, family, date, size] of [
    [[expected], 'disaggregated', reportDate, 100], [[expected], 'tff', '2026-09-15', 100],
    [[expected], 'tff', reportDate, 101], [[expected, expected], 'tff', reportDate, 100],
    [[{ ...expected, report_basis: 'combined' }], 'tff', reportDate, 100],
    [[{ ...expected, contracts_limited: 61 }], 'tff', reportDate, 100],
    [[{ ...expected, contracts_pending: 40 }], 'tff', reportDate, 100],
    [[{ ...expected, report_date: '2026-02-31' }], 'tff', '2026-02-31', 100],
    [null, 'tff', reportDate, 100],
  ]) assert.equal(selectCftcHistoryCoverage(summaries, family, date, size), null);
  assert.deepEqual(selectCftcHistoryCoverage([{ ...expected, owner: 'private' }], 'tff', reportDate, 100), expected);
});
