import test from 'node:test';
import assert from 'node:assert/strict';
import { canReuseRiskWorkspace, decorateRiskProfile, riskResponseForVersion, RISK_VERSION, RISK_CACHE_VERSION } from '../src/utils/riskWorkspace.js';

const profile = values => ({ basis: 'ttm', periods: values.map((value, index) => ({ end: `202${index}-12-31` })),
  reportedFlows: { netIncome: [{ value: 100, sources: [{ tag: 'NetIncomeLoss', value: 100 }] }] },
  metrics: [{ id: 'loss_years', value: values.filter(v => v === 1).length, prior: null, delta: null,
    zone: { level: values.some(v => v === 1) ? 'high' : 'low' },
    series: values.map((value, index) => ({ value, end: `202${index}-12-31` })),
    note: 'Reported windows only; missing observations are excluded.', sources: [{ tag: 'NetIncomeLoss', value: 100 }] }],
  watchItems: [], notes: [] });

test('zero known loss windows with a missing latest observation are contextual, not a passing screen', () => {
  const result = decorateRiskProfile(profile([0, 0, null]));
  assert.equal(result.metrics[0].value, 0);
  assert.deepEqual(result.metrics[0].zone, { level: 'info', label: 'Context' });
  assert.match(result.metrics[0].note, /missing observations/);
  assert.equal(result.metrics[0].thresholds, null);
});

test('a complete zero-loss history and known losses retain their defined screening treatments', () => {
  assert.equal(decorateRiskProfile(profile([0, 0, 0])).metrics[0].zone.level, 'low');
  const known = decorateRiskProfile(profile([1, 1, 1, null]));
  assert.equal(known.metrics[0].zone.level, 'high');
  assert.equal(known.watchItems[0].id, 'loss_years');
});

test('v11 presentation upgrade preserves all numbers, original evidence and clocks without a new cache slot', () => {
  const old = { version: 'risk-workspace-v11', generatedAt: '2026-09-30T08:53:00Z', ticker: 'C',
    annual: profile([0, 0, 0]), current: profile([0, 0, null]), refinancing: null };
  const snapshot = JSON.stringify(old);
  assert.equal(canReuseRiskWorkspace(old, true), true);
  const current = riskResponseForVersion(old, RISK_VERSION);
  assert.equal(current.version, RISK_VERSION);
  assert.equal(current.current.metrics[0].zone.level, 'info');
  assert.equal(current.current.metrics[0].value, old.current.metrics[0].value);
  assert.equal(current.current.metrics[0].sources, old.current.metrics[0].sources);
  assert.equal(current.current.reportedFlows, old.current.reportedFlows);
  assert.equal(current.current.periods, old.current.periods);
  assert.equal(current.generatedAt, old.generatedAt);
  assert.equal(JSON.stringify(old), snapshot);
  assert.equal(riskResponseForVersion(old).filingScan, null);
  assert.equal(RISK_CACHE_VERSION, 'risk-workspace-v9');
  assert.equal(current.presentationCompatibility.fromVersion, 'risk-workspace-v11');
});

test('unknown and malformed previous contracts do not use the presentation adapter', () => {
  assert.equal(canReuseRiskWorkspace({ version: 'risk-workspace-v10', annual: profile([0]), current: profile([0]) }), false);
  assert.equal(canReuseRiskWorkspace({ version: 'risk-workspace-v11' }), false);
  const invalid = profile([0]); invalid.metrics[0].series = [{ value: 'zero' }];
  assert.equal(canReuseRiskWorkspace({ version: 'risk-workspace-v11', annual: invalid, current: profile([0]) }), false);
});
