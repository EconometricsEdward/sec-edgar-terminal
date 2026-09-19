import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const FORMATS = new Set(['text', 'usd', 'number', 'percent', 'ratio', 'date']);
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const KIND_LABELS = { company: 'COMPANY FINANCIAL REPORT', nport: 'FUND PORTFOLIO REPORT · N-PORT', '13f': 'INSTITUTIONAL HOLDINGS REPORT · 13F' };
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const xml = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

function validate(report) {
  if (report?.schema !== 'edgar.report.v1' || !KIND_LABELS[report.kind] || !report.entity?.name || !Array.isArray(report.sections) || !Array.isArray(report.sources) || !Array.isArray(report.summary)) throw new Error('The prepared report is incomplete. Prepare the report again.');
  if (report.sections.length > 50 || report.sources.length > 100000 || report.summary.length > 100) throw new Error('The report exceeds the supported export size.');
  for (const section of report.sections) {
    if (!Array.isArray(section.columns) || !section.columns.length || section.columns.length > 50 || !Array.isArray(section.rows) || section.rows.length > 1000000) throw new Error('A report section exceeds the supported export size.');
  }
}

export function formatReportValue(value, format = 'text', compact = false) {
  if (value === null || value === undefined || value === '' || (typeof value === 'number' && !finite(value))) return 'Unavailable';
  if (format === 'date') return String(value).slice(0, 10);
  if (!finite(value)) return String(value);
  if (format === 'percent') return new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value);
  if (format === 'ratio') return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}×`;
  return new Intl.NumberFormat('en-US', { ...(format === 'usd' ? { style: 'currency', currency: 'USD' } : {}), maximumFractionDigits: compact ? 2 : (format === 'usd' ? 0 : 2), ...(compact && Math.abs(value) >= 1000000 ? { notation: 'compact' } : {}) }).format(value);
}

const columnFormat = (column, row) => column.formatKey && FORMATS.has(row[column.formatKey]) ? row[column.formatKey] : column.format;
const colName = (index) => { let value = ''; for (index++; index; index = Math.floor((index - 1) / 26)) value = String.fromCharCode(65 + ((index - 1) % 26)) + value; return value; };
const isoSerial = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const day = value.slice(0, 10), parsed = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day ? (parsed - Date.UTC(1899, 11, 30)) / 86400000 : null;
};
const styleFor = (format) => ({ text: 0, usd: 4, number: 3, percent: 5, ratio: 6, date: 7 })[format] ?? 0;

function worksheet({ title, description, columns, rows, footnote }) {
  const width = Math.max(columns.length, 2), last = colName(width - 1);
  const columnWidths = columns.map((column, i) => {
    const requested = column.width || (column.format === 'text' ? (i === 0 ? 34 : 40) : 22);
    return Math.min(80, Math.max(12, requested < 10 ? requested * 15 : requested));
  });
  const textHeight = (value, characterWidth, minimum = 29) => {
    if (value == null || typeof value === 'number') return minimum;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(1, characterWidth - 3))), 0);
    return Math.min(409, Math.max(minimum, lines * 15 + 12));
  };
  const fullWidth = columnWidths.reduce((sum, value) => sum + value, 0);
  const cell = (value, reference, format = 'text', override) => {
    let numeric = finite(value), prepared = value, style = override ?? styleFor(format);
    if (format === 'date' && value != null) {
      const serial = isoSerial(value);
      if (serial !== null) { numeric = true; prepared = serial; }
    }
    if (value == null || value === '' || (typeof value === 'number' && !finite(value))) return `<c r="${reference}" s="${style}"/>`;
    if (numeric) return `<c r="${reference}" s="${style}"><v>${prepared}</v></c>`;
    // Literal inline strings are deliberately used even for values beginning with =, +, - or @.
    const text = typeof prepared === 'object' ? JSON.stringify(prepared) : String(prepared);
    return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(text.slice(0, 32767))}</t></is></c>`;
  };
  const rowXML = [
    `<row r="1" ht="32" customHeight="1">${cell(title, 'A1', 'text', 1)}</row>`,
    `<row r="2" ht="${textHeight(description, fullWidth, 34)}" customHeight="1">${cell(description, 'A2', 'text', 8)}</row>`,
    '<row r="3" ht="8" customHeight="1"/>',
    `<row r="4" ht="28" customHeight="1">${columns.map((column, i) => cell(column.label, `${colName(i)}4`, 'text', 2)).join('')}</row>`,
  ];
  rows.forEach((row, index) => rowXML.push(`<row r="${index + 5}" ht="${Math.max(...columns.map((column, i) => textHeight(row[column.key], columnWidths[i])))}" customHeight="1">${columns.map((column, i) => cell(row[column.key], `${colName(i)}${index + 5}`, columnFormat(column, row))).join('')}</row>`));
  if (footnote) rowXML.push(`<row r="${rows.length + 6}" ht="${textHeight(footnote, fullWidth, 42)}" customHeight="1">${cell(footnote, `A${rows.length + 6}`, 'text', 8)}</row>`);
  const merges = [`A1:${last}1`, `A2:${last}2`, ...(footnote ? [`A${rows.length + 6}:${last}${rows.length + 6}`] : [])];
  return `${XML}<worksheet xmlns="${NS}"><dimension ref="A1:${last}${rows.length + (footnote ? 6 : 4)}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/><cols>${columns.map((column, i) => `<col min="${i + 1}" max="${i + 1}" width="${columnWidths[i]}" customWidth="1"/>`).join('')}</cols><sheetData>${rowXML.join('')}</sheetData><autoFilter ref="A4:${colName(columns.length - 1)}${rows.length + 4}"/><mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells><printOptions horizontalCentered="1"/><pageMargins left="0.3" right="0.3" top="0.45" bottom="0.45" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;LEDGAR Terminal&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter></worksheet>`;
}

