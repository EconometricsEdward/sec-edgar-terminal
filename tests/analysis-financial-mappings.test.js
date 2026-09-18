import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAnalysisCompany, commonSizePoint, packAnalysisCompany, unpackAnalysisCompany } from '../src/utils/analysisResearch.js';

const annual = (val, instant = false, extra = {}) => ({ val, ...(instant ? {} : { start: '2025-01-01' }),
  end: '2025-12-31', fy: 2025, fp: 'FY', form: '10-K', filed: '2026-02-01', accn: '0000000001-26-000001', ...extra });
const factsFor = (tags) => ({ 'us-gaap': Object.fromEntries(Object.entries(tags).map(([tag, entries]) => [tag, { units: { USD: entries } }])) });
const company = (tags = {}, sic = 3571) => ({ ticker: 'TEST', cik: '1', companyName: 'Test issuer', sic,
  facts: factsFor({ Assets: [annual(1000, true)], StockholdersEquity: [annual(400, true)],
    NetIncomeLoss: [annual(100)], Revenues: [annual(500)], CashAndCashEquivalentsAtCarryingValue: [annual(200, true)], ...tags }) });
const at = (data, key) => data.metrics[key]?.[0];
const definition = (data, key) => data.definitions.find((row) => row.key === key);

const goldman = JSON.parse(fs.readFileSync(new URL('./fixtures/analysis-gs-sec-facts.json', import.meta.url)));

test('Goldman broker revenue uses reported net-of-interest revenue across every supported basis', () => {
  for (const [basis, expected, start] of [
    ['quarter', 20338000000, '2026-04-01'], ['ytd', 37565000000, '2026-01-01'],
    ['annual', 58283000000, '2025-01-01'], ['ttm', 66203000000, '2025-07-01'],
  ]) {
    const data = buildAnalysisCompany(goldman, { basis, latestOnly: true });
    assert.equal(data.lens, 'corporate');
    assert.equal(data.businessModel, 'broker-dealer');
    assert.equal(data.revenueKey, 'revenue');
    assert.equal(data.periods[0].start, start);
    assert.equal(at(data, 'revenue').value, expected, basis);
    assert.match(definition(data, 'revenue').label, /net of interest expense/);
    assert.ok(at(data, 'revenue').sources.every((source) => source.tag === 'RevenuesNetOfInterestExpense'
      && source.unit === 'USD' && source.start && source.scopeNote && source.documentUrl.includes('/886982/')));
    assert.equal(at(data, 'netMargin').value, at(data, 'netIncome').value / expected * 100);
    assert.equal(commonSizePoint(data, 'netIncome', 0).value, at(data, 'netMargin').value);
    assert.equal(at(data, 'operatingIncome').value, null, 'pretax earnings are not operating income');
    assert.equal(at(data, 'operatingMargin').value, null);
    assert.equal(data.metrics.bankRevenue, undefined);
    const restored = unpackAnalysisCompany(packAnalysisCompany(data));
    for (const [key, values] of Object.entries(data.metrics)) {
      assert.equal(at(restored, key).value, values[0].value);
      assert.deepEqual(at(restored, key).sources, values[0].sources);
      assert.deepEqual(at(restored, key).calculations, values[0].calculations || []);
    }
  }
  const quarter = buildAnalysisCompany(goldman, { basis: 'quarter', latestOnly: true });
  assert.equal(at(quarter, 'netIncome').value, 6628000000);
  assert.equal(at(quarter, 'operatingCashFlow').value, 6105000000);
  assert.equal(at(quarter, 'interestExpense').value, 18093000000);
  assert.equal(at(quarter, 'totalDebt').value, 437874000000);
  assert.equal(at(quarter, 'shortTermDebt').value, null);
  assert.equal(at(quarter, 'longTermDebt').value, null);
  assert.equal(at(quarter, 'netReportedDebt').value, 250608000000);
});

test('Goldman filing cutoff excludes later periods and every later source', () => {
  for (const [basis, expected] of [['quarter', 17227000000], ['ttm', 60448000000]]) {
    const data = buildAnalysisCompany(goldman, { basis, asOf: '2026-05-15', latestOnly: true });
    assert.equal(data.periods[0].end, '2026-03-31');
    assert.equal(at(data, 'revenue').value, expected);
    for (const values of Object.values(data.metrics)) for (const point of values)
      assert.ok(point.sources.every((source) => source.filed <= '2026-05-15'));
  }
});

