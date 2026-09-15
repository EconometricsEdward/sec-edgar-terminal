import { loadThirteenF, normalize13FRequest } from './thirteenFServer.js';
import { buildThirteenFComparison } from './thirteenFComparison.js';

export const POPULAR_13F_MANAGERS = Object.freeze([
  { cik: '0001350694', name: 'Bridgewater Associates' },
  { cik: '0001067983', name: 'Berkshire Hathaway' },
  { cik: '0001037389', name: 'Renaissance Technologies' },
  { cik: '0001747057', name: 'D1 Capital' },
]);
const QUARTER = /^\d{4}-(?:03-31|06-30|09-30|12-31)$/;
const MAX_FRESH_MS = 300000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const failure = (message, status = 502, code = 'SEC_13F_COMPARISON_UNAVAILABLE') => Object.assign(new Error(message), { status, code });
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

/** Validate before any source request. Manager order is part of the display binding. */
export function normalize13FComparisonRequest(ciksInput, periodInput = '', { now = Date.now() } = {}) {
  const values = ciksInput === undefined || ciksInput === null ? POPULAR_13F_MANAGERS.map(manager => manager.cik)
    : Array.isArray(ciksInput) ? ciksInput : String(ciksInput).split(',');
  if (values.length < 2 || values.length > 4) throw failure('Select between two and four SEC managers.', 400, 'INVALID_MANAGERS');
  const ciks = values.map(value => normalize13FRequest(value).cik);
  if (new Set(ciks).size !== ciks.length) throw failure('Choose a different manager for each comparison slot.', 400, 'DUPLICATE_MANAGERS');
  const period = normalize13FRequest(ciks[0], periodInput).period;
  if (period && (Number(period.slice(0, 4)) <= 0 || period > new Date(now).toISOString().slice(0, 10))) throw failure('Select a report quarter that has already ended.', 400, 'INVALID_PERIOD');
  return { ciks, period };
}

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Request aborted.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function twoWorkers(items, operation, signal) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
    while (next < items.length) {
      signal.throwIfAborted();
      const index = next++;
      result[index] = await operation(items[index], index);
    }
  }));
  return result;
}

function periodsFor(data, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  return new Set([...(Array.isArray(data?.reports) ? data.reports.map(report => report?.period) : []), data?.status === 'ready' ? data.selectedPeriod : null]
    .filter(period => typeof period === 'string' && QUARTER.test(period) && Number(period.slice(0, 4)) > 0 && period <= today));
}

function selectPeriod(slots, requestedPeriod, now) {
  const manifests = slots.filter(slot => slot.data).map(slot => ({ cik: slot.cik, periods: periodsFor(slot.data, now) }));
  const usable = manifests.filter(manifest => manifest.periods.size);
  const common = usable.length ? [...usable[0].periods].filter(period => usable.every(manifest => manifest.periods.has(period))).sort().reverse() : [];
  const counts = new Map();
  for (const manifest of usable) for (const period of manifest.periods) counts.set(period, (counts.get(period) || 0) + 1);
  const widest = [...counts].sort(([a, countA], [b, countB]) => countB - countA || b.localeCompare(a));
  const selectedPeriod = requestedPeriod || common[0] || widest[0]?.[0];
  if (!selectedPeriod) throw failure('No reporting quarter could be loaded for these managers. Retry the comparison or select a report quarter.', 503);
  const allKnown = manifests.length === slots.length && usable.length === slots.length;
  const commonQuarter = allKnown && usable.every(manifest => manifest.periods.has(selectedPeriod));
  const alignmentScope = commonQuarter ? 'all-managers' : common.includes(selectedPeriod) ? 'available-managers' : 'partial';
  const availablePeriods = common.length ? common : [...counts.keys()].sort().reverse();
  if (requestedPeriod && !availablePeriods.includes(requestedPeriod)) availablePeriods.push(requestedPeriod);
  availablePeriods.sort().reverse();
  return {
    selectedPeriod, availablePeriods,
    selection: {
      managerCiks: slots.map(slot => slot.cik), requestedPeriod: requestedPeriod || null,
      automatic: !requestedPeriod, aligned: true, commonQuarter, alignmentScope,
      note: commonQuarter ? null : alignmentScope === 'available-managers'
        ? 'This quarter is shared by the available manager histories. Unavailable managers remain visible and are not treated as empty portfolios.'
        : requestedPeriod ? 'Some managers do not have a verified public report for this quarter. Available reports use the same selected quarter.'
          : 'No quarter was shared by every available history. The selected quarter covers the most managers; ties use the newest quarter. Missing reports remain visible.',
    },
  };
}

/** Compact comparisons reuse durable, accession-keyed report caches. They never
 * start issuer research, CFTC downloads, or historical-quarter scans. */
