import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
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

// Standard-font PDFs store each drawn line as a hex string in a content stream.
const pdfText = async (document) => {
  const pdf = await PDFDocument.load(await createReportPdf(document));
  return pdf.context.enumerateIndirectObjects().flatMap(([, object]) => {
    if (!(object instanceof PDFRawStream)) return [];
    const content = new TextDecoder().decode(decodePDFRawStream(object).decode());
    return [...content.matchAll(/<([0-9A-F]+)>\s*Tj/g)].map((match) => Buffer.from(match[1], 'hex').toString('latin1'));
  }).join(' ').replace(/\s+/g, ' ');
};

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

test('PDF grouped filing sources retain every distinct observation period', async () => {
  const base = report({ charts: [], highlights: [] }), source = base.sources[0];
  base.sources = [source, { ...source, id: 'S2', periodEnd: '2023-12-31' }, { ...source, id: 'S3', periodEnd: '2024-12-31' }, { ...source, id: 'S4' }];
  const text = await pdfText(base);
  assert.match(text, /Source IDs: S1, S2, S3, S4/);
  assert.match(text, /Observation period ends: 2023-12-31, 2024-12-31, 2025-12-31/);
  assert.doesNotMatch(text, /Period ending 2025-12-31 \| Filed 2026-02-19/);
  assert.equal(text.split(source.url).length - 1, 1);
  const single = await pdfText(report({ charts: [], highlights: [] }));
  assert.match(single, /Period ending 2025-12-31 \| Filed 2026-02-19/);
  assert.doesNotMatch(single, /Observation period ends:/);
});

test('PDF retains source references without directing readers to removed workbook sheets', async () => {
  const base = report({ charts: [], highlights: [] });
  base.sections[0].rows[0].sourcesByPeriod = [{ period: '2025-12-31', sourceIds: ['S1'] }];
  const text = await pdfText(base);
  assert.doesNotMatch(text, /Excel workbook table|Its Sources sheet|Excel source register/);
  assert.match(text, /Source register/);
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
