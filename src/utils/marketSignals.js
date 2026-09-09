/**
 * Transparent, filing-derived diagnostics for the Market Factor Lab.
 *
 * These helpers deliberately do not estimate expected returns or make an
 * investment recommendation. They compare changes in SEC-derived metrics
 * with other issuers in the selected research cohort, then optionally compare
 * that result with a separately calculated standardized price response.
 */

export const MARKET_SIGNALS_VERSION = 'edgar-market-signals-v1';
export const MIN_FILING_CHANGE_PEERS = 8;
export const FILING_CHANGE_Z_CLIP = 3;
export const EVIDENCE_GAP_INPUT_CLIP = 3;
export const EVIDENCE_NEUTRAL_BAND = 0.5;

const FINANCIAL_COHORTS = new Set(['credit-banks', 'insurance']);

const NONFINANCIAL_COMPONENTS = [
  { key: 'revenueGrowth', label: 'Revenue growth acceleration', weight: 0.25 },
  { key: 'operatingMargin', label: 'Operating margin change', weight: 0.25 },
  { key: 'freeCashFlowMargin', label: 'Free cash flow margin change', weight: 0.25 },
  { key: 'equityToAssets', label: 'Book equity / assets change', weight: 0.125 },
  { key: 'cashToAssets', label: 'Cash / assets change', weight: 0.125 },
];

const FINANCIAL_COMPONENTS = [
  { key: 'revenueGrowth', label: 'Revenue growth acceleration', weight: 1 / 3 },
  { key: 'netMargin', label: 'Net margin change', weight: 1 / 3 },
  { key: 'equityToAssets', label: 'Book equity / assets change', weight: 1 / 3 },
];

export const FILING_CHANGE_TEMPLATES = Object.freeze({
  nonfinancial: Object.freeze({
    id: 'nonfinancial',
    label: 'Non-financial filing change',
    components: Object.freeze(NONFINANCIAL_COMPONENTS.map((component) => Object.freeze({ ...component }))),
  }),
  financial: Object.freeze({
    id: 'financial',
    label: 'Bank and insurance filing change',
    components: Object.freeze(FINANCIAL_COMPONENTS.map((component) => Object.freeze({ ...component }))),
  }),
});

export const EVIDENCE_GAP_CLAIM_LIMITS = Object.freeze([
  'A diagnostic comparison, not a valuation conclusion.',
  'Not a return forecast, trading signal, or recommendation.',
  'Does not establish that filing information caused the price response.',
]);

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));

function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function hasDispersion(value, center) {
  return isFiniteNumber(value) && value > Number.EPSILON * Math.max(1, Math.abs(center));
}

function peerDistribution(peerValues) {
  const values = peerValues.filter(isFiniteNumber).sort((a, b) => a - b);
  const center = median(values);
  if (center === null) {
    return {
      count: 0, median: null, mad: null, q1: null, q3: null,
      standardDeviation: null, scale: null, scaleMethod: null, min: null, max: null,
    };
  }

  const absoluteDeviations = values.map((value) => Math.abs(value - center)).sort((a, b) => a - b);
  const mad = median(absoluteDeviations);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const standardDeviation = sampleStandardDeviation(values);
  const madScale = isFiniteNumber(mad) ? 1.4826 * mad : null;
  const iqrScale = isFiniteNumber(q1) && isFiniteNumber(q3) ? (q3 - q1) / 1.349 : null;

  let scale = null;
  let scaleMethod = null;
  if (hasDispersion(madScale, center)) {
    scale = madScale;
    scaleMethod = 'median_absolute_deviation';
  } else if (hasDispersion(iqrScale, center)) {
    scale = iqrScale;
    scaleMethod = 'interquartile_range';
  } else if (hasDispersion(standardDeviation, center)) {
    scale = standardDeviation;
    scaleMethod = 'sample_standard_deviation';
  }

  return {
    count: values.length,
    median: center,
    mad,
    q1,
    q3,
    standardDeviation,
    scale,
    scaleMethod,
    min: values[0],
    max: values[values.length - 1],
  };
}

/**
 * Robustly standardize a focus value against other issuers. Raw observations
 * are not winsorized; the resulting z-score is clipped so one component
 * cannot dominate the fixed-weight composite.
 */
