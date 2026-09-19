import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { createReportPdf, createReportXlsx, formatReportValue } from '../src/utils/reportExports.js';

const report = (patch = {}) => ({
  schema: 'edgar.report.v1', kind: 'company', generatedAt: '2026-09-19T12:00:00.000Z',
  entity: { id: 'TEST', ticker: 'TEST', name: 'Example & Co. = literal', cik: '0000001234' },
  title: 'Financial report', subtitle: 'Reported financial results and their sources.',
  period: { label: 'Annual', asOf: '2025-12-31', filingDate: '2026-02-19', basis: 'annual' },
  summary: [{ label: 'Revenue', value: 1500000, unit: 'usd', detail: 'Annual consolidated revenue', sourceIds: ['S1'] }, { label: 'Net margin', value: 0.125, unit: 'percent' }, { label: 'Unavailable', value: null, unit: 'usd' }],
  highlights: [{ title: 'Reported results', text: 'Revenue increased while the current ratio remained above one.' }],
  sections: [{ id: 'metrics', title: 'Financial measures', columns: [{ key: 'label', label: 'Measure', format: 'text' }, { key: 'value', label: 'Value', format: 'number', formatKey: 'unit' }, { key: 'date', label: 'Date', format: 'date' }], rows: [{ label: '=HYPERLINK("https://example.com")', value: 0.125, unit: 'percent', date: '2025-12-31' }, { label: 'Zero is reported', value: 0, unit: 'usd', date: '2025-12-31' }, { label: 'Missing stays missing', value: null, unit: 'ratio', date: null }], footnote: 'Source S1. No estimated values.' }],
  charts: [{ kind: 'line', title: 'Revenue history', unit: 'usd', points: [{ label: '2023', value: 1000000 }, { label: '2024', value: null }, { label: '2025', value: 1500000 }] }],
  sources: [{ id: 'S1', label: 'Revenue', url: 'https://www.sec.gov/Archives/example', form: '10-K', accession: '0000001234-26-000001', periodEnd: '2025-12-31', filed: '2026-02-19', concept: 'us-gaap:Revenues', unit: 'USD', value: 1500000 }],
  notes: ['Financial measures use the selected reporting period.'], coverage: { status: 'partial', message: 'Two of three requested measures available.', availableMetrics: 2, totalMetrics: 3 }, ...patch,
});

const files = async (document) => Object.fromEntries(Object.entries(unzipSync(await createReportXlsx(document))).map(([key, value]) => [key, strFromU8(value)]));

test('Excel preserves typed fractions, zero and dates, leaves null blank, and cannot execute string formulas', async () => {
  const workbook = await files(report()), sheet = workbook['xl/worksheets/sheet2.xml'];
  assert.match(sheet, /<c r="B5" s="5"><v>0.125<\/v><\/c>/);
  assert.match(sheet, /<c r="B6" s="4"><v>0<\/v><\/c>/);
  assert.match(sheet, /<c r="B7" s="6"\/>/);
  assert.match(sheet, /<c r="C5" s="7"><v>46022<\/v><\/c>/);
  assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/);
  assert.doesNotMatch(Object.values(workbook).join(''), /<f[ >]/);
  assert.match(sheet, /ySplit="4" topLeftCell="A5"/);
  assert.match(sheet, /autoFilter ref="A4:C7"/);
  assert.match(workbook['xl/workbook.xml'], /<sheet name="Report summary" sheetId="1"/);
  assert.match(workbook['xl/styles.xml'], /formatCode="0.00%/);
});

test('Excel contains every holding even when PDF omits or limits the appendix', async () => {
  const rows = Array.from({ length: 1201 }, (_, i) => ({ label: `Holding ${i + 1}`, value: i + 1 }));
  const document = report({ sections: [{ id: 'holdings', title: 'Holdings / all', pdfRowLimit: 0, columns: [{ key: 'label', label: 'Holding', format: 'text' }, { key: 'value', label: 'Value', format: 'usd' }], rows }] });
  const workbook = await files(document), sheet = workbook['xl/worksheets/sheet2.xml'];
  assert.match(sheet, /Holding 1201/);
  assert.match(sheet, /<c r="B1205" s="4"><v>1201<\/v><\/c>/);
  assert.match(workbook['xl/workbook.xml'], /Holdings   all/);
});

