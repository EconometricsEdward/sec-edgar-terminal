/** Evidence-based document taxonomy for the shared X-17A-5 form family.
 * Deliberately independent of financial mapping: an audit report can be present
 * without a complete set of public statements, and a periodic report can be audited.
 */
export const BROKER_DEALER_CLASSIFICATION_VERSION = 1;
const compact = value => String(value || '').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/[‘’]/g, "'").replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim();
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const datePattern = '(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s*[/.-]\\s*\\d{1,2}\\s*[/.-]\\s*(?:\\d{4}|\\d{2})|(?:' + Object.keys(months).join('|') + ')\\s+\\d{1,2},?\\s+\\d{4})';
function parseDate(value) {
  const text = compact(value);
  if (validDate(text)) return text;
  let match = text.match(/^(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4}|\d{2})$/);
  if (match) {
    const year = match[3].length === 2 ? (Number(match[3]) > 69 ? 1900 : 2000) + Number(match[3]) : Number(match[3]);
    const date = iso(year, match[1], match[2]);
    return validDate(date) ? date : '';
  }
  match = text.match(new RegExp(`^(${Object.keys(months).join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})$`, 'i'));
  const date = match ? iso(match[3], months[match[1].toLowerCase()], match[2]) : '';
  return validDate(date) ? date : '';
}
function sourceUrl(value, page) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (page) url.hash = `page=${page}`;
    return url.href;
  } catch { return ''; }
}
function normalizeLine(value) {
  let text = compact(value);
  // PDFs occasionally contain two coincident text layers. Restrict de-duplication
  // to an exact repeated line; it must not erase distinct report content.
  const words = text.split(' ');
  if (words.length % 2 === 0) {
    const half = words.length / 2;
    if (words.slice(0, half).join(' ') === words.slice(half).join(' ')) text = words.slice(0, half).join(' ');
  }
  return text.replace(/\bPART\s+([Il]{2,3})(A?)\b/gi, (_, roman, a) => `PART ${roman.replace(/l/gi, 'I').toUpperCase()}${a.toUpperCase()}`);
}
function exactPart(text) {
  // This only accepts a descriptor/heading, not prose mentioning another form.
  const value = normalizeLine(text).replace(/^FORM\s+/i, '').replace(/^X\s*-?\s*17A\s*-?\s*5(?:\/A)?\s*(?:-|:|–)?\s*/i, '').replace(/^(?:FOCUS(?: REPORT)?|FINANCIAL AND OPERATIONAL COMBINED UNIFORM SINGLE REPORT)\s*(?:-|:|–)?\s*/i, '').replace(/\s*(?:-|:|–)?\s*(?:FOCUS(?: REPORT)?|ANNUAL REPORTS?)$/i, '');
  if (/^PART\s+III$/i.test(value)) return 'Part III';
  if (/^PART\s+II\s*A$/i.test(value)) return 'Part IIA';
  if (/^PART\s+II$/i.test(value)) return 'Part II';
  if (/^SCHEDULE\s+I$/i.test(value)) return 'Schedule I';
  return '';
}
const statementPatterns = [
  ['financial-condition', /^(?:(?:consolidated|combined|condensed)\s+)?(?:statements? of (?:financial condition|financial position)|balance sheets?)(?:\s|$)/i],
  ['income', /^(?:(?:consolidated|combined|condensed)\s+)?statements? of (?:operations|income|earnings|comprehensive income|revenues? and expenses?)(?:\s|$)/i],
  ['cash-flows', /^(?:(?:consolidated|combined|condensed)\s+)?statements? of cash flows(?:\s|$)/i],
  ['changes-in-equity', /^(?:(?:consolidated|combined|condensed)\s+)?statements? of (?:changes in (?:stockholders'?|shareholders'?|members'?|partners'?) (?:equity|capital)|(?:stockholders'?|shareholders'?|members'?|partners'?) (?:equity|capital))(?:\s|$)/i],
  ['notes', /^notes to (?:the )?(?:(?:consolidated|combined|condensed)\s+)?(?:financial statements?|statements? of financial (?:condition|position))(?:\s|$)/i],
  ['net-capital', /^(?:schedule\s+[IVX\d]+\s*(?:-|:)?\s*)?(?:computation|calculation) of (?:minimum |required )?net capital(?:\s|$)/i],
  ['reserve-requirements', /^(?:schedule\s+[IVX\d]+\s*(?:-|:)?\s*)?(?:computation|calculation) (?:for (?:the )?determination of |of )(?:(?:customer|PAB|security-based swap) )?reserve requirements(?:\s|$)/i],
];

