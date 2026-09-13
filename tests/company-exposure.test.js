import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCompanyExposureMap, COMPANY_EXPOSURE_MAX_TEXT } from '../src/utils/companyExposure.js';

const annual = { url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000001/report.htm', accession: '0000001234-26-000001', form: '10-K', filed: '2026-02-20', reportDate: '2025-12-31' };
const quarterly = { ...annual, accession: '0000001234-26-000002', form: '10-Q', filed: '2026-08-05', reportDate: '2026-06-30' };
function extract(text, options = {}) { return extractCompanyExposureMap([{ text, filing: annual, role: 'annual' }], { ticker: 'TEST', companyName: 'Example Company Inc.', ...options }); }
const row = (result, id) => result.rows.find(item => item.id === id);

test('exact company passages identify different business channels and preserve source identity', () => {
  const text = 'The majority of the company’s equity crude production is priced based on the Brent benchmark. In the company’s downstream business, crude oil is the largest cost component of refined products. The Company is primarily exposed to fluctuations in U.S. interest rates and their impact on the Company’s investment portfolio and term debt. The Company’s primary exposure to movements in foreign exchange rates relates to non–U.S. dollar–denominated sales, cost of sales and operating expenses worldwide.';
  const result = extract(text);
  assert.ok(row(result, 'revenue:brent'));
  assert.ok(row(result, 'input-costs:crude-oil'));
  assert.ok(row(result, 'borrowing:interest-rates'));
  assert.ok(row(result, 'investments:interest-rates'));
  assert.ok(row(result, 'currencies:foreign-currencies'));
  for (const item of result.rows) for (const evidence of item.evidence) {
    assert.ok(text.includes(evidence.text));
    assert.equal(evidence.url, annual.url);
    assert.equal(evidence.accession, annual.accession);
    assert.equal(evidence.filed, annual.filed);
    assert.equal(evidence.reportDate, annual.reportDate);
    assert.deepEqual(evidence.amounts, []);
  }
});

test('generic, third-party, issuer-name, table, and denied exposures do not create rows', () => {
  const texts = [
    'Customers purchase gold to diversify their investments and reduce financial risks.',
    'Our customers purchase gold to diversify their investments and reduce financial risks.',
    'We believe the global demand for copper will increase significantly next year.',
    'Gold Bank owns a large investment portfolio and has significant interest rate exposure.',
    'We do not have any exposure to gold and do not own gold investments.',
    'We have no material exposure to natural gas purchases or price risk.',
    'Our exposure to corn purchases is not material to our costs.',
    'See Note 7 for our exposure to gold investments and related hedging activities.',
    'The company’s discussion of interest rate, foreign currency and commodity price market risk is contained in Management Discussion.',
    'Our gold loyalty card has generated sales across all markets this year.',
    'Our Scope 2 emissions include imported electricity and Scope 3 emissions include use of sold products.',
    'Gold investments\n2026\n2025\nOur total assets\n500\n600',
  ];
  for (const text of texts) {
    const result = extract(text, { companyName: 'Gold Bank Inc.' });
    assert.ok(result.rows.every(item => item.marketId !== 'gold' && item.marketId !== 'natural-gas' && item.marketId !== 'corn' && item.marketId !== 'electricity'), text);
  }
});

test('SOFR is not a ten-year rate proxy and named Treasury maturities remain distinct', () => {
  const result = extract('Our borrowings accrue interest based on SOFR and expose us to changing funding costs. Our investment portfolio includes 2-year U.S. Treasury securities that are subject to market risk. Our term debt creates interest rate risk because its interest payments change over time.');
  assert.equal(row(result, 'borrowing:sofr').benchmark.contract, '134741');
  assert.equal(row(result, 'borrowing:sofr').benchmark.fit, 'named-reference');
  assert.equal(row(result, 'investments:treasury-2y').benchmark.contract, '042601');
  assert.equal(row(result, 'borrowing:interest-rates').benchmark, null);
  assert.ok(!result.rows.some(item => item.benchmark?.contract === '043602'));
});

test('Brent, LNG, soybean oil, and different wheat classes are not silently substituted', () => {
  const result = extract('Our crude oil production is sold under prices linked to Brent. We purchase soybean oil as a raw material for our food products. Our procurement of hard red winter wheat is subject to regional commodity price changes. Our liquefied natural gas sales are linked to TTF pricing in European markets.');
  for (const id of ['revenue:brent', 'input-costs:soybean-oil', 'input-costs:other-wheat', 'revenue:lng']) assert.equal(row(result, id).benchmark, null, id);
  assert.ok(!result.rows.some(item => ['crude-oil', 'soybeans', 'wheat', 'natural-gas'].includes(item.marketId)));
});

test('benchmark fit distinguishes named reference from physical commodity proxy', () => {
  const generic = extract('We produce crude oil and sell our output to customers under long-term contracts.');
  assert.equal(row(generic, 'revenue:crude-oil').benchmark.fit, 'proxy');
  const named = extract('Our crude oil sales prices reference West Texas Intermediate under supply agreements.');
  assert.equal(row(named, 'revenue:crude-oil').benchmark.fit, 'named-reference');
  const forex = extract('Our euro-denominated sales expose us to currency movements against our reporting currency.');
  assert.equal(row(forex, 'currencies:euro').benchmark.fit, 'proxy');
  const unknown = extract('Our sales in Europe and Asia increased during the current fiscal year.');
  assert.equal(unknown.rows.length, 0);
});

test('amounts preserve exact dimensional labels and full exact source context', () => {
  const cases = [
    ['Our SOFR swaps had a notional amount of $1.2 billion and hedge interest rate risk on debt.', 'borrowing:sofr', 'notional', '$1.2 billion'],
    ['Our SOFR-linked borrowings had an outstanding balance of $ 500 million at year end.', 'borrowing:sofr', 'balance', '$ 500 million'],
    ['Our corn purchases were $25 million during the year ended December 31, 2025.', 'input-costs:corn', 'historical-activity', '$25 million'],
    ['A hypothetical 10% increase in corn prices would increase our input costs by $5 million.', 'input-costs:corn', 'sensitivity', '$5 million'],
    ['Our gold production was 500,000 ounces during the year ended December 31, 2025.', 'revenue:gold', 'volume', '500,000 ounces'],
  ];
  for (const [text, id, kind, amountText] of cases) {
    const amounts = row(extract(text), id)?.evidence[0].amounts;
    assert.deepEqual(amounts, [{ text: amountText, kind, context: text }], text);
  }
});

test('ambiguous ranges, periods, currency scope, tables, and joint-market values stay unquantified', () => {
  const texts = [
    'Our SOFR-linked borrowings were $1 billion and $2 billion at December 31, 2025 and 2024, respectively.',
    'Our SOFR-linked debt had an outstanding balance between $1 billion and $2 billion during the year.',
    'Our euro-denominated debt was EUR 1 billion and USD 2 billion under separate borrowing arrangements.',
    'Our SOFR-linked debt had an outstanding balance of $5 (amounts in millions).',
    'Our corn and wheat purchases were $25 million during the most recent fiscal year.',
    'Our corn purchases were 25 million during the most recent fiscal year.',
    'Our corn purchases increased by 25% during the year ended December 31, 2025.',
    'Our crude oil sales realized a price of $1 thousand per barrel under one unusual transaction.',
  ];
  for (const text of texts) assert.ok(extract(text).rows.every(item => item.evidence.every(evidence => evidence.amounts.length === 0)), text);
});

test('a nearby unrelated monetary number does not become the market exposure', () => {
  const result = extract('Our SOFR-linked debt exposes us to interest rate changes; our total revenue was $8 billion during the year. We buy corn for production and our total assets were $7 billion at year end.');
  assert.ok(result.rows.length > 0);
  assert.ok(result.rows.every(item => item.evidence.every(evidence => evidence.amounts.length === 0)));
});

test('latest quarterly evidence supplements annual disclosure, with independent periods and no silence inference', () => {
  const annualText = 'Our euro-denominated debt exposes us to currency fluctuations over the life of the obligations. Our gold holdings are subject to changes in market prices.';
  const quarterText = 'Our euro-denominated debt had an outstanding balance of EUR 2 billion at June 30, 2026.';
  const result = extractCompanyExposureMap([{ text: annualText, filing: annual, role: 'annual' }, { text: quarterText, filing: quarterly, role: 'quarterly' }]);
  const euro = row(result, 'currencies:euro');
  assert.equal(euro.evidence.length, 2);
  assert.equal(euro.evidence[0].role, 'quarterly');
  assert.equal(euro.evidence[0].reportDate, '2026-06-30');
  assert.equal(euro.evidence[1].reportDate, '2025-12-31');
  assert.equal(row(result, 'investments:gold').evidence.length, 1);
  assert.equal(row(result, 'investments:gold').evidence[0].role, 'annual');
});

test('best direct business evidence wins the bounded quote budget without altering quotes', () => {
  const text = 'We may sell crude oil under potential arrangements with counterparties in future years. The company sells crude oil to customers in various markets. The company’s primary exposure to crude oil is through revenue from production. The company’s largest cost component is crude oil purchased for refining.';
  const result = extract(text);
  assert.equal(row(result, 'revenue:crude-oil').evidence.length, 2);
  assert.ok(row(result, 'revenue:crude-oil').evidence.some(evidence => evidence.text.includes('primary exposure')));
  assert.ok(row(result, 'input-costs:crude-oil'));
  assert.ok(!JSON.stringify(result).includes('_score'));
});

test('bounded scanning is explicit and missing data is distinct from zero exposure', () => {
  const empty = extract('');
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.coverage.filings[0].textCharactersScanned, 0);
  const bounded = extract('x'.repeat(COMPANY_EXPOSURE_MAX_TEXT + 1));
  assert.equal(bounded.coverage.filings[0].textCharactersScanned, COMPANY_EXPOSURE_MAX_TEXT);
  assert.equal(bounded.coverage.filings[0].textTruncated, true);
  assert.equal(bounded.coverage.extractionLimited, true);
});

