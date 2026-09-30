import { readCacheMaintenanceState } from './disposableCache.js';

const CONTROL_TTL_MS = 60000;
const FAILURE_TTL_MS = 5000;
const CONTROL_TIMEOUT_MS = 1000;
// redisMaintenance.js permits copy/delete only after this mode-transition drain.
// A steady observation expires well before a newly armed migration can delete.
const MIGRATION_DRAIN_MS = 10 * 60000;

/** Cache only a tiny read-policy decision, never a data value or a cache miss. */
export function createWarmCacheRetryPolicy({ readState = readCacheMaintenanceState, now = Date.now } = {}) {
  let cached = null, pending = null;
  const deadlineError = () => new Error('Cache batch deadline reached.');

  function waitForState(promise, { signal, deadline = Infinity } = {}) {
    signal?.throwIfAborted();
    if (!(deadline > now())) throw deadlineError();
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const finish = (complete, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        complete(value);
      };
      const aborted = () => finish(reject, signal.reason);
      signal?.addEventListener('abort', aborted, { once: true });
      const remaining = deadline - now();
      if (Number.isFinite(deadline) && remaining <= 2147483647) timer = setTimeout(() => finish(reject, deadlineError()), Math.max(1, remaining));
      promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  return async function shouldRetryMiss(options = {}) {
    options.signal?.throwIfAborted();
    const startedAt = now();
    if (!((options.deadline ?? Infinity) > startedAt)) throw deadlineError();
    if (cached && cached.until > startedAt) return cached.retry;
    if (!pending) {
      pending = (async () => {
        try {
          // Do not bind shared control work to the first reader's cancellation.
          // Each waiter has its own deadline and this transport has a 1s limit.
          const control = await readState({ timeoutMs: CONTROL_TIMEOUT_MS, deadline: startedAt + CONTROL_TIMEOUT_MS });
          const changedAt = Date.parse(control?.modeChangedAt), completedAt = Date.parse(control?.state?.completedAt);
          const steady = control?.mode === 'steady' && Number.isFinite(changedAt)
            && changedAt <= startedAt - MIGRATION_DRAIN_MS && control?.state?.version === 1
            && control.state.phase === 'steady' && Number.isFinite(completedAt) && completedAt <= startedAt
            && Array.isArray(control.state.pending) && control.state.pending.length === 0;
          cached = { retry: !steady, until: startedAt + CONTROL_TTL_MS };
        } catch {
          // Unknown or unavailable control keeps the copy/delete-race recovery.
          cached = { retry: true, until: startedAt + FAILURE_TTL_MS };
        }
        return cached.until > now() ? cached.retry : true;
      })().finally(() => { pending = null; });
    }
    return waitForState(pending, options);
  };
}

export const shouldRetryWarmCacheMiss = createWarmCacheRetryPolicy();
