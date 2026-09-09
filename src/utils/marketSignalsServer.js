import { createHash } from 'node:crypto';
import { MARKET_ATLAS_FRESH_MS, MARKET_VERSION } from './marketResearch.js';
import { MARKET_LENSES } from './marketCohorts.js';
import { isMarketAtlas } from './marketResearchValidation.js';
import { loadPriceSeries } from './priceDataServer.js';
import {
  EconometricsError,
  estimateFilingEvent,
  estimateRegressionDiagnostics,
  stripModelInternals,
} from './marketRegression.js';
import { buildFilingChangeScore, calculateEvidenceGap } from './marketSignals.js';
import { warmAcquireLease, warmCacheEnabled, warmGet, warmReleaseLease, warmSet } from './warmCache.js';

export const MARKET_SIGNALS_SCHEMA_VERSION = 'edgar.market-signals.v1';
export const MARKET_SIGNALS_METHODOLOGY_VERSION = 'market-signals-1.0.0';

const RESULT_FRESH_MS = 12 * 60 * 60 * 1000;
const RESULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEGRADED_RESULT_TTL_SECONDS = 2 * 60;
const WITHHELD_RESULT_TTL_SECONDS = 10 * 60;
const RESULT_LEASE_MS = 30_000;
const DAY_MS = 86_400_000;
const pending = new Map();

export const MARKET_SIGNAL_WINDOWS = Object.freeze({
  '1y': 365,
  '3y': 3 * 365,
  '5y': 5 * 365,
});

export const SECTOR_PROXIES = Object.freeze([
  'XLF', 'XLRE', 'XHB', 'XLE', 'XLY', 'XLK', 'XLI', 'XLV', 'XLU',
]);

const COHORT_PROXY = Object.freeze({
  'credit-banks': 'XLF',
  'private-capital': 'XLF',
  'real-estate': 'XLRE',
  housing: 'XHB',
  'energy-commodities': 'XLE',
  'consumer-demand': 'XLY',
  'ai-infrastructure': 'XLK',
  'software-security': 'XLK',
  'transport-cyclicals': 'XLI',
  insurance: 'XLF',
  healthcare: 'XLV',
  'industrial-capex': 'XLI',
  'utilities-rates': 'XLU',
});

