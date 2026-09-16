import { summarize13FHistory } from './thirteenFHistory.js';

const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;
const requestedKeys = (keys) => [...new Set(keys)].sort();
const sourceFingerprint = (projection) => JSON.stringify({
  complete: projection.complete, comparable: projection.comparable, confidentialOmitted: projection.confidentialOmitted, reportType: projection.reportType,
  totalValueUsd: projection.totalValueUsd, positionCount: projection.positionCount, entryCount: projection.entryCount, observedPositionCount: projection.observedPositionCount,
  top5Pct: projection.top5Pct, top10Pct: projection.top10Pct, largestWeightPct: projection.largestWeightPct, amendmentCount: projection.amendmentCount, filings: projection.filings, issues: projection.issues,
});
const sourceTimestamp = (projection) => {
  const checked = Date.parse(projection?.checkedAt);
  return Number.isFinite(checked) ? checked : Date.parse(projection?.observedAt);
};
const queryFor = (cik, period, keys) => new URLSearchParams({ cik, period, keys: JSON.stringify(requestedKeys(keys)) }).toString();

/** Isolated browser cache: projections are never combined across filing revisions. */
export function create13FHistoryClient({ fetcher = (...args) => fetch(...args), now = Date.now, maxEntries = 96, maxBytes = DEFAULT_CACHE_BYTES, timeoutMs = 60000 } = {}) {
  const cache = new Map();
  const inflight = new Map();
  let cacheBytes = 0;
  function remove(key) {
    const entry = cache.get(key);
    if (entry) { cacheBytes -= entry.bytes; cache.delete(key); }
  }
  function read(cik, period, keys, summaryOnly = false) {
    const normalized = requestedKeys(keys);
    const exactKey = queryFor(cik, period, normalized);
    let chosen;
    for (const [key, entry] of cache) {
      if (entry.expires <= now()) { remove(key); continue; }
      if (entry.cik !== cik || entry.period !== period) continue;
      const projection = entry.slot.projection;
      if (summaryOnly ? entry.slot.status !== 'ready' : key !== exactKey && !(entry.slot.status === 'ready' && normalized.every(value => projection.trackedKeys.includes(value)))) continue;
      // Exact observations win. Otherwise prefer the most recently fetched
      // coherent projection, rather than stitching different revisions together.
      if (!chosen || key === exactKey || chosen.key !== exactKey && entry.savedAt >= chosen.entry.savedAt) chosen = { key, entry };
    }
    if (!chosen) return null;
    cache.delete(chosen.key); cache.set(chosen.key, chosen.entry);
    return chosen.entry.slot;
  }
  function save(cik, period, keys, slot) {
    const key = queryFor(cik, period, keys);
    const fingerprint = slot.status === 'ready' ? sourceFingerprint(slot.projection) : null;
    const sourceTime = sourceTimestamp(slot.projection);
    const conflicting = fingerprint ? [...cache.values()].filter(entry => entry.cik === cik && entry.period === period && entry.expires > now() && entry.fingerprint && entry.fingerprint !== fingerprint) : [];
    // Requests for different positions may finish out of order. Arrival time
    // cannot make an older source revision replace a newer verified quarter.
    const newer = conflicting.find(entry => Number.isFinite(sourceTime) && Number.isFinite(entry.sourceTime) && entry.sourceTime > sourceTime);
    if (newer) {
      const current = read(cik, period, keys);
      if (current?.status === 'ready' && sourceFingerprint(current.projection) === newer.fingerprint) return current;
      return save(cik, period, keys, { period, status: 'unavailable', reason: 'A newer filing snapshot is already loaded. Retry this position to match that snapshot.' });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(slot)).byteLength;
    if (bytes > MAX_RESPONSE_BYTES || bytes > maxBytes) return slot;
    // An amendment or reconciliation changes the whole quarter. Previously
    // selected positions must be re-read against that same filing revision.
    if (conflicting.length) {
      for (const [oldKey, entry] of cache) if (entry.cik === cik && entry.period === period) remove(oldKey);
    }
    remove(key);
    while (cache.size && (cache.size >= maxEntries || cacheBytes + bytes > maxBytes)) remove(cache.keys().next().value);
    const complete = slot.status === 'ready' && slot.projection?.complete && !slot.projection?.stale && slot.cacheFresh === true;
    const sourceExpiry = Date.parse(slot.freshUntil);
    const expires = complete && Number.isFinite(sourceExpiry) ? Math.min(now() + 300000, sourceExpiry) : now() + (complete ? 300000 : 60000);
    cache.set(key, { cik, period, slot, bytes, fingerprint, sourceTime, savedAt: now(), expires });
    cacheBytes += bytes;
    return slot;
  }
  async function load(cik, period, keys, signal, force) {
    const response = await fetcher(`/api/fund-13f/history?${queryFor(cik, period, keys)}`, { signal, ...(force ? { cache: 'no-cache' } : {}) });
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('This history response exceeded the supported size.');
    const reader = response.body?.getReader();
    let raw = '', bytes = 0;
    if (reader) {
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('This history response exceeded the supported size.'); }
          raw += decoder.decode(part.value, { stream: true });
        }
        raw += decoder.decode();
      } finally { reader.releaseLock(); }
    } else { raw = await response.text(); bytes = new TextEncoder().encode(raw).byteLength; }
    signal.throwIfAborted();
    if (bytes > MAX_RESPONSE_BYTES) throw new Error('This history response exceeded the supported size.');
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('This SEC quarter could not be opened. Retry to fill the gap.'); }
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'This SEC quarter is temporarily unavailable.');
    const projection = data.projection;
    if (data.manager?.cik !== cik || data.selectedPeriod !== period || !['ready', 'unavailable'].includes(data.status) || data.status === 'ready' && (projection?.cik !== cik || projection?.period !== period || !Array.isArray(projection?.trackedKeys) || keys.some(key => !projection.trackedKeys.includes(key)) || !projection?.positions || !Array.isArray(projection?.filings))) throw new Error('The response did not match this manager, quarter, and selected securities.');
    if (data.status === 'ready') {
      summarize13FHistory([{ period, status: 'ready', projection }], { cik });
      const sourceExpiry = Date.parse(data.cache?.freshUntil);
      const stale = projection.stale === true || data.cache?.stale === true || Number.isFinite(sourceExpiry) && sourceExpiry <= now();
      return { period, status: 'ready', projection: { ...projection, observedAt: projection.observedAt || data.observedAt || null, checkedAt: projection.checkedAt || data.cache?.checkedAt || data.observedAt || null, stale }, freshUntil: data.cache?.freshUntil || null, cacheFresh: data.coverage?.selectedPeriodComplete === true && !stale }; 
    }
    return { period, status: 'unavailable', reason: data.reason || 'No usable 13F holdings report was found for this quarter.' };
  }
  function subscribe(entry, signal) {
    signal.throwIfAborted();
    entry.users += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        entry.users -= 1;
        // React can replace a window's subscriptions in one effect turn. Let
        // compatible new subscribers attach before canceling a shared request.
        queueMicrotask(() => {
          if (!entry.users && !entry.done) {
            if (inflight.get(entry.key) === entry) inflight.delete(entry.key);
            entry.controller.abort();
          }
        });
        callback(value);
      }
      function abort() { finish(reject, signal.reason || new DOMException('The operation was aborted.', 'AbortError')); }
      signal.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  function fetchQuarter(cik, period, keys, signal, force = false) {
    signal.throwIfAborted();
    const normalized = requestedKeys(keys);
    const cached = !force && read(cik, period, normalized);
    if (cached) return Promise.resolve(cached);
    const key = queryFor(cik, period, normalized);
    let entry = inflight.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException('The request timed out.', 'TimeoutError')), timeoutMs);
      entry = { key, controller, users: 0, done: false, promise: null };
      const current = entry;
      entry.promise = load(cik, period, normalized, controller.signal, force).then(slot => {
        controller.signal.throwIfAborted();
        return save(cik, period, normalized, slot);
      }).catch(error => {
        // Canceled subscriptions must not replace a valid result with a gap.
        if (controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') throw error;
        const slot = { period, status: 'unavailable', reason: controller.signal.reason?.name === 'TimeoutError' ? 'This quarter timed out. Retry to fill the gap.' : error.message || 'This quarter could not be loaded. Retry to fill the gap.' };
        return save(cik, period, normalized, slot);
      }).finally(() => {
        clearTimeout(timeout);
        current.done = true;
        if (inflight.get(key) === current) inflight.delete(key);
      });
      inflight.set(key, entry);
    }
    return subscribe(entry, signal);
  }
  return {
    fetchQuarter,
    peek: (cik, period, keys) => read(cik, period, keys),
    peekSummary: (cik, period) => read(cik, period, [], true),
  };
}

/** Keep aggregate charts visible while only the new position observation loads. */
export function historyClientSlot(client, cik, period, keys, { force = false } = {}) {
  const exact = !force && client.peek(cik, period, keys);
  if (exact?.status === 'ready') return { ...exact, requestStatus: 'ready' };
  const summary = client.peekSummary(cik, period);
  if (exact) return summary ? { ...summary, requestStatus: 'unavailable', detailReason: exact.reason } : { ...exact, requestStatus: 'unavailable' };
  return summary ? { ...summary, requestStatus: 'pending' } : { period, status: 'pending', requestStatus: 'pending' };
}


/** Resolve a finished detail request against the newest retained quarter. */
export function settled13FHistorySlot(client, cik, period, result, previous) {
  if (result.status === 'ready') return { ...result, requestStatus: 'ready' };
  const summary = client.peekSummary(cik, period) || (previous?.status === 'ready' ? previous : null);
  return summary ? { ...summary, requestStatus: 'unavailable', detailReason: result.reason } : { ...result, requestStatus: 'unavailable' };
}
