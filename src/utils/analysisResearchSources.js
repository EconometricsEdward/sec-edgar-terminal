import { createHash } from 'node:crypto';
import { loadResearchCompany, secResearchJson } from './secResearchData.js';
import { secFetch } from './secClient.js';
import { readBoundedFilingResponse } from './filingsReader.js';
import { SEC_EVIDENCE_CONTINUITY } from './secEvidenceContinuity.js';
import { latestRiskProfileFiling, mergeRiskProfileCompanyFacts, supplementRiskProfileFacts } from './riskProfileSources.js';
import { verifiesJointRegistrantFacts, RISK_NOTE_MAX_BYTES } from './riskNoteFacts.js';
import { reportingPeriods } from './xbrlPeriods.js';
export { analysisSourcesDegraded, analysisSourceCachePolicy } from './analysisSourceCoverage.js';

const normalizeCik = value => /^\d{1,10}$/.test(String(value || '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const contentHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export function loadAnalysisCompanyFacts(cik, signal) {
  return secResearchJson(`/api/xbrl/companyfacts/CIK${cik}.json`, signal);
}

export async function loadAnalysisFiling(filing, signal) {
  signal?.throwIfAborted();
  const response = await secFetch(filing.url, { signal, timeoutMs: 10000, retries: 0, maxBytes: RISK_NOTE_MAX_BYTES,
    redirect: 'error', headers: { Accept: 'text/html,text/plain' } });
  if (!response.ok || /application\/pdf|image\/|application\/(?:zip|octet-stream)/i.test(response.headers.get('content-type') || ''))
    throw new Error('The selected SEC filing does not contain retrievable inline facts.');
  return readBoundedFilingResponse(response, RISK_NOTE_MAX_BYTES);
}

// The base loader has already verified the SEC registrant. Rebuild the narrow
// manifest from its rows so the shared filing selector also verifies dates,
// accession and document names; never accept a caller-provided document URL.
function selectedManifest(company, basis) {
  const filings = (company.filings || []).filter(row => basis !== 'annual' || row.form === '10-K');
  return { cik: company.cik, filings: { recent: {
    accessionNumber: filings.map(row => row.accession), form: filings.map(row => row.form),
    filingDate: filings.map(row => row.filingDate), reportDate: filings.map(row => row.reportDate),
    primaryDocument: filings.map(row => row.primaryDoc),
  } } };
}

/** Add reviewed source continuity and at most one basis-appropriate primary
 * filing. All observations and transition evidence are gated by filing cutoff.
 * Additional retrieval shares a twelve-second budget and cannot extend a
 * caller's deadline. Unsupported facts remain missing, never estimated.
 */
export async function enrichAnalysisCompanySources(company, { basis = 'annual', asOf = '' } = {}, {
  now = new Date(), signal,
  loadCompanyFacts = loadAnalysisCompanyFacts,
  loadFiling = loadAnalysisFiling,
} = {}) {
  signal?.throwIfAborted();
  const cik = normalizeCik(company?.cik), today = new Date(now).toISOString().slice(0, 10);
  if (!cik || !company?.facts || !['annual', 'quarter', 'ytd', 'ttm'].includes(basis)
    || (asOf && (!validDate(asOf) || asOf > today))) throw new Error('The Analysis issuer, basis or filing cutoff is invalid.');
  const cutoff = asOf || today, periodKind = basis === 'annual' ? 'annual' : 'quarter';
  const extraSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000)]);
  const transition = SEC_EVIDENCE_CONTINUITY[cik];
  const continuity = { status: 'not-applicable', currentCik: cik, predecessorCiks: [], sourceUrl: null, effectiveDate: null };
  const sources = [company], notices = [], sourceDocuments = [];
  if (transition && transition.source.filed <= cutoff) {
    Object.assign(continuity, { status: 'partial', predecessorCiks: [...transition.predecessorCiks],
      sourceUrl: transition.source.url, effectiveDate: transition.effectiveDate });
    const results = await Promise.allSettled(transition.predecessorCiks.map(id => loadCompanyFacts(id, extraSignal)));
    signal?.throwIfAborted();
    for (const [index, result] of results.entries()) {
      const predecessorCik = transition.predecessorCiks[index];
      if (result.status !== 'fulfilled' || normalizeCik(result.value?.cik) !== predecessorCik
        || !result.value?.facts || typeof result.value.facts !== 'object' || Array.isArray(result.value.facts)) continue;
      sources.push(result.value);
      sourceDocuments.push({ kind: 'companyfacts', cik: predecessorCik,
        url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${predecessorCik}.json`, contentHash: contentHash(result.value) });
    }
    if (sources.length === transition.predecessorCiks.length + 1) continuity.status = 'applied';
    notices.push(continuity.status === 'applied'
      ? 'Verified predecessor history is included before the registrant transition. Each fact retains its original SEC registrant.'
      : 'Some verified predecessor history could not be loaded; historical comparisons may be incomplete.');
  }
  let facts = mergeRiskProfileCompanyFacts(sources, { cik, today: cutoff });
  const companyFactsThrough = reportingPeriods(facts, periodKind, cutoff)[0]?.end || null;
  const filing = latestRiskProfileFiling(selectedManifest(company, basis), cik, cutoff);
  const newer = filing && (!companyFactsThrough || filing.reportDate > companyFactsThrough);
  const classificationNeeded = filing && ['MarketableSecurities', 'NotesAndLoansPayable'].some(tag =>
    (facts['us-gaap']?.[tag]?.units?.USD || []).some(row => row.end === filing.reportDate && !row.balanceClassification));
  const filingFallback = { status: 'not-needed', reason: newer ? 'newer-filing' : classificationNeeded ? 'classification' : null,
    reportDate: filing?.reportDate || null, accession: filing?.accession || null, documentUrl: filing?.url || null,
    addedFacts: 0, classifiedFacts: 0 };
  if (filing && (newer || classificationNeeded)) {
    try {
      extraSignal.throwIfAborted();
      const html = await loadFiling(filing, extraSignal);
      extraSignal.throwIfAborted();
      let factCik = cik;
      if (transition?.predecessorCiks.length === 1 && transition.source.filed <= cutoff
        && filing.accession === transition.source.accession && filing.reportDate === transition.source.reportDate
        && filing.reportDate < transition.effectiveDate
        && verifiesJointRegistrantFacts(html, { cik, predecessorCik: transition.predecessorCiks[0], filing })) factCik = transition.predecessorCiks[0];
      const supplemented = supplementRiskProfileFacts(facts, html, { cik, filing, factCik });
      facts = supplemented.facts;
      sourceDocuments.push({ kind: 'inline-filing', cik, factCik, accession: filing.accession,
        url: filing.url, contentHash: contentHash(html) });
      const improved = supplemented.addedFacts > 0 || supplemented.classifiedFacts > 0;
      Object.assign(filingFallback, { status: improved ? 'applied' : 'no-supported-facts',
        addedFacts: supplemented.addedFacts, classifiedFacts: supplemented.classifiedFacts });
      notices.push(improved
        ? 'The selected SEC filing supplements company facts with verified consolidated standard USD facts. Custom concepts, other currencies and unsupported per-share or share-count facts remain unavailable.'
        : 'The selected filing could be verified, but it added no supported consolidated facts.');
    } catch {
      signal?.throwIfAborted();
      filingFallback.status = 'unavailable';
      notices.push(newer
        ? 'A newer eligible SEC filing exists, but its facts could not be verified within this request. Values retain their displayed reporting dates.'
        : 'Some balance-sheet classifications could not be verified from the selected filing. Related metrics may remain unavailable.');
    }
  }
  signal?.throwIfAborted();
  const historicalManifestLimited = Boolean(asOf && !filing);
  if (historicalManifestLimited) notices.push('No eligible original filing was found in the loaded submission history for this cutoff. Company facts still use only observations filed by the cutoff; older primary filings were not searched.');
  return { ...company, cik, facts, sourceCoverage: { filedThrough: cutoff, companyFactsThrough,
    supplementedThrough: reportingPeriods(facts, periodKind, cutoff)[0]?.end || null,
    latestFilingReportDate: filing?.reportDate || null, filingFallback, continuity, historicalManifestLimited,
    sourceDocuments, notices } };
}

export async function loadAnalysisResearchCompany(ticker, { basis = 'annual', asOf = '', signal, ...options } = {}) {
  const company = await loadResearchCompany(ticker, { ...options, signal });
  return enrichAnalysisCompanySources(company, { basis, asOf }, { signal });
}
