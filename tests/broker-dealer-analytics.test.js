import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeBrokerDealerReport, BROKER_DEALER_ANALYTICS_VERSION, brokerDealerMetricGroup } from '../src/utils/brokerDealerAnalytics.js';

const source = 'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/public.pdf';
const analyze = (text, extra = {}) => analyzeBrokerDealerReport({ documentUrl: source, reportDate: '2025-12-31', pages: [{ pageNumber: 6, text }], ...extra });
const metric = (result, id) => result.metrics.find(item => item.id === id);
const ratio = (result, id) => result.ratios.find(item => item.id === id);
const basic = `Example Broker LLC
Statement of Financial Condition
December 31, 2025
Cash and cash equivalents $ 100
Total assets $ 1,000
Total liabilities 800
Members' equity 200
Total liabilities and members' equity $ 1,000`;

test('annual statement amounts retain independent labels, period and page evidence', () => {
  const result = analyze(basic);
  assert.equal(result.version, BROKER_DEALER_ANALYTICS_VERSION);
  assert.equal(result.status, 'ready');
  assert.equal(metric(result, 'totalAssets').value, 1000);
  assert.equal(metric(result, 'totalLiabilities').value, 800);
  assert.equal(metric(result, 'totalEquity').value, 200);
  assert.equal(metric(result, 'totalAssets').source.page, 6);
  assert.equal(metric(result, 'totalAssets').source.url, source);
  assert.equal(metric(result, 'totalAssets').periodEnd, '2025-12-31');
  assert.equal(metric(result, 'totalAssets').basis, 'reported');
  assert.equal(ratio(result, 'assetsToEquity').value, 5);
  assert.equal(ratio(result, 'equityToAssets').value, 0.2);
  assert.equal(ratio(result, 'equityToAssets').format, 'percent');
  assert.equal(ratio(result, 'cashToLiabilities').value, 0.125);
  assert.equal(result.validations[0].status, 'consistent');
});

test('explicit comparative period headings map columns without selecting whichever looks plausible', () => {
  const text = `Statement of Financial Condition
December 31, 2025 and 2024
(U.S. dollars in thousands)
Cash and cash equivalents $ 100 $ 80
Total assets 1,000 900
Total liabilities 800 700
Members' equity 200 200`;
  assert.equal(metric(analyze(text), 'totalAssets').value, 1000000);
  const prior = analyze(text, { reportDate: '2024-12-31' });
  assert.equal(metric(prior, 'totalAssets').value, 900000);
  assert.equal(metric(prior, 'totalAssets').periodEnd, '2024-12-31');
  assert.equal(metric(prior, 'totalAssets').extraction.scale, 1000);
  const noColumnHeading = analyze(text.replace('December 31, 2025 and 2024', 'December 31, 2025'));
  assert.equal(noColumnHeading.metrics.length, 0);
  assert.match(noColumnHeading.coverage.rejected[0].reason, /columns/);
});

test('millions scale is evidenced locally and missing or contradictory unit and date evidence stays unavailable', () => {
  const millions = analyze(basic.replace('December 31, 2025', 'December 31, 2025\n($ in millions)'));
  assert.equal(metric(millions, 'totalAssets').value, 1e9);
  assert.equal(ratio(millions, 'assetsToEquity').value, 5);
  assert.equal(analyze(basic.replaceAll('$', '')).metrics.length, 0);
  assert.equal(analyze(basic.replace('December 31, 2025', 'December 31, 2024')).metrics.length, 0);
  assert.equal(analyze(basic.replace('December 31, 2025', '')).metrics.length, 0);
  assert.equal(analyze(basic.replace('December 31, 2025', 'December 31, 2025\n(in thousands)\n(in millions)')).metrics.length, 0);
  assert.equal(analyze(basic.replace('December 31, 2025', 'December 31, 2025\nCAD dollars')).metrics.length, 0);
});

