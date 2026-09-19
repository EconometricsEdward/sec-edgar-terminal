// The Market edition follows the Market page's business conditions, futures
// positioning and sector drill-down sequence. No source/provenance tab is added.
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const fraction = (value) => finite(value) ? value / 100 : null;
const count = (value) => finite(value) ? value : null;
const displayNumber = (value) => finite(value) ? value.toLocaleString('en-US') : 'unavailable';
const detailSections = [
  ['sector-comparison', 'Sector Performance'], ['sector-statistics', 'Sector Statistics'],
  ['sector-industries', 'Industries'], ['market-companies', 'Companies'],
  ['cftc-all-groups', 'CFTC Contracts'], ['cftc-heatmap', 'CFTC Heatmap'],
];

function marketBriefingSheet(report, tools) {
  const { makeSheet, styles, wrappedHeight } = tools, briefing = report.marketBriefing, coverage = briefing.coverage || {};
  const sheet = makeSheet('Market Briefing', [3, 14, 14, 14, 22, 14, 14, 3, 14, 14, 14], styles);
  sheet.summary = true; sheet.tabColor = '17243B';
  sheet.height(1, 10);
  sheet.span(2, 1, 10, 'Market briefing', 'text', { font: 1, border: 1 }); sheet.height(2, 34);
  sheet.span(3, 1, 10, `${String(report.period.basis || '').toUpperCase()} company fundamentals. SEC snapshot ${String(coverage.snapshotAt || report.period.asOf || 'unavailable').slice(0, 10)}.`, 'text', { font: 6 }); sheet.height(3, 23);
  const cards = [
    { label: 'SEC issuers', value: coverage.companyCount, detail: `${displayNumber(coverage.requestedCount)} requested issuers` },
    { label: 'Primary sectors', value: coverage.sectorCount, detail: `${displayNumber(coverage.missingSectorCount)} issuers without a primary sector` },
    { label: 'SIC industries', value: coverage.industryCount, detail: `${displayNumber(coverage.missingIndustryCount)} issuers without a reported SIC industry` },
  ];
  cards.forEach((card, index) => {
    const start = [1, 4, 8][index], end = [3, 6, 10][index];
    sheet.span(5, start, end, card.label, 'text', { font: 5, fill: 3 });
    sheet.span(6, start, end, finite(card.value) ? card.value : 'Unavailable', 'integer', { font: finite(card.value) ? 4 : 5, fill: 3 });
    sheet.span(7, start, end, card.detail, 'text', { font: 6, fill: 3 });
  });
  sheet.height(5, 26); sheet.height(6, 36); sheet.height(7, 36); sheet.height(8, 10);
  sheet.span(9, 1, 10, '01 / Business conditions', 'text', { font: 5, border: 1 }); sheet.height(9, 30);
  sheet.span(10, 1, 10, 'How broad is the strength? Each share uses the companies with an available observation for that measure.', 'text', { font: 3 }); sheet.height(10, 27);
  sheet.span(12, 1, 3, 'Business outcome', 'text', { font: 2, fill: 2, align: 'center' });
  [['Share', 4], ['Positive', 5], ['Available', 6]].forEach(([label, column]) => sheet.put(12, column, label, 'text', { font: 2, fill: 2, align: 'center' }));
  sheet.span(12, 8, 10, 'What it measures', 'text', { font: 2, fill: 2, align: 'center' }); sheet.height(12, 30);
  const breadth = briefing.breadth || [];
  sheet.conditionalFormats = [];
  breadth.forEach((item, index) => {
    const row = index + 13, fill = index % 2 ? 3 : 0;
    sheet.span(row, 1, 3, item.label, 'text', { font: 5, fill });
    sheet.put(row, 4, count(item.share), 'percent', { font: 5 });
    sheet.put(row, 5, count(item.positive), 'integer', { fill });
    sheet.put(row, 6, count(item.count), 'integer', { fill });
    sheet.span(row, 8, 10, item.context, 'text', { font: 6, fill });
    sheet.height(row, Math.max(42, wrappedHeight(item.context, 42)));
    sheet.conditionalFormats.push({ kind: 'dataBar', range: `E${row}`, color: ['8ABEB9', 'E2C677', 'AEC4D9'][index % 3], minimum: 0, maximum: 1 });
  });
  let row = 15 + breadth.length;
  sheet.span(row, 1, 10, 'Revenue growth across sectors', 'text', { font: 5, border: 1 }); sheet.height(row++, 30);
  const leaders = briefing.growthLeaders || {};
  for (const [index, key] of ['highest', 'lowest'].entries()) {
    const item = leaders[key], start = index ? 4 : 1, end = index ? 6 : 3;
    sheet.span(row, start, end, key === 'highest' ? 'Highest sector median' : 'Lowest sector median', 'text', { font: 6, fill: 3 });
    sheet.span(row + 1, start, end, item?.sector || 'Unavailable', 'text', { font: 5, fill: 3 });
    sheet.span(row + 2, start, end, item && finite(item.value) ? fraction(item.value) : 'Unavailable', 'percent', { font: item && finite(item.value) ? 4 : 5, fill: 3 });
    sheet.span(row + 3, start, end, item ? `${displayNumber(item.count)} / ${displayNumber(item.companies)} companies with available growth` : 'Comparable sector median unavailable', 'text', { font: 6, fill: 3 });
  }
  sheet.span(row, 8, 10, 'Highest-to-lowest spread', 'text', { font: 6, fill: 3 });
  sheet.span(row + 1, 8, 10, 'Sector revenue growth', 'text', { font: 5, fill: 3 });
  sheet.span(row + 2, 8, 10, finite(leaders.spreadPp) ? leaders.spreadPp : 'Unavailable', 'number', { font: finite(leaders.spreadPp) ? 4 : 5, fill: 3 });
  sheet.span(row + 3, 8, 10, 'Percentage points', 'text', { font: 6, fill: 3 });
  sheet.height(row, 24); sheet.height(row + 1, 30); sheet.height(row + 2, 38); sheet.height(row + 3, 36); row += 5;
  sheet.span(row, 1, 10, 'Reporting coverage', 'text', { font: 5, border: 2 }); sheet.height(row++, 28);
  const range = coverage.reportRange;
  const description = range ? `Company reporting periods run from ${range.earliest} through ${range.latest}. ${displayNumber(coverage.olderReports)} issuers have older or unavailable reporting periods.` : 'Company reporting dates are unavailable. Missing observations remain blank.';
  sheet.span(row, 1, 10, description, 'text', { font: 6 }); sheet.height(row++, wrappedHeight(description, 130, 30));
  sheet.span(row, 1, 10, 'Sector measures are unweighted company medians. Read the separate CFTC report dates before comparing futures positioning with company fundamentals.', 'text', { font: 3 }); sheet.height(row, 32);
  return sheet;
}

