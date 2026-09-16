import { randomUUID } from 'node:crypto';
import { loadThirteenF } from './thirteenFServer.js';
import { loadThirteenFMarketConnections, THIRTEEN_F_MARKET_CONNECTIONS_SCHEMA_VERSION } from './thirteenFMarketConnectionsServer.js';
import { thirteenFReviewStore } from './thirteenFReviewStore.js';
import { prepareThirteenFReviewReport, hashThirteenFReviewReport, summarizeThirteenFReviewResult } from './thirteenFSharedReview.js';
import { isCftcEnabled } from './cftcFeature.js';
import { getDataStoreMode } from './dataStore.js';
import { runWithSecRequestBudget } from './secRequestBudget.js';

export const THIRTEEN_F_REVIEW_WORKER_LIMITS = Object.freeze({ invocationMs: 75_000, leaseSeconds: 90,
  batch: 100, publishBatch: 50, publishBytes: 7 * 1024 * 1024, maxHoldings: 1000, scanHoldings: 2000,
  coldHoldings: 60, sourceRequests: 120, concurrency: 2, attempts: 3, sourceMs: 55_000, minSourceMs: 12_000,
  preparedMs: 10_000, saveMs: 5000, releaseMs: 3000 });
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
const sourceBusy = error => error?.status === 429 || /^SEC_(?:RATE_GATE|(?:UPSTREAM_)?COOLDOWN)/.test(error?.code || '');

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
  preparedLoader = (report, keys, options) => loadThirteenFMarketConnections.preparedFromReport(report, keys, options),
  portfolioLoader = loadThirteenF, connectionLoader = (report, key, options) => loadThirteenFMarketConnections.fromReport(report, key, options),
  prepareReport = prepareThirteenFReviewReport, hashReport = hashThirteenFReviewReport,
  summarize = summarizeThirteenFReviewResult, now = Date.now, owner = randomUUID,
  enabled = () => isCftcEnabled() && getDataStoreMode('sec') === 'supabase' && getDataStoreMode('cftc') === 'supabase',
} = {}) {
  return async function runThirteenFReviewWorker({ signal: callerSignal, deadline, maxHoldings = LIMITS.maxHoldings } = {}) {
    if (!Number.isSafeInteger(maxHoldings) || maxHoldings < 1 || maxHoldings > LIMITS.maxHoldings
      || deadline !== undefined && !Number.isFinite(deadline)) throw fail('INVALID_REVIEW_BUDGET');
    if (!enabled()) return { status: 'disabled', processed: 0 };
    return runWithSecRequestBudget(LIMITS.sourceRequests, async sourceAllowance => {
      const startedAt = now(), stopAt = Math.min(deadline ?? startedAt + LIMITS.invocationMs, startedAt + LIMITS.invocationMs);
      if (callerSignal?.aborted || stopAt - startedAt < 10_000) return { status: 'deferred', reason: 'request-budget', processed: 0 };
      // Leave room to acknowledge the final result and release the lease. Source
      // cancellation never discards a completed database checkpoint.
      const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(Math.max(1, stopAt - startedAt - LIMITS.releaseMs))])
        : AbortSignal.timeout(Math.max(1, stopAt - startedAt - LIMITS.releaseMs));
      let claim, processed = 0, retrying = 0, coldStarted = 0, preparedCount = 0, scanned = 0, fenced = false, sourceBlocked = false;
      try {
        claim = await store.claim({ owner: owner(), leaseSeconds: LIMITS.leaseSeconds }, { signal });
        if (!claim) return { status: 'idle', processed: 0 };
        if (claim.attemptsRemaining !== undefined) {
          if (!Number.isSafeInteger(claim.attemptsRemaining) || claim.attemptsRemaining < 0 || claim.attemptsRemaining > 6000) throw fail('REVIEW_WORK_INVALID');
          maxHoldings = Math.min(maxHoldings, claim.attemptsRemaining);
        }
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
        const roomForSave = () => stopAt - now() > LIMITS.saveMs + LIMITS.releaseMs;
        const resultEntry = (row, result, sourceError = null) => {
          let summary = summarize(report, result);
          const retryable = sourceError || summary.retryable || summary.partial || result.retryable || result.status === 'unavailable';
          const retrySeconds = retryable && row.attempts + 1 < LIMITS.attempts ? retryDelay(sourceError, row.attempts) : 0;
          if (sourceError && !retrySeconds) {
            result.message = 'SEC evidence remains unavailable after the bounded retry attempts. The saved review records this gap.';
            summary = summarize(report, result);
          }
          return { ordinal: row.ordinal, result, summary, retrySeconds };
        };
        async function saveEntries(entries, fast = false) {
          while (entries.length && !fenced && roomForSave()) {
            const batch = []; let bytes = 512;
            while (entries.length && batch.length < (fast ? LIMITS.publishBatch : 1)) {
              const size = Buffer.byteLength(JSON.stringify(entries[0])) + 1;
              if (batch.length && bytes + size > LIMITS.publishBytes) break;
              if (size + bytes > LIMITS.publishBytes) throw fail('REVIEW_RESULT_TOO_LARGE');
              bytes += size; batch.push(entries.shift());
            }
            const saveBudget = Math.min(LIMITS.saveMs, stopAt - now() - LIMITS.releaseMs);
            const options = { signal: AbortSignal.timeout(Math.max(1, saveBudget)) };
            let saved;
            try {
              saved = fast ? await store.saveBatch(claim, { results: batch, ...options })
                : await store.save(claim, { ...batch[0], ...options });
            } catch (error) { fenced = true; throw error; }
            if (saved !== true) { fenced = true; return; }
            processed += batch.length;
            retrying += batch.filter(entry => entry.retrySeconds).length;
            if (fast) preparedCount += batch.length;
          }
        }
        async function preparedEntries(rows, classificationOnly) {
          if (!rows.length || signal.aborted || !roomForSave()) return { ready: [], misses: rows };
          const budget = Math.min(LIMITS.preparedMs, stopAt - now() - LIMITS.saveMs - LIMITS.releaseMs);
          const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, budget))]);
          let values, abort;
          try {
            const interrupted = new Promise((_, reject) => {
              abort = () => reject(lookupSignal.reason);
              lookupSignal.addEventListener('abort', abort, { once: true });
            });
            // This lane is provably source-free, even if a future cache helper
            // accidentally tries to fall through to SEC retrieval.
            values = await Promise.race([runWithSecRequestBudget(0, () => preparedLoader(report, rows.map(row => row.holding.key),
              { signal: lookupSignal, classificationOnly })), interrupted]);
          } catch { return { ready: [], misses: rows }; }
          finally { lookupSignal.removeEventListener('abort', abort); }
          if (!Array.isArray(values) || values.length !== rows.length) return { ready: [], misses: rows };
          const ready = [], misses = [];
          rows.forEach((row, index) => {
            try {
              const value = values[index];
              if (!value || !sameHolding(value.holding, row.holding)) { misses.push(row); return; }
              const entry = resultEntry(row, value);
              if (entry.retrySeconds || entry.summary.partial || entry.summary.status === 'unavailable') { misses.push(row); return; }
              ready.push(entry);
            } catch { misses.push(row); }
          });
          return { ready, misses };
        }
        let afterOrdinal = 0;
        const outstanding = new Map();
        // Visit a broad, bounded portion of the report before spending the source
        // allowance. Cheap fund/principal classifications must not sit behind the
        // first page's uncached operating companies for another scheduler turn.
        const classificationDeadline = Math.min(stopAt - LIMITS.saveMs - LIMITS.releaseMs, now() + 15_000);
        while (!fenced && !signal.aborted && roomForSave() && now() < classificationDeadline
          && processed < maxHoldings && scanned < LIMITS.scanHoldings) {
          const limit = Math.min(LIMITS.batch, maxHoldings - processed, LIMITS.scanHoldings - scanned);
          const rows = await store.work(claim, { limit, afterOrdinal, signal });
          if (!Array.isArray(rows) || rows.length > limit) throw fail('REVIEW_WORK_INVALID');
          if (!rows.length) break;
          let priorOrdinal = afterOrdinal;
          for (const row of rows) {
            const expected = report.portfolio.holdings[row?.ordinal - 1];
            if (!Number.isSafeInteger(row?.ordinal) || row.ordinal <= priorOrdinal || !expected
              || !sameHolding(expected, row.holding) || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts >= LIMITS.attempts)
              throw fail('REVIEW_WORK_INVALID');
            priorOrdinal = row.ordinal;
          }
          afterOrdinal = priorOrdinal; scanned += rows.length;
          const classified = await preparedEntries(rows, true);
          await saveEntries(classified.ready, true);
          for (const row of classified.misses) outstanding.set(row.ordinal, row);
        }
        const lookupRows = [...outstanding.values()];
        // Preserve a useful cold-research window while draining as many already
        // prepared entries as storage can deliver within this invocation.
        const preparedDeadline = Math.min(stopAt - LIMITS.saveMs - LIMITS.releaseMs - LIMITS.minSourceMs, now() + 20_000);
        for (let offset = 0; offset < lookupRows.length && !fenced && !signal.aborted
          && roomForSave() && now() < preparedDeadline && processed < maxHoldings; offset += LIMITS.batch) {
          const rows = lookupRows.slice(offset, offset + Math.min(LIMITS.batch, maxHoldings - processed));
          const prepared = await preparedEntries(rows, false);
          const ordinals = prepared.ready.map(entry => entry.ordinal);
          await saveEntries(prepared.ready, true);
          if (!fenced) for (const ordinal of ordinals) outstanding.delete(ordinal);
        }
        const coldRows = [...outstanding.values()];
        const coldLimit = Math.min(LIMITS.coldHoldings, maxHoldings - processed);
        let cursor = 0;
        async function processColdRows() {
          while (!fenced && !sourceBlocked && !signal.aborted && cursor < coldRows.length
            && coldStarted < coldLimit && sourceAllowance.used < sourceAllowance.limit
            && stopAt - now() >= LIMITS.saveMs + LIMITS.releaseMs + LIMITS.minSourceMs) {
            const row = coldRows[cursor++]; coldStarted++;
            const holding = report.portfolio.holdings[row.ordinal - 1];
            const sourceBudget = Math.min(LIMITS.sourceMs, stopAt - now() - LIMITS.saveMs - LIMITS.releaseMs);
            const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, sourceBudget))]);
            let result, sourceError, summary;
            try {
              result = await connectionLoader(report, holding.key, { signal: sourceSignal });
              summary = summarize(report, result);
            } catch (error) {
              sourceError = error;
              sourceBlocked ||= sourceBusy(error);
              result = failedResult(report, holding, now(), error);
            }
            // A task-local request limit is not failed SEC evidence. Lower source
            // layers can wrap that error, so an incomplete result at the exhausted
            // allowance also remains pending without consuming a holding retry.
            if (sourceError?.code === 'SEC_REQUEST_BUDGET_EXHAUSTED' || result?.code === 'SEC_REQUEST_BUDGET_EXHAUSTED'
              || result?.discovery?.code === 'SEC_REQUEST_BUDGET_EXHAUSTED'
              || sourceAllowance.used >= sourceAllowance.limit && (sourceError || summary?.retryable || summary?.partial || result?.retryable || result?.status === 'unavailable')) {
              sourceBlocked = true;
              continue;
            }
            if (!fenced) await saveEntries([resultEntry(row, result, sourceError)]);
          }
        }
        // Wait for both active source tasks before releasing the lease. A failed
        // publication fences new work without racing an in-flight sibling save.
        const workers = await Promise.allSettled(Array.from({ length: Math.min(LIMITS.concurrency, coldRows.length) }, processColdRows));
        const rejected = workers.find(result => result.status === 'rejected');
        if (rejected) throw rejected.reason;
        return { status: fenced ? 'lease-lost' : sourceBlocked || signal.aborted ? 'deferred' : processed ? 'progress' : 'waiting',
          processed, retrying, prepared: preparedCount, coldStarted, scanned, sourceRequests: sourceAllowance.used,
          ...(sourceAllowance.used >= sourceAllowance.limit ? { reason: 'source-budget' } : {}),
          cik: claim.cik, period: claim.period };
      } catch (error) {
        return { status: 'deferred', code: safeCode(error), processed, retrying, prepared: preparedCount, coldStarted, scanned, sourceRequests: sourceAllowance.used };
      } finally {
        if (claim) {
          // Finite database leases recover even if this best-effort release fails.
          // Do not reuse the cancelled source/browser signal for cleanup.
          await store.release(claim, { signal: AbortSignal.timeout(LIMITS.releaseMs) }).catch(() => false);
        }
      }
    });
  };
}

export const runThirteenFReviewWorker = createThirteenFReviewWorker();