test('negative member capital stays negative and never produces a positive-equity leverage multiple', () => {
  const result = analyze(basic.replace('liabilities 800', 'liabilities 1,200').replace("equity 200", 'equity (200)'));
  assert.equal(metric(result, 'totalEquity').value, -200);
  assert.equal(ratio(result, 'assetsToEquity'), undefined);
  assert.equal(ratio(result, 'liabilitiesToEquity'), undefined);
  assert.equal(ratio(result, 'equityToAssets').value, -0.2);
  assert.ok(result.findings.some(item => item.id === 'nonpositive-equity'));
  assert.equal(result.validations[0].status, 'consistent');
});

test('dashes, percentages, note amounts and unlabeled subtotals are not synthesized as financial totals', () => {
  const result = analyze(`Statement of Financial Condition
December 31, 2025
Cash and cash equivalents $ -
Total assets $ 1,000
Total liabilities 80%
Members' equity 200
800
Notes to financial statements
Total liabilities are approximately $800 at December 31, 2025.`);
  assert.equal(metric(result, 'cashAndEquivalents'), undefined);
  assert.equal(metric(result, 'totalLiabilities'), undefined);
  assert.equal(result.status, 'partial');
  assert.equal(ratio(result, 'cashToLiabilities'), undefined);
  assert.equal(analyze(`Notes to financial statements\nDecember 31, 2025\nTotal assets $ 1000\nTotal liabilities $800`).metrics.length, 0);
});

test('Brean public statement rows and dated capital note support financing and regulatory analysis without inventing income', () => {
  const result = analyze(`Brean Capital, LLC and Subsidiaries
Consolidated Statement of Financial Condition
December 31, 2025
Cash and cash equivalents $ 27,929,187
Securities owned, at fair value (pledged as collateral with clearing organization) 2,056,005,290
Securities purchased under agreement to resell 342,482,910
Total Assets $ 2,807,393,781
Securities sold, not yet purchased, at fair value $ 90,086,662
Securities and reverse mortgage loans sold under repurchase agreements, at fair value 1,533,858,716
Payable to broker-dealers and clearing organizations 858,787,000
Subordinated borrowing from related party 47,085,000
Total Liabilities 2,572,173,981
Members' Equity 235,219,800
The accompanying notes are an integral part of this consolidated Statement of Financial Condition`, {
    pages: [
      { pageNumber: 6, text: `Consolidated Statement of Financial Condition\nDecember 31, 2025\nCash and cash equivalents $ 27,929,187\nSecurities owned, at fair value (pledged as collateral with clearing organization) 2,056,005,290\nSecurities purchased under agreement to resell 342,482,910\nTotal Assets $ 2,807,393,781\nSecurities sold, not yet purchased, at fair value $ 90,086,662\nSecurities and reverse mortgage loans sold under repurchase agreements, at fair value 1,533,858,716\nPayable to broker-dealers and clearing organizations 858,787,000\nSubordinated borrowing from related party 47,085,000\nTotal Liabilities 2,572,173,981\nMembers' Equity 235,219,800` },
      { pageNumber: 19, text: `Net capital note\nThe regulatory ratio shall not exceed 15 to 1. At December 31, 2025, the Company had net capital of $82,525,387, which was $77,441,558 in excess of its required minimum net capital of $5,083,829. The Company's percentage of aggregate indebtedness to net capital was 92.40%.` },
    ],
  });
  assert.equal(metric(result, 'brokerPayables').value, 858787000);
  assert.equal(metric(result, 'securitiesOwned').value, 2056005290);
  assert.equal(metric(result, 'reverseRepos').value, 342482910);
  assert.equal(metric(result, 'repos').value, 1533858716);
  assert.match(metric(result, 'repos').label, /reverse mortgage loans/);
  assert.equal(metric(result, 'netCapital').value, 82525387);
  assert.equal(metric(result, 'minimumNetCapital').value, 5083829);
  assert.equal(metric(result, 'excessNetCapital').value, 77441558);
  assert.equal(metric(result, 'netCapital').source.page, 19);
  assert.equal(metric(result, 'netIncome'), undefined);
  assert.ok(result.limitations.some(item => /Profitability is unavailable/.test(item)));
  assert.ok(result.findings.some(item => item.id === 'secured-financing'));
  assert.equal(result.validations.find(item => item.id === 'net-capital-tie-out').status, 'consistent');
});

