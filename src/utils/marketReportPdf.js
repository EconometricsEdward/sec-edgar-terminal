import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 0) => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : 'Unavailable';
const percent = (value, signed = false) => finite(value) ? `${signed && value > 0 ? '+' : ''}${number(value, value !== 0 && Math.abs(value) < .1 ? 3 : 1)}%` : 'Unavailable';
const pp = value => finite(value) ? `${value > 0 ? '+' : ''}${number(value, 1)} pp` : 'Unavailable';
const date = value => value ? String(value).slice(0, 10) : 'Unavailable';
const C = {
  navy: rgb(.055, .13, .19), ink: rgb(.09, .18, .23), muted: rgb(.36, .43, .46),
  teal: rgb(.08, .43, .40), gold: rgb(.68, .47, .13), red: rgb(.62, .25, .23),
  pale: rgb(.945, .961, .956), goldPale: rgb(.976, .951, .89), line: rgb(.81, .86, .85),
  white: rgb(1, 1, 1), quiet: rgb(.76, .84, .83), blue: rgb(.27, .45, .57),
};
const blend = (a, b, amount) => rgb(a.red * amount + b.red * (1 - amount), a.green * amount + b.green * (1 - amount), a.blue * amount + b.blue * (1 - amount));
const METRIC_LABELS = ['Revenue\ngrowth', 'Net\nmargin', 'Operating CF\n/ revenue', 'Capex\n/ revenue', 'Book equity\n/ assets'];

/** The Market page, translated into a finite, dated editorial report.
 * All plotting values in marketBriefing are percentage points; the flat
 * company/position sections retain fractional percentages for Excel. */
