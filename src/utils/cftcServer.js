import { CFTC_CALCULATION_VERSION, CFTC_FAMILIES, CFTC_HISTORY_WINDOWS, CFTC_LAUNCH_CATALOG, CFTC_REPORT_BASIS, CFTC_SCHEMA_VERSION, cftcCatalog, cftcDate, cftcGroup, cftcSeries, isCftcContractCode, isCftcFamily, normalizeCftcRows } from './cftc.js';
import { warmAcquireLease, warmCacheEnabled, warmGet, warmReleaseLease, warmSet } from './warmCache.js';

const deploymentScope = process.env.VERCEL_ENV === 'production'
  ? 'production'
  : process.env.VERCEL_ENV === 'preview'
    ? `preview-${String(process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 12)}`
    : 'local';
export const CFTC_CACHE_NAMESPACE = `edgar.cftc-positioning.v1:${deploymentScope}`;
export const CFTC_FRESH_MS = 6 * 3600_000;
export const CFTC_STALE_MAX_MS = 15 * 86400_000;
export const CFTC_SOURCE_CURRENT_MAX_DAYS = 14;
export const CFTC_RAW_HISTORY_SCHEMA_VERSION = 'edgar.cftc-raw-history.v1';
export const CFTC_LOAD_BUDGET_MS = 48_000;
export const CFTC_REFRESH_CHECKPOINT_VERSION = 'edgar.cftc-refresh-checkpoint.v1';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_DATASET_ROWS = 10_000;
const requestCache = new Map();

export class CftcError extends Error {
  constructor(message, { code = 'CFTC_SOURCE_UNAVAILABLE', status = 502, retryAfter = null, details = null } = {}) {
    super(message); this.name = 'CftcError'; this.code = code; this.status = status; this.retryAfter = retryAfter; this.details = details;
  }
}

export function parseCftcRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.ceil(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(60_000, date - now)) : null;
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new CftcError('The CFTC response exceeded the byte limit.', { code: 'CFTC_RESPONSE_TOO_LARGE' });
  if (!response.body) return response.json();
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new CftcError('The CFTC response exceeded the byte limit.', { code: 'CFTC_RESPONSE_TOO_LARGE' });
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (cause) { throw new CftcError('The CFTC response was not valid JSON.', { code: 'CFTC_RESPONSE_INVALID', details: cause.message }); }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('Cancelled')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('Cancelled')); }, { once: true });
  });
}

function abortError(signal, error = signal?.reason) {
  const reason = signal?.reason || error;
  const timedOut = reason?.name === 'TimeoutError';
  return new CftcError(timedOut ? 'The bounded CFTC source request timed out.' : 'The CFTC request was cancelled.', {
    code: timedOut ? 'CFTC_TIMEOUT' : 'CFTC_REQUEST_CANCELLED', status: timedOut ? 504 : 499,
  });
}

async function retryWait(ms, signal) {
  try { await wait(ms, signal); }
  catch (error) { throw abortError(signal, error); }
}

function deadlineSignal(signal, milliseconds = 20_000) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function boundedOperation(task, signal) {
  try { return await awaitShared(task, signal); }
  catch (error) {
    if (signal?.aborted && !(error instanceof CftcError)) throw abortError(signal, error);
    throw error;
  }
}

async function releaseLeaseBestEffort(id, lease) {
  if (!lease) return;
  try { await boundedOperation(warmReleaseLease(CFTC_CACHE_NAMESPACE, id, lease), deadlineSignal(undefined, 1500)); }
  catch { /* The lease has a bounded TTL; never mask the request result during cleanup. */ }
}

async function awaitShared(task, signal) {
  if (!signal) return task;
  if (signal.aborted) throw abortError(signal);
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([task, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export function cftcResourceUrl(familyId, query) {
  const family = CFTC_FAMILIES[familyId];
  if (!family) throw new CftcError('Unsupported CFTC report family.', { code: 'INVALID_REPORT_FAMILY', status: 400 });
  const url = new URL(family.sourceUrl);
  for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, String(value));
  return url.toString();
}

export async function fetchCftcResource(familyId, query, { signal, fetchImpl = fetch, retries = 1 } = {}) {
  const family = CFTC_FAMILIES[familyId];
  if (!family) throw new CftcError('Unsupported CFTC report family.', { code: 'INVALID_REPORT_FAMILY', status: 400 });
  const url = new URL(cftcResourceUrl(familyId, query));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const timeout = AbortSignal.timeout(10_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(url, { headers: { Accept: 'application/json', ...(process.env.CFTC_APP_TOKEN ? { 'X-App-Token': process.env.CFTC_APP_TOKEN } : {}) }, cache: 'no-store', signal: requestSignal });
      if (!response.ok) {
        const retryAfter = parseCftcRetryAfter(response.headers.get('retry-after'));
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) { await retryWait(Math.min(2000, retryAfter ?? Math.min(2000, 400 * 2 ** attempt)), signal); continue; }
        throw new CftcError(`The CFTC source returned HTTP ${response.status}.`, { code: response.status === 429 ? 'CFTC_RATE_LIMITED' : 'CFTC_SOURCE_HTTP_ERROR', status: 502, retryAfter });
      }
      const value = await boundedJson(response);
      if (!Array.isArray(value)) throw new CftcError('The CFTC source returned an unexpected response.', { code: 'CFTC_RESPONSE_INVALID' });
      if (value.length > MAX_DATASET_ROWS) throw new CftcError('The CFTC row limit was exceeded.', { code: 'CFTC_RESPONSE_TOO_LARGE' });
      return { rows: value, sourceUrl: url.toString() };
    } catch (error) {
      if (error instanceof CftcError) throw error;
      if (signal?.aborted) throw abortError(signal, error);
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (timedOut) {
        if (attempt < retries) { await retryWait(Math.min(2000, 400 * 2 ** attempt), signal); continue; }
        throw new CftcError('The bounded CFTC source request timed out.', { code: 'CFTC_TIMEOUT', status: 504 });
      }
      lastError = error;
      if (attempt < retries) { await retryWait(Math.min(2000, 400 * 2 ** attempt), signal); continue; }
    }
  }
  throw new CftcError('The CFTC source could not be reached.', { details: lastError?.message || null });
}

export async function discoverLatestCftcDate(family, options = {}) {
  const config = CFTC_FAMILIES[family];
  if (!config) throw new CftcError('Unsupported CFTC report family.', { code: 'INVALID_REPORT_FAMILY', status: 400 });
  const { now = new Date(), ...requestOptions } = options;
  const { rows, sourceUrl } = await fetchCftcResource(family, { '$select': config.fields.join(','), '$where': `futonly_or_combined=${quoteSoql('FutOnly')}`, '$order': 'report_date_as_yyyy_mm_dd DESC,cftc_contract_market_code ASC,cftc_market_code ASC,contract_units ASC,id ASC', '$limit': 25 }, requestOptions);
  const normalized = normalizeCftcRows(rows, family).rows;
  const today = new Date(now).toISOString().slice(0, 10);
  const date = normalized.map(row => row.reportDate).filter(value => value <= today).sort().at(-1) || null;
  if (!date) throw new CftcError('The latest CFTC report date could not be verified.', { code: 'CFTC_REPORT_DATE_UNAVAILABLE' });
  return { date, sourceUrl };
}

