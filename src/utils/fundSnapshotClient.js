const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const CIK = /^(?!0000000000)\d{10}$/;
const FORM = /^NPORT-P(?:\/A)?$/;
const numeric = value => value === null || typeof value === 'number' && Number.isFinite(value);
const text = (value, max = 1000) => typeof value === 'string' && value.length > 0 && value.length <= max;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const count = (value, max = 100000) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const position = row => Number.isSafeInteger(row?.id) && row.id > 0 && text(row.name)
  && numeric(row.value) && numeric(row.pctOfNav) && text(row.assetCat, 100) && text(row.invCountry, 100);

/** Validate identity and full-portfolio aggregates without requiring every position in the browser. */
export function validFundSnapshot(data, ticker, accession = '', now = Date.now(), { summaryOnly = true } = {}) {
  try {
    if (!TICKER.test(ticker) || data?.ticker !== ticker || !['ready', 'unavailable'].includes(data.status)) return false;
    if (data.status === 'unavailable') return text(data.reason, 4000);
    if (!CIK.test(data.cik || '') || !ACCESSION.test(data.accession || '') || accession && accession !== data.accession
      || data.isFund !== true || !FORM.test(data.form || '') || !text(data.name) || !text(data.registrant)
      || data.seriesId !== null && !/^S\d{9}$/.test(data.seriesId || '')
      || data.classId !== null && (!data.seriesId || !/^C\d{9}$/.test(data.classId || ''))
      || !['SEC series matched', 'SEC registrant matched'].includes(data.identity)
      || data.identity === 'SEC series matched' && !data.seriesId
      || !date(data.asOf) || !date(data.filingDate) || data.asOf > data.filingDate
      || data.filingDate > new Date(now).toISOString().slice(0, 10)
      || !timestamp(data.retrievedAt) || Date.parse(data.retrievedAt) > now
      || summaryOnly && (data.responseScope !== 'summary' || data.summaryScope !== 'full-portfolio' || 'holdings' in data)
      || !['totAssets', 'totLiabs', 'netAssets', 'cash'].every(key => numeric(data.fundInfo?.[key]))) return false;
    const root = `https://www.sec.gov/Archives/edgar/data/${Number(data.cik)}/${data.accession.replaceAll('-', '')}/`;
    if (typeof data.sourceUrl !== 'string' || !data.sourceUrl.startsWith(root)
      || !/^[\w][\w.-]{0,239}\.xml$/i.test(data.sourceUrl.slice(root.length)) || data.sourceUrl.slice(root.length).includes('..')
      || data.filingUrl !== `${root}${data.accession}-index.html`
      || data.secUrl !== `https://www.sec.gov/edgar/browse/?CIK=${data.identity === 'SEC series matched' ? data.seriesId : data.cik}&owner=exclude`) return false;
    const summary = data.summary;
    if (!count(summary?.count) || !['valuedCount', 'weightCount', 'derivativeCount'].every(key => count(summary[key], summary.count))
      || !['value', 'weightTotal', 'top10Weight'].every(key => numeric(summary[key]))
      || summary.largest !== null && !position(summary.largest)) return false;
    for (const key of ['assets', 'countries']) {
      if (!Array.isArray(summary[key]) || summary[key].length > 500
        || summary[key].some(row => !text(row?.key, 100) || !count(row.count, summary.count) || !numeric(row.value) || !numeric(row.pctOfNav))
        || summary[key].reduce((total, row) => total + row.count, 0) !== summary.count) return false;
    }
    if (data.topHoldings !== undefined && (!Array.isArray(data.topHoldings) || data.topHoldings.length > Math.min(6, summary.count)
      || data.topHoldings.some(row => !position(row)) || new Set(data.topHoldings.map(row => row.id)).size !== data.topHoldings.length)) return false;
    if (summaryOnly && !Array.isArray(data.topHoldings)) return false;
    if (!Array.isArray(data.reports) || data.reports.length > 21
      || data.reports.some(row => !ACCESSION.test(row?.accession || '') || !FORM.test(row.form || '') || !date(row.filingDate)
        || row.reportDate !== null && !date(row.reportDate))
      || !data.reports.some(row => row.accession === data.accession && row.reportDate === data.asOf && row.filingDate === data.filingDate && row.form === data.form)) return false;
    if (data.cache && (!timestamp(data.cache.checkedAt) || !timestamp(data.cache.freshUntil)
      || Date.parse(data.cache.checkedAt) > now || Date.parse(data.cache.checkedAt) < Date.parse(data.retrievedAt)
      || Date.parse(data.cache.freshUntil) <= Date.parse(data.cache.checkedAt) || typeof data.cache.stale !== 'boolean')) return false;
    return JSON.stringify(data).length <= 256 * 1024;
  } catch { return false; }
}

