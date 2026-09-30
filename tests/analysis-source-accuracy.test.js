import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAnalysisCompany, packAnalysisCompany, unpackAnalysisCompany } from '../src/utils/analysisResearch.js';
import { reportingPeriods, selectFinancialFact } from '../src/utils/xbrlPeriods.js';

// Reduced, unchanged SEC observations. The primary filing has 3-, 6- and
// 12-month cash-flow columns; the latter must never establish the YTD start.
const amazon = JSON.parse(fs.readFileSync(new URL('./fixtures/analysis-amzn-sec-facts.json', import.meta.url)));
const at = (data, key) => data.metrics[key]?.[0];
const label = (data, key) => data.definitions.find((definition) => definition.key === key)?.label;

test('Amazon primary-filing annual, quarter, YTD and TTM columns remain separate', () => {
  for (const [basis, start, revenue, income, cash] of [
    ['annual', '2025-01-01', 716924000000, 77670000000, 139514000000],
    ['quarter', '2026-04-01', 200606000000, 62647000000, 45387000000],
    ['ytd', '2026-01-01', 382125000000, 92902000000, 71419000000],
    ['ttm', '2025-07-01', 775680000000, 135281000000, 161403000000],
  ]) {
    const data = buildAnalysisCompany(amazon, { basis, latestOnly: true });
    assert.equal(data.periods[0].start, start, basis);
    assert.equal(at(data, 'revenue').value, revenue, basis);
    assert.equal(at(data, 'netIncome').value, income, basis);
    assert.equal(at(data, 'operatingCashFlow').value, cash, basis);
    assert.ok(Math.abs(at(data, 'netMargin').value - income / revenue * 100) < 1e-10);
    const restored = unpackAnalysisCompany(packAnalysisCompany(data));
    for (const key of Object.keys(data.metrics)) {
      assert.equal(at(restored, key).value, at(data, key).value);
      assert.deepEqual(at(restored, key).sources, at(data, key).sources);
      assert.deepEqual(at(restored, key).calculations, at(data, key).calculations || []);
    }
  }
});

test('Amazon YTD ratios use January opening balances and the six-month annualization', () => {
  const data = buildAnalysisCompany(amazon, { basis: 'ytd', latestOnly: true });
  const averageAssets = (818042000000 + 1095689000000) / 2;
  const averageEquity = (411065000000 + 551620000000) / 2;
  assert.equal(at(data, 'averageAssets').value, averageAssets);
  assert.equal(at(data, 'averageEquity').value, averageEquity);
  assert.ok(Math.abs(at(data, 'roe').value - 92902000000 / averageEquity * 365 / 181 * 100) < 1e-10);
  assert.ok(Math.abs(at(data, 'roa').value - 92902000000 / averageAssets * 365 / 181 * 100) < 1e-10);
  assert.ok(at(data, 'roe').sources.some((source) => source.end === '2025-12-31' && !source.start));
  assert.ok(!at(data, 'roe').sources.some((source) => source.end === '2025-06-30'));
});

test('fiscal-start correction applies to prior Amazon reporting seasons and filing cutoffs', () => {
  for (const [asOf, end, start] of [
    ['2026-05-15', '2026-03-31', '2026-01-01'],
    ['2025-11-15', '2025-09-30', '2025-01-01'],
    ['2025-08-15', '2025-06-30', '2025-01-01'],
  ]) {
    const data = buildAnalysisCompany(amazon, { basis: 'ytd', asOf, latestOnly: true });
    assert.equal(data.periods[0].end, end);
    assert.equal(data.periods[0].start, start);
    assert.ok(at(data, 'netIncome').sources.every((source) => source.start === start && source.filed <= asOf));
  }
});

const entry = (val, start, end, fp = 'Q2', extra = {}) => ({
  val, ...(start ? { start } : {}), end, fp, fy: 2026, form: '10-Q',
  filed: '2026-08-01', accn: '0000000001-26-000001', ...extra,
});
const facts = (tags) => ({ 'us-gaap': Object.fromEntries(Object.entries(tags).map(([tag, values]) => [tag, { units: { USD: values } }])) });