test('a newer explicit qualification remains traceable beside annual evidence without establishing a new exposure', () => {
  const older = 'Our copper production revenue is exposed to changes in copper prices and customer demand.';
  const newer = 'We no longer have any copper production revenue or exposure to changes in copper prices.';
  const result = extractCompanyExposureMap([{ text: older, filing: annual, role: 'annual' }, { text: newer, filing: quarterly, role: 'quarterly' }]);
  const copper = row(result, 'revenue:copper');
  assert.equal(copper.evidence[0].text, newer);
  assert.equal(copper.evidence[0].disclosureDirection, 'qualifying-or-negative');
  assert.equal(copper.evidence[0].benchmark, null);
  assert.deepEqual(copper.qualifyingEvidenceIds, [copper.evidence[0].id]);
  assert.equal(copper.evidence[1].disclosureDirection, 'connection');
  assert.equal(extract(newer).rows.length, 0);
});

test('retained evidence carries its own benchmark fit so source filters do not borrow hidden proof', () => {
  const result = extractCompanyExposureMap([
    { text: 'Our crude oil sales are priced using the WTI benchmark under customer contracts.', filing: annual, role: 'annual' },
    { text: 'Our crude oil production revenue is exposed to changes in global market prices.', filing: quarterly, role: 'quarterly' },
  ]);
  const oil = row(result, 'revenue:crude-oil');
  assert.equal(oil.benchmark.fit, 'named-reference');
  assert.equal(oil.evidence[0].role, 'quarterly');
  assert.equal(oil.evidence[0].benchmark.fit, 'proxy');
  assert.deepEqual(oil.benchmarkEvidenceIds, [oil.evidence[1].id]);
});

