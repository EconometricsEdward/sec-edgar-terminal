import { is13FMarketConnectionResult, thirteenFMarketHoldings } from './thirteenFMarketConnections.js';

export const THIRTEEN_F_MARKET_CLIENT_LIMITS = Object.freeze({ responseBytes: 1024 * 1024, preparedBytes: 2 * 1024 * 1024, preparedMs: 8000, cacheBytes: 16 * 1024 * 1024, cacheEntries: 200, cacheMs: 300000, requestMs: 65000, resultsBytes: 32 * 1024 * 1024, workers: 2, batch: 20 });
const invalidResponse = () => new Error('The SEC evidence did not match this manager, quarter, and security. Retry this holding.');
const retryable = result => result?.status === 'unavailable' || result?.discovery?.status === 'partial' || result?.discovery?.coverage?.searchComplete === false;
const acceptableCache = result => !retryable(result);
const holdingSignature = holding => JSON.stringify(['key', 'cusip', 'issuer', 'classTitle', 'putCall', 'quantityType', 'quantity', 'valueUsd'].map(key => holding[key] ?? null));
// Match the prepared server's source-age windows. A memory hit must never
// restart freshness for an old issuer proof or company disclosure review.
function sourceExpiry(result, now) {
  const discovery = result.discovery;
  const timestamps = [result.observedAt, result.identity?.observedAt, ...(discovery ? [discovery.checkedAt] : [])].map(Date.parse);
  if (timestamps.some(value => !Number.isFinite(value) || value > now + 1000)) return 0;
  const ttl = result.status === 'unresolved' ? 60000 : discovery?.status === 'no_filing' ? 15 * 60000 : discovery?.status === 'no_matches' ? 3600000 : 6 * 3600000;
  return Math.min(...timestamps) + ttl;
}

async function readBounded(response, signal, maxBytes) {
  const tooLarge = () => new Error('This SEC evidence response exceeded the supported size. Open the source filing or retry this holding.');
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw tooLarge(); }
  const reader = response.body?.getReader();
  let raw = '', bytes = 0;
  if (reader) {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw tooLarge(); }
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
  } else {
    raw = await response.text(); bytes = new TextEncoder().encode(raw).byteLength;
  }
  signal.throwIfAborted();
  if (bytes > maxBytes) throw tooLarge();
  let data;
  try { data = JSON.parse(raw); } catch { if (response.ok) throw new Error('This holding’s SEC evidence could not be opened. Retry this holding.'); }
  if (!response.ok) {
    const error = new Error(typeof data?.error === 'string' ? data.error.slice(0, 1000) : 'This holding’s SEC evidence is temporarily unavailable.');
    error.status = response.status;
    const retryAfter = response.headers.get('retry-after');
    const waitMs = retryAfter == null ? NaN : /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    error.retryAfterMs = Math.min(300000, Math.max(1000, Number.isFinite(waitMs) ? waitMs : 60000));
    throw error;
  }
  return { data, bytes };
}

/** Each cache hit is rechecked against the actual current filed security. A
 * revised report cannot reuse a value or proof from a different observation. */