test('non-calendar 52-week fiscal starts retain reported dates and ignore trailing years', () => {
  const observations = facts({ NetIncomeLoss: [
    entry(30, '2025-09-01', '2026-05-10', 'Q3'),
    entry(10, '2026-02-16', '2026-05-10', 'Q3'),
    entry(40, '2025-05-12', '2026-05-10', 'Q3'),
  ] });
  assert.equal(reportingPeriods(observations, 'quarter')[0].fiscalStart, '2025-09-01');
});

test('a saved wrong fiscal start or absent cumulative column cannot turn TTM into YTD', () => {
  const observations = facts({ NetIncomeLoss: [entry(100, '2025-07-01', '2026-06-30')] });
  assert.equal(reportingPeriods(observations, 'quarter')[0].fiscalStart, null);
  assert.equal(selectFinancialFact(observations, ['NetIncomeLoss'], {
    kind: 'ytd', fp: 'Q2', end: '2026-06-30', fiscalStart: '2025-07-01', start: '2025-07-01',
  }), null);
  assert.equal(selectFinancialFact(observations, ['NetIncomeLoss'], { kind: 'ytd', fp: 'Q2', end: '2026-06-30' }), null);
});

const annual = (val, instant = false) => entry(val, instant ? null : '2025-01-01', '2025-12-31', 'FY', {
  fy: 2025, form: '10-K', filed: '2026-02-01',
});
const company = (tags, sic) => ({ ticker: 'TEST', cik: '1', sic,
  facts: facts({ Assets: [annual(1000, true)], StockholdersEquity: [annual(200, true)], NetIncomeLoss: [annual(20)], ...tags }) });

test('bank cash-and-due-from-banks never claims to include separately reported deposits or equivalents', () => {
  const data = buildAnalysisCompany(company({ CashAndDueFromBanks: [annual(24720, true)],
    InterestBearingDepositsInBanks: [annual(285091, true)],
    CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: [annual(309811, true)] }, 6021));
  assert.equal(at(data, 'cash').value, 24720);
  assert.equal(label(data, 'cash'), 'Cash and due from banks');
  assert.match(at(data, 'cash').sources[0].scopeNote, /Separately reported interest-bearing deposits/);
  assert.equal(at(data, 'cashAssets').value, 2472);
});

test('narrow cash and true combined cash each retain an accurate label', () => {
  for (const [tag, expected] of [['Cash', 'Cash, excluding equivalents'], ['CashAndCashEquivalentsAtCarryingValue', 'Cash and equivalents']]) {
    const data = buildAnalysisCompany(company({ [tag]: [annual(50, true)] }, 3571));
    assert.equal(label(data, 'cash'), expected);
    assert.equal(at(data, 'cash').value, 50);
  }
});

test('insurer OperatingIncomeLoss tagging cannot masquerade as comparable GAAP operating earnings', () => {
  const data = buildAnalysisCompany(company({ OperatingIncomeLoss: [annual(1604)] }, 6311));
  assert.equal(data.metrics.operatingIncome, undefined);
  assert.equal(label(data, 'operatingIncome'), undefined);
  assert.equal(at(data, 'netIncome').value, 20);
});

test('reported debt subtotals do not claim comprehensive obligations or blindly add overlapping subordinated debt', () => {
  const data = buildAnalysisCompany(company({ LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [annual(14244, true)],
    ShortTermBorrowings: [annual(460, true)], SubordinatedDebt: [annual(5144, true)] }, 6311));
  assert.equal(at(data, 'totalDebt').value, 14704);
  assert.equal(label(data, 'totalDebt'), 'Selected reported debt');
  assert.ok(at(data, 'totalDebt').sources.every((source) => /not a complete measure/.test(source.scopeNote)));
});

