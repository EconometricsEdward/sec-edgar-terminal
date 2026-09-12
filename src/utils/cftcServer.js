import { CFTC_CALCULATION_VERSION, CFTC_CATEGORY_LABELS, CFTC_FAMILIES, CFTC_HISTORY_WINDOWS, CFTC_LAUNCH_CATALOG, CFTC_REPORT_BASIS, CFTC_SCHEMA_VERSION, cftcCatalog, cftcDate, cftcGroup, cftcSeries, isCftcContractCode, isCftcFamily, normalizeCftcRow, normalizeCftcRows } from './cftc.js';
import { CftcTransportError, cftcOutboundGate } from './cftcTransport.js';
import { warmAcquireLease, warmCacheEnabled, warmGet, warmReleaseLease, warmSet } from './warmCache.js';

const deploymentScope = process.env.VERCEL_ENV === 'production'
  ? 'production'
  : process.env.VERCEL_ENV === 'preview'
    ? `preview-${String(process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 12)}`
    : 'local';
export const CFTC_CACHE_NAMESPACE = `edgar.cftc-positioning.v1:${deploymentScope}`;
export const CFTC_FRESH_MS = 26 * 3600_000;
export const CFTC_STALE_MAX_MS = 15 * 86400_000;
export const CFTC_SOURCE_CURRENT_MAX_DAYS = 14;
export const CFTC_PUBLIC_DATE_YEARS = 6;
export const CFTC_REFRESH_RESUME_MS = 48 * 3600_000;
export const CFTC_RAW_HISTORY_SCHEMA_VERSION = 'edgar.cftc-raw-history.v2';
export const CFTC_LOAD_BUDGET_MS = 48_000;
export const CFTC_REFRESH_CHECKPOINT_VERSION = 'edgar.cftc-refresh-checkpoint.v1';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const CFTC_PUBLIC_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
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
    let onAbort;
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('Cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
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

export async function fetchCftcResource(familyId, query, { signal, fetchImpl = fetch, retries = 1, outboundGate = cftcOutboundGate } = {}) {
  const family = CFTC_FAMILIES[familyId];
  if (!family) throw new CftcError('Unsupported CFTC report family.', { code: 'INVALID_REPORT_FAMILY', status: 400 });
  const url = new URL(cftcResourceUrl(familyId, query));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const outcome = await outboundGate.run(async () => {
        const timeout = AbortSignal.timeout(10_000);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetchImpl(url, { headers: { Accept: 'application/json', ...(process.env.CFTC_APP_TOKEN ? { 'X-App-Token': process.env.CFTC_APP_TOKEN } : {}) }, cache: 'no-store', signal: requestSignal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          const retryAfter = parseCftcRetryAfter(response.headers.get('retry-after'));
          const retryable = response.status === 429 || response.status >= 500;
          const retryDelay = retryAfter ?? Math.min(2000, 400 * 2 ** attempt);
          if (retryable && (response.status === 429 || retryAfter != null)) await outboundGate.publishCooldown(retryDelay);
          return { error: new CftcError(`The CFTC source returned HTTP ${response.status}.`, { code: response.status === 429 ? 'CFTC_RATE_LIMITED' : 'CFTC_SOURCE_HTTP_ERROR', status: retryable ? 503 : 502, retryAfter }), retryable, retryDelay };
        }
        const value = await boundedJson(response);
        if (!Array.isArray(value)) throw new CftcError('The CFTC source returned an unexpected response.', { code: 'CFTC_RESPONSE_INVALID' });
        if (value.length > MAX_DATASET_ROWS) throw new CftcError('The CFTC row limit was exceeded.', { code: 'CFTC_RESPONSE_TOO_LARGE' });
        return { value };
      }, { signal });
      if (outcome.error) {
        if (outcome.retryable && attempt < retries && outcome.retryDelay <= 2000) {
          await retryWait(outcome.retryDelay, signal);
          continue;
        }
        throw outcome.error;
      }
      return { rows: outcome.value, sourceUrl: url.toString() };
    } catch (error) {
      if (error instanceof CftcError || error instanceof CftcTransportError) throw error;
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

function subtractCalendarYears(date, years) {
  const [year, month, day] = date.split('-').map(Number);
  const targetYear = year - years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return `${String(targetYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

export function cftcPublicDateBounds(now = new Date()) {
  const latest = new Date(now).toISOString().slice(0, 10);
  return { earliest: subtractCalendarYears(latest, CFTC_PUBLIC_DATE_YEARS), latest };
}

export function isCftcPublicReportDate(value, now = new Date()) {
  if (cftcDate(value) !== value) return false;
  const bounds = cftcPublicDateBounds(now);
  return value >= bounds.earliest && value <= bounds.latest;
}

function rawOrderValue(row, field) {
  return row?.[field] == null ? '' : String(row[field]);
}

const CFTC_NUMERIC_FIELDS = new Set(['open_interest_all', ...Object.values(CFTC_FAMILIES).flatMap(family => family.groups.flatMap(group => [group.long, group.short, group.spread].filter(Boolean)))]);

function compareRawRows(left, right, order) {
  for (const [field, direction] of order) {
    const a = rawOrderValue(left, field), b = rawOrderValue(right, field);
    if (a === b) continue;
    const numericA = CFTC_NUMERIC_FIELDS.has(field) && a.trim() ? Number(a) : NaN;
    const numericB = CFTC_NUMERIC_FIELDS.has(field) && b.trim() ? Number(b) : NaN;
    const compared = Number.isFinite(numericA) && Number.isFinite(numericB) ? (numericA < numericB ? -1 : 1) : a < b ? -1 : 1;
    return direction === 'DESC' ? -compared : compared;
  }
  return 0;
}

function rawRowFingerprint(row, family) {
  return JSON.stringify(CFTC_FAMILIES[family].fields.map(field => row?.[field] ?? null));
}

function createPageTracker() {
  return { priorLast: null, priorRows: new Set(), pageFingerprints: new Set() };
}

function totalCftcOrder(family, leading) {
  const fields = new Set(leading.map(([field]) => field));
  return [...leading, ...CFTC_FAMILIES[family].fields.filter(field => !fields.has(field)).map(field => [field, 'ASC'])];
}

function soqlOrder(order) { return order.map(([field, direction]) => `${field} ${direction}`).join(','); }

function validateCftcPage(rows, { family, limit, order, tracker }) {
  if (rows.length > limit) throw new CftcError('The CFTC source ignored the bounded page size.', { code: 'CFTC_PAGINATION_INVALID' });
  for (let index = 1; index < rows.length; index += 1) {
    if (compareRawRows(rows[index - 1], rows[index], order) > 0) throw new CftcError('The CFTC source page was not deterministically ordered.', { code: 'CFTC_PAGINATION_INVALID' });
  }
  if (tracker.priorLast && rows[0] && compareRawRows(tracker.priorLast, rows[0], order) > 0) throw new CftcError('The CFTC source pages were not monotonically ordered.', { code: 'CFTC_PAGINATION_INVALID' });
  const fingerprints = rows.map(row => rawRowFingerprint(row, family));
  const pageFingerprint = JSON.stringify(fingerprints);
  if (rows.length && tracker.pageFingerprints.has(pageFingerprint)) throw new CftcError('The CFTC source repeated a pagination page.', { code: 'CFTC_PAGINATION_DUPLICATE' });
  if (fingerprints.some(fingerprint => tracker.priorRows.has(fingerprint))) throw new CftcError('The CFTC source returned overlapping pagination pages.', { code: 'CFTC_PAGINATION_DUPLICATE' });
  if (rows.length) tracker.pageFingerprints.add(pageFingerprint);
  for (const fingerprint of fingerprints) tracker.priorRows.add(fingerprint);
  tracker.priorLast = rows.at(-1) || tracker.priorLast;
}

function latestRowsQuery(family, reportDate, offset = 0) {
  const order = totalCftcOrder(family, [['cftc_contract_market_code', 'ASC'], ['cftc_market_code', 'ASC'], ['contract_units', 'ASC'], ['id', 'ASC']]);
  return {
    '$select': CFTC_FAMILIES[family].fields.join(','),
    '$where': `report_date_as_yyyy_mm_dd=${quoteSoql(`${reportDate}T00:00:00.000`)}`,
    '$order': soqlOrder(order),
    '$limit': 500,
    '$offset': offset,
  };
}

export async function fetchCftcLatestRows(family, reportDate, options = {}) {
  if (!isCftcFamily(family) || cftcDate(reportDate) !== reportDate) throw new CftcError('Invalid CFTC latest-row request.', { code: 'INVALID_CFTC_REQUEST', status: 400 });
  const rows = [], tracker = createPageTracker(); let offset = 0, pages = 0;
  const order = totalCftcOrder(family, [['cftc_contract_market_code', 'ASC'], ['cftc_market_code', 'ASC'], ['contract_units', 'ASC'], ['id', 'ASC']]);
  const query = latestRowsQuery(family, reportDate);
  const sourceUrl = cftcResourceUrl(family, query);
  do {
    const result = await fetchCftcResource(family, { ...query, '$offset': offset }, options);
    validateCftcPage(result.rows, { family, limit: 500, order, tracker });
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

function launchHistoryQuery(family, throughDate, offset = 0) {
  const codes = CFTC_LAUNCH_CATALOG.filter(item => item.family === family).map(item => item.code);
  const from = subtractCalendarDays(throughDate, 6 * 366);
  const order = totalCftcOrder(family, [['cftc_contract_market_code', 'ASC'], ['report_date_as_yyyy_mm_dd', 'DESC'], ['cftc_market_code', 'ASC'], ['contract_units', 'ASC'], ['id', 'ASC']]);
  return {
    '$select': CFTC_FAMILIES[family].fields.join(','),
    '$where': `cftc_contract_market_code in(${codes.map(quoteSoql).join(',')}) AND report_date_as_yyyy_mm_dd between ${quoteSoql(`${from}T00:00:00.000`)} and ${quoteSoql(`${throughDate}T23:59:59.999`)}`,
    '$order': soqlOrder(order),
    '$limit': 1000,
    '$offset': offset,
  };
}

export async function fetchCftcLaunchHistory(family, throughDate, options = {}) {
  if (!isCftcFamily(family) || cftcDate(throughDate) !== throughDate) throw new CftcError('Invalid CFTC launch-history request.', { code: 'INVALID_CFTC_REQUEST', status: 400 });
  const rows = [], tracker = createPageTracker(); let offset = 0, pages = 0;
  const order = totalCftcOrder(family, [['cftc_contract_market_code', 'ASC'], ['report_date_as_yyyy_mm_dd', 'DESC'], ['cftc_market_code', 'ASC'], ['contract_units', 'ASC'], ['id', 'ASC']]);
  const query = launchHistoryQuery(family, throughDate);
  const sourceUrl = cftcResourceUrl(family, query);
  do {
    const result = await fetchCftcResource(family, { ...query, '$offset': offset }, options);
    validateCftcPage(result.rows, { family, limit: 1000, order, tracker });
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

const CFTC_HISTORY_FORMULA = Object.freeze({
  net_contracts: 'long - short',
  net_percent_open_interest: '100 * (long - short) / open interest',
  percentile: '100 * (prior values below current + 0.5 * prior values equal to current) / n; no later observations',
  one_week_change: 'selected net contracts - compatible net contracts exactly 7 calendar days earlier',
  one_week_net_percent_open_interest_change: 'selected net/open-interest percentage - compatible net/open-interest percentage exactly 7 calendar days earlier; each observation uses its own open interest; result is percentage points',
  four_week_change: 'selected net contracts - compatible net contracts exactly 28 calendar days earlier',
  four_week_net_percent_open_interest_change: 'selected net/open-interest percentage - compatible net/open-interest percentage exactly 28 calendar days earlier; each observation uses its own open interest; result is percentage points',
  previous_available_change: 'selected net contracts - immediately preceding compatible report net contracts',
  calculation_version: CFTC_CALCULATION_VERSION,
});

const CFTC_MARKET_METHODOLOGY = Object.freeze({
  net_contracts: 'reported long contracts - reported short contracts',
  net_percent_open_interest: '100 * net contracts / open interest',
  percentile: '100 * (prior values below current + 0.5 * prior values equal to current) / n; same contract, family and trader group; selected and later observations excluded',
  weekly_change: 'Current net contracts minus the compatible observation exactly seven calendar days earlier; unavailable when absent.',
  weekly_net_percent_open_interest_change: 'Current net/open-interest percentage minus the compatible observation exactly seven calendar days earlier; each observation uses its own open interest; result is percentage points.',
  four_week_change: 'Current net contracts minus the compatible observation exactly 28 calendar days earlier; unavailable when absent.',
  four_week_net_percent_open_interest_change: 'Current net/open-interest percentage minus the compatible observation exactly 28 calendar days earlier; each observation uses its own open interest; result is percentage points.',
  previous_available_change: 'Current net contracts minus the immediately preceding compatible report, with its elapsed calendar days disclosed separately.',
});

function requiredHistoryUnavailable(family, selected) {
  return [
    selected.openInterest == null ? 'open_interest_all' : null,
    selected.venueCode == null ? 'cftc_market_code' : null,
    selected.units == null ? 'contract_units' : null,
    ...CFTC_FAMILIES[family].groups.flatMap(definition => {
      const participant = selected.groups[definition.id];
      return [participant?.long == null ? definition.long : null, participant?.short == null ? definition.short : null, definition.spread && participant?.spreading == null ? definition.spread : null];
    }),
  ].filter(Boolean);
}

function warnings(...values) {
  return [...new Set(values.flatMap(value => String(value || '').split(' | ')).map(value => value.trim()).filter(Boolean))].join(' | ');
}

function cftcPublicResponseBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Infinity; }
}

export function assertCftcPublicResponseSize(value) {
  const bytes = cftcPublicResponseBytes(value);
  if (bytes > CFTC_PUBLIC_RESPONSE_MAX_BYTES) throw new CftcError('The prepared CFTC response exceeded the public byte limit.', { code: 'CFTC_RESPONSE_TOO_LARGE', status: 502 });
  return value;
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
    durable: primaryPersisted === true && lastGoodPersisted === true && Number(rawHistoryPersisted) >= Number(rawHistoryExpected),
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
    staleCache ? 'The prepared CFTC snapshot is older than 26 hours.' : '',
    agedSource ? `The latest validated CFTC report is ${nextFreshness.source_report_age_days} days old; the current-data threshold is ${CFTC_SOURCE_CURRENT_MAX_DAYS} days.` : '',
  );
  const durableCache = ['prepared', 'prepared-after-wait', 'stale-last-good'].includes(cacheStatus);
  const storedPublication = response?.cache_publication;
  const presented = { ...response, status, ...(refreshWarning ? { refresh_warning: refreshWarning } : {}), freshness: nextFreshness };
  return assertCftcPublicResponseSize(cftcPublicationStatus(presented, {
    cacheRequired: durableCache || storedPublication?.cache_required,
    primaryPersisted: durableCache && storedPublication == null ? true : storedPublication?.primary_persisted,
    lastGoodPersisted: durableCache && storedPublication == null ? false : storedPublication?.last_good_persisted,
    rawHistoryExpected: storedPublication?.raw_history_expected,
    rawHistoryPersisted: storedPublication?.raw_history_persisted,
  }));
}

function comparableCftcObservation(row) {
  return Object.fromEntries(Object.entries(row || {}).filter(([key]) => key !== 'sourceRowId' && key !== 'raw'));
}

function sameCftcObservation(left, right) {
  return Boolean(left && right) && semanticEqual(comparableCftcObservation(left), comparableCftcObservation(right));
}

function latestHistoryObservationConflicts(latestRows, historyRows) {
  const latestByIdentity = new Map(latestRows.map(row => [row.identity, row]));
  return historyRows.flatMap(row => {
    const current = latestByIdentity.get(row.identity);
    return !current || sameCftcObservation(current, row) ? [] : [{
      reason: 'conflicting_latest_history_identity',
      identity: row.identity,
      sourceRowIds: [current.sourceRowId, row.sourceRowId],
    }];
  });
}

function expectedHistoryObservation(raw, family, code, reportDate) {
  if (!raw) return null;
  const normalized = normalizeCftcRow(raw, family);
  if (!normalized.ok || normalized.value.code !== code || normalized.value.reportDate !== reportDate) {
    throw new CftcError('The expected CFTC observation was invalid.', { code: 'CFTC_RESPONSE_INVALID' });
  }
  return normalized.value;
}

function assertHistoryMatchesExpected(rawRows, family, code, reportDate, expected) {
  if (!expected) return;
  const selected = normalizeCftcRows(rawRows, family).rows.find(row => row.code === code && row.reportDate === reportDate);
  if (!selected) {
    throw new CftcError('The CFTC history resource omitted the expected latest observation.', { code: 'CFTC_SOURCE_INCOMPLETE', status: 502, details: { identity: expected.identity } });
  }
  if (!sameCftcObservation(expected, selected)) {
    throw new CftcError('The CFTC latest and history resources returned conflicting observations.', { code: 'CFTC_SOURCE_CONFLICT', status: 502, details: { identity: expected.identity } });
  }
}

function historyResponseMatchesExpected(response, expected, family) {
  if (!expected) return true;
  const selected = normalizeCftcRow(response?.selected?.raw, family);
  return selected.ok && sameCftcObservation(expected, selected.value);
}

export function buildCftcMarketsSnapshot({ family, reportDate, latestRaw, historyRaw, retrievedAt = new Date().toISOString(), sourceUrl = CFTC_FAMILIES[family]?.sourceUrl, historySourceUrl = null, historyError = null, cacheStatus = 'computed' }) {
  const latestNormalized = normalizeCftcRows(latestRaw, family), historyNormalized = normalizeCftcRows(historyRaw, family);
  const latestRows = latestNormalized.rows.filter(row => row.reportDate === reportDate);
  const latestHistoryConflicts = latestHistoryObservationConflicts(latestRows, historyNormalized.rows);
  const historyByCode = new Map();
  for (const row of historyNormalized.rows.filter(row => row.reportDate < reportDate)) { const list = historyByCode.get(row.code) || []; list.push(row); historyByCode.set(row.code, list); }
  const catalog = cftcCatalog(latestRows, family);
  const expectedLaunch = CFTC_LAUNCH_CATALOG.filter(item => item.family === family);
  const latest = expectedLaunch.flatMap(item => {
    const current = latestRows.find(row => row.code === item.code);
    if (!current) return [];
    const groups = Object.fromEntries(CFTC_FAMILIES[family].groups.map(definition => {
      const series = cftcSeries([current, ...(historyByCode.get(item.code) || [])], definition.id, reportDate, 260);
      return [definition.id, { ...current.groups[definition.id], oneWeekChange: series.selected?.oneWeekChange ?? null, oneWeekNetPctChange: series.selected?.oneWeekNetPctChange ?? null, fourWeekChange: series.selected?.fourWeekChange ?? null, fourWeekNetPctChange: series.selected?.fourWeekNetPctChange ?? null, percentile: series.percentile, shorterPercentiles: series.shorterPercentiles, historyRange: series.historyRange }];
    }));
    return [{ ...current, launchLabel: item.label, groups }];
  });
  const reconciliationIssues = latestRows.filter(row => row.reconciliation.status === 'mismatch').map(row => ({ identity: row.identity, code: row.code, longDifference: row.reconciliation.longDifference, shortDifference: row.reconciliation.shortDifference }));
  const launchReconciliationIssues = reconciliationIssues.filter(issue => expectedLaunch.some(item => item.code === issue.code));
  const requiredUnavailable = latest.filter(row => row.openInterest == null || row.venueCode == null || row.units == null || CFTC_FAMILIES[family].groups.some(group => row.groups[group.id]?.long == null || row.groups[group.id]?.short == null || (group.spread && row.groups[group.id]?.spreading == null))).map(row => row.code);
  const quarantine = [...latestNormalized.quarantine, ...historyNormalized.quarantine, ...latestHistoryConflicts];
  const missingLaunch = expectedLaunch.filter(item => !latestRows.some(row => row.code === item.code)).map(item => item.code);
  const launchHistoryCoverage = expectedLaunch.map(item => ({ code: item.code, ...rawHistoryCoverage((Array.isArray(historyRaw) ? historyRaw : []).filter(row => String(row?.cftc_contract_market_code || '').trim().toUpperCase() === item.code), family, item.code, reportDate, 260) }));
  const missingLaunchHistory = launchHistoryCoverage.filter(item => !item.selected).map(item => item.code);
  const insufficientLaunchHistory = launchHistoryCoverage.filter(item => item.selected && !item.sufficient).map(item => item.code);
  const coverageWarning = historyError || missingLaunchHistory.length || insufficientLaunchHistory.length
    ? `Launch-history coverage is incomplete${historyError ? `: ${historyError}` : '.'}`
    : null;
  const historyWarning = warnings(coverageWarning, latestHistoryConflicts.length ? 'Conflicting latest/history observations were quarantined; displayed latest values were used for calculations.' : '');
  return assertCftcPublicResponseSize({ schema_version: CFTC_SCHEMA_VERSION, calculation_version: CFTC_CALCULATION_VERSION, report_family: family, report_basis: CFTC_REPORT_BASIS, report_date: reportDate, retrieved_at: retrievedAt,
    status: quarantine.length || missingLaunch.length || missingLaunchHistory.length || insufficientLaunchHistory.length || launchReconciliationIssues.length || requiredUnavailable.length || historyError ? 'partial' : 'ready',
    ...(historyWarning ? { refresh_warning: historyWarning } : {}),
    freshness: freshness(reportDate, retrievedAt, cacheStatus), source: sourceDetails(family, sourceUrl, historySourceUrl), groups: CFTC_FAMILIES[family].groups.map(({ id, label }) => ({ id, label })),
    catalog, launch_codes: expectedLaunch.map(item => item.code), latest, coverage: { catalog_rows: catalog.length, launch_expected: expectedLaunch.length, launch_available: latest.length, missing_launch_codes: missingLaunch, missing_launch_history_codes: missingLaunchHistory, insufficient_launch_history_codes: insufficientLaunchHistory, required_values_unavailable: requiredUnavailable, quarantined_rows: quarantine.length, reconciliation_differences: reconciliationIssues.length, launch_reconciliation_differences: launchReconciliationIssues.length }, quarantine, diagnostics: { reconciliation_differences: reconciliationIssues },
    methodology: { ...CFTC_MARKET_METHODOLOGY },
  });
}

function cacheAge(envelope, now = Date.now()) { return new Date(now).getTime() - Date.parse(envelope?.savedAt); }

const RETIRED_CACHE_FIELDS = new Set([
  'price', 'prices', 'price_source', 'price_status', 'price_sample', 'price_through',
  'return', 'returns', 'return_series', 'beta', 'downside_beta', 'sector_beta',
  'residual_volatility', 'co_movement', 'correlation', 'associations',
  'market_signal', 'market_signals', 'sector_proxy', 'event_study',
]);

function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function finiteOrNull(value) { return value == null || Number.isFinite(value); }
function stringOrNull(value) { return value == null || typeof value === 'string'; }
function safeInteger(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function exactKeys(value, required, optional = []) {
  if (!plainObject(value) || required.some(key => !Object.hasOwn(value, key))) return false;
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every(key => allowed.has(key));
}

function semanticEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => semanticEqual(item, right[index]));
  if (!plainObject(left) || !plainObject(right)) return false;
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && semanticEqual(left[key], right[key]));
}

function containsRetiredCacheField(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsRetiredCacheField(item, seen));
  return Object.entries(value).some(([key, nested]) => RETIRED_CACHE_FIELDS.has(key.toLowerCase()) || containsRetiredCacheField(nested, seen));
}

function officialUrl(value, family) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value), config = CFTC_FAMILIES[family];
    return url.protocol === 'https:' && url.hostname === 'publicreporting.cftc.gov'
      && url.port === '' && url.username === '' && url.password === '' && url.hash === ''
      && url.pathname === `/resource/${config.datasetId}.json`;
  } catch { return false; }
}

function exactResourceQuery(value, family, query) {
  return officialUrl(value, family) && new URL(value).toString() === cftcResourceUrl(family, query);
}

function officialSourceMatches(response, family, { kind, reportDate, code = null } = {}) {
  const config = CFTC_FAMILIES[family], source = response?.source;
  const baseValid = Boolean(config)
    && exactKeys(source, ['agency', 'dataset_id', 'report_family', 'report_basis', 'url', 'history_url', 'documentation'])
    && source.agency === 'U.S. Commodity Futures Trading Commission'
    && source.dataset_id === config.datasetId && source.report_family === config.label
    && source.report_basis === CFTC_REPORT_BASIS && source.documentation === config.documentationUrl;
  if (!baseValid) return false;
  if (kind === 'markets') {
    return exactResourceQuery(source.url, family, latestRowsQuery(family, reportDate))
      && (source.history_url == null || exactResourceQuery(source.history_url, family, launchHistoryQuery(family, reportDate)));
  }
  if (kind === 'history') {
    const contractQuery = exactResourceQuery(source.url, family, contractHistoryQuery(family, code, reportDate));
    const launchQuery = CFTC_LAUNCH_CATALOG.some(item => item.family === family && item.code === code)
      && exactResourceQuery(source.url, family, launchHistoryQuery(family, reportDate));
    return source.history_url == null && (contractQuery || launchQuery);
  }
  return false;
}

function validPercentile(value, selectedDate) {
  if (!exactKeys(value, ['value', 'reason', 'observations', 'required', 'comparisonRange'])) return false;
  if (!finiteOrNull(value.value) || value.value < 0 || value.value > 100 || !stringOrNull(value.reason) || ![52, 156, 260].includes(value.required) || !safeInteger(value.observations) || value.observations > value.required) return false;
  const range = value.comparisonRange;
  if (!exactKeys(range, ['observations', 'earliest', 'latest']) || range.observations !== value.observations) return false;
  if (range.observations === 0) {
    if (range.earliest != null || range.latest != null) return false;
  } else if (cftcDate(range.earliest) !== range.earliest || cftcDate(range.latest) !== range.latest || range.earliest > range.latest || range.latest >= selectedDate) return false;
  return value.value == null ? typeof value.reason === 'string' : value.reason == null && value.observations === value.required;
}

function validHistoryRange(value, { code, venueCode, units, selectedDate, historyLength = null } = {}) {
  if (!exactKeys(value, ['observations', 'earliest', 'latest', 'compatibility'], ['required_values_unavailable']) || !safeInteger(value.observations)) return false;
  if (historyLength != null && value.observations !== historyLength) return false;
  if (value.observations === 0) {
    if (value.earliest != null || value.latest != null) return false;
  } else if (cftcDate(value.earliest) !== value.earliest || cftcDate(value.latest) !== value.latest || value.earliest > value.latest || value.latest > selectedDate) return false;
  const compatibility = value.compatibility;
  return exactKeys(compatibility, ['code', 'venueCode', 'units'])
    && compatibility.code === code && compatibility.venueCode === venueCode && compatibility.units === units
    && (!value.required_values_unavailable || Array.isArray(value.required_values_unavailable) && value.required_values_unavailable.every(item => typeof item === 'string'));
}

function validGroupValue(value, definition, { openInterest, code, venueCode, units, selectedDate, analytics = false } = {}) {
  const optional = analytics ? ['oneWeekChange', 'oneWeekNetPctChange', 'fourWeekChange', 'fourWeekNetPctChange', 'percentile', 'shorterPercentiles', 'historyRange'] : [];
  if (!exactKeys(value, ['id', 'label', 'long', 'short', 'spreading', 'spreadingStatus', 'net', 'netPctOi', 'rawFields'], optional)) return false;
  if (value.id !== definition.id || value.label !== definition.label || ![value.long, value.short, value.spreading].every(item => finiteOrNull(item) && !(Number.isFinite(item) && item < 0)) || !finiteOrNull(value.net) || !finiteOrNull(value.netPctOi)) return false;
  if (definition.spread == null ? value.spreading !== null || value.spreadingStatus !== 'not_applicable' : value.spreading == null ? value.spreadingStatus !== 'unavailable' : value.spreadingStatus !== 'reported') return false;
  const expectedNet = value.long != null && value.short != null ? value.long - value.short : null;
  const expectedNetPct = expectedNet != null && openInterest > 0 ? 100 * expectedNet / openInterest : null;
  if (value.net !== expectedNet || value.netPctOi !== expectedNetPct) return false;
  if (!exactKeys(value.rawFields, ['long', 'short', 'spreading']) || value.rawFields.long !== definition.long || value.rawFields.short !== definition.short || value.rawFields.spreading !== definition.spread) return false;
  if (!optional.every(key => !Object.hasOwn(value, key) || key === 'percentile' || key === 'shorterPercentiles' || key === 'historyRange' || finiteOrNull(value[key]))) return false;
  if (Object.hasOwn(value, 'percentile') && !validPercentile(value.percentile, selectedDate)) return false;
  if (Object.hasOwn(value, 'shorterPercentiles') && (!Array.isArray(value.shorterPercentiles) || value.shorterPercentiles.some(item => !validPercentile(item, selectedDate)))) return false;
  if (analytics && optional.some(key => !Object.hasOwn(value, key))) return false;
  return !Object.hasOwn(value, 'historyRange') || validHistoryRange(value.historyRange, { code, venueCode, units, selectedDate });
}

function boundedRawScalar(value) {
  return value == null || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 4096;
}

function validRawObservation(value, family) {
  return plainObject(value)
    && Object.keys(value).length === CFTC_FAMILIES[family].fields.length
    && CFTC_FAMILIES[family].fields.every(field => Object.hasOwn(value, field) && boundedRawScalar(value[field]));
}

function historyPointFields(definition) {
  return ['id', 'market_and_exchange_names', 'contract_market_name', 'report_date_as_yyyy_mm_dd', 'cftc_contract_market_code', 'cftc_market_code', 'contract_units', 'futonly_or_combined', 'open_interest_all', definition.long, definition.short, definition.spread].filter(Boolean);
}

function historyPointUnavailable(canonical, definition) {
  const fields = ['open_interest_all', definition.long, definition.short, definition.spread].filter(Boolean);
  return Object.fromEntries(fields.filter(field => canonical.unavailable[field]).map(field => [field, canonical.unavailable[field]]));
}

function historyPointDerivedUnavailable(canonical, definition) {
  const group = canonical.groups[definition.id], unavailable = {};
  if (group.net == null) unavailable.net = 'long_or_short_unavailable';
  if (group.netPctOi == null) unavailable.netPctOi = group.net == null ? 'net_unavailable' : canonical.openInterest == null ? 'open_interest_unavailable' : canonical.openInterest <= 0 ? 'open_interest_not_positive' : 'calculation_unavailable';
  return unavailable;
}

function validHistoryPointRaw(value, definition) {
  const fields = historyPointFields(definition);
  return exactKeys(value, fields)
    && fields.every(field => boundedRawScalar(value[field]));
}

function validObservation(value, family, { expectedCode = null, expectedDate = null, expectedGroup = null, analytics = false, launch = false } = {}) {
  const required = ['identity', 'family', 'reportBasis', 'reportDate', 'code', 'sourceRowId', 'venueCode', 'marketName', 'contractName', 'exchange', 'commodity', 'category', 'categoryLabel', 'units', 'openInterest', 'groups', 'unavailable', 'reconciliation', 'raw'];
  const optional = ['launchLabel', 'selectedGroup', 'oneWeekChange', 'oneWeekNetPctChange', 'fourWeekChange', 'fourWeekNetPctChange', 'previousAvailableChange', 'previousAvailableDate', 'previousAvailableElapsedDays'];
  if (!exactKeys(value, required, optional) || value.family !== family || value.reportBasis !== CFTC_REPORT_BASIS || cftcDate(value.reportDate) !== value.reportDate || !isCftcContractCode(value.code)) return false;
  if (expectedCode && value.code !== expectedCode || expectedDate && value.reportDate !== expectedDate || value.identity !== `${family}|${CFTC_REPORT_BASIS}|${value.code}|${value.reportDate}`) return false;
  if (!stringOrNull(value.sourceRowId) || !stringOrNull(value.venueCode) || !stringOrNull(value.units) || !finiteOrNull(value.openInterest) || Number.isFinite(value.openInterest) && value.openInterest < 0) return false;
  if (![value.marketName, value.contractName, value.exchange, value.commodity, value.category, value.categoryLabel].every(item => typeof item === 'string') || CFTC_CATEGORY_LABELS[value.category] !== value.categoryLabel) return false;
  if (launch && typeof value.launchLabel !== 'string') return false;
  const definitions = CFTC_FAMILIES[family].groups, groupIds = definitions.map(item => item.id);
  if (!plainObject(value.groups) || Object.keys(value.groups).length !== groupIds.length || !definitions.every(definition => validGroupValue(value.groups[definition.id], definition, { openInterest: value.openInterest, code: value.code, venueCode: value.venueCode, units: value.units, selectedDate: value.reportDate, analytics }))) return false;
  if (!plainObject(value.unavailable) || Object.entries(value.unavailable).some(([field, reason]) => !CFTC_FAMILIES[family].fields.includes(field) || typeof reason !== 'string')) return false;
  if (!validRawObservation(value.raw, family)) return false;
  if (cftcDate(value.raw.report_date_as_yyyy_mm_dd) !== value.reportDate || String(value.raw.cftc_contract_market_code || '').trim().toUpperCase() !== value.code || value.raw.futonly_or_combined !== 'FutOnly') return false;
  if (value.sourceRowId !== (typeof value.raw.id === 'string' ? value.raw.id : null) || value.venueCode !== (String(value.raw.cftc_market_code || '').trim() || null) || value.units !== (String(value.raw.contract_units || '').trim() || null)) return false;
  const renormalized = normalizeCftcRow(value.raw, family);
  if (!renormalized.ok) return false;
  const canonical = renormalized.value;
  const canonicalKeys = ['identity', 'family', 'reportBasis', 'reportDate', 'code', 'sourceRowId', 'venueCode', 'marketName', 'contractName', 'exchange', 'commodity', 'category', 'categoryLabel', 'units', 'openInterest', 'unavailable', 'reconciliation', 'raw'];
  if (canonicalKeys.some(key => !semanticEqual(value[key], canonical[key]))) return false;
  const canonicalGroupKeys = ['id', 'label', 'long', 'short', 'spreading', 'spreadingStatus', 'net', 'netPctOi', 'rawFields'];
  if (CFTC_FAMILIES[family].groups.some(definition => canonicalGroupKeys.some(key => !semanticEqual(value.groups[definition.id]?.[key], canonical.groups[definition.id]?.[key])))) return false;
  const reconciliation = value.reconciliation;
  if (!exactKeys(reconciliation, ['available', 'status', 'tolerance', 'longTotal', 'shortTotal', 'longDifference', 'shortDifference']) || typeof reconciliation.available !== 'boolean' || !['ok', 'mismatch', 'unavailable'].includes(reconciliation.status) || !Number.isFinite(reconciliation.tolerance) || ![reconciliation.longTotal, reconciliation.shortTotal, reconciliation.longDifference, reconciliation.shortDifference].every(finiteOrNull)) return false;
  if (expectedGroup) {
    if (!value.selectedGroup || JSON.stringify(value.selectedGroup) !== JSON.stringify(value.groups[expectedGroup])) return false;
  } else if (value.selectedGroup) return false;
  if (optional.slice(2, 7).some(key => Object.hasOwn(value, key) && !finiteOrNull(value[key]))) return false;
  if (value.previousAvailableDate != null && (cftcDate(value.previousAvailableDate) !== value.previousAvailableDate || value.previousAvailableDate >= value.reportDate)) return false;
  if (value.previousAvailableElapsedDays != null && !safeInteger(value.previousAvailableElapsedDays, 1)) return false;
  return true;
}

function validFreshness(value, reportDate, retrievedAt) {
  return exactKeys(value, ['report_date', 'retrieved_at', 'cache_status', 'source_report_age_days', 'source_currency', 'source_currency_max_days', 'publication_time_verified'])
    && value.report_date === reportDate && value.retrieved_at === retrievedAt && typeof value.cache_status === 'string' && value.cache_status.length > 0
    && safeInteger(value.source_report_age_days) && ['current', 'aged'].includes(value.source_currency)
    && value.source_currency_max_days === CFTC_SOURCE_CURRENT_MAX_DAYS && value.publication_time_verified === false;
}

function validCachePublication(value) {
  if (value == null) return true;
  const shape = exactKeys(value, ['cache_required', 'primary_persisted', 'last_good_persisted', 'raw_history_expected', 'raw_history_persisted', 'durable'])
    && typeof value.cache_required === 'boolean' && [true, false, null].includes(value.primary_persisted) && [true, false, null].includes(value.last_good_persisted)
    && safeInteger(value.raw_history_expected) && safeInteger(value.raw_history_persisted) && value.raw_history_persisted <= value.raw_history_expected && typeof value.durable === 'boolean';
  return shape && value.durable === (value.primary_persisted === true && value.last_good_persisted === true && value.raw_history_persisted >= value.raw_history_expected);
}

function validQuarantine(value) { return Array.isArray(value) && value.every(item => plainObject(item) && typeof item.reason === 'string'); }

export function validMarketsResponse(response, family, nowMs, expectedDate = null) {
  const config = CFTC_FAMILIES[family], groupIds = config?.groups.map(group => group.id) || [];
  const required = ['schema_version', 'calculation_version', 'report_family', 'report_basis', 'report_date', 'retrieved_at', 'status', 'freshness', 'source', 'groups', 'catalog', 'launch_codes', 'latest', 'coverage', 'quarantine', 'diagnostics', 'methodology'];
  if (!exactKeys(response, required, ['refresh_warning', 'cache_publication']) || containsRetiredCacheField(response) || cftcPublicResponseBytes(response) > CFTC_PUBLIC_RESPONSE_MAX_BYTES) return false;
  if (response.schema_version !== CFTC_SCHEMA_VERSION || response.report_family !== family || response.report_basis !== CFTC_REPORT_BASIS) return false;
  if (response.calculation_version !== CFTC_CALCULATION_VERSION || cftcDate(response.report_date) !== response.report_date || response.report_date > new Date(nowMs).toISOString().slice(0, 10) || expectedDate && expectedDate !== 'latest' && response.report_date !== expectedDate) return false;
  if (!Number.isFinite(Date.parse(response.retrieved_at)) || Date.parse(response.retrieved_at) > nowMs || !['ready', 'partial', 'stale'].includes(response.status) || !officialSourceMatches(response, family, { kind: 'markets', reportDate: response.report_date }) || !validFreshness(response.freshness, response.report_date, response.retrieved_at) || !validCachePublication(response.cache_publication)) return false;
  if (response.status === 'ready' && response.cache_publication?.cache_required && !response.cache_publication.durable) return false;
  if (!Array.isArray(response.groups) || response.groups.length !== groupIds.length || !config.groups.every((definition, index) => exactKeys(response.groups[index], ['id', 'label']) && response.groups[index].id === definition.id && response.groups[index].label === definition.label)) return false;
  if (!Array.isArray(response.catalog) || response.catalog.length < 1 || response.catalog.length > 1000) return false;
  const catalogCodes = new Set();
  for (const item of response.catalog) {
    if (!exactKeys(item, ['family', 'code', 'marketName', 'contractName', 'exchange', 'commodity', 'units', 'category', 'categoryLabel', 'launch', 'launchLabel', 'reportDate']) || item.family !== family || !isCftcContractCode(item.code) || catalogCodes.has(item.code) || item.reportDate !== response.report_date || ![item.marketName, item.contractName, item.exchange, item.commodity, item.category, item.categoryLabel].every(field => typeof field === 'string') || !stringOrNull(item.units) || typeof item.launch !== 'boolean' || !stringOrNull(item.launchLabel) || CFTC_CATEGORY_LABELS[item.category] !== item.categoryLabel) return false;
    catalogCodes.add(item.code);
  }
  const expectedLaunch = CFTC_LAUNCH_CATALOG.filter(item => item.family === family).map(item => item.code);
  if (!Array.isArray(response.launch_codes) || response.launch_codes.length !== expectedLaunch.length || response.launch_codes.some((code, index) => code !== expectedLaunch[index])) return false;
  if (!Array.isArray(response.latest) || response.latest.length > expectedLaunch.length) return false;
  const latestCodes = new Set();
  if (response.latest.some(item => !validObservation(item, family, { expectedDate: response.report_date, analytics: true, launch: true }) || !expectedLaunch.includes(item.code) || !catalogCodes.has(item.code) || latestCodes.has(item.code) || !latestCodes.add(item.code))) return false;
  const coverage = response.coverage;
  if (!exactKeys(coverage, ['catalog_rows', 'launch_expected', 'launch_available', 'missing_launch_codes', 'missing_launch_history_codes', 'insufficient_launch_history_codes', 'required_values_unavailable', 'quarantined_rows', 'reconciliation_differences', 'launch_reconciliation_differences']) || coverage.catalog_rows !== response.catalog.length || coverage.launch_expected !== expectedLaunch.length || coverage.launch_available !== response.latest.length || ![coverage.quarantined_rows, coverage.reconciliation_differences, coverage.launch_reconciliation_differences].every(value => safeInteger(value)) || ![coverage.missing_launch_codes, coverage.missing_launch_history_codes, coverage.insufficient_launch_history_codes, coverage.required_values_unavailable].every(list => Array.isArray(list) && list.every(item => typeof item === 'string'))) return false;
  if (response.status === 'ready' && (coverage.missing_launch_codes.length || coverage.missing_launch_history_codes.length || coverage.insufficient_launch_history_codes.length || coverage.required_values_unavailable.length || coverage.quarantined_rows || coverage.launch_reconciliation_differences)) return false;
  if (!validQuarantine(response.quarantine) || !plainObject(response.diagnostics) || !Array.isArray(response.diagnostics.reconciliation_differences) || !semanticEqual(response.methodology, CFTC_MARKET_METHODOLOGY)) return false;
  return true;
}

export function validHistoryResponse(response, family, code, group, throughDate, window, nowMs) {
  const required = ['schema_version', 'calculation_version', 'report_family', 'report_basis', 'retrieved_at', 'status', 'freshness', 'source', 'selection', 'selected', 'participants', 'history', 'percentile', 'shorter_percentiles', 'coverage', 'quarantine', 'formula'];
  if (!exactKeys(response, required, ['refresh_warning', 'cache_publication', 'retrieval']) || containsRetiredCacheField(response) || cftcPublicResponseBytes(response) > CFTC_PUBLIC_RESPONSE_MAX_BYTES) return false;
  if (response.schema_version !== CFTC_SCHEMA_VERSION || response.calculation_version !== CFTC_CALCULATION_VERSION || response.report_family !== family || response.report_basis !== CFTC_REPORT_BASIS || !Number.isFinite(Date.parse(response.retrieved_at)) || Date.parse(response.retrieved_at) > nowMs || !['ready', 'partial', 'stale'].includes(response.status) || !officialSourceMatches(response, family, { kind: 'history', reportDate: throughDate, code }) || !validFreshness(response.freshness, throughDate, response.retrieved_at) || !validCachePublication(response.cache_publication)) return false;
  if (response.status === 'ready' && response.cache_publication?.cache_required && !response.cache_publication.durable) return false;
  if (!exactKeys(response.selection, ['contract', 'group', 'report_date', 'history_window', 'required_prior_reports']) || response.selection.contract !== code || response.selection.group !== group || response.selection.report_date !== throughDate || response.selection.history_window !== window || response.selection.required_prior_reports !== CFTC_HISTORY_WINDOWS[window]) return false;
  if (!validObservation(response.selected, family, { expectedCode: code, expectedDate: throughDate, expectedGroup: group, analytics: false })) return false;
  const definitions = CFTC_FAMILIES[family].groups;
  if (!Array.isArray(response.participants) || response.participants.length !== definitions.length || !definitions.every((definition, index) => validGroupValue(response.participants[index], definition, { openInterest: response.selected.openInterest, code, venueCode: response.selected.venueCode, units: response.selected.units, selectedDate: throughDate }) && JSON.stringify(response.participants[index]) === JSON.stringify(response.selected.groups[definition.id]))) return false;
  if (!Array.isArray(response.history) || response.history.length < 1 || response.history.length > 600) return false;
  let priorDate = null;
  const replayRows = [];
  const selectedDefinition = cftcGroup(family, group);
  if (!selectedDefinition) return false;
  for (const point of response.history) {
    if (!exactKeys(point, ['reportDate', 'sourceRowId', 'marketName', 'contractName', 'exchange', 'openInterest', 'long', 'short', 'spreading', 'spreadingStatus', 'net', 'netPctOi', 'unavailable', 'raw', 'derivedUnavailable']) || cftcDate(point.reportDate) !== point.reportDate || point.reportDate > throughDate || priorDate && point.reportDate <= priorDate || !stringOrNull(point.sourceRowId) || point.sourceRowId != null && Buffer.byteLength(point.sourceRowId, 'utf8') > 512 || ![point.marketName, point.contractName, point.exchange].every(value => typeof value === 'string') || !plainObject(point.unavailable) || !plainObject(point.derivedUnavailable) || !validHistoryPointRaw(point.raw, selectedDefinition)) return false;
    const normalized = normalizeCftcRow(point.raw, family);
    if (!normalized.ok) return false;
    const canonical = normalized.value, canonicalGroup = canonical.groups[selectedDefinition.id];
    if (canonical.code !== code || canonical.reportDate !== point.reportDate || canonical.venueCode !== response.selected.venueCode || canonical.units !== response.selected.units) return false;
    const actual = { sourceRowId: point.sourceRowId, marketName: point.marketName, contractName: point.contractName, exchange: point.exchange, openInterest: point.openInterest, long: point.long, short: point.short, spreading: point.spreading, spreadingStatus: point.spreadingStatus, net: point.net, netPctOi: point.netPctOi, unavailable: point.unavailable, derivedUnavailable: point.derivedUnavailable, raw: point.raw };
    const expected = { sourceRowId: canonical.sourceRowId, marketName: canonical.marketName, contractName: canonical.contractName, exchange: canonical.exchange, openInterest: canonical.openInterest, long: canonicalGroup.long, short: canonicalGroup.short, spreading: canonicalGroup.spreading, spreadingStatus: canonicalGroup.spreadingStatus, net: canonicalGroup.net, netPctOi: canonicalGroup.netPctOi, unavailable: historyPointUnavailable(canonical, selectedDefinition), derivedUnavailable: historyPointDerivedUnavailable(canonical, selectedDefinition), raw: point.raw };
    if (!semanticEqual(actual, expected)) return false;
    replayRows.push(canonical);
    priorDate = point.reportDate;
  }
  const selectedPoint = response.history.at(-1), selectedGroup = response.selected.groups[group];
  const selectedRawMatches = Object.entries(selectedPoint.raw).every(([field, value]) => semanticEqual(value, response.selected.raw[field]));
  if (!selectedRawMatches || !semanticEqual({ sourceRowId: selectedPoint.sourceRowId, marketName: selectedPoint.marketName, contractName: selectedPoint.contractName, exchange: selectedPoint.exchange, openInterest: selectedPoint.openInterest, long: selectedPoint.long, short: selectedPoint.short, spreading: selectedPoint.spreading, spreadingStatus: selectedPoint.spreadingStatus, net: selectedPoint.net, netPctOi: selectedPoint.netPctOi, unavailable: selectedPoint.unavailable, derivedUnavailable: selectedPoint.derivedUnavailable }, { sourceRowId: response.selected.sourceRowId, marketName: response.selected.marketName, contractName: response.selected.contractName, exchange: response.selected.exchange, openInterest: response.selected.openInterest, long: selectedGroup.long, short: selectedGroup.short, spreading: selectedGroup.spreading, spreadingStatus: selectedGroup.spreadingStatus, net: selectedGroup.net, netPctOi: selectedGroup.netPctOi, unavailable: historyPointUnavailable(response.selected, selectedDefinition), derivedUnavailable: historyPointDerivedUnavailable(response.selected, selectedDefinition) })) return false;
  const changeKeys = ['oneWeekChange', 'oneWeekNetPctChange', 'fourWeekChange', 'fourWeekNetPctChange', 'previousAvailableChange', 'previousAvailableDate', 'previousAvailableElapsedDays'];
  if (changeKeys.some(key => !Object.hasOwn(response.selected, key))) return false;
  const replay = cftcSeries(replayRows, group, throughDate, CFTC_HISTORY_WINDOWS[window]);
  if (!replay.selected || changeKeys.some(key => !semanticEqual(response.selected[key], replay.selected[key])) || !semanticEqual(response.history, replay.points) || !semanticEqual(response.percentile, replay.percentile) || !semanticEqual(response.shorter_percentiles, replay.shorterPercentiles)) return false;
  if (response.history.at(-1).reportDate !== throughDate || !validPercentile(response.percentile, throughDate) || response.percentile.required !== CFTC_HISTORY_WINDOWS[window] || !Array.isArray(response.shorter_percentiles) || response.shorter_percentiles.some(item => !validPercentile(item, throughDate))) return false;
  if (!validHistoryRange(response.coverage, { code, venueCode: response.selected.venueCode, units: response.selected.units, selectedDate: throughDate, historyLength: response.history.length }) || !validQuarantine(response.quarantine)) return false;
  if (!semanticEqual({ observations: response.coverage.observations, earliest: response.coverage.earliest, latest: response.coverage.latest, compatibility: response.coverage.compatibility }, replay.historyRange)) return false;
  if (!semanticEqual(response.coverage.required_values_unavailable, requiredHistoryUnavailable(family, response.selected)) || !semanticEqual(response.formula, CFTC_HISTORY_FORMULA)) return false;
  if (response.retrieval != null) {
    const retrieval = response.retrieval;
    if (!exactKeys(retrieval, ['origin_scope', 'scope_rows', 'source_rows', 'source_pages', 'source_page_size', 'cap_reached', 'bounded_scope_rows', 'bounded_source_rows'])
      || !['contract_history', 'launch_selection'].includes(retrieval.origin_scope)
      || !safeInteger(retrieval.scope_rows, 1) || retrieval.scope_rows > 600 || retrieval.scope_rows < response.history.length
      || !safeInteger(retrieval.source_rows, 1) || retrieval.source_rows < retrieval.scope_rows
      || !safeInteger(retrieval.source_pages, 1) || typeof retrieval.cap_reached !== 'boolean'
      || retrieval.bounded_scope_rows !== 600 || retrieval.cap_reached && retrieval.scope_rows !== retrieval.bounded_scope_rows) return false;
    if (retrieval.origin_scope === 'contract_history') {
      if (retrieval.source_rows !== retrieval.scope_rows || retrieval.source_pages > 3 || retrieval.source_page_size !== 200 || retrieval.bounded_source_rows !== 600) return false;
    } else if (retrieval.source_pages > 5 || retrieval.source_page_size !== 1000 || retrieval.bounded_source_rows !== 5000 || retrieval.source_rows > retrieval.bounded_source_rows) return false;
    const minimumPages = Math.max(1, Math.ceil(retrieval.source_rows / retrieval.source_page_size));
    if (retrieval.source_pages < minimumPages || retrieval.source_pages > minimumPages + (retrieval.source_rows % retrieval.source_page_size === 0 ? 1 : 0)) return false;
  }
  return true;
}

function validStatusEnvelope(envelope, family, nowMs, expectedDate = null) {
  const savedAt = Date.parse(envelope?.savedAt);
  return exactKeys(envelope, ['savedAt', 'response']) && Number.isFinite(savedAt) && savedAt <= nowMs
    && savedAt >= Date.parse(envelope?.response?.retrieved_at)
    && validMarketsResponse(envelope?.response, family, nowMs, expectedDate);
}

function validHistoryEnvelope(envelope, family, code, group, throughDate, window, nowMs) {
  const savedAt = Date.parse(envelope?.savedAt);
  return exactKeys(envelope, ['savedAt', 'response']) && Number.isFinite(savedAt) && savedAt <= nowMs
    && savedAt >= Date.parse(envelope?.response?.retrieved_at)
    && validHistoryResponse(envelope.response, family, code, group, throughDate, window, nowMs);
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
      .filter(item => validStatusEnvelope(item.envelope, family, nowMs) && (item.source !== 'primary' || isPublishedCftcPrimary(item.envelope)) && cacheAge(item.envelope, nowMs) < CFTC_STALE_MAX_MS)
      .sort((a, b) => b.envelope.response.report_date.localeCompare(a.envelope.response.report_date) || Date.parse(b.envelope.savedAt) - Date.parse(a.envelope.savedAt) || (a.source === 'primary' ? -1 : 1))[0];
    if (!valid) {
      const any = candidates.find(Boolean);
      const timestamp = Date.parse(any?.savedAt);
      const anyValid = candidates.find((envelope, candidateIndex) => validStatusEnvelope(envelope, family, nowMs) && (candidateIndex > 0 || isPublishedCftcPrimary(envelope)));
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
  const order = totalCftcOrder(family, [['report_date_as_yyyy_mm_dd', 'DESC'], ['cftc_market_code', 'ASC'], ['contract_units', 'ASC'], ['id', 'ASC']]);
  return {
    '$select': config.fields.join(','),
    '$where': `cftc_contract_market_code=${quoteSoql(code)} AND report_date_as_yyyy_mm_dd<=${quoteSoql(`${throughDate}T23:59:59.999`)}`,
    '$order': soqlOrder(order), '$limit': 200, '$offset': offset,
  };
}

function rawHistoryEnvelope({ family, code, throughDate, rows, sourceUrl, pages, retrievedAt, capReached = false, sourceExhausted = false, originScope = 'contract_history', sourceRows = rows.length, sourcePageSize = 200, sourceRowLimit = 600, savedAt = new Date().toISOString() }) {
  return { schema_version: CFTC_RAW_HISTORY_SCHEMA_VERSION, family, report_basis: CFTC_REPORT_BASIS, code, through_date: throughDate, savedAt, retrievedAt, sourceUrl, pages, capReached, sourceExhausted, originScope, sourceRows, sourcePageSize, sourceRowLimit, rows };
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
  if (!exactKeys(envelope, ['schema_version', 'family', 'report_basis', 'code', 'through_date', 'savedAt', 'retrievedAt', 'sourceUrl', 'pages', 'capReached', 'sourceExhausted', 'originScope', 'sourceRows', 'sourcePageSize', 'sourceRowLimit', 'rows']) || containsRetiredCacheField(envelope)) return false;
  if (envelope?.schema_version !== CFTC_RAW_HISTORY_SCHEMA_VERSION || envelope?.family !== family || envelope?.report_basis !== CFTC_REPORT_BASIS || envelope?.code !== code || envelope?.through_date !== throughDate) return false;
  if (!Number.isFinite(savedAt) || !Number.isFinite(retrievedAt) || savedAt > nowMs || retrievedAt > nowMs || nowMs - savedAt >= CFTC_STALE_MAX_MS) return false;
  if (!Array.isArray(envelope.rows) || envelope.rows.length > 600 || !Number.isSafeInteger(envelope.pages) || envelope.pages < 1 || typeof envelope.capReached !== 'boolean' || typeof envelope.sourceExhausted !== 'boolean' || !['contract_history', 'launch_selection'].includes(envelope.originScope) || !safeInteger(envelope.sourceRows) || envelope.sourceRows < envelope.rows.length) return false;
  if (envelope.capReached && envelope.rows.length < 600) return false;
  const launchScope = envelope.originScope === 'launch_selection';
  if (launchScope ? envelope.sourcePageSize !== 1000 || envelope.sourceRowLimit !== 5000 || envelope.pages > 5 || envelope.sourceRows > 5000 : envelope.sourcePageSize !== 200 || envelope.sourceRowLimit !== 600 || envelope.pages > 3 || envelope.sourceRows !== envelope.rows.length) return false;
  const minimumPages = Math.max(1, Math.ceil(envelope.sourceRows / envelope.sourcePageSize));
  if (envelope.pages < minimumPages || envelope.pages > minimumPages + (envelope.sourceRows % envelope.sourcePageSize === 0 ? 1 : 0)) return false;
  const exactSource = launchScope
    ? CFTC_LAUNCH_CATALOG.some(item => item.family === family && item.code === code) && exactResourceQuery(envelope.sourceUrl, family, launchHistoryQuery(family, throughDate))
    : exactResourceQuery(envelope.sourceUrl, family, contractHistoryQuery(family, code, throughDate));
  if (!exactSource) return false;
  if (group && !cftcGroup(family, group)) return false;
  const { normalized, selected, sufficient } = rawHistoryCoverage(envelope.rows, family, code, throughDate, count, group);
  if (normalized.rows.some(row => row.code !== code || row.family !== family || row.reportBasis !== CFTC_REPORT_BASIS || row.reportDate > throughDate)) return false;
  if (!selected) return envelope.sourceExhausted;
  return sufficient || envelope.sourceExhausted || envelope.capReached;
}

async function computeMarkets(family, { reportDate = 'latest', signal, fetchImpl } = {}) {
  const latest = reportDate === 'latest' ? await discoverLatestCftcDate(family, { signal, fetchImpl }) : { date: reportDate, sourceUrl: CFTC_FAMILIES[family].sourceUrl };
  const latestRows = await fetchCftcLatestRows(family, latest.date, { signal, fetchImpl });
  const latestNormalized = normalizeCftcRows(latestRows.rows, family);
  if (!latestNormalized.rows.some(row => row.reportDate === latest.date)) throw new CftcError('No validated CFTC report exists for that date.', { code: 'CFTC_REPORT_DATE_UNAVAILABLE', status: 404 });
  let historyRows = { rows: [], sourceUrl: null, pages: 0 }, historyError = null;
  try { historyRows = await fetchCftcLaunchHistory(family, latest.date, { signal, fetchImpl }); }
  catch (error) { historyError = error; }
  const cacheRequired = warmCacheEnabled();
  let rawHistoryExpected = 0, rawHistoryPersisted = 0;
  if (!historyError) {
    const byCode = new Map(), retrievedAt = new Date().toISOString();
    for (const row of historyRows.rows) { const code = String(row.cftc_contract_market_code || '').trim().toUpperCase(); const list = byCode.get(code) || []; list.push(row); byCode.set(code, list); }
    const expectedCodes = CFTC_LAUNCH_CATALOG.filter(item => item.family === family).map(item => item.code);
    const historyNormalized = normalizeCftcRows(historyRows.rows, family);
    const conflictingCodes = new Set(latestHistoryObservationConflicts(latestNormalized.rows.filter(row => row.reportDate === latest.date), historyNormalized.rows).map(item => item.identity.split('|')[2]));
    rawHistoryExpected = expectedCodes.length;
    if (cacheRequired && rawHistoryExpected) {
      try {
        const stored = await boundedOperation(Promise.all(expectedCodes.map(code => {
          const rows = byCode.get(code);
          return rows?.length && rows.length <= 600 && !conflictingCodes.has(code) ? warmSet(CFTC_CACHE_NAMESPACE, `raw-history:${family}:${code}:${latest.date}`, rawHistoryEnvelope({ family, code, throughDate: latest.date, rows, sourceUrl: historyRows.sourceUrl, pages: historyRows.pages, retrievedAt, sourceExhausted: true, originScope: 'launch_selection', sourceRows: historyRows.rows.length, sourcePageSize: 1000, sourceRowLimit: 5000, savedAt: retrievedAt }), 16 * 86400) : false;
        })), signal);
        rawHistoryPersisted = stored.filter(Boolean).length;
      } catch { rawHistoryPersisted = 0; }
    }
  } else {
    rawHistoryExpected = CFTC_LAUNCH_CATALOG.filter(item => item.family === family).length;
  }
  const snapshot = cftcPublicationStatus(buildCftcMarketsSnapshot({ family, reportDate: latest.date, latestRaw: latestRows.rows, historyRaw: historyRows.rows, sourceUrl: latestRows.sourceUrl, historySourceUrl: historyRows.sourceUrl, historyError: historyError?.message || null }), { cacheRequired, rawHistoryExpected, rawHistoryPersisted });
  if (!snapshot.catalog.length) throw new CftcError('No validated CFTC report exists for that date.', { code: 'CFTC_REPORT_DATE_UNAVAILABLE', status: 404 });
  return snapshot;
}

export async function publishPreparedResponse({ cacheId, lastGoodId, response, savedAt, signal, allowLastGood, cacheRequired = warmCacheEnabled(), cacheWrite = warmSet }) {
  if (!cacheRequired) return cftcPublicationStatus(response, {
    cacheRequired: false,
    rawHistoryExpected: response?.cache_publication?.raw_history_expected,
    rawHistoryPersisted: response?.cache_publication?.raw_history_persisted,
  });
  const publicationBase = { cacheRequired, rawHistoryExpected: response?.cache_publication?.raw_history_expected, rawHistoryPersisted: response?.cache_publication?.raw_history_persisted };
  if (!allowLastGood) {
    const primaryOnly = cftcPublicationStatus(response, { ...publicationBase, primaryPersisted: true, lastGoodPersisted: null });
    const primaryPersisted = await boundedOperation(cacheWrite(CFTC_CACHE_NAMESPACE, cacheId, { savedAt, response: primaryOnly }, 9 * 86400), signal).catch(() => false);
    return primaryPersisted ? primaryOnly : cftcPublicationStatus(response, { ...publicationBase, primaryPersisted: false, lastGoodPersisted: null });
  }

  // Stage only the primary key. The prior last-good value must remain untouched
  // until the complete candidate is ready to replace it.
  const provisional = cftcPublicationStatus(response, { ...publicationBase, primaryPersisted: false, lastGoodPersisted: null });
  const primaryStaged = await boundedOperation(cacheWrite(CFTC_CACHE_NAMESPACE, cacheId, { savedAt, response: provisional }, 9 * 86400), signal).catch(() => false);
  if (!primaryStaged) return provisional;

  const complete = cftcPublicationStatus(response, { ...publicationBase, primaryPersisted: true, lastGoodPersisted: true });
  const lastGoodPersisted = await boundedOperation(cacheWrite(CFTC_CACHE_NAMESPACE, lastGoodId, { savedAt, response: complete }, 16 * 86400), signal).catch(() => false);
  if (!lastGoodPersisted) {
    const failed = cftcPublicationStatus(response, { ...publicationBase, primaryPersisted: true, lastGoodPersisted: false });
    const primaryFinalized = await boundedOperation(cacheWrite(CFTC_CACHE_NAMESPACE, cacheId, { savedAt, response: failed }, 9 * 86400), signal).catch(() => false);
    return primaryFinalized ? failed : cftcPublicationStatus(response, { ...publicationBase, primaryPersisted: false, lastGoodPersisted: false });
  }

  // If this final write loses its acknowledgement, the primary staging value
  // is ignored by readers and the complete same-snapshot last-good wins.
  await boundedOperation(cacheWrite(CFTC_CACHE_NAMESPACE, cacheId, { savedAt, response: complete }, 9 * 86400), signal).catch(() => false);
  return complete;
}

export function hasCftcPublicationFailure(envelope) {
  const publication = envelope?.response?.cache_publication;
  return publication?.cache_required === true && (
    publication.primary_persisted === false
    || publication.last_good_persisted === false
    || publication.raw_history_persisted < publication.raw_history_expected
  );
}

export function isPublishedCftcPrimary(envelope) {
  const publication = envelope?.response?.cache_publication;
  return publication?.cache_required !== true || publication.primary_persisted === true
    && !hasCftcPublicationFailure(envelope)
    && (envelope?.response?.status !== 'ready' || publication.durable === true);
}

export function isDurableCftcTwin(primary, lastGood) {
  return !isPublishedCftcPrimary(primary)
    && typeof primary?.savedAt === 'string'
    && lastGood?.savedAt === primary.savedAt
    && lastGood?.response?.status === 'ready'
    && lastGood.response.cache_publication?.durable === true;
}

export async function loadCftcMarkets({ family = 'tff', reportDate = 'latest', signal, forceRefresh = false, preparedOnly = false, fetchImpl, cacheGet = warmGet, internalSignal = null, deadlineMs = CFTC_LOAD_BUDGET_MS } = {}) {
  if (!isCftcFamily(family)) throw new CftcError('Use family=tff or family=disaggregated.', { code: 'INVALID_REPORT_FAMILY', status: 400 });
  if (reportDate !== 'latest' && !isCftcPublicReportDate(reportDate)) throw new CftcError('Use date=latest or a YYYY-MM-DD date within the retained six-year CFTC range.', { code: 'INVALID_REPORT_DATE', status: 400 });
  const operationSignal = internalSignal || deadlineSignal(undefined, deadlineMs);
  const callerWaitSignal = signal ? AbortSignal.any([signal, operationSignal]) : operationSignal;
  const cacheId = `markets:${family}:${reportDate}`, cached = await boundedOperation(cacheGet(CFTC_CACHE_NAMESPACE, cacheId), callerWaitSignal), nowMs = Date.now();
  const cachedShapeValid = validStatusEnvelope(cached, family, nowMs, reportDate);
  const cachedValid = cachedShapeValid && isPublishedCftcPrimary(cached);
  const age = cacheAge(cached, nowMs);
  if (!forceRefresh && cachedShapeValid && !cachedValid && age >= 0 && age < CFTC_FRESH_MS) {
    const lastGood = await boundedOperation(cacheGet(CFTC_CACHE_NAMESPACE, `markets-last-good:${family}:${reportDate}`), callerWaitSignal).catch(() => null);
    if (validStatusEnvelope(lastGood, family, nowMs, reportDate) && cacheAge(lastGood, nowMs) >= 0 && cacheAge(lastGood, nowMs) < CFTC_FRESH_MS && isDurableCftcTwin(cached, lastGood)) return presentCftcResponse(lastGood.response, { savedAt: lastGood.savedAt, cacheStatus: 'prepared', now: new Date(nowMs), requireCurrent: reportDate === 'latest' });
  }
  if (!forceRefresh && cachedValid && age >= 0 && age < CFTC_FRESH_MS) return presentCftcResponse(cached.response, { savedAt: cached.savedAt, cacheStatus: 'prepared', now: new Date(nowMs), requireCurrent: reportDate === 'latest' });
  if (preparedOnly) {
    const candidateIds = reportDate === 'latest'
      ? [{ id: `markets-last-good:${family}:latest`, source: 'last-good' }]
      : [
          { id: `markets-last-good:${family}:${reportDate}`, source: 'last-good' },
          { id: `markets:${family}:latest`, source: 'primary' },
          { id: `markets-last-good:${family}:latest`, source: 'last-good' },
        ];
    const candidates = [
      { envelope: cachedValid ? cached : null, source: 'primary' },
      ...await Promise.all(candidateIds.map(async candidate => ({ ...candidate, envelope: await boundedOperation(cacheGet(CFTC_CACHE_NAMESPACE, candidate.id), callerWaitSignal) }))),
    ]
      .filter(candidate => validStatusEnvelope(candidate.envelope, family, nowMs, reportDate)
        && (candidate.source !== 'primary' || isPublishedCftcPrimary(candidate.envelope))
        && cacheAge(candidate.envelope, nowMs) >= 0 && cacheAge(candidate.envelope, nowMs) < CFTC_STALE_MAX_MS)
      .sort((left, right) => Date.parse(right.envelope.savedAt) - Date.parse(left.envelope.savedAt)
        || (left.source === right.source ? 0 : left.source === 'primary' ? -1 : 1));
    if (candidates[0]) return presentCftcResponse(candidates[0].envelope.response, { savedAt: candidates[0].envelope.savedAt, cacheStatus: 'prepared', now: new Date(nowMs), requireCurrent: reportDate === 'latest' });
    throw new CftcError('That historical CFTC market snapshot is not available in the bounded prepared cache.', { code: 'CFTC_REPORT_NOT_PREPARED', status: 404 });
  }
  const inflightKey = `${family}:${reportDate}`;
  if (requestCache.has(inflightKey)) return awaitShared(requestCache.get(inflightKey), callerWaitSignal);
  const task = (async () => {
    let lease = null;
    try {
      if (warmCacheEnabled()) {
        lease = await boundedOperation(warmAcquireLease(CFTC_CACHE_NAMESPACE, `load:${cacheId}`, 90_000), operationSignal);
        if (!lease) {
          const prepared = await boundedOperation(cacheGet(CFTC_CACHE_NAMESPACE, cacheId), operationSignal);
          if (validStatusEnvelope(prepared, family, Date.now(), reportDate) && isPublishedCftcPrimary(prepared) && cacheAge(prepared) < CFTC_STALE_MAX_MS) return presentCftcResponse(prepared.response, { savedAt: prepared.savedAt, cacheStatus: 'prepared-after-wait', requireCurrent: reportDate === 'latest' });
          const lastGood = await boundedOperation(cacheGet(CFTC_CACHE_NAMESPACE, `markets-last-good:${family}:${reportDate}`), operationSignal);
          if (validStatusEnvelope(lastGood, family, Date.now(), reportDate) && cacheAge(lastGood) < CFTC_STALE_MAX_MS) return isDurableCftcTwin(prepared, lastGood)
            ? presentCftcResponse(lastGood.response, { savedAt: lastGood.savedAt, cacheStatus: 'prepared-after-wait', requireCurrent: reportDate === 'latest' })
            : presentCftcResponse(lastGood.response, { savedAt: lastGood.savedAt, cacheStatus: 'stale-last-good', requireCurrent: reportDate === 'latest', forceStale: true, warning: 'Another bounded CFTC refresh is in progress.' });
          throw new CftcError('A prepared CFTC snapshot is not ready yet.', { code: 'CFTC_REFRESH_IN_PROGRESS', status: 503, retryAfter: 3000 });
        }
      }
      const response = await computeMarkets(family, { reportDate, signal: operationSignal, fetchImpl });
      if (reportDate === 'latest') {
        const lastGood = await boundedOperation(cacheGet(CFTC_CACHE_NAMESPACE, `markets-last-good:${family}:${reportDate}`), operationSignal);
        const priors = [cachedValid ? cached : null, lastGood].filter(envelope => validStatusEnvelope(envelope, family, Date.now(), reportDate) && cacheAge(envelope) < CFTC_STALE_MAX_MS).sort((a, b) => b.response.report_date.localeCompare(a.response.report_date));
        if (priors[0]?.response?.report_date > response.report_date) return presentCftcResponse(priors[0].response, { savedAt: priors[0].savedAt, cacheStatus: 'stale-last-good', requireCurrent: true, forceStale: true, warning: `The upstream latest-date check regressed from ${priors[0].response.report_date} to ${response.report_date}; the newer validated snapshot was preserved.` });
      }
      const savedAt = new Date().toISOString();
      const preparedResponse = presentCftcResponse(response, { savedAt, cacheStatus: 'computed', requireCurrent: reportDate === 'latest' });
      const allowLastGood = preparedResponse.status === 'ready' && (reportDate !== 'latest' || preparedResponse.freshness.source_currency === 'current');
      return publishPreparedResponse({ cacheId, lastGoodId: `markets-last-good:${family}:${reportDate}`, response: preparedResponse, savedAt, signal: operationSignal, allowLastGood });
    } catch (error) {
      if (error?.code === 'CFTC_REQUEST_CANCELLED') throw error;
      const lastGood = await boundedOperation(cacheGet(CFTC_CACHE_NAMESPACE, `markets-last-good:${family}:${reportDate}`), deadlineSignal(undefined, 3500));
      const candidates = [cachedValid ? cached : null, lastGood].filter(envelope => validStatusEnvelope(envelope, family, Date.now(), reportDate) && cacheAge(envelope) >= 0 && cacheAge(envelope) < CFTC_STALE_MAX_MS).sort((a, b) => b.response.report_date.localeCompare(a.response.report_date));
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
  if (!isCftcFamily(family) || !isCftcContractCode(code) || cftcDate(throughDate) !== throughDate || ![52, 156, 260, 520].includes(count)) throw new CftcError('Invalid bounded CFTC history request.', { code: 'INVALID_CFTC_REQUEST', status: 400 });
  const { group = null, signal, expectedSelectedRaw = null, bypassPrepared = false, cacheGet = warmGet, cacheSet = warmSet, cacheEnabled = warmCacheEnabled, ...requestOptions } = options;
  if (group && !cftcGroup(family, group)) throw new CftcError('Invalid CFTC history participant group.', { code: 'INVALID_TRADER_GROUP', status: 400 });
  const expected = expectedHistoryObservation(expectedSelectedRaw, family, code, throughDate);
  const prepared = bypassPrepared ? null : await boundedOperation(cacheGet(CFTC_CACHE_NAMESPACE, `raw-history:${family}:${code}:${throughDate}`), signal);
  if (!bypassPrepared && validateRawHistoryEnvelope(prepared, { family, code, throughDate, count, group, now: new Date() })) {
    try {
      assertHistoryMatchesExpected(prepared.rows, family, code, throughDate, expected);
      return { rows: prepared.rows, sourceUrl: prepared.sourceUrl, pages: prepared.pages, sourceRows: prepared.sourceRows, sourcePageSize: prepared.sourcePageSize, sourceRowLimit: prepared.sourceRowLimit, originScope: prepared.originScope, retrievedAt: prepared.retrievedAt, cacheStatus: 'prepared', capReached: prepared.capReached, sourceExhausted: prepared.sourceExhausted, cachePersisted: true };
    } catch (error) {
      if (!['CFTC_SOURCE_CONFLICT', 'CFTC_SOURCE_INCOMPLETE'].includes(error?.code)) throw error;
    }
  }
  const rows = [], tracker = createPageTracker(); let offset = 0, pages = 0, sourceExhausted = false;
  const order = totalCftcOrder(family, [['report_date_as_yyyy_mm_dd', 'DESC'], ['cftc_market_code', 'ASC'], ['contract_units', 'ASC'], ['id', 'ASC']]);
  const sourceUrl = cftcResourceUrl(family, contractHistoryQuery(family, code, throughDate));
  const retrievedAt = new Date().toISOString();
  do {
    const result = await fetchCftcResource(family, contractHistoryQuery(family, code, throughDate, offset), { ...requestOptions, signal });
    validateCftcPage(result.rows, { family, limit: 200, order, tracker });
    pages += 1; rows.push(...result.rows);
    const { normalized, selected, sufficient } = rawHistoryCoverage(rows, family, code, throughDate, count, group);
    if (!selected && normalized.rows[0]?.reportDate < throughDate) { sourceExhausted = true; break; }
    if (sufficient || result.rows.length < 200) { sourceExhausted = result.rows.length < 200; break; }
    offset += result.rows.length;
    if (rows.length >= 600) break;
  } while (true);
  const { sufficient } = rawHistoryCoverage(rows, family, code, throughDate, count, group);
  const capReached = rows.length >= 600 && !sufficient;
  assertHistoryMatchesExpected(rows, family, code, throughDate, expected);
  const envelope = rawHistoryEnvelope({ family, code, throughDate, rows, sourceUrl, pages, retrievedAt, capReached, sourceExhausted });
  const cachePersisted = !cacheEnabled() ? null : await boundedOperation(cacheSet(CFTC_CACHE_NAMESPACE, `raw-history:${family}:${code}:${throughDate}`, envelope, 16 * 86400), signal).catch(() => false);
  return { rows, sourceUrl, pages, sourceRows: rows.length, sourcePageSize: 200, sourceRowLimit: 600, originScope: 'contract_history', retrievedAt, cacheStatus: 'computed', capReached, sourceExhausted, cachePersisted };
}

export function cftcHistoryResponseCacheStatus(sourceCacheStatus) {
  return sourceCacheStatus === 'prepared' ? 'computed-from-prepared-raw' : sourceCacheStatus || 'computed';
}

export function buildCftcHistoryResponse({ family, code, group, throughDate, window, rawRows, retrievedAt = new Date().toISOString(), sourceUrl = CFTC_FAMILIES[family]?.sourceUrl, cacheStatus = 'computed', retrieval = null }) {
  const normalized = normalizeCftcRows(rawRows, family), rows = normalized.rows.filter(row => row.code === code && row.reportDate <= throughDate);
  const count = CFTC_HISTORY_WINDOWS[window], result = cftcSeries(rows, group, throughDate, count);
  if (!result.selected) throw new CftcError('No compatible CFTC observation is available for that selection.', { code: 'CFTC_OBSERVATION_UNAVAILABLE', status: 404 });
  const reconciliationIssues = rows.filter(row => row.reconciliation.status === 'mismatch').map(row => ({ reason: 'open_interest_reconciliation_mismatch', identity: row.identity, longDifference: row.reconciliation.longDifference, shortDifference: row.reconciliation.shortDifference }));
  const quarantine = [...normalized.quarantine, ...reconciliationIssues];
  const requiredUnavailable = requiredHistoryUnavailable(family, result.selected);
  const selectedDefinition = cftcGroup(family, group);
  if (!validRawObservation(result.selected.raw, family) || result.selected.sourceRowId != null && Buffer.byteLength(result.selected.sourceRowId, 'utf8') > 512 || result.points.some(point => !validHistoryPointRaw(point.raw, selectedDefinition))) throw new CftcError('The normalized CFTC history exceeded its bounded provenance limits.', { code: 'CFTC_RESPONSE_TOO_LARGE', status: 502 });
  return assertCftcPublicResponseSize({ schema_version: CFTC_SCHEMA_VERSION, calculation_version: CFTC_CALCULATION_VERSION, report_family: family, report_basis: CFTC_REPORT_BASIS, retrieved_at: retrievedAt, status: quarantine.length || retrieval?.cap_reached || requiredUnavailable.length ? 'partial' : 'ready', freshness: freshness(result.selected.reportDate, retrievedAt, cacheStatus), source: sourceDetails(family, sourceUrl), retrieval, selection: { contract: code, group, report_date: result.selected.reportDate, history_window: window, required_prior_reports: count }, selected: result.selected, participants: Object.values(result.selected.groups), history: result.points, percentile: result.percentile, shorter_percentiles: result.shorterPercentiles, coverage: { ...result.historyRange, required_values_unavailable: requiredUnavailable }, quarantine,
    formula: { ...CFTC_HISTORY_FORMULA } });
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
  if (!isCftcPublicReportDate(throughDate)) throw new CftcError('Use date=latest or a YYYY-MM-DD date within the retained six-year CFTC range.', { code: 'INVALID_REPORT_DATE', status: 400 });
  if (throughDate > markets.report_date) throw new CftcError('The requested date is later than the latest validated CFTC report.', { code: 'INVALID_REPORT_DATE', status: 400 });
  const expectedLatest = throughDate === markets.report_date ? markets.latest.find(row => row.code === code) : null;
  const expected = expectedHistoryObservation(expectedLatest?.raw, family, code, throughDate);
  const cacheId = `history:${family}:${code}:${group}:${throughDate}:${window}`, cached = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, cacheId), callerWaitSignal), nowMs = Date.now(), age = cacheAge(cached);
  const cachedShapeValid = validHistoryEnvelope(cached, family, code, group, throughDate, window, nowMs) && historyResponseMatchesExpected(cached.response, expected, family);
  const cachedValid = cachedShapeValid && isPublishedCftcPrimary(cached);
  if (!forceRefresh && cachedShapeValid && !cachedValid && age >= 0 && age < CFTC_FRESH_MS) {
    const lastGood = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, `history-last-good:${family}:${code}:${group}:${throughDate}:${window}`), callerWaitSignal).catch(() => null);
    if (validHistoryEnvelope(lastGood, family, code, group, throughDate, window, nowMs) && historyResponseMatchesExpected(lastGood.response, expected, family) && cacheAge(lastGood, nowMs) >= 0 && cacheAge(lastGood, nowMs) < CFTC_FRESH_MS && isDurableCftcTwin(cached, lastGood)) return presentCftcResponse(lastGood.response, { savedAt: lastGood.savedAt, cacheStatus: 'prepared', requireCurrent: reportDate === 'latest' });
  }
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
          if (validHistoryEnvelope(prepared, family, code, group, throughDate, window, Date.now()) && isPublishedCftcPrimary(prepared) && historyResponseMatchesExpected(prepared.response, expected, family) && cacheAge(prepared) >= 0 && cacheAge(prepared) < CFTC_STALE_MAX_MS) return presentCftcResponse(prepared.response, { savedAt: prepared.savedAt, cacheStatus: 'prepared-after-wait', requireCurrent: reportDate === 'latest' });
          const lastGood = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, `history-last-good:${family}:${code}:${group}:${throughDate}:${window}`), operationSignal);
          if (validHistoryEnvelope(lastGood, family, code, group, throughDate, window, Date.now()) && historyResponseMatchesExpected(lastGood.response, expected, family) && cacheAge(lastGood) >= 0 && cacheAge(lastGood) < CFTC_STALE_MAX_MS) return isDurableCftcTwin(prepared, lastGood)
            ? presentCftcResponse(lastGood.response, { savedAt: lastGood.savedAt, cacheStatus: 'prepared-after-wait', requireCurrent: reportDate === 'latest' })
            : presentCftcResponse(lastGood.response, { savedAt: lastGood.savedAt, cacheStatus: 'stale-last-good', requireCurrent: reportDate === 'latest', forceStale: true, warning: 'Another bounded CFTC refresh is in progress.' });
        throw new CftcError('Prepared CFTC history is not ready yet.', { code: 'CFTC_REFRESH_IN_PROGRESS', status: 503, retryAfter: 3000 });
      }
    }
    const rawThroughDate = throughDate, count = CFTC_HISTORY_WINDOWS[window];
    const source = await fetchCftcContractHistory(family, code, rawThroughDate, count, { group, signal: operationSignal, fetchImpl, expectedSelectedRaw: expectedLatest?.raw, bypassPrepared: forceRefresh });
    const responseCacheStatus = cftcHistoryResponseCacheStatus(source.cacheStatus);
    const response = cftcPublicationStatus(buildCftcHistoryResponse({ family, code, group, throughDate, window, rawRows: source.rows, retrievedAt: source.retrievedAt, sourceUrl: source.sourceUrl, cacheStatus: responseCacheStatus, retrieval: { origin_scope: source.originScope, scope_rows: source.rows.length, source_rows: source.sourceRows, source_pages: source.pages, source_page_size: source.sourcePageSize, cap_reached: Boolean(source.capReached), bounded_scope_rows: 600, bounded_source_rows: source.sourceRowLimit } }), {
      cacheRequired: warmCacheEnabled(),
      rawHistoryExpected: warmCacheEnabled() ? 1 : 0,
      rawHistoryPersisted: source.cachePersisted === true || source.cacheStatus === 'prepared' ? 1 : 0,
    });
    const savedAt = new Date().toISOString();
    const preparedResponse = presentCftcResponse(response, { savedAt, cacheStatus: responseCacheStatus, requireCurrent: reportDate === 'latest' });
    const allowLastGood = preparedResponse.status === 'ready' && (reportDate !== 'latest' || preparedResponse.freshness.source_currency === 'current');
    return publishPreparedResponse({ cacheId, lastGoodId: `history-last-good:${family}:${code}:${group}:${throughDate}:${window}`, response: preparedResponse, savedAt, signal: operationSignal, allowLastGood });
  } catch (error) {
    if (error?.code === 'CFTC_REQUEST_CANCELLED' || error?.code === 'CFTC_SOURCE_CONFLICT') throw error;
    const lastGood = await boundedOperation(warmGet(CFTC_CACHE_NAMESPACE, `history-last-good:${family}:${code}:${group}:${throughDate}:${window}`), deadlineSignal(undefined, 3500));
    const selected = [cachedValid ? cached : null, lastGood].find(envelope => validHistoryEnvelope(envelope, family, code, group, throughDate, window, Date.now()) && historyResponseMatchesExpected(envelope.response, expected, family) && cacheAge(envelope) >= 0 && cacheAge(envelope) < CFTC_STALE_MAX_MS);
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
    const resumable = validCftcRefreshCheckpoint(prior, now) && !prior.complete && now - Date.parse(prior.started_at) < CFTC_REFRESH_RESUME_MS;
    let checkpoint = resumable ? prior : { schema_version: CFTC_REFRESH_CHECKPOINT_VERSION, started_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), complete: false, families: {} };
    async function persist() {
      checkpoint = { ...checkpoint, updated_at: new Date().toISOString() };
      const stored = await boundedOperation(warmSet(CFTC_CACHE_NAMESPACE, 'refresh-checkpoint', checkpoint, 3 * 86400), jobSignal);
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
