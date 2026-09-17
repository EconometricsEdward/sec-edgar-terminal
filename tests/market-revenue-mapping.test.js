import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketCompany, marketRevenuePoint, MARKET_REVENUE_VERSION } from '../src/utils/marketResearchData.js';

const period = { kind: 'annual', fp: 'FY', start: '2025-01-01', end: '2025-12-31', fiscalStart: '2025-01-01' };
const fact = (value, extra = {}) => ({ val: value, start: period.start, end: period.end, fy: 2025, fp: 'FY',
  form: '10-K', filed: '2026-02-27', accn: '0001381197-26-000062', ...extra });
const facts = values => ({ 'us-gaap': Object.fromEntries(Object.entries(values).map(([tag, value]) => [tag,
  { units: { USD: Array.isArray(value) ? value : [fact(value)] } }])) });

test('broker-dealer ratios use net revenue instead of partial ASC 606 fees', () => {
  const data = facts({ RevenueFromContractWithCustomerExcludingAssessedTax: 2_440_000_000,
    RevenuesNetOfInterestExpense: 6_205_000_000, InterestIncomeExpenseNet: 3_563_000_000,
    NoninterestIncome: 2_642_000_000, ProfitLoss: 4_357_000_000 });
  const company = buildMarketCompany({ ticker: 'IBKR', cik: '0001381197', name: 'Broker', sic: '6211', facts: data }, []);
  assert.equal(company.metrics.annual.revenue, 6_205_000_000);
  assert.ok(Math.abs(company.metrics.annual.netMargin - 4_357 / 6_205 * 100) < 1e-10);
  assert.equal(company.revenueBasis, 'Financial net revenue after interest expense');
  assert.equal(company.revenueVersion, MARKET_REVENUE_VERSION);
  delete data['us-gaap'].RevenuesNetOfInterestExpense;
  const calculated = marketRevenuePoint(data, period, '6211');
  assert.equal(calculated.value, 6_205_000_000);
  assert.equal(calculated.sources.length, 2);
  delete data['us-gaap'].NoninterestIncome;
  assert.equal(marketRevenuePoint(data, period, '6211').value, null, 'fees alone cannot replace net revenue');
});

test('financial revenue components require identical reporting contexts', () => {
  const data = facts({ InterestIncomeExpenseNet: 40,
    NoninterestIncome: [fact(20, { start: '2025-01-02' })] });
  assert.equal(marketRevenuePoint(data, period, '6021').value, null);
  assert.equal(marketRevenuePoint(data, period, '6211').value, null);
});

test('fee-only asset managers retain their reported revenue', () => {
  assert.equal(marketRevenuePoint(facts({ RevenueFromContractWithCustomerExcludingAssessedTax: 100 }), period, '6282').value, 100);
});

test('property service companies retain full ASC 606 revenue and are not treated as rental REITs', () => {
  const data = facts({ RevenueFromContractWithCustomerExcludingAssessedTax: 100 });
  for (const sic of ['6500', '6531', '6552', '6799']) assert.equal(marketRevenuePoint(data, period, sic).value, 100);
});

test('rental REITs use labelled lease revenue when a reported total is absent', () => {
  const data = facts({ OperatingLeaseLeaseIncome: 1_573_544_000,
    RevenueFromContractWithCustomerExcludingAssessedTax: 12_967_000, NetIncomeLoss: 384_462_000 });
  const company = buildMarketCompany({ ticker: 'CPT', cik: '0000906345', name: 'Rental REIT', sic: '6798', facts: data }, []);
  assert.equal(company.metrics.annual.revenue, 1_573_544_000);
  assert.ok(Math.abs(company.metrics.annual.netMargin - 384_462 / 1_573_544 * 100) < 1e-10);
  assert.equal(company.revenueBasis, 'Reported lease revenue; non-lease income excluded');
  data['us-gaap'].Revenues = { units: { USD: [fact(1_600_000_000)] } };
  assert.equal(marketRevenuePoint(data, period, '6798').value, 1_600_000_000, 'reported total precedes its rental component');
  delete data['us-gaap'].Revenues;
  delete data['us-gaap'].OperatingLeaseLeaseIncome;
  assert.equal(marketRevenuePoint(data, period, '6798').value, null, 'incidental management fees cannot substitute total rent');
});