test('regulatory formulas and statutory floors cannot replace a reported period-end capital requirement', () => {
  const result = analyze(`At December 31, 2025, the Company had net capital of $20 million. The Company had required minimum net capital of $250,000 or 2% of aggregate debit items, whichever is greater.`);
  assert.equal(metric(result, 'netCapital').value, 20000000);
  assert.equal(metric(result, 'minimumNetCapital'), undefined);
  assert.equal(ratio(result, 'netCapitalToRequired'), undefined);
  const noDate = analyze('The Company had net capital of $20,000,000 and required net capital of $250,000.');
  assert.equal(noDate.metrics.length, 0);
});

test('ASL separately labeled subordinated debt reconciles explicitly without changing the reported subtotal', () => {
  const result = analyze(`Statement of Financial Condition
As of June 30, 2026
Cash and cash equivalents $ 13,624,543
Receivables from brokers, dealers, clearing organizations and others 3,837,729,501
Securities purchased under agreements to resell 29,223,522,831
Total assets $ 41,409,524,157
Payables to brokers, dealers, clearing organizations and others $ 173,962,501
Securities sold under agreements to repurchase 36,603,534,508
Total liabilities 41,201,143,006
Subordinated debt 25,006,352
41,226,149,358
Stockholder's equity 183,374,799
Total liabilities and stockholder's equity $ 41,409,524,157`, { reportDate: '2026-06-30' });
  assert.equal(metric(result, 'totalLiabilities').value, 41201143006);
  assert.equal(metric(result, 'subordinatedDebt').value, 25006352);
  assert.equal(metric(result, 'brokerReceivables').value, 3837729501);
  assert.equal(result.status, 'ready');
  assert.equal(result.validations[0].difference, 0);
  assert.equal(result.validations[0].reportedDifference, 25006352);
  assert.equal(result.validations[0].status, 'consistent');
  const adjusted = metric(result, 'adjustedTotalLiabilities');
  assert.equal(adjusted.value, 41226149358);
  assert.equal(adjusted.basis, 'calculated');
  assert.equal(adjusted.reported, false);
  assert.deepEqual(adjusted.metricIds, ['totalLiabilities', 'subordinatedDebt']);
  assert.equal(adjusted.validation.difference, 0);
  assert.equal(ratio(result, 'liabilitiesToEquity').value, 41226149358 / 183374799);
  assert.equal(ratio(result, 'cashToLiabilities').value, 13624543 / 41226149358);
  assert.deepEqual(ratio(result, 'reposToLiabilities').metricIds, ['repos', 'adjustedTotalLiabilities']);
  assert.ok(ratio(result, 'assetsToEquity'));
  assert.match(result.findings.find(item => item.id === 'separate-subordinated-debt').text, /reported subtotal is preserved/);
});

test('full public income statements stay distinct from balance sheets and net revenue stays distinct from total revenue', () => {
  const result = analyze('', { reportDate: '2026-06-30', pages: [
    { pageNumber: 5, text: `Statement of Financial Condition\nJune 30, 2026\nCash $21,798\nTotal assets $230,209\nTotal liabilities 171,486\nTotal stockholder's equity 58,723` },
    { pageNumber: 6, text: `Statement of Income\nYear Ended June 30, 2026\nSecurities commissions $41,361\nTOTAL REVENUE 1,833,891\nTOTAL EXPENSES 1,822,380\nNET INCOME $11,511` },
    { pageNumber: 12, text: 'At June 30, 2026, the Company had net capital of $36,496 which was $28,153 in excess of its required net capital of $8,343.' },
  ] });
  assert.equal(metric(result, 'netIncome').value, 11511);
  assert.equal(metric(result, 'totalRevenue').value, 1833891);
  assert.equal(metric(result, 'netRevenue'), undefined);
  assert.equal(metric(result, 'excessNetCapital').value, 28153);
  assert.deepEqual(result.coverage.disclosedStatements, ['financial-condition', 'income', 'net-capital']);
});

