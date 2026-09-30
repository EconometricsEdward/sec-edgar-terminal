import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../src/utils/riskAnalysis.js';
import { decorateRiskProfile } from '../src/utils/riskWorkspace.js';

const observed = (value, end, { start, fp = 'FY', fy = Number(end.slice(0, 4)), filed = `${fy + 1}-02-15`, id = '000001' } = {}) => ({
  val: value, ...(start ? { start } : {}), end, fp, fy, filed,
  form: fp === 'FY' ? '10-K' : '10-Q', accn: `0000000001-${String(fy).slice(2)}-${id}`,
});
const concept = entries => ({ units: { USD: entries } });
function annualFacts({ claims, premiums, reserves } = {}) {
  const years = [2024, 2025];
  const balance = value => concept(years.map(year => observed(value, `${year}-12-31`)));
  const flow = value => concept(years.map(year => observed(value, `${year}-12-31`, { start: `${year}-01-01` })));
  return { 'us-gaap': {
    Assets: balance(1000), Liabilities: balance(800), StockholdersEquity: balance(200),
    NetIncomeLoss: flow(50), Revenues: flow(500),
    PremiumsEarnedNet: premiums || flow(100),
    ...(claims ? { PolicyholderBenefitsAndClaimsIncurredNet: claims } : {}),
    ...(reserves ? { LiabilityForClaimsAndClaimsAdjustmentExpense: reserves } : {}),
  } };
}
const profile = (facts, sic = 6311, basis = 'annual') => decorateRiskProfile(assessRisk(facts, sic, 1, { basis }));
const ratio = result => result.metrics.find(metric => metric.id === 'loss_ratio');

test('claim reserves never substitute for incurred claims, including a misleading duration on a reserve concept', () => {
  for (const start of [undefined, '2025-01-01']) {
    const result = profile(annualFacts({ reserves: concept([observed(900, '2025-12-31', { start })]) }));
    assert.equal(ratio(result).value, null);
    assert.equal(ratio(result).zone.level, 'na');
    assert.ok(!ratio(result).sources.some(source => source.tag === 'LiabilityForClaimsAndClaimsAdjustmentExpense'));
  }
});

test('same-date instants on claims or premiums cannot displace actual duration flows', () => {
  const result = profile(annualFacts({
    claims: concept([observed(800, '2025-12-31'), observed(80, '2025-12-31', { start: '2025-01-01' })]),
    premiums: concept([observed(1000, '2025-12-31'), observed(100, '2025-12-31', { start: '2025-01-01' })]),
    reserves: concept([observed(900, '2025-12-31')]),
  }));
  assert.equal(ratio(result).value, 0.8);
  assert.deepEqual(ratio(result).sources.map(source => [source.value, source.start, source.end]), [
    [80, '2025-01-01', '2025-12-31'], [100, '2025-01-01', '2025-12-31'],
  ]);
  const instantOnly = profile(annualFacts({
    claims: concept([observed(80, '2025-12-31', { start: '2025-01-01' })]),
    premiums: concept([observed(100, '2025-12-31')]),
  }));
  assert.equal(ratio(instantOnly).value, null);
});

test('claims and earned premiums require exactly matching actual duration boundaries', () => {
  const result = profile(annualFacts({
    claims: concept([observed(80, '2025-12-31', { start: '2025-01-02' })]),
    premiums: concept([observed(100, '2025-12-31', { start: '2025-01-01' })]),
  }));
  assert.equal(result.periods[0].end, '2025-12-31');
  assert.equal(ratio(result).value, null);
  assert.equal(ratio(result).classification, 'unavailable');
});

test('a missing latest claims flow remains unavailable while the prior-year observation is retained', () => {
  const result = profile(annualFacts({ claims: concept([observed(70, '2024-12-31', { start: '2024-01-01' })]) }));
  assert.equal(ratio(result).value, null);
  assert.deepEqual(ratio(result).series.map(point => [point.end, point.value]), [['2024-12-31', 0.7], ['2025-12-31', null]]);
  assert.equal(ratio(result).delta, null);
});

test('life, health and property/casualty claims comparisons remain contextual without generic loss-ratio screens', () => {
  for (const sic of [6311, 6321, 6331]) {
    const result = profile(annualFacts({ claims: concept([observed(120, '2025-12-31', { start: '2025-01-01' })]) }), sic);
    assert.equal(ratio(result).value, 1.2);
    assert.equal(ratio(result).zone.level, 'info');
    assert.equal(ratio(result).thresholds, null);
    assert.equal(ratio(result).trajectory, null);
    assert.ok(!result.watchItems.some(item => item.id === 'loss_ratio'));
    assert.match(ratio(result).why, /Life, health, property\/casualty and mixed insurers/);
    assert.match(ratio(result).why, /not a combined ratio, underwriting-profit conclusion/);
  }
});

test('TTM insurer claims and premiums use complete consecutive flows with their actual source inputs', () => {
  const quarters = [
    ['2024-09-30', 'Q3', 2024, 75], ['2024-12-31', 'FY', 2024, 100],
    ['2025-03-31', 'Q1', 2025, 25], ['2025-06-30', 'Q2', 2025, 50], ['2025-09-30', 'Q3', 2025, 75],
  ];
  const flows = scale => concept(quarters.map(([end, fp, fy, value], index) => observed(value * scale, end,
    { start: `${fy}-01-01`, fp, fy, id: `00000${index + 1}` })));
  const facts = { 'us-gaap': {
    Assets: concept(quarters.map(([end, fp, fy], index) => observed(1000, end, { fp, fy, id: `00000${index + 1}` }))),
    NetIncomeLoss: flows(0.5), PremiumsEarnedNet: flows(1), PolicyholderBenefitsAndClaimsIncurredNet: flows(0.8),
    LiabilityForClaimsAndClaimsAdjustmentExpense: concept([observed(900, '2025-09-30', { fp: 'Q3', fy: 2025, id: '000005' })]),
  } };
  const result = profile(facts, 6311, 'ttm');
  assert.equal(result.periods[0].end, '2025-09-30');
  assert.equal(ratio(result).value, 0.8);
  assert.ok(ratio(result).sources.some(source => source.tag === 'PolicyholderBenefitsAndClaimsIncurredNet' && source.value === 80 && source.end === '2024-12-31'));
  assert.ok(ratio(result).sources.some(source => source.tag === 'PremiumsEarnedNet' && source.value === 75 && source.end === '2024-09-30'));
  assert.ok(ratio(result).sources.every(source => source.start));
  const missing = structuredClone(facts);
  missing['us-gaap'].PolicyholderBenefitsAndClaimsIncurredNet.units.USD = missing['us-gaap'].PolicyholderBenefitsAndClaimsIncurredNet.units.USD.filter(point => point.end !== '2024-09-30');
  assert.equal(ratio(profile(missing, 6311, 'ttm')).value, null);
});
