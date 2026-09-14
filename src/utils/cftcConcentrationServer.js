import { buildCftcConcentration, cftcConcentrationQuery, cftcConcentrationSourceUrl } from './cftcConcentration.js';
import { cftcDate, isCftcContractCode, isCftcFamily } from './cftc.js';
import { isCftcEnabled } from './cftcFeature.js';
import { CftcError, fetchCftcResource, isCftcPublicReportDate } from './cftcServer.js';

export const CFTC_CONCENTRATION_FRESH_MS = 6 * 3600_000;
const LOAD_BUDGET_MS = 28_000;

export function validateConcentrationRequest({ family, code, reportDate }, now = Date.now()) {
  if (!isCftcFamily(family)) throw new CftcError('Use family=tff or family=disaggregated.', { code: 'INVALID_REPORT_FAMILY', status: 400 });
  if (!isCftcContractCode(code)) throw new CftcError('Use a verified CFTC contract code.', { code: 'INVALID_CONTRACT', status: 400 });
  if (cftcDate(reportDate) !== reportDate || !isCftcPublicReportDate(reportDate, new Date(now))) throw new CftcError('Use an exact YYYY-MM-DD report date within the retained six-year CFTC range.', { code: 'INVALID_REPORT_DATE', status: 400 });
  return { family, code, reportDate };
}

function cancelled() { return new CftcError('The CFTC concentration request was cancelled.', { code: 'CFTC_REQUEST_CANCELLED', status: 499 }); }

async function awaitSignal(task, signal) {
  if (!signal) return task;
  if (signal.aborted) throw cancelled();
  let onAbort;
  const aborted = new Promise((_, reject) => { onAbort = () => reject(cancelled()); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([task, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Optional exact-date detail has a separate bounded cache. Adding these fields
 * to the existing strict history cache would discard otherwise valid history.
 * Source corrections are re-read after six hours; old history needs no flush.
 */
export function createCftcConcentrationLoader({ fetchResource = fetchCftcResource, now = () => Date.now(), enabled = isCftcEnabled, maxEntries = 128, maxPending = 8 } = {}) {
  const memory = new Map(), pending = new Map();
  const put = (key, value) => {
    memory.delete(key); memory.set(key, value);
    while (memory.size > maxEntries) memory.delete(memory.keys().next().value);
  };
  const present = (result, cacheStatus) => structuredClone({ ...result, freshness: { cache_status: cacheStatus, retrieved_at: result.retrieved_at } });

  async function load({ family, code, reportDate, signal } = {}) {
    if (!enabled()) throw new CftcError('CFTC data is currently disabled.', { code: 'CFTC_DISABLED', status: 503 });
    if (signal?.aborted) throw cancelled();
    const request = validateConcentrationRequest({ family, code, reportDate }, now());
    const key = `${family}|${code}|${reportDate}`, cached = memory.get(key);
    if (cached && cached.expiresAt > now()) {
      if (cached.error) throw cached.error;
      return present(cached.result, 'memory');
    }
    if (!pending.has(key)) {
      if (pending.size >= maxPending) throw new CftcError('CFTC concentration requests are busy. Retry shortly.', { code: 'CFTC_CONCENTRATION_BUSY', status: 503, retryAfter: 1000 });
      const task = (async () => {
        try {
          // One narrow official query, under the existing shared CFTC outbound
          // gate, with no retries that could compete with the history request.
          const fetched = await fetchResource(family, cftcConcentrationQuery(request), { signal: AbortSignal.timeout(LOAD_BUDGET_MS), retries: 0 });
          if (fetched.sourceUrl !== cftcConcentrationSourceUrl(request)) throw new CftcError('CFTC concentration source identity is invalid.', { code: 'CFTC_CONCENTRATION_INVALID', status: 502 });
          const result = buildCftcConcentration({ ...request, rows: fetched.rows, retrievedAt: new Date(now()).toISOString() });
          put(key, { result, expiresAt: now() + (result.status === 'ready' ? CFTC_CONCENTRATION_FRESH_MS : 5 * 60_000) });
          return present(result, 'source');
        } catch (error) {
          put(key, { error, expiresAt: now() + 60_000 });
          throw error;
        }
      })().finally(() => pending.delete(key));
      pending.set(key, task);
    }
    return awaitSignal(pending.get(key), signal);
  }
  return { load };
}

const loader = createCftcConcentrationLoader();
export const loadCftcConcentration = options => loader.load(options);