test('conflicting duplicates are withheld and identical supporting amounts preserve all source pages', () => {
  const duplicate = analyze('', { pages: [{ pageNumber: 4, text: basic }, { pageNumber: 7, text: basic }] });
  assert.equal(metric(duplicate, 'totalAssets').sources.length, 2);
  const conflict = analyze('', { pages: [{ pageNumber: 4, text: basic }, { pageNumber: 7, text: basic.replace('assets $ 1,000', 'assets $ 9,000') }] });
  assert.equal(metric(conflict, 'totalAssets'), undefined);
  assert.equal(ratio(conflict, 'assetsToEquity'), undefined);
  assert.ok(conflict.findings.some(item => item.id === 'conflicting-extraction'));
});

test('segregated cash is not added to liquid cash and comparative rows require all matching columns', () => {
  const result = analyze(basic.replace('Total assets', 'Cash segregated under federal regulations $ 500\nTotal assets'));
  assert.equal(metric(result, 'segregatedCash').value, 500);
  assert.equal(ratio(result, 'cashToLiabilities').value, 0.125);
  assert.ok(result.findings.some(item => item.id === 'segregated-cash'));
  assert.equal(analyze(basic.replace('December 31, 2025', 'December 31, 2025 and 2024')).metrics.length, 0);
});

test('image-only and corrupted financial pages do not become financial coverage merely because cover text exists', () => {
  const scan = analyze('', { pages: [{ pageNumber: 1, text: '' }, { pageNumber: 2, text: '' }] });
  assert.equal(scan.status, 'unavailable');
  assert.equal(scan.coverage.pagesWithText, 0);
  assert.match(scan.limitations.join(' '), /OCR or manual review/);
  const cover = analyze('Broker dealer annual report\nX-17A-5\nPublic statement of financial condition');
  assert.equal(cover.status, 'unavailable');
  assert.equal(cover.coverage.disclosedStatements.length, 0);
  assert.match(cover.limitations.join(' '), /damaged text encoding/);
});

test('OCR numeric confidence gates apply to rows and reporting dates, with explicit source provenance', () => {
  const lines = basic.split('\n').map(text => ({ text, numericConfidence: 95, usableForNumbers: true }));
  const good = analyze('', { pages: [{ pageNumber: 4, method: 'ocr', ocrConfidence: 94, lines }] });
  assert.equal(good.status, 'ready');
  assert.equal(metric(good, 'totalAssets').source.method, 'ocr');
  assert.equal(metric(good, 'totalAssets').confidence, 'medium');
  assert.match(metric(good, 'totalAssets').extraction.method, /^ocr-/);
  const badRow = lines.map(line => line.text.startsWith('Total assets') ? { ...line, numericConfidence: 55, usableForNumbers: false } : line);
  assert.equal(metric(analyze('', { pages: [{ method: 'ocr', ocrConfidence: 90, lines: badRow }] }), 'totalAssets'), undefined);
  const badDate = lines.map(line => line.text.startsWith('December') ? { ...line, numericConfidence: 60, usableForNumbers: false } : line);
  assert.equal(analyze('', { pages: [{ method: 'ocr', ocrConfidence: 90, lines: badDate }] }).metrics.length, 0);
  assert.equal(analyze('', { pages: [{ method: 'ocr', ocrConfidence: 60, lines }] }).metrics.length, 0);
});

