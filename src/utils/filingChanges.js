import { daysBetween } from './xbrlPeriods.js';
import { buildMetricRow, extractAnnualPeriods, extractQuarterlyPeriods } from './xbrlParser.js';
import { metricDefinitions } from './researchWorkspace.js';

export const CHANGE_VERSION = 'filing-diff-v3-context-v2';
const REPORT = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;
const RISK_TERMS = [
  ['Liquidity and funding', /\bliquidity\b|\bfunding\b|\bdeposits?\b|\bcash runway\b/i],
  ['Covenants and solvency', /\bcovenants?\b|\bgoing concern\b|\bsubstantial doubt\b|\bdefault\b/i],
  ['Credit quality', /\bcredit loss|\bnonperforming\b|\bnonaccrual\b|\bcharge.off/i],
  ['Controls and accounting', /\bmaterial weakness\b|\brestatement\b|\bnon.reliance\b/i],
  ['Cybersecurity', /\bcyber|\bransomware\b|\bdata breach\b/i],
  ['Concentration and supply chain', /\bconcentration\b|\bmajor customer\b|\btariffs?\b|\bsupply chain\b/i],
];

export function selectFilingPair(filings, { comparison = 'year', baseline = '' } = {}) {
  const reports = filings.filter((f) => REPORT.test(f.form) && f.reportDate && f.primaryDoc)
    .sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession));
  const current = reports[0];
  if (!current) return { current: null, prior: null, reason: 'No supported periodic report was found in the inspected filing history.' };
  if (baseline) {
    const prior = reports.find((f) => f.accession === baseline);
    if (!prior) return { current, prior: null, reason: 'The saved baseline report was not found in the inspected filing history.' };
    if (prior.accession === current.accession) return { current, prior, unchanged: true, reason: 'No newer periodic report since your saved review.' };
    if (prior.filingDate > current.filingDate) return { current, prior: null, reason: 'The baseline must precede the current filing.' };
    return { current, prior, reason: 'Compared with the periodic report saved at your last review.' };
  }
  const form = current.form.replace('/A', '');
  const candidates = reports.filter((f) => f.form.replace('/A', '') === form && f.reportDate < current.reportDate);
  const prior = comparison === 'previous' ? candidates[0]
    : candidates.find((f) => Math.abs(daysBetween(f.reportDate, current.reportDate) - 365.25) <= 35);
  return { current, prior: prior || null, reason: prior
    ? comparison === 'previous' ? 'Previous report of the same form; reporting quarters may differ.' : 'Same reporting season one year earlier.'
    : 'No comparable report was found in the inspected filing history. Try the previous-report comparison.' };
}

const normalized = (s) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const subject = (s) => normalized(s).split(' ').find((word) => word.length > 2 && !['the', 'and', 'our', 'its', 'this', 'that'].includes(word));
const tokens = (s) => new Set(normalized(s).split(' ').filter((w) => w.length > 2));
function similarity(a, b) {
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return common / Math.max(1, a.size + b.size - common);
}

/** Heading-based extraction, not a claim to cover every footnote or exhibit. */
export function extractResearchSections(text, form) {
  const quarterly = form.startsWith('10-Q');
  const definitions = [
    { id: 'risk', label: 'Risk factors', item: '1A', title: /risk\s+factors/i },
    { id: 'mda', label: 'Management discussion and analysis', item: quarterly ? '2' : '7', title: /management.{0,12}discussion/i },
  ];
  // Ignore table-of-contents hits by requiring substantial body text; when a
  // heading repeats, retain the longest section bounded by the next item.
  const headings = [...text.matchAll(/(?:^|\n)\s*item\s+(\d+[A-Z]?)\s*[.\-:—]?\s*/gim)];
  const sections = definitions.map((definition) => {
    const candidates = headings.flatMap((heading, i) => {
      if (heading[1].toUpperCase() !== definition.item) return [];
      const headingText = text.slice(heading.index, heading.index + 180);
      if (!definition.title.test(headingText)) return [];
      const end = headings[i + 1]?.index ?? text.length;
      const body = text.slice(heading.index + heading[0].length, end).trim();
      return body.length >= 120 ? [body] : [];
    }).sort((a, b) => b.length - a.length);
    let body = candidates[0] || '';
    let extraction = 'numbered item heading';
    const headingOnly = definition.id === 'mda' ? /^management.{0,12}discussion and analysis(?: of financial condition and results of operations)?[.\s]*$/i : /^risk\s+factors[.\s]*$/i;
    const paragraphsOf = (value) => value.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p.length >= 80 && (p.match(/[a-z]/gi)?.length || 0) / p.length > 0.45)
      .filter((p) => !headingOnly.test(p));
    // Some bank filings number only the contents page and introduce the actual
    // MD&A in narrative prose. Do not count the contents title as reviewed text.
    if (definition.id === 'mda' && paragraphsOf(body).length < 3) {
      const intro = /(?:^|\n)\s*The following is Management.{0,12}discussion and analysis[^\n]*/im.exec(text);
      if (intro) {
        const remaining = text.slice(intro.index);
        const ending = /\n\s*(?:CONSOLIDATED STATEMENTS OF (?:INCOME|EARNINGS)|CONSOLIDATED FINANCIAL STATEMENTS|FINANCIAL STATEMENTS)(?:\s*\([^\n]{0,50}\))?\s*(?:\n|[–—])/i.exec(remaining);
        if (ending && ending.index > 500) {
          body = remaining.slice(0, ending.index);
          extraction = 'MD&A narrative introduction to financial-statement heading';
        }
      }
    }
    const all = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p.length >= 80 && (p.match(/[a-z]/gi)?.length || 0) / p.length > 0.45)
      .filter((p) => !headingOnly.test(p));
    const seen = new Set();
    const paragraphs = all.filter((p) => { const key = normalized(p); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 220);
    return { id: definition.id, label: definition.label, found: paragraphs.length > 0, referenceOnly: all.length > 0 && all.every((p) => /^(?:refer to|see |there (?:have been|were) no material changes)|incorporated by reference|no material changes to/i.test(p)), extraction, paragraphs, totalParagraphs: all.length, truncated: all.length > 220 };
  });
  return sections;
}

