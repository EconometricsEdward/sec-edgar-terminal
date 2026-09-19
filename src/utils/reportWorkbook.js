import { zipSync, strToU8 } from 'fflate';
import { comparePairQuality } from './compareQuality.js';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const FORMULA = Symbol('workbook formula');
const formulaCell = (formula, value) => ({ [FORMULA]: true, formula, value });
const escape = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const colName = (index) => { let value = ''; for (index++; index; index = Math.floor((index - 1) / 26)) value = String.fromCharCode(65 + ((index - 1) % 26)) + value; return value; };
const formats = { text: 0, number: 164, usd: 165, percent: 166, ratio: 167, date: 168, millions: 169, cardUsd: 170, integer: 171 };
const formatCodes = {
  164: '#,##0.00;[Red](#,##0.00);0.00', 165: '#,##0.00;[Red](#,##0.00);0.00',
  166: '0.0%;[Red](0.0%);0.0%', 167: '0.00"x";[Red](0.00"x");0.00"x"', 168: 'mmm d, yyyy',
  169: '#,##0.0,,;[Red](#,##0.0,,);0.0', 170: '$#,##0.0,,"M";[Red]($#,##0.0,,"M");$0.0"M"',
  171: '#,##0;[Red](#,##0);0',
};
const kindNames = { company: 'Company financial report', nport: 'N-PORT portfolio report', '13f': 'Institutional holdings report', market: 'Market research report' };
const companyNames = { income: 'Income Statement', balance: 'Balance Sheet', cashflow: 'Cash Flow', ratios: 'Ratios' };
const detailNames = { 'market-coverage': 'Coverage', 'sector-performance': 'Sector Performance', 'sector-cash-capital': 'Cash and Capital', 'sector-metric-coverage': 'Metric Coverage', 'cftc-market-coverage': 'CFTC Coverage', 'cftc-tff': 'CFTC Financial Futures', 'cftc-disaggregated': 'CFTC Commodity Futures', 'market-companies': 'Company Detail', 'cftc-all-groups': 'CFTC Contract Detail', 'cftc-history': 'CFTC History' };
const emphasizedMetrics = new Set(['revenue', 'bankRevenue', 'premiumsEarned', 'grossProfit', 'operatingIncome', 'netIncome', 'totalAssets', 'totalLiabilities', 'stockholdersEquity', 'totalEquity', 'operatingCashFlow', 'freeCashFlow']);
const numericFormat = (column, row) => row[column.formatKey] || column.format || 'text';
const excludedColumn = (column) => column.key !== 'weightSource' && (/source|provenance|citation|accession|url/i.test(column.key) || /source|provenance|citation|accession|\burl\b/i.test(column.label));
const excludedSection = (section) => /^(observations|sources|chart-data|report-identity)$/.test(section.id) || /methodology.*source|source.*reference|source register|^sources$|^chart data$/i.test(section.title || '');
const cleanFootnote = (value) => String(value || '').split(/(?<=[.!?])\s+/).filter((part) => !/source IDs?|source references?|source catalog|source appendix|observation appendix|workbook.*methodology|\bsource\s+S\d+/i.test(part)).join(' ');
const dateSerial = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const date = value.slice(0, 10), timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? (timestamp - Date.UTC(1899, 11, 30)) / 86400000 : null;
};

function validate(report) {
  if (report?.schema !== 'edgar.report.v1' || !kindNames[report.kind] || !report.entity?.name || !report.period || !Array.isArray(report.sections) || !Array.isArray(report.summary)) throw new Error('The prepared report is incomplete. Prepare the report again.');
  if (report.sections.length > 50 || report.summary.length > 100) throw new Error('The report exceeds the supported export size.');
  for (const section of report.sections) if (!Array.isArray(section.columns) || !section.columns.length || section.columns.length > 50 || !Array.isArray(section.rows) || section.rows.length > 1000000) throw new Error('A report section exceeds the supported export size.');
}

