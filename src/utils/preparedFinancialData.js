import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getDataStoreMode, readDataset, readDatasetManifests, beginDatasetWrite, publishDataset, revalidateDataset, releaseDatasetWrite, stableDataStoreJson } from './dataStore.js';
import { buildAnalysisCompany, packAnalysisCompany, ANALYSIS_VERSION } from './analysisResearch.js';
import { buildFilingUrl } from './filingTextParser.js';
import { RESEARCH_FORMS } from './researchWorkspace.js';
import { warmGet, warmReserveGeneration, warmSetGeneration } from './warmCache.js';
import { SEC_MIGRATION_COHORT, getSecPreparedCompany, getActiveSecPreparedCompany, isSecPreparedReadEnabled, secDocumentIdentity, refreshSecDocument, preparedEnvelopeUsable, PreparedSecUnavailableError } from './secDocumentStore.js';
import { loadSecCoverageRegistry } from './secCoverageRegistry.js';

export const FINANCIAL_PREPARED_VERSION = 'financial-analysis-v1';
export const FINANCIAL_PREPARED_BASES = Object.freeze(['annual', 'quarter', 'ytd', 'ttm']);
const hotNamespace = 'analysis-research';
const legacyKey = (ticker, basis) => `${ANALYSIS_VERSION}:${ticker}:${basis}:`;
const hash = (value) => createHash('sha256').update(stableDataStoreJson(value)).digest('hex');
const companyForTicker = getSecPreparedCompany;
const pilotTickers = new Set(SEC_MIGRATION_COHORT.map(company => company.ticker));

const MAX_FINANCIAL_DECODE_BYTES = 24 * 1024 * 1024;
const MAX_FINANCIAL_GZIP_BYTES = 6 * 1024 * 1024;
const FINANCIAL_PAYLOAD_CACHE_BYTES = 24 * 1024 * 1024;
const FINANCIAL_PAYLOAD_CACHE_ENTRIES = 16;
const FINANCIAL_PAYLOAD_CACHE_ENTRY_BYTES = 4 * 1024 * 1024;
const FINANCIAL_PAYLOAD_CACHE_TTL_MS = 60000;