test('dated net-capital disclosures apply their own units rather than carrying scale from another page', () => {
  const result = analyze('', { pages: [
    { pageNumber: 1, text: basic.replace('December 31, 2025', 'December 31, 2025\n($ in millions)') },
    { pageNumber: 2, text: 'At December 31, 2025, the Company had net capital of $20,000,000 and required net capital of $250,000.' },
  ] });
  assert.equal(metric(result, 'totalAssets').value, 1000000000);
  assert.equal(metric(result, 'netCapital').value, 20000000);
  const local = analyze('Notes to financial statements\n($ in thousands)\nAt December 31, 2025, the Company had net capital of $20,000 and required net capital of $250.');
  assert.equal(metric(local, 'netCapital').value, 20000000);
});

test('cash-flow totals are mapped only from their own statement, with signed values and no capex aggregation', () => {
  const result = analyze(`Statement of Cash Flows
Year Ended December 31, 2025
Net income $ 11,511
Depreciation expense 3,283
Net cash provided by operating activities 4,338
Net cash provided by (used in) investing activities (3,123)
Net cash used in financing activities (100)
Net change in cash 1,115
Cash at end of year $ 21,698`);
  assert.equal(metric(result, 'operatingCashFlow').value, 4338);
  assert.equal(metric(result, 'investingCashFlow').value, -3123);
  assert.equal(metric(result, 'financingCashFlow').value, -100);
  assert.equal(metric(result, 'changeInCash').value, 1115);
  assert.equal(metric(result, 'netIncome'), undefined);
  assert.equal(metric(result, 'cashAndEquivalents'), undefined);
  assert.deepEqual(result.coverage.disclosedStatements, ['cash-flows']);
  const withoutTotal = analyze(`Statement of Cash Flows\nYear Ended December 31, 2025\nNet income $11,511\nPurchase of property and equipment (3,123)\nNet cash provided by operating activities 4,338`);
  assert.equal(metric(withoutTotal, 'investingCashFlow'), undefined);
});

test('amendments explain standalone scope and partial document extraction cannot be labeled ready', () => {
  const amended = analyze(basic, { form: 'X-17A-5/A' });
  assert.match(amended.limitations.join(' '), /does not merge missing amounts/);
  const partial = analyze(basic, { extraction: { pageCount: 40, pagesRead: 25 } });
  assert.equal(partial.status, 'partial');
  assert.equal(metric(partial, 'totalAssets').value, 1000);
  assert.match(partial.limitations.join(' '), /covered only part/);
});


test('actual ASL June 2026 public filing maps statement detail, capital and dated notes with separate evidence', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/broker-dealer-asl-june2026.json', import.meta.url)));
  const result = analyzeBrokerDealerReport({ ...fixture, documentUrl: fixture.source });
  const expected = {
    totalAssets: 41409524157, totalLiabilities: 41201143006, adjustedTotalLiabilities: 41226149358,
    totalEquity: 183374799, subordinatedDebt: 25006352, cashAndEquivalents: 13624543,
    securitiesOwned: 8323647433, securitiesSoldShort: 4418045014, reverseRepos: 29223522831,
    repos: 36603534508, brokerReceivables: 3837729501, brokerPayables: 173962501,
    fixedAssets: 672294, otherAssets: 10327555, parentPayables: 849004, accountsPayableAndAccruedExpenses: 4751979,
    netCapital: 162760952, minimumNetCapital: 250000, excessNetCapital: 162510952,
    ficcReceivables: 349375797, cmeReceivables: 10012868, treasurySecuritiesOwned: 8177381228,
    gseSecuritiesOwned: 146266205, treasurySecuritiesSoldShort: 4413683891,
    collateralReceivedReusable: 111800000000, forwardReverseRepos: 51400000000, forwardRepos: 32800000000,
    dividendsPaid: 30000361,
  };
  for (const [id, value] of Object.entries(expected)) {
    assert.equal(metric(result, id)?.value, value, id);
    assert.equal(metric(result, id).source.url, fixture.source);
    assert.equal(metric(result, id).periodEnd, '2026-06-30');
  }
  assert.equal(result.metrics.length, 28);
  assert.equal(result.ratios.length, 13);
  assert.equal(metric(result, 'ficcReceivables').source.page, 11);
  assert.equal(metric(result, 'ficcReceivables').statement, 'notes');
  assert.equal(metric(result, 'forwardReverseRepos').source.page, 18);
  assert.equal(metric(result, 'fixedAssets').source.page, 6);
  assert.equal(metric(result, 'fixedAssets').section, 'assets');
  assert.equal(metric(result, 'netCapital').statement, 'net-capital');
  assert.equal(metric(result, 'netIncome'), undefined);
  assert.equal(metric(result, 'operatingCashFlow'), undefined);
  assert.equal(metric(result, 'segregatedCash'), undefined);
  assert.equal(brokerDealerMetricGroup('adjustedTotalLiabilities'), 'balance');
  assert.equal(brokerDealerMetricGroup('dividendsPaid'), 'notes');
  assert.equal(result.coverage.disclosedStatements.includes('income'), false);
  assert.equal(result.coverage.disclosedStatements.includes('cash-flows'), false);
  assert.equal(ratio(result, 'cashToAssets').value, 13624543 / 41409524157);
  assert.equal(ratio(result, 'reposToLiabilities').value, 36603534508 / 41226149358);
});