function styleCatalog() {
  const entries = [], lookup = new Map();
  function style({ font = 0, fill = 0, format = 'text', align, border = 0, wrap = true } = {}) {
    const properties = { font, fill, format, align: align || (format === 'text' ? 'left' : 'right'), border, wrap }, key = JSON.stringify(properties);
    if (!lookup.has(key)) { lookup.set(key, entries.length); entries.push(properties); }
    return lookup.get(key);
  }
  style();
  const font = (size, color, extra = '') => `<font>${extra}<sz val="${size}"/><color rgb="FF${color}"/><name val="Arial"/></font>`;
  return { style, xml: () => `${XML}<styleSheet xmlns="${NS}"><numFmts count="${Object.keys(formatCodes).length}">${Object.entries(formatCodes).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${escape(code)}"/>`).join('')}</numFmts><fonts count="7">${font(10, '17243B')}${font(16, '17243B', '<b/>')}${font(10, 'FFFFFF', '<b/>')}${font(9, '64748B', '<i/>')}${font(20, '17243B', '<b/>')}${font(10, '17243B', '<b/>')}${font(9, '64748B')}</fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${['17243B', 'F2F5F8', 'E9EEF3'].map((color) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`).join('')}</fills><borders count="3"><border/><border><bottom style="thin"><color rgb="FFD6B258"/></bottom></border><border><bottom style="thin"><color rgb="FFDDE4EC"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${entries.length}">${entries.map((item) => `<xf numFmtId="${formats[item.format] || 0}" fontId="${item.font}" fillId="${item.fill}" borderId="${item.border}" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyAlignment="1" applyBorder="1"><alignment horizontal="${item.align}" vertical="center" wrapText="${item.wrap ? 1 : 0}"/></xf>`).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` };
}

