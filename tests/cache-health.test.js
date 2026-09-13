import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDisposableCache } from '../src/utils/cacheHealth.js';

const fixture = () => ({ schema: 1, observedAt: '2026-09-13T17:00:00Z', payloadBytes: 6, rows: 6, maxPayloadBytes: 600,
  families: ['snapshot', 'checkpoint', 'research', 'document', 'reference', 'history'].map(family => ({
    family, payloadBytes: 1, rows: 1, maxPayloadBytes: 100, maxRows: 10, maxTtlSeconds: 300,
    puts: 1, deduplicatedPuts: 0, evictedRows: 0, expiredRows: 0, expiredPendingRows: 0, evictLive: family === 'research',
  })), maintenance: { mode: 'inventory', state: { rawKey: 'must-not-leak', queuedPayload: 'must-not-leak' } } });

test('cache health exposes aggregate pressure without private migration state', () => {
  const input = fixture();
  const summary = summarizeDisposableCache(input, { inspected: 10 });
  assert.equal(summary.status, 'healthy');
  assert.deepEqual(summary.maintenance.summary, { inspected: 10 });
  assert.doesNotMatch(JSON.stringify(summary), /must-not-leak|rawKey|queuedPayload/);
  input.families[2].payloadBytes = 90;
  assert.equal(summarizeDisposableCache(input).status, 'watch');
  input.families[2].payloadBytes = 1; input.families[0].rows = 9;
  assert.equal(summarizeDisposableCache(input).status, 'watch');
});

test('cache health does not call incomplete or invalid capacity evidence healthy', () => {
  for (const input of [null, {}, { ...fixture(), families: [] }, { ...fixture(), observedAt: 'bad' }]) {
    assert.equal(summarizeDisposableCache(input).status, 'unavailable');
  }
  const duplicate = fixture(); duplicate.families[1] = duplicate.families[0];
  assert.equal(summarizeDisposableCache(duplicate).status, 'unavailable');
  const invalid = fixture(); invalid.families[1].rows = -1;
  assert.equal(summarizeDisposableCache(invalid).status, 'unavailable');
});