export function calculateRobustPeerZ({
  value,
  peerValues,
  minPeers = MIN_FILING_CHANGE_PEERS,
  clip = FILING_CHANGE_Z_CLIP,
} = {}) {
  const peers = Array.isArray(peerValues) ? peerValues.filter(isFiniteNumber) : [];
  const distribution = peerDistribution(peers);
  if (!isFiniteNumber(value)) {
    return { available: false, z: null, percentile: null, reason: 'The focus filing change is unavailable.', distribution };
  }
  if (!Number.isInteger(minPeers) || minPeers < 2) {
    return { available: false, z: null, percentile: null, reason: 'The minimum peer count must be an integer of at least 2.', distribution };
  }
  if (!isFiniteNumber(clip) || clip <= 0) {
    return { available: false, z: null, percentile: null, reason: 'The z-score clip must be a positive finite number.', distribution };
  }
  if (distribution.count < minPeers) {
    return {
      available: false,
      z: null,
      percentile: null,
      reason: `At least ${minPeers} other issuers with compatible filing changes are required; ${distribution.count} are available.`,
      distribution,
    };
  }
  if (!isFiniteNumber(distribution.scale) || distribution.scale <= 0) {
    return {
      available: false,
      z: null,
      percentile: null,
      reason: 'Compatible peer filing changes have no usable dispersion.',
      distribution,
    };
  }

  const rawZ = (value - distribution.median) / distribution.scale;
  const below = peers.filter((peer) => peer < value).length;
  const equal = peers.filter((peer) => peer === value).length;
  return {
    available: true,
    z: clamp(rawZ, -clip, clip),
    rawZ,
    clipped: Math.abs(rawZ) > clip,
    percentile: ((below + 0.5 * equal) / peers.length) * 100,
    reason: null,
    distribution,
  };
}

function normalizedCik(company) {
  const raw = company?.cik == null ? '' : String(company.cik).trim();
  if (!/^\d{1,10}$/.test(raw)) return null;
  return raw.padStart(10, '0');
}

function normalizedTicker(company) {
  return typeof company?.ticker === 'string' && company.ticker.trim()
    ? company.ticker.trim().toUpperCase()
    : null;
}

function sameIssuer(left, right) {
  const leftCik = normalizedCik(left);
  const rightCik = normalizedCik(right);
  if (leftCik && rightCik) return leftCik === rightCik;
  const leftTicker = normalizedTicker(left);
  const rightTicker = normalizedTicker(right);
  return Boolean(leftTicker && rightTicker && leftTicker === rightTicker);
}

function issuerKey(company, fallback) {
  return normalizedCik(company) ? `cik:${normalizedCik(company)}` : normalizedTicker(company) ? `ticker:${normalizedTicker(company)}` : fallback;
}

function usesFinancialTemplate(company, cohortId) {
  if (FINANCIAL_COHORTS.has(cohortId)) return true;
  return Array.isArray(company?.cohorts) && company.cohorts.some((cohort) => FINANCIAL_COHORTS.has(cohort));
}

function templateFor(company, cohortId) {
  return usesFinancialTemplate(company, cohortId) ? FILING_CHANGE_TEMPLATES.financial : FILING_CHANGE_TEMPLATES.nonfinancial;
}

