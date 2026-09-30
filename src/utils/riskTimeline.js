import { reportingPeriods, sourceDocumentUrl } from './xbrlPeriods.js';
import { buildMetricRow } from './xbrlParser.js';
import { evidenceSources } from './researchEvidence.js';
import { riskDebtBalances } from './riskFinancialMappings.js';
import { riskComparisonIssue } from './riskFinancialScope.js';
import { classifyRiskIndustry } from './riskAnalysis.js';
import { disclosurePassages, passageSignals, compareDisclosurePassages } from './disclosureResearch.js';
import { parseDisclosureQuery, matchesQuery } from './disclosureQuery.js';
import { extractRefinancingProfile } from './refinancing/maturities.js';

export const RISK_TIMELINE_VERSION = 'risk-timeline-v1';
export const RISK_TIMELINE_LIMITS = { filings: 4, archives: 2, passages: 64, eventsPerTopic: 3, excerpt: 2200 };
export const RISK_TIMELINE_TOPICS = [
  { id: 'cash', label: 'Cash & earnings', query: '"cash flow" OR "cash flows" OR "cash generation" OR "cash used" OR "cash runway"' },
  { id: 'refinancing', label: 'Debt & funding', query: 'refinancing OR "debt maturities" OR "maturing debt" OR "credit facility" OR "credit facilities"' },
  { id: 'customers', label: 'Customer concentration', query: '"customer concentration" OR "major customer" OR "largest customer" OR "significant customer" OR "customers accounted" OR "customer accounted" OR "revenues from"' },
  { id: 'covenants', label: 'Covenants', query: 'covenant OR covenants OR "waiver of" OR "in violation"' },
  { id: 'collateral', label: 'Collateral', query: '"additional collateral" OR "collateral requirements" OR "collateral requirement" OR "post collateral" OR "posted collateral" OR "pledge collateral" OR "pledged assets" OR "collateral calls"' },
];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;

/** Original reports only. Avoid mixing form families or duplicate report dates. */
export function selectRiskTimelineFilings(filings, mode = 'annual') {
  const eligible = filings.filter(f => (mode === 'quarterly' ? /^10-Q$/ : /^(10-K|20-F|40-F)$/).test(f.form)
    && f.reportDate && f.filingDate && f.primaryDoc)
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.filingDate.localeCompare(a.filingDate));
  const form = eligible[0]?.form, seen = new Set();
  return eligible.filter(f => {
    if (f.form !== form || seen.has(f.reportDate)) return false;
    seen.add(f.reportDate); return true;
  }).slice(0, RISK_TIMELINE_LIMITS.filings).reverse();
}

function financialPoint(facts, key, label, filing, sic, cik) {
  if (key === 'nextMaturities') {
    const schedule = extractRefinancingProfile({ cik, facts }, { cik, sic, asOf: filing.filingDate });
    const bucket = schedule.buckets?.[0];
    if (schedule.asOf !== filing.reportDate || schedule.accession !== filing.accession || !finite(bucket?.value) || !bucket.source)
      return { value: null, sources: [], reason: 'A next-year maturity bucket in this original report was not found.' };
    return { value: bucket.value, sources: [bucket.source], source: bucket.source,
      formula: `Reported ${schedule.basis === 'fiscal' ? 'next fiscal-year' : 'next rolling-year'} principal maturities`,
      window: { start: bucket.startDate, end: bucket.endDate, basis: bucket.dateBasis, scheduleBasis: schedule.basis } };
  }
  const kind = filing.form === '10-Q' ? 'quarter' : 'annual';
  const period = reportingPeriods(facts, kind, filing.filingDate).find(p => p.end === filing.reportDate);
  if (!period) return { value: null, sources: [], reason: 'A compatible fiscal period was not identified.' };
  const point = key === 'currentDebt' ? riskDebtBalances(facts, period).current
    : buildMetricRow(facts, key, label, [period], 'currency', sic).values[0];
  const sources = evidenceSources(point).map(source => ({ ...source, documentUrl: sourceDocumentUrl(cik, source) }));
  // All component inputs must be available by this original report's filing date.
  if (!finite(point?.value) || !sources.length || sources.some(s => !s.filed || s.filed > filing.filingDate || s.unit !== 'USD'))
    return { value: null, sources: [], reason: 'Compatible USD inputs available by this filing date were not found.' };
  return { ...point, sources, period };
}

