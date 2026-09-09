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
export const MARKET_SIGNALS_METHODOLOGY_VERSION = 'market-signals-1.1.0';

const RESULT_FRESH_MS = 12 * 60 * 60 * 1000;
const RESULT_TTL_SECONDS = 2 * 24 * 60 * 60;
const LAST_ELIGIBLE_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEGRADED_RESULT_TTL_SECONDS = 2 * 60;
const WITHHELD_RESULT_TTL_SECONDS = 12 * 60 * 60;
const RESULT_LEASE_MS = 75_000;
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

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function stableHash(value, length = 16) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex').slice(0, length);
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
  const current = atlasFromCache(await warmGet(MARKET_VERSION, 'atlas'));
  const cachedAtlas = current || atlasFromCache(await warmGet(MARKET_VERSION, 'atlas-last-good'));
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

function resolveSignalOptions(atlas, options) {
  const company = atlas.companies.find((candidate) => candidate.ticker === options.ticker);
  if (!company) {
    throw new MarketSignalError('Choose a company from the current Market research universe.', {
      code: 'COMPANY_OUTSIDE_UNIVERSE',
      status: 400,
    });
  }
  const cohort = chooseCohort(company, options.cohort);
  if (!cohort) throw new MarketSignalError('No peer-normalization cohort is available for this company.', { code: 'COHORT_UNAVAILABLE', status: 422 });
  return { ...options, cohort, sectorProxy: chooseProxy(cohort, options.sectorProxy) };
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
  const overlap = diagnostics?.sample?.overlapCoverage ?? 0;
  const componentLabel = `${componentCount}/${requiredComponentCount || 0}`;
  const gates = [
    {
      id: 'adjusted_prices',
      label: 'Adjusted-price provenance',
      status: adjustedEligible ? 'pass' : 'fail',
      value: adjustedEligible ? 'Complete Yahoo adjusted close' : 'Incomplete or fallback basis',
      requirement: 'All company, SPY, and sector observations must be Yahoo adjusted close.',
    },
    {
      id: 'aligned_sample',
      label: 'Exactly aligned sample',
      status: observations >= 126 ? 'pass' : 'fail',
      value: `${observations} sessions`,
      requirement: 'At least 126 exactly matched daily return intervals.',
    },
    {
      id: 'overlap',
      label: 'Benchmark overlap',
      status: overlap >= 0.8 ? 'pass' : 'fail',
      value: `${(overlap * 100).toFixed(1)}%`,
      requirement: 'At least 80% of eligible benchmark intervals.',
    },
    {
      id: 'peer_sample',
      label: 'Peer normalization',
      status: peerCount >= 8 ? 'pass' : 'warn',
      value: `${peerCount} minimum peers`,
      requirement: 'At least eight leave-one-out peers for every filing component.',
    },
    {
      id: 'filing_components',
      label: 'Filing template coverage',
      status: filingScoreComplete ? 'pass' : 'warn',
      value: `${componentLabel} components`,
      requirement: 'Every fixed-template component must be available; weights are never redistributed.',
    },
    {
      id: 'event_window',
      label: 'Filing-event window',
      status: hasEvent ? 'pass' : 'warn',
      value: hasEvent ? '20 sessions complete' : 'Incomplete',
      requirement: 'Twenty uninterrupted company, SPY, and sector return intervals.',
    },
    {
      id: 'sec_freshness',
      label: 'SEC snapshot freshness',
      status: atlas.cache?.status === 'stale' ? 'warn' : 'pass',
      value: atlas.cache?.status || 'current',
      requirement: 'Scheduled SEC snapshot inside the 25-hour freshness window.',
    },
  ];
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
    gates,
  };
}

