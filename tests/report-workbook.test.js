import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { createReportXlsx } from '../src/utils/reportWorkbook.js';
import { buildMarketReport } from '../src/utils/marketReport.js';
import { CFTC_FAMILIES, CFTC_REPORT_BASIS, CFTC_SCHEMA_VERSION, cftcCatalog, normalizeCftcRow } from '../src/utils/cftc.js';

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

function marketEdition(size = 3, mixedDates = false, cftcAvailable = true) {
  const issuers = Array.from({ length: size }, (_, i) => ({ ticker: `ISSUER${i + 1}`, cik: String(i + 1).padStart(10, '0'), name: `Market company ${i + 1}`, sector: i < 2 ? 'Technology' : 'Industrials', sic: i < 2 ? 7372 : 3571, cohorts: [i < 2 ? 'sector-technology' : 'sector-industrials'],
    metrics: { ttm: { revenue: 1000000 + i, netIncome: i ? 10000 : -10000, revenueGrowth: i === 0 ? 10 : i === 1 ? -4 : 0, netMargin: i === 1 ? null : 20, cashFlowMargin: i ? 0 : -5, capexIntensity: 4, equityToAssets: 30 } },
    reports: { ttm: { end: '2026-06-30', filed: '2026-08-14', accession: `${String(i + 1).padStart(10, '0')}-26-000001`, form: '10-Q' } } }));
  const families = ['tff', 'disaggregated'].map(family => {
    const definition = CFTC_FAMILIES[family], date = family === 'disaggregated' && mixedDates ? '2026-09-08' : '2026-09-15';
    const raw = { id: 'SOURCE_SENTINEL', market_and_exchange_names: `${family} market - TEST EXCHANGE`, contract_market_name: `${family} contract`, report_date_as_yyyy_mm_dd: date, cftc_contract_market_code: family === 'tff' ? '13874A' : '067651', cftc_market_code: 'TEST', contract_units: 'TEST CONTRACT UNITS', futonly_or_combined: 'FutOnly', open_interest_all: '500' };
    definition.groups.forEach(group => { raw[group.long] = '150'; raw[group.short] = '50'; if (group.spread) raw[group.spread] = '0'; });
    const position = normalizeCftcRow(raw, family).value;
    const catalogOnly = normalizeCftcRow({ ...raw, cftc_contract_market_code: '999999', contract_market_name: 'Additional catalog-only market' }, family).value;
    const catalog = cftcCatalog([position, catalogOnly], family);
    for (const group of Object.values(position.groups)) Object.assign(group, { oneWeekChange: 25, oneWeekNetPctChange: 1.25, fourWeekChange: null, fourWeekNetPctChange: null });
    return { schema_version: CFTC_SCHEMA_VERSION, report_family: family, report_basis: CFTC_REPORT_BASIS, report_date: date, retrieved_at: '2026-09-18T22:30:00Z', status: 'ready', source: { url: definition.sourceUrl, dataset_id: definition.datasetId }, freshness: { source_currency: 'current', cache_status: 'prepared' }, catalog, latest: [position], coverage: { catalog_rows: catalog.length, reconciliation_differences: 0 } };
  });
  return buildMarketReport({ overview: { generatedAt: '2026-09-19T10:00:00Z', requested: size + 5, companies: issuers, cohorts: [{ id: 'sector-technology', label: 'Technology', tickers: issuers.slice(0, 2).map(company => company.ticker) }, { id: 'sector-industrials', label: 'Industrials', tickers: issuers.slice(2).map(company => company.ticker) }], failures: [] }, cftcFamilies: cftcAvailable ? families : [] }, { generatedAt: '2026-09-19T18:00:00Z' });
}