export function create13FMarketConnectionClient({ fetchImpl = (...args) => fetch(...args), now = Date.now, limits = THIRTEEN_F_MARKET_CLIENT_LIMITS } = {}) {
  const cache = new Map();
  let cacheBytes = 0;
  function remove(key) { const value = cache.get(key); if (value) cacheBytes -= value.bytes; cache.delete(key); }
  const keyFor = ({ cik, period, holding }) => `${new URLSearchParams({ cik, period, key: holding.key })}:${holdingSignature(holding)}`;
  function peek({ cik, period, holding }) {
    const cacheKey = keyFor({ cik, period, holding });
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > now() && is13FMarketConnectionResult(cached.data, { cik, period, holding, now: now() })) {
      cache.delete(cacheKey); cache.set(cacheKey, cached); return cached.data;
    }
    if (cached) remove(cacheKey);
    return null;
  }
  function remember(data, { cik, period, holding }, bytes) {
    if (!is13FMarketConnectionResult(data, { cik, period, holding, now: now() })) throw invalidResponse();
    const cacheKey = keyFor({ cik, period, holding });
    remove(cacheKey);
    const expires = Math.min(now() + limits.cacheMs, sourceExpiry(data, now()));
    if (acceptableCache(data) && bytes <= limits.cacheBytes && expires > now()) {
      for (const [key, value] of cache) if (value.expires <= now()) remove(key);
      while (cache.size && (cache.size >= limits.cacheEntries || cacheBytes + bytes > limits.cacheBytes)) remove(cache.keys().next().value);
      cache.set(cacheKey, { data, bytes, expires }); cacheBytes += bytes;
    }
    return data;
  }
  async function load({ cik, period, holding, signal, force = false }) {
    signal.throwIfAborted();
    const request = { cik, period, holding };
    const cached = !force && peek(request);
    if (cached) return cached;
    remove(keyFor(request));
    const query = new URLSearchParams({ cik, period, key: holding.key });
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.requestMs)]);
    const response = await fetchImpl(`/api/fund-13f/market-connections?${query}`, { signal: requestSignal, ...(force ? { cache: 'no-cache' } : {}) });
    const { data, bytes } = await readBounded(response, requestSignal, limits.responseBytes);
    return remember(data, request, bytes);
  }
  async function loadPrepared({ cik, period, holdings, signal }) {
    signal.throwIfAborted();
    const byKey = new Map(holdings.map(holding => [holding.key, holding]));
    if (!holdings.length || holdings.length > limits.batch || byKey.size !== holdings.length) throw invalidResponse();
    const query = new URLSearchParams({ cik, period, prepared: '1' });
    for (const holding of holdings) query.append('key', holding.key);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.preparedMs)]);
    const response = await fetchImpl(`/api/fund-13f/market-connections?${query}`, { signal: requestSignal });
    const { data } = await readBounded(response, requestSignal, limits.preparedBytes);
    const seen = new Set();
    if (data?.schemaVersion !== 'edgar.13f-market-connections-batch.v1' || data.manager?.cik !== cik || data.selectedPeriod !== period
      || data.requested !== holdings.length || !Array.isArray(data.results) || data.results.length > holdings.length
      || data.results.some(result => {
        const key = result?.holding?.key, holding = byKey.get(key);
        if (!holding || seen.has(key) || !is13FMarketConnectionResult(result, { cik, period, holding, now: now() })) return true;
        seen.add(key); return false;
      })) throw invalidResponse();
    return data.results.filter(result => acceptableCache(result) && sourceExpiry(result, now()) > now()).map(result => remember(result, { cik, period, holding: byKey.get(result.holding.key) }, new TextEncoder().encode(JSON.stringify(result)).byteLength));
  }
  return { load, loadPrepared, peek, cacheSize: () => ({ entries: cache.size, bytes: cacheBytes }) };
}

const sharedClient = create13FMarketConnectionClient();

/** A report owns its scan. Aborted work remains queued, and completed evidence
 * stays visible while a retry or refresh replaces only its own result. */
