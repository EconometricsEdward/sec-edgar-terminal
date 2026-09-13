import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getDataStoreMode, readDataset, beginDatasetWrite, publishDataset, revalidateDataset, releaseDatasetWrite, stableDataStoreJson } from './dataStore.js';
import { buildAnalysisCompany, packAnalysisCompany, ANALYSIS_VERSION } from './analysisResearch.js';
import { buildFilingUrl } from './filingTextParser.js';
import { RESEARCH_FORMS } from './researchWorkspace.js';
import { warmGet, warmReserveGeneration, warmSetGeneration } from './warmCache.js';
import { SEC_MIGRATION_COHORT, secDocumentIdentity, refreshSecDocument, preparedEnvelopeUsable, PreparedSecUnavailableError } from './secDocumentStore.js';

export const FINANCIAL_PREPARED_VERSION = 'financial-analysis-v1';
export const FINANCIAL_PREPARED_BASES = Object.freeze(['annual', 'quarter', 'ytd', 'ttm']);
const hotNamespace = 'analysis-research';
const legacyKey = (ticker, basis) => `${ANALYSIS_VERSION}:${ticker}:${basis}:`;
const hash = (value) => createHash('sha256').update(stableDataStoreJson(value)).digest('hex');
const companyForTicker = (ticker) => SEC_MIGRATION_COHORT.find((company) => company.ticker === ticker);

export function financialPreparedKey(ticker, basis, asOf = '') {
  const company = companyForTicker(ticker);
  return company && FINANCIAL_PREPARED_BASES.includes(basis) && !asOf
    ? `${FINANCIAL_PREPARED_VERSION}:${ANALYSIS_VERSION}:CIK${company.cik}:${basis}:latest` : null;
}

function validatePrepared(envelope, ticker, basis) {
  const data = envelope?.payload;
  return preparedEnvelopeUsable(envelope) && data.packed === true && data.version === ANALYSIS_VERSION
    && data.ticker === ticker && data.basis === basis && !data.asOf
    && Array.isArray(data.periods) && Array.isArray(data.sourceCatalog);
}

/** A compact result is the real Analysis API payload, not a second calculator. */
export async function readPreparedAnalysis({ ticker, basis = 'annual', asOf = '' }, {
  mode = getDataStoreMode('financial'), read = readDataset, hotRead = warmGet,
} = {}) {
  const key = financialPreparedKey(ticker, basis, asOf);
  if (mode !== 'supabase' || !key) return null;
  let cached = null;
  try {
    cached = await hotRead(hotNamespace, legacyKey(ticker, basis));
    if (cached?.gzip) cached = { metadata: cached.metadata, stale: cached.stale,
      payload: JSON.parse(gunzipSync(Buffer.from(cached.gzip, 'base64'), { maxOutputLength: 24 * 1024 * 1024 }).toString('utf8')) };
  } catch { cached = null; /* Durable read is bounded and contains no provider fetch. */ }
  if (validatePrepared(cached, ticker, basis)) return { ...cached, cacheSource: 'warm-prepared' };
  let envelope;
  try { envelope = await read('financial', key, { allowStale: true }); }
  catch { throw new PreparedSecUnavailableError('Prepared financial storage is temporarily unavailable.'); }
  if (!validatePrepared(envelope, ticker, basis)) throw new PreparedSecUnavailableError('Prepared financial data is not ready for this reporting basis.');
  return { ...envelope, cacheSource: 'supabase-prepared' };
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
    const comparable = stored?.metadata?.financialInputHash === financialInputIdentity(company);
    const stable = (value) => ({ ...value, observedAt: undefined });
    const status = !stored ? 'not-prepared' : !comparable ? 'different-source-version'
      : hash(stable(stored.payload)) === hash(stable(result)) ? 'identical' : 'mismatch';
    report({ dataset: 'financial', key, status });
    return status;
  } catch { report({ dataset: 'financial', key, status: 'storage-unavailable' }); return 'storage-unavailable'; }
}

