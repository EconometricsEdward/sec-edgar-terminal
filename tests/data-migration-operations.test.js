import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeDataMigration, parseMigrationOperation, readMigrationOperation, migrationRetrySeconds } from '../src/utils/dataMigrationOperations.js';

test('migration operations deny missing, mismatched, and weak authorization', () => {
  const secret = 'test-only-operational-secret';
  const request = token => new Request('http://localhost/api/internal/data-migration', { headers: { authorization: token } });
  assert.equal(authorizeDataMigration(request('')), false);
  assert.equal(authorizeDataMigration(request('Bearer incorrect'), secret), false);
  assert.equal(authorizeDataMigration(request('Bearer short'), 'short'), false);
  assert.equal(authorizeDataMigration(request(`Bearer ${secret}`), secret), true);
});

test('operator cannot submit arbitrary datasets, URLs, cursors, or unbounded work', () => {
  for (const value of [null, [], { action: 'refresh-sec', cursor: 99 }, { action: 'delete' }, { action: 'refresh-sec', maxCompanies: 3 }, { action: 'refresh-sec', maxCompanies: 0 }]) {
    assert.throws(() => parseMigrationOperation(value));
  }
  assert.deepEqual(parseMigrationOperation({ action: 'refresh-sec' }), { action: 'refresh-sec', maxCompanies: 1 });
});

test('job retry preserves long provider Retry-After and adds bounded exponential backoff', () => {
  assert.equal(migrationRetrySeconds({ retryAfter: '7200' }, 2), 7200);
  assert.equal(migrationRetrySeconds({ retryAfter: 'Thu, 01 Jan 2026 02:00:00 GMT' }, 2, Date.parse('2026-01-01T00:00:00Z')), 7200);
  assert.ok(migrationRetrySeconds({}, 2) >= 60);
  assert.ok(migrationRetrySeconds({}, 2) < 70);
});

test('operation body is bounded even with no Content-Length', async () => {
  await assert.rejects(() => readMigrationOperation(new Request('http://localhost/', { method: 'POST', body: 'x'.repeat(1025) })), /exceeds/);
  assert.deepEqual(await readMigrationOperation(new Request('http://localhost/', { method: 'POST', body: '{"action":"refresh-sec"}' })), { action: 'refresh-sec', maxCompanies: 1 });
});