function filingDriverSummary(filingScore) {
  const components = (filingScore?.components || [])
    .filter((component) => component?.available && finite(component?.weightedZ))
    .map((component) => ({
      key: component.key,
      label: component.label,
      weightedZ: component.weightedZ,
      z: component.z,
      weight: component.weight,
    }));
  const ranked = [...components].sort((a, b) => Math.abs(b.weightedZ) - Math.abs(a.weightedZ));
  const strongestPositive = [...components].filter((item) => item.weightedZ > 0).sort((a, b) => b.weightedZ - a.weightedZ)[0] || null;
  const strongestNegative = [...components].filter((item) => item.weightedZ < 0).sort((a, b) => a.weightedZ - b.weightedZ)[0] || null;
  return {
    available: components.length > 0,
    ranked,
    strongestPositive,
    strongestNegative,
    contributionSum: components.reduce((sum, component) => sum + component.weightedZ, 0),
  };
}

function researchReadout({ ticker, diagnostics, filingScore, evidenceGap, quality }) {
  const observations = [];
  const questions = [];
  if (!quality.headline_eligible || !diagnostics) {
    observations.push({
      id: 'headline_withheld',
      level: 'high',
      finding: 'Headline regression estimates are withheld.',
      rule: 'Adjusted-close, observation, or exact-overlap gate failed.',
    });
    questions.push('Which input or provenance gate failed, and can the sample be repaired without mixing price bases?');
  } else {
    const interval = diagnostics.marketModel.betaConfidenceInterval95;
    if (interval) {
      const relation = interval[0] > 1 ? 'above' : interval[1] < 1 ? 'below' : 'includes';
      observations.push({
        id: 'beta_reference',
        level: relation === 'includes' ? 'context' : 'high',
        finding: relation === 'includes'
          ? `${ticker}'s 95% HAC beta interval includes 1.`
          : `${ticker}'s 95% HAC beta interval is entirely ${relation} 1.`,
        rule: 'Compare the complete 95% Newey-West HAC interval with beta = 1.',
      });
    }
    const asymmetry = diagnostics.conditionalBeta?.asymmetry;
    if (finite(asymmetry) && Math.abs(asymmetry) >= 0.25) {
      observations.push({
        id: 'conditional_asymmetry',
        level: 'high',
        finding: `The downside and upside beta point estimates differ by ${Math.abs(asymmetry).toFixed(2)} (downside minus upside ${asymmetry.toFixed(2)}).`,
        rule: 'Preset triage emphasis when |downside beta - upside beta| is at least 0.25; this is not a formal asymmetry test.',
      });
      questions.push('Which business, balance-sheet, or event exposures coincide with the asymmetric market sensitivity?');
    }
    const rolling = diagnostics.rollingBeta;
    if (finite(rolling?.currentPercentile)) {
      observations.push({
        id: 'rolling_location',
        level: rolling.currentPercentile <= 10 || rolling.currentPercentile >= 90 ? 'high' : 'context',
        finding: `Current rolling beta has a ${rolling.currentPercentile.toFixed(0)}% percentile rank within displayed windows.`,
        rule: 'Empirical percentile within the displayed overlapping rolling windows.',
      });
    }
    if (diagnostics.influenceSensitivity?.available && Math.abs(diagnostics.influenceSensitivity.betaDelta) >= 0.1) {
      observations.push({
        id: 'influence_sensitivity',
        level: 'high',
        finding: `Excluding the three largest Cook-distance sessions changes beta by ${diagnostics.influenceSensitivity.betaDelta.toFixed(2)}.`,
        rule: 'Surface when the exclusion sensitivity changes beta by at least 0.10.',
      });
      questions.push('What company-specific disclosures or market events occurred on the influential dates?');
    }
  }
  if (evidenceGap?.available) {
    observations.push({
      id: 'evidence_gap',
      level: Math.abs(evidenceGap.evidenceGap) >= 1 ? 'high' : 'context',
      finding: `${ticker}'s Evidence Gap is ${evidenceGap.evidenceGap.toFixed(2)} (${evidenceGap.classification?.label || 'classified'}).`,
      rule: 'Preset display emphasis when |clipped filing z - clipped price-response z| is at least 1.00; this is not a validated materiality cutoff.',
    });
    questions.push('Which weighted filing components explain the filing side of the gap, and did later disclosures resolve the disagreement?');
  } else {
    questions.push('Which missing peer or event-window input prevents the filing-versus-price comparison?');
  }
  if (filingScore?.coverage?.peerFilingClock?.peersAfterFocus > 0) {
    questions.push('Would the conclusion persist in a fully event-time peer cross-section once deeper filing history is available?');
  }
  return {
    observations,
    questions: [...new Set(questions)].slice(0, 4),
    claimBoundary: 'Descriptive research triage only; not a forecast, valuation, causal filing-impact estimate, recommendation, or trade signal.',
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
    pieces.push(`The downside beta point estimate ${direction} the upside beta point estimate by ${Math.abs(diagnostics.conditionalBeta.asymmetry).toFixed(2)}.`);
  }
  if (filingScore?.available && finite(filingEvent?.windows?.['20']?.standardizedResponse)) {
    const filing = filingScore.filingChangeZ > 0 ? 'above' : filingScore.filingChangeZ < 0 ? 'below' : 'at';
    const response = filingEvent.windows['20'].standardizedResponse;
    const price = response >= 0.5 ? 'above the +0.50 display threshold' : response <= -0.5 ? 'below the −0.50 display threshold' : 'inside the ±0.50 neutral display band';
    pieces.push(`The latest filing-change score is ${filing} its peer center, while the 20-session model-adjusted response is ${price}.`);
  }
  if (evidenceGap?.available) pieces.push('The Evidence Gap is a descriptive disagreement measure, not an expected-return estimate.');
  return pieces.join(' ');
}