function cell(value, ref, style, format = 'text') {
  let prepared = value;
  if (format === 'date' && value != null) prepared = dateSerial(value) ?? value;
  if (prepared == null || prepared === '' || typeof prepared === 'number' && !finite(prepared)) return `<c r="${ref}" s="${style}"/>`;
  if (typeof prepared === 'object' && prepared[FORMULA]) return `<c r="${ref}" s="${style}"${finite(prepared.value) ? '' : ' t="str"'}><f>${escape(prepared.formula)}</f><v>${finite(prepared.value) ? prepared.value : ''}</v></c>`;
  if (finite(prepared)) return `<c r="${ref}" s="${style}"><v>${prepared}</v></c>`;
  // Inline strings keep identifiers intact and cannot execute imported text as formulas.
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escape((typeof prepared === 'object' ? JSON.stringify(prepared) : String(prepared)).slice(0, 32767))}</t></is></c>`;
}

function makeSheet(name, widths, styles) {
  const rows = new Map(), merges = [], sheet = { name, widths, rows, merges, lastRow: 1, freeze: 0, filter: null, charts: [], printEnd: widths.length - 1, repeat: null };
  sheet.put = (row, column, value, format = 'text', decoration = {}) => {
    if (!rows.has(row)) rows.set(row, { height: 23, cells: new Map() });
    rows.get(row).cells.set(column, cell(value, `${colName(column)}${row}`, styles.style({ format, ...decoration }), format));
    sheet.lastRow = Math.max(sheet.lastRow, row);
  };
  sheet.height = (row, height) => { if (!rows.has(row)) rows.set(row, { height, cells: new Map() }); else rows.get(row).height = height; sheet.lastRow = Math.max(sheet.lastRow, row); };
  sheet.span = (row, start, end, value, format = 'text', decoration = {}) => {
    for (let column = start; column <= end; column++) sheet.put(row, column, column === start ? value : null, format, decoration);
    if (end > start) merges.push(`${colName(start)}${row}:${colName(end)}${row}`);
  };
  return sheet;
}

const wrappedHeight = (text, width, minimum = 23) => Math.min(409, Math.max(minimum, String(text || '').split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length / Math.max(8, width - 3))), 0) * 13 + 8));
function titleBlock(sheet, report, title, context) {
  // Keep the opening title/context in the first viewport of wide detail tables.
  const end = Math.min(sheet.widths.length - 1, 9), contextWidth = sheet.widths.slice(1, end + 1).reduce((sum, width) => sum + width, 0);
  sheet.height(1, 10);
  sheet.span(2, 1, end, title, 'text', { font: 1, border: 1 }); sheet.height(2, 32);
  sheet.span(3, 1, end, `${report.entity.name}${report.entity.ticker ? ` (${report.entity.ticker})` : ''}. ${report.period.label || ''}`, 'text', { font: 6 }); sheet.height(3, wrappedHeight(report.entity.name + report.period.label, contextWidth));
  sheet.span(4, 1, end, context, 'text', { font: 3 }); sheet.height(4, wrappedHeight(context, contextWidth, 23));
  sheet.height(5, 9);
}

function summarySheet(report, styles) {
  const sheet = makeSheet('Summary', [3, 13, 13, 13, 3, 13, 13, 13, 3, 13, 13, 13], styles), starts = [1, 5, 9];
  sheet.height(1, 10);
  sheet.span(2, 1, 11, report.entity.name, 'text', { font: 1, border: 1 }); sheet.height(2, wrappedHeight(report.entity.name, 100, 34));
  sheet.span(3, 1, 11, [kindNames[report.kind], report.entity.ticker, report.entity.cik && `CIK ${report.entity.cik}`, report.entity.seriesId].filter(Boolean).join('  ·  '), 'text', { font: 6 });
  const dates = [{ label: report.kind === 'market' ? 'Snapshot date' : 'Reporting period ending', value: report.period.asOf }, { label: report.kind === 'market' ? 'Report prepared' : 'Latest filing', value: report.kind === 'market' ? report.generatedAt : report.period.filingDate }, { label: 'Reporting basis', value: report.period.basis || report.period.label, format: 'text' }];
  dates.forEach((date, index) => { sheet.span(5, starts[index], starts[index] + 2, date.label, 'text', { font: 6 }); sheet.span(6, starts[index], starts[index] + 2, date.value || 'Unavailable', date.format || 'date', { font: 5, align: 'left' }); });
  sheet.height(6, 29); sheet.height(7, 10);
  const metrics = report.summary.slice(0, 6);
  for (let row = 0; row < Math.ceil(metrics.length / 3); row++) {
    const top = 8 + row * 5;
    const group = metrics.slice(row * 3, row * 3 + 3);
    group.forEach((metric, index) => {
      const start = starts[index], format = metric.unit === 'usd' ? 'cardUsd' : metric.unit === 'number' && Number.isInteger(metric.value) ? 'integer' : metric.unit;
      sheet.span(top, start, start + 2, metric.label, 'text', { font: 5, fill: 3 });
      sheet.span(top + 1, start, start + 2, finite(metric.value) ? metric.value : 'Unavailable', format, { font: finite(metric.value) ? 4 : 5, fill: 3 });
      sheet.span(top + 2, start, start + 2, metric.unit === 'usd' ? 'USD millions' : metric.unit === 'percent' ? 'Percent' : metric.unit === 'ratio' ? 'Multiple' : 'Reported measure', 'text', { font: 6, fill: 3 });
      sheet.span(top + 3, start, start + 2, cleanFootnote(metric.detail), 'text', { font: 6, fill: 3 });
    });
    sheet.height(top, 30); sheet.height(top + 1, 38); sheet.height(top + 2, 22); sheet.height(top + 3, Math.max(...group.map((metric) => wrappedHeight(cleanFootnote(metric.detail), 39, 14)))); sheet.height(top + 4, 10);
  }
  let row = 8 + Math.ceil(metrics.length / 3) * 5;
  sheet.span(row, 1, 11, 'Report coverage', 'text', { font: 5, border: 2 }); sheet.height(row++, 27);
  sheet.span(row, 1, 11, report.coverage?.message || 'Available reported observations.', 'text', { font: 6 }); sheet.height(row++, wrappedHeight(report.coverage?.message, 110, 31));
  const insights = (report.highlights || []).slice(0, 4);
  if (insights.length) {
    sheet.height(row++, 8); sheet.span(row, 1, 11, 'Key observations', 'text', { font: 5, border: 2 }); sheet.height(row++, 27);
    for (const item of insights) { sheet.span(row, 1, 11, item.title, 'text', { font: 5 }); sheet.height(row++, 24); sheet.span(row, 1, 11, item.text, 'text', { font: 0 }); sheet.height(row++, wrappedHeight(item.text, 110, 31)); sheet.height(row++, 7); }
  }
  sheet.span(row, 1, 11, 'Blank numeric cells indicate unavailable values. Monetary display scaling does not change the underlying numbers.', 'text', { font: 3 }); sheet.height(row, 28);
  sheet.summary = true;
  return sheet;
}

function sectionSheet(report, section, styles, references) {
  const financial = report.kind === 'company' && !!companyNames[section.id];
  const columns = section.columns.filter((column) => !excludedColumn(column));
  if (!columns.length) return null;
  if (financial) columns.sort((a, b) => a.key === 'metric' ? -1 : b.key === 'metric' ? 1 : a.label.localeCompare(b.label));
  const name = companyNames[section.id] || detailNames[section.id] || section.title || 'Detail';
  const widths = [3, ...columns.map((column, i) => financial ? i === 0 ? 38 : 17 : Math.min(60, Math.max(14, column.width ? column.width < 10 ? column.width * 15 : column.width : column.format === 'text' ? i === 0 ? 35 : 26 : column.format === 'date' ? 18 : 20)))];
  const sheet = makeSheet(name, widths, styles);
  const context = financial ? 'USD millions, except per-share amounts, share counts and ratios. Percentages and multiples are shown as labeled.' : [cleanFootnote(section.description), 'Blank numeric values are unavailable.'].filter(Boolean).join(' ');
  titleBlock(sheet, report, name, context);
  columns.forEach((column, index) => sheet.put(6, index + 1, column.label, 'text', { font: 2, fill: 2, align: 'center' })); sheet.height(6, 34);
  section.rows.forEach((data, index) => {
    const row = index + 7, emphasized = financial && emphasizedMetrics.has(data.key), fill = emphasized ? 4 : index % 2 ? 3 : 0;
    let height = 24;
    columns.forEach((column, columnIndex) => {
      const format = numericFormat(column, data), displayFormat = financial && format === 'usd' ? 'millions' : format === 'number' && Number.isInteger(data[column.key]) ? 'integer' : format;
      sheet.put(row, columnIndex + 1, data[column.key], displayFormat, { fill, font: emphasized ? 5 : 0, border: emphasized ? 2 : 0 });
      if (typeof data[column.key] === 'string') height = Math.max(height, wrappedHeight(data[column.key], widths[columnIndex + 1]));
      if (financial && data.key && /^p\d+$/.test(column.key)) references.set(`${data.key}:${column.label}`, { sheet, cell: `${colName(columnIndex + 1)}${row}`, value: data[column.key], unit: format });
    });
    sheet.height(row, height);
  });
  if (!section.rows.length) { sheet.span(7, 1, widths.length - 1, 'No compatible observations are available for this section.', 'text', { font: 3 }); sheet.height(7, 32); }
  const footnote = cleanFootnote(section.footnote);
  if (footnote) { const row = section.rows.length + 9; sheet.span(row, 1, widths.length - 1, footnote, 'text', { font: 3 }); sheet.height(row, wrappedHeight(footnote, widths.reduce((sum, width) => sum + width, 0), 26)); }
  sheet.freeze = 6; sheet.repeat = '$1:$6';
  if (section.rows.length) sheet.filter = `B6:${colName(widths.length - 1)}${section.rows.length + 6}`;
  return sheet;
}

function trendsSheet(report, styles, references) {
  const observations = report.sections.find((section) => section.id === 'observations')?.rows || [], sourceMap = new Map((report.sources || []).map((source) => [source.id, source]));
  const charts = (report.charts || []).filter((chart) => chart.kind === 'line' && chart.unit === 'usd' && chart.points?.some((point) => finite(point.value))).slice(0, 6);
  const sheet = makeSheet('Trends', [3, 34, 17, 19, 17, 19, 19, 16, 43], styles);
  titleBlock(sheet, report, 'Trends', 'Year-over-year comparisons use matching reporting bases and compatible definitions. USD values are displayed in millions.');
  const headings = ['Financial measure', 'Prior period', 'Prior value', 'Latest period', 'Latest value', 'Change (USD m)', 'Change (%)', 'Comparison'];
  headings.forEach((heading, index) => sheet.put(6, index + 1, heading, 'text', { font: 2, fill: 2, align: 'center' })); sheet.height(6, 34);
  const observationPoint = (observation) => ({ value: observation.value, classification: observation.classification, period: { kind: observation.basis, start: observation.start, end: observation.period }, sources: (observation.sourceIds || []).map((id) => sourceMap.get(id)).filter(Boolean).map((source) => ({ ...source, taxonomy: source.concept?.split(':')[0], tag: source.concept?.split(':').slice(1).join(':'), end: source.periodEnd })) });
  const link = (observation) => {
    const target = observation && references.get(`${observation.key}:${observation.period}`);
    return target && finite(target.value) ? formulaCell(`'${target.sheet.name.replaceAll("'", "''")}'!${target.cell}`, target.value) : observation?.value ?? null;
  };
  const comparable = (current, prior) => current && prior && current.unit === prior.unit && comparePairQuality(observationPoint(current), observationPoint(prior), current.key).valid;
  const history = [];
  charts.forEach((chart, index) => {
    const metricObservations = observations.filter((observation) => observation.metric === chart.title).sort((a, b) => b.period.localeCompare(a.period));
    const current = metricObservations[0], prior = current && metricObservations.find((observation) => { const days = (Date.parse(current.period) - Date.parse(observation.period)) / 86400000; return days >= 330 && days <= 400; });
    const valid = comparable(current, prior), row = index + 7, fill = index % 2 ? 3 : 0;
    let status = !current ? 'Comparable observations unavailable' : !prior ? 'Prior-year observation unavailable' : !valid ? 'Comparison withheld: definitions or coverage differ' : prior.value <= 0 ? 'Percent change unavailable: prior value is not positive' : 'Comparable year-over-year periods';
    if (valid && !finite(current.value)) status = 'Latest observation unavailable';
    [chart.title, prior?.period, link(prior), current?.period, link(current), valid ? formulaCell(`IF(AND(ISNUMBER(F${row}),ISNUMBER(D${row})),F${row}-D${row},"")`, current.value - prior.value) : null, valid && prior.value > 0 ? formulaCell(`IF(AND(ISNUMBER(F${row}),ISNUMBER(D${row}),D${row}>0),F${row}/D${row}-1,"")`, current.value / prior.value - 1) : null, status].forEach((value, column) => sheet.put(row, column + 1, value, ['text', 'date', 'millions', 'date', 'millions', 'millions', 'percent', 'text'][column], { fill }));
    sheet.height(row, wrappedHeight(status, sheet.widths[8], 34));
    history.push({ chart, observations: metricObservations, comparable });
  });
  if (!charts.length) { sheet.span(7, 1, 8, 'No supported financial history is available for trend comparison.', 'text', { font: 3 }); sheet.height(7, 32); }
  let row = Math.max(10, charts.length + 10);
  sheet.span(row, 1, 8, 'Reported financial history', 'text', { font: 5, border: 2 }); sheet.height(row++, 27);
  sheet.span(row, 1, 8, 'Changes are withheld when the definitions or reporting durations differ. Charts show reported levels, with unconnected markers when comparison is unsupported.', 'text', { font: 3 }); sheet.height(row++, 34);
  for (const { chart, observations: metricObservations, comparable: compare } of history) {
    const ordered = [...chart.points].sort((a, b) => a.label.localeCompare(b.label));
    sheet.span(row, 1, 8, chart.title, 'text', { font: 5 }); sheet.height(row++, 25);
    const headerRow = row;
    sheet.put(row, 1, 'Period ending', 'text', { font: 2, fill: 2, align: 'center' }); sheet.put(row++, 2, 'USD millions', 'text', { font: 2, fill: 2, align: 'center' });
    const first = row;
    ordered.forEach((point, index) => {
      const observation = metricObservations.find((item) => item.period === point.label);
      sheet.put(row, 1, point.label, 'text', { fill: index % 2 ? 3 : 0 });
      sheet.put(row++, 2, observation ? link(observation) : point.value, chart.unit === 'usd' ? 'millions' : chart.unit, { fill: index % 2 ? 3 : 0 });
    });
    const allComparable = ordered.every((point, index) => !index || !finite(point.value) || !finite(ordered[index - 1].value) || compare(metricObservations.find((item) => item.period === point.label), metricObservations.find((item) => item.period === ordered[index - 1].label)));
    sheet.charts.push({ title: `${chart.title} (USD millions)`, kind: 'line', unit: chart.unit, points: ordered, firstRow: first, lastRow: row - 1, labelColumn: 'B', valueColumn: 'C', from: { col: 3, row: headerRow - 1 }, to: { col: 8, row: Math.max(row + 2, headerRow + 11) }, connect: allComparable });
    row = Math.max(row + 4, headerRow + 14);
  }
  sheet.height(row, 8); sheet.freeze = 6; sheet.repeat = '$1:$6';
  return sheet;
}

