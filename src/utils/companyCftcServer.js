import { getOperatingTicker } from './tickerMap.js';
import { fetchFilingText } from './filingTextParser.js';
import { secFetch } from './secClient.js';
import { warmGet, warmSet } from './warmCache.js';
import { isCftcEnabled } from './cftcFeature.js';
import { CFTC_LAUNCH_CATALOG, cftcDate } from './cftc.js';
import { cacheDeploymentScope } from './cacheScope.js';
import { COMPANY_CFTC_LIMITATIONS, COMPANY_CFTC_SCHEMA_VERSION, companyCftcAnnualFilings, extractCompanyCftcLinks, parseCompanyCftcRequest } from './companyCftc.js';

export const COMPANY_CFTC_CACHE_NAMESPACE = `edgar.company-cftc-context.v1:${cacheDeploymentScope()}`;
const cache = new Map(), inFlight = new Map();
const MAX_CACHE_ITEMS = 100, MAX_IN_FLIGHT = 32, MAX_HISTORY_FILES = 2;
const LOAD_BUDGET_MS = 43_000;

function error(message, code, status = 503) { return Object.assign(new Error(message), { code, status }); }

async function bounded(task, signal) {
  if (!signal) return task;
  if (signal.aborted) {
    Promise.resolve(task).catch(() => {});
    throw error('SEC market-context discovery was interrupted. Please retry.', 'COMPANY_CFTC_TIMEOUT');
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(error('SEC market-context discovery was interrupted. Please retry.', 'COMPANY_CFTC_TIMEOUT'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([task, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function submissionsJson(file, signal) {
  if (!/^CIK\d{10}(?:-submissions-\d+)?\.json$/.test(file)) throw error('Unsupported SEC submissions filename.', 'SEC_SOURCE_INVALID', 502);
  const response = await secFetch(`https://data.sec.gov/submissions/${file}`, {
    signal, timeoutMs: 10_000, retries: 1, maxBytes: 8 * 1024 * 1024,
    headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'EDGAR Terminal research@secedgarterminal.com', Accept: 'application/json' },
  });
  if (!response.ok) throw error('The SEC submissions source is temporarily unavailable.', 'SEC_SOURCE_UNAVAILABLE');
  return response.json();
}

function resultBase(selection, now) {
  return {
    schemaVersion: COMPANY_CFTC_SCHEMA_VERSION, ticker: selection.ticker, companyName: null, cik: null,
    generatedAt: new Date(now).toISOString(), asOf: selection.asOf, status: 'unavailable', retryable: true,
    filing: null, links: [], coverage: { filingsScanned: 0, historyFilesScanned: 0, historyLimited: false, textCharactersScanned: 0, textTruncated: false, method: 'SEC annual-filing exact-passage keyword review' },
    limitations: [...COMPANY_CFTC_LIMITATIONS],
  };
}

/** Injectable sources make filing-date selection and source outages testable. */
export async function discoverCompanyCftcContext(selection, {
  now = new Date(), signal, lookupTicker = getOperatingTicker, loadSubmissions = submissionsJson, loadFilingText = fetchFilingText,
} = {}) {
  const checked = parseCompanyCftcRequest(`https://example.test/?ticker=${encodeURIComponent(selection.ticker || '')}${selection.asOf == null ? '' : `&asOf=${encodeURIComponent(selection.asOf)}`}`, now);
  const result = resultBase(checked, now), cutoff = checked.asOf || new Date(now).toISOString().slice(0, 10);
  try {
    const entry = await bounded(lookupTicker(checked.ticker), signal);
    if (!entry) throw error('No SEC operating company matched that ticker.', 'COMPANY_NOT_FOUND', 404);
    const cik = String(entry.cik).padStart(10, '0');
    if (!/^\d{10}$/.test(cik)) throw error('The SEC company identifier was invalid.', 'SEC_SOURCE_INVALID', 502);
    result.cik = cik; result.companyName = entry.name || checked.ticker;
    const submissions = await bounded(loadSubmissions(`CIK${cik}.json`, signal), signal);
    if (!Array.isArray(submissions?.filings?.recent?.accessionNumber)) throw error('The SEC submissions response could not be verified.', 'SEC_SOURCE_INVALID', 502);
    result.companyName = submissions?.name || result.companyName;
    let filings = companyCftcAnnualFilings(submissions?.filings?.recent, cik, cutoff);
    if (!filings.length) {
      const historyFiles = (Array.isArray(submissions?.filings?.files) ? submissions.filings.files : [])
        .filter(file => new RegExp(`^CIK${cik}-submissions-\\d+\\.json$`).test(file.name)
          && cftcDate(file.filingFrom) === file.filingFrom && cftcDate(file.filingTo) === file.filingTo
          && file.filingFrom <= cutoff && file.filingFrom <= file.filingTo)
        .sort((a, b) => b.filingTo.localeCompare(a.filingTo));
      for (const file of historyFiles.slice(0, MAX_HISTORY_FILES)) {
        result.coverage.historyFilesScanned += 1;
        const historical = await bounded(loadSubmissions(file.name, signal), signal);
        if (!Array.isArray(historical?.accessionNumber)) throw error('The SEC historical submissions response could not be verified.', 'SEC_SOURCE_INVALID', 502);
        filings = companyCftcAnnualFilings(historical, cik, cutoff);
        if (filings.length) break;
      }
      result.coverage.historyLimited = !filings.length && historyFiles.length > MAX_HISTORY_FILES;
    }
    if (!filings.length) {
      result.status = 'no_filing'; result.retryable = false;
      result.message = 'No eligible complete annual report was found within the bounded SEC submissions search.';
      return result;
    }
    const { primaryDoc, ...filing } = filings[0];
    result.filing = filing;
    const source = await bounded(loadFilingText(cik, filing.accession, primaryDoc), signal);
    if (source?.error || typeof source?.text !== 'string' || !source.text.trim()) throw error('The SEC annual-filing text could not be retrieved. Please retry.', 'SEC_FILING_TEXT_UNAVAILABLE');
    const extracted = extractCompanyCftcLinks(source.text, filing, { companyName: result.companyName });
    result.links = extracted.links;
    Object.assign(result.coverage, { filingsScanned: 1, textCharactersScanned: extracted.textCharactersScanned, textTruncated: extracted.textTruncated });
    result.status = result.links.length ? 'ready' : 'no_matches'; result.retryable = false;
    if (!result.links.length) result.message = 'No sufficiently specific market passages matched the supported contract catalog. You can select a market to research separately.';
    return result;
  } catch (cause) {
    if (cause.status === 404) throw cause;
    result.code = cause.code || 'SEC_CONTEXT_UNAVAILABLE';
    result.message = 'SEC evidence is temporarily unavailable. Company fundamentals and manually selected CFTC markets remain independent.';
    return result;
  }
}

function remember(key, value, ttl) {
  const now = Date.now();
  for (const [id, stored] of cache) if (stored.expiresAt <= now) cache.delete(id);
  while (cache.size >= MAX_CACHE_ITEMS) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: now + ttl * 1000 });
}

/** Treat persisted source links as untrusted until identities and URLs agree. */
export function isCompanyCftcCachedContext(value, selection) {
  if (value?.schemaVersion !== COMPANY_CFTC_SCHEMA_VERSION || value.ticker !== selection.ticker || value.asOf !== selection.asOf
    || !['ready', 'no_matches', 'no_filing'].includes(value.status) || !/^\d{10}$/.test(value.cik)
    || typeof value.companyName !== 'string' || value.companyName.length > 500 || value.retryable !== false
    || !Array.isArray(value.links) || value.links.length > 8 || !Number.isFinite(Date.parse(value.generatedAt))) return false;
  if (value.status === 'no_filing') return value.filing === null && value.links.length === 0;
  const filing = value.filing;
  if (!filing || !['10-K', '20-F', '40-F'].includes(filing.form) || !/^\d{10}-\d{2}-\d{6}$/.test(filing.accession)
    || cftcDate(filing.filed) !== filing.filed || filing.filed > (selection.asOf || value.generatedAt.slice(0, 10))
    || (filing.reportDate !== null && (cftcDate(filing.reportDate) !== filing.reportDate || filing.reportDate > filing.filed))) return false;
  const expectedPrefix = `https://www.sec.gov/Archives/edgar/data/${Number(value.cik)}/${filing.accession.replaceAll('-', '')}/`;
  if (typeof filing.url !== 'string' || !filing.url.startsWith(expectedPrefix)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(filing.url.slice(expectedPrefix.length))) return false;
  if (value.status === 'no_matches') return value.links.length === 0;
  if (!value.links.length) return false;
  return value.links.every(link => {
    const catalog = CFTC_LAUNCH_CATALOG.find(item => item.family === link.family && item.code === link.contract);
    return catalog && catalog.label === link.label && link.reviewStatus === 'candidate'
      && link.group === (link.family === 'tff' ? 'leveraged-funds' : 'managed-money')
      && typeof link.id === 'string' && /^[a-z-]{1,30}$/.test(link.id)
      && typeof link.reason === 'string' && link.reason.length <= 1000
      && typeof link.reviewQuestion === 'string' && link.reviewQuestion.length <= 1000
      && Array.isArray(link.evidence) && link.evidence.length >= 1 && link.evidence.length <= 2
      && link.evidence.every(item => typeof item.text === 'string' && item.text.length >= 35 && item.text.length <= 900
        && ['url', 'accession', 'form', 'filed', 'reportDate'].every(key => item[key] === filing[key]));
  });
}

export async function loadCompanyCftcContext(selection, { signal } = {}) {
  if (!isCftcEnabled()) throw error('CFTC context is disabled.', 'CFTC_DISABLED');
  const checked = parseCompanyCftcRequest(`https://example.test/?ticker=${encodeURIComponent(selection.ticker || '')}${selection.asOf == null ? '' : `&asOf=${encodeURIComponent(selection.asOf)}`}`);
  const key = `${checked.ticker}:${checked.asOf || 'latest'}`;
  const local = cache.get(key);
  if (local && local.expiresAt > Date.now()) return local.value;
  if (inFlight.has(key)) return bounded(inFlight.get(key), signal);
  if (inFlight.size >= MAX_IN_FLIGHT) throw error('Company market-context discovery is busy. Please retry.', 'COMPANY_CFTC_BUSY');
  const task = (async () => {
    const stored = await warmGet(COMPANY_CFTC_CACHE_NAMESPACE, key);
    if (isCompanyCftcCachedContext(stored, checked)) {
      const age = Date.now() - Date.parse(stored.generatedAt);
      const ttl = stored.status === 'ready' ? 6 * 3600 : stored.status === 'no_matches' ? 3600 : 900;
      if (Number.isFinite(age) && age >= 0 && age < ttl * 1000) { remember(key, stored, Math.max(1, ttl - age / 1000)); return stored; }
    }
    const deadline = AbortSignal.timeout(LOAD_BUDGET_MS);
    const value = await discoverCompanyCftcContext(checked, { signal: deadline });
    if (value.status !== 'unavailable') {
      const ttl = value.status === 'ready' ? 6 * 3600 : value.status === 'no_matches' ? 3600 : 900;
      remember(key, value, ttl);
      await warmSet(COMPANY_CFTC_CACHE_NAMESPACE, key, value, ttl);
    }
    return value;
  })();
  inFlight.set(key, task);
  // A caller cancelling must not remove the shared task while another awaits it.
  task.finally(() => inFlight.delete(key)).catch(() => {});
  return bounded(task, signal);
}
