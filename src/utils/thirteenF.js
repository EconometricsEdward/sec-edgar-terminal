// Pure SEC Form 13F normalization. Dollar units follow filing date, not report
// period: SEC Form 13F FAQ 62 requires the revised form from 2023-01-03.
const UNIT_CHANGE_DATE = '2023-01-03';
const MAX_XML_LENGTH = 24 * 1024 * 1024;
const MAX_ROWS = 100000;
const FORMS = new Set(['13F-HR', '13F-HR/A', '13F-NT', '13F-NT/A']);
const REPORT_TYPES = new Set(['13F HOLDINGS REPORT', '13F COMBINATION REPORT', '13F NOTICE']);
const unique = (values) => [...new Set(values.filter(Boolean))];
const tidy = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const invalid = (message) => { throw new Error(`Invalid SEC 13F: ${message}`); };
const knownNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function decodeXml(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) invalid('unsupported or malformed XML entity');
  return value.replace(/&([^;]+);/g, (_, entity) => {
    const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) return predefined[entity];
    const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || !(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) invalid('invalid XML character');
    return String.fromCodePoint(code);
  });
}

// A bounded, non-expanding XML reader. It accepts the XML vocabulary needed by
// SEC 13F documents, checks balanced qualified names, and never resolves DTDs.
function parseXml(input) {
  if (typeof input !== 'string' || input.length > MAX_XML_LENGTH || !input.trim()) invalid('missing or oversized XML');
  const xml = input.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)) invalid('unsupported XML declaration or character');
  const document = { children: [], text: '', name: '#document' };
  const stack = [document];
  let cursor = 0;
  let nodes = 0;
  while (cursor < xml.length) {
    if (xml[cursor] !== '<') {
      const end = xml.indexOf('<', cursor);
      const text = xml.slice(cursor, end < 0 ? xml.length : end);
      if (stack.length === 1 && text.trim()) invalid('text outside XML root');
      if (text.includes(']]>')) invalid('malformed XML text');
      stack.at(-1).text += decodeXml(text);
      cursor = end < 0 ? xml.length : end;
      continue;
    }
    if (xml.startsWith('<!--', cursor)) {
      const end = xml.indexOf('-->', cursor + 4);
      if (end < 0 || xml.slice(cursor + 4, end).includes('--')) invalid('malformed XML comment');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', cursor)) {
      const end = xml.indexOf(']]>', cursor + 9);
      if (end < 0 || stack.length < 2) invalid('malformed CDATA');
      stack.at(-1).text += xml.slice(cursor + 9, end);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', cursor)) {
      const end = xml.indexOf('?>', cursor + 2);
      if (end < 0 || cursor !== 0 || !/^<\?xml\s/i.test(xml.slice(cursor, end))) invalid('unsupported XML processing instruction');
      cursor = end + 2;
      continue;
    }
    let end = cursor + 1;
    let quote = null;
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      else if (character === '<') invalid('malformed XML tag');
    }
    if (end === xml.length || quote) invalid('unterminated XML tag');
    const tag = xml.slice(cursor + 1, end);
    cursor = end + 1;
    if (tag.startsWith('/')) {
      if (!/^\/[A-Za-z_][\w.:-]*\s*$/.test(tag) || stack.length < 2 || stack.at(-1).qualifiedName !== tag.slice(1).trim()) invalid('mismatched XML closing tag');
      stack.pop();
      continue;
    }
    const match = /^([A-Za-z_][\w.:-]*)([\s\S]*?)\/?$/.exec(tag);
    if (!match) invalid('malformed XML opening tag');
    const [, qualifiedName, attributes] = match;
    let remaining = attributes;
    const names = new Set();
    while (remaining) {
      if (!remaining.trim()) break;
      const attribute = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(remaining);
      if (!attribute || names.has(attribute[1])) invalid('malformed or duplicate XML attribute');
      names.add(attribute[1]);
      decodeXml(attribute[2] ?? attribute[3]);
      remaining = remaining.slice(attribute[0].length);
    }
    if (++nodes > 1500000 || stack.length > 48) invalid('XML structure exceeds supported limits');
    const node = { qualifiedName, name: qualifiedName.split(':').at(-1), children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!tag.endsWith('/')) stack.push(node);
  }
  if (stack.length !== 1 || document.children.length !== 1) invalid('incomplete or multiple XML roots');
  return document.children[0];
}