test('Market edition follows the page sequence with breadth denominators, five sector measures and no duplicate legacy tabs', async () => {
  const report = marketEdition(), workbook = await files(report), briefing = sheet(workbook, 'Market Briefing'), sectors = sheet(workbook, 'Sector Performance');
  assert.deepEqual(names(workbook).map(item => item.name), ['Market Briefing', 'CFTC Positioning', 'Sector Performance', 'Sector Statistics', 'Industries', 'Companies', 'CFTC Contracts', 'CFTC Heatmap', 'Coverage']);
  assert.match(cell(briefing, 'B6'), /<v>3<\/v>/);
  assert.ok(Math.abs(Number(cell(briefing, 'E13').match(/<v>([^<]+)/)[1]) - 1 / 3) < 1e-14);
  assert.match(cell(briefing, 'F13'), /<v>1<\/v>/); assert.match(cell(briefing, 'G13'), /<v>3<\/v>/);
  assert.match(cell(briefing, 'B21'), /<v>0.03<\/v>/); // Rich model leader 3 percentage points becomes 3%.
  assert.match(briefing, /conditionalFormatting sqref="E13".*<dataBar>/);
  const sectorRows = report.sections.find(section => section.id === 'sector-comparison').rows;
  const technologyRow = sectorRows.findIndex(row => row.sector === 'Technology') + 7;
  assert.match(cell(sectors, `D${technologyRow}`), /<v>0.03<\/v>/); // Flat table is already a fraction.
  assert.match(cell(sectors, `E${technologyRow}`), /<v>2<\/v>/);
  assert.match(cell(sectors, `F${technologyRow}`), /<v>0.2<\/v>/);
  assert.match(cell(sectors, `G${technologyRow}`), /<v>1<\/v>/);
  assert.match(sectors, /Operating cash flow \/ revenue.*Capex \/ revenue.*Book equity \/ assets/);
  const scaleRules = [...sectors.matchAll(/<colorScale>(.*?)<\/colorScale>/g)];
  assert.equal(scaleRules.length, 5);
  for (const rule of scaleRules) { const values = [...rule[1].matchAll(/<cfvo type="num" val="([^\"]+)"/g)].map(match => Number(match[1])); assert.equal(values[1], 0); assert.ok(values[0] < 0 && values[2] > 0); }
  assert.doesNotMatch(Object.values(workbook).join(''), /SOURCE_SENTINEL|Source ID|name="Sources"|name="Chart data"|name="Cash and Capital"|name="Metric Coverage"/);
});

test('Market CFTC native chart references exact typed observations and distinguishes percentages, points and blanks', async () => {
  const workbook = await files(marketEdition()), xml = sheet(workbook, 'CFTC Positioning'), chart = workbook['xl/charts/chart1.xml'];
  assert.match(cell(xml, 'F7'), /\/>$/); // Missing Treasury observation stays blank.
  assert.match(cell(xml, 'F9'), /<v>0.2<\/v>/); // 20 net/OI percentage points -> 0.2.
  assert.match(cell(xml, 'G9'), /<v>1.25<\/v>/); // Weekly pp remains 1.25.
  assert.match(cell(xml, 'E9'), /<v>46280<\/v>/);
  const xfs = [...workbook['xl/styles.xml'].match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)[1].matchAll(/<xf\s[^>]+>/g)].map(match => match[0]);
  assert.match(xfs[Number(cell(xml, 'F9').match(/s="(\d+)"/)[1])], /numFmtId="166"/);
  assert.match(xfs[Number(cell(xml, 'G9').match(/s="(\d+)"/)[1])], /numFmtId="164"/);
  assert.match(chart, /<c:barChart>/); assert.match(chart, /CFTC Positioning&apos;!\$C\$7:\$C\$12/); assert.match(chart, /CFTC Positioning&apos;!\$F\$7:\$F\$12/);
  assert.match(chart, /<c:max val="1"\/><c:min val="-1"\/>/);
  assert.match(chart, /<c:pt idx="2"><c:v>0.2<\/c:v>/); assert.doesNotMatch(chart, /<c:pt idx="0"><c:v>0<\/c:v>/);
  assert.match(chart, /<c:dispBlanksAs val="gap"/);
  assert.match(xml, /mergeCell ref="B21:C22"/); assert.match(cell(xml, 'B21'), /U.S. Treasury 10-Year Note/);
  assert.match(workbook['xl/drawings/drawing2.xml'], /<xdr:from><xdr:col>3<\/xdr:col>/);
  assert.match(xml, /TFF \/ All participant groups/); assert.match(xml, /Disaggregated \/ All participant groups/);
  const matrixRows = [...xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/g)].filter(match => ['D', 'E', 'F', 'G', 'H'].every(col => /<v>0.2<\/v>/.test(cell(match[2], `${col}${match[1]}`) || '')));
  assert.equal(matrixRows.length, 2, 'Each prepared contract retains all five participant groups in its family matrix');
  assert.doesNotMatch(xml, /Additional catalog-only market/);
});

