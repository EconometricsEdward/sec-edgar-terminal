import { CFTC_LAUNCH_CATALOG } from './cftc.js';
import { isCftcEnabled } from './cftcFeature.js';
import { loadCftcHistory } from './cftcServer.js';
import { marketComparisonKey, summarizePortfolioMarketHistory } from './portfolioMarketComparison.js';

export const PORTFOLIO_MARKET_COMPARISON_VERSION = 'edgar.portfolio-market-comparison.v1';
export const PORTFOLIO_MARKET_COMPARISON_CONCURRENCY = 3;
export const PORTFOLIO_MARKET_COMPARISON_DEADLINE_MS = 12_000;
export const PORTFOLIO_MARKET_COMPARISON_LIMIT = 25;

// One public universe for every visitor. Portfolio selections and allocations
// never enter this loader, its cache key, or the response.
const CANDIDATES = Object.freeze(CFTC_LAUNCH_CATALOG.slice(0, PORTFOLIO_MARKET_COMPARISON_LIMIT).map(item => Object.freeze({
  family: item.family, contract: item.code,
  group: item.family === 'tff' ? 'leveraged-funds' : 'managed-money',
})));
const PUBLIC_CODES = new Set(['CFTC_REPORT_NOT_PREPARED', 'CFTC_UNAVAILABLE', 'CFTC_TIMEOUT', 'CFTC_REQUEST_CANCELLED']);

function stopped(code = 'CFTC_REQUEST_CANCELLED') {
  return Object.assign(new Error('The market comparison request stopped.'), { code, status: 503 });
}

function unavailable(candidate, errorCode) {
  return { key: marketComparisonKey(candidate), ...candidate, status: 'unavailable', summary: null, errorCode };
}

async function withinDeadline(task, signal) {
  if (!signal) return task;
  if (signal.aborted) { Promise.resolve(task).catch(() => {}); throw stopped(); }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(stopped());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([task, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Read published charts only. A miss never refreshes CFTC or acquires a writer. */
export async function buildPortfolioMarketComparison({
  loadHistory = loadCftcHistory, signal, now = new Date(),
  deadlineMs = PORTFOLIO_MARKET_COMPARISON_DEADLINE_MS,
} = {}) {
  const generatedAt = new Date(now).toISOString();
  const budget = Math.min(PORTFOLIO_MARKET_COMPARISON_DEADLINE_MS, Math.max(1, Number(deadlineMs) || PORTFOLIO_MARKET_COMPARISON_DEADLINE_MS));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(stopped('CFTC_TIMEOUT')), budget);
  const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const startedAt = Date.now();
  const results = new Array(CANDIDATES.length);
  let next = 0;
  async function worker() {
    while (!operationSignal.aborted && next < CANDIDATES.length) {
      const index = next++, candidate = CANDIDATES[index];
      try {
        const history = await withinDeadline(Promise.resolve().then(() => loadHistory({
          family: candidate.family, code: candidate.contract, group: candidate.group,
          window: '1y', reportDate: 'latest', preparedOnly: true,
          signal: operationSignal, deadlineMs: Math.max(1, budget - (Date.now() - startedAt)),
        })), operationSignal);
        const summary = summarizePortfolioMarketHistory(history, candidate, now);
        results[index] = summary
          ? { key: marketComparisonKey(candidate), ...candidate, status: 'ready', summary }
          : unavailable(candidate, 'CFTC_COMPARISON_INVALID');
      } catch (error) {
        const code = operationSignal.aborted
          ? signal?.aborted ? 'CFTC_REQUEST_CANCELLED' : 'CFTC_TIMEOUT'
          : PUBLIC_CODES.has(error?.code) ? error.code : 'CFTC_UNAVAILABLE';
        results[index] = unavailable(candidate, code);
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: PORTFOLIO_MARKET_COMPARISON_CONCURRENCY }, () => worker()));
  } finally { clearTimeout(timeout); }
  for (let index = 0; index < CANDIDATES.length; index++) {
    if (!results[index]) results[index] = unavailable(CANDIDATES[index], signal?.aborted ? 'CFTC_REQUEST_CANCELLED' : 'CFTC_TIMEOUT');
  }
  const usable = results.filter(row => row.status === 'ready');
  const complete = usable.length === results.length && usable.every(row => !row.summary.stale && !row.summary.incomplete);
  return { schemaVersion: PORTFOLIO_MARKET_COMPARISON_VERSION, generatedAt, status: complete ? 'ready' : usable.length ? 'partial' : 'unavailable', results };
}

/** A single small, short-lived process cache also coalesces simultaneous misses.
 * Shared work has its own deadline; one departing viewer cannot cancel everyone.
 */
export function createPortfolioMarketComparisonLoader({
  loadHistory = loadCftcHistory, now = () => Date.now(), enabled = isCftcEnabled,
  deadlineMs = PORTFOLIO_MARKET_COMPARISON_DEADLINE_MS,
} = {}) {
  let cached = null, pending = null;
  return async function load({ signal } = {}) {
    if (!enabled()) throw Object.assign(new Error('CFTC data is currently disabled.'), { code: 'CFTC_DISABLED', status: 503 });
    if (signal?.aborted) throw stopped();
    if (cached && cached.expiresAt > now()) return structuredClone(cached.result);
    if (!pending) {
      pending = buildPortfolioMarketComparison({ loadHistory, now: new Date(now()), deadlineMs }).then(result => {
        cached = { result, expiresAt: now() + (result.status === 'ready' ? 300_000 : 60_000) };
        return result;
      }).finally(() => { pending = null; });
    }
    return structuredClone(await withinDeadline(pending, signal));
  };
}

export const loadPortfolioMarketComparison = createPortfolioMarketComparisonLoader();