export function createThirteenFComparisonLoader({
  reportLoader = loadThirteenF, buildComparison = buildThirteenFComparison,
  now = Date.now, deadlineMs = 54000, workBudgetMs = 48000, reportTimeoutMs = workBudgetMs, maxPending = 4, maxCacheBytes = 4 * 1024 * 1024,
} = {}) {
  const cache = new Map(), pending = new Map(), generations = new Map();
  let cacheBytes = 0;
  function deleteCache(key) {
    const entry = cache.get(key);
    if (entry) { cacheBytes -= entry.bytes; cache.delete(key); }
  }
  function put(key, data, bytes) {
    deleteCache(key);
    if (!data.coverage.allComplete || data.cache.stale || !data.cache.freshUntil || Date.parse(data.cache.freshUntil) <= now() || bytes > maxCacheBytes) return;
    while (cache.size && (cache.size >= 16 || cacheBytes + bytes > maxCacheBytes)) deleteCache(cache.keys().next().value);
    cache.set(key, { data, bytes, expires: Date.parse(data.cache.freshUntil) });
    cacheBytes += bytes;
  }
  async function build(ciks, period, refresh, signal) {
    const deadlineAt = now() + workBudgetMs;
    let sourceWaitExpired = false;
    async function load(cik, selectedPeriod) {
      const name = POPULAR_13F_MANAGERS.find(manager => manager.cik === cik)?.name;
      let reportSignal;
      try {
        const remainingMs = deadlineAt - now();
        if (sourceWaitExpired || remainingMs <= 0) return { cik, name, status: 'unavailable', reason: 'This manager’s report is still being prepared. Retry the comparison to reuse completed reports.' };
        reportSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(Math.min(reportTimeoutMs, remainingMs))))]);
        const data = await abortable(reportLoader(cik, { period: selectedPeriod, refresh, signal: reportSignal }), reportSignal);
        if (data?.manager?.cik !== cik || !Array.isArray(data.reports) || data.reports.length > 100 || !['ready', 'unavailable'].includes(data.status)) throw failure('The manager report did not match the comparison request.');
        if (selectedPeriod && data.status === 'ready' && data.selectedPeriod !== selectedPeriod) throw failure('The manager report did not match the selected quarter.');
        return { cik, name: data.manager.name || name, status: data.status, data };
      } catch (error) {
        signal.throwIfAborted();
        // A cancelled reader only detaches from the coalesced report loader;
        // its SEC preparation may continue for another reader. Do not start
        // queued managers or alignment work after relinquishing either slot.
        if (reportSignal?.aborted) sourceWaitExpired = true;
        return { cik, name, status: 'unavailable', reason: error.name === 'TimeoutError' || error.name === 'AbortError'
          ? 'This manager’s SEC report timed out. Retry the comparison.' : 'This manager’s SEC report could not be loaded. Retry the comparison or open its 13F workspace.' };
      }
    }
    let slots = await twoWorkers(ciks, cik => load(cik, period), signal);
    const alignment = selectPeriod(slots, period, now());
    // Already aligned latest reports are reused; only mismatching managers need
    // one additional explicit-quarter request. No previous-quarter tables load.
    slots = await twoWorkers(slots, async slot => {
      if (!slot.data || slot.data.status !== 'ready' || slot.data.selectedPeriod === alignment.selectedPeriod) return slot;
      return load(slot.cik, alignment.selectedPeriod);
    }, signal);
    const modelSlots = slots.map(slot => slot.data?.status === 'ready' && slot.data.selectedPeriod === alignment.selectedPeriod
      ? slot : { cik: slot.cik, name: slot.name, status: 'unavailable', reason: slot.reason || 'No public holdings table is available for this manager in the selected quarter.' });
    const model = buildComparison(modelSlots, { period: alignment.selectedPeriod, now: now() });
    const reports = modelSlots.map(slot => slot.data).filter(Boolean);
    const stale = reports.some(data => data.cache?.stale === true);
    const checked = reports.map(data => iso(data.cache?.checkedAt) ?? iso(data.observedAt)).filter(value => value !== null);
    const expiries = reports.map(data => iso(data.cache?.freshUntil) ?? ((iso(data.observedAt) ?? now() - MAX_FRESH_MS) + MAX_FRESH_MS));
    const freshUntil = model.coverage.allComplete && !stale && expiries.length === ciks.length ? Math.min(...expiries, now() + MAX_FRESH_MS) : null;
    const data = {
      ...model, ...alignment,
      cache: {
        status: 'source', stale,
        checkedAt: checked.length ? new Date(Math.min(...checked)).toISOString() : null,
        freshUntil: freshUntil !== null ? new Date(freshUntil).toISOString() : null,
        ...(stale ? { message: 'One or more managers use a previously verified report because the latest source check failed. The original report check times remain visible.' } : {}),
      },
    };
    const bytes = encoder.encode(JSON.stringify(data)).length;
    if (bytes > MAX_RESPONSE_BYTES) throw failure('This comparison exceeds the supported response size. Compare fewer managers.', 422, 'COMPARISON_TOO_LARGE');
    return { data, bytes };
  }
  return async function loadComparison(ciksInput, { period: periodInput = '', refresh = false, signal } = {}) {
    const { ciks, period } = normalize13FComparisonRequest(ciksInput, periodInput, { now: now() });
    signal?.throwIfAborted();
    const key = `${ciks.join(',')}:${period || 'latest'}`;
    if (refresh) deleteCache(key);
    const refreshing = pending.get(`${key}:refresh`);
    if (refreshing) return abortable(refreshing, signal);
    const existing = cache.get(key);
    if (!refresh && existing?.expires > now()) return { ...existing.data, cache: { ...existing.data.cache, status: 'memory' } };
    if (existing?.expires <= now()) deleteCache(key);
    const pendingKey = `${key}:${refresh ? 'refresh' : 'read'}`;
    if (pending.has(pendingKey)) return abortable(pending.get(pendingKey), signal);
    if (pending.size >= maxPending) throw failure('Several comparisons are loading. Retry this comparison shortly.', 503, 'SEC_13F_COMPARISON_BUSY');
    const generation = Symbol(key);
    generations.set(key, generation);
    // A caller leaving the page must not cancel another reader’s shared work.
    const sourceSignal = AbortSignal.timeout(deadlineMs);
    const work = build(ciks, period, refresh, sourceSignal).then(({ data, bytes }) => {
      if (generations.get(key) === generation) put(key, data, bytes);
      return data;
    }).finally(() => {
      pending.delete(pendingKey);
      if (generations.get(key) === generation) generations.delete(key);
    });
    pending.set(pendingKey, work);
    return abortable(work, signal);
  };
}

export const loadThirteenFComparison = createThirteenFComparisonLoader();
