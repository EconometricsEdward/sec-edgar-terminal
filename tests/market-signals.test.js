import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVIDENCE_GAP_INPUT_CLIP,
  FILING_CHANGE_TEMPLATES,
  MIN_FILING_CHANGE_PEERS,
  buildFilingChangeScore,
  calculateEvidenceGap,
  calculateRobustPeerZ,
} from '../src/utils/marketSignals.js';

const METRICS = [
  'revenueGrowth',
  'operatingMargin',
  'freeCashFlowMargin',
  'equityToAssets',
  'cashToAssets',
  'netMargin',
];

function company(ticker, cik, cohorts, deltas, options = {}) {
  const prior = Object.fromEntries(METRICS.map((metric) => [metric, options.prior?.[metric] ?? 10]));
  const current = Object.fromEntries(METRICS.map((metric) => [metric, prior[metric] + (deltas[metric] ?? 0)]));
  for (const metric of options.missingCurrent || []) current[metric] = null;
  for (const metric of options.missingPrior || []) prior[metric] = null;
  return {
    ticker,
    cik,
    cohorts,
    filingComparisons: {
      ttm: {
        current,
        prior,
        changes: Object.fromEntries(METRICS.map((metric) => [metric, deltas[metric] ?? 0])),
      },
      annual: {
        current: { metrics: current },
        prior: { metrics: prior },
        changes: { metrics: Object.fromEntries(METRICS.map((metric) => [metric, deltas[metric] ?? 0])) },
      },
    },
  };
}

const repeatedDeltas = (value) => Object.fromEntries(METRICS.map((metric) => [metric, value]));
const peerSet = (cohort = 'software-security') => Array.from({ length: MIN_FILING_CHANGE_PEERS }, (_, index) =>
  company(`P${index + 1}`, String(index + 101), [cohort], repeatedDeltas(index + 1)));

