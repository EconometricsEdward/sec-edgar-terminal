import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBankPreparation, startBankPreparationPolling } from '../src/app/analysis/banks/preparationPolling.js';

const queued = [{ status: 'queued', id_rssd: 101 }];
const state = jobs => ({ banks: [{ id_rssd: 101 }], reports: [], periods: ['2026-06-30'], jobs });
function harness() {
  let now = 0, id = 0;
  const timers = new Map(), listeners = new Set();
  const visibility = { visibilityState: 'visible',
    addEventListener: (_name, listener) => listeners.add(listener),
    removeEventListener: (_name, listener) => listeners.delete(listener),
  };
  return {
    options: { now: () => now, visibility,
      schedule: (callback, ms) => { timers.set(++id, { callback, at: now + ms }); return id; },
      cancel: timer => timers.delete(timer),
    },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [timerId, timer] = next;
        timers.delete(timerId); now = timer.at;
        await timer.callback();
      }
      now = end;
    },
    visible(value) { visibility.visibilityState = value ? 'visible' : 'hidden'; for (const listener of listeners) listener(); },
    get timerCount() { return timers.size; },
    get listenerCount() { return listeners.size; },
  };
}

test('an unavailable backend gets three checks, then requires an explicit new session', async () => {
  const clock = harness(), pauses = [];
  let calls = 0;
  const options = { ...clock.options, selection: '101', initialJobs: queued, onData: () => assert.fail('Keep displayed data on errors'),
    onPause: reason => pauses.push(reason), read: async () => { calls++; throw new Error('503'); } };
  startBankPreparationPolling(options);
  await clock.advance(20 * 60 * 1000);
  assert.equal(calls, 3);
  assert.deepEqual(pauses, ['unavailable']);
  assert.equal(clock.timerCount, 0);
  assert.equal(clock.listenerCount, 0);
  const stop = startBankPreparationPolling(options);
  await clock.advance(5000);
  assert.equal(calls, 4);
  stop();
});

test('healthy long-running preparation is bounded to 17 checks in a 15 minute session', async () => {
  const clock = harness(), pauses = [];
  let calls = 0;
  startBankPreparationPolling({ ...clock.options, selection: '101', initialJobs: queued,
    onData: () => {}, onPause: reason => pauses.push(reason), read: async () => { calls++; return state(queued); } });
  await clock.advance(60 * 60 * 1000);
  assert.equal(calls, 17);
  assert.deepEqual(pauses, ['waiting']);
  assert.equal(clock.timerCount, 0);
});

test('hidden pages stop scheduled reads and resume without a burst of missed requests', async () => {
  const clock = harness(); let calls = 0;
  const stop = startBankPreparationPolling({ ...clock.options, selection: '101', initialJobs: queued,
    onData: () => {}, onPause: () => assert.fail('Session still active'), read: async () => { calls++; return state(queued); } });
  clock.visible(false);
  await clock.advance(120000);
  assert.equal(calls, 0);
  assert.equal(clock.timerCount, 1, 'Only the session deadline remains');
  clock.visible(true);
  await clock.advance(0);
  assert.equal(calls, 1);
  clock.visible(false);
  clock.visible(true);
  await clock.advance(14000);
  assert.equal(calls, 1);
  stop();
  assert.equal(clock.timerCount, 0);
});

test('retry timestamps and Retry-After prevent premature backend checks', async () => {
  const clock = harness(); let calls = 0;
  const retryJobs = [{ status: 'retry', next_attempt_at: new Date(300000).toISOString() }];
  const stop = startBankPreparationPolling({ ...clock.options, selection: '101', initialJobs: retryJobs,
    onData: () => {}, onPause: () => assert.fail('Session still active'), read: async () => {
      calls++;
      throw Object.assign(new Error('Retry later'), { retryDelay: 180000 });
    } });
  await clock.advance(299999); assert.equal(calls, 0);
  await clock.advance(1); assert.equal(calls, 1);
  await clock.advance(179999); assert.equal(calls, 1);
  await clock.advance(1); assert.equal(calls, 2);
  stop();
});

test('successful completion after a transient failure updates once and stops polling', async () => {
  const clock = harness(), updates = []; let calls = 0;
  const ready = state([{ status: 'ready', id_rssd: 101 }]);
  startBankPreparationPolling({ ...clock.options, selection: '101', initialJobs: queued,
    onData: data => updates.push(data), onPause: () => assert.fail('Completed'), read: async () => {
      if (++calls === 1) throw new Error('503');
      return ready;
    } });
  await clock.advance(120000);
  assert.equal(calls, 2);
  assert.deepEqual(updates, [ready]);
  assert.equal(clock.timerCount, 0);
});

test('navigation aborts in-flight reads and ignores their late result', async () => {
  const clock = harness(); let signal, resolve;
  const stop = startBankPreparationPolling({ ...clock.options, selection: '101', initialJobs: queued,
    onData: () => assert.fail('Unmounted'), onPause: () => assert.fail('Unmounted'),
    read: options => { signal = options.signal; return new Promise(done => { resolve = done; }); } });
  const reading = clock.advance(5000);
  assert.ok(signal);
  stop();
  assert.equal(signal.aborted, true);
  resolve(state(queued));
  await reading;
  await clock.advance(60000);
  assert.equal(clock.timerCount, 0);
  assert.equal(clock.listenerCount, 0);
});

test('status loader makes one cancellable read, validates it and preserves HTTP retry guidance', async () => {
  let calls = 0;
  const loaded = await loadBankPreparation({ selection: '101,102', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, '/api/banks?rssds=101,102');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(state(queued));
  } });
  assert.deepEqual(loaded, state(queued));
  assert.equal(calls, 1);
  await assert.rejects(loadBankPreparation({ selection: '101', fetchImpl: async () => Response.json({ error: 'Unavailable' }, { status: 503, headers: { 'Retry-After': '120' } }) }), error => error.retryDelay === 120000);
  await assert.rejects(loadBankPreparation({ selection: '101', fetchImpl: async () => Response.json({ banks: [] }) }), /invalid response/);
});

test('individual status reads time out and honor navigation cancellation', async () => {
  const waitingFetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  // AbortSignal.timeout does not keep Node alive by itself.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(loadBankPreparation({ selection: '101', fetchImpl: waitingFetch, timeoutMs: 5 }), { name: 'TimeoutError' });
    const controller = new AbortController();
    const pending = loadBankPreparation({ selection: '101', signal: controller.signal, fetchImpl: waitingFetch });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { clearTimeout(keepAlive); }
});
