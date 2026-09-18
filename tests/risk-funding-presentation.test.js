import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessRisk, classifyRiskIndustry } from '../src/utils/riskAnalysis.js';
import { decorateRiskProfile } from '../src/utils/riskWorkspace.js';
import { buildRiskFundingPresentation } from '../src/app/risk/riskFundingPresentation.js';

const apple = JSON.parse(fs.readFileSync(new URL('./fixtures/apple-risk-2026-q3.json', import.meta.url))).facts;
const assess = (facts, sic = 3571, basis = 'annual') => decorateRiskProfile(assessRisk(facts, sic, 1, { basis }));
const view = (facts = apple, sic = 3571, basis = 'ttm') => buildRiskFundingPresentation(assess(facts, sic, basis), { sic });
const metric = (profile, id) => profile.metrics.find((row) => row.id === id);
const ratio = (v, id) => [...v.liquidity.ratios, ...v.obligations.ratios, ...(v.bank?.ratios || []), ...(v.broker?.ratios || [])].find((row) => row.id === id);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
function factsWith(values, flows = [], taxonomy = 'us-gaap') {
  return { [taxonomy]: Object.fromEntries(Object.entries(values).map(([tag, value]) => [tag, { units: { USD: [2024, 2025].map((fy) => ({
    val: value, end: `${fy}-12-31`, ...(flows.includes(tag) ? { start: `${fy}-01-01` } : {}), fy, fp: 'FY', form: '10-K', filed: `${fy + 1}-02-01`, accn: `0000000001-${fy - 2000}-000001`,
  })) } }])) };
}
const bank = () => factsWith({ Assets: 1000, Liabilities: 900, StockholdersEquity: 100, CashAndCashEquivalentsAtCarryingValue: 80,
  FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss: 500, FinancingReceivableAllowanceForCreditLossExcludingAccruedInterest: 20,
  FinancingReceivableRecordedInvestmentNonaccrualStatus: 10, Deposits: 800, NetIncomeLoss: 15,
  DebtSecuritiesHeldToMaturityAmortizedCostAfterAllowanceForCreditLoss: 200, HeldToMaturitySecuritiesFairValue: 160,
  InterestIncomeExpenseNet: 70, NoninterestIncome: 30, NoninterestExpense: 50, ProvisionForLoanLeaseAndOtherLosses: 5,
}, ['NetIncomeLoss', 'InterestIncomeExpenseNet', 'NoninterestIncome', 'NoninterestExpense', 'ProvisionForLoanLeaseAndOtherLosses']);
const broker = () => ({ ...factsWith({ Assets: 1000, Liabilities: 800, StockholdersEquity: 60, StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: 200,
  CashAndCashEquivalentsAtCarryingValue: 40, CashAndSecuritiesSegregatedUnderFederalAndOtherRegulations: 500, ReceivablesFromBrokersDealersAndClearingOrganizations: 120,
  SecuritiesBorrowed: 100, SecuritiesLoaned: 350, FinancialInstrumentsOwnedAtFairValue: 50, SecuritiesPurchasedUnderAgreementsToResell: 150,
}), ...factsWith({ PayablesToCustomers: 600, PayablesToBrokerDealersAndClearingOrganizations: 70 }, [], 'srt') });

