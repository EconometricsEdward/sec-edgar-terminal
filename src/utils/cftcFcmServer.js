import { isDeepStrictEqual } from 'node:util';
import { CFTC_FCM_INDEX_URL, CFTC_FCM_DEFINITIONS_URL, CFTC_FCM_MAX_BYTES, CFTC_FCM_SCHEMA_VERSION, CFTC_FCM_NUMERIC_FIELDS, CftcFcmError, buildFcmSnapshot, deriveFcmFinancials, discoverFcmReports, fcmEntityId, fcmIsoDate, isOfficialFcmUrl, parseFcmWorkbook } from './cftcFcm.js';
import { cacheDeploymentScope } from './cacheScope.js';
import { isCftcEnabled } from './cftcFeature.js';
import { warmAcquireLease, warmCacheEnabled, warmGet, warmReleaseLease, warmSet } from './warmCache.js';

export const CFTC_FCM_CACHE_NAMESPACE = `edgar.cftc-fcm.v1:${cacheDeploymentScope()}`;
export const CFTC_FCM_FRESH_MS = 12 * 3600_000;
export const CFTC_FCM_STALE_MAX_MS = 7 * 86400_000;
export const CFTC_FCM_SOURCE_MAX_DAYS = 100;
const LOAD_BUDGET_MS = 42_000;

function requestError(error, signal) {
  if (error instanceof CftcFcmError) return error;
  if (signal?.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)) return new CftcFcmError('The bounded CFTC FCM request timed out or was cancelled.', { code: 'CFTC_FCM_TIMEOUT', status: 504 });
  return new CftcFcmError('The official CFTC FCM source could not be reached.', { code: 'CFTC_FCM_UNAVAILABLE', status: 503 });
}

async function boundedBody(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > CFTC_FCM_MAX_BYTES) throw new CftcFcmError('The CFTC FCM response exceeded its byte limit.', { code: 'CFTC_FCM_RESPONSE_TOO_LARGE' });
  if (!response.body) throw new CftcFcmError('The CFTC FCM source returned no response body.');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CFTC_FCM_MAX_BYTES) throw new CftcFcmError('The CFTC FCM response exceeded its byte limit.', { code: 'CFTC_FCM_RESPONSE_TOO_LARGE' });
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

/** Only the CFTC index and workbook URLs discovered on that index are fetched. */
export async function fetchFcmSource(url, { fetchImpl = (...args) => fetch(...args), signal } = {}) {
  if (!isOfficialFcmUrl(url) && !isOfficialFcmUrl(url, { workbook: true })) throw new CftcFcmError('The FCM source URL is outside the official allowlist.', { code: 'CFTC_FCM_SOURCE_URL_INVALID', status: 400 });
  const timeout = AbortSignal.timeout(10_000), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: url === CFTC_FCM_INDEX_URL ? 'text/html' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'User-Agent': 'EDGAR-Terminal/1.0 public-financial-research (+https://secedgarterminal.com/about)' },
      cache: 'no-store', redirect: 'error', signal: requestSignal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new CftcFcmError(`The official CFTC FCM source returned HTTP ${response.status}.`, { code: response.status === 429 ? 'CFTC_FCM_RATE_LIMITED' : 'CFTC_FCM_SOURCE_HTTP_ERROR', status: response.status >= 500 || response.status === 429 ? 503 : 502 });
    }
    return await boundedBody(response);
  } catch (error) { throw requestError(error, requestSignal); }
}

function sourceAgeDays(snapshot, now) { return Math.max(0, Math.floor((now - Date.parse(`${snapshot.reportDate}T00:00:00Z`)) / 86400_000)); }

function validCachedFirm(firm, source) {
  if (!firm || typeof firm.legalName !== 'string' || !firm.legalName.trim() || firm.legalName.length > 180 || /[\x00-\x1f]/.test(firm.legalName)) return false;
  if (firm.id !== fcmEntityId(firm.legalName) || firm.units !== 'USD' || firm.nfaId !== null || firm.identityBasis !== 'published-legal-name') return false;
  if (typeof firm.registration !== 'string' || !/\b(?:FCM|RFED|FCMRFD)\b/.test(firm.registration) || typeof firm.dsro !== 'string' || !Number.isSafeInteger(firm.sourceRow) || firm.sourceRow < 1 || firm.sourceRow > 99999) return false;
  if (firm.sourceReportDate !== source.reportDate || firm.sourceUrl !== source.url || typeof firm.reportDate !== 'string' || fcmIsoDate(firm.reportDate) !== firm.reportDate || firm.reportDate > source.reportDate) return false;
  if (!CFTC_FCM_NUMERIC_FIELDS.every(key => firm[key] === null || Number.isSafeInteger(firm[key])) || (firm.netCapitalRequirement !== null && firm.netCapitalRequirement < 0)) return false;
  const recomputed = deriveFcmFinancials(firm);
  return Object.keys(recomputed).every(key => isDeepStrictEqual(firm[key], recomputed[key]));
}