export function buildRiskFinancialTimeline(facts, sic, cik, filings) {
  const industry = classifyRiskIndustry(sic), bank = industry.isBank;
  const mappingSic = bank ? 6021 : industry.isInsurer ? 6311 : sic;
  const measures = bank ? [
    { key: 'netIncome', label: 'Net income', topic: 'cash', goodUp: true },
    { key: 'deposits', label: 'Deposits', topic: 'refinancing', goodUp: true, context: true },
  ] : industry.isFinancial ? [
    { key: 'netIncome', label: 'Net income', topic: 'cash', goodUp: true, context: true },
    { key: 'currentDebt', label: 'Current debt', topic: 'refinancing', goodUp: false, context: true },
  ] : [
    { key: 'operatingCashFlow', label: 'Operating cash flow', topic: 'cash', goodUp: true },
    { key: 'currentDebt', label: 'Current debt', topic: 'refinancing', goodUp: false, context: true },
  ];
  if (!bank && filings[0]?.form !== '10-Q') measures.push({ key: 'nextMaturities', label: 'Next-year principal maturities', topic: 'refinancing', goodUp: false, context: true });
  const observations = filings.map(filing => ({ filing, measures: measures.map(measure => ({ ...measure,
    point: financialPoint(facts, measure.key, measure.label, filing, mappingSic, cik) })) }));
  const events = [], coverage = [];
  for (let i = 1; i < observations.length; i++) {
    const before = observations[i - 1], after = observations[i];
    for (const measure of after.measures) {
      const prior = before.measures.find(m => m.key === measure.key).point, current = measure.point;
      const gap = days(before.filing.reportDate, after.filing.reportDate);
      const maxGap = after.filing.form === '10-Q' ? 200 : 460;
      const signature = point => [...new Set((point.sources || []).map(s => [s.taxonomy, s.tag, s.unit, s.balanceClassification || '', s.debtScope || ''].join(':')))].sort().join('|');
      const issue = !finite(prior.value) || !finite(current.value) ? 'Compatible inputs missing'
        : gap <= 0 || gap > maxGap ? 'Reporting-period gap'
        : riskComparisonIssue(current, prior) || (signature(current) !== signature(prior) ? 'Reported concept scopes differ' : null);
      coverage.push({ topic: measure.topic, current: after.filing.accession, prior: before.filing.accession,
        status: issue ? 'unavailable' : 'compared', reason: issue || '' });
      if (issue) continue;
      const delta = current.value - prior.value;
      const relative = prior.value === 0 ? null : delta / Math.abs(prior.value);
      const crossedZero = prior.value >= 0 && current.value < 0 || prior.value < 0 && current.value >= 0;
      if (!delta || !crossedZero && relative != null && Math.abs(relative) < .15) continue;
      const direction = delta > 0 ? 'rose' : 'fell';
      const level = measure.context ? 'context' : (delta > 0) === measure.goodUp ? 'improving' : 'weakening';
      events.push({ id: `financial:${measure.key}:${after.filing.accession}`, topic: measure.topic, kind: 'financial', level,
        title: `${measure.label} ${direction}`, label: measure.label, format: 'usd', delta,
        percentChange: prior.value > 0 ? delta / prior.value * 100 : null,
        date: after.filing.reportDate, filedAt: after.filing.filingDate,
        before: { filing: before.filing, value: prior.value, sources: prior.sources, formula: prior.formula || 'Reported SEC fact', ...(prior.window ? { window: prior.window } : {}) },
        after: { filing: after.filing, value: current.value, sources: current.sources, formula: current.formula || 'Reported SEC fact', ...(current.window ? { window: current.window } : {}) },
        note: measure.key === 'nextMaturities' ? 'Successive reported next-year maturity buckets cover different obligation windows. Fiscal-year anniversary dates are indicative for noncalendar filers. This is a change in the scheduled near-term burden, not a change in the same calendar-year debt or a finding of a refinancing shortfall.'
          : measure.key === 'currentDebt' ? 'Current borrowing balance, including reported current maturities. A higher balance is a prompt to review funding; it does not establish a refinancing shortfall.'
          : measure.key === 'deposits' ? 'Deposit movements can reflect flows, acquisitions, pricing and currency. Direction alone is not a funding-risk conclusion.'
          : industry.isFinancial ? 'Reported earnings, not a measure of available institutional liquidity or regulatory capital.'
            : after.filing.form === '10-Q' ? 'Quarterly cash flows are standalone quarters; seasonal differences can affect comparisons.'
              : 'Annual operating cash flow. Working-capital timing, acquisitions and operating changes can affect the comparison.',
        basis: after.filing.form === '10-Q' ? 'Standalone quarter' : 'Fiscal year',
      });
    }
  }
  return { events, observations: observations.map(({ filing, measures }) => ({ filing,
    measures: measures.map(m => ({ key: m.key, label: m.label, topic: m.topic, value: m.point.value, sources: m.point.sources })) })), coverage };
}

