import { loadCftcHistory } from './cftcServer.js';
import { cftcPersistence } from './cftcPersistence.js';

/** Only peek belongs on the response path. Call the loader from a managed
 * background task: an optional prepared chart must never delay saved research. */
export function createThirteenFInitialChartLoader({ load = loadCftcHistory, now = Date.now,
  budgetMs = 3000, maxEntries = 24, maxBytes = 192 * 1024, maxInflight = 4,
  persistence = cftcPersistence, cacheGet,
} = {}) {
  const cache = new Map(), inflight = new Map();
  const capacity = Math.max(1, Math.min(24, Math.floor(maxEntries) || 24));
  const concurrency = Math.max(1, Math.min(4, Math.floor(maxInflight) || 4));
  const timeout = Math.max(1, Math.min(3000, budgetMs));
  function keyFor(market) {
    if (!market || !['tff', 'disaggregated'].includes(market.family)
      || !/^[A-Z0-9]{6}$/.test(market.contract || '')
      || market.group !== (market.family === 'tff' ? 'leveraged-funds' : 'managed-money')) return null;
    return `${market.family}:${market.contract}:${market.group}`;
  }
  function cached(key) {
    const hit = cache.get(key);
    if (!hit || now() >= hit.expires) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, hit);
    return hit;
  }
  function save(key, value) {
    cache.delete(key);
    while (cache.size >= capacity) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: now() + (value ? 300000 : 60000) });
  }
  function peek(market) {
    const key = keyFor(market);
    return key ? cached(key)?.value || null : null;
  }
  async function initialChart(market, { signal } = {}) {
    const key = keyFor(market);
    if (!key) return null;
    signal?.throwIfAborted();
    const hit = cached(key);
    if (hit) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    if (inflight.size >= concurrency) return null;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer, onAbort;
    const deadline = new Promise(resolve => {
      onAbort = () => resolve(null);
      combined.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), timeout);
    });
    // Count the actual read until it settles, even if the adapter ignores
    // cancellation. Repeated visitors cannot leave unlimited reads behind.
    const read = Promise.resolve().then(() => {
      combined.throwIfAborted();
      return load({ family: market.family, code: market.contract,
        group: market.group, reportDate: 'latest', window: '1y', preparedOnly: true,
        // Canonical storage already validates the catalog, dates, and raw
        // observations. Avoid a second disposable-cache probe before that read.
        persistence, ...(persistence.mode() === 'supabase' ? { cacheGet: async () => null } : cacheGet ? { cacheGet } : {}),
        signal: combined, deadlineMs: timeout });
    }).catch(() => null)
      .finally(() => { inflight.delete(key); });
    const result = Promise.race([deadline, read]).then(value => {
      if (combined.aborted || !value || value.report_family !== market.family
        || value.selection?.contract !== market.contract || value.selection?.group !== market.group
        || value.selection?.history_window !== '1y' || Buffer.byteLength(JSON.stringify(value)) > maxBytes) {
        save(key, null); return null;
      }
      save(key, value);
      return value;
    }).catch(() => { save(key, null); return null; }).finally(() => {
      clearTimeout(timer); combined.removeEventListener('abort', onAbort);
    });
    inflight.set(key, result);
    return result;
  }
  initialChart.peek = peek;
  return initialChart;
}

export const loadThirteenFInitialChart = createThirteenFInitialChartLoader();
export const peekThirteenFInitialChart = loadThirteenFInitialChart.peek;