test('a bank reported net revenue total supports margins without inventing missing components', () => {
  const data = buildAnalysisCompany(company({ RevenuesNetOfInterestExpense: [annual(200)],
    InterestAndDividendIncomeOperating: [annual(900)], NoninterestExpense: [annual(80)] }, 6021));
  assert.equal(at(data, 'bankRevenue').value, 200);
  assert.equal(at(data, 'bankRevenue').classification, 'reported');
  assert.equal(at(data, 'bankNetMargin').value, 50);
  assert.equal(at(data, 'efficiency').value, 40);
  assert.equal(at(data, 'netInterestIncome').value, null);
  assert.equal(at(data, 'noninterestIncome').value, null);
  assert.equal(data.metrics.revenue, undefined);
});

test('net revenue fallback is financial-specific, USD-only and limited to actual duration facts', () => {
  const corporate = company({ Revenues: [], RevenuesNetOfInterestExpense: [annual(200)], InterestExpenseOperating: [annual(20)] });
  assert.equal(at(buildAnalysisCompany(corporate), 'revenue').value, null);
  assert.equal(at(buildAnalysisCompany(corporate), 'interestExpense').value, null);
  const financial = company({ Revenues: [], RevenuesNetOfInterestExpense: [annual(200, true)] }, 6211);
  assert.equal(at(buildAnalysisCompany(financial), 'revenue').value, null);
  financial.facts['us-gaap'].RevenuesNetOfInterestExpense.units = { EUR: [annual(200)] };
  assert.equal(at(buildAnalysisCompany(financial), 'revenue').value, null);
  financial.facts.gs = { RevenuesNetOfInterestExpense: { units: { USD: [annual(200)] } } };
  assert.equal(at(buildAnalysisCompany(financial), 'revenue').value, null, 'issuer extensions are not inferred from tag names');
});

test('noncurrent debt is reconciled from an including-current balance and complete current borrowing', () => {
  const data = buildAnalysisCompany(company({ LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [annual(40, true)],
    LongTermDebtAndCapitalLeaseObligationsCurrent: [annual(5, true)], ShortTermBorrowings: [annual(2, true)] }));
  assert.equal(at(data, 'shortTermDebt').value, 7);
  assert.equal(at(data, 'longTermDebt').value, 35);
  assert.equal(at(data, 'totalDebt').value, 42);
  assert.equal(at(data, 'debtAssets').value, 4.2);
  assert.equal(at(data, 'reportedDebtEquity').value, 10.5);
  assert.equal(at(data, 'netReportedDebt').value, -158);
  assert.ok(at(data, 'totalDebt').calculations.some((entry) => /− current maturities/.test(entry.formula)));
  assert.ok(at(data, 'totalDebt').sources.every((source) => source.scopeNote && source.end === '2025-12-31' && !source.start));
});

test('complete debt components take priority over a narrower reported combined subtotal', () => {
  const data = buildAnalysisCompany(company({ LongTermDebtCurrent: [annual(3470, true)],
    ShortTermBorrowings: [annual(10479, true)], LongTermDebtNoncurrent: [annual(36462, true)],
    DebtLongtermAndShorttermCombinedAmount: [annual(39932, true)] }));
  assert.equal(at(data, 'shortTermDebt').value, 13949);
  assert.equal(at(data, 'totalDebt').value, 50411);
  assert.equal(at(data, 'reportedDebtEquity').value, 50411 / 400 * 100);
  assert.ok(at(data, 'totalDebt').sources.some((source) => source.tag === 'ShortTermBorrowings'));
});

test('ambiguous or incomplete debt components and debt fair values do not become complete debt', () => {
  const data = buildAnalysisCompany(company({ LongTermDebt: [annual(40, true)],
    LongTermDebtCurrent: [annual(5, true)], LongTermDebtFairValue: [annual(39, true)],
    NotesAndLoansPayable: [annual(2, true)] }));
  assert.equal(at(data, 'longTermDebt').value, 35);
  assert.equal(at(data, 'shortTermDebt').value, null);
  assert.equal(at(data, 'totalDebt').value, null);
  for (const key of ['debtAssets', 'reportedDebtEquity', 'netReportedDebt']) assert.equal(at(data, key).value, null);
  const noSplit = buildAnalysisCompany(company({ LongTermDebt: [annual(40, true)] }));
  assert.equal(at(noSplit, 'longTermDebt').value, null, 'including-current total is not noncurrent');
});

test('debt components cannot reconcile across incompatible revisions or beyond the filing cutoff', () => {
  const input = company({ DebtCurrent: [annual(7, true)], LongTermDebtNoncurrent: [annual(35, true,
    { accn: '0000000001-26-000009', filed: '2026-04-01' })] });
  assert.equal(at(buildAnalysisCompany(input), 'totalDebt').value, null);
  const cutoff = buildAnalysisCompany(input, { asOf: '2026-02-15' });
  assert.equal(at(cutoff, 'longTermDebt').value, null);
  assert.equal(at(cutoff, 'totalDebt').value, null);
});

