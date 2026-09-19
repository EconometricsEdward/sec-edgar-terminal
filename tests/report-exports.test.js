import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
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

test('market PDF follows the Market briefing sections, preserves percentage scales and profiles every sector', async () => {
  const keys = ['revenueGrowth', 'netMargin', 'cashFlowMargin', 'capexIntensity', 'equityToAssets'];
  const sectors = Array.from({ length: 12 }, (_, i) => ({
    id: `sector-${i + 1}`, label: `Sector ${i + 1}`, count: 6,
    metrics: Object.fromEntries(keys.map((key, n) => [key, { median: n === 0 ? 33.3 : n === 1 ? 0 : null, count: n < 2 ? 6 : 0, positive: n === 0 ? 6 : 0, positivePct: n === 0 ? 100 : 0 }])),
    industries: [{ code: '1234', label: `Industry ${i + 1}`, count: 6 }],
  }));
  const cards = Array.from({ length: 6 }, (_, i) => ({ id: String(i), category: `Lens ${i + 1}`, label: `Contract ${i + 1}`,
    family: 'tff', familyLabel: 'TFF', groupLabel: 'Leveraged Funds', code: `04360${i}`, reportDate: '2026-09-15',
    netPctOi: i === 0 ? -25 : i === 1 ? 0 : null, weeklyChange: i === 0 ? 1.5 : null }));
  const fullUrl = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json?%24select=market_and_exchange_names&%24where=report_date';
  const base = report({ kind: 'market', entity: { id: 'MARKET', name: 'Market overview', cik: '' },
    marketBriefing: {
      coverage: { companyCount: 72, sectorCount: 12, industryCount: 12, requestedCount: 72, missingSectorCount: 0, missingIndustryCount: 0, olderReports: 0, snapshotAt: '2026-09-19' },
      breadth: [{ id: 'revenue-growth', label: 'Growing revenue', positive: 54, count: 72, share: .75, context: 'Positive growth' }],
      growthLeaders: { highest: { sector: 'Sector 1', value: 33.3, count: 6, companies: 6 }, lowest: { sector: 'Sector 2', value: 33.3, count: 6, companies: 6 }, spreadPp: 0 },
      positioning: { cards, availableCount: 2, families: [{ label: 'TFF', valid: true, reportDate: '2026-09-15' }], largestMove: null },
      sectorMetrics: keys.map(key => ({ key, label: key })), sectors,
    },
    sections: [{ id: 'market-companies', columns: [{ key: 'ticker', label: 'Ticker', format: 'text' }],
      rows: sectors.flatMap((sector, i) => Array.from({ length: 6 }, (_, j) => ({ sectorId: sector.id, sector: sector.label, ticker: `S${i + 1}${j === 5 ? 'LOW' : `TOP${j + 1}`}`, name: `Company ${i + 1}.${j + 1}`, revenueGrowth: .125 - j / 100, periodEnd: '2026-06-30' }))) },
    { id: 'cftc-tff', title: 'TFF positioning', description: 'Leveraged Funds / Futures only / 2026-09-15', columns: [{ key: 'netOi', label: 'Net / OI', format: 'percent' }],
      rows: [{ familyId: 'tff', code: '043600', groupId: 'leveraged-funds', market: 'Contract 1', reportDate: '2026-09-15', netOi: -.25, oneWeekChangePp: 1.5 }] },
    { id: 'cftc-heatmap', columns: [{ key: 'rank1y', label: 'Rank', format: 'percent' }], rows: [{ familyId: 'tff', code: '043600', groupId: 'leveraged-funds', reportDate: '2026-09-15', rank1y: .92, rank1yN: 52, rank1yRequired: 52 }] },
    { id: 'cftc-all-groups', columns: [{ key: 'netOi', label: 'Net / OI', format: 'percent' }], rows: [
      ...['Dealers', 'Asset Managers', 'Leveraged Funds', 'Other Reportables', 'Nonreportables'].map((group, i) => ({ familyId: 'tff', groupId: String(i), group, code: '043600', market: 'Contract 1', reportDate: '2026-09-15', openInterest: 1000, netOi: .11 - i / 10 })),
      { familyId: 'tff', groupId: '0', group: 'Dealers', code: 'CATALOG', market: 'Catalog-only sentinel', reportDate: '2026-09-15', netOi: null },
    ] }],
    sources: [{ id: 'cftc-tff', label: 'CFTC financial futures', url: fullUrl }], notes: [],
  });
  const text = await pdfText(base);
  assert.match(text, /75% of companies grew revenue/);
  assert.match(text, /Six windows into the macro market/);
  assert.match(text, /Who holds financial futures/);
  assert.match(text, /Nonreportables/);
  assert.match(text, /-29%/);
  assert.doesNotMatch(text, /Catalog-only sentinel/);
  assert.match(text, /Where is performance diverging/);
  assert.match(text, /Find the dispersion/);
  assert.match(text, /-25%/);
  assert.match(text, /\+1\.5 pp/);
  assert.match(text, /33\.3%/);
  assert.match(text, /12\.5%/);
  assert.match(text, /92%/);
  assert.match(text, /52 \/ 52/);
  assert.match(text, /Unavailable/);
  assert.doesNotMatch(text, /-2,500%|3,330%|9,200%/);
  assert.equal(text.match(/Inside the sectors\./g)?.length, 6);
  assert.match(text, /S12TOP1/);
  assert.doesNotMatch(text, /S12LOW/);
  assert.match(text, /publicreporting.cftc.gov\/resource\/gpe5-46if.json/);
  assert.doesNotMatch(text, /%24select|market_and_exchange_names/);
  const pdf = await PDFDocument.load(await createReportPdf(base));
  const targets = pdf.getPages().flatMap(page => {
    const annotations = page.node.lookup(PDFName.of('Annots'));
    return annotations ? annotations.asArray().map(ref => pdf.context.lookup(ref).lookup(PDFName.of('A')).lookup(PDFName.of('URI')).decodeText()) : [];
  });
  assert.ok(targets.includes(fullUrl), 'the concise source label still opens the full original dataset query');
});
