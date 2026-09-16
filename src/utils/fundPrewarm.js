import { FUND_CATALOG } from './fundResearch.js';
import { PUBLIC_FUND_MANAGERS } from './fundPublicSelectors.js';
import { createFundResearchCache, FUND_FRESH_MS } from './fundResearchCache.js';
import { create13FCache, THIRTEEN_F_FRESH_MS } from './thirteenFCache.js';
import { loadFund } from './fundResearchServer.js';
import { loadThirteenF } from './thirteenFServer.js';

export const FUND_PREWARM_MAX_RUNTIME_MS = 150_000;
const READ_TIMEOUT_MS = 8000;
// Shared loaders isolate reader cancellation and own a 50-second source limit.
// Reserve their full lifetime plus a final persisted-read check before starting.
const MIN_SOURCE_WINDOW_MS = 60_000;
const CONCURRENCY = 2;

/** Rotate the starting group daily so slow/unsupported reports cannot starve a fund. */
export function fundPrewarmCohort(timestamp = Date.now()) {
  const day = Math.floor(timestamp / 86400000);
  const managers = PUBLIC_FUND_MANAGERS.map((_, index) => PUBLIC_FUND_MANAGERS[(index + day) % PUBLIC_FUND_MANAGERS.length]);
  const funds = FUND_CATALOG.map((_, index) => FUND_CATALOG[(index + day * 3) % FUND_CATALOG.length]);
  const result = [];
  for (let index = 0; index < Math.max(managers.length, Math.ceil(funds.length / 3)); index++) {
    if (managers[index]) result.push({ kind: '13f', cik: managers[index].cik });
    for (const fund of funds.slice(index * 3, index * 3 + 3)) result.push({ kind: 'nport', ticker: fund.ticker });
  }
  return result;
}

function checkedState(ready, checkedAt, invalidated, freshMs, now) {
  const checked = typeof checkedAt === 'string' ? Date.parse(checkedAt) : NaN;
  return { ready, checkedAt: Number.isFinite(checked) && checked <= now ? checkedAt : null,
    fresh: ready && !invalidated && Number.isFinite(checked) && checked <= now && now - checked < freshMs };
}

/**
 * Reuse the daily SEC scheduler and existing complete-report caches. No separate
 * comparison copies, source archives, schedule, or visitor-triggered job exists.
 * Dependency injection is for fixtures; production selections are the fixed public cohort.
 */
export async function prewarmFunds({ signal, now = Date.now,
  deadline = now() + FUND_PREWARM_MAX_RUNTIME_MS,
  readFund = createFundResearchCache().readPrepared,
  readManager = create13FCache().readSnapshot,
  prepareFund = loadFund, prepareManager = loadThirteenF,
} = {}) {
  const startedAt = now();
  const stopAt = Math.min(deadline, startedAt + FUND_PREWARM_MAX_RUNTIME_MS);
  const cohort = fundPrewarmCohort(startedAt), results = new Map();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Fund preparation deadline reached.')), Math.max(1, stopAt - startedAt));
  const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let cursor = 0;
  async function inspect(item) {
    const readSignal = AbortSignal.any([runSignal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
    if (item.kind === 'nport') {
      const data = await readFund(item.ticker, '', { signal: readSignal, allowStale: true });
      return checkedState(data?.status === 'ready' && data.ticker === item.ticker,
        data?.cache?.checkedAt, data?.cache?.stale, FUND_FRESH_MS, now());
    }
    const saved = await readManager(item.cik, '', readSignal), data = saved?.data;
    return checkedState(data?.status === 'ready' && data.manager?.cik === item.cik
      && data.portfolio?.complete === true && data.coverage?.selectedPeriodComplete === true,
    saved?.checkedAt, saved?.invalidatedAt, THIRTEEN_F_FRESH_MS, now());
  }
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (!runSignal.aborted && now() < stopAt) {
        const index = cursor++, item = cohort[index];
        if (!item) return;
        try {
          const before = await inspect(item);
          if (before.fresh) {
            results.set(index, { ...item, status: 'current', checkedAt: before.checkedAt });
            continue;
          }
          // Readers can still report current snapshots near the deadline, but
          // no acquisition starts without enough room for its own hard limit.
          if (runSignal.aborted || now() > stopAt - MIN_SOURCE_WINDOW_MS) {
            results.set(index, { ...item, status: 'skipped', reason: 'deadline', checkedAt: before.checkedAt });
            continue;
          }
          const data = item.kind === '13f'
            ? await prepareManager(item.cik, { signal: runSignal })
            : await prepareFund(item.ticker, '', { signal: runSignal });
          // A loader can return valid data when its optional shared write fails.
          // Verify the shared publication rather than announcing local-only data as prepared.
          const after = await inspect(item);
          const status = after.fresh ? 'refreshed' : after.ready ? 'stale'
            : data?.status === 'ready' ? 'unpersisted' : 'unavailable';
          results.set(index, { ...item, status, checkedAt: after.checkedAt });
        } catch (error) {
          results.set(index, { ...item, status: runSignal.aborted ? 'skipped' : 'failed',
            reason: runSignal.aborted ? 'deadline' : 'preparation_failed',
            ...(typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? { code: error.code } : {}) });
        }
      }
    }));
  } finally { clearTimeout(timer); }
  const rows = cohort.map((item, index) => results.get(index) || { ...item, status: 'skipped', reason: 'deadline' });
  const count = status => rows.filter(row => row.status === status).length;
  const current = count('current'), refreshed = count('refreshed');
  return { scope: 'popular-public-fund-cohort', status: current + refreshed === cohort.length ? 'ready' : 'partial',
    requested: cohort.length, current, refreshed, stale: count('stale'), unavailable: count('unavailable'),
    unpersisted: count('unpersisted'), failed: count('failed'), skipped: count('skipped'),
    duration_ms: Math.max(0, now() - startedAt), results: rows };
}
