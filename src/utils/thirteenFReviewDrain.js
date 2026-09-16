import { runThirteenFReviewWorker } from './thirteenFReviewWorker.js';
import { runWithSecRequestBudget } from './secRequestBudget.js';

export const THIRTEEN_F_REVIEW_DRAIN_LIMITS = Object.freeze({ invocationMs: 140_000, runs: 3,
  sourceRequests: 120, minWorkerMs: 12_000 });
const LIMITS = THIRTEEN_F_REVIEW_DRAIN_LIMITS;

/** Hand off the released global lease before this invocation ends. A manager
 * enqueued while a worker was busy can then receive its first results without
 * waiting for the next five-minute schedule. No lease polling or timers keep
 * idle functions alive; SQL remains responsible for fairness and daily caps. */
export function createThirteenFReviewDrain({ worker = runThirteenFReviewWorker, now = Date.now } = {}) {
  return async function drainThirteenFReviews({ signal, deadline } = {}) {
    if (deadline !== undefined && !Number.isFinite(deadline)) throw new TypeError('Invalid review deadline.');
    const stopAt = Math.min(deadline ?? Infinity, now() + LIMITS.invocationMs);
    return runWithSecRequestBudget(LIMITS.sourceRequests, async allowance => {
      const runs = []; let processed = 0, reason = null;
      while (runs.length < LIMITS.runs) {
        if (signal?.aborted || stopAt - now() < LIMITS.minWorkerMs) { reason = 'request-budget'; break; }
        // Exhausting SEC dispatches still permits a source-free handoff. The
        // nested worker sees a zero allowance and may publish prepared results.
        let result;
        try { result = await worker({ signal, deadline: stopAt }); }
        catch { result = { status: 'unavailable', processed: 0, code: 'THIRTEEN_F_REVIEW_UNAVAILABLE' }; }
        // Worker details contain only public manager identifiers and bounded
        // counters, never filing passages, leases, report bodies or credentials.
        const run = { status: result?.status || 'unavailable',
          processed: Number.isSafeInteger(result?.processed) && result.processed > 0 ? result.processed : 0 };
        for (const key of ['cik', 'period', 'reason', 'code']) if (typeof result?.[key] === 'string') run[key] = result[key];
        runs.push(run); processed += run.processed;
        const canHandoff = ['progress', 'report-updated'].includes(run.status)
          || run.status === 'deferred' && ['request-budget', 'source-budget'].includes(run.reason);
        if (!canHandoff) { reason = run.reason || run.status; break; }
      }
      if (!reason && runs.length >= LIMITS.runs) reason = 'run-budget';
      return { status: processed ? 'progress' : runs.at(-1)?.status || 'deferred', processed,
        sourceRequests: allowance.used, runs, ...(reason ? { reason } : {}) };
    });
  };
}

export const drainThirteenFReviews = createThirteenFReviewDrain();