test('shared scales, negative qualifiers, unrelated metrics, and an afterthought scenario do not distort amount typing', () => {
  for (const text of [
    'Our SOFR-linked borrowings had balances of $5 and $10 million at year end.',
    'Our SOFR-linked borrowings had an outstanding balance of ($5 million) at year end.',
    'Our SOFR-linked borrowings had an outstanding balance of -$5 million at year end.',
    'Our SOFR-linked borrowings had balances of $5 million to 10 million at year end.',
    'Our SOFR debt exposes us to changing rates and revenue was $20 billion during the year.',
    'Our SOFR debt was $10 billion and revenue was $20 billion during the year.',
  ]) assert.ok(extract(text).rows.every(item => item.evidence.every(evidence => !evidence.amounts.length)), text);
  const history = extract('Our corn purchases were $25 million during the year and could increase in the future.');
  assert.equal(row(history, 'input-costs:corn').evidence[0].amounts[0].kind, 'historical-activity');
});

test('different commodity actions are not cross-assigned to every market in a sentence', () => {
  const result = extract('We produce crude oil and purchase natural gas for our manufacturing facilities.');
  assert.ok(row(result, 'revenue:crude-oil'));
  assert.ok(row(result, 'input-costs:natural-gas'));
  assert.ok(!row(result, 'input-costs:crude-oil'));
  assert.ok(!row(result, 'revenue:natural-gas'));
  const shared = extract('We produce and purchase natural gas for our integrated business operations.');
  assert.ok(row(shared, 'revenue:natural-gas'));
  assert.ok(row(shared, 'input-costs:natural-gas'));
});

