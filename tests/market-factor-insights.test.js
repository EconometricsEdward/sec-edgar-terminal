import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  betaIntervalReading, betaScenario, eventTermStructure, rollingRegime,
  buildFactorReadingGuide, evidenceReading, filingComponentReading, withFactorReadingGuide,
} from '../src/utils/marketFactorInsights.js';

const sample = () => ({
  status: 'ready', request: { ticker: 'TEST', sector_proxy: 'XLK' },
  sample: { observations: 500, overlap_coverage: .95, effective_start: '2024-01-02', effective_end: '2026-01-02' },
  estimates: { market_model: { beta: 1.2, beta_confidence_interval95: [.8, 1.6], r_squared: .3, residual_volatility_annualized: .4, beta_standard_error: .2, influential_dates: [{ date: '2025-01-02', distance: .12 }] },
    conditional_beta: { downside: { beta: 1.5 }, upside: { beta: 1 }, asymmetry: .5 },
    independent_sector_sensitivity: { independent_sector_beta: -.4 }, rolling_beta: { current: 1.3, median: 1.2, minimum: .9, maximum: 1.5, range: .6 } },
  quality: { headline_eligible: true, grade: 'B' },
  edgar_snapshot: { available: true, filing_change_z: 1, coverage: { peer_filing_clock: { peers_after_focus: 4 } } },
  filing_event: { windows: { '20': { cumulative_abnormal_return: -.05, standardized_response: -1 } } },
  evidence_gap: { available: true, evidence_gap: 2, inputs: { filing_change_z: 1, price_response_z: -1 }, classification: { id: 'filing_improvement_not_confirmed', label: 'Filing improvement not confirmed' } },
});
const metric = (data, id) => buildFactorReadingGuide(data).metrics.find((item) => item.id === id);

test('interval interpretation uses zero and one, not an arbitrary confidence grade', () => {
  assert.match(betaIntervalReading({ beta_confidence_interval95: [.9, 1.3] }).reading, /includes one/);
  assert.match(betaIntervalReading({ beta_confidence_interval95: [-.3, 1.3] }).reading, /includes zero/);
  assert.match(betaIntervalReading({ beta_confidence_interval95: [-2, -.3] }).label, /Inverse/);
  assert.match(betaIntervalReading({ beta_confidence_interval95: [1.1, 1.3] }).reading, /above one/);
  assert.equal(betaIntervalReading({ beta_confidence_interval95: [2, 1] }).intervalWidth, null);
  assert.equal(betaIntervalReading({}).intervalWidth, null);
});

test('shock uses log-return coefficients, preserves identity and orders negative-shock bounds', () => {
  const result = betaScenario(2, [1, 3], -10);
  assert.ok(Math.abs(result.estimate - (-19)) < 1e-10);
  assert.ok(Math.abs(result.bounds[0] - (-27.1)) < 1e-10);
  assert.ok(Math.abs(result.bounds[1] - (-10)) < 1e-10);
  assert.ok(Math.abs(betaScenario(1, null, 15).estimate - 15) < 1e-10);
  assert.deepEqual(betaScenario(1, [.8, 1.2], 0), { estimate: 0, bounds: [0, 0] });
  assert.ok(betaScenario(-1, [-2, -.5], -5).estimate > 0);
  assert.equal(betaScenario(null, [1, 2], 5), null);
  assert.equal(betaScenario(1, [1, 2], -100), null);
  assert.equal(betaScenario(1e308, null, 100), null);
});

test('rolling dispersion is unavailable for a single observation', () => {
  const points = [{ beta: .8 }, { beta: 1.2 }, { beta: 1.4 }];
  const result = rollingRegime(points, 1.4, 1.1);
  assert.equal(result.direction, '+0.30 versus rolling median');
  assert.equal(result.aboveOne, 2 / 3);
  assert.equal(rollingRegime([{ beta: 1 }], 1, 1).standardDeviation, null);
  assert.deepEqual(points, [{ beta: .8 }, { beta: 1.2 }, { beta: 1.4 }]);
});