async function computeSignal({ atlas, ticker, window, basis, cohort: requestedCohort, sectorProxy: requestedProxy, now, signal }) {
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
  // Retrieve one five-year panel for every request so the 1y/3y/5y term
  // structure is estimated from genuinely available history, while the
  // headline regression is still filtered to the user's selected window.
  const termStructureStart = requestedStart(now, '5y');
  const fromIso = priceStart(now, termStructureStart, filingComparison);
  const [asset, market, sector] = await Promise.all([
    loadPriceSeries({ ticker, fromIso, now, signal }),
    loadPriceSeries({ ticker: 'SPY', fromIso, now, signal }),
    loadPriceSeries({ ticker: sectorProxy, fromIso, now, signal }),
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
      const horizonStarts = Object.fromEntries(Object.keys(MARKET_SIGNAL_WINDOWS).map((horizon) => [
        horizon,
        requestedStart(now, horizon),
      ]));
      diagnostics = estimateRegressionDiagnostics({
        assetPrices: asset.prices,
        marketPrices: market.prices,
        sectorPrices: sector.prices,
        requestedStart: windowStart,
        horizonStarts,
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
  const cleanDiagnostics = diagnostics ? stripModelInternals(diagnostics) : null;
  const priceFingerprints = Object.fromEntries([['asset', asset], ['market', market], ['sector_proxy', sector]].map(([role, series]) => [
    role,
    stableHash({
      ticker: series.ticker,
      provider: series.provider,
      priceBasis: series.priceBasis,
      prices: series.prices
        .map((point) => [point.date, point.adjustedClose ?? point.close ?? null])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    }, 64),
  ]));
  const secFingerprint = stableHash({
    basis,
    cohort: cohortId,
    focus: {
      ticker: company.ticker,
      cik: company.cik,
      cohorts: [...company.cohorts].sort(),
      filingComparison,
    },
    peers: peers.map((peer) => ({
      ticker: peer.ticker,
      cik: peer.cik,
      cohorts: [...peer.cohorts].sort(),
      filingComparison: peer.filingComparisons?.[basis] || null,
    })).sort((left, right) => `${left.cik}:${left.ticker}`.localeCompare(`${right.cik}:${right.ticker}`)),
  }, 64);
  const inputFingerprint = stableHash({
    schema: MARKET_SIGNALS_SCHEMA_VERSION,
    methodology: MARKET_SIGNALS_METHODOLOGY_VERSION,
    universe: MARKET_VERSION,
    request,
    calculationCutoffs: {
      headlineStart: windowStart,
      horizonStarts: Object.fromEntries(Object.keys(MARKET_SIGNAL_WINDOWS).map((horizon) => [horizon, requestedStart(now, horizon)])),
    },
    dataThrough,
    sec: secFingerprint,
    prices: priceFingerprints,
  }, 64);
  const snapshotId = `${MARKET_VERSION}:${inputFingerprint.slice(0, 20)}`;
  const calculatedStatus = modelError || !adjustedEligible ? 'withheld' : quality.evidence_gap_eligible ? 'ready' : 'partial';
  const status = calculatedStatus === 'ready' && atlas.cache?.status === 'stale' ? 'stale' : calculatedStatus;
  const driverSummary = filingDriverSummary(filingScore);
  const readout = researchReadout({ ticker, diagnostics, filingScore, evidenceGap, quality });
  const interpretation = deterministicInterpretation({ ticker, diagnostics, filingScore, filingEvent, evidenceGap, quality });
  const measurement = {
    returns: 'daily decimal log returns',
    event_abnormal_return: 'decimal cumulative simple return transformed from log residuals',
    volatility: 'annualized decimal using 252 sessions',
    beta_and_z_scores: 'unitless',
    filing_levels: 'percent',
    filing_changes: 'percentage points',
    annualization_sessions: 252,
  };
  const provenance = {
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
  };
  const equations = [
    { id: 'market_model', expression: 'ln(P_i,t/P_i,t-1) = intercept + beta_market * ln(P_SPY,t/P_SPY,t-1) + error_t', inference: 'Newey-West HAC; automatic Bartlett lag' },
    { id: 'independent_sector', expression: 'sector_residual = r_sector - fitted(r_sector ~ SPY); r_asset = intercept + beta_market*r_SPY + beta_sector*sector_residual + error', inference: 'Frisch-Waugh-Lovell residualization' },
    { id: 'evidence_gap', expression: 'clip(filing_change_z, -3, 3) - clip(price_response_z, -3, 3)', inference: 'Descriptive diagnostic; no expected-return interpretation' },
    { id: 'filing_event_response', expression: 'z_h = cumulative log abnormal return / sqrt(Bartlett-weighted HAC cumulative residual variance)', inference: 'Approximate standardized event response; does not isolate concurrent news' },
  ];
  const limitations = [
    'This is a market-model diagnostic, not CAPM: no risk-free return is subtracted.',
    'The regression intercept is not Jensen alpha.',
    'The filing score is a current, peer-normalized descriptive snapshot and is not a historical factor return.',
    'The current curated universe is not survivorship-free and does not include complete delisting histories.',
    'Only pre-open SEC acceptances use the same session; intraday, post-close, non-trading-day, and date-only filings begin on the next benchmark session.',
    'Benchmark sessions are inferred from observed SPY dates rather than a separately licensed official exchange calendar.',
    'Peer normalization is a calculation-time cross-section of latest point-in-time filings, not a peer portfolio reconstructed at the focus filing event.',
    'The Evidence Gap is not a valuation, forecast, recommendation, or trade signal.',
    'The influence sensitivity is an exclusion diagnostic, not a replacement robust estimator.',
    'Residual-tail statistics describe the in-sample market-model residual distribution and are not portfolio VaR or expected loss.',
    'Derived statistics are provided without redistributing bulk vendor price histories.',
  ];
  const links = {
    methodology: 'https://secedgarterminal.com/market/factors',
    api: `https://secedgarterminal.com/api/v1/market-signals?ticker=${encodeURIComponent(ticker)}&window=${window}&basis=${basis}&cohort=${encodeURIComponent(cohortId)}&sector_proxy=${sectorProxy}`,
    schema: 'https://secedgarterminal.com/schemas/market-signals-v1.schema.json',
    company_analysis: `https://secedgarterminal.com/analysis/${encodeURIComponent(ticker)}`,
    sec_companyfacts: `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`,
  };
  const currentAccession = filingComparison?.current?.accession || null;
  const priorAccession = filingComparison?.prior?.accession || null;
  const baseResult = {
    schema_version: MARKET_SIGNALS_SCHEMA_VERSION,
    methodology_version: MARKET_SIGNALS_METHODOLOGY_VERSION,
    universe_version: MARKET_VERSION,
    snapshot_id: snapshotId,
    fingerprints: {
      algorithm: 'sha-256',
      canonicalization: 'UTF-8 JSON with recursively lexicographic object keys; documented arrays explicitly sorted where order is not analytic',
      input_scope: 'Schema, methodology, universe, normalized request, canonical SEC focus/peer comparison values, and internal price-series trace hashes; retrieval clocks excluded.',
      result_scope: 'Canonical initially computed API record excluding result_sha256. Delivery-time cache status or stale annotations may differ; use HTTP ETag for exact response bytes.',
      input_sha256: inputFingerprint,
      sec_sha256: secFingerprint,
      prices: priceFingerprints,
    },
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
      beta_term_structure: snakeCase(cleanDiagnostics.betaTermStructure),
      influence_sensitivity: snakeCase(cleanDiagnostics.influenceSensitivity),
      residual_tail: snakeCase(cleanDiagnostics.residualTail),
    } : null,
    edgar_snapshot: filingScore ? { ...snakeCase(filingScore), driver_summary: snakeCase(driverSummary) } : null,
    filing_event: snakeCase(filingEvent),
    evidence_gap: snakeCase(evidenceGap),
    quality,
    research_readout: snakeCase(readout),
    interpretation,
    measurement,
    provenance,
    equations,
    warnings,
    limitations,
    links,
    cite_as: `EDGAR Terminal, EDGAR Factor Lab, ${ticker}, data through ${dataThrough || 'unavailable'}, snapshot ${snapshotId}, methodology ${MARKET_SIGNALS_METHODOLOGY_VERSION}, current accession ${currentAccession || 'unavailable'}, prior accession ${priorAccession || 'unavailable'}, ${links.api}.`,
  };
  const resultFingerprint = stableHash(baseResult, 64);
  return {
    ...baseResult,
    fingerprints: { ...baseResult.fingerprints, result_sha256: resultFingerprint },
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

export async function loadMarketSignal(input, { now = new Date(), signal, atlas: providedAtlas = null } = {}) {
  const requestedOptions = validateMarketSignalOptions(input);
  const atlas = atlasFromCache(providedAtlas) || await readAtlasCacheOnly(now);
  const options = resolveSignalOptions(atlas, requestedOptions);
  const id = signalCacheId(atlas, options);
  const lastEligibleId = lastEligibleCacheId(options);
  if (!signal && pending.has(id)) return pending.get(id);

  const task = (async () => {
    const cached = await warmGet('market-signal-result-v1', id);
    const cachedProviderDegraded = cached?.warnings?.some((warning) => (
      warning.code === 'PRICE_BASIS_UNVERIFIED' || warning.code === 'PRICE_REFRESH_FAILED'
    ));
    if (freshResult(cached) && !cachedProviderDegraded) return { ...cached, cache_status: 'warm' };
    const lastEligible = await warmGet('market-signal-last-eligible-v1', lastEligibleId);
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
      const result = await computeSignal({ atlas, ...options, now, signal });
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
        writes.push(warmSet('market-signal-last-eligible-v1', lastEligibleId, result, LAST_ELIGIBLE_TTL_SECONDS));
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
  if (!signal) pending.set(id, task);
  try {
    return await task;
  } finally {
    if (!signal) pending.delete(id);
  }
}