function quoteSoql(value) { return `'${String(value).replaceAll("'", "''")}'`; }

export async function fetchCftcLatestRows(family, reportDate, options = {}) {
  if (!isCftcFamily(family) || !cftcDate(reportDate)) throw new CftcError('Invalid CFTC latest-row request.', { code: 'INVALID_CFTC_REQUEST', status: 400 });
  const config = CFTC_FAMILIES[family], rows = []; let offset = 0, pages = 0;
  const query = {
    '$select': config.fields.join(','), '$where': `report_date_as_yyyy_mm_dd=${quoteSoql(`${reportDate}T00:00:00.000`)}`,
    '$order': 'cftc_contract_market_code ASC,cftc_market_code ASC,contract_units ASC,id ASC', '$limit': 500, '$offset': 0,
  };
  const sourceUrl = cftcResourceUrl(family, query);
  do {
    const result = await fetchCftcResource(family, { ...query, '$offset': offset }, options);
    pages += 1; rows.push(...result.rows);
    if (result.rows.length < 500) break;
    offset += result.rows.length;
    if (rows.length >= 1000) throw new CftcError('The latest CFTC catalog exceeded its bounded row limit.', { code: 'CFTC_PAGINATION_LIMIT' });
  } while (true);
  return { rows, sourceUrl, pages };
}

function subtractCalendarDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() - days); return value.toISOString().slice(0, 10);
}

export async function fetchCftcLaunchHistory(family, throughDate, options = {}) {
  const config = CFTC_FAMILIES[family];
  const codes = CFTC_LAUNCH_CATALOG.filter(item => item.family === family).map(item => item.code);
  const from = subtractCalendarDays(throughDate, 6 * 366);
  const where = `cftc_contract_market_code in(${codes.map(quoteSoql).join(',')}) AND report_date_as_yyyy_mm_dd between ${quoteSoql(`${from}T00:00:00.000`)} and ${quoteSoql(`${throughDate}T23:59:59.999`)}`;
  const rows = []; let offset = 0, pages = 0;
  const query = { '$select': config.fields.join(','), '$where': where, '$order': 'cftc_contract_market_code ASC,report_date_as_yyyy_mm_dd DESC,cftc_market_code ASC,contract_units ASC,id ASC', '$limit': 1000, '$offset': 0 };
  const sourceUrl = cftcResourceUrl(family, query);
  do {
    const result = await fetchCftcResource(family, { ...query, '$offset': offset }, options);
    pages += 1; rows.push(...result.rows);
    if (result.rows.length < 1000) break;
    offset += result.rows.length;
    if (rows.length >= 5000) throw new CftcError('The launch-market history exceeded its bounded row limit.', { code: 'CFTC_PAGINATION_LIMIT' });
  } while (true);
  return { rows, sourceUrl, pages };
}

function sourceDetails(family, url, historyUrl = null) {
  const config = CFTC_FAMILIES[family];
  return { agency: 'U.S. Commodity Futures Trading Commission', dataset_id: config.datasetId, report_family: config.label, report_basis: CFTC_REPORT_BASIS, url, history_url: historyUrl, documentation: config.documentationUrl };
}

