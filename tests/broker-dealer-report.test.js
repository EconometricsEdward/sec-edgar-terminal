import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { unzipSync, strFromU8 } from 'fflate';
import { analyzeBrokerDealerReport } from '../src/utils/brokerDealerAnalytics.js';
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
  const analysis = analyzeBrokerDealerReport({ ...filing, cik, name: 'Independent Securities LLC', documentUrl,
    pages: [{ pageNumber: 3, text: 'Statement of Financial Condition\nDecember 31, 2025\nU.S. dollars in thousands\nTotal assets 10,000\nTotal liabilities 9,000\nMembers equity 1,000\nCash and cash equivalents 400\nSecurities sold under agreements to repurchase 6,000' },
      { pageNumber: 8, text: 'Computation of Net Capital\nDecember 31, 2025\nU.S. dollars in thousands\nNet capital 600\nRequired minimum net capital 100\nExcess net capital 500' }] });
  return { status: 'available', company: { cik, name: 'Independent Securities LLC' }, filing, analysis,
    selectedDocument: { name: 'annual.pdf', url: documentUrl }, coverage: { complete: true } };
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
