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
import { companyExposureRevisionCache } from './companyExposureRevisionCache.js';

export const COMPANY_EXPOSURE_CACHE_NAMESPACE = `edgar.company-exposure-sources.v1:${cacheDeploymentScope()}`;
export const COMPANY_EXPOSURE_MAX_HISTORY_FILES = 2;
export const COMPANY_EXPOSURE_SOURCE_RETENTION_SECONDS = 25 * 3600;
const MAX_DOCUMENT_BYTES = 24_000_000, LOAD_BUDGET_MS = 45_000;
const MAX_LOCAL_CACHE_BYTES = 16 * 1024 * 1024;
const ANNUAL_FORMS = new Set(['10-K', '20-F', '40-F']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const error = (message, code, status = 503) => Object.assign(new Error(message), { code, status });

export const parseCompanyExposureRequest = parseCompanyCftcRequest;
const validDate = value => typeof value === 'string' && DATE_PATTERN.test(value) && cftcDate(value) === value;
const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const completeManifestRows = rows => Array.isArray(rows?.accessionNumber)
  && ['form', 'filingDate', 'reportDate', 'primaryDocument'].every(key => Array.isArray(rows[key]) && rows[key].length === rows.accessionNumber.length);
const sameFiling = (a, b) => ['role', 'form', 'filed', 'reportDate', 'accession', 'primaryDoc', 'url'].every(key => a[key] === b[key]);

/** Internal callers that already proved an issuer CIK must not round-trip
 * through a ticker, which can represent a different security or change over
 * time. The public ticker endpoint keeps its existing request contract. */
export function normalizeCompanyExposureCikRequest(cikInput, asOf = null, now = new Date()) {
  const value = String(cikInput ?? '');
  if (!/^\d{1,10}$/.test(value) || Number(value) <= 0) throw error('Provide a valid SEC issuer CIK.', 'INVALID_CIK', 400);
  if (asOf !== null && (!validDate(asOf) || asOf < '1994-01-01' || asOf > new Date(now).toISOString().slice(0, 10)))
    throw error('Use asOf=YYYY-MM-DD between 1994 and today for the SEC filing-date cutoff.', 'INVALID_AS_OF', 400);
  return { cik: value.padStart(10, '0'), ticker: null, asOf };
}

function normalizeSelection(selection, now = new Date()) {
  if (Object.hasOwn(selection, 'cik')) {
    if (selection.ticker != null) throw error('Use one verified issuer CIK without a ticker alias.', 'INVALID_REQUEST', 400);
    return normalizeCompanyExposureCikRequest(selection.cik, selection.asOf ?? null, now);
  }
  return parseCompanyExposureRequest(`https://example.test/?ticker=${encodeURIComponent(selection.ticker || '')}${selection.asOf == null ? '' : `&asOf=${encodeURIComponent(selection.asOf)}`}`, now);
}

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

function fillDerived(result, inputs, prepared = null) {
  const extracted = prepared || extractCompanyExposureMap(inputs, { companyName: result.companyName, ticker: result.ticker });
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

async function fillPreparedDerived(result, inputs, rawSources, { signal, revisionCache }) {
  signal?.throwIfAborted();
  const cached = inputs.length ? await revisionCache.extraction(result, rawSources, { signal }) : null;
  const extracted = cached?.extracted || extractCompanyExposureMap(inputs, { companyName: result.companyName, ticker: result.ticker });
  if (cached) result.generatedAt = cached.generatedAt;
  fillDerived(result, inputs, extracted);
  if (!cached && inputs.length) await revisionCache.saveExtraction(result, rawSources, extracted, { signal });
  signal?.throwIfAborted();
  return result;
}

function encodedSource(source, cik, input) {
  const text = input.text.slice(0, COMPANY_EXPOSURE_MAX_TEXT + 1);
  return { ...source, gzip: gzipSync(text).toString('base64'), digest: binding(source, cik, text) };
}

function decodeDocumentSource(raw, selection, cik, companyName, now) {
  if (!raw) return null;
  const snapshot = { cacheVersion: COMPANY_EXPOSURE_SCHEMA_VERSION, ticker: selection.ticker, asOf: selection.asOf,
    cik, companyName, checkedAt: new Date(now).toISOString(), historyFilesScanned: 0, sources: [raw] };
  snapshot.integrity = snapshotIntegrity(snapshot);
  return decodeCompanyExposureSnapshot(snapshot, selection, now);
}

/** Injectable transport verifies source selection, partial outages and date limits
 * without fixtures becoming an alternate runtime data source. */
export async function discoverCompanyExposures(selection, {
  now = new Date(), signal, lookupTicker = getOperatingTicker, loadSubmissions = submissionsJson, loadFilingText = filingText, onSnapshot, previousSnapshot,
  revisionCache = companyExposureRevisionCache,
} = {}) {
  const checked = normalizeSelection(selection, now);
  const result = initialResult(checked, now), cutoff = checked.asOf || result.checkedAt.slice(0, 10);
  const previousAge = new Date(now).getTime() - Date.parse(previousSnapshot?.checkedAt);
  const previous = previousAge >= 0 && previousAge < COMPANY_EXPOSURE_SOURCE_RETENTION_SECONDS * 1000
    ? decodeCompanyExposureSnapshot(previousSnapshot, checked, now) : null;
  try {
    const entry = checked.cik ? { cik: checked.cik, name: '' } : await bounded(lookupTicker(checked.ticker), signal);
    if (!entry) throw error('No SEC operating company matched that ticker.', 'COMPANY_NOT_FOUND', 404);
    const cik = String(entry.cik).padStart(10, '0');
    if (!/^\d{10}$/.test(cik) || Number(cik) <= 0) throw error('The SEC company identifier was invalid.', 'SEC_SOURCE_INVALID', 502);
    result.cik = cik; result.companyName = String(entry.name || checked.ticker || '').slice(0, 500);
    const manifest = await bounded(loadSubmissions(`CIK${cik}.json`, signal), signal);
    if (String(manifest?.cik).padStart(10, '0') !== cik || !completeManifestRows(manifest?.filings?.recent)) {
      throw error('The SEC manifest did not verify the selected company identity.', 'SEC_SOURCE_IDENTITY_MISMATCH', 502);
    }
    if (typeof manifest.name === 'string' && manifest.name.trim()) result.companyName = manifest.name.slice(0, 500);
    if (!result.companyName.trim()) throw error('The SEC manifest did not verify the selected issuer name.', 'SEC_SOURCE_IDENTITY_MISMATCH', 502);
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
        if (!completeManifestRows(historic)) throw error('The SEC history manifest was not readable.', 'SEC_HISTORY_INVALID', 502);
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
        // Immutable document identity must still appear in the current issuer
        // manifest. Reuse its verified text without presenting the metadata
        // check as a new download. Partial history remains explicitly partial.
        const reusable = previous?.sources.find(item => sameFiling(item, { ...filing, role }));
        const input = reusable && previous.inputs.find(item => item.role === role && sameFiling({ ...item.filing, role }, source));
        if (previous?.cik === cik && reusable && input) {
          const raw = previousSnapshot.sources.find(item => sameFiling(item, source));
          await revisionCache.saveDocument(cik, raw, { signal });
          return { source: { ...reusable }, input, raw };
        }
        const raw = await revisionCache.document(cik, source, { signal });
        const saved = decodeDocumentSource(raw, checked, cik, result.companyName, now);
        if (saved) return { source: saved.sources[0], input: saved.inputs[0], raw };
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
        const nextInput = { text: loaded.text, filing, role }, nextRaw = encodedSource(source, cik, nextInput);
        await revisionCache.saveDocument(cik, nextRaw, { signal });
        return { source, input: nextInput, raw: nextRaw };
      } catch (cause) {
        source.code = cause.code || 'SEC_FILING_TEXT_UNAVAILABLE';
        source.message = 'This eligible report could not be read. Its missing passages have not been replaced with an older report.';
        return { source, input: null };
      }
    }));
    result.sources = outcomes.map(item => item.source);
    const inputs = outcomes.map(item => item.input).filter(Boolean);
    const rawSources = outcomes.map(item => item.raw).filter(Boolean);
    await fillPreparedDerived(result, inputs, rawSources, { signal, revisionCache });
    if (['ready', 'no_matches', 'no_filing'].includes(result.status)) onSnapshot?.(encodeCompanyExposureSnapshot(result, inputs, rawSources));
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
export function encodeCompanyExposureSnapshot(result, inputs, rawSources = []) {
  const snapshot = {
    cacheVersion: COMPANY_EXPOSURE_SCHEMA_VERSION, ticker: result.ticker, asOf: result.asOf,
    cik: result.cik, companyName: result.companyName, checkedAt: result.checkedAt,
    historyFilesScanned: result.coverage.historyFilesScanned,
    sources: result.sources.map(source => {
      const prepared = rawSources.find(item => sameFiling(item, source));
      if (prepared) return prepared;
      const input = inputs.find(item => item.filing.accession === source.accession && item.role === source.role);
      return encodedSource(source, result.cik, input);
    }),
  };
  return { ...snapshot, integrity: snapshotIntegrity(snapshot) };
}

