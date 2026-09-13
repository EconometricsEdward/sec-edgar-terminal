import { gunzipSync } from 'node:zlib';
import { getDataStoreMode, readDataset } from './dataStore.js';
import { ANALYSIS_VERSION, unpackAnalysisCompany } from './analysisResearch.js';
import { COMPARE_VERSION } from './compareResearch.js';
import { unpackPortfolioCompany } from './portfolioEvidenceCodec.js';
import { warmGet } from './warmCache.js';
import { preparedEnvelopeUsable, PreparedSecUnavailableError, isSecPreparedReadEnabled, getSecPreparedCompany, SEC_MIGRATION_COHORT } from './secDocumentStore.js';

export const RESEARCH_SERVING_NAMESPACE = 'research-serving-v1';
export const RESEARCH_VIEW_BASES = Object.freeze({
  compare: Object.freeze(['annual', 'quarter', 'ttm']),
  portfolio: Object.freeze(['annual', 'quarter', 'ytd', 'ttm']),
});
export const MARKET_DURABLE_KEY = 'research-market-overview-v1:latest';
export const researchHotCacheEligible = (cik) => SEC_MIGRATION_COHORT.some((company) => company.cik === cik);
const MAX_GZIP_BYTES = 6 * 1024 * 1024;
const MAX_DECODE_BYTES = 24 * 1024 * 1024;

export function researchPreparedKey(kind, cik, basis) {
  if (!RESEARCH_VIEW_BASES[kind]?.includes(basis) || !/^\d{10}$/.test(cik) || Number(cik) === 0) return null;
  const version = kind === 'compare' ? COMPARE_VERSION : ANALYSIS_VERSION;
  return `research-${kind}-v1:${version}:CIK${cik}:${basis}:latest`;
}

function validView(envelope, kind, cik, basis) {
  const value = envelope?.payload;
  return preparedEnvelopeUsable(envelope) && value?.cik === cik && value.basis === basis
    && value.metrics && typeof value.metrics === 'object'
    && (kind === 'compare'
      ? value.version === COMPARE_VERSION && !value.asOf && Array.isArray(value.periods) && value.packed === true
      : value.analysisVersion === ANALYSIS_VERSION && Array.isArray(value.filings) && Array.isArray(value.warnings));
}

/** Published projections only. A missing projection keeps the existing bounded path during backfill. */
export async function readPreparedResearchView(kind, { ticker, cik, basis = 'annual', asOf = '', format = 'expanded' } = {}, {
  mode = getDataStoreMode('financial'), read = readDataset, hotRead = warmGet,
  lookup = getSecPreparedCompany, enabled = isSecPreparedReadEnabled,
} = {}) {
  if (mode !== 'supabase' || asOf || !RESEARCH_VIEW_BASES[kind]?.includes(basis)) return null;
  const entity = lookup(cik || ticker);
  if (!entity || !enabled(entity.cik)) return null;
  const key = researchPreparedKey(kind, entity.cik, basis);
  let envelope = null, cacheSource = 'warm-prepared';
  try {
    const cached = researchHotCacheEligible(entity.cik) ? await hotRead(RESEARCH_SERVING_NAMESPACE, key) : null;
    if (typeof cached?.gzip === 'string' && cached.gzip.length <= Math.ceil(MAX_GZIP_BYTES / 3) * 4) {
      envelope = { metadata: cached.metadata, stale: cached.stale,
        payload: JSON.parse(gunzipSync(Buffer.from(cached.gzip, 'base64'), { maxOutputLength: MAX_DECODE_BYTES }).toString('utf8')) };
    }
  } catch { /* A corrupt or unavailable hot cache uses the immutable durable projection. */ }
  if (!validView(envelope, kind, entity.cik, basis)) {
    try { envelope = await read('financial', key, { allowStale: true }); }
    catch { throw new PreparedSecUnavailableError('Prepared company research is temporarily unavailable.'); }
    if (!envelope) return null;
    cacheSource = 'supabase-prepared';
  }
  if (!validView(envelope, kind, entity.cik, basis)) throw new PreparedSecUnavailableError('Prepared company research failed validation or requires a scheduled refresh.');
  let payload;
  try { payload = kind === 'compare'
    ? format === 'packed' ? envelope.payload : unpackAnalysisCompany(envelope.payload)
    : unpackPortfolioCompany(envelope.payload); }
  catch { throw new PreparedSecUnavailableError('Prepared company evidence could not be decoded.'); }
  // Share classes identify the same issuer. Preserve the requested security label,
  // while all stored metrics and evidence remain attached to the validated CIK.
  if (ticker) payload = { ...payload, ticker };
  const stale = Boolean(envelope.stale || Date.parse(envelope.metadata.expiresAt) <= Date.now());
  return { ...envelope, payload, serializedPayload: undefined, stale, cacheSource };
}

export const readPreparedCompare = (selection, dependencies) => readPreparedResearchView('compare', selection, dependencies);
export const readPreparedPortfolio = (selection, dependencies) => readPreparedResearchView('portfolio', selection, dependencies);