function marketPositioningSheet(report, tools) {
  const { makeSheet, titleBlock, styles, wrappedHeight } = tools, positioning = report.marketBriefing.positioning || {}, cards = positioning.cards || [];
  const sheet = makeSheet('CFTC Positioning', [3, 19, 34, 24, 19, 20, 20, 27, 28], styles); sheet.tabColor = '24797C';
  titleBlock(sheet, report, 'CFTC positioning', '02 / Six macro observations. Futures only. Net/open interest is a percent; weekly shifts are percentage points.');
  const headings = ['Macro lens', 'Selected contract', 'Trader group', 'Position date', 'Net / open interest', '1-week shift (pp)', 'Report family', 'Observation coverage'];
  headings.forEach((heading, index) => sheet.put(6, index + 1, heading, 'text', { font: 2, fill: 2, align: 'center' })); sheet.height(6, 36);
  cards.forEach((card, index) => {
    const row = 7 + index, available = card.available === true && finite(card.netPctOi), fill = index % 2 ? 3 : 0;
    const status = !available ? 'Unavailable' : card.aged ? 'Older report' : card.stale ? 'Preserved snapshot' : 'Reported observation';
    [card.category, card.label, card.groupLabel, card.reportDate, available ? fraction(card.netPctOi) : null, available ? count(card.weeklyChange) : null, card.familyLabel, status].forEach((value, column) => sheet.put(row, column + 1, value, ['text', 'text', 'text', 'date', 'percent', 'number', 'text', 'text'][column], { fill, font: column === 4 ? 5 : 0 }));
    sheet.height(row, 38);
  });
  let row = Math.max(15, cards.length + 9);
  const differentDates = positioning.differentReportDates === true;
  const largest = !differentDates ? positioning.largestMove : null;
  const weekly = largest ? `Largest weekly shift: ${largest.label} (${largest.groupLabel}), ${largest.weeklyChange > 0 ? '+' : ''}${largest.weeklyChange.toFixed(1)} percentage points. Among ${displayNumber(positioning.comparableCount)} comparable observations for ${largest.reportDate}.` : differentDates ? 'The CFTC families have different report dates. A cross-family largest weekly shift is withheld.' : 'A largest weekly shift is unavailable or all comparable weekly changes are zero.';
  sheet.span(row, 1, 8, weekly, 'text', { font: 5, fill: 4 }); sheet.height(row++, wrappedHeight(weekly, 150, 35));
  sheet.span(row, 1, 8, `${displayNumber(positioning.availableCount)} of ${cards.length} selected observations are available. Teal denotes net long and gold denotes net short; positions may include hedges.`, 'text', { font: 3 }); sheet.height(row++, 28);
  const firstChartRow = row + 1;
  // Keep contract names outside the plot, so negative bars cannot cover labels
  // in spreadsheet viewers with inconsistent category-axis positioning.
  cards.forEach((card, index) => {
    const [start, end] = [[3, 4], [5, 7], [8, 9], [10, 11], [12, 14], [15, 16]][index] || [3 + index * 2, 4 + index * 2];
    for (let line = firstChartRow + start; line <= firstChartRow + end; line++) for (let column = 1; column <= 2; column++) sheet.put(line, column, line === firstChartRow + start && column === 1 ? card.label : null, 'text', { font: 5 });
    sheet.merges.push(`B${firstChartRow + start}:C${firstChartRow + end}`);
  });
  if (cards.length) sheet.charts.push({ kind: 'bar', title: 'Six macro observations: net / open interest', unit: 'percent', points: cards.map((card) => ({ label: card.label, value: card.available === true ? fraction(card.netPctOi) : null })), firstRow: 7, lastRow: cards.length + 6, labelColumn: 'C', valueColumn: 'F', from: { col: 3, row: firstChartRow }, to: { col: 8, row: firstChartRow + 16 }, fixedScale: [-1, 1] });
  row = firstChartRow + 18;
  sheet.span(row, 1, 8, 'How each observation relates to the economy', 'text', { font: 5, border: 1 }); sheet.height(row++, 28);
  cards.forEach((card) => { sheet.span(row, 1, 2, `${card.category}: ${card.label}`, 'text', { font: 5 }); sheet.span(row, 3, 8, card.context, 'text', { font: 6 }); sheet.height(row++, wrappedHeight(card.context, 120, 32)); });
  sheet.span(row, 1, 8, 'Explore the CFTC Heatmap tab for prepared 1-, 3- and 5-year positioning ranks. Exact comparison dates and coverage reasons remain in CFTC Contracts.', 'text', { font: 3 }); sheet.height(row++, 32);
  const contractRows = report.sections.find(section => section.id === 'cftc-all-groups')?.rows || [];
  sheet.conditionalFormats = [];
  for (const family of positioning.families || []) {
    row += 2; sheet.span(row, 1, 8, `${family.label} / All participant groups`, 'text', { font: 5, border: 1 }); sheet.height(row++, 30);
    sheet.span(row, 1, 8, 'Net / open interest. Teal indicates net long; gold indicates net short. Contract sizes differ, so positions are not added across markets.', 'text', { font: 3 }); sheet.height(row++, 30);
    const familyRows = contractRows.filter(item => item.familyId === family.family);
    const groups = [...new Map(familyRows.map(item => [item.groupId, item.group])).entries()];
    const contracts = new Map();
    familyRows.filter(item => finite(item.long) || finite(item.short)).forEach(item => {
      const key = `${item.code}:${item.reportDate}`;
      if (!contracts.has(key)) contracts.set(key, { market: item.market, reportDate: item.reportDate, values: new Map() });
      contracts.get(key).values.set(item.groupId, item.netOi);
    });
    if (!contracts.size) { sheet.span(row, 1, 8, 'Prepared participant-group observations are unavailable.', 'text', { font: 6 }); sheet.height(row++, 30); continue; }
    sheet.span(row, 1, 2, 'Prepared contract', 'text', { font: 2, fill: 2, align: 'center' });
    groups.forEach(([, label], index) => sheet.put(row, index + 3, label, 'text', { font: 2, fill: 2, align: 'center' }));
    sheet.put(row, 8, 'Position date', 'text', { font: 2, fill: 2, align: 'center' }); sheet.height(row++, 46);
    const first = row;
    [...contracts.values()].forEach((contract, index) => {
      const fill = index % 2 ? 3 : 0;
      sheet.span(row, 1, 2, contract.market, 'text', { font: 5, fill });
      groups.forEach(([id], i) => sheet.put(row, i + 3, count(contract.values.get(id)), 'percent', { fill }));
      sheet.put(row, 8, contract.reportDate, 'date', { fill }); sheet.height(row++, 31);
    });
    sheet.conditionalFormats.push({ kind: 'colorScale', range: `D${first}:H${row - 1}`, minimum: -1, midpoint: 0, maximum: 1, colors: ['F2E3B7', 'FFFFFF', '8ABEB9'] });
  }
  sheet.freeze = 6; sheet.repeat = '$1:$6'; sheet.height(row, 8);
  return sheet;
}