function freezeJson(value) {
  const pending = value && typeof value === 'object' ? [value] : [];
  while (pending.length) {
    const current = pending.pop();
    for (const child of Object.values(current)) {
      if (child && typeof child === 'object') pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

/**
 * Cache only immutable response content, never a Redis head or source metadata.
 * Every request still checks the current fenced Redis response and its age.
 * The byte budget is serialized JSON size; parsed objects also consume memory.
 * The entry count, per-entry limit and absolute TTL bound retained objects.
 */
export function createFinancialPayloadCache({
  maxBytes = FINANCIAL_PAYLOAD_CACHE_BYTES, maxEntries = FINANCIAL_PAYLOAD_CACHE_ENTRIES,
  maxEntryBytes = FINANCIAL_PAYLOAD_CACHE_ENTRY_BYTES, ttlMs = FINANCIAL_PAYLOAD_CACHE_TTL_MS,
  now = Date.now,
} = {}) {
  for (const [value, cap] of [[maxBytes, FINANCIAL_PAYLOAD_CACHE_BYTES], [maxEntries, FINANCIAL_PAYLOAD_CACHE_ENTRIES],
    [maxEntryBytes, FINANCIAL_PAYLOAD_CACHE_ENTRY_BYTES], [ttlMs, FINANCIAL_PAYLOAD_CACHE_TTL_MS]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new Error('Invalid financial payload cache bound.');
  }
  const entries = new Map(); let retainedBytes = 0;
  const remove = (key) => { const item = entries.get(key); if (item) retainedBytes -= item.bytes; entries.delete(key); };
  return Object.freeze({
    decode(gzip) {
      if (typeof gzip !== 'string' || gzip.length > Math.ceil(MAX_FINANCIAL_GZIP_BYTES / 3) * 4) {
        throw new Error('Prepared financial gzip exceeds its size limit.');
      }
      const at = now();
      for (const [key, item] of entries) if (at >= item.expiresAt) remove(key);
      const key = createHash('sha256').update(gzip).digest('hex');
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key); entries.set(key, cached);
        return cached.content;
      }
      const bytes = gunzipSync(Buffer.from(gzip, 'base64'), { maxOutputLength: MAX_FINANCIAL_DECODE_BYTES });
      const serializedPayload = bytes.toString('utf8');
      const content = Object.freeze({ payload: freezeJson(JSON.parse(serializedPayload)), serializedPayload });
      if (bytes.length <= maxEntryBytes && bytes.length <= maxBytes) {
        while (entries.size >= maxEntries || retainedBytes + bytes.length > maxBytes) remove(entries.keys().next().value);
        entries.set(key, { content, bytes: bytes.length, expiresAt: at + ttlMs }); retainedBytes += bytes.length;
      }
      return content;
    },
  });
}

const financialPayloadCache = createFinancialPayloadCache();

export function financialPreparedKey(ticker, basis, asOf = '') {
  const company = companyForTicker(ticker);
  return company && FINANCIAL_PREPARED_BASES.includes(basis) && !asOf
    ? `${FINANCIAL_PREPARED_VERSION}:${ANALYSIS_VERSION}:CIK${company.cik}:${basis}:latest` : null;
}

function validatePrepared(envelope, cik, basis) {
  const data = envelope?.payload;
  return preparedEnvelopeUsable(envelope) && data.packed === true && data.version === ANALYSIS_VERSION
    && data.cik === cik && (!envelope.metadata.entityId || envelope.metadata.entityId === cik)
    && data.basis === basis && !data.asOf
    && Array.isArray(data.periods) && Array.isArray(data.sourceCatalog);
}

/** A compact result is the real Analysis API payload, not a second calculator. */
export async function readPreparedAnalysis({ ticker, basis = 'annual', asOf = '' }, {
  mode = getDataStoreMode('financial'), read = readDataset, hotRead = warmGet,
  payloadCache = financialPayloadCache,
  readEnabled = isSecPreparedReadEnabled, loadRegistry = loadSecCoverageRegistry,
} = {}) {
  if (mode !== 'supabase' || asOf || !FINANCIAL_PREPARED_BASES.includes(basis)) return null;
  await loadRegistry();
  const company = getActiveSecPreparedCompany(ticker);
  if (!company || !readEnabled(company.cik)) return null;
  const key = financialPreparedKey(company.cik, basis, asOf);
  const canonicalTicker = company.ticker;
  const forSecurity = (record) => {
    if (ticker === record.payload.ticker) return record;
    const payload = { ...record.payload, ticker };
    return { ...record, payload, serializedPayload: JSON.stringify(payload) };
  };
  let cached = null;
  try {
    cached = await hotRead(hotNamespace, legacyKey(canonicalTicker, basis));
    if (cached?.gzip) cached = { metadata: structuredClone(cached.metadata), stale: cached.stale,
      ...payloadCache.decode(cached.gzip) };
  } catch { cached = null; /* Durable read is bounded and contains no provider fetch. */ }
  if (validatePrepared(cached, company.cik, basis)) return forSecurity({ ...cached, cacheSource: 'warm-prepared' });
  let envelope;
  try { envelope = await read('financial', key, { allowStale: true }); }
  catch { throw new PreparedSecUnavailableError('Prepared financial storage is temporarily unavailable.'); }
  if (!validatePrepared(envelope, company.cik, basis)) throw new PreparedSecUnavailableError('Prepared financial data is not ready for this reporting basis.');
  return forSecurity({ ...envelope, serializedPayload: envelope.serializedPayload || JSON.stringify(envelope.payload), cacheSource: 'supabase-prepared' });
}

export function financialInputIdentity(company) {
  return hash({ ticker: company.ticker, cik: company.cik, companyName: company.companyName, sic: company.sic, facts: company.facts, filings: company.filings });
}

const sampled = new Map();
export async function sampleFinancialShadow(company, result, {
  mode = getDataStoreMode('financial'), read = readDataset, now = Date.now(),
  report = (event) => console.info('[dataStore.shadow]', JSON.stringify(event)),
} = {}) {
  const key = financialPreparedKey(company.ticker, result.basis, result.asOf);
  if (mode !== 'shadow' || !key || now - (sampled.get(key) || 0) < 300000) return null;
  sampled.set(key, now);
  try {
    const stored = await read('financial', key, { allowStale: true });
    const comparable = (stored?.metadata?.financialCompanyHash || stored?.metadata?.financialInputHash) === financialInputIdentity(company);
    const stable = (value) => ({ ...value, observedAt: undefined });
    const status = !stored ? 'not-prepared' : !comparable ? 'different-source-version'
      : hash(stable(stored.payload)) === hash(stable(result)) ? 'identical' : 'mismatch';
    report({ dataset: 'financial', key, status });
    return status;
  } catch { report({ dataset: 'financial', key, status: 'storage-unavailable' }); return 'storage-unavailable'; }
}

export function researchCompanyFromDocuments(ticker, submissions, companyfacts) {
  const cik = String(submissions.cik).padStart(10, '0');
  const recent = submissions.filings.recent;
  const filings = (recent.accessionNumber || []).flatMap((accession, index) => {
    if (!RESEARCH_FORMS.test(recent.form?.[index]) || !recent.primaryDocument?.[index]) return [];
    const primaryDoc = recent.primaryDocument[index];
    return [{ accession, form: recent.form[index], filingDate: recent.filingDate[index], reportDate: recent.reportDate?.[index], primaryDoc, documentUrl: buildFilingUrl(cik, accession, primaryDoc) }];
  });
  const ordered = [...new Map(filings.map((filing) => [filing.accession, filing])).values()]
    .sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession));
  return { ticker, cik, companyName: submissions.name || ticker, sic: submissions.sic, facts: companyfacts.facts, filings: ordered, historyLimited: false };
}

