import { loadCftcHistory } from './cftcServer.js';

/** An optional chart must never turn opening saved research into a source job. */
export function createThirteenFInitialChartLoader({ load = loadCftcHistory, now = Date.now,
  budgetMs = 1000, maxEntries = 24, maxBytes = 192 * 1024 } = {}) {
  const cache = new Map();
  return async function initialChart(market, { signal } = {}) {
    if (!market || !['tff', 'disaggregated'].includes(market.family)
      || !/^[A-Z0-9]{6}$/.test(market.contract || '')
      || market.group !== (market.family === 'tff' ? 'leveraged-funds' : 'managed-money')) return null;
    signal?.throwIfAborted();
    const key = `${market.family}:${market.contract}:${market.group}`, hit = cache.get(key);
    if (hit && now() < hit.expires) return hit.value;
    cache.delete(key);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, budgetMs); });
    try {
      const value = await Promise.race([deadline, load({ family: market.family, code: market.contract,
        group: market.group, reportDate: 'latest', window: '1y', preparedOnly: true,
        signal: combined, deadlineMs: budgetMs }).catch(() => null)]);
      if (combined.aborted || !value || value.report_family !== market.family
        || value.selection?.contract !== market.contract || value.selection?.group !== market.group
        || value.selection?.history_window !== '1y' || Buffer.byteLength(JSON.stringify(value)) > maxBytes) return null;
      while (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expires: now() + 300000 });
      return value;
    } finally { clearTimeout(timer); }
  };
}

export const loadThirteenFInitialChart = createThirteenFInitialChartLoader();