test('non-financial score uses fixed weights and leave-one-out median/MAD normalization', () => {
  const focus = company('FOCUS', '0000000042', ['software-security'], repeatedDeltas(10));
  const duplicateShareClass = company('FOCUS.B', '42', ['software-security'], repeatedDeltas(-100));
  const result = buildFilingChangeScore({
    company: focus,
    peers: [focus, duplicateShareClass, ...peerSet()],
    basis: 'ttm',
    cohortId: 'software-security',
  });

  assert.equal(result.available, true);
  assert.equal(result.template.id, 'nonfinancial');
  assert.equal(result.components.length, 5);
  assert.equal(result.components.reduce((sum, component) => sum + component.weight, 0), 1);
  assert.ok(result.components.every((component) => component.peerCount === MIN_FILING_CHANGE_PEERS));
  assert.ok(result.components.every((component) => component.peerDistribution.median === 4.5));
  const expected = (10 - 4.5) / (1.4826 * 2);
  assert.ok(Math.abs(result.filingChangeZ - expected) < 1e-12);
  assert.equal(result.direction.id, 'stronger_relative_change');
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('annual comparisons may expose metric bags under a metrics property', () => {
  const focus = company('FOCUS', '42', ['software-security'], repeatedDeltas(5));
  const result = buildFilingChangeScore({ company: focus, peers: peerSet(), basis: 'annual', cohortId: 'software-security' });
  assert.equal(result.available, true);
  assert.equal(result.components[0].current, 15);
  assert.equal(result.components[0].prior, 10);
  assert.equal(result.components[0].change, 5);
});

test('Filing scores expose peer clock dispersion instead of implying an event-time cross-section', () => {
  const focus = company('FOCUS', '42', ['software-security'], repeatedDeltas(5));
  focus.filingComparisons.ttm.current.acceptedAt = '2026-08-01T12:00:00.000Z';
  const peers = peerSet();
  peers.forEach((peer, index) => {
    peer.filingComparisons.ttm.current.acceptedAt = index < 3
      ? `2026-08-0${index + 2}T12:00:00.000Z`
      : '2026-07-30T12:00:00.000Z';
  });
  const result = buildFilingChangeScore({ company: focus, peers, cohortId: 'software-security' });
  assert.equal(result.coverage.peerFilingClock.observedPeers, MIN_FILING_CHANGE_PEERS);
  assert.equal(result.coverage.peerFilingClock.peersAfterFocus, 3);
  assert.equal(result.coverage.peerFilingClock.earliestPeer, '2026-07-30T12:00:00.000Z');
});

test('financial cohorts use only the financial template and require all three components', () => {
  const financialDeltas = { revenueGrowth: 4, netMargin: 4, equityToAssets: 4 };
  const focus = company('BANK', '500', ['credit-banks'], financialDeltas, {
    missingCurrent: ['operatingMargin', 'freeCashFlowMargin', 'cashToAssets'],
  });
  const peers = Array.from({ length: MIN_FILING_CHANGE_PEERS }, (_, index) => company(
    `B${index}`,
    String(600 + index),
    ['credit-banks'],
    { revenueGrowth: index, netMargin: index, equityToAssets: index },
    { missingCurrent: ['operatingMargin', 'freeCashFlowMargin', 'cashToAssets'] },
  ));
  // A non-financial row cannot enter a bank component distribution.
  peers.push(company('SOFT', '999', ['software-security'], repeatedDeltas(100)));
  const result = buildFilingChangeScore({ company: focus, peers, basis: 'ttm', cohortId: 'credit-banks' });

  assert.equal(result.available, true);
  assert.equal(result.template.id, 'financial');
  assert.deepEqual(result.components.map((component) => component.key), ['revenueGrowth', 'netMargin', 'equityToAssets']);
  assert.ok(result.components.every((component) => component.peerCount === MIN_FILING_CHANGE_PEERS));
  assert.equal(FILING_CHANGE_TEMPLATES.financial.components.length, 3);
});

test('missing required focus observations make the fixed-weight score unavailable without reweighting', () => {
  const focus = company('FOCUS', '42', ['software-security'], repeatedDeltas(2), { missingCurrent: ['freeCashFlowMargin'] });
  const result = buildFilingChangeScore({ company: focus, peers: peerSet(), cohortId: 'software-security' });
  const missing = result.components.find((component) => component.key === 'freeCashFlowMargin');

  assert.equal(result.available, false);
  assert.equal(result.filingChangeZ, null);
  assert.equal(result.coverage.availableComponents, 4);
  assert.equal(missing.available, false);
  assert.equal(missing.current, null);
  assert.match(missing.reason, /current and comparable-prior/);
  assert.match(result.methodology.missingData, /No imputation/);
});

test('zero is a valid filing change while missing peer observations reduce coverage', () => {
  const focus = company('FOCUS', '42', ['software-security'], repeatedDeltas(0));
  const peers = peerSet();
  peers[0] = company('P1', '101', ['software-security'], repeatedDeltas(1), { missingPrior: ['cashToAssets'] });
  const result = buildFilingChangeScore({ company: focus, peers, cohortId: 'software-security' });

  assert.equal(result.available, false);
  assert.equal(result.components.find((component) => component.key === 'cashToAssets').peerCount, MIN_FILING_CHANGE_PEERS - 1);
  assert.equal(result.components.find((component) => component.key === 'revenueGrowth').current, 10);
  assert.equal(result.components.find((component) => component.key === 'revenueGrowth').change, 0);
});

test('robust peer normalization falls back from MAD to IQR and then standard deviation', () => {
  const iqr = calculateRobustPeerZ({ value: 2, peerValues: [0, 0, 0, 0, 0, 1, 2, 3] });
  assert.equal(iqr.available, true);
  assert.equal(iqr.distribution.scaleMethod, 'interquartile_range');

  const standardDeviation = calculateRobustPeerZ({ value: 2, peerValues: [0, 0, 0, 0, 0, 0, 0, 10] });
  assert.equal(standardDeviation.available, true);
  assert.equal(standardDeviation.distribution.scaleMethod, 'sample_standard_deviation');

  const constant = calculateRobustPeerZ({ value: 2, peerValues: Array(8).fill(1) });
  assert.equal(constant.available, false);
  assert.match(constant.reason, /no usable dispersion/);
});

test('invalid score requests return JSON-safe unavailable diagnostics instead of throwing', () => {
  const noCompany = buildFilingChangeScore();
  const wrongBasis = buildFilingChangeScore({ company: company('A', '1', [], repeatedDeltas(1)), peers: [], basis: 'quarter' });
  const wrongPeers = buildFilingChangeScore({ company: company('A', '1', [], repeatedDeltas(1)), peers: null });

  assert.equal(noCompany.available, false);
  assert.match(wrongBasis.reason, /ttm or annual/);
  assert.match(wrongPeers.reason, /peer-company array/);
  assert.doesNotThrow(() => JSON.stringify([noCompany, wrongBasis, wrongPeers]));
});

test('evidence gap clips both standardized inputs, exposes the formula, and classifies alignment', () => {
  const result = calculateEvidenceGap({ filingChangeZ: 4, priceResponseZ: -5 });
  assert.equal(result.available, true);
  assert.equal(result.inputs.clippedFilingChangeZ, EVIDENCE_GAP_INPUT_CLIP);
  assert.equal(result.inputs.clippedPriceResponseZ, -EVIDENCE_GAP_INPUT_CLIP);
  assert.equal(result.evidenceGap, 6);
  assert.equal(result.classification.id, 'filing_improvement_not_confirmed');
  assert.equal(result.range.min, -6);
  assert.equal(result.range.max, 6);
  assert.equal(result.diagnosticOnly, true);
  assert.match(result.formula, /clip/);
});

test('evidence gap keeps neutral observations neutral and never converts missing inputs to zero', () => {
  const neutral = calculateEvidenceGap({ filingChangeZ: 0.2, priceResponseZ: -0.1 });
  const missing = calculateEvidenceGap({ filingChangeZ: 0.2, priceResponseZ: null });
  const nonfinite = calculateEvidenceGap({ filingChangeZ: Number.POSITIVE_INFINITY, priceResponseZ: 1 });

  assert.equal(neutral.classification.id, 'muted_alignment');
  assert.ok(Math.abs(neutral.evidenceGap - 0.3) < 1e-12);
  assert.equal(missing.available, false);
  assert.equal(missing.evidenceGap, null);
  assert.equal(missing.inputs.priceResponseZ, null);
  assert.equal(nonfinite.available, false);
  assert.doesNotThrow(() => JSON.stringify([neutral, missing, nonfinite]));
});