function companyCftcSheet(report, sections, styles) {
  const sheet = makeSheet('CFTC Context', [3, 35, 25, 18, 24, 20, 22, 22], styles);
  titleBlock(sheet, report, 'CFTC Context', 'Aggregate futures positioning provides market context. It does not quantify the company’s own derivatives or hedging exposure.');
  const positioning = sections.find((section) => section.id === 'cftc-positioning');
  let row = 6;
  if (positioning) {
    const columns = positioning.columns.filter((column) => !excludedColumn(column));
    columns.forEach((column, index) => sheet.put(row, index + 1, column.label, 'text', { font: 2, fill: 2, align: 'center' })); sheet.height(row++, 35);
    positioning.rows.forEach((item, index) => { columns.forEach((column, i) => sheet.put(row, i + 1, item[column.key], numericFormat(column, item), { fill: index % 2 ? 3 : 0 })); sheet.height(row++, 40); });
    sheet.filter = `B6:H${row - 1}`;
    row += 2;
  }
  for (const section of sections.filter((item) => item.id !== 'cftc-positioning')) {
    sheet.span(row, 1, 7, section.title, 'text', { font: 5, border: 2 }); sheet.height(row++, 29);
    for (const item of section.rows) {
      sheet.span(row, 1, 7, [item.market, item.traderGroup].filter(Boolean).join(' · ') || 'Market coverage', 'text', { font: 5, fill: 4 }); sheet.height(row++, 29);
      const columns = section.columns.filter((column) => !excludedColumn(column) && !['market', 'traderGroup'].includes(column.key) && !(section.id === 'cftc-market-detail' && positioning?.columns.some((positionColumn) => positionColumn.key === column.key)));
      columns.forEach((column, index) => {
        const fill = index % 2 ? 3 : 0;
        sheet.span(row, 1, 2, column.label, 'text', { font: 6, fill });
        sheet.span(row, 3, 7, item[column.key], numericFormat(column, item), { fill });
        sheet.height(row++, wrappedHeight(item[column.key], 100, 26));
      });
      row++;
    }
    row++;
  }
  sheet.height(row, 8); sheet.freeze = positioning ? 6 : 0;
  return sheet;
}

