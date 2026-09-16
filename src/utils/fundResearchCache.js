import { createHash } from 'node:crypto';
import { cacheGet, cachePut, disposableCacheEnabled } from './disposableCache.js';
import { portfolioSummary } from './fundResearch.js';
import { validFilingDate } from './filingsResearch.js';

export const FUND_CACHE_TYPE = 'edgar.nport-prepared.v1:production';
export const FUND_CACHE_VERSION = 'edgar.nport-prepared.v1';
export const FUND_FRESH_MS = 3600000;
export const FUND_RETENTION_MS = 30 * 86400000;
export const FUND_MAX_BYTES = 24 * 1024 * 1024;
const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const CIK = /^(?!0000000000)\d{10}$/;
const FORM = /^NPORT-P(?:\/A)?$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, max = 1000) => typeof value === 'string' && value.length > 0 && value.length <= max;
const optionalText = value => value === null || text(value);
const numeric = value => value === null || typeof value === 'number' && Number.isFinite(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const identity = value => CIK.test(value?.cik || '') && (value.seriesId === null || /^S\d{9}$/.test(value.seriesId))
  && (value.classId === null || Boolean(value.seriesId) && /^C\d{9}$/.test(value.classId));
const sameIdentity = (a, b) => ['ticker', 'cik', 'seriesId', 'classId', 'accession'].every(key => a[key] === b[key]);
const filingRoot = (cik, accession) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/`;

export function normalizeFundRequest(tickerInput, accessionInput = '') {
  const ticker = String(tickerInput ?? '').trim().toUpperCase(), accession = String(accessionInput ?? '').trim();
  if (!TICKER.test(ticker) || accession && !ACCESSION.test(accession)) throw new Error('Enter a valid fund ticker and filing accession.');
  return { ticker, accession };
}

/** Preserve every position and its reported, calculated or missing values. */
export function validPreparedFundData(data, ticker, accession, now = Date.now()) {
  try {
    if (data?.status !== 'ready' || data.ticker !== ticker || !identity(data) || !ACCESSION.test(data.accession || '')
      || accession && data.accession !== accession || !FORM.test(data.form || '') || !text(data.name) || !text(data.registrant)
      || data.isFund !== true || !optionalText(data.family) || !validFilingDate(data.asOf) || !validFilingDate(data.filingDate)
      || data.filingDate < data.asOf || data.filingDate > new Date(now).toISOString().slice(0, 10)
      || !iso(data.retrievedAt) || Date.parse(data.retrievedAt) > now || now - Date.parse(data.retrievedAt) >= FUND_RETENTION_MS
      || !Array.isArray(data.holdings) || data.holdings.length > 100000 || !data.fundInfo
      || !['totAssets', 'totLiabs', 'netAssets', 'cash'].every(key => numeric(data.fundInfo[key]))
      || !['reported', 'assets less liabilities', 'unavailable'].includes(data.fundInfo.netAssetsSource)) return false;
    if (data.fundInfo.netAssetsSource === 'reported' && data.fundInfo.netAssets === null
      || data.fundInfo.netAssetsSource === 'unavailable' && data.fundInfo.netAssets !== null
      || data.fundInfo.netAssetsSource === 'assets less liabilities' && !(data.fundInfo.totAssets !== null && data.fundInfo.totLiabs !== null
        && data.fundInfo.netAssets === data.fundInfo.totAssets - data.fundInfo.totLiabs)) return false;
    const root = filingRoot(data.cik, data.accession);
    if (typeof data.sourceUrl !== 'string' || !data.sourceUrl.startsWith(root)
      || !/^[\w][\w.-]{0,239}\.xml$/i.test(data.sourceUrl.slice(root.length)) || data.sourceUrl.slice(root.length).includes('..')
      || data.filingUrl !== `${root}${data.accession}-index.html`
      || data.secUrl !== `https://www.sec.gov/edgar/browse/?CIK=${data.identity === 'SEC series matched' ? data.seriesId : data.cik}&owner=exclude`
      || !['SEC series matched', 'SEC registrant matched'].includes(data.identity)
      || data.identity === 'SEC series matched' && !data.seriesId) return false;
    const ids = new Set();
    for (const row of data.holdings) {
      if (!Number.isSafeInteger(row?.id) || row.id < 1 || ids.has(row.id) || !text(row.name)
        || !['title', 'cusip', 'isin', 'tickerSymbol', 'units', 'payoffProfile'].every(key => optionalText(row[key]))
        || !['balance', 'value', 'pctOfNav'].every(key => numeric(row[key])) || !text(row.assetCat, 100) || !text(row.invCountry, 100)
        || !['reported', 'calculated', 'unavailable'].includes(row.weightSource)
        || row.weightSource === 'reported' && row.pctOfNav === null
        || row.weightSource === 'unavailable' && row.pctOfNav !== null
        || row.weightSource === 'calculated' && !(row.value !== null && data.fundInfo.netAssets > 0 && row.pctOfNav === row.value / data.fundInfo.netAssets * 100)) return false;
      ids.add(row.id);
    }
    if (!Array.isArray(data.reports) || !data.reports.length || data.reports.length > 21
      || data.reports.some(row => !ACCESSION.test(row?.accession || '') || !FORM.test(row.form || '') || !validFilingDate(row.filingDate)
        || row.reportDate !== null && !validFilingDate(row.reportDate))
      || !data.reports.some(row => row.accession === data.accession && row.reportDate === data.asOf && row.filingDate === data.filingDate && row.form === data.form)
      || !Array.isArray(data.filings) || data.filings.length > 12
      || data.filings.some(row => !ACCESSION.test(row?.accession || '') || !validFilingDate(row.filingDate)
        || !/^(N-|NPORT|485|497)/.test(row.form || '') || row.url !== `${filingRoot(data.cik, row.accession)}${row.accession}-index.html`)) return false;
    return hash(portfolioSummary(data)) === hash(data.summary) && Buffer.byteLength(JSON.stringify(data)) <= FUND_MAX_BYTES - 2048;
  } catch { return false; }
}

