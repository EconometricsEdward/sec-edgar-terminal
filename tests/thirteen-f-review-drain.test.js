import test from 'node:test';
import assert from 'node:assert/strict';
import { createThirteenFReviewDrain, THIRTEEN_F_REVIEW_DRAIN_LIMITS } from '../src/utils/thirteenFReviewDrain.js';
import { runWithSecRequestBudget, takeSecRequestBudget } from '../src/utils/secRequestBudget.js';

test('a request arriving during a large review is handed the released lease within the same invocation', async () => {
  let time = 0, queued = false, active = false;
  const served = [], deadlines = [];
  const drain = createThirteenFReviewDrain({ now: () => time, worker: async ({ deadline }) => {
    assert.equal(active, false, 'only one worker can own the handoff at a time');
    deadlines.push(deadline);
    if (served.length === 2) return { status: 'idle', processed: 0 };
    active = true;
    const cik = queued ? '0001067983' : '0002012383';
    served.push(cik);
    if (!queued) { queued = true; time += 72_000; }
    else time += 30_000;
    active = false;
    return { status: 'progress', cik, period: '2026-06-30', processed: cik === '0001067983' ? 29 : 69 };
  } });
  const value = await drain();
  assert.deepEqual(served, ['0002012383', '0001067983']);
  assert.equal(value.processed, 98);
  assert.equal(value.reason, 'idle');
  assert.deepEqual(deadlines, [140_000, 140_000, 140_000]);
});

test('a worker reaching its own shorter deadline still hands off within the outer deadline', async () => {
  let time = 0, calls = 0;
  const drain = createThirteenFReviewDrain({ now: () => time, worker: async () => {
    calls++;
    if (calls === 1) { time = 75_000; return { status: 'deferred', reason: 'request-budget', processed: 5 }; }
    return { status: 'idle', processed: 0 };
  } });
  assert.equal((await drain()).processed, 5);
  assert.equal(calls, 2);
});

test('busy or empty queues exit immediately without sleeping, polling or repeating a claim', async () => {
  let calls = 0;
  const drain = createThirteenFReviewDrain({ worker: async () => { calls++; return { status: 'idle', processed: 0 }; } });
  const value = await drain();
  assert.equal(calls, 1); assert.equal(value.status, 'idle'); assert.equal(value.sourceRequests, 0);
});

test('all handoffs share 120 actual SEC requests instead of resetting the source allowance', async () => {
  let calls = 0;
  const limits = [];
  const drain = createThirteenFReviewDrain({ now: () => 0, worker: async () => {
    calls++;
    return runWithSecRequestBudget(120, async allowance => {
      limits.push(allowance.limit);
      let dispatched = 0;
      while (dispatched < 80 && takeSecRequestBudget()) dispatched++;
      return { status: dispatched ? 'progress' : 'waiting', processed: dispatched };
    });
  } });
  const value = await drain();
  assert.equal(calls, 3); assert.deepEqual(limits, [120, 40, 0]);
  assert.equal(value.processed, 120); assert.equal(value.sourceRequests, 120); assert.equal(value.reason, 'waiting');
});

test('a new manager can publish prepared results after another manager uses the entire SEC allowance', async () => {
  let calls = 0;
  const drain = createThirteenFReviewDrain({ now: () => 0, worker: async () => {
    calls++;
    if (calls === 3) return { status: 'idle', processed: 0 };
    return runWithSecRequestBudget(120, async allowance => {
      if (calls === 1) {
        for (let i = 0; i < 120; i++) assert.equal(takeSecRequestBudget(), true);
        return { status: 'deferred', reason: 'source-budget', cik: '0002012383', processed: 12 };
      }
      assert.equal(allowance.limit, 0); assert.equal(takeSecRequestBudget(), false);
      return { status: 'progress', cik: '0001067983', processed: 29 };
    });
  } });
  const value = await drain();
  assert.equal(value.processed, 41); assert.equal(value.sourceRequests, 120);
  assert.equal(value.runs[1].cik, '0001067983'); assert.equal(value.runs[1].processed, 29);
});

test('the POST request deadline includes report preparation time and admits no worker after its remaining budget', async () => {
  let time = 100_000, calls = 0;
  const drain = createThirteenFReviewDrain({ now: () => time, worker: async ({ deadline }) => {
    calls++; assert.equal(deadline, 140_000); time = 135_000;
    return { status: 'progress', processed: 1 };
  } });
  assert.equal((await drain({ deadline: 140_000 })).reason, 'request-budget');
  assert.equal(calls, 1);
  assert.equal((await drain({ deadline: 140_000 })).runs.length, 0);
  assert.equal(calls, 1);
});

test('fast workers are still limited to three claims and caller cancellation prevents further work', async () => {
  let calls = 0;
  const controller = new AbortController();
  const drain = createThirteenFReviewDrain({ now: () => 0, worker: async () => { calls++; return { status: 'progress', processed: 1 }; } });
  const value = await drain();
  assert.equal(value.runs.length, THIRTEEN_F_REVIEW_DRAIN_LIMITS.runs); assert.equal(value.reason, 'run-budget');
  controller.abort();
  assert.equal((await drain({ signal: controller.signal })).runs.length, 0);
  assert.equal(calls, 3);
});

test('source cooldown, fencing and unavailable work do not immediately repeat their failures', async () => {
  for (const result of [{ status: 'deferred', reason: 'source-cooldown' }, { status: 'lease-lost' }, { status: 'waiting' }]) {
    let calls = 0;
    const drain = createThirteenFReviewDrain({ worker: async () => { calls++; return result; } });
    await drain(); assert.equal(calls, 1);
  }
  const drain = createThirteenFReviewDrain({ worker: async () => { throw new Error('private error detail'); } });
  const value = await drain();
  assert.equal(value.status, 'unavailable'); assert.equal(JSON.stringify(value).includes('private'), false);
});