function sheetXml(sheet) {
  const end = colName(sheet.widths.length - 1);
  const rows = [...sheet.rows.entries()].sort(([a], [b]) => a - b).map(([index, row]) => `<row r="${index}" ht="${row.height}" customHeight="1">${[...row.cells.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('')}</row>`).join('');
  return `${XML}<worksheet xmlns="${NS}" xmlns:r="${REL}"><sheetPr><tabColor rgb="FF${sheet.summary ? '17243B' : 'B8C5D5'}"/><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${end}${sheet.lastRow}"/><sheetViews><sheetView showGridLines="0" zoomScale="90" workbookViewId="0">${sheet.freeze ? `<pane xSplit="2" ySplit="${sheet.freeze}" topLeftCell="C${sheet.freeze + 1}" activePane="bottomRight" state="frozen"/>` : ''}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="23"/><cols>${sheet.widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${rows}</sheetData>${sheet.filter ? `<autoFilter ref="${sheet.filter}"/>` : ''}${sheet.merges.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>` : ''}<printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.18" footer="0.18"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="${sheet.summary ? 1 : 0}"/><headerFooter><oddFooter>&amp;LEDGAR Terminal&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>${sheet.charts.length ? '<drawing r:id="rDrawing"/>' : ''}</worksheet>`;
}

