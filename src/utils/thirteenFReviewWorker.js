import { randomUUID } from 'node:crypto';
import { loadThirteenF } from './thirteenFServer.js';
import { loadThirteenFMarketConnections, THIRTEEN_F_MARKET_CONNECTIONS_SCHEMA_VERSION } from './thirteenFMarketConnectionsServer.js';
import { thirteenFReviewStore } from './thirteenFReviewStore.js';
import { prepareThirteenFReviewReport, hashThirteenFReviewReport, summarizeThirteenFReviewResult } from './thirteenFSharedReview.js';
import { isCftcEnabled } from './cftcFeature.js';
import { getDataStoreMode } from './dataStore.js';

export const THIRTEEN_F_REVIEW_WORKER_LIMITS = Object.freeze({ invocationMs: 75_000, leaseSeconds: 90,
  batch: 12, concurrency: 2, attempts: 3, sourceMs: 55_000, minSourceMs: 12_000, saveMs: 5000, releaseMs: 3000 });
const LIMITS = THIRTEEN_F_REVIEW_WORKER_LIMITS;
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)
  ? error.code : error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'THIRTEEN_F_REVIEW_TIMEOUT' : 'THIRTEEN_F_REVIEW_UNAVAILABLE';
const fail = code => Object.assign(new Error('The shared review could not finish its bounded step.'), { code });
const holdingFields = ['key', 'cusip', 'issuer', 'classTitle', 'putCall', 'quantity', 'quantityType', 'valueUsd', 'weightPct'];
const sameHolding = (left, right) => holdingFields.every(key => (left?.[key] ?? null) === (right?.[key] ?? null));
const retryDelay = (error, attempts) => {
  const advertised = Number(error?.retryAfter);
  return Math.min(86400, Math.max(60 * 2 ** Math.max(0, attempts), Number.isFinite(advertised) ? Math.ceil(advertised) : 0));
};
const sourceBusy = error => error?.status === 429 || /^SEC_(?:RATE_GATE|COOLDOWN)/.test(error?.code || '');

function failedResult(report, holding, now, error) {
  return { schemaVersion: THIRTEEN_F_MARKET_CONNECTIONS_SCHEMA_VERSION, status: 'unavailable',
    manager: { cik: report.manager.cik, name: report.manager.name }, selectedPeriod: report.selectedPeriod,
    holding, observedAt: new Date(now).toISOString(), retryable: true, code: safeCode(error),
    message: 'SEC evidence could not be retrieved during this attempt. The shared review will retry within its processing budget.' };
}

/** Every invocation is resumable from SQL, not browser memory. The database
 * atomically reserves the global lease and daily allowance; every publication
 * is fenced and acknowledged before it counts as progress. */