test('statement and public-summary changes share scope protection without breaking same-period bridges', async () => {
  const { analysisChange } = await import('../src/utils/analysisResearch.js');
  const point = (tag, year, unit = 'USD') => ({ value: 10,
    period: { kind: 'annual', fp: 'FY', start: `${year}-01-01`, end: `${year}-12-31` },
    sources: [{ taxonomy: 'us-gaap', tag, unit, value: 10, start: `${year}-01-01`, end: `${year}-12-31` }],
  });
  assert.equal(analysisChange(point('NetIncomeLoss', 2025), point('ProfitLoss', 2024), 'currency').delta, null);
  assert.equal(analysisChange(point('Revenues', 2025), point('Revenues', 2024, 'EUR'), 'currency').delta, null);
  assert.equal(analysisChange(point('RevenueFromContractWithCustomerExcludingAssessedTax', 2025), point('Revenues', 2024), 'currency').delta, 0);
  assert.equal(analysisChange(point('NetIncomeLoss', 2025), point('ProfitLoss', 2025), 'currency').delta, 0);
});

test('Q3 cannot relabel a trailing six-month column as fiscal YTD when nine months are absent', () => {
  const observations = facts({ NetIncomeLoss: [
    entry(60, '2026-04-01', '2026-09-30', 'Q3', { filed: '2026-11-01' }),
    entry(30, '2026-07-01', '2026-09-30', 'Q3', { filed: '2026-11-01' }),
  ] });
  assert.equal(reportingPeriods(observations, 'quarter')[0].fiscalStart, null);
  assert.equal(selectFinancialFact(observations, ['NetIncomeLoss'], { kind: 'ytd', fp: 'Q3', end: '2026-09-30' }), null);
});

test('a contradictory filing fiscal label needs a prior annual anchor plus two reported fiscal-start concepts', () => {
  // GE's actual Q1 2020 accession carries erroneous FY2019/Q3 DEI metadata.
  // https://www.sec.gov/Archives/edgar/data/40545/000004054520000021/ge1q202010-q.htm
  const prior = entry(100, '2019-01-01', '2019-12-31', 'FY', { fy: 2019, form: '10-K',
    filed: '2020-02-24', accn: '0000040545-20-000009' });
  const incorrect = entry(10, '2020-01-01', '2020-03-31', 'Q3', { fy: 2019,
    filed: '2020-04-29', accn: '0000040545-20-000021' });
  const input = facts({ Revenues: [prior, incorrect], NetIncomeLoss: [{ ...incorrect, val: 5 }] });
  const period = reportingPeriods(input, 'quarter')[0];
  assert.equal(period.fp, 'Q1'); assert.equal(period.fy, 2020);
  assert.equal(period.start, '2020-01-01'); assert.equal(period.fiscalStart, '2020-01-01');
  assert.equal(period.fiscalMetadataCorrection.reportedFiscalPeriod, 'Q3');
  assert.equal(period.fiscalMetadataCorrection.reportedFiscalYear, 2019);
  assert.equal(period.fiscalMetadataCorrection.annualAccession, prior.accn);
  assert.deepEqual(period.fiscalMetadataCorrection.evidenceConcepts, ['NetIncomeLoss', 'Revenues']);
  input['us-gaap'].NetIncomeLoss.units.USD.push({ ...incorrect, start: '2019-12-03', val: 7 });
  assert.equal(reportingPeriods(input, 'quarter')[0].fiscalStart, '2020-01-01',
    'the proved annual boundary wins over a competing trailing 120-day column');
  assert.equal(reportingPeriods(input, 'quarter', '2020-04-28')[0].end, '2019-12-31');
  const oneConcept = facts({ Revenues: [prior, incorrect] });
  assert.equal(reportingPeriods(oneConcept, 'quarter')[0].fiscalMetadataCorrection, undefined);
  const noAnnual = facts({ Revenues: [incorrect], NetIncomeLoss: [{ ...incorrect, val: 5 }] });
  assert.equal(reportingPeriods(noAnnual, 'quarter')[0].fiscalMetadataCorrection, undefined);
  const shorterColumn = facts({ Revenues: [prior, { ...incorrect, start: '2020-07-01', end: '2020-09-30' }],
    NetIncomeLoss: [{ ...incorrect, val: 5, start: '2020-07-01', end: '2020-09-30' }] });
  assert.equal(reportingPeriods(shorterColumn, 'quarter')[0].fiscalMetadataCorrection, undefined);
});