test('unfinished event horizons remain explicitly missing, preserving an explicit zero', () => {
  const result = eventTermStructure({ '20': null, '1': { cumulative_abnormal_return: 0, standardized_response: 0 } });
  assert.deepEqual(result.map((point) => point.sessions), [1, 5, 20]);
  assert.equal(result[0].cumulativeAbnormalReturn, 0);
  assert.equal(result[1].cumulativeAbnormalReturn, null);
});

test('negative beta is inverse, not defensive or low risk; uncertainty overrides directional conclusions', () => {
  const data = sample();
  data.estimates.market_model.beta = -2;
  data.estimates.market_model.beta_confidence_interval95 = [-3, -1];
  assert.match(metric(data, 'market_beta').reading, /opposite/);
  assert.doesNotMatch(metric(data, 'market_beta').reading, /Defensive/);
  data.estimates.market_model.beta_confidence_interval95 = [-3, 1];
  assert.match(metric(data, 'market_beta').reading, /includes zero/);
});

test('R², sector sign, asymmetry, and event scale carry explicit interpretive limits', () => {
  const data = sample();
  assert.match(metric(data, 'r_squared').reading, /30.0%.*70.0%/);
  assert.match(metric(data, 'r_squared').caution, /not prediction accuracy/);
  assert.match(metric(data, 'sector').reading, /negative sign.*inverse/);
  assert.match(metric(data, 'sector').caution, /no confidence interval/);
  assert.match(metric(data, 'asymmetry').caution, /No joint test/);
  assert.match(metric(data, 'event_z').caution, /not a calibrated significance test/);
});

test('relative filing strength does not claim an absolute improvement, and gap zero is not neutral evidence', () => {
  const data = sample();
  const component = { key: 'operatingMargin', current: 8, prior: 10, change: -2, peer_percentile: 80 };
  assert.match(filingComponentReading(component).reading, /fell by 2.0 percentage points/);
  assert.match(metric(data, 'filing_score').caution, /deterioration/);
  const result = evidenceReading({ available: true, evidence_gap: 0, inputs: { filing_change_z: -2, price_response_z: -2 } });
  assert.match(result.label, /Below-peer.*negative/);
  assert.match(result.reading, /both inputs are positive or both are negative/);
});

test('withheld, partial, and stale results do not imply available metrics are zero', () => {
  const data = sample();
  data.status = 'withheld';
  assert.equal(metric(data, 'market_beta').value, 'Unavailable');
  assert.equal(metric(data, 'influence').value, 'Unavailable');
  assert.match(buildFactorReadingGuide(data).summary[0], /Missing is not zero/);
  data.status = 'partial';
  data.edgar_snapshot.available = false;
  data.evidence_gap.available = false;
  data.filing_event.windows['20'] = null;
  assert.equal(metric(data, 'market_beta').value, '1.20');
  assert.equal(metric(data, 'evidence_gap').value, 'Unavailable');
  assert.ok(buildFactorReadingGuide(data).checks.length >= 2);
  data.cache_status = 'stale';
  assert.match(buildFactorReadingGuide(data).checks[0], /retained data/);
});

test('AI and export reading guide matches page text, preserves the snapshot, and satisfies the published contract', () => {
  const data = sample();
  data.snapshot_id = 'original';
  const before = JSON.stringify(data);
  const result = withFactorReadingGuide(data);
  assert.equal(JSON.stringify(data), before);
  assert.equal(result.snapshot_id, 'original');
  assert.deepEqual(result.reading_guide, buildFactorReadingGuide(data));
  assert.equal(result.interpretation, result.reading_guide.summary.join(' '));
  assert.match(result.evidence_gap.classification.label, /Above-peer/);
  const schema = JSON.parse(readFileSync(new URL('../public/schemas/market-signals-v1.schema.json', import.meta.url), 'utf8'));
  const require = createRequire(import.meta.url);
  const Ajv = require('ajv');
  const validate = new Ajv().compile(schema.properties.reading_guide);
  assert.equal(validate(result.reading_guide), true, JSON.stringify(validate.errors));
  for (const row of result.reading_guide.metrics) {
    assert.ok(row.meaning && row.reading && row.caution);
    assert.doesNotMatch(JSON.stringify(row), /undefined|NaN|Infinity/);
  }
});
