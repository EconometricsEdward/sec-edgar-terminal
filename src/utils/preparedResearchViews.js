import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { getDataStoreMode, readDataset, readDatasetManifests, beginDatasetWrite, publishDataset,
  revalidateDataset, releaseDatasetWrite, stableDataStoreJson } from './dataStore.js';
import { buildCompareCompany, COMPARE_VERSION, COMPARE_MAPPING_VERSION } from './compareResearch.js';
import { packAnalysisCompany, ANALYSIS_VERSION } from './analysisResearch.js';
import { packPortfolioCompany } from './portfolioEvidenceCodec.js';
import { buildPortfolioCompanyFromDocuments } from './portfolioResearchServer.js';
import { preparedEnvelopeUsable, secDocumentIdentity } from './secDocumentStore.js';
import { warmReserveGeneration, warmSetGeneration } from './warmCache.js';
import { researchPreparedKey, RESEARCH_VIEW_BASES, RESEARCH_SERVING_NAMESPACE, researchHotCacheEligible } from './preparedResearchStore.js';
import { enrichAnalysisCompanySources, loadAnalysisCompanyFacts, loadAnalysisFiling } from './analysisResearchSources.js';
import { analysisSourcesDegraded } from './analysisSourceCoverage.js';

const digest = (value) => createHash('sha256').update(stableDataStoreJson(value)).digest('hex');
const COMPARE_SOURCE_VERSION = 'compare-sources-v1';