// A small, queried serving projection is version-linked; the full packed result
// remains the response contract and carries every period and source context.
export function financialServingObservations(data) {
  // Store each supported latest metric once per basis, with immutable evidence
  // references. The full history stays in its compressed version snapshot.
  const selected = data.definitions.map(definition => definition.key);
  return selected.flatMap((metric) => {
    const point = data.metrics[metric]?.[0], period = data.periods[0];
    if (!point || !period) return [];
    const inputs = (point.sourceIds || []).map((id) => data.sourceCatalog[id]);
    const source = point.classification === 'reported' && inputs.length === 1 ? inputs[0] : null;
    const definition = data.definitions.find((item) => item.key === metric);
    return [{ metric, periodEnd: period.end, periodStart: source ? source.start : period.start || null,
      value: Number.isFinite(point.value) ? point.value : null,
      unit: source?.unit || ({ currency: 'USD', percent: '%', eps: 'USD/shares', shares: 'shares', days: 'days', number: 'count' }[definition?.format] || 'ratio'),
      accession: source?.accession || null, form: source?.form || null, filed: source?.filed || null,
      taxonomy: source?.taxonomy || null, concept: source?.tag || null,
      fiscalYear: period.fy ?? null, fiscalPeriod: period.fp || null, calculationVersion: ANALYSIS_VERSION,
      context: { classification: point.classification, reason: point.reason || null, formula: point.formula || null,
        sourceIds: point.sourceIds || [], calculationIds: point.calculationIds || [], kind: period.kind,
        // IDs address catalogs in this row's immutable version snapshot. Do not
        // duplicate potentially large revision histories in each database row.
        evidenceLocation: 'version_snapshot.sourceCatalog', calculationLocation: 'version_snapshot.calculationCatalog' } }];
  });
}

