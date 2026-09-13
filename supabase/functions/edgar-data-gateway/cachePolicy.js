/** Reviewed, reproducible public data only. Shared by the Node adapter and gateway.
 * TTL is retention, not source freshness: readers retain their existing age checks.
 * Coordination, auth, user content, arbitrary URLs and preview keys are excluded.
 */
export const DISPOSABLE_CACHE_LIMITS = Object.freeze({
  rpcBytes: 9 * 1024 * 1024, gzipBytes: 6 * 1024 * 1024,
  rawBytes: 32 * 1024 * 1024, batch: 25, stateBytes: 64 * 1024,
});
export const DISPOSABLE_CACHE_TTLS = Object.freeze({
  snapshot: 7 * 86400, checkpoint: 14 * 86400, research: 25 * 3600,
  document: 30 * 86400, reference: 90 * 86400, history: 90 * 86400,
});
const CIK = '(?!0000000000)[0-9]{10}';
const TICKER = '[A-Z0-9][A-Z0-9.-]{0,9}';
const ACCESSION = '[0-9]{10}-[0-9]{2}-[0-9]{6}';
const DATE = '[0-9]{4}-[0-9]{2}-[0-9]{2}';
const BASIS = '(?:ANNUAL|QUARTER|YTD|TTM)';
const re = pattern => new RegExp(`^(?:${pattern})$`);
const ticker = re(TICKER), cik = re(CIK), accession = re(ACCESSION);
const atlas = /^(?:ATLAS|ATLAS-LAST-GOOD)$/;
const snapshotTypes = new Set(['market-v2', 'market-research-v3', 'market-overview-v1', 'quant-atlas-v1', 'quant-atlas-v2:production']);
const companyTypes = new Set(['quant-company-v1', 'quant-company-v2:production', 'quant-company-v2:production:attempts']);
const coverageTypes = new Set(['quant-coverage-v1', 'quant-coverage-v2:production']);
const filingDocument = re(`${CIK}:${ACCESSION}:[A-Z0-9_][A-Z0-9_.-]{0,254}`);
const secPath = re(`/SUBMISSIONS/CIK(${CIK})(-SUBMISSIONS-[0-9]{1,10})?\\.JSON|/API/XBRL/COMPANYFACTS/CIK(${CIK})\\.JSON`);
const submissionsFile = re(`CIK(${CIK})(-SUBMISSIONS-[0-9]{1,10})?\\.JSON`);
const PILOT_TICKERS = Object.freeze({ '0000320193': 'AAPL', '0000789019': 'MSFT', '0000019617': 'JPM', '0000002098': 'ACU' });
const researchServing = /^RESEARCH-(COMPARE|PORTFOLIO)-V1:(?:COMPARE-V2|ANALYSIS-V1\.4):CONTEXT-V3:CIK([0-9]{10}):(ANNUAL|QUARTER|YTD|TTM):LATEST$/;

