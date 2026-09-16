import { loadThirteenF } from './thirteenFServer.js';
import { normalize13FCompanyRequest } from './thirteenFCompanyResearchServer.js';
import { loadThirteenFCompanyIdentity } from './thirteenFCompanyIdentityServer.js';
import { loadCompanyExposuresByCik } from './companyExposureServer.js';
import { COMPANY_EXPOSURE_SCHEMA_VERSION, COMPANY_EXPOSURE_MAX_ROWS } from './companyExposure.js';
import { buildFilingUrl } from './filingTextParser.js';
import { isCftcEnabled } from './cftcFeature.js';
import { thirteenFMarketConnectionsCache } from './thirteenFMarketConnectionsCache.js';

export const THIRTEEN_F_MARKET_CONNECTIONS_SCHEMA_VERSION = 'edgar.13f-market-connections.v1';
export const THIRTEEN_F_MARKET_CONNECTIONS_MAX_BYTES = 1024 * 1024;
export const THIRTEEN_F_MARKET_CONNECTIONS_BATCH_SCHEMA_VERSION = 'edgar.13f-market-connections-batch.v1';
export const THIRTEEN_F_MARKET_CONNECTIONS_BATCH_MAX_BYTES = 2 * 1024 * 1024;
export const normalize13FMarketConnectionsRequest = normalize13FCompanyRequest;
const CIK = /^\d{10}$/;
const fail = (message, status = 502, code = 'SEC_MARKET_CONNECTIONS_UNAVAILABLE') => Object.assign(new Error(message), { status, code });
const sameCik = (value, expected) => /^\d{1,10}$/.test(String(value ?? '')) && Number(value) > 0 && String(value).padStart(10, '0') === expected;
const text = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
function compactHolding(holding) {
  return Object.fromEntries(['key', 'cusip', 'issuer', 'classTitle', 'putCall', 'quantity', 'quantityType', 'valueUsd', 'weightPct'].map(key => [key, holding[key] ?? null]));
}
function secDocumentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.sec.gov' && !url.username && !url.password && !url.port && url.pathname.startsWith('/Archives/edgar/data/') ? url.href : null;
  } catch { return null; }
}

/** The disclosure loader already validates the issuer's submissions manifest
 * and cached source bindings. Recheck the returned identity and passage/source
 * joins at the 13F boundary so another company's evidence cannot be attached. */
function verifiedDiscovery(discovery, cik) {
  if (!discovery || discovery.schemaVersion !== COMPANY_EXPOSURE_SCHEMA_VERSION || !sameCik(discovery.cik, cik)
    || discovery.code === 'SEC_SOURCE_IDENTITY_MISMATCH' || discovery.ticker != null || discovery.asOf != null
    || !['ready', 'partial', 'no_matches', 'no_filing', 'unavailable'].includes(discovery.status)
    || !Array.isArray(discovery.sources) || discovery.sources.length > 2 || !Array.isArray(discovery.rows) || discovery.rows.length > COMPANY_EXPOSURE_MAX_ROWS)
    throw fail('The SEC disclosures could not be verified for this holding’s issuer. Retry this holding.', 502, 'DISCLOSURE_IDENTITY_MISMATCH');
  for (const source of discovery.sources) {
    if (!/^\d{10}-\d{2}-\d{6}$/.test(source.accession) || !['annual', 'quarterly'].includes(source.role)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(source.primaryDoc || '')
      || !secDocumentUrl(source.url) || buildFilingUrl(cik, source.accession, source.primaryDoc) !== source.url)
      throw fail('An SEC source did not match this holding’s verified issuer.', 502, 'DISCLOSURE_IDENTITY_MISMATCH');
  }
  for (const row of discovery.rows) {
    if (!Array.isArray(row.evidence) || !row.evidence.length || row.evidence.length > 4)
      throw fail('The disclosure passages could not be verified. Retry this holding.', 502, 'DISCLOSURE_SOURCE_MISMATCH');
    for (const evidence of row.evidence) {
      const source = discovery.sources.find(source => source.accession === evidence.accession && source.role === evidence.role);
      if (!source || source.status !== 'ready' || evidence.url !== source.url || evidence.form !== source.form
        || evidence.filed !== source.filed || evidence.reportDate !== source.reportDate || typeof evidence.text !== 'string'
        || !evidence.text.trim() || evidence.text.length > 1800)
        throw fail('An SEC passage did not match its verified source. Retry this holding.', 502, 'DISCLOSURE_SOURCE_MISMATCH');
    }
  }
  return discovery;
}