// Reuse does not reset the source check or turn a retained result into fresh data.
export function fundSnapshotIsStale(data, now = Date.now()) {
  return Boolean(data?.cache?.stale || data?.cache?.freshUntil && Date.parse(data.cache.freshUntil) <= now);
}

function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** A bounded queue per explorer, with exact request identity and two simultaneous reads. */
export function createFundSnapshotClient({ fetcher = (...args) => fetch(...args), now = Date.now,
  onStates = (_states) => {}, onProgress = (_progress) => {}, timeoutMs = 55000, maxEntries = 64 } = {}) {
  const entries = new Map(), jobs = new Map(), queue = [];
  let running = 0, total = 0, completed = 0, cancelled = false;
  const progress = () => onProgress({ busy: jobs.size > 0, total, completed,
    ticker: [...jobs.values()].filter(job => job.started).map(job => job.ticker).join(', '), cancelled });
  function publish(key, state, expiresAt = 0) {
    entries.delete(key);
    entries.set(key, { state, expiresAt });
    while (entries.size > maxEntries) {
      const victim = [...entries.keys()].find(value => !jobs.has(value));
      if (!victim) break;
      entries.delete(victim);
    }
    onStates(Object.fromEntries([...entries].map(([id, entry]) => [id, entry.state])));
  }
  function retention(data, exact) {
    if (data.status !== 'ready') return now() + 60000;
    if (exact) return now() + 3600000;
    if (fundSnapshotIsStale(data, now())) return now() + 60000;
    const sourceExpiry = Date.parse(data.cache?.freshUntil || '');
    return Math.min(now() + 300000, Number.isFinite(sourceExpiry) ? sourceExpiry : now() + 300000);
  }
  function finish(job, success) {
    if (jobs.get(job.key) !== job) return;
    jobs.delete(job.key);
    completed++;
    job.resolve(success);
  }
  async function run(job) {
    const prior = entries.get(job.key)?.state.data;
    const timer = setTimeout(() => job.controller.abort(new Error('Portfolio request timed out. Retry this fund.')), timeoutMs);
    try {
      const query = new URLSearchParams({ v: '3', ticker: job.ticker, view: 'summary',
        ...(job.refresh ? { refresh: '1' } : {}), ...(job.accession ? { accession: job.accession } : {}) });
      const response = await abortable(fetcher(`/api/fund?${query}`, { signal: job.controller.signal }), job.controller.signal);
      const data = await abortable(response.json(), job.controller.signal);
      if (job.controller.signal.aborted || jobs.get(job.key) !== job) return;
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${response.status}).`);
      if (!validFundSnapshot(data, job.ticker, job.accession, now())) throw new Error('The returned portfolio identity or summary could not be verified. Retry this fund.');
      const state = data.status === 'ready' ? { status: 'ready', data } : { status: 'unavailable', data, error: data.reason };
      publish(job.key, state, retention(data, Boolean(job.accession)));
      if (state.status === 'ready') publish(`${job.ticker}:${data.accession}`, state, retention(data, true));
      finish(job, true);
    } catch (error) {
      if (jobs.get(job.key) !== job) return;
      const message = error instanceof Error ? error.message : 'Snapshot could not be loaded. Retry this fund.';
      publish(job.key, prior?.status === 'ready' ? { status: 'ready', data: prior, error: message }
        : { status: 'error', error: message }, now() + 60000);
      finish(job, false);
    } finally {
      clearTimeout(timer);
      running--;
      drain();
    }
  }
  function drain() {
    while (running < 2 && queue.length) {
      const job = queue.shift();
      if (jobs.get(job.key) !== job) continue;
      running++;
      job.started = true;
      void run(job);
    }
    progress();
  }
  function load(tickers, reportMap = {}, force = false) {
    const requests = [...new Set(tickers.map(value => String(value).trim().toUpperCase()))].slice(0, 32);
    if (!jobs.size) { total = 0; completed = 0; cancelled = false; }
    const work = requests.map(ticker => {
      const accession = reportMap[ticker] || '';
      if (!TICKER.test(ticker) || accession && !ACCESSION.test(accession)) return Promise.resolve(false);
      const key = `${ticker}:${accession || 'latest'}`;
      if (jobs.has(key)) return jobs.get(key).promise;
      const hit = entries.get(key);
      if (!force && hit?.expiresAt > now()) return Promise.resolve(hit.state.status === 'ready' || hit.state.status === 'unavailable');
      if (jobs.size >= 32) return Promise.resolve(false);
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const job = { key, ticker, accession, refresh: force, promise, resolve, controller: new AbortController(), started: false };
      jobs.set(key, job);
      queue.push(job);
      total++;
      publish(key, hit?.state.status === 'ready' ? { ...hit.state, refreshing: true, error: undefined }
        : { status: 'loading', ...(hit?.state.data ? { data: hit.state.data } : {}) });
      return promise;
    });
    drain();
    return Promise.all(work).then(results => results.every(Boolean));
  }
  function cancel() {
    cancelled = jobs.size > 0;
    for (const job of [...jobs.values()]) {
      const prior = entries.get(job.key)?.state.data;
      publish(job.key, prior?.status === 'ready' ? { status: 'ready', data: prior }
        : { status: 'cancelled', error: 'Loading cancelled. Retry this fund when ready.' });
      finish(job, false);
      job.controller.abort(new Error('Loading cancelled.'));
    }
    queue.length = 0;
    progress();
  }
  function ingest(funds) {
    for (const original of funds.slice(0, 32)) {
      // Comparison responses contain complete summaries but intentionally omit positions.
      const { holdings: _holdings, filings: _filings, ...data } = original || {};
      if (data.status !== 'ready' || !validFundSnapshot(data, data.ticker, data.accession, now(), { summaryOnly: false })) continue;
      const key = `${data.ticker}:${data.accession}`;
      if (jobs.has(key)) continue;
      const previous = entries.get(key)?.state.data;
      if (Date.parse(previous?.cache?.checkedAt || previous?.retrievedAt || '') > Date.parse(data.cache?.checkedAt || data.retrievedAt)) continue;
      // Comparison metadata has no preview positions. Keep a verified preview only
      // when its exact filing identity, portfolio totals and source still agree.
      if (data.topHoldings === undefined && Array.isArray(previous?.topHoldings)
        && ['ticker', 'cik', 'seriesId', 'classId', 'accession', 'asOf', 'filingDate', 'form', 'sourceUrl']
          .every(field => data[field] === previous[field])
        && JSON.stringify(data.summary) === JSON.stringify(previous.summary)
        && JSON.stringify(data.fundInfo) === JSON.stringify(previous.fundInfo)) data.topHoldings = previous.topHoldings;
      publish(key, { status: 'ready', data }, retention(data, true));
    }
  }
  return { load, cancel, ingest, getStates: () => Object.fromEntries([...entries].map(([key, entry]) => [key, entry.state])) };
}