/** Refresh from canonical documents; all bases reuse the same two source reads. */
export async function prepareFinancialCompany(ticker, {
  mode = getDataStoreMode('financial'), read = readDataset, begin = beginDatasetWrite,
  publish = publishDataset, revalidate = revalidateDataset, release = releaseDatasetWrite,
  legacyWrite = warmSetGeneration, reserveLegacy = warmReserveGeneration,
  bases = FINANCIAL_PREPARED_BASES,
  signal, deadline = Infinity, loadRegistry = loadSecCoverageRegistry,
} = {}) {
  if (mode !== 'off') await loadRegistry({ required: true });
  const cohort = companyForTicker(ticker);
  if (!cohort) throw new Error('Financial preparation is limited to the documented SEC cohort.');
  ticker = cohort.ticker;
  const mirrorLegacy = pilotTickers.has(ticker);
  if (mode === 'off') return { status: 'off', ticker, bases: [] };
  if (!Array.isArray(bases) || bases.length > 4 || bases.some((basis) => !FINANCIAL_PREPARED_BASES.includes(basis))) throw new Error('Invalid financial preparation bases.');
  // Claim each output BEFORE capturing its inputs. A paused worker must not
  // capture old sources, acquire a newer fence later, and replace newer output.
  const claims = [], results = [];
  // Publication can involve several bounded gateway requests. Reserve one
  // minute before starting another basis, plus the caller's cleanup margin.
  const stopped = () => signal?.aborted || Date.now() >= deadline - 60000;
  const defer = async (pending) => {
    await Promise.allSettled(pending.map(({ key, claim }) => release('financial', key, claim)));
    results.push(...pending.map(({ basis }) => ({ basis, status: 'busy', reason: 'The scheduled preparation deadline was reached.' })));
    return { ticker, status: 'busy', bases: results };
  };
  try {
  for (const basis of [...new Set(bases)]) {
    if (stopped()) { results.push({ basis, status: 'busy', reason: 'The scheduled preparation deadline was reached.' }); continue; }
    const key = financialPreparedKey(cohort.cik, basis);
    const claim = await begin('financial', key, { leaseSeconds: 270 });
    if (!claim) results.push({ basis, status: 'busy' });
    else {
      claims.push({ basis, key, claim });
      if (mirrorLegacy) await reserveLegacy(hotNamespace, key, claim.generation, claim);
    }
  }
  if (!claims.length) return { ticker, status: results.some(result => result.status === 'busy') ? 'busy' : 'prepared', bases: results };
  if (stopped()) return defer(claims);
  const sourcePaths = [`/submissions/CIK${cohort.cik}.json`, `/api/xbrl/companyfacts/CIK${cohort.cik}.json`];
  const sources = await Promise.all(sourcePaths.map((path) => read('sec', secDocumentIdentity(path).key, { allowStale: true })));
  if (sources.some((source) => !preparedEnvelopeUsable(source) || Number(source.payload.cik) !== Number(cohort.cik))) throw new PreparedSecUnavailableError('Both canonical SEC documents are required before preparing financial data.');
  const company = researchCompanyFromDocuments(ticker, sources[0].payload, sources[1].payload);
  const financialCompanyHash = financialInputIdentity(company);
  const inputDocuments = sources.map((source, index) => ({ key: secDocumentIdentity(sourcePaths[index]).key,
    contentHash: source.metadata.documentContentHash, generation: source.metadata.generation ?? null,
    fetchedAt: source.metadata.fetchedAt }));
  // A new raw submissions document (for example, a Form 4-only change) still
  // requires a new version-linked provenance record when financials are equal.
  const sourceIdentity = inputDocuments.map(({ key, contentHash }) => ({ key, contentHash }));
  const financialInputHash = hash({ financialCompanyHash, inputDocuments: sourceIdentity });
  const fetchedAt = sources.map((source) => source.metadata.fetchedAt).sort()[0];
  const revalidatedAt = sources.map((source) => source.metadata.revalidatedAt || source.metadata.fetchedAt).sort()[0];
  const expiresAt = sources.map((source) => source.metadata.expiresAt).sort()[0];
  if (stopped()) return defer(claims);
  const manifests = !mirrorLegacy && read === readDataset
    ? await readDatasetManifests('financial', claims.map(({ key }) => key)) : null;
  for (const [index, { basis, key, claim }] of claims.entries()) {
    if (stopped()) return defer(claims.slice(index));
    const manifest = manifests?.[index];
    const previous = manifests ? manifest && {
      metadata: manifest.metadata, payload: { version: manifest.metadata.calculationVersion },
    } : await read('financial', key, { allowStale: true });
    if (stopped()) return defer(claims.slice(index));
    if (previous?.metadata?.financialInputHash === financialInputHash && previous?.payload?.version === ANALYSIS_VERSION
      && previous?.metadata?.metricProjectionVersion === 'latest-all-v1') {
      if (await revalidate('financial', key, { claim, revalidatedAt, expiresAt }) !== true) throw new Error('Financial revalidation lost its publication claim.');
      const rollbackStored = mirrorLegacy && await legacyWrite(hotNamespace, legacyKey(ticker, basis),
        { gzip: gzipSync(JSON.stringify(previous.payload)).toString('base64'), metadata: { ...previous.metadata, revalidatedAt, expiresAt }, stale: false },
        25 * 3600, { ...claim, fenceId: key });
      results.push({ basis, status: 'unchanged', rollbackStored }); continue;
    }
    const payload = packAnalysisCompany(buildAnalysisCompany(company, { basis, asOf: '' }));
    if (stopped()) return defer(claims.slice(index));
    const metadata = { sourceId: 'sec-edgar', sourceUrl: sourcePaths.map((path) => `https://data.sec.gov${path}`)[1],
      entityId: cohort.cik, fetchedAt, revalidatedAt, expiresAt, publishedAt: null,
      reportPeriod: payload.periods[0]?.end || null, parserVersion: FINANCIAL_PREPARED_VERSION,
      calculationVersion: ANALYSIS_VERSION, financialInputHash, financialCompanyHash, metricProjectionVersion: 'latest-all-v1',
      inputDocuments, basis };
    const published = await publish({ dataset: 'financial', key, claim, payload, metadata,
      identityInputs: { financialInputHash, inputDocuments: sourceIdentity, calculationVersion: ANALYSIS_VERSION,
        metricProjectionVersion: 'latest-all-v1', basis, asOf: '' }, observations: financialServingObservations(payload) });
    // Keep actual rollback responses populated without copying unverified legacy input.
    const rollbackStored = mirrorLegacy && await legacyWrite(hotNamespace, legacyKey(ticker, basis),
      { gzip: gzipSync(JSON.stringify(payload)).toString('base64'), metadata: published?.metadata || metadata, stale: false },
      25 * 3600, { ...claim, fenceId: key });
    results.push({ basis, status: 'updated', bytes: Buffer.byteLength(JSON.stringify(payload)), rollbackStored });
  }
  return { ticker, status: results.some(result => result.status === 'busy') ? 'busy' : 'prepared', bases: results };
  } catch (error) {
    await Promise.allSettled(claims.map(({ key, claim }) => release('financial', key, claim)));
    throw error;
  }
}

