import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { unzipSync, strFromU8 } from 'fflate';
import { analyzeBrokerDealerReport } from '../src/utils/brokerDealerAnalytics.js';
import { classifyBrokerDealerDocument } from '../src/utils/brokerDealerClassification.js';
import { buildBrokerDealerReport } from '../src/utils/brokerDealerReport.js';
import { createCompanyReportLoader } from '../src/utils/companyReport.js';
import { enrichCompanyReportCftc } from '../src/utils/companyReportCftc.js';
import { createReportPdf, createReportXlsx } from '../src/utils/reportExports.js';
import { createPublicReportSources } from '../src/utils/reportPreviewSources.js';

const cik = '0000123456', accession = '0000123456-26-000001', end = '2025-12-31';
const generatedAt = '2026-09-21T00:00:00.000Z';
const documentUrl = `https://www.sec.gov/Archives/edgar/data/123456/${accession.replaceAll('-', '')}/annual.pdf`;
function research() {
  const filing = { accession, form: 'X-17A-5', reportDate: end, filingDate: '2026-02-27' };
  const pages = [{ pageNumber: 1, text: 'UNITED STATES SECURITIES AND EXCHANGE COMMISSION\nFORM X-17A-5\nPART III\nAnnual Report\nPeriod beginning January 1, 2025 and ending December 31, 2025' },
    { pageNumber: 3, text: 'Statement of Financial Condition\nDecember 31, 2025\nU.S. dollars in thousands\nTotal assets 10,000\nTotal liabilities 9,000\nMembers equity 1,000\nCash and cash equivalents 400\nSecurities sold under agreements to repurchase 6,000' },
    { pageNumber: 8, text: 'Computation of Net Capital\nDecember 31, 2025\nU.S. dollars in thousands\nNet capital 600\nRequired minimum net capital 100\nExcess net capital 500' }];
  const classification = classifyBrokerDealerDocument({ pages, filing, documentUrl });
  const analysis = { ...analyzeBrokerDealerReport({ ...filing, cik, name: 'Independent Securities LLC', documentUrl, pages }), classification };
  return { status: 'available', company: { cik, name: 'Independent Securities LLC' }, filing, analysis, classification,
    selectedDocument: { name: 'annual.pdf', url: documentUrl }, coverage: { complete: true } };
}

function separatelyPresentedDebtResearch() {
  const input = research();
  input.analysis = analyzeBrokerDealerReport({ cik, name: input.company.name, ...input.filing, documentUrl,
    pages: [{ pageNumber: 6, text: `Statement of Financial Condition\nDecember 31, 2025\nU.S. dollars
Cash and cash equivalents 13,624,543
Securities purchased under agreements to resell 29,223,522,831
Financial instruments owned, at fair value 8,323,647,433
Total assets 41,409,524,157
Securities sold under agreements to repurchase 36,603,534,508
Total liabilities 41,201,143,006
Subordinated debt 25,006,352
Stockholder's equity 183,374,799` }] });
  input.analysis.classification = input.classification;
  return input;
}