function stylesXML() {
  const formats = [[164, '#,##0.00;[Red](#,##0.00);0.00'], [165, '$#,##0;[Red]($#,##0);$0'], [166, '0.00%;[Red](0.00%);0.00%'], [167, '0.00"x";[Red](0.00"x");0.00"x"'], [168, 'yyyy-mm-dd']];
  const xf = (font = 0, fill = 0, num = 0, vertical = 'top') => `<xf numFmtId="${num}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="${vertical}" wrapText="1"/></xf>`;
  return `${XML}<styleSheet xmlns="${NS}"><numFmts count="5">${formats.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xml(code)}"/>`).join('')}</numFmts><fonts count="4"><font><sz val="11"/><color rgb="FF17243B"/><name val="Calibri"/></font><font><b/><sz val="19"/><color rgb="FF17243B"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF526178"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17243B"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0F4F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9">${xf()}${xf(1)}${xf(2, 2, 0, 'center')}${xf(0, 0, 164)}${xf(0, 0, 165)}${xf(0, 0, 166)}${xf(0, 0, 167)}${xf(0, 0, 168)}${xf(3, 3)}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

/** XLSX is generated inside the export worker. All holdings remain in the workbook. */
export async function createReportXlsx(report) {
  validate(report);
  const summaryRows = [
    { item: 'Entity', value: report.entity.name }, { item: 'Report type', value: KIND_LABELS[report.kind] },
    { item: 'Ticker / identifier', value: report.entity.ticker || report.entity.id }, { item: 'SEC CIK', value: report.entity.cik },
    ...(report.entity.seriesId ? [{ item: 'SEC series', value: report.entity.seriesId }] : []),
    { item: 'Reporting basis', value: report.period.basis || report.period.label },
    { item: 'Period ending', value: report.period.asOf, format: 'date' }, { item: report.kind === 'company' ? 'Latest source filing' : 'Filed', value: report.period.filingDate, format: 'date' },
    { item: 'Generated at (UTC)', value: report.generatedAt }, { item: 'Coverage', value: report.coverage.status, detail: report.coverage.message },
    ...report.summary.map((metric) => ({ item: metric.label, value: metric.value, format: metric.unit, detail: metric.detail, sources: metric.sourceIds?.join(', ') })),
    ...report.highlights.map((item) => ({ item: item.title, value: item.text })),
    ...report.notes.map((note, i) => ({ item: `Note ${i + 1}`, value: note })),
  ];
  const sheets = [{ title: 'Report summary', description: `${report.title} | ${report.entity.name}. Blank numeric cells mean unavailable, never zero. Currency values are whole USD; percent cells contain fractions.`, columns: [{ key: 'item', label: 'Item', format: 'text', width: 38 }, { key: 'value', label: 'Value', format: 'text', formatKey: 'format', width: 55 }, { key: 'detail', label: 'Context', format: 'text', width: 70 }, { key: 'sources', label: 'Source IDs', format: 'text', width: 26 }], rows: summaryRows }, ...report.sections];
  if (report.charts?.length) sheets.push({ title: 'Chart data', description: 'Underlying reported or calculated observations used in the PDF charts.', columns: [{ key: 'chart', label: 'Chart', format: 'text', width: 42 }, { key: 'label', label: 'Observation', format: 'text', width: 35 }, { key: 'value', label: 'Value', format: 'number', formatKey: 'format' }, { key: 'format', label: 'Unit', format: 'text', width: 15 }], rows: report.charts.flatMap((chart) => chart.points.map((point) => ({ chart: chart.title, ...point, format: chart.unit }))) });
  sheets.push({ title: 'Sources', description: 'Original source register. Match these IDs to metric and section references. Reporting dates and filing dates are distinct.', columns: [{ key: 'id', label: 'Source ID', format: 'text', width: 18 }, { key: 'label', label: 'Source', format: 'text', width: 45 }, { key: 'url', label: 'Original URL', format: 'text', width: 72 }, { key: 'form', label: 'Form', format: 'text', width: 14 }, { key: 'periodEnd', label: 'Period ending', format: 'date', width: 18 }, { key: 'filed', label: 'Filed', format: 'date', width: 18 }, { key: 'accession', label: 'Accession', format: 'text', width: 28 }, { key: 'concept', label: 'Source concept', format: 'text', width: 58 }, { key: 'unit', label: 'Source unit', format: 'text', width: 16 }, { key: 'value', label: 'Source value', format: 'number', width: 25 }, { key: 'start', label: 'Period start', format: 'date', width: 18 }, { key: 'note', label: 'Notes', format: 'text', width: 65 }], rows: report.sources });
  const names = new Set(), files = {}, entries = [], relationships = [], overrides = [];
  sheets.forEach((sheet, index) => {
    const base = String(sheet.title || `Section ${index + 1}`).replace(/[\\/?*:[\]]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Section';
    let name = base;
    for (let suffix = 2; names.has(name.toLowerCase()); suffix++) name = `${base.slice(0, 27)} ${suffix}`.slice(0, 31);
    names.add(name.toLowerCase());
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(worksheet(sheet));
    entries.push(`<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`);
    relationships.push(`<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`);
    overrides.push(`<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  });
  files['xl/workbook.xml'] = strToU8(`${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${entries.join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="0"/></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`${XML}<Relationships xmlns="${PKG}">${relationships.join('')}<Relationship Id="rStyles" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
  files['_rels/.rels'] = strToU8(`${XML}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files['xl/styles.xml'] = strToU8(stylesXML());
  files['[Content_Types].xml'] = strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides.join('')}</Types>`);
  return zipSync(files, { level: 6 });
}

const COLORS = { navy: rgb(0.075, 0.13, 0.22), ink: rgb(0.11, 0.16, 0.23), muted: rgb(0.36, 0.41, 0.48), gold: rgb(0.84, 0.63, 0.16), pale: rgb(0.94, 0.96, 0.975), line: rgb(0.82, 0.86, 0.90), teal: rgb(0.12, 0.48, 0.48), red: rgb(0.70, 0.27, 0.27), white: rgb(1, 1, 1) };

/** Structured, paginated PDF with vector charts and searchable text. */
export async function createReportPdf(report, options = {}) {
  validate(report);
  const doc = await PDFDocument.create();
  doc.setTitle(`${report.entity.name} - ${report.title}`); doc.setAuthor('EDGAR Terminal'); doc.setSubject(report.subtitle); doc.setCreator('EDGAR Terminal Reports');
  const generated = new Date(report.generatedAt); if (Number.isFinite(generated.getTime())) doc.setCreationDate(generated);
  let regular, bold;
  if (options.fontBytes && options.boldFontBytes) {
    doc.registerFontkit(fontkit);
    regular = await doc.embedFont(options.fontBytes, { subset: true });
    bold = await doc.embedFont(options.boldFontBytes, { subset: true });
  } else {
    regular = await doc.embedFont(StandardFonts.Helvetica);
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  }
  const regularChars = new Set(regular.getCharacterSet()), boldChars = new Set(bold.getCharacterSet());
  let replacedGlyphs = false;
  const pdfText = (value) => Array.from(String(value ?? '').normalize('NFC')).map((char) => {
    if (char === '\n') return char;
    if (char === '\t') return ' ';
    if (char.codePointAt(0) < 32) return '';
    if (regularChars.has(char.codePointAt(0)) && boldChars.has(char.codePointAt(0))) return char;
    const normalized = char.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (Array.from(normalized).every((item) => regularChars.has(item.codePointAt(0)) && boldChars.has(item.codePointAt(0)))) return normalized;
    replacedGlyphs = true;
    return '?';
  }).join('');
  const W = 595.28, H = 841.89, M = 44, CONTENT = W - M * 2, BOTTOM = 52;
  let page, y, sectionLabel = 'Overview';
  const fit = (value, width, size, font = regular) => {
    const text = pdfText(value), paragraphs = text.split('\n'), lines = [];
    for (const paragraph of paragraphs) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (font.widthOfTextAtSize(word, size) > width) {
          if (line) { lines.push(line); line = ''; }
          let fragment = '';
          for (const letter of word) {
            if (font.widthOfTextAtSize(fragment + letter, size) > width && fragment) { lines.push(fragment); fragment = ''; }
            fragment += letter;
          }
          line = fragment;
        } else if (line && font.widthOfTextAtSize(`${line} ${word}`, size) > width) { lines.push(line); line = word; }
        else line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
    }
    return lines.length ? lines : [''];
  };
  const draw = (text, x, top, size = 9, font = regular, color = COLORS.ink) => page.drawText(pdfText(text), { x, y: top - size, size, font, color });
  const rect = (x, top, width, height, color) => page.drawRectangle({ x, y: top - height, width, height, color });
  const rule = (top, color = COLORS.line) => page.drawLine({ start: { x: M, y: top }, end: { x: W - M, y: top }, thickness: 0.6, color });
  const newPage = () => {
    page = doc.addPage([W, H]);
    rect(0, H, W, 5, COLORS.navy);
    draw('EDGAR / TERMINAL', M, H - 25, 9, bold, COLORS.navy);
    const right = `${report.entity.ticker || report.entity.id}  /  ${sectionLabel}`;
    const line = fit(right, CONTENT * 0.62, 7, regular)[0];
    draw(line, W - M - regular.widthOfTextAtSize(line, 7), H - 27, 7, regular, COLORS.muted);
    rule(H - 45); y = H - 64;
  };
  const ensure = (height) => { if (y - height < BOTTOM) { newPage(); return true; } return false; };
  const paragraph = (text, { size = 9, font = regular, color = COLORS.muted, after = 10, indent = 0 } = {}) => {
    const lines = fit(text, CONTENT - indent, size, font), leading = size * 1.45;
    for (const line of lines) { ensure(leading); draw(line, M + indent, y, size, font, color); y -= leading; }
    y -= after;
  };
  const heading = (title, label) => {
    sectionLabel = title; ensure(76);
    if (label) { draw(label.toUpperCase(), M, y, 7, bold, COLORS.gold); y -= 16; }
    paragraph(title, { size: 17, font: bold, color: COLORS.navy, after: 8 });
  };
  newPage();
  draw(KIND_LABELS[report.kind], M, y, 8, bold, COLORS.gold); y -= 26;
  paragraph(report.entity.name, { size: 27, font: bold, color: COLORS.navy, after: 6 });
  paragraph(report.subtitle, { size: 10, after: 14 });
  const identity = [report.entity.ticker, `CIK ${report.entity.cik}`, report.entity.seriesId].filter(Boolean).join('  |  ');
  paragraph(identity, { size: 8, after: 9 });
  paragraph(`${report.period.label}  |  Period ending ${report.period.asOf || 'unavailable'}  |  ${report.kind === 'company' ? 'Latest source filing' : 'Filed'} ${report.period.filingDate || 'unavailable'}`, { size: 8, font: bold, after: 16 });
  rule(y); y -= 18;
  const cards = report.summary.slice(0, 6), cardGap = 13, cardWidth = (CONTENT - 2 * cardGap) / 3;
  for (let index = 0; index < cards.length; index += 3) {
    const group = cards.slice(index, index + 3), prepared = group.map((metric) => ({ metric, labels: fit(metric.label, cardWidth - 20, 8, bold), details: fit([metric.detail, metric.sourceIds?.length ? `[${metric.sourceIds.join(', ')}]` : ''].filter(Boolean).join(' '), cardWidth - 20, 7) }));
    const cardHeight = Math.max(...prepared.map((item) => 57 + item.labels.length * 11 + item.details.length * 10)); ensure(cardHeight + 14);
    prepared.forEach(({ metric, labels, details }, offset) => {
      const x = M + offset * (cardWidth + cardGap); rect(x, y, cardWidth, cardHeight, COLORS.pale); rect(x, y, 3, cardHeight, COLORS.gold);
      let top = y - 12;
      labels.forEach((line) => { draw(line, x + 11, top, 8, bold); top -= 11; }); top -= 8;
      const value = formatReportValue(metric.value, metric.unit, true), valueSize = Math.min(20, (cardWidth - 22) / Math.max(1, regular.widthOfTextAtSize(pdfText(value), 1)));
      draw(value, x + 11, top, valueSize, bold, COLORS.navy); top -= 31;
      details.forEach((line) => { draw(line, x + 11, top, 7, regular, COLORS.muted); top -= 10; });
    }); y -= cardHeight + 14;
  }
  if (report.summary.length > 6) paragraph('Additional measures are included in the detailed tables and Excel workbook.', { size: 8 });
  paragraph(report.coverage.message, { size: 8, color: COLORS.muted, after: 16 });
  if (report.highlights.length) {
    heading('At a glance');
    for (const item of report.highlights) {
      ensure(45); paragraph(item.title, { size: 10, font: bold, color: COLORS.navy, after: 3 }); paragraph(item.text, { size: 9, after: 11 });
    }
  }
  for (const chart of report.charts || []) {
    const points = chart.kind === 'bar' ? chart.points.filter((point) => finite(point.value)).slice(0, 12) : chart.points.slice(-12);
    if (!points.some((point) => finite(point.value))) continue;
    const height = chart.kind === 'bar' ? 50 + points.length * 26 : 190;
    ensure(height + 36); heading(chart.title); const top = y;
    if (chart.kind === 'bar') {
      const labelW = 155, valueW = 70, plotX = M + labelW, plotW = CONTENT - labelW - valueW;
      const low = Math.min(0, ...points.map((point) => point.value)), high = Math.max(0, ...points.map((point) => point.value)), span = high - low || 1;
      const xAt = (value) => plotX + (value - low) / span * plotW, zero = xAt(0);
      points.forEach((point, index) => {
        const rowTop = top - index * 26, labelLines = fit(point.label, labelW - 10, 8).slice(0, 2);
        labelLines.forEach((line, i) => draw(line, M, rowTop - i * 9, 8));
        rect(plotX, rowTop - 3, plotW, 9, COLORS.pale);
        rect(Math.min(zero, xAt(point.value)), rowTop - 3, Math.max(0.8, Math.abs(xAt(point.value) - zero)), 9, point.value < 0 ? COLORS.red : COLORS.teal);
        draw(formatReportValue(point.value, chart.unit, true), plotX + plotW + 9, rowTop, 8, bold);
      }); y -= points.length * 26 + 18;
    } else {
      const plotX = M + 57, plotW = CONTENT - 70, plotH = 123, plotTop = top - 8;
      const values = points.map((point) => point.value).filter(finite), low = Math.min(0, ...values), high = Math.max(0, ...values), span = high - low || 1;
      const yAt = (value) => plotTop - plotH + (value - low) / span * plotH;
      for (let tick = 0; tick < 3; tick++) { const value = low + span * tick / 2, gridY = yAt(value); page.drawLine({ start: { x: plotX, y: gridY }, end: { x: plotX + plotW, y: gridY }, thickness: 0.5, color: COLORS.line }); draw(formatReportValue(value, chart.unit, true), M, gridY + 4, 7); }
      points.forEach((point, index) => { if (!finite(point.value)) return; const x = plotX + index / Math.max(1, points.length - 1) * plotW, py = yAt(point.value); if (index && finite(points[index - 1].value)) page.drawLine({ start: { x: plotX + (index - 1) / Math.max(1, points.length - 1) * plotW, y: yAt(points[index - 1].value) }, end: { x, y: py }, thickness: 2, color: COLORS.teal }); page.drawCircle({ x, y: py, size: 2.5, color: COLORS.teal }); if (index === 0 || index === points.length - 1 || index === Math.floor(points.length / 2)) draw(point.label, Math.min(x - 16, W - M - 48), plotTop - plotH - 10, 7); });
      y -= 165;
    }
  }
  for (const [sectionIndex, section] of report.sections.entries()) {
    if (section.pdfRowLimit === 0) continue;
    const rows = section.rows.slice(0, section.pdfRowLimit ?? 50), columns = section.columns;
    ensure(110); heading(section.title, `Detail ${String(sectionIndex + 1).padStart(2, '0')}`);
    if (section.description) paragraph(section.description, { size: 8, after: 12 });
    const weights = columns.map((column) => column.width ? (column.width < 10 ? column.width * 15 : column.width) : (column.format === 'text' ? 34 : 23)), totalW = weights.reduce((sum, value) => sum + value, 0), widths = weights.map((value) => value / totalW * CONTENT);
    const size = columns.length > 6 ? 6.5 : 7.5, leading = size * 1.35, pad = 7;
    const headerLines = columns.map((column, i) => fit(column.label, widths[i] - 2 * pad, size, bold));
    const headerHeight = Math.max(...headerLines.map((lines) => lines.length)) * leading + 15;
    const header = () => { rect(M, y, CONTENT, headerHeight, COLORS.navy); let x = M; headerLines.forEach((lines, i) => { lines.forEach((line, n) => draw(line, x + pad, y - pad - n * leading, size, bold, COLORS.white)); x += widths[i]; }); y -= headerHeight; };
    ensure(headerHeight + 34); header();
    if (!rows.length) { paragraph('No compatible observations were available for this section.', { size: 8, after: 12 }); }
    for (const [rowIndex, row] of rows.entries()) {
      const lines = columns.map((column, i) => fit(formatReportValue(row[column.key], columnFormat(column, row), columns.length > 6 && columnFormat(column, row) === 'usd'), widths[i] - pad * 2, size));
      // Continue unusually long cells over multiple pages without clipping or losing text.
      let offset = 0, maxLines = Math.max(...lines.map((item) => item.length));
      while (offset < maxLines) {
        if (y - (leading + pad * 2) < BOTTOM) { newPage(); header(); }
        const available = Math.max(1, Math.floor((y - BOTTOM - pad * 2) / leading));
        const count = Math.min(maxLines - offset, available), rowHeight = count * leading + pad * 2;
        if (rowIndex % 2 === 0) rect(M, y, CONTENT, rowHeight, COLORS.pale);
        let x = M;
        lines.forEach((values, columnIndex) => { values.slice(offset, offset + count).forEach((line, n) => draw(line, x + pad, y - pad - n * leading, size, regular, COLORS.ink)); x += widths[columnIndex]; });
        y -= rowHeight; offset += count;
        rule(y);
      }
    }
    y -= 12;
    if (section.rows.length > rows.length) paragraph(`Showing ${rows.length.toLocaleString()} of ${section.rows.length.toLocaleString()} records. The Excel workbook includes every available row.`, { size: 8, after: 8 });
    if (columns.length > 6) paragraph('Large currency amounts are abbreviated for readability. The Excel workbook retains exact values.', { size: 7.5, after: 8 });
    if (section.footnote) paragraph(section.footnote, { size: 7.5, after: 16 });
  }
  if (report.notes.length) { heading('Reading this report', 'Methodology & coverage'); for (const note of report.notes) paragraph(note, { size: 8, after: 8 }); }
  heading('Source register', 'Original public records');
  paragraph('Source IDs connect measures to the original disclosures. The Excel source register includes the source concept, original unit and observation where available.', { size: 8 });
  const groupedSources = new Map();
  for (const source of report.sources) {
    const key = source.url || source.id;
    if (!groupedSources.has(key)) groupedSources.set(key, { ...source, ids: [] });
    groupedSources.get(key).ids.push(source.id);
  }
  for (const source of groupedSources.values()) {
    ensure(62); paragraph(`${source.form || 'Source document'}${source.accession ? ` · ${source.accession}` : ` · ${source.label}`}`, { size: 8, font: bold, color: COLORS.navy, after: 2 });
    paragraph(`Source IDs: ${source.ids.join(', ')}`, { size: 7, after: 2 });
    const metadata = [source.form, source.periodEnd && `Period ${source.periodEnd}`, source.filed && `Filed ${source.filed}`, source.accession].filter(Boolean).join('  |  ');
    if (metadata) paragraph(metadata, { size: 7, after: 2 });
    paragraph(source.url, { size: 6.8, color: COLORS.teal, after: 8 });
  }
  if (replacedGlyphs) paragraph('A small number of characters could not be represented in this PDF font. The Excel workbook preserves the original text.', { size: 7 });
  const pages = doc.getPages();
  pages.forEach((p, index) => { page = p; rule(39); draw('Public data. Traceable research.  |  secedgarterminal.com', M, 28, 6.7, regular, COLORS.muted); const footer = `${String(report.generatedAt).slice(0, 10)}  ·  ${index + 1} / ${pages.length}`; draw(footer, W - M - regular.widthOfTextAtSize(pdfText(footer), 7), 28, 7, regular, COLORS.muted); });
  return doc.save();
}