// Reuse checks only across nearby retries. A long reuse window can skip a
// midnight daily cycle after a daytime backfill and outrun the 25-hour TTL.
const COVERAGE_SOURCE_RETRY_REUSE_MS = 15 * 60 * 1000;

/** One scheduled issuer reuses canonical source documents for every user view. */
export async function refreshSecCoverageCompany(ticker, {
  signal, deadline = Date.now() + 230000,
  refresh = refreshSecDocument, prepare = prepareFinancialCompany, read = readDataset,
  prepareViews, loadRegistry = loadSecCoverageRegistry,
} = {}) {
  await loadRegistry({ required: true });
  const company = companyForTicker(ticker);
  if (!company) throw new Error('Unknown prepared coverage issuer.');
  if (signal?.aborted || Date.now() >= deadline - 60000) return { ticker: company.ticker, status: 'busy', code: 'coverage_deadline' };
  const sourcePaths = [`/submissions/CIK${company.cik}.json`, `/api/xbrl/companyfacts/CIK${company.cik}.json`];
  const sources = [];
  for (const path of sourcePaths) {
    if (signal?.aborted || Date.now() >= deadline - 60000) return { ticker: company.ticker, status: 'busy', code: 'coverage_deadline' };
    const result = await refresh(path, { signal, minRecheckAgeMs: COVERAGE_SOURCE_RETRY_REUSE_MS });
    if (['busy', 'off'].includes(result.status)) return { ticker: company.ticker, status: result.status };
    sources.push(result.envelope || await read('sec', secDocumentIdentity(path).key, { allowStale: false }));
  }
  if (signal?.aborted || Date.now() >= deadline - 60000) return { ticker: company.ticker, status: 'busy', code: 'coverage_deadline' };
  const financial = await prepare(company.cik, { signal, deadline });
  if (financial.status === 'off') return { ticker: company.ticker, status: 'off' };
  if (financial.status === 'busy' || financial.bases?.some(value => value.status === 'busy')) return { ticker: company.ticker, status: 'busy' };
  if (signal?.aborted || Date.now() >= deadline - 30000) return { ticker: company.ticker, status: 'busy', code: 'coverage_deadline' };
  const buildViews = prepareViews || (await import('./preparedResearchViews.js')).prepareResearchViews;
  const researchCompany = researchCompanyFromDocuments(company.ticker, sources[0].payload, sources[1].payload);
  const supportingSources = [];
  if (company.cik === '0002115436') {
    for (const path of ['/submissions/CIK0000034088.json', '/api/xbrl/companyfacts/CIK0000034088.json']) {
      if (signal?.aborted || Date.now() >= deadline - 30000) return { ticker: company.ticker, status: 'busy', code: 'coverage_deadline' };
      const result = await refresh(path, { signal, minRecheckAgeMs: COVERAGE_SOURCE_RETRY_REUSE_MS });
      if (['busy', 'off'].includes(result.status)) return { ticker: company.ticker, status: result.status };
      supportingSources.push({ path, envelope: result.envelope || await read('sec', secDocumentIdentity(path).key, { allowStale: false }) });
    }
  }
  const research = await buildViews(researchCompany, sources, { signal, deadline, supportingSources });
  if (research?.status === 'off') return { ticker: company.ticker, status: 'off' };
  if (research?.status === 'busy' || research?.views?.some(value => value.status === 'busy') || research?.bases?.some(value => value.status === 'busy')) {
    return { ticker: company.ticker, status: 'busy' };
  }
  return { ticker: company.ticker, cik: company.cik, status: 'prepared', financial, research };
}