export function classifyBrokerDealerDocument({ pages = [], cover = {}, filing = {}, selectedDocument = {}, documentUrl = '' } = {}) {
  const source = documentUrl || selectedDocument?.url || '';
  const evidence = [], limitations = [], parts = new Set(), components = new Set();
  const ownDocument = Boolean(selectedDocument && Object.keys(selectedDocument).length);
  const add = (kind, text, page = null) => {
    if (!evidence.some(item => item.kind === kind && item.page === page && item.excerpt === compact(text).slice(0, 320))) evidence.push({ page, url: sourceUrl(source, page), excerpt: compact(text).slice(0, 320), kind });
  };
  const prepared = (Array.isArray(pages) ? pages : []).slice(0, 80).map((page, index) => {
    const lines = String(page?.text || (Array.isArray(page?.lines) ? page.lines.map(line => line.text || '').join('\n') : '')).slice(0, 250000).split(/\r?\n/).map(normalizeLine).filter(Boolean);
    return { page: Number.isInteger(page?.pageNumber) && page.pageNumber > 0 ? page.pageNumber : index + 1, lines, text: lines.join('\n') };
  });
  // Attachment-local metadata is permitted only when it is an exact part heading.
  // An annual cover belonging to another attachment must not classify this one.
  const partField = value => /^(?:III|IIA|II)$/i.test(compact(value)) ? `Part ${compact(value)}` : value;
  const metadata = ownDocument ? [partField(selectedDocument.part), selectedDocument.description, selectedDocument.title] : [partField(cover.part), partField(cover.reportPart), partField(cover.formPart), cover.reportType, cover.description, partField(filing.part), filing.description, filing.primaryDocDescription];
  for (const descriptor of metadata) {
    const part = exactPart(descriptor);
    if (part) { parts.add(part); add('part', descriptor); }
  }
  let auditor = null, unaudited = null, disclaimer = false, reportedPeriod = null, asOf = null, annualHeading = false;
  const durations = [];
  for (const page of prepared) {
    const text = compact(page.text);
    const checklist = /this (?:filing|report).{0,30}contains|oath or affirmation/i.test(text);
    const contents = /\btable of contents\b/i.test(text);
    const coverPage = /\bfacing page\b|\bregistrant identification\b/i.test(text);
    const annualTitle = page.lines.find(line => /^annual (?:audited )?(?:financial )?reports?$/i.test(line));
    if (!checklist && !contents && annualTitle) { annualHeading = true; add('annual-heading', annualTitle, page.page); }
    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i], part = exactPart(line);
      const nearby = page.lines.slice(Math.max(0, i - 7), i + 8).join(' ');
      if (part && !contents && /X\s*-?\s*17A\s*-?\s*5|\bFOCUS\b|financial and operational combined|annual reports?|securities and exchange commission/i.test(nearby)) {
        parts.add(part); add('part', nearby, page.page);
      }
    }
    // Annual facing-page checklists, a contents list, and an accountant name do
    // not establish that the selected document contains any listed statement.
    if (!checklist && !contents && !coverPage) {
      const statementNumbers = (text.match(/(?:\$\s*)?\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\$\s*\d+(?:\.\d+)?/g) || []).length;
      for (const [component, pattern] of statementPatterns) {
        const heading = page.lines.find(line => pattern.test(line));
        if (heading && (component === 'notes' ? text.length > 300 : statementNumbers >= 3)) {
          components.add(component); add(component, heading, page.page);
        }
      }
      const auditHeading = /(?:report of (?:the )?independent (?:registered |certified )?public (?:accounting firm|accountants?)|independent (?:registered public accounting firm'?s|auditors?(?:'s|')?|accountants?(?:'s|')?) report)/i.test(text);
      const financialAudit = /\bwe (?:have )?audited (?:the )?(?:accompanying |consolidated |combined )*(?:financial statements?|statements? of (?:financial condition|financial position)|balance sheets?)|\bwe were engaged to audit (?:the )?(?:accompanying |consolidated |combined )*(?:financial statements?|statements? of (?:financial condition|financial position)|balance sheets?)/i.exec(text);
      if (auditHeading && financialAudit && /\bopinion\b/i.test(text)) {
        auditor = { page: page.page, scope: /financial statements|statements of (?:income|cash flows|operations)/i.test(financialAudit[0]) ? 'financial-statements' : 'financial-condition' };
        disclaimer ||= /\b(?:do not|did not|unable to|cannot) express (?:an? )?(?:audit )?opinion\b|\bdisclaimer of opinion\b/i.test(text);
        components.add('auditor-report');
        add('auditor-report', text.slice(Math.max(0, financialAudit.index - 70), financialAudit.index + 250), page.page);
      }
      const unauditedHeading = page.lines.find(line => /^(?:\(?unaudited\)?|(?:financial and operational combined uniform single report|FOCUS(?: report)?|(?:consolidated |condensed )?statements? of [\w '\-]+)\s*(?:-|—|:)?\s*\(?unaudited\)?)$/i.test(line));
      if (unauditedHeading) { unaudited = { page: page.page }; add('unaudited', unauditedHeading, page.page); }
    }
    if (coverPage && !checklist) {
      const designation = page.lines.find(line => /^\(?unaudited\)?$/i.test(line));
      if (designation) { unaudited = { page: page.page }; add('unaudited', designation, page.page); }
    }
    // Reporting dates must be stated as such; filing dates and auditor signature
    // dates are never used to manufacture a reporting period.
    if (!contents && (!checklist || coverPage)) {
      const range = text.match(new RegExp(`(?:filing for the )?period (?:beginning|from)\\s*(${datePattern})\\s*(?:and (?:ending|ended)|(?:through|to|-))\\s*(${datePattern})`, 'i'));
      if (range) {
        const start = parseDate(range[1]), end = parseDate(range[2]);
        if (start && end && start <= end && !reportedPeriod) { reportedPeriod = { start, end }; add('reporting-period', range[0], page.page); }
      }
      const duration = text.match(new RegExp(`\\b(year|quarter|month|three months|twelve months) ended\\s*(${datePattern})`, 'i'));
      const durationContext = coverPage || page.lines.some(line => exactPart(line) || statementPatterns.slice(0, 4).some(([, pattern]) => pattern.test(line))) || (auditor?.page === page.page);
      if (duration && durationContext && !page.lines.some(line => statementPatterns.find(([kind]) => kind === 'notes')[1].test(line))) {
        const end = parseDate(duration[2]);
        if (end) durations.push({ end, frequency: /year|twelve/i.test(duration[1]) ? 'annual' : /quarter|three/i.test(duration[1]) ? 'quarterly' : 'monthly', text: duration[0], page: page.page });
      }
      if (!asOf && (coverPage || page.lines.some(line => exactPart(line) || statementPatterns[0][1].test(line))) && !/\bwe (?:have )?audited\b/i.test(text)) {
        const date = text.match(new RegExp(`\\bas (?:of|at)\\s*(${datePattern})`, 'i'));
        if (date && parseDate(date[1])) asOf = parseDate(date[1]);
      }
    }
  }
  const matchingDurations = durations.filter(item => (!reportedPeriod?.end && !asOf) || item.end === (reportedPeriod?.end || asOf));
  const durationConflict = new Set(matchingDurations.map(item => `${item.end}:${item.frequency}`)).size > 1;
  const datedDuration = durationConflict ? null : matchingDurations[0];
  if (durationConflict) limitations.push('The selected document contains conflicting reporting durations. A single frequency was not assigned.');
  const explicitFrequency = datedDuration?.frequency || '';
  if (datedDuration) add('reporting-period', datedDuration.text, datedDuration.page);
  const ownRangeDays = reportedPeriod ? (Date.parse(reportedPeriod.end) - Date.parse(reportedPeriod.start)) / 86400000 + 1 : 0;
  const annualPeriod = explicitFrequency === 'annual' || (ownRangeDays >= 365 && ownRangeDays <= 366);
  const annualPart = parts.has('Part III'), periodicPart = ['Part II', 'Part IIA', 'Schedule I'].some(part => parts.has(part));
  let family = annualPart ? 'annual-report' : periodicPart ? 'periodic-focus' : annualHeading || (auditor && annualPeriod) ? 'annual-report' : 'unknown';
  if (annualPart && periodicPart) { family = 'unknown'; limitations.push('The selected document contains both annual and periodic report headings. Review the source before comparing periods.'); }
  if (periodicPart) components.add('operational-schedules');
  const audit = auditor ? { status: 'auditor-report-present', scope: auditor.scope } : unaudited ? { status: 'explicitly-unaudited' } : { status: 'not-established' };
  if (auditor && unaudited) limitations.push('An auditor report and an unaudited designation both appear. The audit scope does not automatically extend to every schedule.');
  if (disclaimer) limitations.push('The auditor report contains a disclaimer of opinion; the presence of the report does not establish a completed audit opinion.');
  if (family === 'annual-report' && !auditor) limitations.push('The annual report classification does not establish audit status. An auditor name or facing-page checklist is insufficient.');
  if (family === 'periodic-focus' && !auditor && !unaudited) limitations.push('Periodic FOCUS classification does not establish whether the report is audited or unaudited.');
  if (family === 'unknown') limitations.push('The X-17A-5 form code alone does not distinguish an annual report from a periodic FOCUS report.');
  const documentHasPeriod = Boolean(reportedPeriod || asOf || datedDuration);
  const coverPart = exactPart(partField(cover.part || cover.reportPart || cover.formPart || ''));
  const incompatibleCover = ownDocument && family === 'periodic-focus' && (coverPart === 'Part III' || (!coverPart && parseDate(cover.periodBegin) && parseDate(cover.reportDate) && Date.parse(cover.reportDate) - Date.parse(cover.periodBegin) > 300 * 86400000));
  const matchingAnnualCover = family === 'annual-report' && coverPart === 'Part III' && asOf && asOf === parseDate(cover.reportDate || cover.periodEnd);
  let start = reportedPeriod?.start || (!incompatibleCover && (!documentHasPeriod || matchingAnnualCover) ? parseDate(cover.periodBegin || cover.periodStart) : '') || '';
  const end = reportedPeriod?.end || asOf || datedDuration?.end || (!incompatibleCover ? parseDate(cover.reportDate || cover.periodEnd) || parseDate(filing.reportDate || filing.periodEnd) : '') || '';
  if (start && end && start > end) start = '';
  let frequency = explicitFrequency || 'unknown';
  if (start && end) {
    const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
    frequency = days >= 365 && days <= 366 ? 'annual' : days >= 89 && days <= 92 ? 'quarterly' : days >= 28 && days <= 31 ? 'monthly' : 'other';
  }
  if (incompatibleCover && !documentHasPeriod) limitations.push('Annual filing metadata was not assigned to the selected periodic attachment; its reporting dates were not established.');
  const label = family === 'annual-report' ? auditor && !disclaimer && !unaudited ? 'Annual audited report' : 'Annual report' : family === 'periodic-focus' ? 'Periodic FOCUS report' : 'Unclassified broker-dealer report';
  return { version: BROKER_DEALER_CLASSIFICATION_VERSION, family, label, parts: [...parts], audit, period: { start, end, frequency }, components: [...components], evidence, limitations };
}