/** Reuse the canonical documents and established calculators, preserving every source and period. */
export async function prepareResearchViews(company, sourceEnvelopes, {
  mode = getDataStoreMode('financial'), read = readDataset, manifests = readDatasetManifests,
  begin = beginDatasetWrite, publish = publishDataset, revalidate = revalidateDataset,
  release = releaseDatasetWrite, reserve = warmReserveGeneration, hotWrite = warmSetGeneration,
  bases = ['annual', 'quarter', 'ytd', 'ttm'],
  signal, deadline = Infinity,
  supportingSources = [],
  enrichCompany = enrichAnalysisCompanySources,
  loadCompanyFacts = loadAnalysisCompanyFacts, loadFiling = loadAnalysisFiling,
} = {}) {
  if (mode === 'off') return { status: 'off', ticker: company.ticker, bases: [] };
  if (!Array.isArray(bases) || bases.length > 4 || bases.some((basis) => !RESEARCH_VIEW_BASES.portfolio.includes(basis)))
    throw new Error('Invalid research preparation bases.');
  const primarySources = Array.isArray(sourceEnvelopes) ? sourceEnvelopes : [];
  const primaryPaths = [`/submissions/CIK${company.cik}.json`, `/api/xbrl/companyfacts/CIK${company.cik}.json`];
  if (primarySources.length !== 2 || primarySources.some((source) => !preparedEnvelopeUsable(source))
    || primarySources.some((source) => Number(source.payload.cik) !== Number(company.cik)))
    throw new Error('Two verified canonical SEC documents are required for prepared research.');
  const supportingPaths = ['/submissions/CIK0000034088.json', '/api/xbrl/companyfacts/CIK0000034088.json'];
  if (!Array.isArray(supportingSources) || supportingSources.length > 2
    || (supportingSources.length && company.cik !== '0002115436')
    || new Set(supportingSources.map((source) => source.path)).size !== supportingSources.length
    || supportingSources.some((source) => !supportingPaths.includes(source.path)
      || !preparedEnvelopeUsable(source.envelope) || Number(source.envelope.payload.cik) !== 34088))
    throw new Error('Supporting SEC documents must belong to the verified ExxonMobil predecessor chain.');
  const sources = [...primarySources, ...supportingSources.map((source) => source.envelope)];
  const paths = [...primaryPaths, ...supportingSources.map((source) => source.path)];
  const sourceKeys = paths.map((path) => secDocumentIdentity(path).key);
  const fetchedAt = sources.map((source) => source.metadata.fetchedAt).sort()[0];
  const revalidatedAt = sources.map((source) => source.metadata.revalidatedAt || source.metadata.fetchedAt).sort()[0];
  const expiresAt = sources.map((source) => source.metadata.expiresAt).sort()[0];
  const inputDocuments = sources.map((source, index) => ({ key: sourceKeys[index],
    contentHash: source.metadata.documentContentHash || source.metadata.contentHash,
    generation: source.metadata.generation, versionId: source.metadata.versionId,
    fetchedAt: source.metadata.fetchedAt }));
  const financialBaseInputHash = digest({ company, inputs: inputDocuments.map(({ key, contentHash }) => ({ key, contentHash })),
    compareVersion: COMPARE_VERSION, compareMappingVersion: COMPARE_MAPPING_VERSION,
    analysisVersion: ANALYSIS_VERSION, projectionVersion: RESEARCH_SERVING_NAMESPACE });
  const claims = [], results = [];
  const hotEligible = researchHotCacheEligible(company.cik);
  const mirror = (key, claim, payload, metadata) => hotEligible ? hotWrite(RESEARCH_SERVING_NAMESPACE, key,
    { gzip: gzipSync(JSON.stringify(payload)).toString('base64'), metadata, stale: false },
    25 * 3600, { ...claim, fenceId: key }) : Promise.resolve(false);
  try {
    for (const [kind, supported] of Object.entries(RESEARCH_VIEW_BASES)) {
      for (const basis of [...new Set(bases)].filter((value) => supported.includes(value))) {
        if (signal?.aborted || Date.now() > deadline - 30000) {
          results.push({ kind, basis, status: 'busy', reason: 'The scheduled preparation deadline was reached.' });
          continue;
        }
        const key = researchPreparedKey(kind, company.cik, basis);
        const claim = await begin('financial', key, { leaseSeconds: 300 });
        if (!claim) { results.push({ kind, basis, status: 'busy' }); continue; }
        claims.push({ kind, basis, key, claim });
        if (hotEligible) await reserve(RESEARCH_SERVING_NAMESPACE, key, claim.generation, claim);
      }
    }
    if (!claims.length) return { status: 'busy', ticker: company.ticker, bases: results };
    // The parent captured these objects earlier. Verify their immutable versions
    // AFTER acquiring output claims so a delayed worker cannot republish older inputs.
    const current = await manifests('sec', sourceKeys);
    if (current.length !== sources.length || current.some((manifest, index) => !manifest
      || (sources[index].metadata.versionId && manifest.id !== sources[index].metadata.versionId)
      || (sources[index].metadata.contentHash && manifest.contentHash !== sources[index].metadata.contentHash)
      || (!sources[index].metadata.versionId && !sources[index].metadata.contentHash)))
      throw new Error('SEC inputs changed before research preparation acquired its publication claims. Retry this company.');
    const documents = Object.fromEntries(paths.map((path, index) => [path, sources[index].payload]));
    const priorViews = await manifests('financial', claims.map(({ key }) => key));
    // Quarter and TTM use the same eligible primary filing. Share the enrichment
    // and document reads within this preparation, retaining source hashes.
    const augmented = new Map(), extraDocuments = new Map();
    const reuse = (key, load) => {
      if (!extraDocuments.has(key)) extraDocuments.set(key, Promise.resolve().then(load));
      return extraDocuments.get(key);
    };
    const enrich = (basis) => {
      const sourceBasis = basis === 'annual' ? 'annual' : 'quarter';
      if (!augmented.has(sourceBasis)) augmented.set(sourceBasis, enrichCompany(company, { basis: sourceBasis, asOf: '' }, {
        signal,
        loadCompanyFacts: (cik, requestSignal) => reuse(`companyfacts:${cik}`, () =>
          documents[`/api/xbrl/companyfacts/CIK${cik}.json`] || loadCompanyFacts(cik, requestSignal)),
        loadFiling: (filing, requestSignal) => reuse(`filing:${filing.url}`, () => loadFiling(filing, requestSignal)),
      }));
      return augmented.get(sourceBasis);
    };
    for (const [index, { kind, basis, key, claim }] of claims.entries()) {
      if (signal?.aborted || Date.now() > deadline - 25000) {
        await release('financial', key, claim);
        results.push({ kind, basis, status: 'busy', reason: 'The scheduled preparation deadline was reached.' });
        continue;
      }
      const prior = priorViews[index]?.metadata;
      let financialInputHash = financialBaseInputHash, enrichedCompany, supplementalDocuments = [];
      const reusableCompare = kind === 'compare' && prior?.financialBaseInputHash === financialBaseInputHash
        && prior.compareMappingVersion === COMPARE_MAPPING_VERSION && prior.sourceEnrichmentVersion === COMPARE_SOURCE_VERSION
        && prior.sourceCoverage && !analysisSourcesDegraded(prior)
        && !prior.supplementalDocuments?.some(document => document.kind === 'companyfacts');
      if (kind === 'compare' && !reusableCompare) {
        enrichedCompany = await enrich(basis);
        if (signal?.aborted || Date.now() > deadline - 25000 || analysisSourcesDegraded(enrichedCompany)) {
          await release('financial', key, claim);
          results.push({ kind, basis, status: 'busy', reason: 'Supplemental SEC evidence could not be verified within the preparation budget; the last good prepared view was retained.' });
          continue;
        }
        supplementalDocuments = enrichedCompany.sourceCoverage?.sourceDocuments || [];
        financialInputHash = digest({ financialBaseInputHash, supplementalDocuments,
          compareMappingVersion: COMPARE_MAPPING_VERSION, sourceEnrichmentVersion: COMPARE_SOURCE_VERSION });
      }
      if (reusableCompare || prior?.financialInputHash === financialInputHash) {
        if (await revalidate('financial', key, { claim, revalidatedAt, expiresAt }) !== true)
          throw new Error('Research revalidation lost its publication claim.');
        // Only the tiny original pilot has Redis mirrors. The broad cohort can
        // renew unchanged views using metadata alone, without downloading objects.
        const previous = hotEligible ? await read('financial', key, { allowStale: true }) : null;
        const hotStored = previous ? await mirror(key, claim, previous.payload,
          { ...previous.metadata, revalidatedAt, expiresAt }) : false;
        results.push({ kind, basis, status: 'unchanged', hotStored });
        continue;
      }
      let payload;
      if (kind === 'compare') payload = packAnalysisCompany(buildCompareCompany(enrichedCompany, { basis }));
      else {
        const result = await buildPortfolioCompanyFromDocuments({ cik: company.cik, ticker: company.ticker }, basis,
          documents, { retrievedAt: fetchedAt });
        if (result.status !== 'prepared') {
          await release('financial', key, claim);
          results.push({ kind, basis, status: 'skipped', reason: result.reason });
          continue;
        }
        payload = packPortfolioCompany(result.payload);
      }
      const metadata = { sourceId: 'sec-edgar', sourceUrl: `https://data.sec.gov${paths[1]}`,
        entityId: company.cik, fetchedAt, revalidatedAt, expiresAt, publishedAt: null,
        reportPeriod: kind === 'compare' ? payload.periods[0]?.end || null : payload.period?.end || null,
        parserVersion: RESEARCH_SERVING_NAMESPACE, calculationVersion: kind === 'compare' ? COMPARE_VERSION : ANALYSIS_VERSION,
        financialInputHash, inputDocuments, basis, view: kind,
        ...(kind === 'compare' ? { financialBaseInputHash, compareMappingVersion: COMPARE_MAPPING_VERSION,
          sourceEnrichmentVersion: COMPARE_SOURCE_VERSION, sourceCoverage: enrichedCompany.sourceCoverage, supplementalDocuments } : {}) };
      const stored = await publish({ dataset: 'financial', key, claim, payload, metadata,
        identityInputs: { financialInputHash, kind, basis } });
      const hotStored = await mirror(key, claim, payload, stored?.metadata || metadata);
      results.push({ kind, basis, status: 'updated', bytes: Buffer.byteLength(JSON.stringify(payload)), hotStored });
    }
    return { status: results.some((result) => result.status === 'busy') ? 'busy' : 'prepared', ticker: company.ticker, bases: results };
  } catch (error) {
    await Promise.allSettled(claims.map(({ key, claim }) => release('financial', key, claim)));
    throw error;
  }
}