// Ignore typography and rolling calendar years, but retain percentages, amounts,
// negation and contract wording. Date-only boilerplate is not a risk change.
const semantic = text => text.toLowerCase().replace(/\b(as of|at|for (?:the )?(?:year|quarter|period|three months|six months|nine months) ended)\s+(?:(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+(?:19|20)\d{2}|(?:19|20)\d{2}-\d{2}-\d{2})\b/g, '$1 REPORT_DATE')
  .replace(/[,\u2018\u2019\u201c\u201d]/g, '').replace(/\s+/g, ' ').trim();
function excerpt(text, terms) {
  if (text.length <= RISK_TIMELINE_LIMITS.excerpt) return { text, excerpted: false };
  const indexes = terms.map(term => text.toLowerCase().indexOf(term.toLowerCase())).filter(i => i >= 0);
  const focus = indexes.length ? Math.min(...indexes) : 0;
  const start = Math.max(0, focus - 500), end = Math.min(text.length, start + RISK_TIMELINE_LIMITS.excerpt);
  return { text: text.slice(start, end), excerpted: true };
}
export function extractRiskTimelinePassages(text, filing) {
  const extracted = disclosurePassages(text, filing.form);
  const analyses = RISK_TIMELINE_TOPICS.map(topic => {
    const parsed = parseDisclosureQuery(topic.query);
    // Compare relevant prose in recognized sections; table cells and contents
    // headings cannot establish covenant/customer/collateral changes.
    const prose = extracted.paragraphs.filter(p => p.text.length >= 80 && p.text.length <= 12000
      && (p.text.match(/[a-z]/gi)?.length || 0) / p.text.length > .45 && matchesQuery(p.text, parsed))
      .map(p => ({ ...p, ...passageSignals(p.text, parsed.positive, p.sectionId) }));
    const matches = [...prose].sort((a, b) => Number(b.sectionId !== 'other') - Number(a.sectionId !== 'other') || b.relevance - a.relevance)
      .slice(0, RISK_TIMELINE_LIMITS.passages).sort((a, b) => a.index - b.index);
    return { topic, form: filing.form, sections: extracted.sections, paragraphs: matches, matches, truncated: prose.length > matches.length,
      matchedCount: prose.length, terms: parsed.positive };
  });
  // A newly required collateral clause may match a prior funding paragraph
  // that never said "collateral". Reuse bounded related prose as candidates.
  const pool = [...new Map(analyses.flatMap(a => a.matches).map(p => [p.index, p])).values()];
  return analyses.map(a => ({ ...a, paragraphs: pool }));
}
export function compareRiskTimelinePassages(prior, current, priorFiling, currentFiling) {
  const events = [], coverage = [];
  for (const after of current) {
    const before = prior.find(p => p.topic.id === after.topic.id);
    const comparison = compareDisclosurePassages(after, before);
    coverage.push({ topic: after.topic.id, current: currentFiling.accession, prior: priorFiling.accession,
      priorMatches: before.matchedCount, currentMatches: after.matchedCount,
      sections: after.sections.map(s => s.label), truncated: before.truncated || after.truncated,
      status: comparison.comparisonError ? 'unavailable' : !before.matchedCount && !after.matchedCount ? 'missing'
        : !before.matchedCount || !after.matchedCount ? 'uncompared' : 'compared',
      reason: comparison.comparisonError || (!before.matchedCount && !after.matchedCount ? 'No matching prose for this driver in either report.' : '') });
    if (comparison.comparisonError) continue;
    const candidates = comparison.matches.filter(p => p.change === 'revised' && p.sectionId !== 'other'
      && p.priorText && p.text && semantic(p.priorText) !== semantic(p.text))
      .sort((a, b) => b.relevance - a.relevance || a.index - b.index);
    const seen = new Set();
    for (const change of candidates) {
      if (seen.size >= RISK_TIMELINE_LIMITS.eventsPerTopic) break;
      const key = semantic(change.text || change.priorText);
      if (seen.has(key)) continue;
      seen.add(key);
      const old = excerpt(change.priorText || '', after.terms), next = excerpt(change.text || '', after.terms);
      events.push({ id: `text:${after.topic.id}:${currentFiling.accession}:${change.index}:${change.change}`,
        topic: after.topic.id, kind: 'disclosure', level: 'review', change: change.change,
        title: `${after.topic.label} ${change.change === 'revised' ? 'changed' : 'passage unmatched'}`,
        label: after.topic.label, date: currentFiling.reportDate, filedAt: currentFiling.filingDate,
        before: { filing: priorFiling, ...old, section: change.section, matched: Boolean(change.priorText) },
        after: { filing: currentFiling, ...next, section: change.section, matched: Boolean(change.text) },
        note: change.change === 'revised' ? 'Matched passage changed. Read the highlighted wording in both originals; a change is not proof of deteriorating risk.'
          : 'A passage was not matched across these reports. It does not establish a new obligation, the beginning of a risk, or its resolution.',
        basis: 'Filing text',
      });
    }
  }
  return { events, coverage };
}
