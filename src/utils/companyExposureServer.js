import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getOperatingTicker } from './tickerMap.js';
import { secFetch } from './secClient.js';
import { extractFilingReaderText, readBoundedFilingResponse } from './filingsReader.js';
import { buildFilingUrl } from './filingTextParser.js';
import { warmGet, warmSet } from './warmCache.js';
import { cacheDeploymentScope } from './cacheScope.js';
import { isCftcEnabled } from './cftcFeature.js';
import { cftcDate } from './cftc.js';
import { parseCompanyCftcRequest } from './companyCftc.js';
import { COMPANY_EXPOSURE_SCHEMA_VERSION, COMPANY_EXPOSURE_MAX_TEXT, COMPANY_EXPOSURE_LIMITATIONS, extractCompanyExposureMap } from './companyExposure.js';

export const COMPANY_EXPOSURE_CACHE_NAMESPACE = `edgar.company-exposure-sources.v1:${cacheDeploymentScope()}`;
export const COMPANY_EXPOSURE_MAX_HISTORY_FILES = 2;
const MAX_DOCUMENT_BYTES = 24_000_000, LOAD_BUDGET_MS = 45_000;
const cache = new Map(), inFlight = new Map();
const ANNUAL_FORMS = new Set(['10-K', '20-F', '40-F']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const error = (message, code, status = 503) => Object.assign(new Error(message), { code, status });

export const parseCompanyExposureRequest = parseCompanyCftcRequest;
const validDate = value => typeof value === 'string' && DATE_PATTERN.test(value) && cftcDate(value) === value;
const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

async function bounded(task, signal) {
  if (!signal) return task;
  if (signal.aborted) { Promise.resolve(task).catch(() => {}); throw error('The SEC source request reached its time limit. Please retry.', 'COMPANY_EXPOSURE_TIMEOUT'); }
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(error('The SEC source request reached its time limit. Please retry.', 'COMPANY_EXPOSURE_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([task, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function submissionsJson(file, signal) {
  if (!/^CIK\d{10}(?:-submissions-\d+)?\.json$/.test(file)) throw error('Unsupported SEC submissions identity.', 'SEC_SOURCE_INVALID', 502);
  const response = await secFetch(`https://data.sec.gov/submissions/${file}`, {
    signal, timeoutMs: 10_000, retries: 1, maxBytes: 8 * 1024 * 1024,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw error('The SEC filing manifest is temporarily unavailable.', 'SEC_SUBMISSIONS_UNAVAILABLE');
  return response.json();
}

/** The existing reader parser removes hidden XBRL facts and preserves visible text.
 * This endpoint keeps its own source cache so retrieval dates and document bindings
 * can be verified, rather than relabeling an older reader-cache access as a download. */
async function filingText(cik, filing, { signal } = {}) {
  const response = await secFetch(filing.url, {
    signal, timeoutMs: 18_000, retries: 1, maxBytes: MAX_DOCUMENT_BYTES, redirect: 'error',
    headers: { Accept: 'text/html,text/plain' },
  });
  if (!response.ok) throw error('The eligible SEC document is temporarily unavailable.', 'SEC_FILING_TEXT_UNAVAILABLE');
  if (/application\/pdf|image\/|application\/(?:zip|octet-stream)/i.test(response.headers.get('content-type') || '')) {
    throw error('The eligible SEC document is not readable text.', 'SEC_FILING_FORMAT_UNSUPPORTED', 422);
  }
  const parsed = extractFilingReaderText(await readBoundedFilingResponse(response, MAX_DOCUMENT_BYTES), filing.primaryDoc);
  return { ...parsed, retrievedAt: new Date().toISOString() };
}

/** A document's accession may belong to its filing agent, so it need not begin
 * with the issuer CIK. Identity comes from the issuer's own submissions manifest. */
export function companyExposureFilings(recent, cik, cutoff) {
  if (!/^\d{10}$/.test(String(cik))) return [];
  return (Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : []).flatMap((accession, i) => {
    const form = recent.form?.[i], filed = recent.filingDate?.[i], reportDate = recent.reportDate?.[i];
    const primaryDoc = recent.primaryDocument?.[i];
    if ((!ANNUAL_FORMS.has(form) && form !== '10-Q') || !/^\d{10}-\d{2}-\d{6}$/.test(accession)
      || !validDate(filed) || filed > cutoff || !validDate(reportDate) || reportDate > filed
      || typeof primaryDoc !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(primaryDoc)) return [];
    return [{ form, filed, reportDate, accession, primaryDoc, url: buildFilingUrl(cik, accession, primaryDoc) }];
  }).sort((a, b) => b.filed.localeCompare(a.filed) || b.reportDate.localeCompare(a.reportDate) || b.accession.localeCompare(a.accession));
}

export function selectCompanyExposureFilings(filings) {
  const ordered = [...filings].sort((a, b) => b.filed.localeCompare(a.filed) || b.reportDate.localeCompare(a.reportDate) || b.accession.localeCompare(a.accession));
  const annual = ordered.find(filing => ANNUAL_FORMS.has(filing.form));
  const quarterly = ordered.find(filing => filing.form === '10-Q' && (!annual || (filing.filed > annual.filed && filing.reportDate > annual.reportDate)));
  return [annual && { ...annual, role: 'annual' }, quarterly && { ...quarterly, role: 'quarterly' }].filter(Boolean);
}

function initialResult(selection, now) {
  const checkedAt = new Date(now).toISOString();
  return {
    schemaVersion: COMPANY_EXPOSURE_SCHEMA_VERSION, ...selection, cik: null, companyName: null,
    checkedAt, generatedAt: checkedAt, status: 'unavailable', retryable: true, sources: [], rows: [],
    coverage: { historyFilesScanned: 0, historyLimited: false, searchComplete: true, historyFailures: [],
      filingsEligible: 0, filingsScanned: 0, filingsFailed: 0, filings: [],
      annualAvailable: false, quarterlyAvailable: false, maxHistoryFiles: COMPANY_EXPOSURE_MAX_HISTORY_FILES, maxDocumentBytes: MAX_DOCUMENT_BYTES },
    limitations: [...COMPANY_EXPOSURE_LIMITATIONS,
      'The map searches the latest eligible complete annual report and at most one newer complete 10-Q. Annual and quarterly passages remain separately dated and are not a combined current balance.',
      'Amendments, 6-K attachments, exhibits, predecessor entities, and table amounts without readable narrative context are outside this search. A missing match does not establish that an exposure is absent.',
      'The filing-date cutoff limits SEC evidence. It does not establish when CFTC market observations became publicly available.'],
  };
}

function fillDerived(result, inputs) {
  const extracted = extractCompanyExposureMap(inputs, { companyName: result.companyName, ticker: result.ticker });
  result.rows = extracted.rows;
  Object.assign(result.coverage, extracted.coverage);
  result.coverage.filingsScanned = inputs.length;
  result.coverage.filingsFailed = result.sources.filter(source => source.status === 'unavailable').length;
  result.coverage.annualAvailable = inputs.some(source => source.role === 'annual');
  result.coverage.quarterlyAvailable = inputs.some(source => source.role === 'quarterly');
  if (!inputs.length) {
    result.status = result.sources.length || !result.coverage.searchComplete ? 'unavailable' : 'no_filing';
    result.message = result.status === 'no_filing'
      ? 'No eligible complete annual or quarterly report was found within the bounded SEC filing search.'
      : 'The eligible SEC filing evidence could not be loaded. The unavailable sources remain identified below; retry to obtain their passages.';
  } else if (result.coverage.filingsFailed || !result.coverage.searchComplete) {
    result.status = 'partial';
    result.message = 'Only part of the eligible evidence was retrieved. The map uses the successful sources; unavailable or unsearched sources may change the picture.';
  } else {
    result.status = result.rows.length ? 'ready' : 'no_matches';
    if (!result.rows.length) result.message = 'No sufficiently specific exposure passages matched this bounded narrative search. This does not mean the company has no market exposure.';
  }
  result.retryable = result.status === 'unavailable' || result.status === 'partial';
  return result;
}

/** Injectable transport verifies source selection, partial outages and date limits
 * without fixtures becoming an alternate runtime data source. */
export async function discoverCompanyExposures(selection, {
  now = new Date(), signal, lookupTicker = getOperatingTicker, loadSubmissions = submissionsJson, loadFilingText = filingText, onSnapshot,
} = {}) {
  const checked = parseCompanyExposureRequest(`https://example.test/?ticker=${encodeURIComponent(selection.ticker || '')}${selection.asOf == null ? '' : `&asOf=${encodeURIComponent(selection.asOf)}`}`, now);
  const result = initialResult(checked, now), cutoff = checked.asOf || result.checkedAt.slice(0, 10);
  try {
    const entry = await bounded(lookupTicker(checked.ticker), signal);
    if (!entry) throw error('No SEC operating company matched that ticker.', 'COMPANY_NOT_FOUND', 404);
    const cik = String(entry.cik).padStart(10, '0');
    if (!/^\d{10}$/.test(cik)) throw error('The SEC company identifier was invalid.', 'SEC_SOURCE_INVALID', 502);
    result.cik = cik; result.companyName = String(entry.name || checked.ticker).slice(0, 500);
    const manifest = await bounded(loadSubmissions(`CIK${cik}.json`, signal), signal);
    if (String(manifest?.cik).padStart(10, '0') !== cik || !Array.isArray(manifest?.filings?.recent?.accessionNumber)) {
      throw error('The SEC manifest did not verify the selected company identity.', 'SEC_SOURCE_IDENTITY_MISMATCH', 502);
    }
    if (typeof manifest.name === 'string' && manifest.name.trim()) result.companyName = manifest.name.slice(0, 500);
    let filings = companyExposureFilings(manifest.filings.recent, cik, cutoff);
    const historyFiles = (Array.isArray(manifest.filings.files) ? manifest.filings.files : [])
      .filter(file => new RegExp(`^CIK${cik}-submissions-\\d+\\.json$`).test(file.name)
        && validDate(file.filingFrom) && validDate(file.filingTo) && file.filingFrom <= cutoff && file.filingFrom <= file.filingTo)
      .sort((a, b) => b.filingTo.localeCompare(a.filingTo));
    for (const file of historyFiles) {
      const annual = selectCompanyExposureFilings(filings).find(filing => filing.role === 'annual');
      // An older archive cannot supersede the selected annual or contain a later quarter.
      if (annual && file.filingTo < annual.filed) break;
      if (result.coverage.historyFilesScanned === COMPANY_EXPOSURE_MAX_HISTORY_FILES) {
        result.coverage.historyLimited = true; result.coverage.searchComplete = false; break;
      }
      result.coverage.historyFilesScanned += 1;
      try {
        const historic = await bounded(loadSubmissions(file.name, signal), signal);
        if (!Array.isArray(historic?.accessionNumber)) throw error('The SEC history manifest was not readable.', 'SEC_HISTORY_INVALID', 502);
        filings = filings.concat(companyExposureFilings(historic, cik, cutoff));
      } catch (cause) {
        result.coverage.searchComplete = false;
        result.coverage.historyFailures.push({ name: file.name, code: cause.code || 'SEC_HISTORY_UNAVAILABLE', message: 'This SEC history file could not be checked; later or additional eligible reports may be missing.' });
      }
    }
    const selected = selectCompanyExposureFilings(filings);
    result.coverage.filingsEligible = selected.length;
    const outcomes = await Promise.all(selected.map(async ({ role, ...filing }) => {
      const source = { ...filing, role, status: 'unavailable', retrievedAt: null };
      try {
        const loaded = await bounded(loadFilingText(cik, filing, { signal }), signal);
        if (loaded?.error || typeof loaded?.text !== 'string' || loaded.text.trim().length < 30) {
          throw error('The eligible SEC filing did not return usable narrative text.', 'SEC_FILING_TEXT_UNAVAILABLE');
        }
        // Injected loaders may omit a timestamp; the real loader always records
        // the completed download. checkedAt remains the manifest-check time.
        const retrievedAt = loaded.retrievedAt || new Date(now).toISOString();
        if (!validTime(retrievedAt)) throw error('The SEC source retrieval timestamp could not be verified.', 'SEC_SOURCE_INVALID', 502);
        source.status = 'ready'; source.retrievedAt = retrievedAt;
        source.textCharactersRetrieved = loaded.text.length;
        return { source, input: { text: loaded.text, filing, role } };
      } catch (cause) {
        source.code = cause.code || 'SEC_FILING_TEXT_UNAVAILABLE';
        source.message = 'This eligible report could not be read. Its missing passages have not been replaced with an older report.';
        return { source, input: null };
      }
    }));
    result.sources = outcomes.map(item => item.source);
    const inputs = outcomes.map(item => item.input).filter(Boolean);
    fillDerived(result, inputs);
    if (['ready', 'no_matches', 'no_filing'].includes(result.status)) onSnapshot?.(encodeCompanyExposureSnapshot(result, inputs));
    return result;
  } catch (cause) {
    if (cause.status === 404) throw cause;
    result.coverage.searchComplete = false;
    result.code = cause.code || 'SEC_EXPOSURE_UNAVAILABLE';
    result.message = 'The company’s SEC filing evidence is temporarily unavailable. Retry to load verifiable sources.';
    return result;
  }
}

function binding(source, cik, text) {
  return createHash('sha256').update(JSON.stringify([cik, source.role, source.form, source.filed, source.reportDate, source.accession, source.primaryDoc, source.url, source.retrievedAt, source.textCharactersRetrieved, text])).digest('hex');
}

function snapshotIntegrity(snapshot) {
  return createHash('sha256').update(JSON.stringify([snapshot.cacheVersion, snapshot.ticker, snapshot.asOf, snapshot.cik,
    snapshot.companyName, snapshot.checkedAt, snapshot.historyFilesScanned, snapshot.sources.map(source => source.digest)])).digest('hex');
}

/** Persist source text, not classifications or exposure amounts. A cache hit
 * reruns the current extraction engine and recreates all derived fields. */
export function encodeCompanyExposureSnapshot(result, inputs) {
  const snapshot = {
    cacheVersion: COMPANY_EXPOSURE_SCHEMA_VERSION, ticker: result.ticker, asOf: result.asOf,
    cik: result.cik, companyName: result.companyName, checkedAt: result.checkedAt,
    historyFilesScanned: result.coverage.historyFilesScanned,
    sources: result.sources.map(source => {
      const input = inputs.find(item => item.filing.accession === source.accession && item.role === source.role);
      const text = input.text.slice(0, COMPANY_EXPOSURE_MAX_TEXT + 1);
      return { ...source, gzip: gzipSync(text).toString('base64'), digest: binding(source, result.cik, text) };
    }),
  };
  return { ...snapshot, integrity: snapshotIntegrity(snapshot) };
}

export function restoreCompanyExposureSnapshot(snapshot, selection, now = new Date()) {
  try {
    const currentTime = new Date(now).getTime();
    if (snapshot?.cacheVersion !== COMPANY_EXPOSURE_SCHEMA_VERSION || snapshot.ticker !== selection.ticker || snapshot.asOf !== selection.asOf
      || !/^\d{10}$/.test(snapshot.cik) || typeof snapshot.companyName !== 'string' || !snapshot.companyName.trim() || snapshot.companyName.length > 500
      || !validTime(snapshot.checkedAt) || Date.parse(snapshot.checkedAt) > currentTime
      || !Number.isInteger(snapshot.historyFilesScanned) || snapshot.historyFilesScanned < 0 || snapshot.historyFilesScanned > COMPANY_EXPOSURE_MAX_HISTORY_FILES
      || !Array.isArray(snapshot.sources) || snapshot.sources.length > 2
      || !/^[a-f\d]{64}$/.test(snapshot.integrity) || snapshotIntegrity(snapshot) !== snapshot.integrity) return null;
    const cutoff = selection.asOf || snapshot.checkedAt.slice(0, 10), seenRoles = new Set();
    const inputs = [], sources = [];
    for (const raw of snapshot.sources) {
      if (!['annual', 'quarterly'].includes(raw.role) || seenRoles.has(raw.role) || raw.status !== 'ready'
        || (raw.role === 'annual' ? !ANNUAL_FORMS.has(raw.form) : raw.form !== '10-Q')
        || !validTime(raw.retrievedAt) || Date.parse(raw.retrievedAt) < Date.parse(snapshot.checkedAt) || Date.parse(raw.retrievedAt) > currentTime
        || !Number.isInteger(raw.textCharactersRetrieved) || raw.textCharactersRetrieved < 30 || raw.textCharactersRetrieved > MAX_DOCUMENT_BYTES
        || typeof raw.gzip !== 'string' || raw.gzip.length > 3_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.gzip) || !/^[a-f\d]{64}$/.test(raw.digest)) return null;
      const validated = companyExposureFilings({ accessionNumber: [raw.accession], form: [raw.form], filingDate: [raw.filed], reportDate: [raw.reportDate], primaryDocument: [raw.primaryDoc] }, snapshot.cik, cutoff)[0];
      if (!validated || validated.url !== raw.url) return null;
      const text = gunzipSync(Buffer.from(raw.gzip, 'base64'), { maxOutputLength: (COMPANY_EXPOSURE_MAX_TEXT + 1) * 4 }).toString('utf8');
      if (text.trim().length < 30 || text.length !== Math.min(raw.textCharactersRetrieved, COMPANY_EXPOSURE_MAX_TEXT + 1) || binding(raw, snapshot.cik, text) !== raw.digest) return null;
      const source = { ...validated, role: raw.role, status: 'ready', retrievedAt: raw.retrievedAt, textCharactersRetrieved: raw.textCharactersRetrieved };
      seenRoles.add(raw.role); sources.push(source); inputs.push({ filing: validated, role: raw.role, text });
    }
    const selected = selectCompanyExposureFilings(sources);
    if (selected.length !== sources.length || selected.some((filing, i) => filing.accession !== sources[i].accession || filing.role !== sources[i].role)) return null;
    const result = initialResult(selection, snapshot.checkedAt);
    result.companyName = snapshot.companyName; result.cik = snapshot.cik; result.sources = sources;
    result.generatedAt = new Date(now).toISOString();
    result.coverage.historyFilesScanned = snapshot.historyFilesScanned; result.coverage.filingsEligible = sources.length;
    return fillDerived(result, inputs);
  } catch { return null; }
}

function ttlFor(result) { return result.status === 'ready' ? 6 * 3600 : result.status === 'no_matches' ? 3600 : 900; }
function remember(key, value, ttl) {
  const time = Date.now();
  for (const [id, item] of cache) if (item.expires <= time) cache.delete(id);
  while (cache.size >= 80) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: time + ttl * 1000 });
}

export async function loadCompanyExposures(selection, { signal } = {}) {
  if (!isCftcEnabled()) throw error('CFTC company exposure research is disabled.', 'CFTC_DISABLED');
  const checked = parseCompanyExposureRequest(`https://example.test/?ticker=${encodeURIComponent(selection.ticker || '')}${selection.asOf == null ? '' : `&asOf=${encodeURIComponent(selection.asOf)}`}`);
  const key = `${checked.ticker}:${checked.asOf || 'latest'}`, local = cache.get(key);
  if (local && local.expires > Date.now()) return local.value;
  if (inFlight.has(key)) return bounded(inFlight.get(key), signal);
  if (inFlight.size >= 24) throw error('Company exposure research is busy. Please retry.', 'COMPANY_EXPOSURE_BUSY');
  const task = (async () => {
    const stored = await warmGet(COMPANY_EXPOSURE_CACHE_NAMESPACE, key);
    const restored = restoreCompanyExposureSnapshot(stored, checked);
    if (restored) {
      const age = Date.now() - Date.parse(restored.checkedAt), ttl = ttlFor(restored);
      if (age >= 0 && age < ttl * 1000) { remember(key, restored, Math.max(1, ttl - age / 1000)); return restored; }
    }
    let snapshot;
    const value = await discoverCompanyExposures(checked, { signal: AbortSignal.timeout(LOAD_BUDGET_MS), onSnapshot: prepared => { snapshot = prepared; } });
    if (snapshot) {
      const ttl = ttlFor(value);
      remember(key, value, ttl);
      await warmSet(COMPANY_EXPOSURE_CACHE_NAMESPACE, key, snapshot, ttl);
    }
    return value;
  })();
  inFlight.set(key, task);
  task.finally(() => inFlight.delete(key)).catch(() => {});
  return bounded(task, signal);
}