test('PDF-only broker-dealer report preserves exact legal identity, USD scaling and fractional ratios', () => {
  const result = buildBrokerDealerReport(research(), { generatedAt });
  assert.equal(result.entity.cik, cik);
  assert.equal(result.entity.ticker, undefined);
  assert.equal(result.period.basis, 'annual');
  assert.equal(result.summary.find(row => row.label === 'Total assets').value, 10_000_000);
  const ratios = result.sections.find(section => section.id === 'ratios').rows;
  assert.equal(ratios.find(row => row.key === 'assetsToEquity').value, 10);
  assert.equal(ratios.find(row => row.key === 'equityToAssets').value, 0.1);
  assert.equal(result.sections.some(section => section.id === 'income'), false);
  assert.equal(result.sections.some(section => section.id === 'cashflow'), false);
  assert.equal(result.coverage.status, 'partial');
  assert.ok(result.notes.some(note => /Missing income and cash-flow statements are not estimated/.test(note)));
  for (const source of result.sources) {
    assert.equal(source.accession, accession);
    assert.equal(source.periodEnd, end);
    assert.match(source.url, /annual\.pdf#page=\d+$/);
    assert.match(source.note, /Page \d+\./);
  }
});

test('report projection rejects crossed identity, unknown periods, unsupported basis and unreadable documents', () => {
  assert.throws(() => buildBrokerDealerReport(research(), { id: '123457' }), /verified SEC registrant/);
  assert.throws(() => buildBrokerDealerReport(research(), { basis: 'quarter' }), /annual reporting basis/);
  const mismatched = research(); mismatched.analysis.accession = '0000123456-25-000001';
  assert.throws(() => buildBrokerDealerReport(mismatched), /verified SEC registrant/);
  const undated = research(); undated.analysis.periodEnd = null;
  assert.throws(() => buildBrokerDealerReport(undated), /verified SEC registrant/);
  const unreadable = research(); unreadable.analysis.metrics = [];
  assert.throws(() => buildBrokerDealerReport(unreadable), /No financial amounts/);
});

test('unverifiable sources are omitted along with dependent ratios', () => {
  const input = research();
  input.analysis.metrics.find(metric => metric.id === 'totalAssets').source.url = 'https://example.com/annual.pdf';
  const report = buildBrokerDealerReport(input);
  assert.equal(report.sections.find(section => section.id === 'balance').rows.some(row => row.key === 'totalAssets'), false);
  assert.equal(report.sections.find(section => section.id === 'ratios').rows.some(row => row.key === 'assetsToEquity'), false);
  assert.equal(report.sources.some(source => source.url.includes('example.com')), false);
});

test('separately presented debt exports a distinctly calculated total and source-complete liability ratios', () => {
  const input = separatelyPresentedDebtResearch(), report = buildBrokerDealerReport(input);
  const balance = report.sections.find(section => section.id === 'balance').rows;
  const subtotal = balance.find(row => row.key === 'totalLiabilities');
  const calculated = balance.find(row => row.key === 'adjustedTotalLiabilities');
  assert.equal(subtotal.value, 41_201_143_006);
  assert.equal(subtotal.classification, 'reported');
  assert.equal(calculated.value, 41_226_149_358);
  assert.equal(calculated.classification, 'calculated');
  assert.match(calculated.metric, /\(calculated\)$/);
  assert.match(calculated.formula, /subtotal \+ separately presented subordinated debt/);
  assert.equal(calculated.sourceIds.length, 4, 'All four reconciliation inputs survive export');
  assert.deepEqual(calculated.sourceIds.map(id => report.sources.find(source => source.id === id).concept).sort(),
    ['X-17A-5:totalAssets', 'X-17A-5:totalLiabilities', 'X-17A-5:subordinatedDebt', 'X-17A-5:totalEquity'].sort());
  assert.equal(report.sources.some(source => source.concept === 'X-17A-5:adjustedTotalLiabilities'), false, 'Calculated amounts never claim a reported source');
  const ratios = report.sections.find(section => section.id === 'ratios').rows;
  assert.equal(ratios.find(row => row.key === 'liabilitiesToEquity').value, 41_226_149_358 / 183_374_799);
  assert.ok(ratios.find(row => row.key === 'cashToLiabilities').sourceIds.includes(calculated.sourceIds[2]));
  assert.ok(report.notes.some(note => /original subtotal, subordinated debt and equity remain visible/.test(note)));
});

test('invalid calculated totals and unavailable reconciliation inputs are withheld with dependent ratios', () => {
  const mutations = [
    input => { input.analysis.metrics.find(metric => metric.id === 'adjustedTotalLiabilities').value += 1; },
    input => { input.analysis.metrics.find(metric => metric.id === 'adjustedTotalLiabilities').basis = 'reported'; },
    input => { input.analysis.metrics.find(metric => metric.id === 'adjustedTotalLiabilities').validation.status = 'mismatch'; },
    input => { input.analysis.metrics.find(metric => metric.id === 'totalEquity').source.url = 'https://example.com/not-sec.pdf'; },
    input => { input.analysis.metrics.find(metric => metric.id === 'subordinatedDebt').periodEnd = '2024-12-31'; },
    input => { input.analysis.metrics.find(metric => metric.id === 'subordinatedDebt').source.page = 7; },
  ];
  for (const mutate of mutations) {
    const input = separatelyPresentedDebtResearch(); mutate(input);
    const report = buildBrokerDealerReport(input);
    assert.equal(report.sections.flatMap(section => section.rows).some(row => row.key === 'adjustedTotalLiabilities'), false);
    assert.equal(report.sections.find(section => section.id === 'ratios')?.rows.some(row => row.key === 'liabilitiesToEquity') || false, false);
  }
});

test('note details are kept separate from balance-sheet totals and missing statements are explained', () => {
  const input = separatelyPresentedDebtResearch(), sourceMetric = input.analysis.metrics.find(metric => metric.id === 'totalAssets');
  for (const [id, value] of [['ficcReceivables', 349_375_797], ['forwardRepos', 32_800_000_000]]) {
    input.analysis.metrics.push({ ...sourceMetric, id, statement: 'notes', value,
      source: { ...sourceMetric.source, page: 11, text: `${id}: $${value}`, url: `${documentUrl}#page=11` } });
  }
  const report = buildBrokerDealerReport(input);
  assert.deepEqual(report.sections.find(section => section.id === 'statement-notes').rows.map(row => row.key), ['ficcReceivables', 'forwardRepos']);
  assert.equal(report.sections.find(section => section.id === 'balance').rows.some(row => row.key === 'forwardRepos'), false);
  assert.ok(report.notes.some(note => /may be components of other balances or off-balance-sheet commitments/.test(note)));
  assert.ok(report.notes.some(note => /revenue, earnings and profitability are unavailable, not zero/.test(note)));
  input.analysis.coverage.disclosedStatements.push('income', 'cash-flows');
  const identified = buildBrokerDealerReport(input);
  assert.ok(identified.notes.some(note => /An income statement was identified, but no income amounts/.test(note)));
  assert.ok(identified.notes.some(note => /A cash-flow statement was identified, but no cash-flow amounts/.test(note)));
});

test('expanded income measures remain in the income statement', () => {
  const input = research(), template = input.analysis.metrics[0];
  const ids = ['interestIncome', 'interestExpense', 'totalExpenses', 'pretaxIncome'];
  for (const id of ids) input.analysis.metrics.push({ ...template, id, value: 500, statement: 'income', periodStart: '2025-04-01' });
  const report = buildBrokerDealerReport(input);
  assert.deepEqual(report.sections.find(section => section.id === 'income').rows.map(row => row.key), ids);
  assert.equal(report.sections.find(section => section.id === 'balance').rows.some(row => ids.includes(row.key)), false);
  assert.equal(report.sections.find(section => section.id === 'income').rows[0].start, '2025-04-01');
  assert.equal(report.sections.find(section => section.id === 'income').rows[0].basis, 'duration', 'Nine-month amounts retain a duration basis inside an annual filing');
  assert.equal(report.sections.find(section => section.id === 'balance').rows[0].basis, 'instant');
  assert.equal(report.sections.find(section => section.id === 'income').rows[0].reportedPeriod, '2025-04-01 to 2025-12-31');
  assert.equal(report.sources.find(source => source.concept === 'X-17A-5:interestIncome').start, '2025-04-01');
});

test('annual exports reject periodic and unclassified documents across broker-dealers despite the shared SEC form', () => {
  for (const [name, text, family] of [
    ['Regional Clearing LLC', 'SECURITIES AND EXCHANGE COMMISSION\nX-17A-5\nPART II\nFOCUS REPORT\nPeriod beginning October 1, 2025 and ending December 31, 2025\nUnaudited', 'periodic-focus'],
    ['Independent Introducing Securities Inc.', 'SECURITIES AND EXCHANGE COMMISSION\nX-17A-5\nPART IIA\nFOCUS REPORT\nPeriod beginning December 1, 2025 and ending December 31, 2025', 'periodic-focus'],
    ['Unclassified Securities LLC', 'Financial schedules\nTotal assets $10,000\nTotal liabilities $9,000\nMembers equity $1,000', 'unknown'],
  ]) {
    const input = research();
    input.company.name = name;
    input.classification = classifyBrokerDealerDocument({ pages: [{ pageNumber: 1, text }], documentUrl });
    input.analysis.classification = input.classification;
    assert.equal(input.classification.family, family);
    assert.throws(() => buildBrokerDealerReport(input), error => error.status === 422 && /classified as an annual report/.test(error.message));
  }
  const missing = research(); delete missing.classification; delete missing.analysis.classification;
  assert.throws(() => buildBrokerDealerReport(missing), /classified as an annual report/);
  const conflicting = research(); conflicting.classification = { ...conflicting.classification, family: 'periodic-focus' };
  assert.throws(() => buildBrokerDealerReport(conflicting), /classified as an annual report/);
});

test('Part III without an auditor report remains annual with audit not established, including PDF and Excel scope', async () => {
  const input = research();
  input.filing.classification = { version: 1, family: 'unknown' };
  const report = buildBrokerDealerReport(input, { generatedAt });
  assert.equal(report.classification.audit.status, 'not-established');
  assert.deepEqual(report.classification.parts, ['Part III']);
  assert.equal(report.classification.period.start, '2025-01-01');
  assert.equal(report.classification.period.end, end);
  assert.equal(report.period.start, '2025-01-01');
  assert.doesNotMatch(`${report.title} ${report.subtitle} ${report.classification.label}`, /audited/i);
  const scope = report.sections.find(section => section.id === 'report-scope');
  assert.match(scope.rows.find(row => row.item === 'Audit evidence').value, /Audit status not established/);
  assert.ok(scope.rows.some(row => /Period beginning January 1, 2025/.test(row.value)));
  assert.ok(report.classification.evidence.every(row => report.sources.some(source => source.id === row.sourceId && source.url === row.url)));
  const pdf = await PDFDocument.load(await createReportPdf(report));
  assert.doesNotMatch(pdf.getSubject(), /audited/i);
  const workbook = unzipSync(await createReportXlsx(report));
  assert.match(strFromU8(workbook['xl/workbook.xml']), /Report scope/);
  const sheets = Object.entries(workbook).filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(([, bytes]) => strFromU8(bytes)).join('\n');
  assert.match(sheets, /Audit status not established/);
  assert.match(sheets, /Part III/);
  assert.match(sheets, /2025-01-01 to 2025-12-31/);
});

test('auditor report evidence retains its financial-condition-only scope and unverified claims are downgraded', () => {
  const input = research();
  input.company.name = 'Clearwater Securities Inc.';
  const classification = classifyBrokerDealerDocument({ documentUrl, filing: input.filing, pages: [
    { pageNumber: 1, text: 'SECURITIES AND EXCHANGE COMMISSION\nX-17A-5\nPART III\nAnnual Report' },
    { pageNumber: 2, text: "Report of Independent Registered Public Accounting Firm\nWe have audited the accompanying statement of financial condition of Clearwater Securities Inc. as of December 31, 2025.\nIn our opinion, the statement of financial condition presents fairly, in all material respects, the financial position." },
  ] });
  input.classification = classification; input.analysis.classification = classification;
  const report = buildBrokerDealerReport(input);
  assert.equal(report.classification.audit.status, 'auditor-report-present');
  assert.equal(report.classification.audit.scope, 'financial-condition');
  assert.match(report.sections.find(section => section.id === 'report-scope').rows.find(row => row.item === 'Audit evidence').value, /for the statement of financial condition/);
  assert.ok(report.classification.evidence.some(item => item.kind === 'auditor-report' && item.page === 2));
  const invalid = research(); invalid.classification.audit = { status: 'auditor-report-present', scope: 'financial-statements' };
  assert.equal(buildBrokerDealerReport(invalid).classification.audit.status, 'not-established');
  const crossedSource = research(); crossedSource.classification.evidence = crossedSource.classification.evidence.map(item => ({ ...item, url: 'https://www.sec.gov/Archives/edgar/data/999/000000099926000001/annual.pdf' }));
  assert.throws(() => buildBrokerDealerReport(crossedSource), /page-level evidence/);
  const siblingSource = research(); siblingSource.selectedDocument.url = documentUrl.replace('annual.pdf', 'focus.pdf');
  assert.throws(() => buildBrokerDealerReport(siblingSource), /page-level evidence/, 'Annual sibling metadata cannot classify a selected periodic attachment');
});

test('company Reports loader selects the annual PDF branch without prepared-company or XBRL calls', async () => {
  const loader = createCompanyReportLoader({ loadCik: async () => ({ brokerDealerResearch: research() }),
    readPrepared: () => assert.fail('No ticker may be inferred'), loadInteractive: () => assert.fail('No XBRL request'), now: () => generatedAt });
  const report = await loader({ ticker: cik, basis: 'annual' });
  assert.equal(report.entity.id, cik);
  assert.equal(report.generatedAt, generatedAt);
  await assert.rejects(loader({ ticker: '0000654321' }), /did not match/);
  const unchanged = await enrichCompanyReportCftc(report, { loadContext: () => assert.fail('No parent-company business context is substituted') });
  assert.strictEqual(unchanged, report);
});

test('existing PDF and Excel export pipelines support the same broker-dealer statement snapshot', async () => {
  const report = buildBrokerDealerReport(research(), { generatedAt });
  const pdf = await createReportPdf(report);
  assert.ok((await PDFDocument.load(pdf)).getPageCount() >= 2);
  const workbook = unzipSync(await createReportXlsx(report));
  const manifest = strFromU8(workbook['xl/workbook.xml']);
  assert.match(manifest, /Balance Sheet/);
  assert.match(manifest, /Regulatory capital/);
  assert.match(manifest, /Statement evidence/);
  assert.doesNotMatch(manifest, /Income Statement|Cash Flow/);
  const sheets = Object.entries(workbook).filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(([, bytes]) => strFromU8(bytes)).join('\n');
  assert.match(sheets, /<v>10000000<\/v>/);
  assert.match(sheets, /Total assets 10,000/);
});

test('PDF and Excel retain calculated liability status, the reported subtotal and separate note details', async () => {
  const input = separatelyPresentedDebtResearch(), metric = input.analysis.metrics.find(row => row.id === 'totalAssets');
  input.analysis.metrics.push({ ...metric, id: 'forwardRepos', value: 32_800_000_000, statement: 'notes' });
  const report = buildBrokerDealerReport(input, { generatedAt });
  assert.ok((await PDFDocument.load(await createReportPdf(report))).getPageCount() >= 2);
  const workbook = unzipSync(await createReportXlsx(report));
  assert.match(strFromU8(workbook['xl/workbook.xml']), /Statement notes/);
  const sheets = Object.entries(workbook).filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(([, bytes]) => strFromU8(bytes)).join('\n');
  assert.match(sheets, /<v>41201143006<\/v>/);
  assert.match(sheets, /<v>41226149358<\/v>/);
  assert.match(sheets, /Liabilities including separately presented subordinated debt \(calculated\)/);
  assert.match(sheets, /Calculated from reported inputs/);
  assert.match(sheets, /Reported liabilities subtotal \+ separately presented subordinated debt/);
});

test('preview numeric-company requests preserve the public PDF-aware pipeline and reject crossed CIKs', async () => {
  const calls = [], report = buildBrokerDealerReport(research(), { generatedAt });
  let crossed = false;
  const source = createPublicReportSources({ now: () => Date.parse(generatedAt), fetchPublic: async (input, options) => {
    const url = new URL(input); calls.push(url.href);
    assert.equal(url.origin, 'https://secedgarterminal.com');
    assert.equal(url.pathname, '/api/reports/prepare');
    assert.equal(url.searchParams.get('id'), cik);
    assert.equal(url.searchParams.get('basis'), 'annual');
    assert.equal(options.credentials, 'omit');
    return Response.json(crossed ? { ...report, entity: { ...report.entity, cik: '0000654321' } } : report);
  } });
  const selected = { kind: 'company', id: cik, basis: 'annual' };
  const result = await source.prepareReport(selected);
  assert.equal(result.sources[0].form, 'X-17A-5');
  assert.equal(calls.length, 1, 'No XBRL or parent company fallback');
  crossed = true;
  await assert.rejects(source.prepareReport(selected), /did not match/);
});