function comparisonFor(company, basis) {
  const value = company?.filingComparisons?.[basis];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function filingClock(company, basis) {
  const current = comparisonFor(company, basis)?.current;
  const value = current?.acceptedAt || current?.filed || null;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function peerFilingClock(company, peers, basis) {
  const focus = filingClock(company, basis);
  const values = peers.map((peer) => filingClock(peer, basis)).filter(Boolean).sort();
  return {
    focus,
    earliestPeer: values[0] || null,
    latestPeer: values.at(-1) || null,
    observedPeers: values.length,
    missingPeers: peers.length - values.length,
    peersAfterFocus: focus ? values.filter((value) => Date.parse(value) > Date.parse(focus)).length : null,
  };
}

function metricBag(comparison, name) {
  if (!comparison) return null;
  const direct = comparison[name] ?? comparison[`${name}Metrics`];
  if (!direct || typeof direct !== 'object' || Array.isArray(direct)) return null;
  return direct.metrics && typeof direct.metrics === 'object' && !Array.isArray(direct.metrics)
    ? direct.metrics
    : direct;
}

function numericMetric(bag, key) {
  const candidate = bag?.[key];
  if (isFiniteNumber(candidate)) return candidate;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  for (const property of ['value', 'change', 'delta']) {
    if (isFiniteNumber(candidate[property])) return candidate[property];
  }
  return null;
}

function metricChange(company, basis, key) {
  const comparison = comparisonFor(company, basis);
  if (!comparison) {
    return { available: false, current: null, prior: null, change: null, suppliedChange: null, changeSource: null, reason: `No ${basis} filing comparison is available.` };
  }
  const current = numericMetric(metricBag(comparison, 'current'), key);
  const prior = numericMetric(metricBag(comparison, 'prior'), key);
  const suppliedChange = numericMetric(metricBag(comparison, 'changes'), key);
  if (!isFiniteNumber(current) || !isFiniteNumber(prior)) {
    return {
      available: false,
      current,
      prior,
      change: null,
      suppliedChange,
      changeSource: null,
      reason: 'Both current and comparable-prior SEC-derived metrics are required.',
    };
  }

  const calculatedChange = current - prior;
  const tolerance = 1e-9 * Math.max(1, Math.abs(calculatedChange), Math.abs(suppliedChange ?? 0));
  const suppliedConsistent = !isFiniteNumber(suppliedChange) || Math.abs(suppliedChange - calculatedChange) <= tolerance;
  return {
    available: true,
    current,
    prior,
    change: calculatedChange,
    suppliedChange,
    suppliedConsistent,
    changeSource: 'current_minus_prior',
    reason: null,
  };
}

function belongsToCohort(company, cohortId) {
  if (!cohortId) return true;
  return Array.isArray(company?.cohorts) && company.cohorts.includes(cohortId);
}

function uniqueEligiblePeers(company, peers, cohortId, templateId) {
  const seen = new Set();
  const eligible = [];
  for (let index = 0; index < peers.length; index += 1) {
    const peer = peers[index];
    if (!peer || typeof peer !== 'object' || sameIssuer(company, peer)) continue;
    if (!belongsToCohort(peer, cohortId) || templateFor(peer, cohortId).id !== templateId) continue;
    const key = issuerKey(peer, `row:${index}`);
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push(peer);
  }
  return eligible;
}

function filingDirection(z) {
  if (z >= EVIDENCE_NEUTRAL_BAND) return { id: 'stronger_relative_change', label: 'Stronger peer-relative filing change' };
  if (z <= -EVIDENCE_NEUTRAL_BAND) return { id: 'weaker_relative_change', label: 'Weaker peer-relative filing change' };
  return { id: 'near_peer_center', label: 'Filing change near the peer center' };
}

function unavailableFilingScore({ company, basis, cohortId, reason, template = null, components = [], eligiblePeerIssuers = 0, peerClock = null }) {
  return {
    schemaVersion: MARKET_SIGNALS_VERSION,
    available: false,
    diagnosticOnly: true,
    ticker: normalizedTicker(company),
    cik: normalizedCik(company),
    basis,
    cohortId: cohortId || null,
    template: template ? { id: template.id, label: template.label } : null,
    filingChangeZ: null,
    direction: null,
    coverage: {
      requiredComponents: template?.components.length || 0,
      availableComponents: components.filter((component) => component.available).length,
      ratio: template?.components.length ? components.filter((component) => component.available).length / template.components.length : 0,
      eligiblePeerIssuers,
      minimumPeersPerComponent: MIN_FILING_CHANGE_PEERS,
      peerFilingClock: peerClock,
    },
    components,
    reason,
    methodology: {
      peerMethod: 'leave-one-out cohort comparison',
      center: 'median',
      primaryScale: '1.4826 × median absolute deviation',
      scaleFallbacks: ['interquartile range / 1.349', 'sample standard deviation'],
      componentZClip: FILING_CHANGE_Z_CLIP,
      missingData: 'No imputation, zero-filling, or weight redistribution.',
    },
    claimLimits: [...EVIDENCE_GAP_CLAIM_LIMITS],
  };
}

/**
 * Build an auditable filing-change score for one company. `peers` may include
 * the focus company; it is excluded by normalized CIK (or ticker when no CIK
 * exists). The score is unavailable unless every fixed-weight component has a
 * current value, a comparable-prior value, enough peers, and usable dispersion.
 */
export function buildFilingChangeScore({ company, peers, basis = 'ttm', cohortId = null } = {}) {
  if (!company || typeof company !== 'object') {
    return unavailableFilingScore({ company: null, basis, cohortId, reason: 'A focus company is required.' });
  }
  if (!['ttm', 'annual'].includes(basis)) {
    return unavailableFilingScore({ company, basis, cohortId, reason: 'Basis must be either ttm or annual.' });
  }
  if (!Array.isArray(peers)) {
    return unavailableFilingScore({ company, basis, cohortId, reason: 'A peer-company array is required.' });
  }

  const template = templateFor(company, cohortId);
  const eligiblePeers = uniqueEligiblePeers(company, peers, cohortId, template.id);
  const peerClock = peerFilingClock(company, eligiblePeers, basis);
  const components = template.components.map((definition) => {
    const focus = metricChange(company, basis, definition.key);
    const peerObservations = eligiblePeers.map((peer) => ({ peer, observation: metricChange(peer, basis, definition.key) }));
    const compatiblePeers = peerObservations.filter(({ observation }) => observation.available);
    const standardized = calculateRobustPeerZ({
      value: focus.change,
      peerValues: compatiblePeers.map(({ observation }) => observation.change),
    });
    const available = focus.available && standardized.available;
    const reason = focus.reason || standardized.reason;
    return {
      key: definition.key,
      label: definition.label,
      unit: 'percentage_points',
      weight: definition.weight,
      required: true,
      available,
      current: focus.current,
      prior: focus.prior,
      change: focus.change,
      suppliedChange: focus.suppliedChange,
      suppliedChangeConsistent: focus.available ? focus.suppliedConsistent : null,
      changeSource: focus.changeSource,
      z: available ? standardized.z : null,
      rawZ: available ? standardized.rawZ : null,
      clipped: available ? standardized.clipped : false,
      weightedZ: available ? standardized.z * definition.weight : null,
      peerPercentile: available ? standardized.percentile : null,
      peerCount: standardized.distribution.count,
      peerCandidates: eligiblePeers.length,
      peerDistribution: standardized.distribution,
      reason,
    };
  });

  const failed = components.filter((component) => !component.available);
  if (failed.length) {
    const labels = failed.map((component) => component.label).join(', ');
    return unavailableFilingScore({
      company,
      basis,
      cohortId,
      template,
      components,
      eligiblePeerIssuers: eligiblePeers.length,
      peerClock,
      reason: `The fixed-weight score is unavailable because these required components are incomplete: ${labels}.`,
    });
  }

  const filingChangeZ = components.reduce((sum, component) => sum + component.weightedZ, 0);
  return {
    schemaVersion: MARKET_SIGNALS_VERSION,
    available: true,
    diagnosticOnly: true,
    ticker: normalizedTicker(company),
    cik: normalizedCik(company),
    basis,
    cohortId: cohortId || null,
    template: { id: template.id, label: template.label },
    filingChangeZ,
    direction: filingDirection(filingChangeZ),
    coverage: {
      requiredComponents: components.length,
      availableComponents: components.length,
      ratio: 1,
      eligiblePeerIssuers: eligiblePeers.length,
      minimumPeersPerComponent: MIN_FILING_CHANGE_PEERS,
      peerFilingClock: peerClock,
    },
    components,
    reason: null,
    methodology: {
      peerMethod: 'leave-one-out cohort comparison',
      center: 'median',
      primaryScale: '1.4826 × median absolute deviation',
      scaleFallbacks: ['interquartile range / 1.349', 'sample standard deviation'],
      componentZClip: FILING_CHANGE_Z_CLIP,
      composite: 'Fixed-weight sum of component z-scores.',
      missingData: 'No imputation, zero-filling, or weight redistribution.',
    },
    claimLimits: [...EVIDENCE_GAP_CLAIM_LIMITS],
  };
}

function axisState(value) {
  if (value >= EVIDENCE_NEUTRAL_BAND) return 'positive';
  if (value <= -EVIDENCE_NEUTRAL_BAND) return 'negative';
  return 'neutral';
}

const ALIGNMENTS = Object.freeze({
  'positive:positive': {
    id: 'aligned_improvement',
    label: 'Aligned improvement',
    interpretation: 'Peer-relative filing change and the model-adjusted price response were both positive.',
  },
  'positive:negative': {
    id: 'filing_improvement_not_confirmed',
    label: 'Filing improvement not confirmed by price',
    interpretation: 'Peer-relative filing change was positive while the model-adjusted price response was negative.',
  },
  'negative:positive': {
    id: 'price_ahead_of_reported_evidence',
    label: 'Price response ahead of reported evidence',
    interpretation: 'The model-adjusted price response was positive while peer-relative filing change was negative.',
  },
  'negative:negative': {
    id: 'aligned_deterioration',
    label: 'Aligned deterioration',
    interpretation: 'Peer-relative filing change and the model-adjusted price response were both negative.',
  },
  'positive:neutral': {
    id: 'filing_change_without_material_price_response',
    label: 'Positive filing change; muted price response',
    interpretation: 'Peer-relative filing change was positive while the model-adjusted price response remained inside the neutral band.',
  },
  'negative:neutral': {
    id: 'filing_deterioration_without_material_price_response',
    label: 'Negative filing change; muted price response',
    interpretation: 'Peer-relative filing change was negative while the model-adjusted price response remained inside the neutral band.',
  },
  'neutral:positive': {
    id: 'price_strength_without_material_filing_change',
    label: 'Positive price response; muted filing change',
    interpretation: 'The model-adjusted price response was positive while peer-relative filing change remained inside the neutral band.',
  },
  'neutral:negative': {
    id: 'price_weakness_without_material_filing_change',
    label: 'Negative price response; muted filing change',
    interpretation: 'The model-adjusted price response was negative while peer-relative filing change remained inside the neutral band.',
  },
  'neutral:neutral': {
    id: 'muted_alignment',
    label: 'Both measures near neutral',
    interpretation: 'Both peer-relative filing change and the model-adjusted price response remained inside the neutral band.',
  },
});

function evidenceGapUnavailable(reason, filingChangeZ, priceResponseZ) {
  return {
    schemaVersion: MARKET_SIGNALS_VERSION,
    available: false,
    diagnosticOnly: true,
    evidenceGap: null,
    inputs: {
      filingChangeZ: isFiniteNumber(filingChangeZ) ? filingChangeZ : null,
      priceResponseZ: isFiniteNumber(priceResponseZ) ? priceResponseZ : null,
      clippedFilingChangeZ: null,
      clippedPriceResponseZ: null,
    },
    classification: null,
    gapInterpretation: null,
    reason,
    formula: 'clip(filingChangeZ, -3, 3) - clip(priceResponseZ, -3, 3)',
    inputClip: EVIDENCE_GAP_INPUT_CLIP,
    neutralBand: EVIDENCE_NEUTRAL_BAND,
    range: { min: -2 * EVIDENCE_GAP_INPUT_CLIP, max: 2 * EVIDENCE_GAP_INPUT_CLIP },
    claimLimits: [...EVIDENCE_GAP_CLAIM_LIMITS],
  };
}

/**
 * Compare two already standardized diagnostics. The evidence gap is not a
 * statistical significance test and must always be shown with both inputs.
 */
export function calculateEvidenceGap({ filingChangeZ, priceResponseZ } = {}) {
  if (!isFiniteNumber(filingChangeZ) && !isFiniteNumber(priceResponseZ)) {
    return evidenceGapUnavailable('Filing change and 20-day standardized price response are required.', filingChangeZ, priceResponseZ);
  }
  if (!isFiniteNumber(filingChangeZ)) {
    return evidenceGapUnavailable('A finite filing-change z-score is required.', filingChangeZ, priceResponseZ);
  }
  if (!isFiniteNumber(priceResponseZ)) {
    return evidenceGapUnavailable('A finite 20-day standardized price response is required.', filingChangeZ, priceResponseZ);
  }

  const clippedFilingChangeZ = clamp(filingChangeZ, -EVIDENCE_GAP_INPUT_CLIP, EVIDENCE_GAP_INPUT_CLIP);
  const clippedPriceResponseZ = clamp(priceResponseZ, -EVIDENCE_GAP_INPUT_CLIP, EVIDENCE_GAP_INPUT_CLIP);
  const classification = ALIGNMENTS[`${axisState(clippedFilingChangeZ)}:${axisState(clippedPriceResponseZ)}`];
  const evidenceGap = clippedFilingChangeZ - clippedPriceResponseZ;
  const gapInterpretation = evidenceGap >= EVIDENCE_NEUTRAL_BAND
    ? 'Reported filing change was stronger than the model-adjusted price response on the clipped standardized scales.'
    : evidenceGap <= -EVIDENCE_NEUTRAL_BAND
      ? 'The model-adjusted price response was stronger than reported filing change on the clipped standardized scales.'
      : 'Reported filing change and the model-adjusted price response were close on the clipped standardized scales.';

  return {
    schemaVersion: MARKET_SIGNALS_VERSION,
    available: true,
    diagnosticOnly: true,
    evidenceGap,
    inputs: { filingChangeZ, priceResponseZ, clippedFilingChangeZ, clippedPriceResponseZ },
    classification,
    gapInterpretation,
    reason: null,
    formula: 'clip(filingChangeZ, -3, 3) - clip(priceResponseZ, -3, 3)',
    inputClip: EVIDENCE_GAP_INPUT_CLIP,
    neutralBand: EVIDENCE_NEUTRAL_BAND,
    range: { min: -2 * EVIDENCE_GAP_INPUT_CLIP, max: 2 * EVIDENCE_GAP_INPUT_CLIP },
    claimLimits: [...EVIDENCE_GAP_CLAIM_LIMITS],
  };
}
