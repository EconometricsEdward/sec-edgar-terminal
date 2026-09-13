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
  else if (type === 'compare-research' && re(`COMPARE-V2:(?:CONTEXT-V3|XBRL-V1):${TICKER}:(?:ANNUAL|QUARTER|TTM):(?:${DATE})?`).test(id)) family = 'research';
  else if (type === 'portfolio-company-v3-evidence-continuity' && re(`PORTFOLIO-COMPANY-V3-EVIDENCE-CONTINUITY:COMPARE-V2:CONTEXT-V3:ANALYSIS-V1\\.4:CONTEXT-V3:${CIK}:${BASIS}`).test(id)) family = 'research';
  else if (type === 'holders-v3' && ticker.test(id)) family = 'document';
  else if (type === 'risk-workspace-v4' && ticker.test(id)) family = 'research';
  else if (type === 'risk-workspace-v4-scan' && accession.test(id)) family = 'document';
  else if (['filings-reader-text-v2', 'disclosure-text-v1'].includes(type) && filingDocument.test(id)) family = 'document';
  else if (type === 'disclosure-history-v1' && re(`${CIK}:${DATE}`).test(id)) family = 'research';
  else if (type === 'disclosure-scan-v1' && /^[A-F0-9]{64}$/.test(id)) family = 'research';
  else if (type === 'filing-changes' && re(`FILING-DIFF-V3-CONTEXT-V2:${CIK}:${ACCESSION}:${ACCESSION}`).test(id)) family = 'document';
  else if (['edgar.company-exposure-sources.v1:production', 'edgar.company-cftc-context.v1:production'].includes(type) && re(`${TICKER}:(?:LATEST|${DATE})`).test(id)) family = 'research';
  else if (type === 'edgar.cftc-fcm.v1:production' && id === 'LATEST') family = 'history';
  else if (type === 'fund-research-v1' && re(`${TICKER}:(?:LATEST|${ACCESSION})(?::[A-F0-9]{16}:(?:[0-9]|1[0-5]))?`).test(id)) family = 'research';
  else if (type === 'global-fund-discovery-v1' && /^SEARCH:[A-F0-9]{24}$/.test(id)) family = 'research';
  else if (type === 'edgar.cftc-positioning.v1:production') {
    if (id === 'REFRESH-CHECKPOINT') family = 'checkpoint';
    else if (re(`MARKETS(?:-LAST-GOOD)?:(?:TFF|DISAGGREGATED):(?:LATEST|${DATE})`).test(id)) family = 'history';
    else if (re(`RAW-HISTORY:(?:TFF|DISAGGREGATED):[A-Z0-9]{6}:${DATE}`).test(id)) family = 'history';
    else if (re(`HISTORY(?:-LAST-GOOD)?:(?:TFF|DISAGGREGATED):[A-Z0-9]{6}:(?:DEALER|ASSET-MANAGER|LEVERAGED-FUNDS|OTHER-REPORTABLES|NON-REPORTABLES|PRODUCER-MERCHANT|SWAP-DEALERS|MANAGED-MONEY):${DATE}:(?:1Y|3Y|5Y)`).test(id)) family = 'history';
  }
  return family ? Object.freeze({ family, type, id, maxTtlSeconds: DISPOSABLE_CACHE_TTLS[family], ...(sourceCik ? { sourceCik } : {}) }) : null;
}
