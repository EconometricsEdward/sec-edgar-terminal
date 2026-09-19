import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { createReportXlsx } from '../src/utils/reportWorkbook.js';

const column = (key, label, format = 'text', extra = {}) => ({ key, label, format, ...extra });
const base = (patch = {}) => ({ schema: 'edgar.report.v1', kind: 'company', generatedAt: '2026-09-19T12:00:00Z', entity: { id: 'ANY', ticker: 'ANY', name: 'Any issuer', cik: '0000001234' }, title: 'Company report', subtitle: 'Financial results', period: { label: 'Annual period ending 2025-12-31', asOf: '2025-12-31', filingDate: '2026-02-20', basis: 'annual' }, summary: [{ label: 'Revenue', value: 1500000, unit: 'usd', sourceIds: ['S1'] }, { label: 'Margin', value: 0.125, unit: 'percent' }], highlights: [{ title: 'Results', text: 'Revenue and earnings reflect reported company results.' }], sections: [], sources: [], charts: [], notes: [], coverage: { status: 'ready', message: 'Two comparable annual reporting periods.' }, ...patch });
const files = async (report) => Object.fromEntries(Object.entries(unzipSync(await createReportXlsx(report))).map(([key, value]) => [key, strFromU8(value)]));
const names = (workbook) => [...workbook['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)" sheetId="(\d+)"/g)].map((match) => ({ name: match[1], path: `xl/worksheets/sheet${match[2]}.xml` }));
const sheet = (workbook, name) => workbook[names(workbook).find((entry) => entry.name === name).path];
const cell = (xml, ref) => xml.match(new RegExp(`<c r="${ref}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)`))?.[0];

function company() {
  const report = base();
  report.sources = [2025, 2024].map((year, index) => ({ id: `S${index + 1}`, concept: 'us-gaap:Revenues', unit: 'USD', value: index ? 1000000 : 1500000, start: `${year}-01-01`, periodEnd: `${year}-12-31`, filed: '2026-02-20' }));
  report.sections = [{ id: 'income', title: 'Financial results', columns: [column('metric', 'Metric'), column('p0', '2025-12-31', 'number', { formatKey: 'unit' }), column('p1', '2024-12-31', 'number', { formatKey: 'unit' })], rows: [{ metric: 'Revenue', key: 'revenue', unit: 'usd', p0: 1500000, p1: 1000000 }] }, { id: 'observations', title: 'Metric methodology and source references', columns: [column('metric', 'Metric'), column('sourceRefs', 'Source IDs')], rows: report.sources.map((source) => ({ metric: 'Revenue', key: 'revenue', period: source.periodEnd, start: source.start, basis: 'annual', value: source.value, unit: 'usd', classification: 'reported', sourceIds: [source.id], sourceRefs: source.id })) }];
  report.charts = [{ kind: 'line', title: 'Revenue', unit: 'usd', points: [{ label: '2024-12-31', value: 1000000 }, { label: '2025-12-31', value: 1500000 }] }];
  return report;
}

test('company workbook is a dashboard and six financial tabs, with exact values displayed in millions', async () => {
  const workbook = await files(company());
  assert.deepEqual(names(workbook).map((item) => item.name), ['Summary', 'Income Statement', 'Balance Sheet', 'Cash Flow', 'Ratios', 'Trends']);
  const summary = sheet(workbook, 'Summary'), income = sheet(workbook, 'Income Statement');
  assert.match(summary, /Any issuer/);
  assert.match(cell(summary, 'B9'), /<v>1500000<\/v>/);
  assert.match(cell(summary, 'F9'), /<v>0.125<\/v>/);
  assert.doesNotMatch(summary, />Item<|>Context<|Source IDs|<pane/);
  assert.match(income, /USD millions/);
  assert.match(cell(income, 'C6'), /2024-12-31/);
  assert.match(cell(income, 'D6'), /2025-12-31/);
  assert.match(cell(income, 'D7'), /<v>1500000<\/v>/);
  assert.match(workbook['xl/styles.xml'], /#,##0.0,,/);
  assert.match(income, /xSplit="2" ySplit="6" topLeftCell="C7"/);
  assert.match(workbook['xl/styles.xml'], /horizontal="right"/);
  assert.match(workbook['xl/workbook.xml'], /_xlnm.Print_Area/);
  assert.match(workbook['xl/workbook.xml'], /_xlnm.Print_Titles/);
});

test('all report kinds omit provenance columns, methodology, Sources and standalone Chart data', async () => {
  for (const kind of ['company', 'nport', '13f', 'market']) {
    const report = base({ kind, sections: [{ id: 'detail', title: 'Details', columns: [column('name', 'Name'), column('value', 'Value', 'usd'), column('sourceId', 'Source ID'), column('weightSource', 'Weight basis'), column('sourceRows', 'Source rows'), column('url', 'URL')], rows: [{ name: 'Holding', value: 123.45, sourceId: 'SECRET_SOURCE_ID', weightSource: 'Calculated from NAV', sourceRows: 77, url: 'https://example.com/secret-provenance' }] }, { id: 'observations', title: 'Metric methodology and source references', columns: [column('sourceRefs', 'Source IDs')], rows: [{ sourceRefs: 'SECRET_OBSERVATION' }] }, { id: 'sources', title: 'Sources', columns: [column('id', 'Source ID')], rows: [{ id: 'SECRET_REGISTER' }] }], sources: [{ id: 'SECRET_REGISTER', url: 'https://example.com/secret-register' }] });
    const workbook = await files(report), text = Object.values(workbook).join('');
    assert.doesNotMatch(text, /SECRET_|secret-provenance|Source IDs|Source rows|Metric methodology|name="Sources"|name="Chart data"/);
    assert.match(sheet(workbook, 'Details'), /<v>123.45<\/v>/);
    assert.match(sheet(workbook, 'Details'), /Weight basis.*Calculated from NAV/);
  }
});

test('fund holdings retain every row, identifiers, fractions, nulls, zero, dates and literal formula-like text', async () => {
  const rows = Array.from({ length: 1201 }, (_, index) => ({ name: `Holding ${index + 1}`, identifier: '001234567', value: index + 0.1234, weight: index / 10000, date: '2025-12-31' }));
  rows[0] = { name: '=HYPERLINK("https://example.com")', identifier: '001234567', value: 0, weight: 0.125, date: '2025-12-31' }; rows[1].value = null;
  rows[2].name = { formula: 'HYPERLINK("https://example.com")', value: 123 };
  const report = base({ kind: 'nport', sections: [{ id: 'all-holdings', title: 'All holdings', pdfRowLimit: 0, columns: [column('name', 'Holding'), column('identifier', 'CUSIP'), column('value', 'Value (USD)', 'usd'), column('weight', 'Net assets', 'percent'), column('date', 'Date', 'date')], rows }] });
  const workbook = await files(report), xml = sheet(workbook, 'All holdings');
  assert.match(xml, /Holding 1201/);
  assert.match(cell(xml, 'D1207'), /<v>1200.1234<\/v>/);
  assert.match(cell(xml, 'C7'), /t="inlineStr".*001234567/);
  assert.match(cell(xml, 'D7'), /<v>0<\/v>/);
  assert.match(cell(xml, 'D8'), /\/>$/);
  assert.match(cell(xml, 'E7'), /<v>0.125<\/v>/);
  assert.match(cell(xml, 'F7'), /<v>46022<\/v>/);
  assert.match(cell(xml, 'B7'), /t="inlineStr".*=HYPERLINK/);
  assert.match(cell(xml, 'B9'), /t="inlineStr".*formula.*HYPERLINK/);
  assert.doesNotMatch(Object.values(workbook).join(''), /<f[ >]/);
  assert.match(xml, /autoFilter ref="B6:F1207"/);
});

test('summary retains measurement denominators and distinguishes the market snapshot date', async () => {
  const report = base({ kind: 'market', summary: [{ label: 'Positive revenue growth', value: 0.75, unit: 'percent', detail: '300 of 400 issuers with growth data', sourceIds: ['SECRET'] }] });
  const xml = sheet(await files(report), 'Summary');
  assert.match(xml, /Snapshot date/);
  assert.match(cell(xml, 'B11'), /300 of 400 issuers with growth data/);
  assert.doesNotMatch(xml, /Reporting period ending|SECRET/);
});

test('Trends links reported data and recalculable changes only for verified comparable periods', async () => {
  const report = company(), workbook = await files(report), trends = sheet(workbook, 'Trends');
  assert.match(cell(trends, 'F7'), /<f>&apos;Income Statement&apos;!D7<\/f><v>1500000<\/v>/);
  assert.match(cell(trends, 'G7'), /<f>IF.*<v>500000<\/v>/);
  assert.match(cell(trends, 'H7'), /<f>IF.*<v>0.5<\/v>/);
  assert.match(workbook['xl/charts/chart1.xml'], /Trends&apos;!\$C\$\d+:\$C\$\d+/);
  assert.match(workbook['xl/charts/chart1.xml'], /<c:dispBlanksAs val="gap"/);
  report.sources[1].concept = 'us-gaap:DifferentDefinition';
  const incompatible = await files(report);
  assert.match(cell(sheet(incompatible, 'Trends'), 'G7'), /\/>$/);
  assert.match(cell(sheet(incompatible, 'Trends'), 'H7'), /\/>$/);
  assert.match(sheet(incompatible, 'Trends'), /Comparison withheld/);
  assert.match(incompatible['xl/charts/chart1.xml'], /<a:ln w="25400"><a:noFill\/>/);
});

test('zero and negative prior values preserve absolute changes without misleading growth percentages', async () => {
  for (const value of [0, -1000000]) {
    const report = company(); report.sections[0].rows[0].p1 = value; report.sections[1].rows[1].value = value; report.sources[1].value = value; report.charts[0].points[0].value = value;
    const xml = sheet(await files(report), 'Trends');
    assert.match(cell(xml, 'G7'), new RegExp(`<v>${1500000 - value}<\\/v>`));
    assert.match(cell(xml, 'H7'), /\/>$/);
    assert.match(xml, /prior value is not positive/);
  }
});

test('company CFTC sections become Context and History without contaminating USD financial trends', async () => {
  const report = company();
  for (const id of ['cftc-positioning', 'cftc-company-relevance', 'cftc-market-detail', 'cftc-history']) report.sections.push({ id, title: id, columns: [column('market', 'Market'), column('reportDate', 'Position date', 'date'), column('netPctOi', 'Net / open interest', 'percent'), column('sourceIds', 'Source IDs')], rows: [{ market: 'Crude oil', reportDate: '2026-09-15', netPctOi: 0.25, sourceIds: ['SECRET_CFTC_ID'] }] });
  report.charts.push({ kind: 'line', title: 'Crude oil positioning', unit: 'percent', points: [{ label: '2026-09-15', value: 0.25 }] });
  const workbook = await files(report), list = names(workbook).map((item) => item.name);
  assert.equal(list.filter((name) => name.startsWith('CFTC')).length, 2);
  assert.ok(list.includes('CFTC Context') && list.includes('CFTC History'));
  assert.doesNotMatch(sheet(workbook, 'Trends'), /Crude oil/);
  assert.match(sheet(workbook, 'CFTC Context'), /<v>0.25<\/v>/);
  assert.doesNotMatch(Object.values(workbook).join(''), /SECRET_CFTC_ID/);
});

test('Unicode names, unique sheet names and wrapped descriptions survive export', async () => {
  const section = { id: 'detail', title: 'Detail / table', columns: [column('label', 'Label', 'text', { width: 2.3 }), column('value', 'Value', 'number')], rows: [{ label: 'Long but meaningful context that should wrap. '.repeat(5), value: 1.25 }] };
  const workbook = await files(base({ kind: 'market', entity: { name: 'Εταιρεία Société 公司', id: 'MARKET' }, sections: [section, { ...section, id: 'duplicate' }] }));
  assert.match(sheet(workbook, 'Summary'), /Εταιρεία Société 公司/);
  assert.deepEqual(names(workbook).map((item) => item.name), ['Summary', 'Detail   table', 'Detail   table 2']);
  const xml = sheet(workbook, 'Detail   table');
  assert.match(xml, /min="2" max="2" width="34.5"/);
  assert.ok(Number(xml.match(/<row r="7" ht="([\d.]+)"/)[1]) > 80);
});