test('Apple audited annual/TTM capex and distributions reconcile without quarterly/YTD mixing', () => {
  const ttm = view();
  const latest = ttm.history.at(-1);
  assert.equal(latest.capitalExpenditure, (12715 + 6799 - 9473) * 1e6);
  assert.equal(latest.freeCashFlow, 136683e6);
  assert.equal(latest.dividendsPaid, 15640e6);
  assert.equal(latest.cashAfterDividends, 121043e6);
  close(ratio(ttm, 'fcf_to_debt').value, 136683 / 84344);
  close(ratio(ttm, 'fcf_to_current_debt').value, 136683 / 13004);
  const annual = view(apple, 3571, 'annual');
  assert.equal(annual.history.at(-1).freeCashFlow, 98767e6);
  assert.equal(annual.history.at(-1).cashAfterDividends, 83346e6);
  assert.ok(ratio(ttm, 'fcf_to_debt').sources.some((source) => source.value === 6799e6));
  assert.ok(ratio(ttm, 'fcf_to_debt').sources.some((source) => source.value === 9473e6));
  assert.ok(ratio(ttm, 'fcf_to_debt').sources.every((source) => source.documentUrl && source.unit === 'USD'));
});
test('liquidity denominators keep current and noncurrent securities and borrowings separate', () => {
  const v = view();
  close(ratio(v, 'cash_current_debt').value, 39544 / 13004);
  close(ratio(v, 'liquid_current_debt').value, (39544 + 22855) / 13004);
  close(ratio(v, 'current_debt_share').value, 13004 / 84344);
  assert.ok(!ratio(v, 'liquid_current_debt').sources.some((source) => source.tag === 'MarketableSecuritiesNoncurrent'));
  assert.deepEqual(v.history.map((row) => row.end), [...v.history.map((row) => row.end)].sort());
});
test('missing capex does not become zero, and missing dividends do not block the capex bridge', () => {
  const missingCapex = structuredClone(apple);
  delete missingCapex['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment;
  const noCapex = view(missingCapex);
  assert.equal(noCapex.history.at(-1).freeCashFlow, null);
  assert.equal(ratio(noCapex, 'fcf_to_debt').value, null);
  const missingDividends = structuredClone(apple);
  missingDividends['us-gaap'].PaymentsOfDividendsCommonStock = missingDividends['us-gaap'].PaymentsOfDividends;
  delete missingDividends['us-gaap'].PaymentsOfDividends;
  const noDividends = view(missingDividends);
  assert.equal(noDividends.history.at(-1).freeCashFlow, 136683e6);
  assert.equal(noDividends.history.at(-1).cashAfterDividends, null);
});
test('negative cash-payment and instant cash-payment facts are rejected', () => {
  for (const instant of [false, true]) {
    const facts = factsWith({ Assets: 100, NetCashProvidedByUsedInOperatingActivities: 30, PaymentsToAcquirePropertyPlantAndEquipment: instant ? 10 : -10 }, instant ? ['NetCashProvidedByUsedInOperatingActivities'] : ['NetCashProvidedByUsedInOperatingActivities', 'PaymentsToAcquirePropertyPlantAndEquipment']);
    const p = assess(facts);
    assert.equal(p.reportedFlows.capitalExpenditure.at(-1).value, null);
    assert.equal(buildRiskFundingPresentation(p).history.at(-1).freeCashFlow, null);
  }
});
test('flow comparisons reject mismatched interval starts and preserve missing current dates', () => {
  const p = assess(apple, 3571, 'ttm');
  p.reportedFlows.capitalExpenditure.at(-1).start = '2026-01-01';
  let v = buildRiskFundingPresentation(p);
  assert.equal(v.history.at(-1).freeCashFlow, null);
  assert.equal(ratio(v, 'fcf_to_debt').value, null);
  p.reportedBalances.currentDebt.pop();
  v = buildRiskFundingPresentation(p);
  assert.equal(ratio(v, 'cash_current_debt').value, null);
  assert.ok(ratio(v, 'cash_current_debt').series.at(-2).value > 0);
});
test('zero denominator does not produce infinity or zero-risk coverage', () => {
  const p = assess(apple, 3571, 'ttm');
  p.reportedBalances.currentDebt.at(-1).value = 0;
  const v = buildRiskFundingPresentation(p);
  assert.equal(ratio(v, 'cash_current_debt').value, null);
  assert.equal(ratio(v, 'fcf_to_current_debt').value, null);
  assert.equal(ratio(v, 'current_debt_share').value, 0);
});
test('cash interest is separate from accrual interest and is never deducted twice', () => {
  const facts = factsWith({ Assets: 100, NetCashProvidedByUsedInOperatingActivities: 30, PaymentsToAcquirePropertyPlantAndEquipment: 10, InterestPaidNet: 5 }, ['NetCashProvidedByUsedInOperatingActivities', 'PaymentsToAcquirePropertyPlantAndEquipment', 'InterestPaidNet']);
  const p = assess(facts), v = buildRiskFundingPresentation(p);
  assert.equal(v.history.at(-1).cashInterestPaid, 5);
  assert.equal(v.history.at(-1).freeCashFlow, 20);
  assert.equal(metric(p, 'interest_coverage').value, null);
  assert.ok(v.limitations.some((line) => /net of capitalized interest/.test(line)));
});
test('bank lens links loan quality, capital, liquidity and earnings without supervisory ratings', () => {
  const p = assess(bank(), 6021), v = buildRiskFundingPresentation(p);
  assert.equal(v.lens, 'bank');
  close(ratio(v, 'bank_earnings_assets').value, 15 / 1000);
  close(ratio(v, 'bank_allowance_nonaccrual').value, 20 / 10);
  close(ratio(v, 'bank_cash_deposits').value, 80 / 800);
  close(ratio(v, 'bank_htm_gap_equity').value, -40 / 100);
  close(ratio(v, 'bank_preprovision_credit_cost').value, (70 + 30 - 50) / 5);
  assert.equal(v.history.at(-1).grossLoans, 520);
  assert.equal(v.bank.dimensions.find((dimension) => dimension.letter === 'M').metrics.length, 0);
  assert.ok(!v.obligations.ratios.some((item) => item.id === 'fcf_to_debt'));
  for (const id of ['bank_earnings_assets', 'bank_allowance_nonaccrual', 'bank_cash_deposits', 'bank_htm_gap_equity']) {
    assert.equal(metric(p, id).zone.level, 'info');
    assert.equal(metric(p, id).thresholds, null);
    assert.ok(metric(p, id).sources.length >= 2);
  }
});
test('bank missing nonaccruals remain a coverage gap rather than zero problem loans', () => {
  const facts = bank(); delete facts['us-gaap'].FinancingReceivableRecordedInvestmentNonaccrualStatus;
  const p = assess(facts, 6021), v = buildRiskFundingPresentation(p);
  assert.equal(ratio(v, 'bank_allowance_nonaccrual').value, null);
  assert.equal(v.history.at(-1).nonaccrualLoans, null);
  assert.equal(metric(p, 'bank_allowance_nonaccrual').zone.level, 'na');
});
test('broker SRT customer funding is sourced separately from segregated assets', () => {
  const p = assess(broker(), 6211), v = buildRiskFundingPresentation(p);
  assert.equal(v.lens, 'broker');
  assert.equal(v.history.at(-1).customerPayables, 600);
  assert.equal(v.history.at(-1).brokerPayables, 70);
  assert.equal(v.history.at(-1).segregatedAssets, 500);
  close(ratio(v, 'broker_cash_liabilities').value, 40 / 800);
  close(ratio(v, 'broker_equity_assets').value, 200 / 1000);
  assert.match(metric(p, 'broker_equity_assets').label, /Consolidated/);
  assert.equal(v.history.at(-1).equity, 60);
  const payable = v.broker.balances.find((row) => row.id === 'customerPayables');
  assert.equal(payable.sources[0].taxonomy, 'srt');
  assert.match(payable.sources[0].url, /\/srt\//);
  assert.ok(!ratio(v, 'broker_cash_liabilities').sources.some((source) => /Segregated/.test(source.tag)));
  assert.ok(!v.obligations.ratios.some((item) => item.id === 'fcf_to_debt'));
});
test('broker missing free cash is not replaced by restricted customer reserves', () => {
  const facts = broker(); delete facts['us-gaap'].CashAndCashEquivalentsAtCarryingValue;
  const v = buildRiskFundingPresentation(assess(facts, 6211));
  assert.equal(ratio(v, 'broker_cash_liabilities').value, null);
  assert.equal(v.history.at(-1).segregatedAssets, 500);
});
test('broker parent-equity fallback is labeled and general financial firms do not inherit the broker lens', () => {
  const facts = broker(); delete facts['us-gaap'].StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest;
  const p = assess(facts, 6211);
  assert.match(metric(p, 'broker_equity_assets').label, /Parent book equity/);
  close(metric(p, 'broker_equity_assets').value, 60 / 1000);
  assert.equal(classifyRiskIndustry(6211).isBrokerDealer, true);
  assert.equal(classifyRiskIndustry(6221).isBrokerDealer, true);
  assert.equal(classifyRiskIndustry(6282).isBrokerDealer, false);
  assert.equal(buildRiskFundingPresentation(assess(facts, 6282)).lens, 'financial');
});
