import { createHash } from 'node:crypto';
import { cacheGet, cachePut, disposableCacheEnabled } from './disposableCache.js';
import { cacheDeploymentScope } from './cacheScope.js';

export const COMPANY_EXPOSURE_DOCUMENT_TYPE = `edgar.company-exposure-document.v1:${cacheDeploymentScope()}`;
export const COMPANY_EXPOSURE_REVISION_TYPE = `edgar.company-exposure-revision.v1:${cacheDeploymentScope()}`;
// Bump the source version when visible-text parsing changes; bump the extraction
// version when classification rules or the supported benchmark catalog change.
export const COMPANY_EXPOSURE_TEXT_VERSION = 'filing-visible-text.v2';
export const COMPANY_EXPOSURE_EXTRACTION_VERSION = 'company-exposure-extraction.v1';
export const COMPANY_EXPOSURE_REVISION_RETENTION_SECONDS = 30 * 86400;
const FILING_FIELDS = ['role', 'form', 'filed', 'reportDate', 'accession', 'primaryDoc', 'url'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').toUpperCase();
const filingBinding = source => FILING_FIELDS.map(key => source?.[key] ?? null);
const validCik = cik => /^(?!0000000000)\d{10}$/.test(cik || '');
const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

export function companyExposureDocumentKey(cik, source, textVersion = COMPANY_EXPOSURE_TEXT_VERSION) {
  if (!validCik(cik) || !/^\d{10}-\d{2}-\d{6}$/.test(source?.accession || '')) return null;
  return `${cik}:${source.accession}:${digest([textVersion, cik, filingBinding(source)])}`;
}
export function companyExposureRevisionKey(result, sources, extractionVersion = COMPANY_EXPOSURE_EXTRACTION_VERSION) {
  if (!validCik(result?.cik)) return null;
  return `${result.cik}:${digest([extractionVersion, result.cik, result.companyName, result.ticker ?? null,
    sources.map(source => [filingBinding(source), source.digest])])}`;
}

/** Immutable SEC source bodies and extraction revisions share the existing
 * bounded document quota. Cache presence never establishes manifest freshness. */
export function createCompanyExposureRevisionCache({ enabled = disposableCacheEnabled, read = cacheGet, write = cachePut,
  now = Date.now, timeoutMs = 1500, textVersion = COMPANY_EXPOSURE_TEXT_VERSION,
  extractionVersion = COMPANY_EXPOSURE_EXTRACTION_VERSION,
} = {}) {
  async function operation(task, signal) {
    signal?.throwIfAborted();
    const wait = Math.max(1, Math.min(timeoutMs, 3000));
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(wait)]) : AbortSignal.timeout(wait);
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(requestSignal.reason);
      requestSignal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(() => task({ signal: requestSignal, deadline: Date.now() + wait, timeoutMs: wait })), stopped]); }
    finally { requestSignal.removeEventListener('abort', abort); }
  }
  async function get(type, key, signal) {
    if (!enabled() || !key) return null;
    try { return (await operation(options => read(type, key, options), signal))?.payload ?? null; }
    catch { signal?.throwIfAborted(); return null; }
  }
  async function put(type, key, payload, signal) {
    if (!enabled() || !key) return;
    try { await operation(options => write(type, key, payload, COMPANY_EXPOSURE_REVISION_RETENTION_SECONDS, options), signal); }
    catch { signal?.throwIfAborted(); }
  }
  return {
    async document(cik, filing, { signal } = {}) {
      const key = companyExposureDocumentKey(cik, filing, textVersion), value = await get(COMPANY_EXPOSURE_DOCUMENT_TYPE, key, signal);
      if (!value || value.version !== textVersion || value.cik !== cik || value.key !== key
        || value.integrity !== digest([value.version, value.cik, value.key, value.source])
        || JSON.stringify(filingBinding(value.source)) !== JSON.stringify(filingBinding(filing))) return null;
      return value.source;
    },
    async saveDocument(cik, source, { signal } = {}) {
      const key = companyExposureDocumentKey(cik, source, textVersion);
      const value = { version: textVersion, cik, key, source };
      value.integrity = digest([value.version, value.cik, value.key, value.source]);
      await put(COMPANY_EXPOSURE_DOCUMENT_TYPE, key, value, signal);
    },
    async extraction(result, sources, { signal } = {}) {
      const key = companyExposureRevisionKey(result, sources, extractionVersion), value = await get(COMPANY_EXPOSURE_REVISION_TYPE, key, signal);
      if (!value || value.version !== extractionVersion || value.key !== key || value.cik !== result.cik
        || !validTime(value.generatedAt) || Date.parse(value.generatedAt) > now()
        || !Array.isArray(value.extracted?.rows) || value.extracted.rows.length > 50
        || !Array.isArray(value.extracted?.coverage?.filings) || value.extracted.coverage.filings.length !== sources.length
        || value.integrity !== digest([value.version, value.key, value.cik, value.generatedAt, value.extracted])) return null;
      // Every persisted passage remains attached to one exact selected document.
      if (value.extracted.rows.some(row => !Array.isArray(row.evidence) || !row.evidence.length || row.evidence.length > 4
        || row.evidence.some(evidence => !sources.some(source => ['role', 'form', 'filed', 'reportDate', 'accession', 'url']
          .every(field => (source[field] ?? null) === (evidence[field] ?? null)))))) return null;
      return { extracted: value.extracted, generatedAt: value.generatedAt };
    },
    async saveExtraction(result, sources, extracted, { signal } = {}) {
      const key = companyExposureRevisionKey(result, sources, extractionVersion);
      const value = { version: extractionVersion, key, cik: result.cik, generatedAt: result.generatedAt, extracted };
      value.integrity = digest([value.version, value.key, value.cik, value.generatedAt, value.extracted]);
      await put(COMPANY_EXPOSURE_REVISION_TYPE, key, value, signal);
    },
  };
}

export const companyExposureRevisionCache = createCompanyExposureRevisionCache();