export function isUsableFcmSnapshot(snapshot, now = Date.now()) {
  if (snapshot?.schema_version !== CFTC_FCM_SCHEMA_VERSION || snapshot.units !== 'USD' || typeof snapshot.reportDate !== 'string' || typeof snapshot.previousReportDate !== 'string' || typeof snapshot.retrievedAt !== 'string' || fcmIsoDate(snapshot.reportDate) !== snapshot.reportDate || fcmIsoDate(snapshot.previousReportDate) !== snapshot.previousReportDate || snapshot.previousReportDate >= snapshot.reportDate) return false;
  const retrievalAge = now - Date.parse(snapshot.retrievedAt);
  if (!Number.isFinite(retrievalAge) || retrievalAge < -60_000 || retrievalAge > CFTC_FCM_STALE_MAX_MS || Date.parse(snapshot.reportDate) > now || sourceAgeDays(snapshot, now) > CFTC_FCM_SOURCE_MAX_DAYS) return false;
  if (!Array.isArray(snapshot.firms) || !snapshot.firms.length || snapshot.firms.length > 500 || !Array.isArray(snapshot.warnings) || !Array.isArray(snapshot.source?.reports) || snapshot.source.reports.length !== 2) return false;
  if (snapshot.source.publisher !== 'CFTC' || snapshot.source.indexUrl !== CFTC_FCM_INDEX_URL || snapshot.source.definitionsUrl !== CFTC_FCM_DEFINITIONS_URL) return false;
  const [currentSource, priorSource] = snapshot.source.reports;
  if (!currentSource || !priorSource || currentSource.reportDate !== snapshot.reportDate || priorSource.reportDate !== snapshot.previousReportDate || currentSource.url === priorSource.url) return false;
  if (![currentSource, priorSource].every(source => isOfficialFcmUrl(source.url, { workbook: true }))) return false;
  const ids = new Set(), currentFirms = [], previousFirms = [];
  for (const firm of snapshot.firms) {
    if (!validCachedFirm(firm, currentSource) || ids.has(firm.id)) return false;
    ids.add(firm.id);
    if (firm.previous !== null) {
      if (!validCachedFirm(firm.previous, priorSource) || firm.previous.id !== firm.id) return false;
      previousFirms.push(firm.previous);
    }
    const raw = { ...firm };
    delete raw.previous; delete raw.changes; delete raw.comparisonStatus;
    currentFirms.push(raw);
  }
  // Treat the cached envelope as untrusted. Rebuild comparisons and all public
  // methodology/notes from verified raw rows, then reject any disagreement.
  // In particular, a changed ratio, prior month, change value, source linkage,
  // or missing-data annotation can never be served as warm or last-good data.
  const rebuilt = buildFcmSnapshot({ ...currentSource, firms: currentFirms }, { ...priorSource, firms: previousFirms }, snapshot.retrievedAt);
  return isDeepStrictEqual(snapshot, rebuilt);
}

function withFreshness(snapshot, cacheStatus, now, fallbackError = null) {
  const age = sourceAgeDays(snapshot, now), stale = cacheStatus.startsWith('stale'), aged = age > 75;
  return {
    ...snapshot, status: stale || aged ? 'degraded' : 'ready',
    freshness: { cacheStatus, stale, sourceAgeDays: age, sourceCurrency: aged ? 'aged' : 'current', retrievalAgeSeconds: Math.max(0, Math.floor((now - Date.parse(snapshot.retrievedAt)) / 1000)), checkedAt: new Date(now).toISOString() },
    warnings: [...snapshot.warnings, ...(stale ? ['The latest refresh failed. A previously verified CFTC snapshot is shown with its original dates.'] : []), ...(aged ? ['The latest verified source report is more than 75 days old. Review its reporting date before use.'] : [])],
    ...(fallbackError ? { refreshError: { code: fallbackError.code || 'CFTC_FCM_UNAVAILABLE', message: fallbackError.message } } : {}),
  };
}