/** Preserve the legacy warm cache identity: type is exact, id is uppercase. */
export function disposableCachePolicy(type, originalId) {
  if (typeof type !== 'string' || typeof originalId !== 'string' || !originalId.length || originalId.length > 1024) return null;
  const id = originalId.toUpperCase();
  let family = null, sourceCik = null;
  if (snapshotTypes.has(type) && atlas.test(id)) family = 'snapshot';
  else if (['market-v2', 'market-research-v3'].includes(type) && id === 'OBSERVATIONS') family = 'history';
  else if (type === 'edgar.fundamental-universe.v2:production' && /^(?:ANNUAL|QUARTER|TTM)(?:-LAST-GOOD)?$/.test(id)) family = 'snapshot';
  else if (type === 'market-research-v3:company:production' && ticker.test(id)) family = 'checkpoint';
  else if (companyTypes.has(type) && cik.test(id)) family = 'checkpoint';
  else if (coverageTypes.has(type) && id === 'MEMBERSHIP') family = 'reference';
  else if (coverageTypes.has(type) && /^BATCH-[0-9]{1,3}$/.test(id)) family = 'checkpoint';
  else if (type === 'sec-directory-v1' && /^(?:OPERATING|FUNDS)$/.test(id)) family = 'reference';
  else if (type === 'submissions-cik' && cik.test(id)) { family = 'research'; sourceCik = id; }
  else if (type === 'research-sec-v1') {
    const match = secPath.exec(id);
    if (match) { family = match[2] ? 'document' : 'research'; sourceCik = match[2] ? null : match[1] || match[3]; }
  } else if (type === 'filings-submissions-v1') {
    const match = submissionsFile.exec(id);
    if (match) { family = match[2] ? 'document' : 'research'; sourceCik = match[2] ? null : match[1]; }
  } else if (type === 'analysis-research' && re(`ANALYSIS-V1\\.4:(?:CONTEXT-V3|XBRL-V1):${TICKER}:${BASIS}:(?:${DATE})?`).test(id)) family = 'research';
  else if (type === 'research-serving-v1') {
    const match = researchServing.exec(id);
    if (match && Object.hasOwn(PILOT_TICKERS, match[2]) && (match[1] !== 'COMPARE' || match[3] !== 'YTD')
      && (match[1] === 'COMPARE' ? id.includes(':COMPARE-V2:') : id.includes(':ANALYSIS-V1.4:'))) family = 'research';
  }
  else if (type === 'compare-research' && re(`COMPARE-V2:(?:CONTEXT-V3|XBRL-V1):${TICKER}:(?:ANNUAL|QUARTER|TTM):(?:${DATE})?`).test(id)) family = 'research';
  else if (type === 'portfolio-company-v3-evidence-continuity' && re(`PORTFOLIO-COMPANY-V3-EVIDENCE-CONTINUITY:COMPARE-V2:CONTEXT-V3:ANALYSIS-V1\\.4:CONTEXT-V3:${CIK}:${BASIS}`).test(id)) family = 'research';
  else if (type === 'holders-v3' && ticker.test(id)) family = 'document';
  else if (type === 'risk-workspace-v4' && ticker.test(id)) family = 'research';
  else if (type === 'risk-workspace-v4-scan' && accession.test(id)) family = 'document';
  else if (['filings-reader-text-v2', 'disclosure-text-v1'].includes(type) && filingDocument.test(id)) family = 'document';
  else if (type === 'disclosure-history-v1' && re(`${CIK}:${DATE}`).test(id)) family = 'research';
  else if (type === 'disclosure-scan-v1' && /^[A-F0-9]{64}$/.test(id)) family = 'research';
  else if (type === 'scanner-results-v2' && re(`${TICKER}:(?:SCAN|KW:[A-F0-9]{64})`).test(id)) family = 'research';
  else if (type === 'scanner-invalidations-v1' && re(`${TICKER}:(?:SCAN|KW:[A-F0-9]{64})`).test(id)) family = 'reference';
  else if (type === 'filing-changes' && re(`FILING-DIFF-V3-CONTEXT-V2:${CIK}:${ACCESSION}:${ACCESSION}`).test(id)) family = 'document';
  else if (['edgar.company-exposure-sources.v1:production', 'edgar.company-cftc-context.v1:production'].includes(type) && re(`${TICKER}:(?:LATEST|${DATE})`).test(id)) family = 'research';
  else if (type === 'edgar.cftc-fcm.v1:production' && id === 'LATEST') family = 'history';
  else if (type === 'fund-research-v1' && re(`${TICKER}:(?:LATEST|${ACCESSION})(?::[A-F0-9]{16}:(?:[0-9]|1[0-5]))?`).test(id)) family = 'research';
  else if (type === 'global-fund-discovery-v1' && /^SEARCH:[A-F0-9]{24}$/.test(id)) family = 'research';
  else if (type === 'edgar.cftc-positioning.v1:production') {
    if (id === 'REFRESH-CHECKPOINT') family = 'checkpoint';
    else if (re(`MARKETS(?:-LAST-GOOD)?:(?:TFF|DISAGGREGATED):(?:LATEST|${DATE})`).test(id)) family = 'history';
    else if (re(`RAW-HISTORY:(?:TFF|DISAGGREGATED):[A-Z0-9+]{3,12}:${DATE}`).test(id)) family = 'history';
    else if (re(`HISTORY(?:-LAST-GOOD)?:(?:TFF|DISAGGREGATED):[A-Z0-9+]{3,12}:(?:DEALER|ASSET-MANAGER|LEVERAGED-FUNDS|OTHER-REPORTABLES|NON-REPORTABLES|PRODUCER-MERCHANT|SWAP-DEALERS|MANAGED-MONEY):${DATE}:(?:1Y|3Y|5Y)`).test(id)) family = 'history';
  }
  return family ? Object.freeze({ family, type, id, maxTtlSeconds: DISPOSABLE_CACHE_TTLS[family], ...(sourceCik ? { sourceCik } : {}) }) : null;
}