function validBody(value, ticker, accession, now) {
  return value?.schemaVersion === FUND_CACHE_VERSION && value.kind === 'filing' && sameIdentity(value, value.data || {})
    && iso(value.checkedAt) && Date.parse(value.checkedAt) <= now && Date.parse(value.checkedAt) >= Date.parse(value.data?.retrievedAt)
    && validPreparedFundData(value.data, ticker, accession, now);
}
function validHead(value, ticker, now, allowStale = false) {
  return value?.schemaVersion === FUND_CACHE_VERSION && value.kind === 'latest' && value.ticker === ticker && identity(value)
    && ACCESSION.test(value.accession || '') && /^[a-f0-9]{64}$/.test(value.bodyHash || '') && iso(value.checkedAt)
    && Date.parse(value.checkedAt) <= now && now - Date.parse(value.checkedAt) < (allowStale ? FUND_RETENTION_MS : FUND_FRESH_MS);
}

/** One complete accession body, one compact latest reference. No legacy chunks. */
export function createFundResearchCache({ enabled = disposableCacheEnabled, read = cacheGet, write = cachePut, now = Date.now,
  timeoutMs = 1500, maxLocalBytes = 32 * 1024 * 1024, maxLocalEntries = 48 } = {}) {
  const local = new Map(); let localBytes = 0;
  const options = signal => ({ signal, timeoutMs, deadline: now() + timeoutMs });
  function remove(id) { const old = local.get(id); if (old) { localBytes -= old.bytes; local.delete(id); } }
  function remember(id, payload, expiresAt) {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > maxLocalBytes) return;
    remove(id);
    while (local.size && (local.size >= maxLocalEntries || localBytes + bytes > maxLocalBytes)) remove(local.keys().next().value);
    local.set(id, { payload, expiresAt, bytes }); localBytes += bytes;
  }
  async function record(id, signal, { sharedOnly = false } = {}) {
    if (!sharedOnly) {
      const hit = local.get(id);
      if (hit && hit.expiresAt > now()) return { payload: hit.payload };
      remove(id);
    }
    if (!enabled() || signal?.aborted) return null;
    try { return await read(FUND_CACHE_TYPE, id, options(signal)); }
    catch {
      // An unavailable optional cache may reuse a recent local source check.
      // A successful shared miss deliberately does not take this path, and a
      // successfully read newer head always takes precedence over local data.
      const hit = local.get(id);
      return hit && hit.expiresAt > now() && now() - Date.parse(hit.payload?.checkedAt) < FUND_FRESH_MS
        ? { payload: hit.payload, unavailable: true } : { unavailable: true };
    }
  }
  async function readPrepared(tickerInput, accessionInput = '', { signal, allowStale = true } = {}) {
    if (signal?.aborted) return null;
    let ticker, accession;
    try { ({ ticker, accession } = normalizeFundRequest(tickerInput, accessionInput)); } catch { return null; }
    let head;
    if (!accession) {
      // Mutable heads can be replaced by another instance. A retained local
      // head must not hide that source check until its 30-day retention ends.
      head = (await record(`${ticker}:LATEST`, signal, { sharedOnly: enabled() }))?.payload;
      if (!validHead(head, ticker, now(), allowStale)) return null;
      accession = head.accession;
    }
    let body = (await record(`${ticker}:${accession}`, signal))?.payload;
    if (head && enabled() && (!body || !sameIdentity(head, body) || hash(body) !== head.bodyHash || head.checkedAt !== body.checkedAt)) {
      body = (await record(`${ticker}:${accession}`, signal, { sharedOnly: true }))?.payload;
    }
    if (signal?.aborted) return null;
    if (!validBody(body, ticker, accession, now()) || head && (!sameIdentity(head, body) || hash(body) !== head.bodyHash || head.checkedAt !== body.checkedAt)) return null;
    remember(`${ticker}:${accession}`, body, Date.parse(body.data.retrievedAt) + FUND_RETENTION_MS);
    if (head) remember(`${ticker}:LATEST`, head, Date.parse(head.checkedAt) + FUND_RETENTION_MS);
    const checkedAt = head?.checkedAt || body.checkedAt;
    return { ...body.data, cache: { checkedAt, freshUntil: new Date(Date.parse(checkedAt) + FUND_FRESH_MS).toISOString(),
      stale: !accessionInput && now() - Date.parse(checkedAt) >= FUND_FRESH_MS } };
  }
  async function publish(data, { latest = false, checkedAt = new Date(now()).toISOString(), signal } = {}) {
    if (!validPreparedFundData(data, data?.ticker, data?.accession, now()) || !iso(checkedAt)
      || Date.parse(checkedAt) > now() || Date.parse(checkedAt) < Date.parse(data.retrievedAt)) return false;
    const fields = Object.fromEntries(['ticker', 'cik', 'seriesId', 'classId', 'accession'].map(key => [key, data[key]]));
    const body = { schemaVersion: FUND_CACHE_VERSION, kind: 'filing', ...fields, checkedAt, data };
    const head = { schemaVersion: FUND_CACHE_VERSION, kind: 'latest', ...fields, checkedAt, bodyHash: hash(body) };
    const bodyId = `${data.ticker}:${data.accession}`, headId = `${data.ticker}:LATEST`;
    function retainLocally() {
      if ([local.get(bodyId)?.payload, ...(latest ? [local.get(headId)?.payload] : [])]
        .some(value => Date.parse(value?.checkedAt) > Date.parse(checkedAt))) return;
      remember(bodyId, body, Date.parse(data.retrievedAt) + FUND_RETENTION_MS);
      if (latest) remember(headId, head, Date.parse(checkedAt) + FUND_RETENTION_MS);
    }
    const localHead = local.get(headId)?.payload, localBody = local.get(bodyId)?.payload;
    if ([localBody, ...(latest ? [localHead] : [])].some(value => Date.parse(value?.checkedAt) > Date.parse(checkedAt))) return false;
    if (!enabled()) {
      retainLocally();
      return true;
    }
    if (signal?.aborted) return false;
    const [oldBody, oldHead] = await Promise.all([record(bodyId, signal, { sharedOnly: true }), latest ? record(headId, signal, { sharedOnly: true }) : null]);
    if ([oldBody, oldHead].some(row => Date.parse(row?.payload?.checkedAt) > Date.parse(checkedAt))) return false;
    try {
      const stored = await write(FUND_CACHE_TYPE, bodyId, body, Math.max(1, Math.floor((Date.parse(data.retrievedAt) + FUND_RETENTION_MS - now()) / 1000)),
        { ...options(signal), ifHash: oldBody?.rawSha256 || 'absent' });
      if (!stored?.stored) return false;
      remember(bodyId, body, Date.parse(data.retrievedAt) + FUND_RETENTION_MS);
      if (latest) {
        const saved = await write(FUND_CACHE_TYPE, headId, head, 30 * 86400,
          { ...options(signal), ifHash: oldHead?.rawSha256 || 'absent' });
        if (!saved?.stored) return false;
        remember(headId, head, Date.parse(checkedAt) + FUND_RETENTION_MS);
      }
      return true;
    } catch {
      // Preserve useful validated work through transport failures, without
      // treating compare-and-set rejection above as permission to replace it.
      retainLocally();
      return false;
    }
  }
  return { readPrepared, publish, memoryUsage: () => ({ bytes: localBytes, entries: local.size }) };
}

export const fundResearchCache = createFundResearchCache();