test('physical quantities retain signs, shared scales, ranges, and reporting-period qualifications in quotes only', () => {
  const ambiguous = [
    'We produced 31 million and 29 million barrels of crude oil in 2026 and 2025, respectively.',
    'We produced 31 and 29 million barrels of crude oil during the current year.',
    'We produced 29 million barrels and 31 million of crude oil during the current year.',
    'We produced between 29 and 31 million barrels of crude oil during the current year.',
    'We produced 29–31 million barrels of crude oil during the current year.',
    'We produced 29 million barrels to 31 million of crude oil during the current year.',
    'We produced 29 million barrels of crude oil in 2026 and 2025.',
    'We produced 29 million barrels of crude oil in the current and prior years, respectively.',
    'We sold -5 million barrels of crude oil in 2026.',
    'We sold +5 million barrels of crude oil in 2026.',
    'We sold −5 million barrels of crude oil in 2026.',
    'We sold –5 million barrels of crude oil in 2026.',
    'We sold ±5 million barrels of crude oil in 2026.',
    'We sold (5 million barrels) of crude oil in 2026.',
    'We sold (approximately 5 million barrels) of crude oil in 2026.',
  ];
  for (const text of ambiguous) {
    const evidence = row(extract(text), 'revenue:crude-oil')?.evidence[0];
    assert.ok(evidence, text);
    assert.equal(evidence.text, text);
    assert.deepEqual(evidence.amounts, [], text);
  }
});

test('straightforward fully qualified physical quantities preserve positive and explicitly reported zero amounts', () => {
  for (const [text, quantity] of [
    ['We produced 29 million barrels of crude oil in 2026.', '29 million barrels'],
    ['We produced 0 barrels of crude oil during the year 2026.', '0 barrels'],
    ['We produced 0 million barrels of crude oil in 2026.', '0 million barrels'],
    ['Our gold production was 500,000 ounces during the year ended December 31, 2025.', '500,000 ounces'],
  ]) {
    const result = extract(text);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0].evidence[0].amounts, [{ text: quantity, kind: 'volume', context: text }]);
  }
});

test('Unicode monetary signs remain attached to the exact source quote rather than becoming a positive amount', () => {
  for (const sign of ['−', '–', '—']) {
    const text = `Our copper sales were ${sign}$5 million during the current year.`;
    const evidence = row(extract(text), 'revenue:copper')?.evidence[0];
    assert.ok(evidence);
    assert.equal(evidence.text, text);
    assert.deepEqual(evidence.amounts, []);
  }
});