function verifiedIdentity(identity, holding) {
  if (!identity || !['resolved', 'unresolved'].includes(identity.status) || identity.cusip !== holding.cusip)
    throw fail('The company evidence did not match the selected security. Retry this holding.', 502, 'ISSUER_IDENTITY_MISMATCH');
  if (identity.status === 'unresolved') return;
  const issuerCik = identity.issuer?.cik;
  if (!CIK.test(issuerCik || '') || Number(issuerCik) <= 0 || identity.issuer.kind !== 'company'
    || !Array.isArray(identity.evidence) || !identity.evidence.length || identity.evidence.length > 4
    || identity.evidence.some(source => !sameCik(source.cik, issuerCik) || !Array.isArray(source.cusips)
      || !source.cusips.includes(holding.cusip) || !secDocumentUrl(source.url)))
    throw fail('The SEC issuer proof is incomplete or conflicting. Retry this holding.', 502, 'ISSUER_IDENTITY_MISMATCH');
}

function verifyPrepared(result) {
  verifiedIdentity(result.identity, result.holding);
  if (result.identity.status === 'resolved') verifiedDiscovery(result.discovery, result.identity.issuer.cik);
  return true;
}

function verifiedHoldings(report, cik, period, keys) {
  if (!sameCik(report?.manager?.cik, cik) || report.selectedPeriod !== period || !sameCik(report.portfolio?.cik, cik) || report.portfolio?.period !== period)
    throw fail('The selected SEC report could not be verified for this manager and quarter. Retry the report.', 502, 'REPORT_IDENTITY_MISMATCH');
  return keys.map(key => {
    const matches = (report.portfolio.holdings || []).filter(holding => holding.key === key);
    if (matches.length !== 1) throw fail('This holding is not present in the selected manager report. Reopen it from the holdings table.', 404, 'HOLDING_NOT_FOUND');
    const holding = matches[0];
    if ([holding.cusip, holding.putCall || 'SECURITY', holding.quantityType].join('|') !== key)
      throw fail('The selected holding’s SEC identity could not be verified.', 502, 'HOLDING_IDENTITY_MISMATCH');
    return holding;
  });
}

export function normalize13FMarketConnectionsBatchRequest(cikInput, periodInput, keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 20 || new Set(keys).size !== keys.length)
    throw fail('Use between one and twenty distinct holding keys.', 400, 'INVALID_REQUEST');
  const requests = keys.map(key => normalize13FMarketConnectionsRequest(cikInput, periodInput, key));
  if (new Set(requests.map(request => request.key)).size !== requests.length)
    throw fail('Use distinct holding keys.', 400, 'INVALID_REQUEST');
  return { cik: requests[0].cik, period: requests[0].period, keys: requests.map(request => request.key) };
}

/** Each request represents one actual filed security. Portfolio aggregation
 * happens separately; a market connection never changes its reported value
 * into an economic exposure estimate. No CFTC observations are loaded here. */