/** One invocation processes at most two companies. Persist nextCursor in its job. */
export async function refreshSecFinancialCohort({
  cursor = 0, maxCompanies = 2, signal, deadline = Date.now() + 180000,
  refresh = refreshSecDocument, prepare = prepareFinancialCompany,
} = {}) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > SEC_MIGRATION_COHORT.length
    || !Number.isSafeInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > 2) throw new Error('Invalid bounded SEC cohort cursor or limit.');
  const results = []; let nextCursor = cursor;
  for (const company of SEC_MIGRATION_COHORT.slice(cursor, cursor + maxCompanies)) {
    if (signal?.aborted || Date.now() > deadline - 30000) break;
    try {
      const submissions = await refresh(`/submissions/CIK${company.cik}.json`, { signal });
      const facts = await refresh(`/api/xbrl/companyfacts/CIK${company.cik}.json`, { signal });
      if ([submissions, facts].some((result) => result.status === 'busy')) break;
      const financial = await prepare(company.ticker, { signal, deadline });
      if (financial.status === 'busy' || financial.bases.some((result) => result.status === 'busy')) break;
      results.push({ ticker: company.ticker, submissions: submissions.status, companyfacts: facts.status, financial });
      nextCursor += 1;
    } catch (error) {
      results.push({ ticker: company.ticker, status: 'failed', error: String(error.message).slice(0, 240), retryAfter: error.retryAfter || null });
      break; // Resume the failing company; never silently skip evidence.
    }
  }
  return { cursor, nextCursor, done: nextCursor === SEC_MIGRATION_COHORT.length, results, coverage: SEC_MIGRATION_COHORT.length };
}