function decodeCompanyExposureSnapshot(snapshot, selection, now = new Date()) {
  try {
    const currentTime = new Date(now).getTime();
    if (snapshot?.cacheVersion !== COMPANY_EXPOSURE_SCHEMA_VERSION || snapshot.ticker !== selection.ticker || snapshot.asOf !== selection.asOf
      || (selection.cik != null && snapshot.cik !== selection.cik)
      || !/^\d{10}$/.test(snapshot.cik) || Number(snapshot.cik) <= 0 || typeof snapshot.companyName !== 'string' || !snapshot.companyName.trim() || snapshot.companyName.length > 500
      || !validTime(snapshot.checkedAt) || Date.parse(snapshot.checkedAt) > currentTime
      || !Number.isInteger(snapshot.historyFilesScanned) || snapshot.historyFilesScanned < 0 || snapshot.historyFilesScanned > COMPANY_EXPOSURE_MAX_HISTORY_FILES
      || !Array.isArray(snapshot.sources) || snapshot.sources.length > 2
      || !/^[a-f\d]{64}$/.test(snapshot.integrity) || snapshotIntegrity(snapshot) !== snapshot.integrity) return null;
    const cutoff = selection.asOf || snapshot.checkedAt.slice(0, 10), seenRoles = new Set();
    const inputs = [], sources = [];
    for (const raw of snapshot.sources) {
      if (!['annual', 'quarterly'].includes(raw.role) || seenRoles.has(raw.role) || raw.status !== 'ready'
        || (raw.role === 'annual' ? !ANNUAL_FORMS.has(raw.form) : raw.form !== '10-Q')
        || !validTime(raw.retrievedAt) || Date.parse(raw.retrievedAt) < Date.parse(raw.filed) || Date.parse(raw.retrievedAt) > currentTime
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
    return { cik: snapshot.cik, sources, inputs };
  } catch { return null; }
}

export function restoreCompanyExposureSnapshot(snapshot, selection, now = new Date()) {
  const decoded = decodeCompanyExposureSnapshot(snapshot, selection, now);
  if (!decoded) return null;
  const { sources, inputs } = decoded;
  const result = initialResult(selection, snapshot.checkedAt);
  result.companyName = snapshot.companyName; result.cik = snapshot.cik; result.sources = sources;
  result.generatedAt = new Date(now).toISOString();
  result.coverage.historyFilesScanned = snapshot.historyFilesScanned; result.coverage.filingsEligible = sources.length;
  return fillDerived(result, inputs);
}

function ttlFor(result) { return result.status === 'ready' ? 6 * 3600 : result.status === 'no_matches' ? 3600 : 900; }
/** Reuse current-engine derived results within this process. Shared storage
 * continues to hold only verified sources, so cold processes rerun extraction. */
export function createCompanyExposureLoader({ read = warmGet, write = warmSet,
  discover = discoverCompanyExposures, enabled = isCftcEnabled, now = Date.now,
  cacheBytes = MAX_LOCAL_CACHE_BYTES, revisionCache = companyExposureRevisionCache,
} = {}) {
  const cache = new Map(), inFlight = new Map();
  let usedBytes = 0;
  const forget = key => {
    const item = cache.get(key);
    if (item) { usedBytes -= item.bytes; cache.delete(key); }
  };
  const remember = (key, value) => {
    const time = now(), expires = Date.parse(value.checkedAt) + ttlFor(value) * 1000;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (expires <= time || bytes > cacheBytes) return;
    for (const [id, item] of cache) if (item.expires <= time) forget(id);
    forget(key);
    while (cache.size && (cache.size >= 80 || usedBytes + bytes > cacheBytes)) forget(cache.keys().next().value);
    cache.set(key, { value, expires, bytes }); usedBytes += bytes;
  };
  const subscribe = (key, entry, signal) => {
    entry.subscribers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; signal?.removeEventListener('abort', release);
      entry.subscribers--;
      if (!entry.settled && !entry.subscribers) {
        // Another visitor may still need this shared research. Abort SEC work
        // only when its last consumer leaves, and allow a fresh retry at once.
        if (inFlight.get(key) === entry) inFlight.delete(key);
        entry.controller.abort();
      }
    };
    signal?.addEventListener('abort', release, { once: true });
    return bounded(entry.task, signal).finally(release);
  };
  async function restoreFresh(stored, checked, signal) {
    const age = now() - Date.parse(stored?.checkedAt);
    if (age < 0 || !(age < 6 * 3600 * 1000)) return null;
    const decoded = decodeCompanyExposureSnapshot(stored, checked, now());
    if (!decoded) return null;
    const result = initialResult(checked, stored.checkedAt);
    result.companyName = stored.companyName; result.cik = stored.cik; result.sources = decoded.sources;
    result.generatedAt = new Date(now()).toISOString();
    result.coverage.historyFilesScanned = stored.historyFilesScanned; result.coverage.filingsEligible = decoded.sources.length;
    const restored = await fillPreparedDerived(result, decoded.inputs, stored.sources, { signal, revisionCache });
    return Date.parse(restored.checkedAt) + ttlFor(restored) * 1000 > now() ? restored : null;
  }
  const load = async function load(selection, { signal } = {}) {
    if (!enabled()) throw error('CFTC company exposure research is disabled.', 'CFTC_DISABLED');
    const checked = normalizeSelection(selection, now());
    if (signal?.aborted) throw error('The SEC source request reached its time limit. Please retry.', 'COMPANY_EXPOSURE_TIMEOUT');
    const key = `${checked.cik ? `cik:${checked.cik}` : checked.ticker}:${checked.asOf || 'latest'}`, local = cache.get(key);
    if (local && local.expires > now()) {
      cache.delete(key); cache.set(key, local);
      return local.value;
    }
    forget(key);
    if (inFlight.has(key)) return subscribe(key, inFlight.get(key), signal);
    if (inFlight.size >= 24) throw error('Company exposure research is busy. Please retry.', 'COMPANY_EXPOSURE_BUSY');
    const entry = { controller: new AbortController(), subscribers: 0, settled: false, task: null };
    const taskSignal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(LOAD_BUDGET_MS)]);
    const assertActive = () => {
      if (taskSignal.aborted) throw error('The SEC source request reached its time limit. Please retry.', 'COMPANY_EXPOSURE_TIMEOUT');
    };
    entry.task = (async () => {
      const stored = await bounded(read(COMPANY_EXPOSURE_CACHE_NAMESPACE, key), taskSignal);
      assertActive();
      // Freshness and source retention are separate: a due manifest check can
      // reuse unchanged filing text for up to the research cache's 25h cap.
      const restored = await restoreFresh(stored, checked, taskSignal);
      if (restored) {
        remember(key, restored); return restored;
      }
      let snapshot;
      const value = await bounded(discover(checked, { now: new Date(now()), signal: taskSignal, previousSnapshot: stored, revisionCache,
        onSnapshot: prepared => { if (!taskSignal.aborted) snapshot = prepared; } }), taskSignal);
      assertActive();
      if (snapshot && ['ready', 'no_matches', 'no_filing'].includes(value.status) && !value.retryable && value.coverage.searchComplete) {
        // Cache age starts at the manifest check, not the end of a slow fetch.
        const ttl = Math.floor((Date.parse(value.checkedAt) + COMPANY_EXPOSURE_SOURCE_RETENTION_SECONDS * 1000 - now()) / 1000);
        if (ttl > 0) await bounded(write(COMPANY_EXPOSURE_CACHE_NAMESPACE, key, snapshot, ttl), taskSignal);
        assertActive();
        remember(key, value);
      }
      return value;
    })();
    inFlight.set(key, entry);
    entry.task.finally(() => {
      entry.settled = true;
      // A cancelled task may finish after a replacement has already started.
      if (inFlight.get(key) === entry) inFlight.delete(key);
    }).catch(() => {});
    return subscribe(key, entry, signal);
  };
  // Cache-only reads may regenerate the current extraction from verified text,
  // but never contact SEC or advance the original manifest-check timestamp.
  load.prepared = async (selection, { signal } = {}) => {
    if (!enabled()) return null;
    signal?.throwIfAborted();
    const checked = normalizeSelection(selection, now());
    const key = `${checked.cik ? `cik:${checked.cik}` : checked.ticker}:${checked.asOf || 'latest'}`, local = cache.get(key);
    if (local?.expires > now()) return local.value;
    const stored = await bounded(read(COMPANY_EXPOSURE_CACHE_NAMESPACE, key), signal);
    const restored = await restoreFresh(stored, checked, signal);
    signal?.throwIfAborted();
    if (restored) remember(key, restored);
    return restored;
  };
  return load;
}

export const loadCompanyExposures = createCompanyExposureLoader();

export async function loadCompanyExposuresByCik(cik, { asOf = null, signal } = {}) {
  return loadCompanyExposures(normalizeCompanyExposureCikRequest(cik, asOf), { signal });
}
loadCompanyExposuresByCik.prepared = (cik, { asOf = null, signal } = {}) =>
  loadCompanyExposures.prepared(normalizeCompanyExposureCikRequest(cik, asOf), { signal });