export function createThirteenFMarketConnectionsLoader({
  portfolioLoader = loadThirteenF, identityLoader = loadThirteenFCompanyIdentity,
  exposureLoader = loadCompanyExposuresByCik, enabled = isCftcEnabled, now = Date.now, deadlineMs = 55000,
  preparedCache = thirteenFMarketConnectionsCache,
} = {}) {
  function requestSignal(callerSignal) {
    if (!enabled()) throw fail('CFTC market connection research is disabled.', 503, 'CFTC_DISABLED');
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(deadlineMs)]) : AbortSignal.timeout(deadlineMs);
    signal.throwIfAborted();
    return signal;
  }
  const load = async (cikInput, { period: periodInput, key: keyInput, signal: callerSignal, skipPrepared = false } = {}) => {
    const { cik, period, key } = normalize13FMarketConnectionsRequest(cikInput, periodInput, keyInput);
    const signal = requestSignal(callerSignal);
    const report = await portfolioLoader(cik, { period, signal });
    signal.throwIfAborted();
    const [holding] = verifiedHoldings(report, cik, period, [key]);
    const [prepared] = skipPrepared ? [null] : await preparedCache.getMany(report, [holding], { signal, verify: verifyPrepared });
    if (prepared) return prepared;
    const identity = await identityLoader(holding, { period, signal });
    signal.throwIfAborted();
    verifiedIdentity(identity, holding);
    const result = {
      schemaVersion: THIRTEEN_F_MARKET_CONNECTIONS_SCHEMA_VERSION, status: identity.status === 'resolved' ? 'ready' : 'unresolved',
      manager: { cik, name: text(report.manager.name), submissionsUrl: report.manager.submissionsUrl }, selectedPeriod: period,
      holding: compactHolding(holding), identity, discovery: null, observedAt: new Date(now()).toISOString(),
      coverage: { selectedPeriodComplete: report.coverage?.selectedPeriodComplete === true, portfolioComplete: report.portfolio.complete === true },
      retryable: false,
      basis: 'Latest available issuer disclosures are researched separately from the selected 13F quarter. Associated holdings’ share of disclosed 13F value is a portfolio composition measure, not measured economic exposure or the manager’s futures position.',
    };
    if (identity.status === 'unresolved') {
      result.message = text(identity.reason, 1500) || 'No verified SEC issuer connection is available for this security.';
      await preparedCache.put(report, holding, result, { signal, verify: verifyPrepared });
      return result;
    }
    const issuerCik = identity.issuer?.cik;
    result.discovery = verifiedDiscovery(await exposureLoader(issuerCik, { signal }), issuerCik);
    signal.throwIfAborted();
    if (result.discovery.status === 'unavailable') result.status = 'unavailable';
    result.retryable = result.discovery.retryable === true;
    if (result.discovery.message) result.message = text(result.discovery.message, 1500);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > THIRTEEN_F_MARKET_CONNECTIONS_MAX_BYTES)
      throw fail('The SEC disclosure extract exceeds the supported response size. Open the source reports for this issuer.', 502, 'DISCLOSURE_RESPONSE_TOO_LARGE');
    await preparedCache.put(report, holding, result, { signal, verify: verifyPrepared });
    return result;
  };
  load.prepared = async (cikInput, { period: periodInput, keys: keysInput, signal: callerSignal } = {}) => {
    const { cik, period, keys } = normalize13FMarketConnectionsBatchRequest(cikInput, periodInput, keysInput);
    const signal = requestSignal(callerSignal);
    const report = await portfolioLoader(cik, { period, signal });
    signal.throwIfAborted();
    const holdings = verifiedHoldings(report, cik, period, keys);
    const cached = await preparedCache.getMany(report, holdings, { signal, verify: verifyPrepared });
    const envelope = { schemaVersion: THIRTEEN_F_MARKET_CONNECTIONS_BATCH_SCHEMA_VERSION, manager: { cik }, selectedPeriod: period, results: [], requested: keys.length };
    let bytes = Buffer.byteLength(JSON.stringify(envelope));
    for (const result of cached) {
      if (!result) continue;
      const addedBytes = Buffer.byteLength(JSON.stringify(result)) + (envelope.results.length ? 1 : 0);
      if (bytes + addedBytes > THIRTEEN_F_MARKET_CONNECTIONS_BATCH_MAX_BYTES) continue;
      envelope.results.push(result); bytes += addedBytes;
    }
    signal.throwIfAborted();
    return envelope;
  };
  return load;
}

export const loadThirteenFMarketConnections = createThirteenFMarketConnectionsLoader();