test('separate subordinated debt must reconcile same-page totals and cannot hide an unresolved discrepancy', () => {
  const separate = basic.replace('Total liabilities 800', 'Total liabilities 750\nSubordinated debt 50');
  assert.equal(metric(analyze(separate), 'adjustedTotalLiabilities').value, 800);
  const discrepancy = analyze(separate.replace('Subordinated debt 50', 'Subordinated debt 49'));
  // One dollar is inside explicit dollar rounding tolerance; larger errors stay withheld.
  assert.equal(metric(discrepancy, 'adjustedTotalLiabilities').value, 799);
  const mismatch = analyze(separate.replace('Subordinated debt 50', 'Subordinated debt 47'));
  assert.equal(metric(mismatch, 'adjustedTotalLiabilities'), undefined);
  assert.equal(mismatch.validations[0].status, 'mismatch');
  assert.equal(ratio(mismatch, 'cashToLiabilities'), undefined);
  const alreadyIncluded = analyze(basic.replace('Total liabilities 800', 'Subordinated debt 50\nTotal liabilities 800'));
  assert.equal(metric(alreadyIncluded, 'adjustedTotalLiabilities'), undefined);
  assert.equal(ratio(alreadyIncluded, 'liabilitiesToEquity').value, 4);
  const separatePages = analyze('', { pages: [
    { pageNumber: 1, text: basic.replace('Total liabilities 800', 'Total liabilities 750') },
    { pageNumber: 2, text: 'Statement of Financial Condition\nDecember 31, 2025\nSubordinated debt $50' },
  ] });
  assert.equal(metric(separatePages, 'adjustedTotalLiabilities'), undefined);
});

test('notes respect report dates, explicit amounts, foreign currency and OCR numeric gates', () => {
  const note = 'At December 31, 2025, amounts due from FICC of $10 million were outstanding.';
  assert.equal(metric(analyze(note), 'ficcReceivables').value, 10000000);
  assert.equal(metric(analyze(`Notes to financial statements\n(Amounts in thousands)\n${note.replace('$10 million', '$500')}`), 'ficcReceivables').value, 500000);
  assert.equal(metric(analyze(`Notes to financial statements\n(Amounts in thousands)\n(Amounts in millions)\n${note}`), 'ficcReceivables'), undefined);
  assert.equal(metric(analyze(note.replace('2025', '2024')), 'ficcReceivables'), undefined);
  assert.equal(metric(analyze(note.replace('At December 31, 2025, ', '')), 'ficcReceivables'), undefined);
  assert.equal(metric(analyze(note.replace('$10 million', 'CAD $10 million')), 'ficcReceivables'), undefined);
  assert.equal(metric(analyze(note.replace('$10 million', '$10 million in 2024 and at December 31, 2023')), 'ficcReceivables'), undefined);
  const ocr = analyze('', { pages: [{ method: 'ocr', ocrConfidence: 94, lines: [{ text: note, numericConfidence: 65, usableForNumbers: false }] }] });
  assert.equal(metric(ocr, 'ficcReceivables'), undefined);
  const subsequent = analyze('Through January 31, 2026, the Company paid dividends of $40,000. During the year ended December 31, 2025, the Company declared and paid dividends of $10,000.');
  assert.equal(metric(subsequent, 'dividendsPaid').value, 10000);
  assert.equal(metric(subsequent, 'dividendsPaid').statement, 'notes');
});