function child(node, name) {
  const matches = node?.children?.filter((entry) => entry.name === name) ?? [];
  if (matches.length > 1) invalid(`duplicate ${name} field`);
  return matches[0];
}
const path = (node, ...names) => names.reduce(child, node);
function field(node, ...names) {
  const target = path(node, ...names);
  if (target?.children.length) invalid(`nested content in ${names.at(-1)}`);
  return target ? tidy(target.text) : null;
}
function date(value) {
  let normalized = tidy(value);
  if (/^\d{2}-\d{2}-\d{4}$/.test(normalized)) normalized = `${normalized.slice(6)}-${normalized.slice(0, 2)}-${normalized.slice(3, 5)}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || !Number.isFinite(Date.parse(normalized)) || new Date(normalized).toISOString().slice(0, 10) !== normalized) return null;
  return normalized;
}
function quarter(value) {
  const result = date(value);
  return result && /-(?:03-31|06-30|09-30|12-31)$/.test(result) ? result : null;
}
function cik(value) {
  const raw = tidy(value);
  return /^\d{1,10}$/.test(raw) && Number(raw) > 0 ? raw.padStart(10, '0') : null;
}
function number(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) && result <= Number.MAX_SAFE_INTEGER ? result : null;
}
function integer(value) {
  const result = number(value);
  return Number.isSafeInteger(result) ? result : null;
}
function bool(value) {
  if (value === 'true' || value === '1' || value === 'Y') return true;
  if (value === 'false' || value === '0' || value === 'N') return false;
  return null;
}
function dollars(value, multiplier) {
  const result = integer(value);
  return result !== null && Number.isSafeInteger(result * multiplier) ? result * multiplier : null;
}

export function parse13FCover(xml, expected = {}) {
  const root = parseXml(xml);
  if (root.name !== 'edgarSubmission') invalid('not a 13F cover document');
  const cover = path(root, 'formData', 'coverPage');
  const summary = path(root, 'formData', 'summaryPage');
  const form = field(root, 'headerData', 'submissionType');
  const managerCik = cik(field(root, 'headerData', 'filerInfo', 'filer', 'credentials', 'cik'));
  const period = quarter(field(cover, 'reportCalendarOrQuarter'));
  const headerPeriod = quarter(field(root, 'headerData', 'filerInfo', 'periodOfReport'));
  const managerName = field(cover, 'filingManager', 'name');
  const filingDate = date(expected.filingDate);
  const reportType = field(cover, 'reportType');
  const amendmentFlag = field(cover, 'isAmendment');
  const isAmendment = amendmentFlag === null && (form === '13F-HR' || form === '13F-NT') ? false : bool(amendmentFlag);
  const amendmentType = field(cover, 'amendmentInfo', 'amendmentType')?.toUpperCase() || null;
  const amendmentNumber = integer(field(cover, 'amendmentNo'));
  if (!FORMS.has(form) || !managerCik || !managerName || managerName.length > 500 || !period || !filingDate || period > filingDate || headerPeriod !== period || !REPORT_TYPES.has(reportType)) invalid('missing or inconsistent cover identity, date, or report type');
  if (expected.cik && cik(expected.cik) !== managerCik) invalid('cover CIK does not match the requested filer');
  if (expected.form && expected.form !== form) invalid('cover form does not match the filing');
  if (expected.period && quarter(expected.period) !== period) invalid('cover reporting period does not match the filing');
  if (isAmendment === null || isAmendment !== form.endsWith('/A')) invalid('inconsistent amendment status');
  if (isAmendment && (amendmentNumber === null || amendmentNumber < 1 || (form === '13F-HR/A' && !['RESTATEMENT', 'NEW HOLDINGS'].includes(amendmentType)) || (amendmentType !== null && !['RESTATEMENT', 'NEW HOLDINGS'].includes(amendmentType)))) invalid('missing amendment type or number');
  if (!isAmendment && (amendmentType || amendmentNumber !== null)) invalid('amendment fields on an original filing');
  if (child(cover, 'amendmentType')) invalid('amendment type is outside the required amendment-info section');
  if (form.startsWith('13F-NT') !== (reportType === '13F NOTICE')) invalid('form does not match its report type');
  const valueMultiplier = filingDate < UNIT_CHANGE_DATE ? 1000 : 1;
  const confidentialField = field(summary, 'isConfidentialOmitted');
  // The optional checkbox is absent on ordinary public reports (including D1).
  const confidentialOmitted = confidentialField === null ? false : bool(confidentialField);
  if (confidentialOmitted === null) invalid('invalid confidential-omission flag');
  const managerIdentity = (node, sequenceNumber = null) => ({ sequenceNumber, name: field(node, 'name'), cik: cik(field(node, 'cik')), fileNumber: field(node, 'form13FFileNumber') });
  const includedManagers = (path(summary, 'otherManagers2Info')?.children ?? []).filter((node) => node.name === 'otherManager2').map((node) => managerIdentity(child(node, 'otherManager'), integer(field(node, 'sequenceNumber'))));
  const reportingManagers = (path(cover, 'otherManagersInfo')?.children ?? []).filter((node) => node.name === 'otherManager').map((node) => managerIdentity(node));
  const otherManagers = [...includedManagers, ...reportingManagers];
  return {
    cik: managerCik, managerName, period, form, filingDate, isAmendment, amendmentType, amendmentNumber, reportType,
    tableEntryTotal: integer(field(summary, 'tableEntryTotal')),
    tableValueTotalUsd: dollars(field(summary, 'tableValueTotal'), valueMultiplier),
    confidentialOmitted, valueMultiplier, otherManagers,
  };
}

function holdingKey(holding) {
  // CUSIP identifies the share class; descriptive class wording can change.
  return [holding.cusip, holding.putCall || 'SECURITY', holding.quantityType].join('|');
}

export function parse13FInformationTable(xml, cover, { validateTotals = true } = {}) {
  if (![1, 1000].includes(cover?.valueMultiplier)) invalid('cover value units are unavailable');
  const root = parseXml(xml);
  if (root.name !== 'informationTable') invalid('not a 13F information table');
  if (root.children.some((node) => node.name !== 'infoTable') || root.text.trim()) invalid('unexpected information-table content');
  if (root.children.length > MAX_ROWS) invalid('too many information-table rows');
  const issues = [];
  const holdings = root.children.map((node, index) => {
    const row = index + 1;
    const issuer = field(node, 'nameOfIssuer');
    const classTitle = field(node, 'titleOfClass');
    const cusip = field(node, 'cusip')?.toUpperCase();
    const putCallRaw = field(node, 'putCall');
    const putCall = putCallRaw?.toUpperCase() || null;
    const quantityType = field(node, 'shrsOrPrnAmt', 'sshPrnamtType')?.toUpperCase();
    const quantity = number(field(node, 'shrsOrPrnAmt', 'sshPrnamt'));
    const valueUsd = dollars(field(node, 'value'), cover.valueMultiplier);
    if (!issuer || !classTitle || !cusip || !/^[A-Z0-9*@#]{9}$/.test(cusip) || !['SH', 'PRN'].includes(quantityType) || (putCall !== null && !['PUT', 'CALL'].includes(putCall))) invalid(`unusable security identity in row ${row}`);
    if (quantity === null) issues.push(`Row ${row} has no valid reported quantity.`);
    if (valueUsd === null) issues.push(`Row ${row} has no valid reported value.`);
    const investmentDiscretion = field(node, 'investmentDiscretion');
    if (!['SOLE', 'DFND', 'OTR'].includes(investmentDiscretion)) issues.push(`Row ${row} has no valid investment-discretion field.`);
    const holding = {
      cusip, issuer, classTitle, putCall, quantity, quantityType, valueUsd,
      investmentDiscretion, otherManager: field(node, 'otherManager'),
      votingAuthority: { sole: number(field(node, 'votingAuthority', 'Sole')), shared: number(field(node, 'votingAuthority', 'Shared')), none: number(field(node, 'votingAuthority', 'None')) },
      sourceRowCount: 1,
    };
    if (Object.values(holding.votingAuthority).some((value) => value === null)) issues.push(`Row ${row} has incomplete voting-authority fields.`);
    holding.key = holdingKey(holding);
    return holding;
  });
  const reconciliation = validateTotals ? reconcile13FTable(holdings, cover) : { complete: true, issues: [], totalValueUsd: sumKnown(holdings.map((holding) => holding.valueUsd)), entryCount: holdings.length };
  return { holdings, entryCount: holdings.length, totalValueUsd: reconciliation.totalValueUsd, complete: issues.length === 0 && reconciliation.complete, issues: unique([...issues, ...reconciliation.issues]) };
}

function sumKnown(values) {
  if (values.some((value) => !knownNumber(value))) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isFinite(sum) && sum <= Number.MAX_SAFE_INTEGER ? sum : null;
}

export function reconcile13FTable(holdings, cover) {
  if (!Array.isArray(holdings) || holdings.length > MAX_ROWS) invalid('invalid information-table rows');
  const entryCount = holdings.reduce((sum, holding) => sum + (holding.sourceRowCount ?? 1), 0);
  const totalValueUsd = sumKnown(holdings.map((holding) => holding.valueUsd));
  const issues = [];
  if (cover?.reportType === '13F NOTICE') issues.push('This notice refers to reporting by another manager and provides no holdings table.');
  if (!Number.isSafeInteger(cover?.tableEntryTotal)) issues.push('The cover does not provide a valid information-table entry total.');
  else if (entryCount !== cover.tableEntryTotal) issues.push(`The ${entryCount} loaded rows do not reconcile to the ${cover.tableEntryTotal} cover-page entries.`);
  if (!knownNumber(cover?.tableValueTotalUsd)) issues.push('The cover does not provide a valid information-table value total.');
  else if (totalValueUsd !== cover.tableValueTotalUsd) issues.push('Loaded information-table values do not reconcile to the cover-page value total.');
  if (totalValueUsd === null) issues.push('One or more reported values are unavailable or exceed supported numeric precision.');
  if (holdings.some((holding) => !knownNumber(holding.quantity))) issues.push('One or more reported quantities are unavailable.');
  return { holdings, entryCount, totalValueUsd, complete: issues.length === 0, issues };
}

function aggregateHoldings(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = holdingKey(row);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...row, key, classTitles: [row.classTitle], votingAuthority: { ...row.votingAuthority }, sourceRowCount: row.sourceRowCount ?? 1 });
      continue;
    }
    existing.valueUsd = sumKnown([existing.valueUsd, row.valueUsd]);
    existing.quantity = sumKnown([existing.quantity, row.quantity]);
    existing.sourceRowCount += row.sourceRowCount ?? 1;
    existing.classTitles = unique([...existing.classTitles, row.classTitle]);
    existing.investmentDiscretion = unique([existing.investmentDiscretion, row.investmentDiscretion]).join(', ');
    existing.otherManager = unique([existing.otherManager, row.otherManager]).join(', ') || null;
    for (const authority of ['sole', 'shared', 'none']) existing.votingAuthority[authority] = sumKnown([existing.votingAuthority[authority], row.votingAuthority?.[authority]]);
  }
  return [...map.values()].sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1) || a.key.localeCompare(b.key));
}

export function assemble13FPeriod(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100) invalid('missing or excessive reports for the quarter');
  const reports = [...input].sort((a, b) => String(a.filing?.filingDate || a.cover?.filingDate).localeCompare(String(b.filing?.filingDate || b.cover?.filingDate)) || (a.cover?.amendmentNumber ?? 0) - (b.cover?.amendmentNumber ?? 0) || String(a.filing?.accession).localeCompare(String(b.filing?.accession)));
  const first = reports[0].cover;
  if (!first?.cik || !first.period || reports.some((report) => report.cover?.cik !== first.cik || report.cover?.period !== first.period)) invalid('reports belong to different filers or quarters');
  const accessionSet = new Set();
  for (const report of reports) {
    if (!report.filing?.accession || accessionSet.has(report.filing.accession)) invalid('missing or duplicate filing accession');
    accessionSet.add(report.filing.accession);
  }
  const issues = [];
  const notice = reports.at(-1).cover.reportType === '13F NOTICE';
  let baseIndex = -1;
  for (let i = 0; i < reports.length; i += 1) {
    if (reports[i].cover.amendmentType === 'RESTATEMENT' && reports[i].cover.reportType !== '13F NOTICE') baseIndex = i;
  }
  if (baseIndex < 0) {
    const originals = reports.map((report, index) => ({ report, index })).filter(({ report }) => !report.cover.isAmendment && report.cover.reportType !== '13F NOTICE');
    if (originals.length === 1) baseIndex = originals[0].index;
    else if (originals.length > 1) {
      issues.push('Multiple original reports exist for this quarter; a single holdings baseline cannot be established.');
      baseIndex = originals.at(-1).index;
    }
  }
  if (baseIndex < 0) issues.push(notice ? 'This is a 13F notice; holdings are reported by another manager.' : 'The original report or a complete restatement is unavailable.');
  const active = baseIndex < 0 ? [] : reports.slice(baseIndex);
  if (baseIndex >= 0 && reports[baseIndex].cover.isAmendment && reports.slice(0, baseIndex).some((report) => report.cover.amendmentNumber === reports[baseIndex].cover.amendmentNumber)) issues.push('The current restatement repeats an amendment number, so the filing sequence is ambiguous.');
  let rows = [];
  let entryCount = 0;
  const amendmentNumbers = new Set();
  let previousAmendmentNumber = active[0]?.cover.amendmentNumber ?? 0;
  for (const [index, report] of active.entries()) {
    const cover = report.cover;
    if (cover.reportType === '13F NOTICE') { issues.push('A notice and holdings report are mixed in the current filing sequence.'); continue; }
    if (index > 0 && cover.amendmentType !== 'NEW HOLDINGS') { issues.push('The report sequence includes an ambiguous additional baseline.'); continue; }
    if (cover.isAmendment && amendmentNumbers.has(cover.amendmentNumber)) issues.push('Duplicate amendment numbers make the report sequence ambiguous.');
    if (index > 0 && cover.amendmentNumber !== previousAmendmentNumber + 1) issues.push('An amendment is missing or out of order in the current report sequence.');
    if (cover.isAmendment) amendmentNumbers.add(cover.amendmentNumber);
    if (cover.isAmendment) previousAmendmentNumber = cover.amendmentNumber;
    const holdings = Array.isArray(report.holdings) ? report.holdings : [];
    const reconciled = reconcile13FTable(holdings, cover);
    issues.push(...(report.issues ?? []), ...reconciled.issues);
    if (report.complete === false) issues.push('One or more source documents or filing-history segments are incomplete.');
    const existingKeys = new Set(rows.map(holdingKey));
    if (index > 0 && holdings.some((holding) => existingKeys.has(holdingKey(holding)))) {
      issues.push('A new-holdings amendment overlaps an existing security; overlapping entries were not added because their scope is ambiguous.');
      rows.push(...holdings.filter((holding) => !existingKeys.has(holdingKey(holding))));
    } else rows.push(...holdings);
    entryCount += reconciled.entryCount;
  }
  // A metadata gap remains relevant even if a later restatement replaces values.
  if (reports.some((report) => report.historyComplete === false)) issues.push('Filing-history coverage is incomplete for this quarter.');
  let holdings = aggregateHoldings(rows);
  const valueSum = sumKnown(holdings.map((holding) => holding.valueUsd));
  if (valueSum === null) issues.push('The aggregated reported value exceeds available numeric precision.');
  if (holdings.some((holding) => !knownNumber(holding.quantity))) issues.push('An aggregated reported quantity is unavailable or exceeds supported numeric precision.');
  const complete = !notice && baseIndex >= 0 && issues.length === 0;
  const totalValueUsd = complete ? valueSum : null;
  holdings = holdings.map((holding) => ({ ...holding, weightPct: totalValueUsd > 0 && holding.valueUsd !== null ? holding.valueUsd / totalValueUsd * 100 : null }));
  const confidentialOmitted = active.some((report) => report.cover.confidentialOmitted);
  const reportType = (active[0] ?? reports.at(-1)).cover.reportType;
  const comparable = complete && !confidentialOmitted && reportType === '13F HOLDINGS REPORT';
  return {
    cik: first.cik, managerName: reports.at(-1).cover.managerName, period: first.period,
    holdings, reportType, entryCount, positionCount: holdings.length, totalValueUsd, complete, comparable, confidentialOmitted,
    issues: unique(issues), amendmentCount: reports.filter((report) => report.cover.isAmendment).length,
    otherManagers: active.length ? active.flatMap((report) => report.cover.otherManagers ?? []) : reports.at(-1).cover.otherManagers ?? [],
    filings: reports.map((report, index) => ({ ...report.filing, isAmendment: report.cover.isAmendment, amendmentType: report.cover.amendmentType, amendmentNumber: report.cover.amendmentNumber, superseded: index < baseIndex })),
  };
}

export function summarize13FPortfolio(portfolio) {
  const holdings = [...(portfolio?.holdings ?? [])].sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const complete = portfolio?.complete === true;
  const totalValueUsd = complete ? portfolio.totalValueUsd : null;
  const pct = (count) => complete && totalValueUsd > 0 ? sumKnown(holdings.slice(0, count).map((holding) => holding.valueUsd)) / totalValueUsd * 100 : null;
  const bucket = (predicate) => complete ? sumKnown(holdings.filter(predicate).map((holding) => holding.valueUsd)) : null;
  return {
    totalValueUsd, positionCount: holdings.length, entryCount: portfolio?.entryCount ?? null,
    top5Pct: pct(5), top10Pct: pct(10), largestPosition: holdings[0] ?? null, holdings,
    ordinaryValueUsd: bucket((holding) => !holding.putCall && holding.quantityType === 'SH'),
    principalValueUsd: bucket((holding) => !holding.putCall && holding.quantityType === 'PRN'),
    putValueUsd: bucket((holding) => holding.putCall === 'PUT'),
    callValueUsd: bucket((holding) => holding.putCall === 'CALL'),
    complete, issues: portfolio?.issues ?? [],
  };
}

function quarterIndex(period) {
  if (!quarter(period)) return null;
  return Number(period.slice(0, 4)) * 4 + Number(period.slice(5, 7)) / 3;
}

export function compare13FPortfolios(before, after) {
  const output = {
    available: false, reason: null, beforePeriod: before?.period ?? null, afterPeriod: after?.period ?? null,
    changes: [], counts: { newlyReported: 0, noLongerReported: 0, increased: 0, decreased: 0, unchanged: 0 },
    totalValueChangeUsd: null, totalValueChangePct: null,
    issues: ['Changes describe reported quarter-end quantities. Corporate actions, reporting scope, and confidential treatment can affect comparisons; they do not establish purchases, sales, or performance.'],
  };
  if (!before || !after) output.reason = 'Two reported quarters are needed for a comparison.';
  else if (before.cik !== after.cik) output.reason = 'The reports belong to different managers.';
  else if (quarterIndex(before.period) === null || quarterIndex(after.period) !== quarterIndex(before.period) + 1) output.reason = 'Only consecutive reported quarters can be compared.';
  else if (!before.complete || !after.complete) output.reason = 'Complete, reconciled public holdings are needed for both quarters.';
  else if (before.confidentialOmitted || after.confidentialOmitted) output.reason = 'A report omits confidential holdings, so changes cannot be classified reliably.';
  else if (!before.comparable || !after.comparable) output.reason = 'The reports have a notice or combination reporting scope that prevents a complete comparison.';
  if (output.reason) return output;
  const previous = new Map(before.holdings.map((holding) => [holding.key, holding]));
  const current = new Map(after.holdings.map((holding) => [holding.key, holding]));
  for (const key of unique([...previous.keys(), ...current.keys()])) {
    const old = previous.get(key);
    const next = current.get(key);
    const holding = next ?? old;
    const beforeQuantity = old ? old.quantity : 0;
    const afterQuantity = next ? next.quantity : 0;
    const quantityChange = knownNumber(beforeQuantity) && knownNumber(afterQuantity) ? afterQuantity - beforeQuantity : null;
    const status = !old ? 'newly-reported' : !next ? 'no-longer-reported' : quantityChange === null ? 'unavailable' : quantityChange > 0 ? 'increased' : quantityChange < 0 ? 'decreased' : 'unchanged';
    const countKey = { 'newly-reported': 'newlyReported', 'no-longer-reported': 'noLongerReported' }[status] || status;
    if (Object.hasOwn(output.counts, countKey)) output.counts[countKey] += 1;
    const beforeValueUsd = old ? old.valueUsd : 0;
    const afterValueUsd = next ? next.valueUsd : 0;
    const beforeWeightPct = old ? old.weightPct : 0;
    const afterWeightPct = next ? next.weightPct : 0;
    output.changes.push({
      key, cusip: holding.cusip, issuer: holding.issuer, classTitle: holding.classTitle, putCall: holding.putCall, quantityType: holding.quantityType, status,
      beforeQuantity, afterQuantity, quantityChange,
      quantityChangePct: quantityChange !== null && beforeQuantity > 0 ? quantityChange / beforeQuantity * 100 : null,
      beforeValueUsd, afterValueUsd, valueChangeUsd: knownNumber(beforeValueUsd) && knownNumber(afterValueUsd) ? afterValueUsd - beforeValueUsd : null,
      beforeWeightPct, afterWeightPct, weightChangePp: knownNumber(beforeWeightPct) && knownNumber(afterWeightPct) ? afterWeightPct - beforeWeightPct : null,
    });
  }
  output.changes.sort((a, b) => Math.abs(b.weightChangePp ?? 0) - Math.abs(a.weightChangePp ?? 0) || a.key.localeCompare(b.key));
  output.available = true;
  output.totalValueChangeUsd = after.totalValueUsd - before.totalValueUsd;
  output.totalValueChangePct = before.totalValueUsd > 0 ? output.totalValueChangeUsd / before.totalValueUsd * 100 : null;
  return output;
}