export function compareDisclosureText(priorText, currentText, priorForm, currentForm = priorForm) {
  const before = extractResearchSections(priorText, priorForm);
  const after = extractResearchSections(currentText, currentForm);
  const changes = [];
  const coverage = [];
  for (const section of after) {
    const old = before.find((s) => s.id === section.id);
    coverage.push({ section: section.label, currentFound: section.found, priorFound: !!old?.found,
      currentParagraphs: section.paragraphs.length, priorParagraphs: old?.paragraphs.length || 0,
      truncated: section.truncated || old?.truncated || false, referenceOnly: section.referenceOnly || old?.referenceOnly || false, extraction: section.extraction });
    if (!section.found || !old?.found) continue;
    const oldByText = new Map(old.paragraphs.map((p, i) => [normalized(p), i]));
    const used = new Set();
    const newParagraphs = section.paragraphs.filter((p) => { const i = oldByText.get(normalized(p)); if (i != null) { used.add(i); return false; } return true; });
    const oldTokens = old.paragraphs.map(tokens);
    for (const paragraph of newParagraphs) {
      const words = tokens(paragraph);
      let best = -1; let score = 0.52;
      for (let i = 0; i < old.paragraphs.length; i++) {
        if (used.has(i) || subject(paragraph) !== subject(old.paragraphs[i])) continue;
        const candidate = similarity(words, oldTokens[i]);
        if (candidate > score) { score = candidate; best = i; }
      }
      if (best >= 0) used.add(best);
      const prior = best >= 0 ? old.paragraphs[best] : '';
      const themes = RISK_TERMS.filter(([, re]) => re.test(paragraph)).map(([label]) => label);
      const introducedThemes = RISK_TERMS.filter(([, re]) => re.test(paragraph) && !re.test(prior)).map(([label]) => label);
      changes.push({ section: section.label, type: prior ? 'modified' : 'added', before: prior, after: paragraph, themes, introducedThemes,
        reason: introducedThemes.length ? `Newly matched language in this paragraph: ${introducedThemes.join(', ')}. Read in context; a mention is not proof of deterioration.` : prior ? 'Wording or numbers changed in a matched paragraph.' : 'Paragraph not matched in the prior section.',
        priority: introducedThemes.length * 3 + themes.length + (section.id === 'risk' ? 2 : 0) });
    }
    old.paragraphs.forEach((p, i) => { if (!used.has(i)) changes.push({ section: section.label, type: 'removed', before: p, after: '', themes: RISK_TERMS.filter(([, re]) => re.test(p)).map(([label]) => label), introducedThemes: [], reason: 'Prior paragraph not matched in the current section. Removal alone does not establish that a risk was resolved.', priority: 1 }); });
  }
  changes.sort((a, b) => b.priority - a.priority);
  return { changes: changes.slice(0, 40), totalChanges: changes.length, truncated: changes.length > 40 || coverage.some((s) => s.truncated), coverage };
}

export function compareFinancialReports(facts, sic, prior, current) {
  const periodFor = (filing) => {
    const annual = !filing.form.startsWith('10-Q');
    const periods = annual ? extractAnnualPeriods(facts, filing.filingDate) : extractQuarterlyPeriods(facts, filing.filingDate);
    return periods.find((p) => p.end === filing.reportDate) || { fy: Number(filing.reportDate.slice(0, 4)), fp: annual ? 'FY' : 'Q?', kind: annual ? 'annual' : 'quarter', end: filing.reportDate, asOf: filing.filingDate };
  };
  const beforePeriod = periodFor(prior); const afterPeriod = periodFor(current);
  if (beforePeriod.kind !== afterPeriod.kind) return [];
  return metricDefinitions(sic).map(([key, label]) => {
    const before = buildMetricRow(facts, key, label, [beforePeriod], 'currency', sic).values[0];
    const after = buildMetricRow(facts, key, label, [afterPeriod], 'currency', sic).values[0];
    const comparable = before.value != null && after.value != null && before.source?.unit === after.source?.unit;
    return { key, label, before, after, delta: comparable ? after.value - before.value : null,
      percentChange: comparable && before.value > 0 ? (after.value - before.value) / before.value * 100 : null };
  });
}