test('expanded statement aliases preserve annual and interim duration and avoid mixed-period profit ratios', () => {
  const result = analyze(`Statement of Operations
For the year ended December 31, 2025
Interest income $100
Interest expense 20
Net revenues 80
Total expenses 40
Income before income taxes 40
Net income 30`);
  assert.equal(metric(result, 'interestIncome').value, 100);
  assert.equal(metric(result, 'totalExpenses').value, 40);
  assert.equal(metric(result, 'pretaxIncome').value, 40);
  assert.equal(metric(result, 'netIncome').statement, 'income');
  assert.equal(metric(result, 'netIncome').periodStart, '2025-01-01');
  assert.equal(metric(result, 'netIncome').durationMonths, 12);
  assert.equal(ratio(result, 'netIncomeToNetRevenue').value, 0.375);
  const mixed = analyze('', { pages: [
    { pageNumber: 1, text: 'Statement of Income\nYear ended December 31, 2025\nTotal revenue $100' },
    { pageNumber: 2, text: 'Statement of Income\nThree months ended December 31, 2025\nNet income $10' },
  ] });
  assert.equal(metric(mixed, 'netIncome').periodStart, '2025-10-01');
  assert.equal(ratio(mixed, 'netIncomeToRevenue'), undefined);
});


test('explicit loss, cash-used and decrease labels retain their negative economic sign without double inversion', () => {
  for (const amount of ['$100', '$(100)', '$-100']) {
    const income = analyze(`Statement of Income\nYear ended December 31, 2025\nNet loss ${amount}`);
    assert.equal(metric(income, 'netIncome').value, -100, amount);
    assert.match(metric(income, 'netIncome').extraction.signConvention, /loss/);
    const pretax = analyze(`Statement of Income\nYear ended December 31, 2025\nLoss before income taxes ${amount}`);
    assert.equal(metric(pretax, 'pretaxIncome').value, -100, amount);
    const cash = analyze(`Statement of Cash Flows\nYear ended December 31, 2025\nNet cash used in operating activities ${amount}\nNet cash used in investing activities ${amount}\nNet cash used in financing activities ${amount}\nNet decrease in cash ${amount}`);
    for (const id of ['operatingCashFlow', 'investingCashFlow', 'financingCashFlow', 'changeInCash']) assert.equal(metric(cash, id).value, -100, `${id}: ${amount}`);
  }
  const incomeMixed = analyze('Statement of Income\nYear ended December 31, 2025\nNet income (loss) $100');
  assert.equal(metric(incomeMixed, 'netIncome').value, 100);
  assert.equal(metric(incomeMixed, 'netIncome').extraction.signConvention, undefined);
  const lossMixed = analyze('Statement of Income\nYear ended December 31, 2025\nNet loss (income) $100');
  assert.equal(metric(lossMixed, 'netIncome').value, 100);
  const cashMixed = analyze('Statement of Cash Flows\nYear ended December 31, 2025\nNet cash provided by (used in) operating activities $100\nNet cash used in (provided by) investing activities $(100)\nNet increase (decrease) in cash $100');
  assert.equal(metric(cashMixed, 'operatingCashFlow').value, 100);
  assert.equal(metric(cashMixed, 'investingCashFlow').value, -100);
  assert.equal(metric(cashMixed, 'changeInCash').value, 100);
  for (const row of cashMixed.metrics) assert.equal(row.extraction.signConvention, undefined);
});


