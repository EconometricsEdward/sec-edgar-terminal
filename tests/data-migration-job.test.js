import test from 'node:test';
import assert from 'node:assert/strict';
import { runSecMigrationJob } from '../src/utils/dataMigrationJob.js';
import { GET, POST } from '../src/app/api/internal/data-migration/route.js';

test('protected status and refresh deny unauthenticated clients before accessing stores', async () => {
  for (const handler of [GET, POST]) {
    const response = await handler(new Request('http://localhost/api/internal/data-migration'));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('daily scheduled invocation caps work at four companies on a single durable claim', async () => {
  const cursors = []; let final;
  const result = await runSecMigrationJob({ maxCompanies: 2, maxBatches: 2 }, {
    enqueue: async () => 'job', claimJob: async () => ({ id: 'job', checkpoint: { cursor: 0 }, attempts: 1 }),
    checkpointJob: async (_claim, { checkpoint }) => { assert.equal(checkpoint.cursor, 2); return true; },
    refresh: async ({ cursor, maxCompanies }) => { cursors.push(cursor); assert.equal(maxCompanies, 2); return { nextCursor: cursor + 2, done: cursor === 2, coverage: 4, results: [{ ticker: 'fixture', status: 'prepared' }] }; },
    finish: async (_claim, value) => { final = value; return true; },
  });
  assert.deepEqual(cursors, [0, 2]);
  assert.equal(result.status, 'done');
  assert.equal(final.checkpoint.cursor, 4);
});

test('failed second batch preserves completed first-batch cursor for retry', async () => {
  let final;
  await assert.rejects(() => runSecMigrationJob({ maxCompanies: 2, maxBatches: 2 }, {
    enqueue: async () => 'job', claimJob: async () => ({ id: 'job', checkpoint: { cursor: 0 }, attempts: 1 }),
    checkpointJob: async () => true,
    refresh: async ({ cursor }) => { if (cursor === 2) throw new Error('Interruption'); return { nextCursor: 2, done: false, coverage: 4, results: [] }; },
    finish: async (_claim, value) => { final = value; return true; },
  }), /Interruption/);
  assert.equal(final.checkpoint.cursor, 2);
  assert.equal(final.status, 'retry');
});

test('duplicate trigger cannot invoke refresh without a durable job claim', async () => {
  let calls = 0;
  const result = await runSecMigrationJob({}, { enqueue: async () => 'job', claimJob: async () => null, refresh: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.status, 'busy-or-finished');
});

test('a new daily trigger resumes the oldest eligible checkpoint rather than resetting its cursor', async () => {
  let resumed;
  await runSecMigrationJob({}, {
    enqueue: async () => 'today',
    claimJob: async options => { assert.equal(options.jobKey, undefined); return { id: 'yesterday', checkpoint: { cursor: 3 }, attempts: 2 }; },
    refresh: async ({ cursor }) => { resumed = cursor; return { nextCursor: 4, done: true, coverage: 4, results: [] }; },
    finish: async () => true,
  });
  assert.equal(resumed, 3);
});