test('Market workbooks retain all detail rows and separate the preparation, SEC, company and CFTC clocks', async () => {
  const report = marketEdition(1201, true), workbook = await files(report), companies = sheet(workbook, 'Companies'), contracts = sheet(workbook, 'CFTC Contracts'), coverage = sheet(workbook, 'Coverage');
  const companySection = report.sections.find(section => section.id === 'market-companies'), contractSection = report.sections.find(section => section.id === 'cftc-all-groups');
  const last = companySection.rows.at(-1);
  assert.match(companies, /Market company 1201/); assert.match(companies, new RegExp(`<v>${1001200}<\\/v>`));
  assert.ok(cell(companies, 'B1207').includes(last.ticker));
  assert.match(companies, /autoFilter ref="B6:[A-Z]+1207"/); assert.equal(companySection.rows.length, 1201);
  assert.match(contracts, new RegExp(`autoFilter ref="B6:[A-Z]+${contractSection.rows.length + 6}"`));
  const missingRow = contractSection.rows.findIndex(row => row.code === '999999') + 7;
  assert.match(cell(contracts, `Q${missingRow}`), /\/>$/); // Catalog-only net/open interest.
  assert.match(contracts, /Additional catalog-only market/);
  assert.match(cell(companies, 'D7'), /t="inlineStr"/); assert.ok(cell(companies, 'D7').includes(companySection.rows[0].cik));
  for (const value of [report.generatedAt, '2026-09-19T10:00:00Z', '2026-06-30', '2026-09-15', '2026-09-08', '2026-09-18T22:30:00Z']) assert.ok(coverage.includes(value), `Coverage retains ${value}`);
  assert.match(sheet(workbook, 'CFTC Positioning'), /different report dates.*largest weekly shift is withheld/);
  assert.doesNotMatch(sheet(workbook, 'CFTC Positioning'), /Largest weekly shift:/);
});

test('Market prepared rank heatmap preserves every contract, fractional ranks, horizon counts and unavailable long windows', async () => {
  const report = marketEdition(), ranks = report.sections.find(section => section.id === 'cftc-heatmap');
  Object.assign(ranks.rows[0], { rank1y: 0, rank1yN: 52, rank3y: 0.625, rank3yN: 156, rank5y: null, rank5yN: 208 });
  const workbook = await files(report), xml = sheet(workbook, 'CFTC Heatmap');
  assert.match(cell(xml, 'H7'), /<v>0<\/v>/); assert.match(cell(xml, 'I7'), /<v>52<\/v>/);
  assert.match(cell(xml, 'J7'), /<v>0.625<\/v>/); assert.match(cell(xml, 'K7'), /<v>156<\/v>/);
  assert.match(cell(xml, 'L7'), /\/>$/); assert.match(cell(xml, 'M7'), /<v>208<\/v>/);
  assert.match(xml, new RegExp(`autoFilter ref="B6:M${ranks.rows.length + 6}"`));
  assert.match(xml, /52, 156 or 260 prior weekly reports/);
});

test('Market CFTC outage preserves SEC analysis and six unavailable macro observations without invented zeros', async () => {
  const workbook = await files(marketEdition(3, false, false)), positioning = sheet(workbook, 'CFTC Positioning');
  assert.match(sheet(workbook, 'Companies'), /Market company 3/);
  assert.match(sheet(workbook, 'Sector Performance'), /Technology/);
  for (let row = 7; row <= 12; row++) { assert.match(cell(positioning, `F${row}`), /\/>$/); assert.match(cell(positioning, `G${row}`), /\/>$/); }
  assert.match(positioning, /0 of 6 selected observations are available/);
  assert.match(sheet(workbook, 'Coverage'), /Snapshot unavailable/);
  assert.doesNotMatch(workbook['xl/charts/chart1.xml'].match(/<c:numCache>(.*?)<\/c:numCache>/)[1], /<c:pt idx=/);
});