test('actual ASL 2025 overlapping searchable layers recover the visible balance sheet without changing digits', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/broker-dealer-asl-june2025-overlap.json', import.meta.url)));
  const result = analyzeBrokerDealerReport({ ...fixture, documentUrl: fixture.source });
  const expected = {
    totalAssets: 45061249894, totalLiabilities: 44870904773, totalEquity: 190345121,
    cashAndEquivalents: 18272722, securitiesOwned: 9547697011, securitiesSoldShort: 3339875022,
    reverseRepos: 35059894068, repos: 39175097982, brokerReceivables: 427952403,
    brokerPayables: 2349711092, otherAssets: 6460434, parentPayables: 2866622,
    accountsPayableAndAccruedExpenses: 3354055,
  };
  for (const [id, value] of Object.entries(expected)) {
    assert.equal(metric(result, id)?.value, value, id);
    assert.equal(metric(result, id).source.page, 6);
    assert.equal(metric(result, id).periodEnd, '2025-06-30');
  }
  assert.equal(result.validations[0].difference, 0);
  assert.equal(result.status, 'ready');
  assert.equal(ratio(result, 'assetsToEquity').value, 45061249894 / 190345121);
  const conflict = structuredClone(fixture);
  const assets = conflict.pages[0].lines.find(row => row.text.startsWith('Total assets'));
  assets.items.find(item => item.text === '45,061,249.894').text = '45,061,249.895';
  assert.equal(metric(analyzeBrokerDealerReport(conflict), 'totalAssets'), undefined);
  assert.equal(ratio(analyzeBrokerDealerReport(conflict), 'assetsToEquity'), undefined);
});

test('overlap cleanup preserves separate comparative columns and rejects ambiguous punctuation or signs', () => {
  const row = (label, a, b, positions = [400, 500]) => ({
    text: `${label} ${a} ${b}`,
    items: [
      { text: label, x: 40, y: 600, width: 180 },
      { text: a, x: positions[0], y: 600, width: 50 },
      { text: b, x: positions[1], y: 600, width: 45 },
    ],
  });
  const analyzeRows = (heading, rows) => analyze('', { pages: [{ method: 'native', lines: [
    { text: 'Statement of Financial Condition' }, { text: heading }, { text: 'Amounts in U.S. dollars' }, ...rows,
  ] }] });
  const comparative = analyzeRows('December 31, 2025 and 2024', [row('Total assets', '1,000', '1,000')]);
  assert.equal(metric(comparative, 'totalAssets').value, 1000);
  const exactOverlay = analyzeRows('December 31, 2025', [row('Total assets', '1,000', '1,000', [400, 401])]);
  assert.equal(metric(exactOverlay, 'totalAssets').value, 1000);
  const ambiguous = analyzeRows('December 31, 2025', [row('Total assets', '1,000', '1.000', [400, 401])]);
  assert.equal(metric(ambiguous, 'totalAssets'), undefined);
  const signConflict = analyzeRows('December 31, 2025', [row("Members' equity", '1,000', '(1,000)', [400, 401])]);
  assert.equal(metric(signConflict, 'totalEquity'), undefined);
  for (const negativeOverlay of ['1,000-', '1,000−', '1,000)', '1,000—']) {
    const trailingSign = analyzeRows('December 31, 2025', [row("Members' equity", '1,000', negativeOverlay, [400, 401])]);
    assert.equal(metric(trailingSign, 'totalEquity'), undefined, negativeOverlay);
  }
  const unicodeSignConflict = analyzeRows('December 31, 2025', [{
    text: "Members' equity Members' equity 1,000 −1,000",
    items: [
      { text: "Members' equity", x: 40, y: 600, width: 150 },
      { text: "Members'", x: 40.2, y: 599.88, width: 70 },
      { text: 'equity', x: 115, y: 599.88, width: 65 },
      { text: '1,000', x: 400, y: 600, width: 50 },
      { text: '−1,000', x: 400.2, y: 599.88, width: 45 },
    ],
  }]);
  assert.equal(metric(unicodeSignConflict, 'totalEquity'), undefined);
});