test('investment balances retain explicit scope and require filing evidence for generic classifications', () => {
  const input = company({ AvailableForSaleSecuritiesCurrent: [annual(12, true)],
    LongTermInvestments: [annual(20, true)], MarketableSecurities: [annual(99, true)],
    AvailableForSaleSecuritiesDebtMaturitiesWithinOneYearFairValue: [annual(8, true)] });
  let data = buildAnalysisCompany(input);
  assert.equal(at(data, 'shortTermInvestments').value, 12);
  assert.equal(at(data, 'longTermInvestments').value, 20);
  assert.match(at(data, 'longTermInvestments').sources[0].scopeNote, /not a cash balance/);
  delete input.facts['us-gaap'].AvailableForSaleSecuritiesCurrent;
  assert.equal(at(buildAnalysisCompany(input), 'shortTermInvestments').value, null);
  Object.assign(input.facts['us-gaap'].MarketableSecurities.units.USD[0], {
    balanceClassification: 'current', classificationEvidence: { method: 'balance-sheet-section',
      documentUrl: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm', factId: 'current-investments' },
  });
  data = buildAnalysisCompany(input);
  assert.equal(at(data, 'shortTermInvestments').value, 99);
  assert.equal(at(data, 'shortTermInvestments').sources[0].classificationEvidence.factId, 'current-investments');
});

test('total liabilities require complete reported components and never assume minority equity is zero', () => {
  const input = company({ LiabilitiesCurrent: [annual(200, true)] });
  assert.equal(at(buildAnalysisCompany(input), 'totalLiabilities').value, null);
  input.facts['us-gaap'].LiabilitiesNoncurrent = { units: { USD: [annual(350, true)] } };
  const data = buildAnalysisCompany(input);
  assert.equal(at(data, 'totalLiabilities').value, 550);
  assert.ok(Math.abs(at(data, 'liabilitiesAssets').value - 55) < 1e-10);
});

test('interest expense fallback distinguishes operating, nonoperating and interest-plus-debt scope', () => {
  for (const [sic, tag] of [[6211, 'InterestExpenseOperating'], [6798, 'InterestExpenseNonoperating'], [6311, 'InterestAndDebtExpense']]) {
    const data = buildAnalysisCompany(company({ [tag]: [annual(12)] }, sic));
    assert.equal(at(data, 'interestExpense').value, 12);
    assert.equal(at(data, 'interestExpense').sources[0].tag, tag);
    assert.ok(at(data, 'interestExpense').sources[0].scopeNote);
  }
});

test('ordinary cash dividends derive standalone quarters only from complete cumulative contexts', () => {
  const q1 = { start: '2026-01-01', end: '2026-03-31', fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-05-01', accn: '0000000001-26-000002' };
  const q2 = { ...q1, end: '2026-06-30', fp: 'Q2', filed: '2026-08-01', accn: '0000000001-26-000003' };
  const input = company({ NetIncomeLoss: [{ val: 10, ...q1 }, { val: 20, ...q2 }],
    PaymentsOfOrdinaryDividends: [{ val: 3, ...q1 }, { val: 5, ...q2 }] }, 6021);
  const data = buildAnalysisCompany(input, { basis: 'quarter' });
  assert.equal(at(data, 'dividendsPaid').value, 2);
  assert.equal(at(data, 'dividendsPaid').classification, 'calculated');
  assert.equal(at(data, 'dividendsPaid').sources.length, 2);
  assert.ok(at(data, 'dividendsPaid').sources.every((source) => /ordinary dividends/.test(source.scopeNote)));
  input.facts['us-gaap'].PaymentsOfOrdinaryDividends.units.USD = [{ val: 0, ...q2 }];
  assert.equal(at(buildAnalysisCompany(input, { basis: 'quarter' }), 'dividendsPaid').value, null);
});

test('revision links and transport preserve predecessor CIK provenance and source coverage', () => {
  const input = company({ Revenues: [annual(490, false, { sourceCik: '99' }),
    annual(500, false, { sourceCik: '99', filed: '2026-03-01', accn: '0000000099-26-000002' })] });
  input.sourceCoverage = { companyFactsThrough: '2025-12-31', notices: ['Predecessor facts retained.'] };
  const data = buildAnalysisCompany(input);
  assert.ok(at(data, 'revenue').sources[0].revisions.every((revision) => revision.documentUrl.includes('/data/99/')));
  assert.deepEqual(data.sourceCoverage, input.sourceCoverage);
  assert.deepEqual(unpackAnalysisCompany(packAnalysisCompany(data)).sourceCoverage, input.sourceCoverage);
});
