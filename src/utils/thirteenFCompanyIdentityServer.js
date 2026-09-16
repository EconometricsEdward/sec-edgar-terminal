import { createHash } from 'node:crypto';
import { secFetch } from './secClient.js';
import { cacheGet, cachePut, disposableCacheEnabled } from './disposableCache.js';
import { loadFilingsCompany } from './filingsResearchServer.js';
import { normalizeHoldingCompanyRequest, parseScheduleIssuer, resolveHoldingCompanyEvidence } from './thirteenFCompanyIdentity.js';

export const THIRTEEN_F_ISSUER_EVIDENCE_CACHE_TYPE = 'edgar.13f-issuer-evidence.v1:production';
const CACHE_VERSION = 'edgar.13f-issuer-evidence.v1';
const CACHE_MAX_BYTES = 128 * 1024, CACHE_MAX_AGE_MS = 6 * 3600000;
const CACHE_CUSIP = /^(?!000000000)[A-Z0-9*@#]{9}$/;
const SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENTS = 4;
const FORM = /^SCHEDULE 13[DG](?:\/A)?$/;
const CIK = /^\d{10}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const fail = (message, status = 502, code = 'SEC_IDENTITY_UNAVAILABLE') => Object.assign(new Error(message), { status, code });

const SEARCH_SOURCE = 'SEC structured Schedule 13D/G issuer covers';
const SEARCH_NOTE = 'Exact CUSIP and issuer CIK are checked in up to four recent SEC ownership filing covers. This is current issuer research, not a historical reconstruction of issuer identity or financial information.';
const boundedString = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
function issuerSearchUrl(cusip, observedAt) {
  const params = new URLSearchParams({ q: `"${cusip}"`, forms: 'SCHEDULE 13G,SCHEDULE 13D', dateRange: 'custom', startdt: '2025-01-01', enddt: observedAt.slice(0, 10), sort: 'desc', from: '0' });
  return `${SEARCH_URL}?${params}`;
}
function evidenceIntegrity(value) {
  return createHash('sha256').update(JSON.stringify([value.schemaVersion, value.cusip, value.observedAt, value.expiresAt, value.evidence, value.coverage])).digest('hex');
}
/** Only validated source proof is shared. Every holding still undergoes its
 * own name/class checks and its issuer's submissions identity verification. */
function validSharedEvidence(value, cusip, now, maxAgeMs) {
  try {
    if (!value || value.schemaVersion !== CACHE_VERSION || value.cusip !== cusip || !CACHE_CUSIP.test(cusip)
      || !validTime(value.observedAt) || !validTime(value.expiresAt) || Date.parse(value.observedAt) > now
      || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) <= Date.parse(value.observedAt)
      || Date.parse(value.expiresAt) - Date.parse(value.observedAt) > maxAgeMs
      || !/^[a-f0-9]{64}$/.test(value.integrity || '') || evidenceIntegrity(value) !== value.integrity
      || Buffer.byteLength(JSON.stringify(value), 'utf8') > CACHE_MAX_BYTES
      || !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > MAX_DOCUMENTS) return false;
    const coverage = value.coverage, seen = new Set();
    if (!coverage || coverage.source !== SEARCH_SOURCE || coverage.searchUrl !== issuerSearchUrl(cusip, value.observedAt)
      || coverage.searchStart !== '2025-01-01' || coverage.note !== SEARCH_NOTE || typeof coverage.bounded !== 'boolean'
      || !Number.isSafeInteger(coverage.indexedMatches) || coverage.indexedMatches < coverage.documentsChecked
      || !Number.isSafeInteger(coverage.documentsChecked) || coverage.documentsChecked < value.evidence.length || coverage.documentsChecked > MAX_DOCUMENTS
      || coverage.matchingDocuments !== value.evidence.length || new Set(value.evidence.map(source => source.cik)).size !== 1) return false;
    for (const source of value.evidence) {
      if (!CIK.test(source.cik || '') || Number(source.cik) <= 0 || !boundedString(source.name, 1000) || !boundedString(source.classTitle, 2000)
        || !Array.isArray(source.cusips) || !source.cusips.length || source.cusips.length > 25 || !source.cusips.includes(cusip)
        || source.cusips.some(id => !/^[A-Z0-9*@#]{9}$/.test(id) || /^0+$/.test(id)) || new Set(source.cusips).size !== source.cusips.length
        || !FORM.test(source.form || '') || !ACCESSION.test(source.accession || '') || seen.has(source.accession)
        || !validDate(source.filingDate) || source.filingDate < coverage.searchStart || source.filingDate > value.observedAt.slice(0, 10)
        || !validDate(source.eventDate) || source.eventDate > source.filingDate || typeof source.url !== 'string') return false;
      const location = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/([1-9]\d{0,9})\/(\d{18})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,239}\.xml)$/.exec(source.url);
      if (!location || location[2] !== source.accession.replaceAll('-', '') || location[3].includes('..')) return false;
      const root = source.url.slice(0, -location[3].length);
      const stylesheet = source.form.startsWith('SCHEDULE 13D') ? 'D' : 'G';
      if (source.indexUrl !== `${root}${source.accession}-index.html`
        || source.sourceUrl !== source.url && !new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}xslSCHEDULE_13${stylesheet}_X[0-9]{2}/${location[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(source.sourceUrl || '')) return false;
      seen.add(source.accession);
    }
    return true;
  } catch { return false; }
}

async function boundedText(response, signal) {
  if (!response.ok) throw fail('SEC issuer evidence is temporarily unavailable. Retry this holding.', [403, 429, 503].includes(response.status) ? 503 : 502);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw fail('The SEC issuer evidence exceeds the supported document size. Open the original filing.');
  if (!response.body) throw fail('The SEC issuer evidence response was empty. Retry this holding.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw fail('The SEC issuer evidence exceeds the supported document size. Open the original filing.');
      text += decoder.decode(part.value, { stream: true });
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

function searchDocuments(payload) {
  const hits = payload?.hits?.hits, total = typeof payload?.hits?.total === 'number' ? payload.hits.total : payload?.hits?.total?.value;
  if (payload?.error || payload?.timed_out || Number(payload?._shards?.failed || 0) > 0 || !Array.isArray(hits) || hits.length > 100 || !Number.isSafeInteger(total) || total < hits.length) throw fail('The SEC identifier search returned incomplete data. Retry this holding.');
  const rows = [];
  for (const hit of hits) {
    const source = hit?._source;
    if (!source || !FORM.test(source.form) || !ACCESSION.test(source.adsh) || !validDate(source.file_date)
      || !Array.isArray(source.ciks) || !source.ciks.length || source.ciks.length > 1000
      || source.ciks.some(cik => !CIK.test(cik) || Number(cik) <= 0)
      || typeof hit._id !== 'string' || !hit._id.startsWith(`${source.adsh}:`)) throw fail('The SEC identifier search returned invalid filing metadata. Retry this holding.');
    // Only the indexed primary XML form qualifies; exhibits can mention another
    // issuer's CUSIP. The full-text search itself never establishes identity.
    const name = hit._id.slice(source.adsh.length + 1);
    if (source.sequence !== 1 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,239}\.xml$/i.test(name) || name.includes('..')) continue;
    rows.push({ accession: source.adsh, name, form: source.form, filingDate: source.file_date, ciks: [...new Set(source.ciks)], xsl: typeof source.xsl === 'string' && /^xslSCHEDULE_13[DG]_X\d{2}$/.test(source.xsl) ? source.xsl : null });
  }
  rows.sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession));
  const unique = [...new Map(rows.map(row => [row.accession, row])).values()];
  // Include different SEC subject-directory locations before repeated filings
  // from one subject. Those locations help discover conflicts, but only the XML
  // issuerCik can establish a company identity.
  const selected = [], subjectLocations = new Set();
  for (const row of unique) if (!subjectLocations.has(row.ciks[0])) { subjectLocations.add(row.ciks[0]); selected.push(row); }
  for (const row of unique) if (!selected.includes(row)) selected.push(row);
  return { rows: selected.slice(0, MAX_DOCUMENTS), total, indexedPrimaryDocuments: unique.length,
    truncated: total > hits.length || payload.hits.total?.relation === 'gte' || unique.length > MAX_DOCUMENTS };
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

/** On-demand exact-identifier discovery, using the existing SEC outbound gate.
 * The bounded cache stores SEC evidence per CUSIP, never a guessed ticker map. */
export function createThirteenFCompanyIdentityLoader({ fetchSec = secFetch, companyLoader = loadFilingsCompany, now = Date.now, maxEntries = 200, maxPending = 8, deadlineMs = 45000, ttlMs = CACHE_MAX_AGE_MS,
  cacheEnabled = disposableCacheEnabled, readEvidence = cacheGet, writeEvidence = cachePut, cacheIoMs = 1500,
} = {}) {
  const cache = new Map(), pending = new Map(), published = new WeakSet();
  const maxAgeMs = Math.min(CACHE_MAX_AGE_MS, Math.max(1, ttlMs));
  async function sharedOperation(operation, signal) {
    const timeoutMs = Math.max(1, Math.min(1500, cacheIoMs)), deadline = Date.now() + timeoutMs;
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return abortable(Promise.resolve().then(() => operation({ signal: requestSignal, deadline, timeoutMs })), requestSignal);
  }
  async function publishEvidence(cusip, data, signal) {
    if (!cacheEnabled() || !CACHE_CUSIP.test(cusip) || published.has(data)) return;
    const expiresAt = new Date(Date.parse(data.observedAt) + maxAgeMs).toISOString();
    const value = { schemaVersion: CACHE_VERSION, cusip, ...data, expiresAt };
    value.integrity = evidenceIntegrity(value);
    if (!validSharedEvidence(value, cusip, now(), maxAgeMs)) return;
    // Mark this observation once even if optional persistence fails. A visit
    // never extends evidence freshness or repeatedly writes the same proof.
    published.add(data);
    const remainingSeconds = Math.floor((Date.parse(expiresAt) - now()) / 1000);
    if (remainingSeconds < 1) return;
    try { await sharedOperation(options => writeEvidence(THIRTEEN_F_ISSUER_EVIDENCE_CACHE_TYPE, cusip, value, remainingSeconds, { ...options, expiresAt }), signal); }
    catch { /* Optional shared storage never prevents verified issuer research. */ }
  }
  async function fetchText(url, signal) {
    const response = await fetchSec(url, { signal, timeoutMs: 10000, retries: 1, maxBytes: MAX_BYTES, cache: 'no-store', headers: { Accept: 'application/json, application/xml, text/xml;q=0.9' } });
    return boundedText(response, signal);
  }
  async function discover(cusip, signal) {
    const observedAt = new Date(now()).toISOString(), searchUrl = issuerSearchUrl(cusip, observedAt);
    let payload;
    try { payload = JSON.parse(await fetchText(searchUrl, signal)); }
    catch (error) { if (error.status || signal.aborted) throw error; throw fail('SEC identifier search returned an invalid response. Retry this holding.'); }
    const page = searchDocuments(payload), evidence = [], failures = [];
    async function inspect(filing) {
      signal.throwIfAborted();
      const root = `https://www.sec.gov/Archives/edgar/data/${Number(filing.ciks[0])}/${filing.accession.replaceAll('-', '')}`;
      const url = `${root}/${filing.name}`;
      try {
        const parsed = parseScheduleIssuer(await fetchText(url, signal), { form: filing.form, filingDate: filing.filingDate, ciks: filing.ciks });
        if (!parsed.cusips.includes(cusip)) return;
        evidence.push({ ...parsed, accession: filing.accession, url, sourceUrl: filing.xsl ? `${root}/${filing.xsl}/${filing.name}` : url, indexUrl: `${root}/${filing.accession}-index.html` });
      } catch (error) { if (signal.aborted) throw error; failures.push(error); }
    }
    // Two independent documents at a time reduce cold-panel latency. Every
    // request still obtains permission from the shared SEC outbound pacer.
    for (let offset = 0; offset < page.rows.length; offset += 2) {
      const results = await Promise.allSettled(page.rows.slice(offset, offset + 2).map(inspect));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    }
    // A failed selected source might contain conflicting identity evidence. Do
    // not turn upstream failures into a definitive no-match or cache them.
    if (failures.length) throw fail('Some SEC issuer documents could not be verified. Retry this holding; company matching has been withheld.');
    return { evidence, observedAt, coverage: { source: SEARCH_SOURCE, searchUrl, searchStart: '2025-01-01', indexedMatches: page.total,
      documentsChecked: page.rows.length, matchingDocuments: evidence.length, bounded: page.truncated,
      note: SEARCH_NOTE } };
  }
  function consumeEvidence(cusip, entry, signal) {
    entry.consumers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (success, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        entry.consumers--;
        if (!entry.settled && entry.consumers === 0) {
          // Remove immediately so a new caller can retry while an old aborted
          // transport finishes unwinding. Its finally cannot remove this retry.
          if (pending.get(cusip) === entry) pending.delete(cusip);
          entry.controller.abort(new DOMException('No issuer research consumers remain.', 'AbortError'));
        }
        if (success) resolve(value); else reject(value);
      };
      const abort = () => finish(false, signal.reason || new DOMException('Request aborted.', 'AbortError'));
      entry.task.then(value => finish(true, value), error => finish(false, error));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async function evidenceFor(cusip, signal) {
    signal?.throwIfAborted();
    const previous = cache.get(cusip);
    if (previous?.expires > now()) { cache.delete(cusip); cache.set(cusip, previous); return previous.data; }
    cache.delete(cusip);
    if (pending.has(cusip)) return consumeEvidence(cusip, pending.get(cusip), signal);
    if (pending.size >= maxPending) throw fail('Several issuer lookups are loading. Retry shortly.', 503, 'SEC_IDENTITY_BUSY');
    const controller = new AbortController();
    const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(deadlineMs)]);
    const entry = { controller, consumers: 0, settled: false, task: null };
    // Start on the next microtask so the first consumer is registered before
    // any shared cache or SEC request can begin.
    entry.task = Promise.resolve().then(async () => {
      deadline.throwIfAborted();
      if (cacheEnabled() && CACHE_CUSIP.test(cusip)) {
        try {
          const stored = await sharedOperation(options => readEvidence(THIRTEEN_F_ISSUER_EVIDENCE_CACHE_TYPE, cusip, options), deadline);
          if (validSharedEvidence(stored?.payload, cusip, now(), maxAgeMs)) {
            const { evidence, observedAt, coverage } = stored.payload;
            const data = { evidence, observedAt, coverage };
            published.add(data);
            return { data, expires: Date.parse(stored.payload.expiresAt) };
          }
        } catch { /* Cold or unavailable storage retains bounded SEC discovery. */ }
      }
      deadline.throwIfAborted();
      const data = await discover(cusip, deadline);
      return { data, expires: Date.parse(data.observedAt) + (data.evidence.length ? maxAgeMs : Math.min(maxAgeMs, 60000)) };
    }).then(({ data, expires }) => {
      deadline.throwIfAborted();
      cache.set(cusip, { data, expires });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return data;
    }).finally(() => {
      entry.settled = true;
      if (pending.get(cusip) === entry) pending.delete(cusip);
    });
    pending.set(cusip, entry);
    return consumeEvidence(cusip, entry, signal);
  }
  return async function loadThirteenFCompanyIdentity(holding, { period = '', signal } = {}) {
    signal?.throwIfAborted();
    const request = normalizeHoldingCompanyRequest(holding, { period });
    if (['fund', 'principal'].includes(request.securityType)) return { ...resolveHoldingCompanyEvidence(holding, [], { period, now: now() }), observedAt: new Date(now()).toISOString(), coverage: { documentsChecked: 0, bounded: false } };
    const found = await evidenceFor(request.cusip, signal);
    signal?.throwIfAborted();
    const result = resolveHoldingCompanyEvidence(holding, found.evidence, { period, now: now() });
    if (result.status !== 'resolved') return { ...result, observedAt: found.observedAt, coverage: found.coverage };
    const company = await companyLoader(result.issuer.cik, { signal });
    if (company.cik !== result.issuer.cik || typeof company.name !== 'string' || !company.name.trim() || !Array.isArray(company.tickers) || !Array.isArray(company.filings)) throw fail('The company submissions did not match the verified issuer CIK. Retry this holding.');
    if (company.kind === 'fund' || company.filings.some(filing => /^NPORT-P(?:\/A)?$/.test(filing.form))) return { ...result, status: 'unresolved', issuer: null, securityType: 'fund', code: 'FUND_ISSUER', reason: 'The SEC issuer files fund portfolio reports. Research this security as a fund; operating-company financials are not assigned.', observedAt: found.observedAt, coverage: found.coverage };
    await publishEvidence(request.cusip, found, signal);
    signal?.throwIfAborted();
    return { ...result, issuer: { cik: company.cik, name: company.name, tickers: company.tickers, kind: 'company', sic: company.sic || '', sicDescription: company.sicDescription || '', submissionsUrl: company.submissionsUrl || `https://data.sec.gov/submissions/CIK${company.cik}.json` }, observedAt: found.observedAt, coverage: found.coverage };
  };
}

export const loadThirteenFCompanyIdentity = createThirteenFCompanyIdentityLoader();