function marketCoverageSheet(report, tools) {
  const original = report.sections.find(section => section.id === 'market-coverage');
  if (!original) return null;
  const sheet = tools.sectionSheet(report, { ...original, workbookName: 'Coverage' }, tools.styles, new Map());
  const coverage = report.marketBriefing.coverage || {}, positioning = report.marketBriefing.positioning || {};
  let row = sheet.lastRow + 3;
  const line = (label, value) => { sheet.span(row, 1, 2, label, 'text', { font: 6 }); sheet.span(row, 3, 5, value, 'text'); sheet.height(row++, tools.wrappedHeight(value, 105, 29)); };
  sheet.span(row, 1, 5, 'Separate reporting clocks', 'text', { font: 5, border: 1 }); sheet.height(row++, 28);
  line('Report prepared', report.generatedAt);
  line('SEC snapshot', coverage.snapshotAt);
  line('Company reporting periods', coverage.reportRange ? `${coverage.reportRange.earliest} through ${coverage.reportRange.latest} (${displayNumber(coverage.reportRange.count)} dated issuers)` : 'Unavailable');
  for (const family of positioning.families || []) {
    line(`${family.label} positions`, family.reportDate || 'Unavailable');
    line(`${family.label} retrieved`, family.retrievedAt || 'Unavailable');
    line(`${family.label} coverage`, [family.valid ? 'Prepared snapshot available' : 'Snapshot unavailable', family.aged ? 'Older report' : '', family.stale ? 'Preserved cached snapshot' : '', family.partial ? 'Partial coverage' : '', family.warning].filter(Boolean).join('. '));
  }
  const categories = report.sections.find(section => section.id === 'cftc-market-coverage');
  if (categories) {
    row += 2; sheet.span(row, 1, 5, 'CFTC coverage by market category', 'text', { font: 5, border: 1 }); sheet.height(row++, 28);
    categories.columns.filter(column => !tools.excludedColumn(column)).forEach((column, index) => sheet.put(row, index + 1, column.label, 'text', { font: 2, fill: 2, align: 'center' })); sheet.height(row++, 36);
    categories.rows.forEach((item, index) => { categories.columns.filter(column => !tools.excludedColumn(column)).forEach((column, col) => { const format = tools.numericFormat(column, item); sheet.put(row, col + 1, item[column.key], format === 'number' && Number.isInteger(item[column.key]) ? 'integer' : format, { fill: index % 2 ? 3 : 0 }); }); sheet.height(row++, 32); });
  }
  return sheet;
}