export class MarketSignalError extends Error {
  constructor(message, { code = 'MARKET_SIGNAL_UNAVAILABLE', status = 502, details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MarketSignalError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const validTicker = (value) => typeof value === 'string' && /^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(value);
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isoDate = (date) => date.toISOString().slice(0, 10);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function addWarning(warnings, code, message, severity = 'warning') {
  if (!warnings.some((warning) => warning.code === code)) warnings.push({ code, severity, message });
}

function snakeKey(key) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function snakeCase(value) {
  if (Array.isArray(value)) return value.map(snakeCase);
  if (!value || typeof value !== 'object') return typeof value === 'number' && !Number.isFinite(value) ? null : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [snakeKey(key), snakeCase(item)]));
}

const FACTOR_SOURCE_KEYS = [
  'revenueGrowth', 'netMargin', 'operatingMargin', 'freeCashFlowMargin', 'equityToAssets', 'cashToAssets',
];

function filingProvenance(point, cik) {
  if (!point || typeof point !== 'object') return null;
  const accessions = Array.isArray(point.factorSourceAccessions) ? point.factorSourceAccessions : [];
  const masks = Array.isArray(point.factorSourceMasks) ? point.factorSourceMasks : [];
  const metricSourceAccessions = Object.fromEntries(FACTOR_SOURCE_KEYS.map((key, keyIndex) => {
    const encoded = typeof masks[keyIndex] === 'string' && /^[0-9a-f]+$/.test(masks[keyIndex]) ? BigInt(`0x${masks[keyIndex]}`) : 0n;
    return [snakeKey(key), accessions.filter((_, index) => (encoded & (1n << BigInt(index))) !== 0n)];
  }));
  const value = snakeCase(point);
  delete value.factor_source_masks;
  const source = value.source || (point.accession && cik
    ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${point.accession.replaceAll('-', '')}/`
    : null);
  return { ...value, source, metric_source_accessions: metricSourceAccessions };
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function chooseCohort(company, requested) {
  if (requested && requested !== 'auto') {
    if (!company.cohorts.includes(requested)) {
      throw new MarketSignalError(`${company.ticker} is not in the requested peer-normalization cohort.`, {
        code: 'COMPANY_OUTSIDE_COHORT',
        status: 400,
      });
    }
    return requested;
  }
  return company.cohorts[0] || null;
}

function chooseProxy(cohortId, requested) {
  if (requested && requested !== 'auto') return requested;
  return COHORT_PROXY[cohortId] || 'XLI';
}

function atlasFromCache(candidate) {
  return isMarketAtlas(candidate, MARKET_VERSION) ? candidate : null;
}

async function readAtlasCacheOnly(now = new Date()) {
  const [current, lastGood] = await Promise.all([
    warmGet(MARKET_VERSION, 'atlas'),
    warmGet(MARKET_VERSION, 'atlas-last-good'),
  ]);
  const cachedAtlas = atlasFromCache(current) || atlasFromCache(lastGood);
  if (!cachedAtlas) {
    throw new MarketSignalError('The filing snapshot is not warm yet. Open Market research or retry shortly.', {
      code: 'MARKET_SNAPSHOT_NOT_READY',
      status: 503,
    });
  }
  const age = now.getTime() - Date.parse(cachedAtlas.generatedAt);
  if (cachedAtlas.cache?.status === 'stale' || !Number.isFinite(age) || age < 0 || age > MARKET_ATLAS_FRESH_MS) {
    return {
      ...cachedAtlas,
      cache: {
        status: 'stale',
        warning: cachedAtlas.cache?.warning
          || 'The SEC snapshot is outside the 25-hour scheduled-refresh window; estimates retain its original source clock while a refresh is pending.',
      },
    };
  }
  return cachedAtlas;
}

function signalCacheId(atlas, request) {
  return stableHash({
    schema: MARKET_SIGNALS_SCHEMA_VERSION,
    methodology: MARKET_SIGNALS_METHODOLOGY_VERSION,
    universe: MARKET_VERSION,
    atlas: atlas.generatedAt,
    atlasCacheStatus: atlas.cache?.status || 'current',
    ...request,
  });
}

function lastEligibleCacheId(request) {
  return stableHash({
    schema: MARKET_SIGNALS_SCHEMA_VERSION,
    methodology: MARKET_SIGNALS_METHODOLOGY_VERSION,
    universe: MARKET_VERSION,
    ...request,
  });
}

function freshResult(value) {
  const age = value?.generated_at ? Date.now() - Date.parse(value.generated_at) : Number.POSITIVE_INFINITY;
  return value
    && value.schema_version === MARKET_SIGNALS_SCHEMA_VERSION
    && value.methodology_version === MARKET_SIGNALS_METHODOLOGY_VERSION
    && validDate(value.generated_at)
    && age >= 0
    && age < RESULT_FRESH_MS;
}

function cachedStale(value, message = 'A refresh is in progress; this is the last completed signal result.') {
  if (!value || value.schema_version !== MARKET_SIGNALS_SCHEMA_VERSION) return null;
  const warnings = Array.isArray(value.warnings) ? [...value.warnings] : [];
  addWarning(warnings, 'STALE_SIGNAL_RESULT', message);
  return { ...value, status: value.status === 'ready' ? 'stale' : value.status, cache_status: 'stale', warnings };
}

function requestedStart(now, window) {
  return isoDate(new Date(now.getTime() - MARKET_SIGNAL_WINDOWS[window] * DAY_MS));
}

function priceStart(now, windowStart, filingComparison) {
  const filed = filingComparison?.current?.acceptedAt
    || filingComparison?.current?.filed
    || filingComparison?.currentPeriod?.acceptedAt
    || filingComparison?.currentPeriod?.filed;
  if (!validDate(filed)) return windowStart;
  const eventHistoryStart = isoDate(new Date(Date.parse(filed) - 430 * DAY_MS));
  return eventHistoryStart < windowStart ? eventHistoryStart : windowStart;
}

function priceDescriptor(series) {
  return {
    ticker: series.ticker,
    provider: series.provider,
    cache_status: series.cacheStatus,
    price_basis: series.priceBasis,
    adjustment_coverage: series.adjustmentCoverage,
    retrieved_at: series.retrievedAt,
    first_observation: series.from,
    last_observation: series.to,
    observations: series.count,
    attempts: series.attempts,
  };
}

function commonPriceThrough(series) {
  if (!Array.isArray(series) || !series.length) return null;
  const dateSets = series.slice(1).map((item) => new Set(item.prices.map((row) => row.date)));
  return series[0].prices.map((row) => row.date).filter((date) => dateSets.every((set) => set.has(date))).at(-1) || null;
}

function filingDateFromComparison(comparison) {
  return comparison?.current?.filed
    || comparison?.currentPeriod?.acceptedAt?.slice(0, 10)
    || comparison?.currentPeriod?.filed
    || null;
}

function filingAcceptanceFromComparison(comparison) {
  return comparison?.current?.acceptedAt
    || comparison?.currentPeriod?.acceptedAt
    || null;
}

function qualityAssessment({ diagnostics, filingScore, filingEvent, adjustedEligible, atlas, warnings }) {
  const observations = diagnostics?.sample?.observations || 0;
  const componentPeerCounts = (filingScore?.components || []).map((component) => component.peerCount).filter(finite);
  const peerCount = componentPeerCounts.length ? Math.min(...componentPeerCounts) : 0;
  const eligiblePeerIssuers = filingScore?.coverage?.eligiblePeerIssuers ?? 0;
  const componentCount = filingScore?.components?.filter((component) => component?.available && finite(component?.z)).length || 0;
  const requiredComponentCount = filingScore?.coverage?.requiredComponents || 0;
  const filingScoreComplete = Boolean(filingScore?.available)
    && requiredComponentCount > 0
    && componentCount === requiredComponentCount;
  const hasEvent = finite(filingEvent?.windows?.['20']?.standardizedResponse);
  const timingProxy = filingEvent?.timingQuality === 'filing_date_next_session_proxy';
  const peersAfterFocus = filingScore?.coverage?.peerFilingClock?.peersAfterFocus ?? null;
  let grade = 'D';
  if (adjustedEligible && observations >= 500 && peerCount >= 12 && filingScoreComplete && hasEvent) grade = 'A';
  else if (adjustedEligible && observations >= 252 && peerCount >= 8 && filingScoreComplete) grade = 'B';
  else if (adjustedEligible && observations >= 126) grade = 'C';
  if (atlas.cache?.status === 'stale' && ['A', 'B'].includes(grade)) grade = 'C';
  else if (timingProxy && grade === 'A') grade = 'B';
  if (atlas.cache?.status === 'stale') addWarning(warnings, 'STALE_SEC_SNAPSHOT', atlas.cache.warning || 'The SEC snapshot is stale.');
  if (timingProxy) addWarning(warnings, 'FILING_TIME_PROXY', 'The filing event uses the next session after the SEC filed date because an acceptance timestamp is unavailable.');
  if (finite(peersAfterFocus) && peersAfterFocus > 0) {
    addWarning(warnings, 'NON_COEVAL_PEER_FILINGS', `${peersAfterFocus} peer filing snapshots became public after the focus filing; the peer score is a calculation-time cross-section, not an event-time portfolio.`);
  }
  if (!hasEvent) addWarning(warnings, 'FILING_EVENT_UNAVAILABLE', 'A complete, estimable 20-session filing event window is unavailable.');
  if (!filingScore?.available) addWarning(warnings, 'FILING_SCORE_UNAVAILABLE', filingScore?.reason || 'Comparable filing and peer observations are insufficient.');
  return {
    grade,
    headline_eligible: adjustedEligible && observations >= 126,
    evidence_gap_eligible: adjustedEligible && hasEvent && Boolean(filingScore?.available),
    observations,
    peer_count: peerCount,
    eligible_peer_issuers: eligiblePeerIssuers,
    filing_components: componentCount,
    required_filing_components: requiredComponentCount,
    filing_score_complete: filingScoreComplete,
    peer_filings_after_focus: peersAfterFocus,
    filing_event_complete: hasEvent,
    sec_snapshot_status: atlas.cache?.status || 'current',
  };
}

function deterministicInterpretation({ ticker, diagnostics, filingScore, filingEvent, evidenceGap, quality }) {
  if (!quality.headline_eligible || !diagnostics) {
    return `${ticker}'s regression estimates are withheld because an adjusted, sufficiently aligned price sample is unavailable.`;
  }
  const beta = diagnostics.marketModel.beta;
  const interval = diagnostics.marketModel.betaConfidenceInterval95;
  const pieces = [
    `${ticker}'s estimated market beta is ${beta.toFixed(2)}${interval ? ` (95% HAC interval ${interval[0].toFixed(2)} to ${interval[1].toFixed(2)})` : ''}.`,
  ];
  if (finite(diagnostics.conditionalBeta?.asymmetry)) {
    const direction = diagnostics.conditionalBeta.asymmetry >= 0 ? 'exceeds' : 'is below';
    pieces.push(`Downside beta ${direction} upside beta by ${Math.abs(diagnostics.conditionalBeta.asymmetry).toFixed(2)}.`);
  }
  if (filingScore?.available && finite(filingEvent?.windows?.['20']?.standardizedResponse)) {
    const filing = filingScore.filingChangeZ > 0 ? 'above' : filingScore.filingChangeZ < 0 ? 'below' : 'at';
    const price = filingEvent.windows['20'].standardizedResponse > 0 ? 'positive' : filingEvent.windows['20'].standardizedResponse < 0 ? 'negative' : 'neutral';
    pieces.push(`The latest filing-change score is ${filing} its peer center, while the 20-session model-adjusted response is ${price}.`);
  }
  if (evidenceGap?.available) pieces.push('The Evidence Gap is a descriptive disagreement measure, not an expected-return estimate.');
  return pieces.join(' ');
}

async function computeSignal({ atlas, ticker, window, basis, cohort: requestedCohort, sectorProxy: requestedProxy, now }) {
  const company = atlas.companies.find((candidate) => candidate.ticker === ticker);
  if (!company) {
    throw new MarketSignalError('Choose a company from the current Market research universe.', {
      code: 'COMPANY_OUTSIDE_UNIVERSE',
      status: 400,
    });
  }
  const cohortId = chooseCohort(company, requestedCohort);
  if (!cohortId) throw new MarketSignalError('No peer-normalization cohort is available for this company.', { code: 'COHORT_UNAVAILABLE', status: 422 });
  const sectorProxy = chooseProxy(cohortId, requestedProxy);
  const peers = atlas.companies.filter((candidate) => candidate.cohorts.includes(cohortId) && candidate.ticker !== ticker);
  const filingComparison = company.filingComparisons?.[basis] || null;
  const windowStart = requestedStart(now, window);
  const fromIso = priceStart(now, windowStart, filingComparison);
  const [asset, market, sector] = await Promise.all([
    loadPriceSeries({ ticker, fromIso, now }),
    loadPriceSeries({ ticker: 'SPY', fromIso, now }),
    loadPriceSeries({ ticker: sectorProxy, fromIso, now }),
  ]);
  const warnings = [];
  const adjustedEligible = [asset, market, sector].every((series) => (
    series.provider === 'yahoo_finance'
      && series.priceBasis === 'adjusted_close'
      && series.adjustmentCoverage === 1
  ));
  if (!adjustedEligible) {
    addWarning(
      warnings,
      'PRICE_BASIS_UNVERIFIED',
      'Headline regressions are withheld because all three series were not complete Yahoo adjusted-close histories.',
      'error',
    );
  }

  let diagnostics = null;
  let modelError = null;
  if (adjustedEligible) {
    try {
      diagnostics = estimateRegressionDiagnostics({
        assetPrices: asset.prices,
        marketPrices: market.prices,
        sectorPrices: sector.prices,
        requestedStart: windowStart,
      });
    } catch (error) {
      if (!(error instanceof EconometricsError)) throw error;
      modelError = error;
      addWarning(warnings, error.code, error.message, 'error');
    }
  }
  if (diagnostics && !diagnostics.independentSector) {
    addWarning(warnings, 'SECTOR_MODEL_INSUFFICIENT_OVERLAP', 'Independent sector sensitivity is withheld because exact triple-series coverage is below its estimation gate.');
  }

  const filingScore = buildFilingChangeScore({ company, peers, basis, cohortId });
  let filingEvent = null;
  const filingDate = filingDateFromComparison(filingComparison);
  const acceptedAt = filingAcceptanceFromComparison(filingComparison);
  if (adjustedEligible && filingDate) {
    filingEvent = estimateFilingEvent({
      assetPrices: asset.prices,
      marketPrices: market.prices,
      sectorPrices: sector.prices,
      filedDate: filingDate,
      acceptedAt,
    });
  }
  const priceResponseZ = filingEvent?.windows?.['20']?.standardizedResponse ?? null;
  const evidenceGap = calculateEvidenceGap({
    filingChangeZ: filingScore?.available ? filingScore.filingChangeZ : null,
    priceResponseZ: adjustedEligible ? priceResponseZ : null,
  });
  const quality = qualityAssessment({ diagnostics, filingScore, filingEvent, adjustedEligible, atlas, warnings });
  const generatedAt = now.toISOString();
  const dataThrough = commonPriceThrough([asset, market, sector]);
  const request = { ticker, window, basis, cohort: cohortId, sectorProxy, marketBenchmark: 'SPY', frequency: 'daily' };
  const snapshotId = `${MARKET_VERSION}:${stableHash({ atlas: atlas.generatedAt, generatedAt, request, dataThrough })}`;
  const cleanDiagnostics = diagnostics ? stripModelInternals(diagnostics) : null;
  const calculatedStatus = modelError || !adjustedEligible ? 'withheld' : quality.evidence_gap_eligible ? 'ready' : 'partial';
  const status = calculatedStatus === 'ready' && atlas.cache?.status === 'stale' ? 'stale' : calculatedStatus;

  return {
    schema_version: MARKET_SIGNALS_SCHEMA_VERSION,
    methodology_version: MARKET_SIGNALS_METHODOLOGY_VERSION,
    universe_version: MARKET_VERSION,
    snapshot_id: snapshotId,
    status,
    cache_status: atlas.cache?.status === 'stale' ? 'stale' : 'computed',
    generated_at: generatedAt,
    data_through: dataThrough,
    request: snakeCase(request),
    issuer: {
      ticker: company.ticker,
      name: company.name,
      cik: company.cik,
      sic: String(company.sic),
      cohorts: company.cohorts,
    },
    sample: cleanDiagnostics ? snakeCase(cleanDiagnostics.sample) : null,
    estimates: cleanDiagnostics ? {
      market_model: snakeCase(cleanDiagnostics.marketModel),
      conditional_beta: snakeCase(cleanDiagnostics.conditionalBeta),
      independent_sector_sensitivity: snakeCase(cleanDiagnostics.independentSector),
      rolling_beta: snakeCase(cleanDiagnostics.rollingBeta),
    } : null,
    edgar_snapshot: snakeCase(filingScore),
    filing_event: snakeCase(filingEvent),
    evidence_gap: snakeCase(evidenceGap),
    quality,
    interpretation: deterministicInterpretation({ ticker, diagnostics, filingScore, filingEvent, evidenceGap, quality }),
    provenance: {
      sec: {
        source: `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`,
        snapshot_generated_at: atlas.generatedAt,
        reporting_basis: basis,
        point_in_time: filingComparison?.pointInTime === true,
        cutoff: snakeCase(filingComparison?.cutoff || null),
        current_filing: filingProvenance(filingComparison?.current || filingComparison?.currentPeriod || null, company.cik),
        prior_filing: filingProvenance(filingComparison?.prior || filingComparison?.priorPeriod || null, company.cik),
      },
      prices: {
        asset: priceDescriptor(asset),
        market: priceDescriptor(market),
        sector_proxy: priceDescriptor(sector),
      },
    },
    equations: [
      { id: 'market_model', expression: 'ln(P_i,t/P_i,t-1) = intercept + beta_market * ln(P_SPY,t/P_SPY,t-1) + error_t', inference: 'Newey-West HAC; automatic Bartlett lag' },
      { id: 'independent_sector', expression: 'sector_residual = r_sector - fitted(r_sector ~ SPY); r_asset = intercept + beta_market*r_SPY + beta_sector*sector_residual + error', inference: 'Frisch-Waugh-Lovell residualization' },
      { id: 'evidence_gap', expression: 'clip(filing_change_z, -3, 3) - clip(price_response_z, -3, 3)', inference: 'Descriptive diagnostic; no expected-return interpretation' },
    ],
    warnings,
    limitations: [
      'This is a market-model diagnostic, not CAPM: no risk-free return is subtracted.',
      'The regression intercept is not Jensen alpha.',
      'The filing score is a current, peer-normalized descriptive snapshot and is not a historical factor return.',
      'The current curated universe is not survivorship-free and does not include complete delisting histories.',
      'Only pre-open SEC acceptances use the same session; intraday, post-close, non-trading-day, and date-only filings begin on the next benchmark session.',
      'Benchmark sessions are inferred from observed SPY dates rather than a separately licensed official exchange calendar.',
      'Peer normalization is a calculation-time cross-section of latest point-in-time filings, not a peer portfolio reconstructed at the focus filing event.',
      'The Evidence Gap is not a valuation, forecast, recommendation, or trade signal.',
      'Derived statistics are provided without redistributing bulk vendor price histories.',
    ],
    links: {
      methodology: 'https://secedgarterminal.com/market/factors',
      api: `https://secedgarterminal.com/api/v1/market-signals?ticker=${encodeURIComponent(ticker)}&window=${window}&basis=${basis}&cohort=${encodeURIComponent(cohortId)}&sector_proxy=${sectorProxy}`,
      schema: 'https://secedgarterminal.com/schemas/market-signals-v1.schema.json',
      company_analysis: `https://secedgarterminal.com/analysis/${encodeURIComponent(ticker)}`,
      sec_companyfacts: `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`,
    },
    cite_as: `EDGAR Terminal, EDGAR Factor Lab, ${ticker}, ${generatedAt.slice(0, 10)}, methodology ${MARKET_SIGNALS_METHODOLOGY_VERSION}.`,
  };
}

export function validateMarketSignalOptions(input = {}) {
  const ticker = typeof input.ticker === 'string' ? input.ticker.trim().toUpperCase() : '';
  const window = input.window || '3y';
  const basis = input.basis || 'ttm';
  const cohort = input.cohort || 'auto';
  const rawSectorProxy = typeof input.sectorProxy === 'string' ? input.sectorProxy.trim() : 'auto';
  const sectorProxy = rawSectorProxy.toLowerCase() === 'auto' ? 'auto' : rawSectorProxy.toUpperCase();
  if (!validTicker(ticker)) throw new MarketSignalError('A valid ticker is required.', { code: 'INVALID_TICKER', status: 400 });
  if (!Object.hasOwn(MARKET_SIGNAL_WINDOWS, window)) throw new MarketSignalError('Window must be 1y, 3y, or 5y.', { code: 'INVALID_WINDOW', status: 400 });
  if (!['ttm', 'annual'].includes(basis)) throw new MarketSignalError('Basis must be ttm or annual.', { code: 'INVALID_BASIS', status: 400 });
  if (cohort !== 'auto' && !MARKET_LENSES.some((item) => item.id === cohort)) throw new MarketSignalError('Unknown peer-normalization cohort.', { code: 'INVALID_COHORT', status: 400 });
  if (sectorProxy !== 'auto' && !SECTOR_PROXIES.includes(sectorProxy)) throw new MarketSignalError('Unknown sector proxy.', { code: 'INVALID_SECTOR_PROXY', status: 400 });
  return { ticker, window, basis, cohort, sectorProxy };
}

export async function loadMarketSignal(input, { now = new Date() } = {}) {
  const options = validateMarketSignalOptions(input);
  const atlas = await readAtlasCacheOnly(now);
  const id = signalCacheId(atlas, options);
  const lastEligibleId = lastEligibleCacheId(options);
  if (pending.has(id)) return pending.get(id);

  const task = (async () => {
    const [cached, lastEligible] = await Promise.all([
      warmGet('market-signal-result-v1', id),
      warmGet('market-signal-last-eligible-v1', lastEligibleId),
    ]);
    const cachedProviderDegraded = cached?.warnings?.some((warning) => (
      warning.code === 'PRICE_BASIS_UNVERIFIED' || warning.code === 'PRICE_REFRESH_FAILED'
    ));
    if (freshResult(cached) && !cachedProviderDegraded) return { ...cached, cache_status: 'warm' };
    if (freshResult(cached) && cachedProviderDegraded && lastEligible?.quality?.headline_eligible) {
      return cachedStale(lastEligible, 'The latest price-provider result did not meet the adjusted-close gate; showing the last completed eligible result.');
    }
    if (freshResult(cached) && cachedProviderDegraded) return { ...cached, cache_status: 'warm' };
    const lease = await warmAcquireLease('market-signal-result', id, RESULT_LEASE_MS);
    if (warmCacheEnabled() && !lease) {
      if (cached) return cachedStale(cached);
      throw new MarketSignalError('Another worker is calculating this model. Retry shortly.', {
        code: 'SIGNAL_CALCULATION_IN_PROGRESS',
        status: 503,
      });
    }
    try {
      const result = await computeSignal({ atlas, ...options, now });
      const providerDegraded = result.warnings?.some((warning) => warning.code === 'PRICE_BASIS_UNVERIFIED');
      const eligibleFallback = cached?.quality?.headline_eligible ? cached : lastEligible;
      if (providerDegraded && eligibleFallback?.quality?.headline_eligible) {
        await warmSet('market-signal-result-v1', id, result, DEGRADED_RESULT_TTL_SECONDS);
        return cachedStale(
          eligibleFallback,
          'The latest price-provider refresh did not meet the adjusted-close gate; showing the last completed eligible result.',
        );
      }
      const writes = [warmSet(
        'market-signal-result-v1',
        id,
        result,
        providerDegraded
          ? DEGRADED_RESULT_TTL_SECONDS
          : result.status === 'withheld' ? WITHHELD_RESULT_TTL_SECONDS : RESULT_TTL_SECONDS,
      )];
      if (!providerDegraded && result.cache_status !== 'stale' && result.quality?.headline_eligible) {
        writes.push(warmSet('market-signal-last-eligible-v1', lastEligibleId, result, RESULT_TTL_SECONDS));
      }
      await Promise.all(writes);
      return result;
    } catch (error) {
      const eligibleFallback = cached?.quality?.headline_eligible ? cached : lastEligible;
      if (eligibleFallback) {
        const fallback = cachedStale(eligibleFallback);
        addWarning(fallback.warnings, 'PRICE_REFRESH_FAILED', 'The latest price refresh failed before a new eligible model could be completed.');
        await warmSet('market-signal-result-v1', id, fallback, DEGRADED_RESULT_TTL_SECONDS);
        return fallback;
      }
      if (error instanceof MarketSignalError || error instanceof EconometricsError) throw error;
      throw new MarketSignalError(error?.message || 'The market signal could not be calculated.', {
        code: error?.code || 'MARKET_SIGNAL_UNAVAILABLE',
        status: error?.status || 502,
        details: error?.details || null,
        cause: error,
      });
    } finally {
      if (lease) await warmReleaseLease('market-signal-result', id, lease);
    }
  })();
  pending.set(id, task);
  try {
    return await task;
  } finally {
    pending.delete(id);
  }
}