function researchCompanyFromDocuments(ticker, submissions, companyfacts) {
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
  const selected = ['revenue', 'netIncome', 'totalAssets', 'stockholdersEquity', 'operatingCashFlow', 'freeCashFlow', 'roe', 'roa', 'currentRatio'];
  return selected.flatMap((metric) => {
    const point = data.metrics[metric]?.[0], period = data.periods[0];
    if (!point || !period) return [];
    const inputs = (point.sourceIds || []).map((id) => data.sourceCatalog[id]);
    const source = point.classification === 'reported' && inputs.length === 1 ? inputs[0] : null;
    const definition = data.definitions.find((item) => item.key === metric);
    return [{ metric, periodEnd: period.end, periodStart: source ? source.start : period.start || null,
      value: Number.isFinite(point.value) ? point.value : null,
      unit: source?.unit || (definition?.format === 'currency' ? 'USD' : definition?.format === 'percent' ? '%' : 'ratio'),
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
} = {}) {
  const cohort = companyForTicker(ticker);
  if (!cohort) throw new Error('Financial preparation is limited to the documented SEC cohort.');
  if (mode === 'off') return { status: 'off', ticker, bases: [] };
  if (!Array.isArray(bases) || bases.length > 4 || bases.some((basis) => !FINANCIAL_PREPARED_BASES.includes(basis))) throw new Error('Invalid financial preparation bases.');
  // Claim each output BEFORE capturing its inputs. A paused worker must not
  // capture old sources, acquire a newer fence later, and replace newer output.
  const claims = [], results = [];
  for (const basis of [...new Set(bases)]) {
    const key = financialPreparedKey(ticker, basis);
    const claim = await begin('financial', key, { leaseSeconds: 120 });
    if (!claim) results.push({ basis, status: 'busy' });
    else {
      await reserveLegacy(hotNamespace, key, claim.generation, claim);
      claims.push({ basis, key, claim });
    }
  }
  if (!claims.length) return { ticker, status: 'prepared', bases: results };
  try {
  const sourcePaths = [`/submissions/CIK${cohort.cik}.json`, `/api/xbrl/companyfacts/CIK${cohort.cik}.json`];
  const sources = await Promise.all(sourcePaths.map((path) => read('sec', secDocumentIdentity(path).key, { allowStale: true })));
  if (sources.some((source) => !preparedEnvelopeUsable(source))) throw new PreparedSecUnavailableError('Both canonical SEC documents are required before preparing financial data.');
  const company = researchCompanyFromDocuments(ticker, sources[0].payload, sources[1].payload);
  const financialInputHash = financialInputIdentity(company);
  const fetchedAt = sources.map((source) => source.metadata.fetchedAt).sort()[0];
  const revalidatedAt = sources.map((source) => source.metadata.revalidatedAt || source.metadata.fetchedAt).sort()[0];
  const expiresAt = sources.map((source) => source.metadata.expiresAt).sort()[0];
  for (const { basis, key, claim } of claims) {
    const previous = await read('financial', key, { allowStale: true });
    if (previous?.metadata?.financialInputHash === financialInputHash && previous?.payload?.version === ANALYSIS_VERSION) {
      if (await revalidate('financial', key, { claim, revalidatedAt, expiresAt }) !== true) throw new Error('Financial revalidation lost its publication claim.');
      const rollbackStored = await legacyWrite(hotNamespace, legacyKey(ticker, basis),
        { gzip: gzipSync(JSON.stringify(previous.payload)).toString('base64'), metadata: { ...previous.metadata, revalidatedAt, expiresAt }, stale: false },
        25 * 3600, { ...claim, fenceId: key });
      results.push({ basis, status: 'unchanged', rollbackStored }); continue;
    }
    const payload = packAnalysisCompany(buildAnalysisCompany(company, { basis, asOf: '' }));
    const metadata = { sourceId: 'sec-edgar', sourceUrl: sourcePaths.map((path) => `https://data.sec.gov${path}`)[1],
      entityId: cohort.cik, fetchedAt, revalidatedAt, expiresAt, publishedAt: null,
      reportPeriod: payload.periods[0]?.end || null, parserVersion: FINANCIAL_PREPARED_VERSION,
      calculationVersion: ANALYSIS_VERSION, financialInputHash,
      inputDocuments: sources.map((source, index) => ({ key: secDocumentIdentity(sourcePaths[index]).key,
        contentHash: source.metadata.documentContentHash, generation: source.metadata.generation ?? null,
        fetchedAt: source.metadata.fetchedAt })), basis };
    const published = await publish({ dataset: 'financial', key, claim, payload, metadata,
      identityInputs: { financialInputHash, calculationVersion: ANALYSIS_VERSION, basis, asOf: '' }, observations: financialServingObservations(payload) });
    // Keep actual rollback responses populated without copying unverified legacy input.
    const rollbackStored = await legacyWrite(hotNamespace, legacyKey(ticker, basis),
      { gzip: gzipSync(JSON.stringify(payload)).toString('base64'), metadata: published?.metadata || metadata, stale: false },
      25 * 3600, { ...claim, fenceId: key });
    results.push({ basis, status: 'updated', bytes: Buffer.byteLength(JSON.stringify(payload)), rollbackStored });
  }
  return { ticker, status: 'prepared', bases: results };
  } catch (error) {
    await Promise.allSettled(claims.map(({ key, claim }) => release('financial', key, claim)));
    throw error;
  }
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
      const financial = await prepare(company.ticker);
      if (financial.bases.some((result) => result.status === 'busy')) break;
      results.push({ ticker: company.ticker, submissions: submissions.status, companyfacts: facts.status, financial });
      nextCursor += 1;
    } catch (error) {
      results.push({ ticker: company.ticker, status: 'failed', error: String(error.message).slice(0, 240), retryAfter: error.retryAfter || null });
      break; // Resume the failing company; never silently skip evidence.
    }
  }
  return { cursor, nextCursor, done: nextCursor === SEC_MIGRATION_COHORT.length, results, coverage: SEC_MIGRATION_COHORT.length };
}