export function create13FMarketConnectionSession(data, { client = sharedClient, resultsBytes = THIRTEEN_F_MARKET_CLIENT_LIMITS.resultsBytes } = {}) {
  const holdings = thirteenFMarketHoldings(data), byKey = new Map(holdings.map(holding => [holding.key, holding]));
  const cik = data?.manager?.cik || '', period = data?.selectedPeriod || '';
  const validReport = /^\d{10}$/.test(cik) && Number(cik) > 0 && /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(period)
    && data?.portfolio?.cik === cik && data?.portfolio?.period === period;
  const results = new Map(), sizes = new Map(), failures = new Map(), queued = new Map(), running = new Map(), listeners = new Set();
  let active = false, paused = false, blocked = false, retainedBytes = 0, limit = Math.min(THIRTEEN_F_MARKET_CLIENT_LIMITS.batch, holdings.length), version = 0;
  let snapshot, preparedTask = null, resultList = [], rateLimitMessage = null;
  function publish() {
    const keys = holdings.slice(0, limit).map(holding => holding.key);
    const completed = keys.filter(key => results.has(key) && !queued.has(key) && !running.has(key)).length;
    snapshot = { results: resultList, pending: active && !paused && (queued.size > 0 || running.size > 0), paused, blocked, limit, completed,
      progress: limit ? Math.round(completed / limit * 100) : 100, error: !validReport ? 'Reopen a verified manager report before researching market connections.'
        : blocked ? 'This scan reached the browser’s evidence limit. Completed connections remain available. Continue researching individual holdings through Company research.'
          : rateLimitMessage ? rateLimitMessage
          : failures.size ? `Could not refresh ${failures.size} holding${failures.size === 1 ? '' : 's'}. Earlier verified evidence remains visible. Retry to update it.` : null };
    for (const listener of listeners) listener();
  }
  function queue(key, force = false) {
    if (!byKey.has(key) || (!force && (results.has(key) || queued.has(key) || running.has(key)))) return;
    queued.set(key, { key, force, version: ++version });
  }
  function fillScope() { for (const holding of holdings.slice(0, limit)) queue(holding.key); }
  function stopRunning() {
    if (preparedTask) { preparedTask.controller.abort(); preparedTask = null; }
    for (const [key, job] of running) {
      if (!queued.has(key)) queued.set(key, { key, force: job.force, prepared: job.prepared, version: ++version });
      job.controller.abort();
    }
    running.clear();
  }
  function retain(key, result) {
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    if (retainedBytes - (sizes.get(key) || 0) + bytes > resultsBytes) {
      blocked = true; paused = true; stopRunning(); publish(); return;
    }
    retainedBytes += bytes - (sizes.get(key) || 0); sizes.set(key, bytes);
    failures.delete(key); results.set(key, result); resultList = [...results.values()];
  }
  function pauseForRateLimit(error) {
    const seconds = Math.ceil(Math.min(300000, Math.max(1000, Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 60000)) / 1000);
    rateLimitMessage = `Review paused while the request limit resets. Wait ${seconds} second${seconds === 1 ? '' : 's'}, then select Resume. Completed evidence remains available.`;
    paused = true; stopRunning(); publish();
  }
  function hydrate() {
    // Look up just the next bounded group. A full-portfolio scan must not fan
    // out thousands of cache reads while the two source workers are occupied.
    const jobs = [...queued.values()].filter(job => !job.force && !job.prepared).slice(0, THIRTEEN_F_MARKET_CLIENT_LIMITS.batch);
    const controller = new AbortController(), task = { controller, jobs };
    preparedTask = task;
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return client.loadPrepared({ cik, period, holdings: jobs.map(job => byKey.get(job.key)), signal: controller.signal });
    }).then(values => {
      if (preparedTask !== task || controller.signal.aborted) return;
      const requested = new Map(jobs.map(job => [job.key, job])), seen = new Set();
      // Also guard injected loaders, and reject the whole batch before any
      // evidence is published if a result is foreign, repeated, or amended.
      if (!Array.isArray(values) || values.length > jobs.length || values.some(result => {
        const key = result?.holding?.key;
        if (!requested.has(key) || seen.has(key) || !is13FMarketConnectionResult(result, { cik, period, holding: byKey.get(key) })) return true;
        seen.add(key); return false;
      })) return;
      for (const result of values) {
        if (preparedTask !== task || blocked) break;
        const key = result.holding.key;
        if (queued.get(key) !== requested.get(key) || !acceptableCache(result)) continue;
        queued.delete(key); retain(key, result);
      }
    }).catch(error => {
      // A prepared cache miss or short read failure falls through to the
      // ordinary verified source path without presenting a false data gap.
      if (preparedTask === task && !controller.signal.aborted && error?.status === 429) pauseForRateLimit(error);
    }).finally(() => {
      if (preparedTask !== task) return;
      preparedTask = null;
      for (const job of jobs) if (queued.get(job.key) === job) job.prepared = true;
      pump();
    });
  }
  function pump() {
    if (!active || paused || blocked || !validReport) { publish(); return; }
    // Restore memory hits immediately, even while a prepared lookup is slow.
    for (const [key, job] of [...queued.entries()].slice(0, THIRTEEN_F_MARKET_CLIENT_LIMITS.batch)) {
      const cached = !job.force && client.peek?.({ cik, period, holding: byKey.get(key) });
      if (cached && is13FMarketConnectionResult(cached, { cik, period, holding: byKey.get(key) })) {
        queued.delete(key); retain(key, cached);
        if (blocked) return;
      }
    }
    while (running.size < THIRTEEN_F_MARKET_CLIENT_LIMITS.workers && queued.size) {
      const [key, job] = queued.entries().next().value;
      if (!job.force && !job.prepared && typeof client.loadPrepared === 'function') {
        if (!preparedTask) hydrate();
        break;
      }
      queued.delete(key);
      const controller = new AbortController(), task = { ...job, controller };
      running.set(key, task);
      const holding = byKey.get(key);
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return client.load({ cik, period, holding, signal: controller.signal, force: task.force });
      }).then(result => {
        if (running.get(key) !== task || controller.signal.aborted) return;
        // Keep this guard even for injected loaders: the session must never
        // publish an unrelated response after navigation or report refresh.
        if (!is13FMarketConnectionResult(result, { cik, period, holding })) throw invalidResponse();
        const previous = results.get(key);
        if (previous && is13FMarketConnectionResult(previous, { cik, period, holding }) && previous.status !== 'unavailable' && result.status === 'unavailable') {
          failures.set(key, true); return;
        }
        retain(key, result);
      }).catch(error => {
        if (running.get(key) === task && !controller.signal.aborted) {
          if (error?.status === 429) { pauseForRateLimit(error); return; }
          const previous = results.get(key);
          if (previous && is13FMarketConnectionResult(previous, { cik, period, holding }) && previous.status !== 'unavailable') failures.set(key, true);
          else retain(key, { key, holding, status: 'unavailable', message: error?.name === 'TimeoutError'
            ? 'This holding’s SEC research timed out. Retry this holding.' : (typeof error?.message === 'string' ? error.message.slice(0, 1000) : 'This holding’s SEC evidence is temporarily unavailable.') });
        }
      }).finally(() => {
        if (running.get(key) !== task) return;
        running.delete(key); pump();
      });
    }
    publish();
  }
  function retry(key) {
    if (blocked) return;
    const targets = holdings.slice(0, limit).filter(holding => (!key || holding.key === key) && (retryable(results.get(holding.key)) || failures.has(holding.key)));
    if (targets.length) { paused = false; rateLimitMessage = null; }
    for (const holding of targets) if (!running.has(holding.key)) queue(holding.key, true);
    pump();
  }
  publish();
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    setActive(value) { active = value; if (!active) stopRunning(); else fillScope(); pump(); },
    pause() { paused = true; stopRunning(); publish(); },
    resume() { if (blocked) return; paused = false; rateLimitMessage = null; fillScope(); pump(); },
    startAll() { if (blocked) return; limit = holdings.length; paused = false; rateLimitMessage = null; fillScope(); pump(); },
    scanNext() { if (blocked) return; limit = Math.min(limit + THIRTEEN_F_MARKET_CLIENT_LIMITS.batch, holdings.length); paused = false; rateLimitMessage = null; fillScope(); pump(); },
    retry,
    refresh() { if (blocked) return; paused = false; rateLimitMessage = null; stopRunning(); queued.clear(); for (const holding of holdings.slice(0, limit)) queue(holding.key, true); pump(); },
  };
}