test('Excel preserves Unicode names and produces unique Excel-safe sheet names', async () => {
  const base = report();
  base.entity.name = 'Εταιρεία Société 公司';
  base.sections.push({ ...base.sections[0], id: 'duplicate' });
  const workbook = await files(base);
  assert.match(workbook['xl/worksheets/sheet1.xml'], /Εταιρεία Société 公司/);
  assert.match(workbook['xl/workbook.xml'], /name="Financial measures 2"/);
  assert.match(workbook['xl/worksheets/sheet5.xml'], /us-gaap:Revenues/);
});

test('Excel expands wrapped text rows and converts relative PDF widths to readable columns', async () => {
  const base = report();
  base.sections[0].columns[0].width = 2.3;
  base.sections[0].rows[0].label = 'Meaningful explanatory context that must remain visible. '.repeat(5);
  const workbook = await files(base), sheet = workbook['xl/worksheets/sheet2.xml'];
  assert.match(sheet, /min="1" max="1" width="34.5"/);
  const height = Number(sheet.match(/<row r="5" ht="([\d.]+)"/)[1]);
  assert.ok(height > 100 && height <= 409);
});

test('PDF is a genuine document with safe Unicode and long multipage tables', async () => {
  const base = report({ entity: { id: 'TEST', name: 'Εταιρεία Société Москва 公司', cik: '0000001234' } });
  base.sections[0].pdfRowLimit = 145;
  base.sections[0].rows = Array.from({ length: 145 }, (_, i) => ({ label: `Long report row ${i} ${'A description with spaces. '.repeat(4)}`, value: i / 100, unit: 'percent', date: '2025-12-31' }));
  const bytes = await createReportPdf(base, { fontBytes: await readFile('public/report-fonts/NotoSans-Regular.ttf'), boldFontBytes: await readFile('public/report-fonts/NotoSans-Bold.ttf') });
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 6);
  assert.equal(pdf.getAuthor(), 'EDGAR Terminal');
  assert.equal(pdf.getTitle(), 'Εταιρεία Société Москва 公司 - Financial report');
  assert.ok(pdf.getPages().every((page) => page.getWidth() > 590 && page.getHeight() > 840));
});

test('PDF table uses readable metric widths when the builder supplies relative sizing', async () => {
  const base = report({ charts: [], highlights: [], sources: [] });
  base.sections[0].columns = [{ key: 'label', label: 'Metric', format: 'text', width: 2.3 }, ...Array.from({ length: 5 }, (_, i) => ({ key: `p${i}`, label: `202${i}-12-31`, format: 'usd' }))];
  base.sections[0].rows = Array.from({ length: 12 }, (_, i) => ({ label: `Meaningful reported financial metric ${i}`, p0: 1500000, p1: 1600000, p2: 1700000, p3: 1800000, p4: 1900000 }));
  const pdf = await PDFDocument.load(await createReportPdf(base));
  assert.ok(pdf.getPageCount() <= 3, `unexpected layout inflation: ${pdf.getPageCount()} pages`);
});

test('display formatting respects fractions, null and true zero', () => {
  assert.equal(formatReportValue(0.125, 'percent'), '12.5%');
  assert.equal(formatReportValue(null, 'usd'), 'Unavailable');
  assert.equal(formatReportValue(0, 'usd'), '$0');
  assert.equal(formatReportValue(1.25, 'ratio'), '1.25×');
  assert.equal(formatReportValue(-1500000, 'usd', true), '-$1.5M');
});

test('both exporters reject unsupported report contracts', async () => {
  await assert.rejects(createReportPdf({ schema: 'old' }), /incomplete/);
  await assert.rejects(createReportXlsx(report({ sections: [{ columns: [], rows: [] }] })), /section/);
});