export function buildMarketWorkbookSheets(report, tools) {
  const sheets = [marketBriefingSheet(report, tools), marketPositioningSheet(report, tools)];
  for (const [id, name] of detailSections) {
    const section = report.sections.find((item) => item.id === id);
    if (!section) continue;
    let columns = section.columns, footnote = section.footnote;
    if (id === 'sector-comparison') columns = columns.map(column => ({ ...column, width: column.key === 'sector' ? 32 : column.key === 'companies' || /N$/.test(column.key) ? 14 : 18 }));
    if (id === 'cftc-heatmap') {
      columns = columns.filter(column => !/Required|Start|End|Status$/.test(column.key)).map(column => ({ ...column, width: column.key === 'market' ? 36 : column.key === 'family' || column.key === 'group' ? 27 : /N$/.test(column.key) ? 14 : 19 }));
      footnote = 'Ranks compare the same contract and trader group with 52, 156 or 260 prior weekly reports for 1, 3 or 5 years. Each n is the available compatible observation count. Blank ranks are unavailable; exact window dates and reasons are retained in CFTC Contracts.';
    }
    const sheet = tools.sectionSheet(report, { ...section, workbookName: name, columns, footnote }, tools.styles, new Map());
    if (!sheet) continue;
    sheet.height(6, Math.max(36, ...columns.map((column, index) => tools.wrappedHeight(column.label, sheet.widths[index + 1] || 20, 30))));
    if (id === 'sector-comparison' || id === 'cftc-heatmap') {
      sheet.tabColor = '24797C'; sheet.conditionalFormats = [];
      columns.forEach((column, index) => {
        if (column.format !== 'percent' || !section.rows.length) return;
        const rank = /^rank(1y|3y|5y)$/.test(column.key), extent = Math.max(...section.rows.map(row => finite(row[column.key]) ? Math.abs(row[column.key]) : 0)) || 1;
        sheet.conditionalFormats.push({ kind: 'colorScale', range: `${tools.colName(index + 1)}7:${tools.colName(index + 1)}${section.rows.length + 6}`, minimum: rank ? 0 : -extent, midpoint: rank ? 0.5 : 0, maximum: rank ? 1 : extent, colors: ['F2E3B7', 'FFFFFF', '8ABEB9'] });
      });
    }
    sheets.push(sheet);
  }
  const coverage = marketCoverageSheet(report, tools); if (coverage) sheets.push(coverage);
  return sheets;
}