export function createThirteenFReviewWorker({ store = thirteenFReviewStore,
  portfolioLoader = loadThirteenF, connectionLoader = (report, key, options) => loadThirteenFMarketConnections.fromReport(report, key, options),
  prepareReport = prepareThirteenFReviewReport, hashReport = hashThirteenFReviewReport,
  summarize = summarizeThirteenFReviewResult, now = Date.now, owner = randomUUID,
  enabled = () => isCftcEnabled() && getDataStoreMode('sec') === 'supabase' && getDataStoreMode('cftc') === 'supabase',
} = {}) {
  return async function runThirteenFReviewWorker({ signal: callerSignal, deadline, maxHoldings = LIMITS.batch } = {}) {
    if (!Number.isSafeInteger(maxHoldings) || maxHoldings < 1 || maxHoldings > LIMITS.batch
      || deadline !== undefined && !Number.isFinite(deadline)) throw fail('INVALID_REVIEW_BUDGET');
    if (!enabled()) return { status: 'disabled', processed: 0 };
    const startedAt = now(), stopAt = Math.min(deadline ?? startedAt + LIMITS.invocationMs, startedAt + LIMITS.invocationMs);
    if (callerSignal?.aborted || stopAt - startedAt < 10_000) return { status: 'deferred', reason: 'request-budget', processed: 0 };
    // Leave room to acknowledge the final result and release the lease. Source
    // cancellation never discards a completed database checkpoint.
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(Math.max(1, stopAt - startedAt - LIMITS.releaseMs))])
      : AbortSignal.timeout(Math.max(1, stopAt - startedAt - LIMITS.releaseMs));
    let claim, processed = 0, retrying = 0, fenced = false, sourceBlocked = false;
    try {
      claim = await store.claim({ owner: owner(), leaseSeconds: LIMITS.leaseSeconds }, { signal });
      if (!claim) return { status: 'idle', processed: 0 };
      const report = prepareReport(claim.report);
      if (hashReport(report) !== claim.reportHash || report.manager.cik !== claim.cik || report.selectedPeriod !== claim.period)
        throw fail('REVIEW_REPORT_IDENTITY_MISMATCH');
      // The report loader retains its normal source freshness policy. A new
      // amendment replaces this job's binding; work never migrates to a newer
      // quarter or silently uses an earlier denominator.
      const current = prepareReport(await portfolioLoader(claim.cik, { period: claim.period, signal }));
      if (current.manager.cik !== claim.cik || current.selectedPeriod !== claim.period) throw fail('REVIEW_REPORT_IDENTITY_MISMATCH');
      const currentHash = hashReport(current);
      if (currentHash !== claim.reportHash) {
        await store.enqueue(current, currentHash, { signal });
        return { status: 'report-updated', processed: 0, cik: claim.cik, period: claim.period };
      }
      if (signal.aborted || stopAt - now() < LIMITS.saveMs + LIMITS.releaseMs + LIMITS.minSourceMs)
        return { status: 'deferred', reason: 'request-budget', processed: 0 };
      const rows = await store.work(claim, { limit: maxHoldings, signal });
      if (!Array.isArray(rows) || rows.length > maxHoldings) throw fail('REVIEW_WORK_INVALID');
      const ordinals = new Set();
      for (const row of rows) {
        const expected = report.portfolio.holdings[row?.ordinal - 1];
        if (!Number.isSafeInteger(row?.ordinal) || row.ordinal < 1 || ordinals.has(row.ordinal) || !expected
          || !sameHolding(expected, row.holding) || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts >= LIMITS.attempts)
          throw fail('REVIEW_WORK_INVALID');
        ordinals.add(row.ordinal);
      }
      let cursor = 0;
      async function processRows() {
        while (!fenced && !sourceBlocked && !signal.aborted && cursor < rows.length
          && stopAt - now() >= LIMITS.saveMs + LIMITS.releaseMs + LIMITS.minSourceMs) {
          const row = rows[cursor++];
          const holding = report.portfolio.holdings[row.ordinal - 1];
          const sourceBudget = Math.min(LIMITS.sourceMs, stopAt - now() - LIMITS.saveMs - LIMITS.releaseMs);
          const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, sourceBudget))]);
          let result, summary, sourceError;
          try {
            result = await connectionLoader(report, holding.key, { signal: sourceSignal });
            summary = summarize(report, result);
          } catch (error) {
            sourceError = error;
            sourceBlocked ||= sourceBusy(error);
            result = failedResult(report, holding, now(), error);
            summary = summarize(report, result);
          }
          if (fenced) return;
          const retryable = sourceError || summary.retryable || summary.partial || result.retryable || result.status === 'unavailable';
          const retrySeconds = retryable && row.attempts + 1 < LIMITS.attempts ? retryDelay(sourceError, row.attempts) : 0;
          if (sourceError && !retrySeconds) {
            result.message = 'SEC evidence remains unavailable after the bounded retry attempts. The saved review records this gap.';
            summary = summarize(report, result);
          }
          // An expired source deadline still gets a bounded failure checkpoint.
          // Caller cancellation likewise cannot turn an acknowledged attempt
          // into a lost cursor; the SQL lease remains the authority.
          const saveBudget = Math.min(LIMITS.saveMs, stopAt - now() - LIMITS.releaseMs);
          if (saveBudget <= 0) return;
          let saved;
          try {
            saved = await store.save(claim, { ordinal: row.ordinal, result, summary, retrySeconds,
              signal: AbortSignal.timeout(Math.max(1, saveBudget)) });
          } catch (error) { fenced = true; throw error; }
          if (saved !== true) { fenced = true; return; }
          processed++;
          if (retrySeconds) retrying++;
        }
      }
      // allSettled waits for the sibling's acknowledged checkpoint before the
      // lease is released. Rejecting early could fence a still-running save.
      const workers = await Promise.allSettled(Array.from({ length: Math.min(LIMITS.concurrency, rows.length) }, processRows));
      const rejected = workers.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      return { status: fenced ? 'lease-lost' : sourceBlocked || signal.aborted ? 'deferred' : processed ? 'progress' : 'waiting',
        processed, retrying, cik: claim.cik, period: claim.period };
    } catch (error) {
      return { status: 'deferred', code: safeCode(error), processed, retrying };
    } finally {
      if (claim) {
        // Finite database leases recover even if this best-effort release fails.
        // Do not reuse the cancelled source/browser signal for cleanup.
        await store.release(claim, { signal: AbortSignal.timeout(LIMITS.releaseMs) }).catch(() => false);
      }
    }
  };
}

export const runThirteenFReviewWorker = createThirteenFReviewWorker();