function chartXml(chart, sheetName, index) {
  const c = 'http://schemas.openxmlformats.org/drawingml/2006/chart', a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const sheet = `'${sheetName.replaceAll("'", "''")}'`, category = `${sheet}!$${chart.labelColumn}$${chart.firstRow}:$${chart.labelColumn}$${chart.lastRow}`, values = `${sheet}!$${chart.valueColumn}$${chart.firstRow}:$${chart.valueColumn}$${chart.lastRow}`;
  const axis1 = 100000 + index * 2, axis2 = axis1 + 1, numberFormat = chart.unit === 'usd' ? '#,##0.0,,' : chart.unit === 'percent' ? '0.0%' : '#,##0.0';
  const title = `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${escape(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
  const points = chart.points.map((point, i) => finite(point.value) ? `<c:pt idx="${i}"><c:v>${point.value}</c:v></c:pt>` : '').join('');
  return `${XML}<c:chartSpace xmlns:c="${c}" xmlns:a="${a}" xmlns:r="${REL}"><c:lang val="en-US"/><c:chart>${title}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${escape(chart.title)}</c:v></c:tx><c:spPr><a:ln w="25400">${chart.connect ? '<a:solidFill><a:srgbClr val="24797C"/></a:solidFill>' : '<a:noFill/>'}</a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="24797C"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker><c:cat><c:strRef><c:f>${escape(category)}</c:f><c:strCache><c:ptCount val="${chart.points.length}"/>${chart.points.map((point, i) => `<c:pt idx="${i}"><c:v>${escape(point.label)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${escape(values)}</c:f><c:numCache><c:formatCode>${escape(numberFormat)}</c:formatCode><c:ptCount val="${chart.points.length}"/>${points}</c:numCache></c:numRef></c:val><c:smooth val="0"/></c:ser><c:marker val="1"/><c:smooth val="0"/><c:axId val="${axis1}"/><c:axId val="${axis2}"/></c:lineChart><c:catAx><c:axId val="${axis1}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="${axis2}"/><c:crosses val="autoZero"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="${axis2}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="E6EBF1"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${escape(numberFormat)}" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="${axis1}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:latin typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:chartSpace>`;
}

/** Browser-worker workbook writer. Raw numeric values survive presentation scaling. */
export async function createReportXlsx(report) {
  validate(report);
  const styles = styleCatalog(), references = new Map(), sheets = [summarySheet(report, styles)];
  let sections = report.sections.filter((section) => !excludedSection(section));
  const companyCftc = report.kind === 'company' ? sections.filter((section) => section.id?.startsWith('cftc-') && section.id !== 'cftc-history') : [];
  if (companyCftc.length) sections = sections.filter((section) => !companyCftc.includes(section));
  if (report.kind === 'company') {
    for (const [id, title] of Object.entries(companyNames)) if (!sections.some((section) => section.id === id)) sections.push({ id, title, columns: [{ key: 'metric', label: 'Metric', format: 'text' }, { key: 'value', label: 'Value', format: 'number' }], rows: [] });
    sections.sort((a, b) => (Object.keys(companyNames).indexOf(a.id) < 0 ? 10 : Object.keys(companyNames).indexOf(a.id)) - (Object.keys(companyNames).indexOf(b.id) < 0 ? 10 : Object.keys(companyNames).indexOf(b.id)));
  }
  sections.forEach((section) => { const sheet = sectionSheet(report, section, styles, references); if (sheet) sheets.push(sheet); });
  if (companyCftc.length) sheets.push(companyCftcSheet(report, companyCftc, styles));
  const names = new Set();
  const nameSheet = (sheet) => {
    const base = String(sheet.name || 'Detail').replace(/[\\/?*:[\]]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Detail';
    let name = base; for (let i = 2; names.has(name.toLowerCase()); i++) name = `${base.slice(0, 27)} ${i}`;
    names.add(name.toLowerCase()); sheet.name = name;
  };
  sheets.forEach(nameSheet);
  if (report.kind === 'company') { const sheet = trendsSheet(report, styles, references); nameSheet(sheet); sheets.splice(5, 0, sheet); }
  const files = {}, entries = [], relationships = [], overrides = [], definedNames = [];
  let chartCount = 0;
  sheets.forEach((sheet, index) => {
    const id = index + 1, quotedName = `'${sheet.name.replaceAll("'", "''")}'`;
    files[`xl/worksheets/sheet${id}.xml`] = strToU8(sheetXml(sheet));
    entries.push(`<sheet name="${escape(sheet.name)}" sheetId="${id}" r:id="rId${id}"/>`);
    relationships.push(`<Relationship Id="rId${id}" Type="${REL}/worksheet" Target="worksheets/sheet${id}.xml"/>`);
    overrides.push(`<Override PartName="/xl/worksheets/sheet${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    definedNames.push(`<definedName name="_xlnm.Print_Area" localSheetId="${index}">${escape(`${quotedName}!$B$2:$${colName(sheet.widths.length - 1)}$${sheet.lastRow}`)}</definedName>`);
    if (sheet.repeat) definedNames.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${escape(`${quotedName}!${sheet.repeat}`)}</definedName>`);
    if (sheet.charts.length) {
      const anchors = [], rels = [];
      sheet.charts.forEach((chart, chartIndex) => {
        const chartId = ++chartCount;
        files[`xl/charts/chart${chartId}.xml`] = strToU8(chartXml(chart, sheet.name, chartId));
        overrides.push(`<Override PartName="/xl/charts/chart${chartId}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
        rels.push(`<Relationship Id="rChart${chartIndex + 1}" Type="${REL}/chart" Target="../charts/chart${chartId}.xml"/>`);
        const anchor = (name, position) => `<xdr:${name}><xdr:col>${position.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${position.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${name}>`;
        anchors.push(`<xdr:twoCellAnchor>${anchor('from', chart.from)}${anchor('to', chart.to)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${chartIndex + 1}" name="Trend ${chartIndex + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL}" r:id="rChart${chartIndex + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`);
      });
      files[`xl/drawings/drawing${id}.xml`] = strToU8(`${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors.join('')}</xdr:wsDr>`);
      files[`xl/drawings/_rels/drawing${id}.xml.rels`] = strToU8(`${XML}<Relationships xmlns="${PKG}">${rels.join('')}</Relationships>`);
      files[`xl/worksheets/_rels/sheet${id}.xml.rels`] = strToU8(`${XML}<Relationships xmlns="${PKG}"><Relationship Id="rDrawing" Type="${REL}/drawing" Target="../drawings/drawing${id}.xml"/></Relationships>`);
      overrides.push(`<Override PartName="/xl/drawings/drawing${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
    }
  });
  files['xl/workbook.xml'] = strToU8(`${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${entries.join('')}</sheets><definedNames>${definedNames.join('')}</definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`${XML}<Relationships xmlns="${PKG}">${relationships.join('')}<Relationship Id="rStyles" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
  files['_rels/.rels'] = strToU8(`${XML}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files['xl/styles.xml'] = strToU8(styles.xml());
  files['[Content_Types].xml'] = strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides.join('')}</Types>`);
  return zipSync(files, { level: 6 });
}