export async function createMarketReportPdf(report, options = {}) {
  const briefing = report.marketBriefing;
  if (!briefing?.coverage || !Array.isArray(briefing.sectors) || !Array.isArray(briefing.breadth)
    || !Array.isArray(briefing.positioning?.cards) || !Array.isArray(briefing.sectorMetrics)) {
    throw new Error('The market briefing is incomplete. Prepare the report again.');
  }
  const doc = await PDFDocument.create();
  doc.setTitle(`${report.entity.name} - ${report.title}`);
  doc.setAuthor('EDGAR Terminal'); doc.setSubject(report.subtitle); doc.setCreator('EDGAR Terminal Reports');
  const generated = new Date(report.generatedAt);
  if (Number.isFinite(generated.getTime())) doc.setCreationDate(generated);
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
  const safe = value => Array.from(String(value ?? '').normalize('NFC').replace(/[\u2010-\u2015\u2212]/g, '-')).map(char => {
    if (char === '\n') return char;
    if (char === '\t') return ' ';
    if (char.codePointAt(0) < 32) return '';
    if (regularChars.has(char.codePointAt(0)) && boldChars.has(char.codePointAt(0))) return char;
    const plain = char.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (Array.from(plain).every(item => regularChars.has(item.codePointAt(0)) && boldChars.has(item.codePointAt(0)))) return plain;
    replacedGlyphs = true;
    return '?';
  }).join('');
  const W = 595.28, H = 841.89, M = 40, CW = W - 2 * M, BOTTOM = 54;
  let page, y;
  const rect = (x, top, width, height, color) => page.drawRectangle({ x, y: top - height, width, height, color });
  const line = (x1, top, x2, color = C.line, thickness = .6) => page.drawLine({ start: { x: x1, y: top }, end: { x: x2, y: top }, color, thickness });
  const draw = (value, x, top, size = 9, font = regular, color = C.ink) => page.drawText(safe(value), { x, y: top - size, size, font, color });
  const right = (value, x, top, size = 9, font = regular, color = C.ink) => draw(value, x - font.widthOfTextAtSize(safe(value), size), top, size, font, color);
  const wrap = (value, width, size = 9, font = regular) => {
    const lines = [];
    for (const paragraph of safe(value).split('\n')) {
      let current = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (font.widthOfTextAtSize(word, size) > width) {
          if (current) { lines.push(current); current = ''; }
          for (const char of word) {
            if (current && font.widthOfTextAtSize(current + char, size) > width) { lines.push(current); current = ''; }
            current += char;
          }
        } else if (current && font.widthOfTextAtSize(`${current} ${word}`, size) > width) { lines.push(current); current = word; }
        else current = current ? `${current} ${word}` : word;
      }
      lines.push(current);
    }
    return lines;
  };
  const block = (value, x, top, width, { size = 9, font = regular, color = C.muted, leading = size * 1.4, limit } = {}) => {
    const all = wrap(value, width, size, font), lines = limit ? all.slice(0, limit) : all;
    if (limit && all.length > limit) {
      let last = lines[limit - 1];
      while (last && font.widthOfTextAtSize(`${last}...`, size) > width) last = last.slice(0, -1);
      lines[limit - 1] = `${last}...`;
    }
    lines.forEach((text, i) => draw(text, x, top - i * leading, size, font, color));
    return lines.length * leading;
  };
  const sourceLink = (url, top) => {
    let display = url;
    try { const parsed = new URL(url); display = `${parsed.origin}${parsed.pathname}`; } catch { /* Preserve malformed input as text. */ }
    const height = block(display, M, top, CW, { size: 7.2, leading: 10, color: C.teal });
    if (/^https:\/\//.test(url)) {
      const annotation = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [M, top - height, W - M, top + 2], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) } }));
      const annotations = page.node.lookup(PDFName.of('Annots'));
      if (annotations) annotations.push(annotation);
      else page.node.set(PDFName.of('Annots'), doc.context.obj([annotation]));
    }
    return height;
  };
  const newPage = (title, section, subtitle = '') => {
    page = doc.addPage([W, H]);
    rect(0, H, W, 5, C.navy);
    draw('EDGAR / TERMINAL', M, H - 24, 9, bold, C.navy);
    right(`MARKET RESEARCH  /  ${date(report.generatedAt)}`, W - M, H - 26, 7, regular, C.muted);
    line(M, H - 45, W - M);
    draw(section.toUpperCase(), M, H - 64, 7.3, bold, C.gold);
    y = H - 83;
    y -= block(title, M, y, CW, { size: 25, font: bold, color: C.navy, leading: 30 });
    y -= 10;
    if (subtitle) { y -= block(subtitle, M, y, CW, { size: 9.3, leading: 13 }); y -= 15; }
  };
  const note = (value, { color = C.pale, accent = C.teal, size = 8.2 } = {}) => {
    const height = wrap(value, CW - 26, size).length * 11.5 + 22;
    rect(M, y, CW, height, color); rect(M, y, 2, height, accent);
    block(value, M + 13, y - 11, CW - 26, { size, leading: 11.5 }); y -= height + 14;
  };
  const coverage = briefing.coverage, basis = report.period.basis === 'ttm' ? 'Latest TTM' : 'Latest annual';
  const sectors = briefing.sectors, metrics = briefing.sectorMetrics.slice(0, 5);
  const rankSectors = [...sectors].sort((a, b) => {
    const av = a.metrics?.revenueGrowth?.median, bv = b.metrics?.revenueGrowth?.median;
    return finite(av) ? finite(bv) ? bv - av || a.label.localeCompare(b.label) : -1 : finite(bv) ? 1 : a.label.localeCompare(b.label);
  });
  const companies = report.sections.find(section => section.id === 'market-companies')?.rows || [];

  // 01. A real briefing on page one, with the Market page's breadth readout.
  newPage('The market, in context.', '01 / Market Briefing');
  rect(M, y + 5, CW, 141, C.navy);
  draw('BUSINESS CONDITIONS  /  SEC FUNDAMENTALS', M + 19, y - 11, 7.3, bold, C.quiet);
  const growth = briefing.breadth.find(item => item.id === 'revenueGrowth' || /revenue/i.test(item.label));
  const headline = finite(growth?.share) ? `${percent(growth.share * 100)} of companies\ngrew revenue.` : 'The business picture,\nsector by sector.';
  block(headline, M + 19, y - 35, CW - 38, { size: 25, leading: 32, font: bold, color: C.white });
  block(growth?.count ? `${number(growth.count)} comparable businesses. ${basis} financial results, with equal issuer weights.` : 'Comparable revenue observations are unavailable. Read the available sector metrics below.', M + 19, y - 110, CW - 38, { size: 8.5, color: C.quiet, leading: 12 });
  y -= 153;
  const coverageCards = [
    ['Covered companies', coverage.companyCount, finite(coverage.requestedCount) ? `of ${number(coverage.requestedCount)} requested` : 'Prepared research universe'],
    ['Primary sectors', coverage.sectorCount, `${number(coverage.missingSectorCount)} unclassified companies`],
    ['SEC SIC industries', coverage.industryCount, `${number(coverage.missingIndustryCount)} companies without SIC`],
  ];
  const gap = 10, cardW = (CW - 2 * gap) / 3;
  coverageCards.forEach(([label, value, detail], i) => {
    const x = M + i * (cardW + gap);
    rect(x, y, cardW, 82, C.pale);
    draw(label, x + 12, y - 10, 8, bold);
    draw(number(value), x + 12, y - 27, 23, bold, C.navy);
    block(detail, x + 12, y - 58, cardW - 24, { size: 7, leading: 9, limit: 2 });
  });
  y -= 104;
  draw('HOW BROAD IS THE STRENGTH?', M, y, 8, bold, C.gold); y -= 24;
  briefing.breadth.slice(0, 3).forEach((item, i) => {
    draw(item.label, M, y, 10, bold);
    right(finite(item.share) ? percent(item.share * 100) : 'Unavailable', W - M, y, 14, bold, C.navy);
    rect(M, y - 22, CW, 6, C.pale);
    if (finite(item.share)) rect(M, y - 22, Math.max(0, Math.min(1, item.share)) * CW, 6, [C.teal, C.gold, C.blue][i]);
    draw(`${number(item.positive)} / ${number(item.count)} available  |  ${item.context}`, M, y - 34, 7, regular, C.muted);
    y -= 60;
  });
  const leaders = briefing.growthLeaders || {};
  draw('REVENUE GROWTH / SECTOR MEDIANS', M, y, 8, bold, C.gold);
  if (finite(leaders.spreadPp)) right(`${number(leaders.spreadPp, 1)} pp spread`, W - M, y, 8, bold, C.navy);
  y -= 20;
  [leaders.highest, leaders.lowest].forEach((item, i) => {
    const x = M + i * ((CW + 12) / 2), width = (CW - 12) / 2;
    rect(x, y, width, 74, i ? C.goldPale : C.pale);
    draw(i ? 'LOWEST' : 'HIGHEST', x + 12, y - 10, 6.5, bold, C.muted);
    block(item?.sector || 'Unavailable', x + 12, y - 24, width - 90, { size: 9, font: bold, color: C.ink, leading: 11, limit: 2 });
    right(percent(item?.value), x + width - 12, y - 24, 18, bold, C.navy);
    draw(item ? `${number(item.count)} / ${number(item.companies)} companies` : 'No comparable sector median', x + 12, y - 54, 7, regular, C.muted);
  });
  y -= 88;
  block(`SEC snapshot ${date(coverage.snapshotAt)}. Financial periods ${coverage.reportRange ? `${coverage.reportRange.earliest} to ${coverage.reportRange.latest}` : 'unavailable'}. ${number(coverage.olderReports)} older or unavailable reporting periods. This is a covered-company snapshot; sector performance means reported fundamentals, not security-price returns.`, M, y, CW, { size: 7.6, leading: 10.5 });

  // 02. The six fixed macro lenses from the Market page, never an invented basket.
  newPage('Six windows into the macro market.', '02 / CFTC Positioning', 'Rates, currencies, equity indices and real assets through reported futures positions. Each observation retains its own trader group and report date.');
  const position = briefing.positioning;
  const familyLine = position.families.map(family => `${family.label}: ${family.valid ? family.reportDate : 'unavailable'}${family.aged ? ' (older report)' : family.stale ? ' (preserved)' : ''}`).join('    /    ');
  rect(M, y, CW, 29, C.pale); draw(familyLine, M + 10, y - 9, 7.5, bold);
  right(`${number(position.availableCount)} / 6 observations`, W - M - 10, y - 9, 7.5, regular, C.muted); y -= 41;
  const posW = (CW - 14) / 2, posH = 164;
  position.cards.slice(0, 6).forEach((card, i) => {
    const x = M + (i % 2) * (posW + 14), top = y - Math.floor(i / 2) * (posH + 12);
    const tone = finite(card.netPctOi) && card.netPctOi < 0 ? C.gold : C.teal;
    rect(x, top, posW, posH, C.pale); rect(x, top, posW, 3, tone);
    draw(card.category.toUpperCase(), x + 12, top - 12, 7, bold, tone);
    block(card.label, x + 12, top - 30, posW - 24, { size: 11, font: bold, color: C.navy, leading: 13, limit: 2 });
    draw(`${card.groupLabel}  /  ${card.familyLabel}`, x + 12, top - 60, 7.2, regular, C.muted);
    draw(percent(card.netPctOi, true), x + 12, top - 78, finite(card.netPctOi) ? 25 : 16, bold, tone);
    right('net / open interest', x + posW - 12, top - 91, 6.8, regular, C.muted);
    const bx = x + 12, bw = posW - 24, zero = bx + bw / 2;
    rect(bx, top - 112, bw, 6, C.line);
    if (finite(card.netPctOi)) {
      const bar = Math.min(100, Math.abs(card.netPctOi)) / 200 * bw;
      rect(card.netPctOi < 0 ? zero - bar : zero, top - 112, bar, 6, tone);
    }
    page.drawLine({ start: { x: zero, y: top - 110 }, end: { x: zero, y: top - 120 }, thickness: .7, color: C.muted });
    draw(finite(card.weeklyChange) ? `${pp(card.weeklyChange)}  /  one-week change` : 'Weekly comparison unavailable', x + 12, top - 129, 8, bold, C.ink);
    draw(`${date(card.reportDate)}  /  ${card.code}${card.aged ? '  /  older report' : card.stale ? '  /  preserved' : ''}`, x + 12, top - 148, 6.7, regular, C.muted);
  });
  y -= Math.ceil(Math.min(6, position.cards.length) / 2) * (posH + 12);
  if (position.largestMove) {
    const item = position.largestMove;
    y -= block(`Largest weekly shift in this selection: ${item.label}, ${item.groupLabel}, ${pp(item.weeklyChange)}. Among ${number(position.comparableCount)} comparable observations dated ${date(item.reportDate)}.`, M, y, CW, { size: 8, color: C.ink, leading: 11 }) + 8;
  }
  block(`${position.differentReportDates ? 'Report families have different dates; read each observation at its stated date. ' : ''}Bars use a common -100% to +100% scale centered at zero. Teal = net long; gold = net short. Changes are percentage points of each contract's open interest, not investment flows or price forecasts. Futures only.`, M, y, CW, { size: 7.4, leading: 10 });

  // The positioning workspace compares all participant categories, not only
  // the two default macro lenses. Keep each family and contract separate.
  const allGroups = report.sections.find(section => section.id === 'cftc-all-groups')?.rows || [];
  for (const family of ['tff', 'disaggregated']) {
    const familyRows = allGroups.filter(row => row.familyId === family);
    const groups = [...new Map(familyRows.map(row => [row.groupId, row.group])).entries()];
    const contracts = new Map();
    for (const row of familyRows) {
      if (!row.sourceRowId && ![row.openInterest, row.long, row.short, row.net].some(finite)) continue;
      const key = `${row.code}:${row.reportDate}`;
      if (!contracts.has(key)) contracts.set(key, { code: row.code, market: row.market, reportDate: row.reportDate, values: new Map() });
      contracts.get(key).values.set(row.groupId, row.netOi);
    }
    if (!contracts.size || !groups.length) continue;
    const title = family === 'tff' ? 'Who holds financial futures?' : 'Who holds commodity futures?';
    const subtitle = `${family === 'tff' ? 'Traders in Financial Futures' : 'Disaggregated'} / Futures only. Net positions as a share of each contract's open interest, across every reported trader group.`;
    newPage(title, '02 / CFTC Positioning / Participant Heatmap', subtitle);
    const labelWidth = 178, cellWidth = (CW - labelWidth) / groups.length;
    const groupHeaders = {
      dealer: 'Dealer /\nintermediary', 'asset-manager': 'Asset manager /\ninstitutional',
      'producer-merchant': 'Producer /\nmerchant /\nprocessor / user', 'non-reportables': 'Non-\nreportables',
    };
    const participantHeader = () => {
      rect(M, y, CW, 42, C.navy);
      draw('CONTRACT / REPORT DATE', M + 8, y - 15, 6.8, bold, C.white);
      groups.forEach(([id, label], i) => block(groupHeaders[id] || label, M + labelWidth + i * cellWidth + 7, y - 8, cellWidth - 14, { size: 6.5, font: bold, color: C.white, leading: 9 }));
      y -= 42;
    };
    participantHeader();
    for (const contract of contracts.values()) {
      const lines = wrap(contract.market, labelWidth - 16, 7.8, bold);
      const height = Math.max(38, lines.length * 10 + 22);
      if (y - height < 128) { newPage(`${title.replace('?', '')}, continued`, '02 / CFTC Positioning / Participant Heatmap', subtitle); participantHeader(); }
      rect(M, y, labelWidth, height, C.pale);
      block(contract.market, M + 8, y - 7, labelWidth - 16, { size: 7.8, font: bold, color: C.ink, leading: 10 });
      draw(`${date(contract.reportDate)} / ${contract.code}`, M + 8, y - 10 - lines.length * 10, 6.2, regular, C.muted);
      groups.forEach(([id], i) => {
        const value = contract.values.get(id), x = M + labelWidth + i * cellWidth;
        const tone = finite(value) ? blend(value < 0 ? C.gold : C.teal, C.white, Math.min(.3, .045 + Math.abs(value) * .5)) : C.white;
        rect(x, y, cellWidth, height, tone);
        right(finite(value) ? percent(value * 100, true) : 'N/A', x + cellWidth - 9, y - height / 2 + 5, 9, bold, finite(value) && value < 0 ? C.gold : C.navy);
      });
      y -= height; line(M, y, W - M, C.white, 1);
    }
    y -= 17;
    block('Teal indicates net long; gold indicates net short. Color intensity reflects the size of net / open interest, not a risk score. Trader groups can hold offsetting positions, and positions may hedge other exposures. These groups have different definitions across the two report families. Catalog-only contracts are excluded from this view and retained in Excel; missing figures stay unavailable.', M, y, CW, { size: 8, leading: 11.3 });
  }

  // 03. Sorted growth bars preserve the same equal-issuer statistic as the page.
  newPage('Where is performance diverging?', '03 / Sector Performance', `${basis} company fundamentals. Median revenue growth by primary sector; equal issuer weights and each sector's own comparable-company count.`);
  const maxGrowth = Math.max(1, ...sectors.map(sector => Math.abs(sector.metrics?.revenueGrowth?.median || 0)));
  const rankHeader = () => {
    rect(M, y, CW, 25, C.navy);
    draw('SECTOR / COMPANY COVERAGE', M + 10, y - 8, 7, bold, C.white);
    right('MEDIAN GROWTH', W - M - 10, y - 8, 7, bold, C.white); y -= 30;
  };
  rankHeader();
  rankSectors.forEach((sector, i) => {
    if (y - 43 < 135) { newPage('Sector revenue growth, continued', '03 / Sector Performance'); rankHeader(); }
    const stats = sector.metrics?.revenueGrowth || {}, value = stats.median;
    if (i % 2 === 0) rect(M, y, CW, 42, C.pale);
    draw(String(i + 1).padStart(2, '0'), M + 9, y - 11, 8, regular, C.muted);
    block(sector.label, M + 34, y - 7, 182, { size: 9, font: bold, color: C.ink, leading: 11, limit: 1 });
    draw(`${number(stats.count)} / ${number(sector.count)} with data`, M + 34, y - 24, 7, regular, C.muted);
    const px = M + 230, pw = 190, zero = px + pw / 2;
    rect(px, y - 18, pw, 6, C.line);
    if (finite(value)) {
      const length = Math.abs(value) / maxGrowth * pw / 2;
      rect(value < 0 ? zero - length : zero, y - 16, length, 10, value < 0 ? C.gold : C.teal);
    }
    page.drawLine({ start: { x: zero, y: y - 11 }, end: { x: zero, y: y - 31 }, thickness: .6, color: C.muted });
    right(percent(value), W - M - 10, y - 13, finite(value) ? 11 : 7, bold, value < 0 ? C.gold : C.navy);
    y -= 43;
  });
  y -= 12;
  note('Revenue reflects both volumes and prices; this is not real GDP growth. The companies reporting the fastest growth do not necessarily have the highest margins, strongest cash generation or lowest financial risk. Read the five-metric comparison next.');
  block('The PDF includes every classified sector and a compact profile of each. The Excel workbook includes all companies, all SIC industries, all five sector measures and additional company screening metrics.', M, y, CW, { size: 8, leading: 11.3 });

  // 04. A compact matrix matches the five-column Sector Performance heatmap.
  newPage('Find the dispersion.', '04 / Sector Comparison', 'Read across each sector to connect growth, profits, cash generation, investment and book capital. Each cell shows the median and its own available-company denominator.');
  const labelW = 143, metricW = (CW - labelW) / 5;
  const matrixHeader = () => {
    rect(M, y, CW, 40, C.navy);
    draw('PRIMARY SECTOR', M + 9, y - 13, 7.3, bold, C.white);
    METRIC_LABELS.forEach((label, i) => block(label, M + labelW + i * metricW + 7, y - 8, metricW - 14, { size: 7, font: bold, color: C.white, leading: 10 }));
    y -= 40;
  };
  matrixHeader();
  sectors.forEach(sector => {
    if (y - 46 < 126) { newPage('Sector comparison, continued', '04 / Sector Comparison'); matrixHeader(); }
    rect(M, y, labelW, 46, C.pale);
    block(sector.label, M + 9, y - 8, labelW - 18, { size: 8.2, font: bold, color: C.ink, leading: 10, limit: 2 });
    draw(`${number(sector.count)} companies / ${number(sector.industries.length)} industries`, M + 9, y - 34, 6.3, regular, C.muted);
    metrics.forEach((metric, i) => {
      const stats = sector.metrics[metric.key] || {}, value = stats.median, x = M + labelW + i * metricW;
      const tone = finite(value) ? blend(value < 0 ? C.gold : C.teal, C.white, Math.min(.22, .05 + Math.abs(value) / 500)) : C.white;
      rect(x, y, metricW, 46, tone);
      draw(finite(value) ? percent(value) : 'N/A', x + 8, y - 9, 10.5, bold, finite(value) && value < 0 ? C.gold : C.navy);
      draw(`${number(stats.count)} / ${number(sector.count)}`, x + 8, y - 29, 6.8, regular, C.muted);
    });
    y -= 46; line(M, y, W - M, C.white, 1);
  });
  y -= 15;
  block(`Colors show numeric levels, not risk ratings. Companies have different fiscal periods. Financial-company margins, cash flows and capital structures are not directly comparable with industrial companies.${coverage.missingSectorCount ? ` ${number(coverage.missingSectorCount)} companies without a primary sector are excluded from sector comparisons.` : ''}`, M, y, CW, { size: 8, leading: 11.5 });

  // 05. Every primary sector receives an industry and company drill-down.
  const profile = (sector, top) => {
    const metricsTop = top - 47, profileH = 294;
    rect(M, top, CW, profileH, C.pale); rect(M, top, 3, profileH, C.teal);
    draw(sector.label, M + 13, top - 12, 16, bold, C.navy);
    right(`${number(sector.count)} companies  /  ${number(sector.industries.length)} industries`, W - M - 13, top - 17, 7, regular, C.muted);
    const cw = (CW - 26) / 5;
    metrics.forEach((metric, i) => {
      const x = M + 13 + i * cw, stats = sector.metrics[metric.key] || {};
      draw(['Growth', 'Net margin', 'Cash / revenue', 'Capex / revenue', 'Equity / assets'][i], x, metricsTop, 6.7, bold, C.muted);
      draw(percent(stats.median), x, metricsTop - 15, finite(stats.median) ? 13 : 8, bold, C.navy);
      draw(`n = ${number(stats.count)} / ${number(sector.count)}`, x, metricsTop - 34, 6.2, regular, C.muted);
    });
    line(M + 13, top - 93, W - M - 13);
    const leftW = 176, leftX = M + 13, rightX = M + 219, rightW = CW - 232;
    draw('LARGEST SIC INDUSTRIES', leftX, top - 107, 6.8, bold, C.gold);
    draw('FASTEST REVENUE GROWTH', rightX, top - 107, 7.1, bold, C.gold);
    const industries = [...(sector.industries || [])].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, 3);
    let iy = top - 128;
    industries.forEach(industry => {
      block(industry.label, leftX, iy, leftW - 40, { size: 7.3, color: C.ink, leading: 9, limit: 2 });
      right(number(industry.count), leftX + leftW - 8, iy, 10, bold, C.navy);
      draw(`SIC ${industry.code}  /  ${percent(sector.count ? 100 * industry.count / sector.count : null)}`, leftX, iy - 22, 6.5, regular, C.muted);
      iy -= 42;
    });
    if (!industries.length) block('SIC industries unavailable.', leftX, iy, leftW, { size: 8 });
    const selected = companies.filter(company => (company.sectorId ? company.sectorId === sector.id : company.sector === sector.label) && finite(company.revenueGrowth))
      .sort((a, b) => b.revenueGrowth - a.revenueGrowth || a.ticker.localeCompare(b.ticker)).slice(0, 5);
    if (!selected.length) block('Comparable company revenue growth is unavailable.', rightX, top - 128, rightW, { size: 8 });
    selected.forEach((company, i) => {
      const cy = top - 128 - i * 27;
      draw(company.ticker, rightX, cy, 8, bold, C.navy);
      right(percent(company.revenueGrowth * 100), W - M - 13, cy, 8.5, bold, C.teal);
      block(`${company.name} / ${date(company.periodEnd)}`, rightX, cy - 12, rightW, { size: 6.5, leading: 8, limit: 1 });
    });
    const growthStats = sector.metrics.revenueGrowth || {};
    draw(`Growing revenue: ${percent(growthStats.positivePct)} (${number(growthStats.positive)} / ${number(growthStats.count)} measured)`, leftX, top - 266, 7.5, bold, C.navy);
    const barW = CW - 26;
    rect(leftX, top - 283, barW, 5, C.line);
    if (finite(growthStats.positivePct)) rect(leftX, top - 283, barW * Math.min(100, Math.max(0, growthStats.positivePct)) / 100, 5, C.teal);
  };
  for (let offset = 0; offset < sectors.length; offset += 2) {
    newPage('Inside the sectors.', `05 / Company and Industry Profiles / ${Math.floor(offset / 2) + 1} of ${Math.ceil(sectors.length / 2)}`, 'Medians use all available companies. Industries are the three largest by issuer count; companies are the five highest revenue-growth observations. Full membership is in Excel.');
    for (const [index, sector] of sectors.slice(offset, offset + 2).entries()) profile(sector, y - index * 308);
    const footY = y - Math.min(2, sectors.length - offset) * 308;
    block('Company labels include financial-period end dates. Excel retains all covered issuers and SIC industries.', M, footY, CW, { size: 7.2, leading: 10 });
  }

  // Prepared CFTC detail stays separate by family and participant group.
  const heatmap = new Map((report.sections.find(section => section.id === 'cftc-heatmap')?.rows || [])
    .map(row => [`${row.familyId}:${row.code}:${row.groupId}:${row.reportDate}`, row]));
  for (const section of report.sections.filter(item => ['cftc-tff', 'cftc-disaggregated'].includes(item.id))) {
    const detailDescription = `${section.id === 'cftc-tff' ? 'Leveraged Funds' : 'Managed Money'} / Futures only. Current net positioning and its historical rank for every prepared contract in this family; observation dates appear beside each market.`;
    newPage(section.id === 'cftc-tff' ? 'Financial futures positioning.' : 'Commodity futures positioning.', '06 / CFTC Contract Detail', detailDescription);
    const widths = [190, 67, 63, 65, 65, CW - 450];
    const header = () => {
      rect(M, y, CW, 32, C.navy);
      let x = M;
      ['Contract / report date', 'Net / OI', '1-week\nchange', '1y prior\nrank', '3y prior\nrank', '5y prior\nrank'].forEach((label, i) => {
        block(label, x + 8, y - 8, widths[i] - 16, { size: 7.1, font: bold, color: C.white, leading: 9 }); x += widths[i];
      }); y -= 32;
    };
    header();
    if (!section.rows.length) { y -= 15; note('Prepared positions are unavailable for this report family. No positions have been inferred.'); }
    section.rows.forEach((row, i) => {
      const nameLines = wrap(row.market, widths[0] - 16, 8);
      const height = Math.max(38, nameLines.length * 10 + 24);
      if (y - height < 111) { newPage(`${section.title}, continued`, '06 / CFTC Contract Detail', detailDescription); header(); }
      if (i % 2 === 0) rect(M, y, CW, height, C.pale);
      block(row.market, M + 8, y - 8, widths[0] - 16, { size: 8, font: bold, color: C.ink, leading: 10 });
      draw(`${date(row.reportDate)} / ${row.code || 'Contract code unavailable'}`, M + 8, y - 11 - nameLines.length * 10, 6.5, regular, C.muted);
      let x = M + widths[0];
      [percent(finite(row.netOi) ? row.netOi * 100 : null, true), pp(row.oneWeekChangePp)].forEach((value, j) => {
        right(value, x + widths[j + 1] - 8, y - 10, value === 'Unavailable' ? 5.8 : 8, j === 0 ? bold : regular, j === 0 ? C.navy : C.ink); x += widths[j + 1];
      });
      const ranks = heatmap.get(`${row.familyId}:${row.code}:${row.groupId}:${row.reportDate}`);
      ['1y', '3y', '5y'].forEach((window, j) => {
        const rank = ranks?.[`rank${window}`], observed = ranks?.[`rank${window}N`], needed = ranks?.[`rank${window}Required`];
        if (finite(rank)) rect(x, y, widths[j + 3], height, blend(rank < .5 ? C.gold : C.teal, C.white, .04 + Math.abs(rank - .5) * .35));
        right(finite(rank) ? percent(rank * 100) : 'N/A', x + widths[j + 3] - 8, y - 8, 8.5, bold, C.navy);
        right(finite(observed) ? `${number(observed)} / ${number(needed)}` : 'No history', x + widths[j + 3] - 8, y - 24, 6, regular, C.muted);
        x += widths[j + 3];
      });
      y -= height; line(M, y, W - M);
    });
    y -= 16;
    block('Net / OI = (long - short) / open interest. Weekly change is in percentage points, exactly seven days apart. Ranks compare the same contract and trader group with 52, 156 or 260 prior reports; the count below each rank is available / required. High rank means relatively higher net positioning, not a price forecast. N/A means history is insufficient or unavailable. Full positions, prior-date ranges and all trader groups are in Excel.', M, y, CW, { size: 7.6, leading: 10.6 });
  }

  // Full methodology is retained, but sources stay concise and readable.
  newPage('Coverage, methods and sources.', '07 / Reading This Report', 'A dated view of the covered research universe. SEC financial periods, snapshot times and CFTC observation dates describe different things.');
  const methodNotes = report.notes || [];
  const colGap = 24, colW = (CW - colGap) / 2;
  let colIndex = 0, cy = y, methodTop = y;
  const methodBottom = 263;
  for (const [index, text] of methodNotes.entries()) {
    const height = wrap(text, colW - 17, 7.7).length * 10.4 + 13;
    if (cy - height < methodBottom && colIndex === 0) { colIndex = 1; cy = methodTop; }
    if (cy - height < methodBottom) {
      newPage('Methods, continued.', '07 / Reading This Report');
      colIndex = 0; cy = y; methodTop = y;
    }
    const x = M + colIndex * (colW + colGap);
    draw(String(index + 1).padStart(2, '0'), x, cy, 6.5, bold, C.gold);
    block(text, x + 17, cy, colW - 17, { size: 7.7, leading: 10.4 });
    cy -= height;
  }
  y = Math.min(cy - 18, methodBottom - 12);
  if (y < 220) { newPage('Source register.', '07 / Original Public Datasets'); }
  draw('SOURCE REGISTER', M, y, 8, bold, C.gold); y -= 20;
  const sources = report.sources.filter(source => source.id === 'market-snapshot' || source.id.startsWith('cftc-'));
  for (const source of sources) {
    const labelH = wrap(source.label, CW, 8.4, bold).length * 11;
    const noteH = source.note ? wrap(source.note, CW, 7.2).length * 10 : 0;
    let shortUrl = source.url;
    try { const url = new URL(source.url); shortUrl = `${url.origin}${url.pathname}`; } catch { /* Print original URL if invalid. */ }
    const urlH = wrap(shortUrl, CW, 7.2).length * 10;
    if (y - labelH - noteH - urlH - 19 < BOTTOM) newPage('Source register, continued.', '07 / Original Public Datasets');
    y -= block(source.label, M, y, CW, { size: 8.4, font: bold, color: C.navy, leading: 11 }) + 4;
    if (source.note) y -= block(source.note, M, y, CW, { size: 7.2, leading: 10 }) + 3;
    y -= sourceLink(source.url, y) + 12;
  }
  if (replacedGlyphs) {
    if (y < 82) newPage('Reading this report.', '07 / Text Coverage');
    block('Some characters are unavailable in this PDF font. The Excel workbook preserves the original company and industry names.', M, y, CW, { size: 7, leading: 10 });
  }
  const pages = doc.getPages();
  pages.forEach((item, index) => {
    page = item; line(M, 40, W - M);
    draw('PUBLIC DATA. A WIDER VIEW.  /  secedgarterminal.com/market', M, 28, 6.6, regular, C.muted);
    right(`${basis.toUpperCase()}  /  ${String(index + 1).padStart(2, '0')} OF ${String(pages.length).padStart(2, '0')}`, W - M, 28, 6.8, bold, C.muted);
  });
  return doc.save();
}