function sourceReportAgeDays(reportDate, now = new Date()) {
  return Math.max(0, Math.floor((Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`) - Date.parse(`${reportDate}T00:00:00.000Z`)) / 86400000));
}

function freshness(reportDate, retrievedAt, cacheStatus, now = new Date()) {
  const age = sourceReportAgeDays(reportDate, now);
  return { report_date: reportDate, retrieved_at: retrievedAt, cache_status: cacheStatus, source_report_age_days: age, source_currency: age <= CFTC_SOURCE_CURRENT_MAX_DAYS ? 'current' : 'aged', source_currency_max_days: CFTC_SOURCE_CURRENT_MAX_DAYS, publication_time_verified: false };
}

function warnings(...values) {
  return [...new Set(values.flatMap(value => String(value || '').split(' | ')).map(value => value.trim()).filter(Boolean))].join(' | ');
}

export function cftcPublicationStatus(response, {
  cacheRequired = false,
  primaryPersisted = null,
  lastGoodPersisted = null,
  rawHistoryExpected = response?.cache_publication?.raw_history_expected || 0,
  rawHistoryPersisted = response?.cache_publication?.raw_history_persisted || 0,
} = {}) {
  const publication = {
    cache_required: Boolean(cacheRequired),
    primary_persisted: typeof primaryPersisted === 'boolean' ? primaryPersisted : null,
    last_good_persisted: typeof lastGoodPersisted === 'boolean' ? lastGoodPersisted : null,
    raw_history_expected: Math.max(0, Number(rawHistoryExpected) || 0),
    raw_history_persisted: Math.max(0, Number(rawHistoryPersisted) || 0),
    durable: primaryPersisted === true && lastGoodPersisted !== false && Number(rawHistoryPersisted) >= Number(rawHistoryExpected),
  };
  const publicationFailed = publication.cache_required && (
    publication.primary_persisted === false
    || publication.last_good_persisted === false
    || publication.raw_history_persisted < publication.raw_history_expected
  );
  if (!publicationFailed) return { ...response, cache_publication: publication };
  const failed = [
    publication.primary_persisted === false ? 'primary snapshot' : null,
    publication.last_good_persisted === false ? 'last-good snapshot' : null,
    publication.raw_history_persisted < publication.raw_history_expected ? `${publication.raw_history_expected - publication.raw_history_persisted} raw histor${publication.raw_history_expected - publication.raw_history_persisted === 1 ? 'y' : 'ies'}` : null,
  ].filter(Boolean).join(', ');
  return {
    ...response,
    status: 'partial',
    refresh_warning: warnings(response?.refresh_warning, `The official CFTC data was computed, but durable cache publication was incomplete (${failed}).`),
    cache_publication: publication,
  };
}

export function presentCftcResponse(response, { savedAt = response?.retrieved_at, cacheStatus = 'computed', now = new Date(), requireCurrent = false, forceStale = false, warning = '' } = {}) {
  const reportDate = response?.report_date || response?.selected?.reportDate;
  const nowMs = new Date(now).getTime(), savedMs = Date.parse(savedAt);
  const age = Number.isFinite(savedMs) ? nowMs - savedMs : Infinity;
  const nextFreshness = freshness(reportDate, response?.retrieved_at, cacheStatus, new Date(nowMs));
  const staleCache = age >= CFTC_FRESH_MS;
  const agedSource = requireCurrent && nextFreshness.source_currency === 'aged';
  const status = response?.status === 'partial' ? 'partial' : forceStale || staleCache || agedSource || response?.status === 'stale' ? 'stale' : 'ready';
  const refreshWarning = warnings(
    response?.refresh_warning,
    warning,
    staleCache ? 'The prepared CFTC snapshot is older than six hours.' : '',
    agedSource ? `The latest validated CFTC report is ${nextFreshness.source_report_age_days} days old; the current-data threshold is ${CFTC_SOURCE_CURRENT_MAX_DAYS} days.` : '',
  );
  const durableCache = ['prepared', 'prepared-after-wait', 'stale-last-good'].includes(cacheStatus);
  const presented = { ...response, status, ...(refreshWarning ? { refresh_warning: refreshWarning } : {}), freshness: nextFreshness };
  return cftcPublicationStatus(presented, {
    cacheRequired: durableCache || response?.cache_publication?.cache_required,
    primaryPersisted: durableCache ? true : response?.cache_publication?.primary_persisted,
    lastGoodPersisted: response?.cache_publication?.last_good_persisted,
    rawHistoryExpected: response?.cache_publication?.raw_history_expected,
    rawHistoryPersisted: response?.cache_publication?.raw_history_persisted,
  });
}

export function buildCftcMarketsSnapshot({ family, reportDate, latestRaw, historyRaw, retrievedAt = new Date().toISOString(), sourceUrl = CFTC_FAMILIES[family]?.sourceUrl, historySourceUrl = null, historyError = null, cacheStatus = 'computed' }) {
  const latestNormalized = normalizeCftcRows(latestRaw, family), historyNormalized = normalizeCftcRows(historyRaw, family);
  const latestRows = latestNormalized.rows.filter(row => row.reportDate === reportDate);
  const historyByCode = new Map();
  for (const row of historyNormalized.rows) { const list = historyByCode.get(row.code) || []; list.push(row); historyByCode.set(row.code, list); }
  const catalog = cftcCatalog(latestRows, family);
  const expectedLaunch = CFTC_LAUNCH_CATALOG.filter(item => item.family === family);
  const latest = expectedLaunch.flatMap(item => {
    const current = latestRows.find(row => row.code === item.code);
    if (!current) return [];
    const groups = Object.fromEntries(CFTC_FAMILIES[family].groups.map(definition => {
      const series = cftcSeries(historyByCode.get(item.code) || [current], definition.id, reportDate, 260);
      return [definition.id, { ...current.groups[definition.id], oneWeekChange: series.selected?.oneWeekChange ?? null, oneWeekNetPctChange: series.selected?.oneWeekNetPctChange ?? null, fourWeekChange: series.selected?.fourWeekChange ?? null, percentile: series.percentile, shorterPercentiles: series.shorterPercentiles, historyRange: series.historyRange }];
    }));
    return [{ ...current, launchLabel: item.label, groups }];
  });
  const reconciliationIssues = latestRows.filter(row => row.reconciliation.status === 'mismatch').map(row => ({ identity: row.identity, code: row.code, longDifference: row.reconciliation.longDifference, shortDifference: row.reconciliation.shortDifference }));
  const launchReconciliationIssues = reconciliationIssues.filter(issue => expectedLaunch.some(item => item.code === issue.code));
  const requiredUnavailable = latest.filter(row => row.openInterest == null || row.venueCode == null || row.units == null || CFTC_FAMILIES[family].groups.some(group => row.groups[group.id]?.long == null || row.groups[group.id]?.short == null || (group.spread && row.groups[group.id]?.spreading == null))).map(row => row.code);
  const quarantine = [...latestNormalized.quarantine, ...historyNormalized.quarantine];
  const missingLaunch = expectedLaunch.filter(item => !latestRows.some(row => row.code === item.code)).map(item => item.code);
  return { schema_version: CFTC_SCHEMA_VERSION, calculation_version: CFTC_CALCULATION_VERSION, report_family: family, report_basis: CFTC_REPORT_BASIS, report_date: reportDate, retrieved_at: retrievedAt,
    status: quarantine.length || missingLaunch.length || launchReconciliationIssues.length || requiredUnavailable.length || historyError ? 'partial' : 'ready',
    ...(historyError ? { refresh_warning: `Current positions are available, but launch-market history is incomplete: ${historyError}` } : {}),
    freshness: freshness(reportDate, retrievedAt, cacheStatus), source: sourceDetails(family, sourceUrl, historySourceUrl), groups: CFTC_FAMILIES[family].groups.map(({ id, label }) => ({ id, label })),
    catalog, launch_codes: expectedLaunch.map(item => item.code), latest, coverage: { catalog_rows: catalog.length, launch_expected: expectedLaunch.length, launch_available: latest.length, missing_launch_codes: missingLaunch, required_values_unavailable: requiredUnavailable, quarantined_rows: quarantine.length, reconciliation_differences: reconciliationIssues.length, launch_reconciliation_differences: launchReconciliationIssues.length }, quarantine, diagnostics: { reconciliation_differences: reconciliationIssues },
    methodology: { net_contracts: 'reported long contracts - reported short contracts', net_percent_open_interest: '100 * net contracts / open interest', percentile: '100 * (prior values below current + 0.5 * prior values equal to current) / n; same contract, family and trader group; selected and later observations excluded', weekly_change: 'Current net contracts minus the compatible observation exactly seven calendar days earlier; unavailable when absent.', four_week_change: 'Current net contracts minus the compatible observation exactly 28 calendar days earlier; unavailable when absent.', previous_available_change: 'Current net contracts minus the immediately preceding compatible report, with its elapsed calendar days disclosed separately.' },
  };
}

function cacheAge(envelope, now = Date.now()) { return new Date(now).getTime() - Date.parse(envelope?.savedAt); }

function officialSourceMatches(response, family) {
  const config = CFTC_FAMILIES[family], source = response?.source;
  if (!config || source?.dataset_id !== config.datasetId || source?.report_family !== config.label || source?.report_basis !== CFTC_REPORT_BASIS) return false;
  try {
    const url = new URL(source.url);
    return url.protocol === 'https:' && url.hostname === 'publicreporting.cftc.gov' && url.pathname === `/resource/${config.datasetId}.json`;
  } catch { return false; }
}

function validMarketsResponse(response, family, nowMs) {
  const groupIds = CFTC_FAMILIES[family]?.groups.map(group => group.id) || [];
  return response?.schema_version === CFTC_SCHEMA_VERSION
    && response?.calculation_version === CFTC_CALCULATION_VERSION
    && response?.report_family === family && response?.report_basis === CFTC_REPORT_BASIS
    && cftcDate(response?.report_date) === response.report_date
    && response.report_date <= new Date(nowMs).toISOString().slice(0, 10)
    && Number.isFinite(Date.parse(response?.retrieved_at)) && Date.parse(response.retrieved_at) <= nowMs
    && ['ready', 'partial', 'stale'].includes(response?.status)
    && officialSourceMatches(response, family)
    && Array.isArray(response?.groups) && response.groups.length === groupIds.length
    && groupIds.every(id => response.groups.some(group => group?.id === id))
    && Array.isArray(response?.catalog) && response.catalog.length > 0 && response.catalog.every(item => item?.family === family && cftcDate(item?.reportDate) === response.report_date)
    && Array.isArray(response?.latest) && response.latest.every(item => item?.family === family && item?.reportBasis === CFTC_REPORT_BASIS && item?.reportDate === response.report_date)
    && response?.coverage && Number.isSafeInteger(response.coverage.catalog_rows);
}

function validHistoryResponse(response, family, code, group, throughDate, window, nowMs) {
  return response?.schema_version === CFTC_SCHEMA_VERSION
    && response?.calculation_version === CFTC_CALCULATION_VERSION
    && response?.report_family === family && response?.report_basis === CFTC_REPORT_BASIS
    && Number.isFinite(Date.parse(response?.retrieved_at)) && Date.parse(response.retrieved_at) <= nowMs
    && ['ready', 'partial', 'stale'].includes(response?.status)
    && officialSourceMatches(response, family)
    && response?.selection?.contract === code && response.selection.group === group && response.selection.report_date === throughDate && response.selection.history_window === window && response.selection.required_prior_reports === CFTC_HISTORY_WINDOWS[window]
    && response?.selected?.family === family && response.selected.code === code && response.selected.reportDate === throughDate && response.selected.selectedGroup?.id === group
    && Array.isArray(response?.history) && Array.isArray(response?.participants)
    && response.history.every(point => cftcDate(point?.reportDate) && point.reportDate <= throughDate);
}

function validStatusEnvelope(envelope, family, nowMs) {
  const savedAt = Date.parse(envelope?.savedAt);
  return Number.isFinite(savedAt) && savedAt <= nowMs
    && validMarketsResponse(envelope?.response, family, nowMs);
}

/** Cache-only service status. This never invokes an upstream CFTC request. */
export async function readCftcCacheStatus({ now = new Date(), get = warmGet, enabled = warmCacheEnabled } = {}) {
  const nowMs = new Date(now).getTime();
  if (!enabled()) return { schema_version: CFTC_SCHEMA_VERSION, status: 'disabled', checked_at: new Date(nowMs).toISOString(), families: [] };
  const ids = ['tff', 'disaggregated'].flatMap(family => [`markets:${family}:latest`, `markets-last-good:${family}:latest`]);
  const values = await Promise.all(ids.map(id => get(CFTC_CACHE_NAMESPACE, id)));
  const families = ['tff', 'disaggregated'].map((family, index) => {
    const candidates = values.slice(index * 2, index * 2 + 2);
    const valid = candidates.map((envelope, candidateIndex) => ({ envelope, source: candidateIndex ? 'last-good' : 'primary' }))
      .filter(item => validStatusEnvelope(item.envelope, family, nowMs) && cacheAge(item.envelope, nowMs) < CFTC_STALE_MAX_MS)
      .sort((a, b) => b.envelope.response.report_date.localeCompare(a.envelope.response.report_date) || Date.parse(b.envelope.savedAt) - Date.parse(a.envelope.savedAt) || (a.source === 'primary' ? -1 : 1))[0];
    if (!valid) {
      const any = candidates.find(Boolean);
      const timestamp = Date.parse(any?.savedAt);
      const anyValid = candidates.find(envelope => validStatusEnvelope(envelope, family, nowMs));
      return { family, status: anyValid || Number.isFinite(timestamp) && timestamp <= nowMs && nowMs - timestamp >= CFTC_STALE_MAX_MS ? 'expired' : any ? 'invalid' : 'missing', report_date: null, retrieved_at: null, cache_age_seconds: null, source_report_age_days: null, source_currency: null, cache_source: null };
    }
    const response = valid.envelope.response;
    const age = nowMs - Date.parse(valid.envelope.savedAt), sourceAge = sourceReportAgeDays(response.report_date, new Date(nowMs));
    const status = response.status === 'partial' ? 'partial' : response.status === 'stale' || age >= CFTC_FRESH_MS || sourceAge > CFTC_SOURCE_CURRENT_MAX_DAYS ? 'stale' : 'ready';
    return { family, status, report_date: response.report_date, retrieved_at: response.retrieved_at, cache_age_seconds: Math.floor(age / 1000), source_report_age_days: sourceAge, source_currency: sourceAge <= CFTC_SOURCE_CURRENT_MAX_DAYS ? 'current' : 'aged', cache_source: valid.source };
  });
  const usable = families.filter(item => ['ready', 'partial', 'stale'].includes(item.status));
  const status = families.every(item => item.status === 'ready') ? 'ready' : usable.length ? 'degraded' : 'unavailable';
  return { schema_version: CFTC_SCHEMA_VERSION, status, checked_at: new Date(nowMs).toISOString(), families };
}

function contractHistoryQuery(family, code, throughDate, offset = 0) {
  const config = CFTC_FAMILIES[family];
  return {
    '$select': config.fields.join(','),
    '$where': `cftc_contract_market_code=${quoteSoql(code)} AND report_date_as_yyyy_mm_dd<=${quoteSoql(`${throughDate}T23:59:59.999`)}`,
    '$order': 'report_date_as_yyyy_mm_dd DESC,cftc_market_code ASC,contract_units ASC,id ASC', '$limit': 200, '$offset': offset,
  };
}

function rawHistoryEnvelope({ family, code, throughDate, rows, sourceUrl, pages, retrievedAt, capReached = false, sourceExhausted = false, savedAt = new Date().toISOString() }) {
  return { schema_version: CFTC_RAW_HISTORY_SCHEMA_VERSION, family, report_basis: CFTC_REPORT_BASIS, code, through_date: throughDate, savedAt, retrievedAt, sourceUrl, pages, capReached, sourceExhausted, rows };
}

function rawHistoryCoverage(rows, family, code, throughDate, count, group = null) {
  const normalized = normalizeCftcRows(rows, family);
  const selected = normalized.rows.find(row => row.code === code && row.reportDate === throughDate);
  if (!selected?.venueCode || !selected?.units) return { normalized, selected, compatible: [], sufficient: false };
  const compatible = normalized.rows.filter(row => row.code === code && row.reportDate <= throughDate && row.venueCode === selected.venueCode && row.units === selected.units);
  const groups = group ? [group] : CFTC_FAMILIES[family].groups.map(item => item.id);
  const sufficient = groups.every(groupId => compatible.filter(row => row.reportDate < throughDate && Number.isFinite(row.groups[groupId]?.netPctOi)).length >= count);
  return { normalized, selected, compatible, sufficient };
}

export function validateRawHistoryEnvelope(envelope, { family, code, throughDate, count, group = null, now = new Date() }) {
  const nowMs = new Date(now).getTime(), savedAt = Date.parse(envelope?.savedAt), retrievedAt = Date.parse(envelope?.retrievedAt);
  if (envelope?.schema_version !== CFTC_RAW_HISTORY_SCHEMA_VERSION || envelope?.family !== family || envelope?.report_basis !== CFTC_REPORT_BASIS || envelope?.code !== code || envelope?.through_date !== throughDate) return false;
  if (!Number.isFinite(savedAt) || !Number.isFinite(retrievedAt) || savedAt > nowMs || retrievedAt > nowMs || nowMs - savedAt >= CFTC_STALE_MAX_MS) return false;
  if (!Array.isArray(envelope.rows) || envelope.rows.length > 600 || !Number.isSafeInteger(envelope.pages) || envelope.pages < 1 || typeof envelope.capReached !== 'boolean' || typeof envelope.sourceExhausted !== 'boolean') return false;
  if (envelope.capReached && envelope.rows.length < 600) return false;
  try {
    const url = new URL(envelope.sourceUrl), config = CFTC_FAMILIES[family];
    if (url.protocol !== 'https:' || url.hostname !== 'publicreporting.cftc.gov' || url.pathname !== `/resource/${config.datasetId}.json` || url.searchParams.get('$offset') !== '0') return false;
    const where = url.searchParams.get('$where') || '';
    if (!where.includes(code) || !where.includes(throughDate)) return false;
  } catch { return false; }
  if (group && !cftcGroup(family, group)) return false;
  const { normalized, selected, sufficient } = rawHistoryCoverage(envelope.rows, family, code, throughDate, count, group);
  if (normalized.rows.some(row => row.code !== code || row.family !== family || row.reportBasis !== CFTC_REPORT_BASIS || row.reportDate > throughDate)) return false;
  if (!selected) return envelope.sourceExhausted;
  return sufficient || envelope.sourceExhausted || envelope.capReached;
}

async function computeMarkets(family, { reportDate = 'latest', signal, fetchImpl } = {}) {
  const latest = reportDate === 'latest' ? await discoverLatestCftcDate(family, { signal, fetchImpl }) : { date: reportDate, sourceUrl: CFTC_FAMILIES[family].sourceUrl };
  const latestRows = await fetchCftcLatestRows(family, latest.date, { signal, fetchImpl });
  if (!normalizeCftcRows(latestRows.rows, family).rows.some(row => row.reportDate === latest.date)) throw new CftcError('No validated CFTC report exists for that date.', { code: 'CFTC_REPORT_DATE_UNAVAILABLE', status: 404 });
  let historyRows = { rows: [], sourceUrl: null, pages: 0 }, historyError = null;
  try { historyRows = await fetchCftcLaunchHistory(family, latest.date, { signal, fetchImpl }); }
  catch (error) { historyError = error; }
  const cacheRequired = warmCacheEnabled();
  let rawHistoryExpected = 0, rawHistoryPersisted = 0;
  if (!historyError) {
    const byCode = new Map(), retrievedAt = new Date().toISOString();
    for (const row of historyRows.rows) { const code = String(row.cftc_contract_market_code || '').trim().toUpperCase(); const list = byCode.get(code) || []; list.push(row); byCode.set(code, list); }
    rawHistoryExpected = byCode.size;
    if (cacheRequired && rawHistoryExpected) {
      try {
        const stored = await boundedOperation(Promise.all([...byCode].map(([code, rows]) => warmSet(CFTC_CACHE_NAMESPACE, `raw-history:${family}:${code}:${latest.date}`, { ...rawHistoryEnvelope({ family, code, throughDate: latest.date, rows, sourceUrl: historyRows.sourceUrl, pages: historyRows.pages, retrievedAt, sourceExhausted: false, savedAt: retrievedAt }), origin_scope: 'launch_selection' }, 16 * 86400))), signal);
        rawHistoryPersisted = stored.filter(Boolean).length;
      } catch { rawHistoryPersisted = 0; }
    }
  }
  const snapshot = cftcPublicationStatus(buildCftcMarketsSnapshot({ family, reportDate: latest.date, latestRaw: latestRows.rows, historyRaw: historyRows.rows, sourceUrl: latestRows.sourceUrl, historySourceUrl: historyRows.sourceUrl, historyError: historyError?.message || null }), { cacheRequired, rawHistoryExpected, rawHistoryPersisted });
  if (!snapshot.catalog.length) throw new CftcError('No validated CFTC report exists for that date.', { code: 'CFTC_REPORT_DATE_UNAVAILABLE', status: 404 });
  return snapshot;
}

async function publishPreparedResponse({ cacheId, lastGoodId, response, savedAt, signal, allowLastGood }) {
  const cacheRequired = warmCacheEnabled();
  if (!cacheRequired) return cftcPublicationStatus(response, {
    cacheRequired: false,
    rawHistoryExpected: response?.cache_publication?.raw_history_expected,
    rawHistoryPersisted: response?.cache_publication?.raw_history_persisted,
  });
  const cacheValue = { savedAt, response };
  let primaryPersisted = false, lastGoodPersisted = null;
  try {
    const writes = [warmSet(CFTC_CACHE_NAMESPACE, cacheId, cacheValue, 9 * 86400)];
    if (allowLastGood) writes.push(warmSet(CFTC_CACHE_NAMESPACE, lastGoodId, cacheValue, 16 * 86400));
    const results = await boundedOperation(Promise.all(writes), signal);
    primaryPersisted = results[0] === true;
    if (allowLastGood) lastGoodPersisted = results[1] === true;
  } catch {
    primaryPersisted = false;
    if (allowLastGood) lastGoodPersisted = false;
  }
  return cftcPublicationStatus(response, {
    cacheRequired,
    primaryPersisted,
    lastGoodPersisted,
    rawHistoryExpected: response?.cache_publication?.raw_history_expected,
    rawHistoryPersisted: response?.cache_publication?.raw_history_persisted,
  });
}

export async function loadCftcMarkets({ family = 'tff', reportDate = 'latest', signal, forceRefresh = false, fetchImpl, internalSignal = null, deadlineMs = CFTC_LOAD_BUDGET_MS } = {}) {
  if (!isCftcFamily(family)) throw new CftcError('Use family=tff or family=disaggregated.', { code: 'INVALID_REPORT_FAMILY', status: 400 });
  if (reportDate !== 'latest' && !cftcDate(reportDate)) throw new CftcError('Use date=latest or a valid YYYY-MM-DD date.', { code: 'INVALID_REPORT_DATE', status: 400 });
  if (reportDate !== 'latest' && reportDate > new Date().toISOString().slice(0, 10)) throw new CftcError('A future CFTC report date cannot be requested.', { code: 'INVALID_REPORT_DATE', status: 400 });
  const operationSignal = internalSignal || deadlineSignal(undefined, deadlineMs);
  const callerWaitSignal = signal ? AbortSignal.any([signal, operationSignal]) : operationSignal;
  const cacheId = `markets:${family}:${reportDate}`, cached = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, cacheId), callerWaitSignal), nowMs = Date.now();
  const cachedValid = validStatusEnvelope(cached, family, nowMs);
  const age = cacheAge(cached, nowMs);
  if (!forceRefresh && cachedValid && age >= 0 && age < CFTC_FRESH_MS) return presentCftcResponse(cached.response, { savedAt: cached.savedAt, cacheStatus: 'prepared', now: new Date(nowMs), requireCurrent: reportDate === 'latest' });
  const inflightKey = `${family}:${reportDate}`;
  if (requestCache.has(inflightKey)) return awaitShared(requestCache.get(inflightKey), callerWaitSignal);
  const task = (async () => {
    let lease = null;
    try {
      if (warmCacheEnabled()) {
        lease = await boundedOperation(warmAcquireLease(CFTC_CACHE_NAMESPACE, `load:${cacheId}`, 90_000), operationSignal);
        if (!lease) {
          const prepared = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, cacheId), operationSignal);
          if (validStatusEnvelope(prepared, family, Date.now()) && cacheAge(prepared) < CFTC_STALE_MAX_MS) return presentCftcResponse(prepared.response, { savedAt: prepared.savedAt, cacheStatus: 'prepared-after-wait', requireCurrent: reportDate === 'latest' });
          const lastGood = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, `markets-last-good:${family}:${reportDate}`), operationSignal);
          if (validStatusEnvelope(lastGood, family, Date.now()) && cacheAge(lastGood) < CFTC_STALE_MAX_MS) return presentCftcResponse(lastGood.response, { savedAt: lastGood.savedAt, cacheStatus: 'stale-last-good', requireCurrent: reportDate === 'latest', forceStale: true, warning: 'Another bounded CFTC refresh is in progress.' });
          throw new CftcError('A prepared CFTC snapshot is not ready yet.', { code: 'CFTC_REFRESH_IN_PROGRESS', status: 503, retryAfter: 3000 });
        }
      }
      const response = await computeMarkets(family, { reportDate, signal: operationSignal, fetchImpl });
      if (reportDate === 'latest') {
        const lastGood = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, `markets-last-good:${family}:${reportDate}`), operationSignal);
        const priors = [cached, lastGood].filter(envelope => validStatusEnvelope(envelope, family, Date.now()) && cacheAge(envelope) < CFTC_STALE_MAX_MS).sort((a, b) => b.response.report_date.localeCompare(a.response.report_date));
        if (priors[0]?.response?.report_date > response.report_date) return presentCftcResponse(priors[0].response, { savedAt: priors[0].savedAt, cacheStatus: 'stale-last-good', requireCurrent: true, forceStale: true, warning: `The upstream latest-date check regressed from ${priors[0].response.report_date} to ${response.report_date}; the newer validated snapshot was preserved.` });
      }
      const savedAt = new Date().toISOString();
      const preparedResponse = presentCftcResponse(response, { savedAt, cacheStatus: 'computed', requireCurrent: reportDate === 'latest' });
      const allowLastGood = preparedResponse.status === 'ready' && (reportDate !== 'latest' || preparedResponse.freshness.source_currency === 'current');
      return publishPreparedResponse({ cacheId, lastGoodId: `markets-last-good:${family}:${reportDate}`, response: preparedResponse, savedAt, signal: operationSignal, allowLastGood });
    } catch (error) {
      if (error?.code === 'CFTC_REQUEST_CANCELLED') throw error;
      const lastGood = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, `markets-last-good:${family}:${reportDate}`), deadlineSignal(undefined, 3500));
      const candidates = [cached, lastGood].filter(envelope => validStatusEnvelope(envelope, family, Date.now()) && cacheAge(envelope) >= 0 && cacheAge(envelope) < CFTC_STALE_MAX_MS).sort((a, b) => b.response.report_date.localeCompare(a.response.report_date));
      const selected = candidates.find(envelope => reportDate === 'latest' || envelope.response.report_date === reportDate);
      if (selected) return presentCftcResponse(selected.response, { savedAt: selected.savedAt, cacheStatus: 'stale-last-good', requireCurrent: reportDate === 'latest', forceStale: true, warning: error.message });
      throw error;
    } finally {
      await releaseLeaseBestEffort(`load:${cacheId}`, lease);
    }
  })();
  requestCache.set(inflightKey, task);
  task.finally(() => requestCache.delete(inflightKey)).catch(() => {});
  return awaitShared(task, callerWaitSignal);
}

export async function fetchCftcContractHistory(family, code, throughDate, count, options = {}) {
  if (!isCftcFamily(family) || !isCftcContractCode(code) || !cftcDate(throughDate) || ![52, 156, 260, 520].includes(count)) throw new CftcError('Invalid bounded CFTC history request.', { code: 'INVALID_CFTC_REQUEST', status: 400 });
  const { group = null, signal, ...requestOptions } = options;
  if (group && !cftcGroup(family, group)) throw new CftcError('Invalid CFTC history participant group.', { code: 'INVALID_TRADER_GROUP', status: 400 });
  const prepared = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, `raw-history:${family}:${code}:${throughDate}`), signal);
  if (validateRawHistoryEnvelope(prepared, { family, code, throughDate, count, group, now: new Date() })) return { rows: prepared.rows, sourceUrl: prepared.sourceUrl, pages: prepared.pages, retrievedAt: prepared.retrievedAt, cacheStatus: 'prepared', capReached: prepared.capReached, sourceExhausted: prepared.sourceExhausted, cachePersisted: true };
  const rows = []; let offset = 0, pages = 0, sourceExhausted = false;
  const sourceUrl = cftcResourceUrl(family, contractHistoryQuery(family, code, throughDate));
  const retrievedAt = new Date().toISOString();
  do {
    const result = await fetchCftcResource(family, contractHistoryQuery(family, code, throughDate, offset), { ...requestOptions, signal });
    pages += 1; rows.push(...result.rows);
    const { normalized, selected, sufficient } = rawHistoryCoverage(rows, family, code, throughDate, count, group);
    if (!selected && normalized.rows[0]?.reportDate < throughDate) { sourceExhausted = true; break; }
    if (sufficient || result.rows.length < 200) { sourceExhausted = result.rows.length < 200; break; }
    offset += result.rows.length;
    if (rows.length >= 600) break;
  } while (true);
  const { sufficient } = rawHistoryCoverage(rows, family, code, throughDate, count, group);
  const capReached = rows.length >= 600 && !sufficient;
  const envelope = rawHistoryEnvelope({ family, code, throughDate, rows, sourceUrl, pages, retrievedAt, capReached, sourceExhausted });
  const cachePersisted = !warmCacheEnabled() ? null : await boundedOperation(warmSet(CFTC_CACHE_NAMESPACE, `raw-history:${family}:${code}:${throughDate}`, envelope, 16 * 86400), signal).catch(() => false);
  return { rows, sourceUrl, pages, retrievedAt, cacheStatus: 'computed', capReached, sourceExhausted, cachePersisted };
}

export function buildCftcHistoryResponse({ family, code, group, throughDate, window, rawRows, retrievedAt = new Date().toISOString(), sourceUrl = CFTC_FAMILIES[family]?.sourceUrl, cacheStatus = 'computed', retrieval = null }) {
  const normalized = normalizeCftcRows(rawRows, family), rows = normalized.rows.filter(row => row.code === code && row.reportDate <= throughDate);
  const count = CFTC_HISTORY_WINDOWS[window], result = cftcSeries(rows, group, throughDate, count);
  if (!result.selected) throw new CftcError('No compatible CFTC observation is available for that selection.', { code: 'CFTC_OBSERVATION_UNAVAILABLE', status: 404 });
  const reconciliationIssues = rows.filter(row => row.reconciliation.status === 'mismatch').map(row => ({ reason: 'open_interest_reconciliation_mismatch', identity: row.identity, longDifference: row.reconciliation.longDifference, shortDifference: row.reconciliation.shortDifference }));
  const quarantine = [...normalized.quarantine, ...reconciliationIssues];
  const requiredUnavailable = [
    result.selected.openInterest == null ? 'open_interest_all' : null,
    result.selected.venueCode == null ? 'cftc_market_code' : null,
    result.selected.units == null ? 'contract_units' : null,
    ...CFTC_FAMILIES[family].groups.flatMap(definition => {
      const participant = result.selected.groups[definition.id];
      return [participant?.long == null ? definition.long : null, participant?.short == null ? definition.short : null, definition.spread && participant?.spreading == null ? definition.spread : null];
    }),
  ].filter(Boolean);
  return { schema_version: CFTC_SCHEMA_VERSION, calculation_version: CFTC_CALCULATION_VERSION, report_family: family, report_basis: CFTC_REPORT_BASIS, retrieved_at: retrievedAt, status: quarantine.length || retrieval?.cap_reached || requiredUnavailable.length ? 'partial' : 'ready', freshness: freshness(result.selected.reportDate, retrievedAt, cacheStatus), source: sourceDetails(family, sourceUrl), retrieval, selection: { contract: code, group, report_date: result.selected.reportDate, history_window: window, required_prior_reports: count }, selected: result.selected, participants: Object.values(result.selected.groups), history: result.points, percentile: result.percentile, shorter_percentiles: result.shorterPercentiles, coverage: { ...result.historyRange, required_values_unavailable: requiredUnavailable }, quarantine,
    formula: { net_contracts: 'long - short', net_percent_open_interest: '100 * (long - short) / open interest', percentile: '100 * (prior values below current + 0.5 * prior values equal to current) / n; no later observations', one_week_change: 'selected net contracts - compatible net contracts exactly 7 calendar days earlier', four_week_change: 'selected net contracts - compatible net contracts exactly 28 calendar days earlier', previous_available_change: 'selected net contracts - immediately preceding compatible report net contracts', calculation_version: CFTC_CALCULATION_VERSION } };
}

export async function loadCftcHistory({ family = 'tff', code, group, reportDate = 'latest', window = '5y', signal, forceRefresh = false, fetchImpl, deadlineMs = CFTC_LOAD_BUDGET_MS } = {}) {
  if (!isCftcFamily(family) || !isCftcContractCode(code)) throw new CftcError('Use a verified CFTC contract code.', { code: 'INVALID_CONTRACT', status: 400 });
  if (!cftcGroup(family, group)) throw new CftcError('Use a trader group from the selected report family.', { code: 'INVALID_TRADER_GROUP', status: 400 });
  if (!Object.hasOwn(CFTC_HISTORY_WINDOWS, window)) throw new CftcError('Use window=1y, 3y, or 5y.', { code: 'INVALID_HISTORY_WINDOW', status: 400 });
  const operationSignal = deadlineSignal(undefined, deadlineMs);
  const callerWaitSignal = signal ? AbortSignal.any([signal, operationSignal]) : operationSignal;
  const markets = await loadCftcMarkets({ family, signal, fetchImpl, internalSignal: operationSignal });
  if (!markets.catalog.some(item => item.code === code)) throw new CftcError('That contract is not in the current verified CFTC catalog for this report family.', { code: 'UNSUPPORTED_CONTRACT', status: 404 });
  let throughDate = reportDate;
  if (reportDate === 'latest') throughDate = markets.report_date;
  if (!cftcDate(throughDate)) throw new CftcError('Use date=latest or a valid YYYY-MM-DD date.', { code: 'INVALID_REPORT_DATE', status: 400 });
  if (throughDate > markets.report_date) throw new CftcError('The requested date is later than the latest validated CFTC report.', { code: 'INVALID_REPORT_DATE', status: 400 });
  const cacheId = `history:${family}:${code}:${group}:${throughDate}:${window}`, cached = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, cacheId), callerWaitSignal), nowMs = Date.now(), age = cacheAge(cached);
  const cachedValid = validHistoryResponse(cached?.response, family, code, group, throughDate, window, nowMs) && Date.parse(cached?.savedAt) <= nowMs;
  if (!forceRefresh && cachedValid && age >= 0 && age < CFTC_FRESH_MS) return presentCftcResponse(cached.response, { savedAt: cached.savedAt, cacheStatus: 'prepared', requireCurrent: reportDate === 'latest' });
  const inflightKey = cacheId;
  if (requestCache.has(inflightKey)) return awaitShared(requestCache.get(inflightKey), callerWaitSignal);
  const task = (async () => {
    let lease = null;
  try {
    if (warmCacheEnabled()) {
      lease = await boundedOperation(warmAcquireLease(CFTC_CACHE_NAMESPACE, `load:${cacheId}`, 45_000), operationSignal);
      if (!lease) {
        const prepared = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, cacheId), operationSignal);
        if (validHistoryResponse(prepared?.response, family, code, group, throughDate, window, Date.now()) && cacheAge(prepared) >= 0 && cacheAge(prepared) < CFTC_STALE_MAX_MS) return presentCftcResponse(prepared.response, { savedAt: prepared.savedAt, cacheStatus: 'prepared-after-wait', requireCurrent: reportDate === 'latest' });
        const lastGood = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, `history-last-good:${family}:${code}:${group}:${throughDate}:${window}`), operationSignal);
        if (validHistoryResponse(lastGood?.response, family, code, group, throughDate, window, Date.now()) && cacheAge(lastGood) >= 0 && cacheAge(lastGood) < CFTC_STALE_MAX_MS) return presentCftcResponse(lastGood.response, { savedAt: lastGood.savedAt, cacheStatus: 'stale-last-good', requireCurrent: reportDate === 'latest', forceStale: true, warning: 'Another bounded CFTC refresh is in progress.' });
        throw new CftcError('Prepared CFTC history is not ready yet.', { code: 'CFTC_REFRESH_IN_PROGRESS', status: 503, retryAfter: 3000 });
      }
    }
    const rawThroughDate = throughDate, count = CFTC_HISTORY_WINDOWS[window];
    const source = await fetchCftcContractHistory(family, code, rawThroughDate, count, { group, signal: operationSignal, fetchImpl });
    const response = cftcPublicationStatus(buildCftcHistoryResponse({ family, code, group, throughDate, window, rawRows: source.rows, retrievedAt: source.retrievedAt, sourceUrl: source.sourceUrl, cacheStatus: source.cacheStatus || 'computed', retrieval: { rows: source.rows.length, pages: source.pages, cap_reached: Boolean(source.capReached), bounded_max_rows: 600 } }), {
      cacheRequired: warmCacheEnabled(),
      rawHistoryExpected: warmCacheEnabled() ? 1 : 0,
      rawHistoryPersisted: source.cachePersisted === true || source.cacheStatus === 'prepared' ? 1 : 0,
    });
    const savedAt = new Date().toISOString();
    const preparedResponse = presentCftcResponse(response, { savedAt, cacheStatus: source.cacheStatus || 'computed', requireCurrent: reportDate === 'latest' });
    const allowLastGood = preparedResponse.status === 'ready' && (reportDate !== 'latest' || preparedResponse.freshness.source_currency === 'current');
    return publishPreparedResponse({ cacheId, lastGoodId: `history-last-good:${family}:${code}:${group}:${throughDate}:${window}`, response: preparedResponse, savedAt, signal: operationSignal, allowLastGood });
  } catch (error) {
    if (error?.code === 'CFTC_REQUEST_CANCELLED') throw error;
    const lastGood = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, `history-last-good:${family}:${code}:${group}:${throughDate}:${window}`), deadlineSignal(undefined, 3500));
    const selected = [cached, lastGood].find(envelope => validHistoryResponse(envelope?.response, family, code, group, throughDate, window, Date.now()) && cacheAge(envelope) >= 0 && cacheAge(envelope) < CFTC_STALE_MAX_MS);
    if (selected) return presentCftcResponse(selected.response, { savedAt: selected.savedAt, cacheStatus: 'stale-last-good', requireCurrent: reportDate === 'latest', forceStale: true, warning: error.message });
    throw error;
  } finally {
    await releaseLeaseBestEffort(`load:${cacheId}`, lease);
  }
  })();
  requestCache.set(inflightKey, task);
  task.finally(() => requestCache.delete(inflightKey)).catch(() => {});
  return awaitShared(task, callerWaitSignal);
}

export async function refreshCftcSnapshots({ signal } = {}) {
  if (!warmCacheEnabled()) throw new CftcError('Shared CFTC cache storage is unavailable.', { code: 'CFTC_CACHE_UNAVAILABLE', status: 503 });
  const jobSignal = signal || deadlineSignal(undefined, 240_000);
  const lease = await boundedOperation(warmAcquireLease(CFTC_CACHE_NAMESPACE, 'refresh', 240_000), jobSignal);
  if (!lease) return { skipped: 'CFTC refresh is already running or coordination is unavailable.' };
  try {
    const now = Date.now(), prior = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, 'refresh-checkpoint'), jobSignal);
    const resumable = validCftcRefreshCheckpoint(prior, now) && !prior.complete && now - Date.parse(prior.started_at) < CFTC_FRESH_MS;
    let checkpoint = resumable ? prior : { schema_version: CFTC_REFRESH_CHECKPOINT_VERSION, started_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), complete: false, families: {} };
    async function persist() {
      checkpoint = { ...checkpoint, updated_at: new Date().toISOString() };
      const stored = await boundedOperation(warmSet(CFTC_CACHE_NAMESPACE, 'refresh-checkpoint', checkpoint, 2 * 86400), jobSignal);
      if (!stored) throw new CftcError('The CFTC refresh checkpoint could not be persisted.', { code: 'CFTC_CACHE_PUBLICATION_FAILED', status: 503 });
    }
    if (!resumable) await persist();
    for (const family of ['tff', 'disaggregated']) {
      if (checkpoint.families[family]?.status === 'ready' && checkpoint.families[family]?.cache_durable === true) continue;
      try {
        const value = await loadCftcMarkets({ family, forceRefresh: true, signal: jobSignal });
        checkpoint = { ...checkpoint, families: { ...checkpoint.families, [family]: { family, status: value.status, report_date: value.report_date, catalog_rows: value.catalog.length, cache_durable: value.cache_publication?.durable === true } } };
      } catch (error) {
        checkpoint = { ...checkpoint, families: { ...checkpoint.families, [family]: { family, status: 'failed', cache_durable: false, error: error?.message || 'Unknown CFTC refresh error' } } };
      }
      await persist();
    }
    const families = ['tff', 'disaggregated'].map(family => checkpoint.families[family] || { family, status: 'failed', cache_durable: false, error: 'No checkpointed result.' });
    checkpoint = { ...checkpoint, complete: families.every(item => item.status === 'ready' && item.cache_durable === true), ...(families.every(item => item.status === 'ready' && item.cache_durable === true) ? { completed_at: new Date().toISOString() } : {}) };
    await persist();
    if (families.every(item => item.status === 'failed' || item.status === 'stale')) throw new CftcError('Both CFTC report families failed to produce a fresh refresh.', { code: 'CFTC_REFRESH_FAILED', status: 503, details: families });
    return { schema_version: CFTC_SCHEMA_VERSION, refreshed_at: new Date().toISOString(), status: checkpoint.complete ? 'ready' : 'degraded', checkpoint: { schema_version: checkpoint.schema_version, started_at: checkpoint.started_at, updated_at: checkpoint.updated_at, complete: checkpoint.complete }, families };
  } finally { await releaseLeaseBestEffort('refresh', lease); }
}

export function validCftcRefreshCheckpoint(value, now = Date.now()) {
  const started = Date.parse(value?.started_at), updated = Date.parse(value?.updated_at), completed = Date.parse(value?.completed_at);
  if (value?.schema_version !== CFTC_REFRESH_CHECKPOINT_VERSION || !Number.isFinite(started) || !Number.isFinite(updated) || started > updated || updated > now || typeof value?.complete !== 'boolean' || !value?.families || Array.isArray(value.families) || typeof value.families !== 'object') return false;
  if (value.complete && (!Number.isFinite(completed) || completed < started || completed > updated)) return false;
  if (!value.complete && value.completed_at != null) return false;
  const validFamilies = Object.entries(value.families).every(([family, result]) => isCftcFamily(family) && result?.family === family
    && ['ready', 'partial', 'stale', 'failed'].includes(result?.status)
    && typeof result?.cache_durable === 'boolean'
    && (result.status === 'failed' ? typeof result.error === 'string' : cftcDate(result.report_date) === result.report_date && Number.isSafeInteger(result.catalog_rows)));
  if (!validFamilies) return false;
  return !value.complete || ['tff', 'disaggregated'].every(family => value.families[family]?.status === 'ready' && value.families[family]?.cache_durable === true);
}