/** Only existing canonical CFTC/pilot claims may fence corresponding mirrors.
 * Canonical resource keys retain their case; disposable cache IDs are uppercase.
 */
export function disposableCacheFencePolicy(type, fenceId, originalId = null) {
  if (typeof type !== 'string' || typeof fenceId !== 'string' || fenceId.length > 512) return null;
  const id = originalId === null ? null : typeof originalId === 'string' ? originalId.toUpperCase() : '';
  if (id !== null && !disposableCachePolicy(type, id)) return null;
  let dataset = null;
  if (type === 'edgar.cftc-positioning.v1:production') {
    const market = /^markets:(tff|disaggregated):(latest|\d{4}-\d{2}-\d{2})$/.exec(fenceId);
    const history = /^history:(tff|disaggregated):([A-Z0-9+]{3,12}):([a-z-]{3,32}):(\d{4}-\d{2}-\d{2}):(1y|3y|5y)$/.exec(fenceId);
    const groups = { tff: ['dealer', 'asset-manager', 'leveraged-funds', 'other-reportables', 'non-reportables'],
      disaggregated: ['producer-merchant', 'swap-dealers', 'managed-money', 'other-reportables', 'non-reportables'] };
    if (!market && !(history && groups[history[1]].includes(history[3]))) return null;
    if (id !== null && id !== fenceId.toUpperCase() && id !== fenceId.replace(/^(markets|history):/, '$1-last-good:').toUpperCase()) {
      const raw = /^RAW-HISTORY:(TFF|DISAGGREGATED):([A-Z0-9+]{3,12}):(\d{4}-\d{2}-\d{2})$/.exec(id);
      if (!raw || (market ? raw[1] !== market[1].toUpperCase() || market[2] !== 'latest' && raw[3] !== market[2]
        : raw[1] !== history[1].toUpperCase() || raw[2] !== history[2] || raw[3] !== history[4])) return null;
    }
    dataset = 'cftc';
  } else {
    const sec = /^sec-documents-v1:CIK([0-9]{10}):(submissions|companyfacts)$/.exec(fenceId);
    if (sec && Object.hasOwn(PILOT_TICKERS, sec[1])) {
      const expected = type === 'submissions-cik' && sec[2] === 'submissions' ? sec[1]
        : type === 'research-sec-v1' ? (sec[2] === 'submissions' ? `/SUBMISSIONS/CIK${sec[1]}.JSON` : `/API/XBRL/COMPANYFACTS/CIK${sec[1]}.JSON`) : null;
      if (expected && (id === null || id === expected)) dataset = 'sec';
    }
    const financial = /^financial-analysis-v1:(analysis-v1\.4:context-v3):CIK([0-9]{10}):(annual|quarter|ytd|ttm):latest$/.exec(fenceId);
    if (type === 'analysis-research' && financial && Object.hasOwn(PILOT_TICKERS, financial[2])
      && (id === null || id === `${financial[1]}:${PILOT_TICKERS[financial[2]]}:${financial[3]}:`.toUpperCase())) dataset = 'financial';
    if (type === 'research-serving-v1' && disposableCachePolicy(type, fenceId)
      && (id === null || id === fenceId.toUpperCase()) && /^research-(compare|portfolio)-v1:/.test(fenceId)) dataset = 'financial';
  }
  return dataset ? Object.freeze({ dataset, key: fenceId, type, ...(id === null ? {} : { id }) }) : null;
}

/** Reserve requests have no cache destination yet; constrain canonical claims. */
export function disposableCacheFenceResource(dataset, key) {
  const types = dataset === 'cftc' ? ['edgar.cftc-positioning.v1:production']
    : dataset === 'sec' ? ['research-sec-v1'] : dataset === 'financial' ? ['analysis-research', 'research-serving-v1'] : [];
  return types.some(type => disposableCacheFencePolicy(type, key)?.dataset === dataset);
}
