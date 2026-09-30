import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, classifyTrajectory } from '../src/utils/riskAnalysis.js';
import { riskCashLabel, riskCashPoint, riskComparisonIssue, RISK_DEBT_SCOPE_NOTE } from '../src/utils/riskFinancialScope.js';
import { buildRiskResearchModel } from '../src/app/risk/riskResearchModel.js';
import { buildRiskFundingPresentation } from '../src/app/risk/riskFundingPresentation.js';
import { riskMetricComparison } from '../src/app/risk/riskProfilePresentation.js';
import { decorateRiskProfile, RISK_CACHE_VERSION, RISK_VERSION } from '../src/utils/riskWorkspace.js';

const fact = (val, tag, year = 2025, duration = true) => ({ val, end: `${year}-12-31`, ...(duration ? { start: `${year}-01-01` } : {}),
  fy: year, fp: 'FY', form: '10-K', filed: `${year + 1}-02-01`, accn: `0000000001-${String(year + 1).slice(2)}-000001`, tag });
const fixture = (additional = {}) => ({ 'us-gaap': Object.fromEntries(Object.entries({
  Revenues: [fact(500, 'Revenues')], NetIncomeLoss: [fact(30, 'NetIncomeLoss')],
  Assets: [fact(100, 'Assets', 2025, false)], NetCashProvidedByUsedInOperatingActivities: [fact(100, 'NetCashProvidedByUsedInOperatingActivities')], ...additional,
}).map(([tag, values]) => [tag, { units: { USD: values } }])) });
const source = (tag, year = 2025) => ({ tag, taxonomy: 'us-gaap', unit: 'USD', end: `${year}-12-31`, accession: `0000000001-${String(year + 1).slice(2)}-000001`, value: 10 });

test('productive-asset purchases fill capital spending without claiming PP&E-only scope', () => {
  const facts = fixture({ PaymentsToAcquireProductiveAssets: [fact(120, 'PaymentsToAcquireProductiveAssets')] });
  const profile = assessRisk(facts, 3571, '0000000001');
  const capital = profile.reportedFlows.capitalExpenditure.at(-1);
  assert.equal(capital.value, 120);
  assert.equal(capital.sources[0].tag, 'PaymentsToAcquireProductiveAssets');
  assert.equal(capital.sources[0].label, 'Cash productive-asset purchases');
  assert.match(capital.sources[0].scopeNote, /may include intangible assets/);
  const model = buildRiskResearchModel(profile, { sic: 3571 });
  const cash = model.drivers.flatMap(driver => driver.metrics).find(metric => metric.id === 'cash_after_capex');
  assert.equal(cash.value, -20);
  assert.match(cash.formula, /reported cash capital purchases/);
  assert.match(cash.note, /not complete investment spending/);
  assert.equal(buildRiskFundingPresentation(profile).history.at(-1).freeCashFlow, -20);
});

test('PP&E remains preferred, and missing, negative, zero and instant purchase facts stay distinct', () => {
  const both = fixture({ PaymentsToAcquirePropertyPlantAndEquipment: [fact(40, '')], PaymentsToAcquireProductiveAssets: [fact(80, '')] });
  assert.equal(assessRisk(both, 3571, '1').reportedFlows.capitalExpenditure.at(-1).value, 40);
  for (const input of [undefined, fact(-20, ''), fact(20, '', 2025, false)]) {
    const p = assessRisk(fixture(input ? { PaymentsToAcquireProductiveAssets: [input] } : {}), 3571, '1');
    assert.equal(p.reportedFlows.capitalExpenditure.at(-1).value, null);
  }
  assert.equal(assessRisk(fixture({ PaymentsToAcquireProductiveAssets: [fact(0, '')] }), 3571, '1').reportedFlows.capitalExpenditure.at(-1).value, 0);
});

test('known ownership and capital-purchase scope changes do not become deltas or adverse streaks', () => {
  assert.match(riskComparisonIssue({ sources: [source('ProfitLoss')] }, { sources: [source('NetIncomeLoss', 2024)] }), /income attribution/);
  assert.match(riskComparisonIssue({ sources: [source('StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest')] }, { sources: [source('StockholdersEquity', 2024)] }), /equity attribution/);
  assert.match(riskComparisonIssue({ sources: [source('PaymentsToAcquireProductiveAssets')] }, { sources: [source('PaymentsToAcquirePropertyPlantAndEquipment', 2024)] }), /capital-purchase/);
  const series = [2023, 2024, 2025].map((fy, i) => ({ fy, end: `${fy}-12-31`, kind: 'annual', value: i + 1,
    sources: [source(fy === 2025 ? 'ProfitLoss' : 'NetIncomeLoss', fy)] }));
  assert.equal(classifyTrajectory(series, true), null);
  assert.equal(riskMetricComparison({ value: 3, prior: 2, series }).delta, null);
});

test('API ratio comparisons and decorated notices reject parent-to-consolidated income switches', () => {
  const facts = fixture({ Revenues: [fact(500, '', 2025), fact(400, '', 2024)],
    NetIncomeLoss: [fact(20, '', 2024)], ProfitLoss: [fact(30, '', 2025)],
    Assets: [fact(100, '', 2025, false), fact(90, '', 2024, false)],
    NetCashProvidedByUsedInOperatingActivities: [fact(100, '', 2025), fact(80, '', 2024)] });
  const profile = decorateRiskProfile(assessRisk(facts, 3711, '1'));
  for (const id of ['net_margin', 'accruals_ratio']) {
    const metric = profile.metrics.find(item => item.id === id);
    assert.notEqual(metric.value, null);
    assert.equal(metric.prior, null);
    assert.equal(metric.delta, null);
    assert.match(metric.note, /income attribution/);
  }
});

test('narrow cash labels and selected borrowing scope stay explicit, without new cache namespaces', () => {
  assert.equal(riskCashLabel({ sources: [source('CashAndDueFromBanks')] }), 'Cash and due from banks');
  assert.equal(riskCashLabel({ sources: [source('Cash')] }), 'Cash, excluding equivalents');
  assert.equal(riskCashLabel({ sources: [source('CashAndCashEquivalentsAtCarryingValue')] }), 'Cash and equivalents');
  assert.match(RISK_DEBT_SCOPE_NOTE, /subordinated debt/);
  assert.equal(RISK_CACHE_VERSION, 'risk-workspace-v9');
  assert.equal(RISK_VERSION, 'risk-workspace-v11');
});

test('insurer adjusted operating earnings cannot enter generic operating-income or stress inputs', () => {
  const profile = assessRisk(fixture({ OperatingIncomeLoss: [fact(6137000000, 'OperatingIncomeLoss')] }), 6311, '0001099219');
  assert.equal(profile.reportedFlows.operatingIncome.at(-1).value, null);
  assert.equal(profile.stressInputs.operatingIncome.value, null);
});

test('reconstructed bank cash retains distinct gross and restricted raw-input labels', () => {
  const total = { ...source('CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'), value: 309811000000, label: 'Cash including restricted cash' };
  const restricted = { ...source('RestrictedCashAndCashEquivalents'), value: 23700000000, label: 'Restricted cash and equivalents' };
  const point = riskCashPoint({ value: 286111000000, formula: 'Cash including restricted cash − restricted cash and equivalents', sources: [total, restricted], source: total });
  assert.equal(point.label, 'Cash excluding tagged restrictions');
  assert.equal(point.sources[0].label, total.label);
  assert.equal(point.sources[1].label, restricted.label);
  assert.equal(point.sources[0].value, 309811000000);
  assert.equal(point.source.label, total.label);
});