function awaitSignal(task, signal) {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(requestError(signal.reason, signal));
  let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => reject(requestError(signal.reason, signal));
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([task, cancelled]).finally(() => signal.removeEventListener('abort', listener));
}

/** Separate cache and refresh lease: this integration never changes COT transport state. */
export function createFcmLoader({
  fetchImpl = (...args) => fetch(...args), now = () => Date.now(), readCache = () => warmGet(CFTC_FCM_CACHE_NAMESPACE, 'latest'),
  writeCache = snapshot => warmSet(CFTC_FCM_CACHE_NAMESPACE, 'latest', snapshot, CFTC_FCM_STALE_MAX_MS / 1000),
  sharedEnabled = warmCacheEnabled, acquireLease = () => warmAcquireLease(CFTC_FCM_CACHE_NAMESPACE, 'refresh', 55_000),
  releaseLease = token => warmReleaseLease(CFTC_FCM_CACHE_NAMESPACE, 'refresh', token), enabled = isCftcEnabled,
} = {}) {
  let memory = null, inFlight = null, retryAfter = 0, lastError = null;

  async function refresh() {
    const signal = AbortSignal.timeout(LOAD_BUDGET_MS); let lease = null;
    try {
      if (sharedEnabled()) {
        lease = await acquireLease();
        if (!lease) throw new CftcFcmError('A CFTC FCM refresh is already in progress. Please retry shortly.', { code: 'CFTC_FCM_REFRESH_BUSY', status: 503 });
      }
      const index = await fetchFcmSource(CFTC_FCM_INDEX_URL, { fetchImpl, signal });
      const reports = discoverFcmReports(index.toString('utf8'), new Date(now()));
      const current = parseFcmWorkbook(await fetchFcmSource(reports[0].url, { fetchImpl, signal }), reports[0]);
      const previous = parseFcmWorkbook(await fetchFcmSource(reports[1].url, { fetchImpl, signal }), reports[1]);
      const snapshot = buildFcmSnapshot(current, previous, new Date(now()).toISOString());
      if (!isUsableFcmSnapshot(snapshot, now())) throw new CftcFcmError('The latest CFTC FCM financial report is outside the supported freshness range or failed validation.', { code: 'CFTC_FCM_REPORT_UNAVAILABLE', status: 503 });
      memory = snapshot; lastError = null; retryAfter = 0;
      await writeCache(snapshot).catch(() => false);
      return withFreshness(snapshot, 'source', now());
    } catch (cause) {
      const error = requestError(cause, signal);
      lastError = error; retryAfter = now() + 60_000;
      if (isUsableFcmSnapshot(memory, now())) return withFreshness(memory, 'stale-last-good', now(), error);
      throw error;
    } finally {
      if (lease) await releaseLease(lease).catch(() => false);
    }
  }

  async function load({ signal } = {}) {
    if (!enabled()) throw new CftcFcmError('CFTC data is currently disabled.', { code: 'CFTC_DISABLED', status: 503 });
    if (signal?.aborted) throw requestError(signal.reason, signal);
    if (isUsableFcmSnapshot(memory, now()) && now() - Date.parse(memory.retrievedAt) <= CFTC_FCM_FRESH_MS) return withFreshness(memory, 'memory', now());
    if (inFlight) return awaitSignal(inFlight, signal);
    // Set the shared promise before awaiting the cache to coalesce cold starts.
    inFlight = (async () => {
      const cached = await readCache().catch(() => null);
      if (isUsableFcmSnapshot(cached, now()) && (!isUsableFcmSnapshot(memory, now()) || Date.parse(cached.retrievedAt) > Date.parse(memory.retrievedAt))) memory = cached;
      if (isUsableFcmSnapshot(memory, now()) && now() - Date.parse(memory.retrievedAt) <= CFTC_FCM_FRESH_MS) return withFreshness(memory, 'warm', now());
      if (retryAfter > now()) {
        if (isUsableFcmSnapshot(memory, now())) return withFreshness(memory, 'stale-last-good', now(), lastError);
        throw lastError || new CftcFcmError('Please retry the CFTC FCM request shortly.', { status: 503 });
      }
      return refresh();
    })().finally(() => { inFlight = null; });
    return awaitSignal(inFlight, signal);
  }
  return { load };
}

const loader = createFcmLoader();
export const loadCftcFcm = options => loader.load(options);
