import { buildRiskResearchModel } from './riskResearchModel.js';
import { RISK_CAPITAL_PURCHASE_NOTE, RISK_DEBT_SCOPE_NOTE, riskCashLabel, riskComparisonIssue } from '../../utils/riskFinancialScope.js';
import { isRefinancingProfile } from '../../utils/refinancing/projection.js';

// Descriptive events over loaded SEC observations. Selection is a transparent
// change screen, never a risk grade, forecast, maturity schedule or causal claim.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const day = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp / 86400000 : null;
};
const days = (a, b) => day(a) != null && day(b) != null ? day(a) - day(b) : NaN;
const cik = value => /^\d{1,10}$/.test(String(value || '')) && Number(value) > 0 ? String(Number(value)) : null;
const FINANCIAL = new Set(['bank', 'broker', 'life', 'property', 'insurance', 'financial']);
const CATEGORIES = [
  ['cash-generation', 'Earnings & cash'], ['liquidity', 'Liquidity'], ['refinancing', 'Debt & funding'],
  ['capital', 'Capital'], ['asset-quality', 'Asset quality'], ['investment', 'Investment'], ['distributions', 'Distributions'],
].map(([id, label]) => ({ id, label }));
const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map(item => [item.id, item.label]));
const FLOW_INPUTS = {
  reported_netIncome: ['netIncome'], reported_operatingIncome: ['operatingIncome'], reported_operatingCashFlow: ['operatingCashFlow'],
  reported_capitalExpenditure: ['capitalExpenditure'], reported_dividendsPaid: ['dividendsPaid'],
  cash_after_capex: ['operatingCashFlow', 'capitalExpenditure'], cash_investment_cover: ['operatingCashFlow', 'capitalExpenditure'],
  historical_burn_months: ['operatingCashFlow'], interest_coverage: ['operatingIncome', 'interestExpense'],
  ocf_to_debt: ['operatingCashFlow'], fcf_to_debt: ['operatingCashFlow', 'capitalExpenditure'], fcf_to_current_debt: ['operatingCashFlow', 'capitalExpenditure'],
  net_margin: ['netIncome', 'revenue'], accruals_ratio: ['netIncome', 'operatingCashFlow'],
  receivables_gap: ['revenue'], provision_rate: ['provision'], bank_earnings_assets: ['netIncome'],
  bank_preprovision_credit_cost: ['netInterestIncome', 'noninterestIncome', 'noninterestExpense', 'provision'],
};
const PP_MINIMUM = {
  bank_equity_assets: .005, broker_equity_assets: .005, ins_equity_assets: .005, htm_adj_equity: .005,
  npl_ratio: .001, provision_rate: .001, bank_earnings_assets: .001,
  bank_cash_deposits: .02, nib_deposit_share: .05, loans_deposits: .05, bank_htm_gap_equity: .05,
  current_debt_share: .05, net_margin: .02, loss_ratio: .02, accruals_ratio: .02, receivables_gap: .03,
  liab_to_assets: .02, cash_investment_cover: .10, ocf_to_debt: .05, fcf_to_debt: .05,
};
const REASONS = {
  missing: 'Missing observation or source inputs', dates: 'Nonadjacent or mixed reporting periods',
  scope: 'Different source concepts, units or accounting scope', entity: 'Different or unverified issuer scope',
  evidence: 'Unverified SEC source evidence', duration: 'Incompatible flow intervals or balance dates',
  cutoff: 'Evidence unavailable by the selected filing cutoff',
};
const CRITERIA = [
  { id: 'usd', label: 'Dollar changes', detail: 'At least 15% of the absolute prior value and at least $1m or 0.05% of supported ending assets, whichever is larger. A move from zero or through zero uses the same dollar minimum.' },
  { id: 'pp', label: 'Percentage-point changes', detail: 'An absolute measure-specific change of 0.1–10 percentage points. Each event states its exact threshold; these are display filters, not risk thresholds.' },
  { id: 'multiple', label: 'Multiple changes', detail: 'At least 15% of the absolute prior value and 0.25×; interest coverage requires 1× and credit-cost or reserve coverage 0.5×.' },
  { id: 'months', label: 'Historical cash-use months', detail: 'At least 15% of the absolute prior value and three months. This compares historical cash use, not forecast runway.' },
];

function officialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['sec.gov', 'www.sec.gov', 'data.sec.gov'].includes(url.hostname) ? url : null;
  } catch { return null; }
}

function sourceIdentity(source) {
  const ids = [cik(source.sourceCik)];
  let verified = false;
  for (const value of [source.documentUrl, source.url].filter(Boolean)) {
    const url = officialUrl(value);
    if (!url) return null;
    const archive = url.pathname.match(/^\/Archives\/edgar\/data\/(\d+)\/(\d{18})(?:\/|$)/);
    const concept = url.pathname.match(/^\/api\/xbrl\/companyconcept\/CIK(\d{10})\/([^/]+)\/([^/]+)\.json$/);
    if (archive) {
      if (!/^\d{10}-\d{2}-\d{6}$/.test(source.accession || '') || archive[2] !== source.accession.replaceAll('-', '')) return null;
      ids.push(cik(archive[1]));
      verified = true;
    } else if (concept) {
      try {
        if (decodeURIComponent(concept[2]) !== (source.taxonomy || 'us-gaap') || decodeURIComponent(concept[3]) !== source.tag) return null;
      } catch { return null; }
      ids.push(cik(concept[1]));
      verified = true;
    } else return null;
  }
  const unique = [...new Set(ids.filter(Boolean))];
  return verified && unique.length === 1 ? unique[0] : null;
}

function scopeSignature(point) {
  return [...new Set(point.sources.map(source => [source.taxonomy || 'us-gaap', source.tag, source.unit || '', source.scopeNote || '', source.balanceClassification || '', source.debtScope || ''].join(':')))].sort().join('|');
}

function fullWindow(point, end) {
  const start = point?.start;
  return finite(point?.value) && point.end === end && point.sources?.length && day(start) != null && days(end, start) >= 299 && days(end, start) <= 399 ? start : null;
}

const inputKey = source => [source.taxonomy || 'us-gaap', source.tag, source.unit || '', source.start || '', source.end, source.accession || '', source.value,
  source.sourceCik || '', source.filed || '', source.form || '', source.documentUrl || '', source.url || ''].join('|');

function observationWindow(metric, point, profile) {
  const inputs = FLOW_INPUTS[metric.id];
  if (inputs) {
    const sourceKeys = new Set(point.sources.map(inputKey));
    const rows = inputs.map(key => profile.reportedFlows?.[key]?.find(row => row.end === point.end));
    // Proving a duration with an unrelated row would detach the displayed
    // value from its evidence. Each full-window input must occur in this point.
    if (rows.some(row => !row?.sources?.length || row.sources.some(source => !sourceKeys.has(inputKey(source))))) return null;
    const starts = rows.map(row => fullWindow(row, point.end));
    return starts.every(Boolean) && new Set(starts).size === 1 ? { start: starts[0] } : null;
  }
  if (metric.id === 'loss_ratio') {
    const labels = ['Claims and benefits incurred', 'Premiums earned'];
    const starts = labels.map(label => {
      const calculation = point.calculations?.find(row => row.label === label && row.end === point.end && day(row.start) != null && days(row.end, row.start) >= 299 && days(row.end, row.start) <= 399);
      if (calculation) return calculation.start;
      return point.sources.find(source => source.label === label && source.end === point.end && day(source.start) != null && days(source.end, source.start) >= 299 && days(source.end, source.start) <= 399)?.start;
    });
    return starts.every(Boolean) && new Set(starts).size === 1 ? { start: starts[0] } : null;
  }
  // Every other selected metric is a same-date balance or a ratio of balances.
  return point.sources.some(source => source.start) ? null : { start: null };
}

function validateObservation(metric, point, period, profile, expectedCik, cutoff) {
  if (!point || !finite(point.value) || !point.sources?.length) return { reason: 'missing' };
  if (point.end !== period.end || (point.kind && point.kind !== profile.basis) || (point.fy != null && period.fy != null && point.fy !== period.fy) || (point.fp && period.fp && point.fp !== period.fp)) return { reason: 'dates' };
  if (point.sources.length > 32) return { reason: 'evidence' };
  const identities = [];
  for (const source of point.sources) {
    if (!source.tag || !source.unit || !/^\d{10}-\d{2}-\d{6}$/.test(source.accession || '') || !finite(source.value) || day(source.end) == null || source.end > point.end || (source.start && (day(source.start) == null || source.start > source.end)) || (source.filed && (day(source.filed) == null || source.filed < source.end))) return { reason: 'evidence' };
    const identity = sourceIdentity(source);
    if (!identity || (expectedCik && identity !== expectedCik)) return { reason: 'entity' };
    identities.push(identity);
    if (cutoff && (point.end > cutoff || !source.filed || source.filed > cutoff)) return { reason: 'cutoff' };
  }
  if (new Set(identities).size !== 1) return { reason: 'entity' };
  const window = observationWindow(metric, point, profile);
  if (!window) return { reason: 'duration' };
  const instant = point.sources.filter(source => !source.start);
  if (instant.some(source => source.end !== point.end && !(metric.id === 'receivables_gap' && days(point.end, source.end) >= 300 && days(point.end, source.end) <= 400))) return { reason: 'duration' };
  // Growth-difference evidence contains current and year-ago revenue windows.
  if (metric.id === 'receivables_gap') {
    const previous = profile.reportedFlows?.revenue?.find(row => days(point.end, row.end) >= 300 && days(point.end, row.end) <= 400 && fullWindow(row, row.end));
    if (!previous || !instant.some(source => source.end === previous.end)) return { reason: 'duration' };
  }
  return { start: window.start, identity: identities[0] };
}

function adjacent(before, after, basis) {
  const interval = days(after.end, before.end);
  return basis === 'ttm' ? interval >= 60 && interval <= 120 : basis === 'annual' && interval >= 300 && interval <= 400;
}

function category(metric) {
  const id = metric.id;
  if (id === 'reported_dividendsPaid') return 'distributions';
  if (id === 'reported_capitalExpenditure' || id === 'cash_investment_cover') return 'investment';
  if (/equity|htm/.test(id) && !/liab/.test(id)) return 'capital';
  if (/npl|allowance|provision_rate|loss_ratio|receivables|clearing|financial_instruments|accruals/.test(id)) return 'asset-quality';
  if (/debt_share|reported_(currentDebt|totalDebt)|interest_coverage|repos|securities_borrowed/.test(id)) return 'refinancing';
  if (/reported_(netIncome|operatingIncome|operatingCashFlow)|net_margin|cash_after_capex|earnings|preprovision/.test(id)) return 'cash-generation';
  if (/liab_to_assets|reported_(equity|totalAssets|totalLiabilities)/.test(id)) return 'capital';
  return 'liquidity';
}

function rawMetric(key, profile) {
  const flow = key === 'capitalExpenditure' || key === 'dividendsPaid' || key === 'netIncome';
  const series = (flow ? profile.reportedFlows : profile.reportedBalances)?.[key] || [];
  const labels = { totalDebt: 'Selected reported debt', currentDebt: 'Debt classified as current', deposits: 'Reported deposits', netIncome: 'Net income', capitalExpenditure: 'Reported cash capital purchases', dividendsPaid: 'Cash dividends' };
  return { id: `reported_${key}`, label: key === 'cash' ? riskCashLabel(series.at(-1)) : labels[key] || key,
    format: 'usd', formula: flow ? 'Reported annual or TTM SEC flow' : 'Reported SEC balance', series,
    note: key === 'totalDebt' ? RISK_DEBT_SCOPE_NOTE : key === 'capitalExpenditure' ? RISK_CAPITAL_PURCHASE_NOTE : '' };
}

function selectedMetrics(profile, research) {
  const map = new Map(research.drivers.flatMap(driver => driver.metrics).filter(metric => metric.id !== 'loss_years').map(metric => [metric.id, metric]));
  const additions = research.lens.id === 'bank' ? ['cash', 'deposits', 'netIncome'] : research.lens.id === 'broker' ? [] : ['cash', 'currentDebt', 'totalDebt'];
  if (!FINANCIAL.has(research.lens.id)) additions.push('capitalExpenditure', 'dividendsPaid');
  for (const key of additions) if (!map.has(`reported_${key}`)) map.set(`reported_${key}`, rawMetric(key, profile));
  const inspectable = new Set((profile.metrics || []).map(metric => metric.id));
  return [...map.values()].slice(0, 20).map(metric => ({ ...metric, metricId: inspectable.has(metric.metricId) ? metric.metricId : null }));
}

function criterionFor(metric, before, after, assets) {
  const delta = after.value - before.value;
  const absolute = Math.abs(delta);
  const relative = before.value === 0 ? null : delta / Math.abs(before.value);
  if (metric.format === 'pct' || metric.format === 'pp') {
    const threshold = PP_MINIMUM[metric.id] ?? .02;
    return absolute + 1e-12 >= threshold ? { id: 'pp', label: `Absolute change ≥ ${(threshold * 100).toFixed(1)} percentage points`, threshold, observed: absolute } : null;
  }
  if (metric.format === 'usd') {
    const threshold = Math.max(1000000, finite(assets) && assets > 0 ? assets * .0005 : 0);
    const crossZero = before.value === 0 || (before.value < 0 && after.value >= 0) || (before.value > 0 && after.value <= 0);
    return absolute >= threshold && (crossZero || Math.abs(relative) >= .15) ? { id: 'usd', label: `Absolute change ≥ $${Math.round(threshold).toLocaleString('en-US')} and ≥15% of |prior|, or a move from/through zero`, threshold, observed: absolute, relativeThreshold: .15, assetScale: finite(assets) ? assets : null } : null;
  }
  const threshold = metric.format === 'count' ? 3 : metric.id === 'interest_coverage' ? 1 : /allowance|preprovision/.test(metric.id) ? .5 : .25;
  return absolute >= threshold && (before.value === 0 || Math.abs(relative) >= .15) ? { id: metric.format === 'count' ? 'months' : 'multiple', label: `Absolute change ≥ ${threshold}${metric.format === 'count' ? ' months' : '×'} and ≥15% of |prior|, or a move from zero`, threshold, observed: absolute, relativeThreshold: .15 } : null;
}

function evidence(metric, point, validation) {
  const filed = [...new Set(point.sources.map(source => source.filed).filter(Boolean))];
  const forms = [...new Set(point.sources.map(source => source.form).filter(Boolean))];
  return { end: point.end, date: point.end, start: validation.start, value: point.value, formula: point.formula || metric.formula,
    ...(filed.length === 1 && point.sources.every(source => source.filed) ? { filed: filed[0] } : {}),
    ...(forms.length === 1 && point.sources.every(source => source.form) ? { form: forms[0] } : {}),
    sources: point.sources.map(source => ({ ...source })),
    sourceUrls: [...new Set(point.sources.flatMap(source => [source.documentUrl, source.url].filter(Boolean)))] };
}

function maturityEvidence(schedule) {
  const bucket = schedule.buckets[0];
  const scope = `Reported ${schedule.basis === 'fiscal' ? 'next-fiscal-year' : 'next-rolling-twelve-month'} principal; forward window ${bucket.startDate} to ${bucket.endDate}; ${bucket.dateBasis}.`;
  const input = { taxonomy: 'us-gaap', tag: bucket.tag, label: bucket.label, value: bucket.value, unit: 'USD',
    end: schedule.asOf, filed: schedule.filedAt, accession: schedule.accession, form: schedule.form, sourceCik: schedule.cik,
    documentUrl: schedule.sourceUrl, sourceType: 'sec-maturity-schedule', scopeNote: scope,
    futureWindowStart: bucket.startDate, futureWindowEnd: bucket.endDate, dateBasis: bucket.dateBasis };
  return { end: schedule.asOf, date: schedule.asOf, start: bucket.startDate, windowEnd: bucket.endDate,
    filed: schedule.filedAt, form: schedule.form, value: bucket.value, formula: `Reported USD principal in the ${schedule.basis === 'fiscal' ? 'next-fiscal-year' : 'next-rolling-twelve-month'} maturity bucket`,
    sources: [input], sourceUrls: [schedule.sourceUrl] };
}

function maturityComparison(before, after, expectedCik, cutoff, invalidCutoff, assets) {
  if (!expectedCik || !before || !after) return { reason: 'entity' };
  const issuer = expectedCik.padStart(10, '0');
  if (![before, after].every(schedule => isRefinancingProfile(schedule, issuer) && schedule.status === 'ready'
    && ['10-K', '20-F', '40-F'].includes(schedule.form) && day(schedule.asOf) != null && day(schedule.filedAt) != null)) return { reason: 'evidence' };
  if (!adjacent({ end: before.asOf }, { end: after.asOf }, 'annual') || before.accession === after.accession) return { reason: 'dates' };
  if (before.basis !== after.basis || before.buckets[0].tag !== after.buckets[0].tag || before.buckets[0].dateBasis !== after.buckets[0].dateBasis) return { reason: 'scope' };
  const expectedTag = `LongTermDebtMaturitiesRepaymentsOfPrincipal${after.basis === 'fiscal' ? 'InNextTwelveMonths' : 'InNextRollingTwelveMonths'}`;
  for (const schedule of [before, after]) {
    const bucket = schedule.buckets[0];
    if (!finite(bucket.value)) return { reason: 'missing' };
    if (bucket.tag !== expectedTag || day(bucket.startDate) == null || day(bucket.endDate) == null
      || days(bucket.startDate, schedule.asOf) !== 1 || days(bucket.endDate, bucket.startDate) < 299 || days(bucket.endDate, bucket.startDate) > 399) return { reason: 'duration' };
    if (invalidCutoff || cutoff && (schedule.asOf > cutoff || schedule.filedAt > cutoff)) return { reason: 'cutoff' };
    if (sourceIdentity(maturityEvidence(schedule).sources[0]) !== expectedCik) return { reason: 'entity' };
  }
  if (Math.abs(days(after.buckets[0].startDate, before.buckets[0].startDate) - days(after.asOf, before.asOf)) > 15
    || Math.abs(days(after.buckets[0].endDate, before.buckets[0].endDate) - days(after.asOf, before.asOf)) > 15) return { reason: 'duration' };
  const beforeEvidence = maturityEvidence(before), afterEvidence = maturityEvidence(after);
  const criterion = criterionFor({ id: 'scheduled_next12m', format: 'usd' }, beforeEvidence, afterEvidence, assets);
  if (!criterion) return { filtered: true };
  const delta = afterEvidence.value - beforeEvidence.value;
  const scope = 'The two buckets cover different forward windows; this does not compare the same loan cohort or establish a cause, refinancing outcome or market access. The reported principal schedule excludes short-term borrowings and leases. Anniversary dates are indicative where the filing uses a noncalendar fiscal year.';
  return { event: { id: `scheduled_next12m:${before.asOf}:${after.asOf}`, kind: 'metric', date: after.asOf, dateBasis: 'period-end',
    category: 'refinancing', categoryLabel: CATEGORY_LABELS.refinancing, title: `Reported next-year principal ${delta > 0 ? 'increased' : 'decreased'}`,
    label: after.basis === 'fiscal' ? 'Next fiscal-year principal' : 'Next rolling 12-month principal', direction: delta > 0 ? 'increase' : 'decrease',
    format: 'usd', deltaFormat: 'usd', delta, relativeChange: beforeEvidence.value === 0 ? null : delta / Math.abs(beforeEvidence.value),
    metricId: null, note: scope, scope, criterion, before: beforeEvidence, after: afterEvidence } };
}

/** Build at most 20 financial events across six loaded reporting observations. */
export function buildRiskChangeTimeline(profile = {}, company = {}, { asOf = '' } = {}) {
  const research = buildRiskResearchModel(profile, company);
  const cutoff = day(asOf) != null ? asOf : '';
  const invalidCutoff = !!asOf && !cutoff;
  const metrics = selectedMetrics(profile, research);
  const seen = new Set();
  const periods = [...(profile.periods || [])].filter(period => day(period.end) != null && !seen.has(period.end) && seen.add(period.end)).sort((a, b) => a.end.localeCompare(b.end)).slice(-6);
  const reasonCounts = new Map();
  const countReason = reason => reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  let comparablePairs = 0;
  let comparisons = 0;
  let filteredPairs = 0;
  const events = [];
  const timeline = periods.map((period, index) => ({ id: period.end, date: period.end,
    label: period.kind === 'annual' || period.fp === 'FY' ? `FY ${period.fy || period.end.slice(0, 4)}` : `${period.fp || 'Period'} ${period.fy || period.end.slice(0, 4)}`,
    priorDate: periods[index - 1]?.end || null, eventIds: [], eventCount: 0, comparisonAvailable: false }));
  const expectedCik = cik(company.cik);
  // Original annual schedules form their own adjacent annual sequence even
  // when the selected financial profile consists of overlapping TTM windows.
  const history = [...(Array.isArray(company.refinancingHistory) ? company.refinancingHistory : [])].sort((a, b) => String(a?.asOf).localeCompare(String(b?.asOf))).slice(-3);
  for (let index = periods.length - 1; index >= 1; index--) {
    const currentPeriod = periods[index], priorPeriod = periods[index - 1];
    const candidates = [];
    const assetsPoint = profile.reportedBalances?.totalAssets?.find(row => row.end === currentPeriod.end);
    const assetValidation = assetsPoint && validateObservation({ id: 'reported_totalAssets' }, assetsPoint, currentPeriod, profile, expectedCik, cutoff);
    const assets = assetValidation && !assetValidation.reason ? assetsPoint.value : null;
    const scheduleIndex = history.findIndex(schedule => schedule?.asOf === currentPeriod.end);
    if (scheduleIndex > 0) {
      comparisons++;
      const result = history.filter(schedule => schedule?.asOf === currentPeriod.end).length > 1
        ? { reason: 'dates' } : maturityComparison(history[scheduleIndex - 1], history[scheduleIndex], expectedCik, cutoff, invalidCutoff, assets);
      if (result.reason) countReason(result.reason);
      else {
        comparablePairs++;
        timeline[index].comparisonAvailable = true;
        if (result.event) candidates.push(result.event);
        else filteredPairs++;
      }
    }
    for (const metric of metrics) {
      comparisons++;
      const rows = metric.series || [];
      const currentRows = rows.filter(point => point.end === currentPeriod.end);
      const priorRows = rows.filter(point => point.end === priorPeriod.end);
      const after = currentRows[0], before = priorRows[0];
      if (currentRows.length > 1 || priorRows.length > 1 || !adjacent(priorPeriod, currentPeriod, profile.basis) || (currentPeriod.kind && currentPeriod.kind !== profile.basis) || (priorPeriod.kind && priorPeriod.kind !== profile.basis)) { countReason('dates'); continue; }
      const afterValidation = validateObservation(metric, after, currentPeriod, profile, expectedCik, cutoff);
      const beforeValidation = validateObservation(metric, before, priorPeriod, profile, expectedCik, cutoff);
      const reason = invalidCutoff ? 'cutoff' : afterValidation.reason || beforeValidation.reason;
      if (reason) { countReason(reason); continue; }
      if (afterValidation.identity !== beforeValidation.identity) { countReason('entity'); continue; }
      if (riskComparisonIssue(after, before) || scopeSignature(after) !== scopeSignature(before)) { countReason('scope'); continue; }
      if (afterValidation.start || beforeValidation.start) {
        const interval = days(after.end, before.end);
        if (!afterValidation.start || !beforeValidation.start || Math.abs(days(after.end, afterValidation.start) - days(before.end, beforeValidation.start)) > 15 || Math.abs(days(afterValidation.start, beforeValidation.start) - interval) > 15) { countReason('duration'); continue; }
      }
      comparablePairs++;
      timeline[index].comparisonAvailable = true;
      const criterion = criterionFor(metric, before, after, assets);
      if (!criterion) { filteredPairs++; continue; }
      const delta = after.value - before.value;
      const eventCategory = category(metric);
      const scope = [metric.note, eventCategory === 'refinancing' ? 'Current debt is a balance-sheet classification; these amounts do not establish contractual maturities, refinancing dates or market access.' : '', eventCategory === 'distributions' ? 'Cash distributions are capital allocation; a change alone is not a deterioration or improvement in credit quality.' : '', profile.basis === 'ttm' && afterValidation.start ? 'Adjacent trailing twelve-month windows overlap; they are not independent annual cash flows.' : ''].filter(Boolean).join(' ');
      candidates.push({ id: `${metric.id}:${before.end}:${after.end}`, kind: 'metric', date: after.end, dateBasis: 'period-end', category: eventCategory, categoryLabel: CATEGORY_LABELS[eventCategory],
        title: `${metric.label} ${delta > 0 ? 'increased' : 'decreased'}`, label: metric.label, direction: delta > 0 ? 'increase' : 'decrease',
        format: metric.format, deltaFormat: ['pct', 'pp'].includes(metric.format) ? 'pp' : metric.format, delta,
        relativeChange: before.value === 0 ? null : delta / Math.abs(before.value), metricId: metric.metricId,
        note: scope, scope, criterion, before: evidence(metric, before, beforeValidation), after: evidence(metric, after, afterValidation) });
    }
    // First show distinct business questions, then fill remaining slots in
    // framework order. Dollar, percentage and multiple changes are not ranked.
    const chosen = [], categories = new Set();
    for (const event of candidates) if (!categories.has(event.category) && chosen.length < 4) { chosen.push(event); categories.add(event.category); }
    for (const event of candidates) if (chosen.length < 4 && !chosen.includes(event)) chosen.push(event);
    for (const event of chosen) if (events.length < 20) { events.push(event); timeline[index].eventIds.push(event.id); }
    timeline[index].eventCount = timeline[index].eventIds.length;
  }
  const excludedPairs = [...reasonCounts.values()].reduce((sum, count) => sum + count, 0);
  return { basis: profile.basis || '', lens: research.lens, asOf: cutoff || null, periods: timeline, categories: CATEGORIES.map(item => ({ ...item })), events,
    coverage: { comparisons, comparablePairs, excludedPairs, cutoffExcludedPairs: reasonCounts.get('cutoff') || 0, filteredPairs, eventCount: events.length },
    gaps: [...reasonCounts].map(([id, count]) => ({ id, label: REASONS[id], count })), criteria: CRITERIA.map(item => ({ ...item })),
    limitations: [
      'Financial events describe supported changes, not their causes, a credit rating or a default forecast. Reporting dates position events; each source retains its own filing date.',
      'Only adjacent loaded observations with matching issuer, source concepts, units, balance dates and compatible full-year flow intervals are compared. Missing evidence is never replaced with zero or bridged.',
      'Relative change uses the absolute prior value; it is unavailable when the prior value is zero. Negative baselines do not imply ordinary growth rates.',
      'At most six reporting periods and four events per period are displayed. Selection follows business-question order across different units; absence of an event does not establish stability.',
      ...(history.length ? ['Maturity events compare adjacent verified original annual next-year buckets on the same fiscal or rolling basis. The forward windows differ; no change in the same debt cohort is inferred.'] : []),
      profile.basis === 'ttm' ? 'TTM windows overlap. Adjacent reporting-end changes are not independent annual observations.' : 'Annual comparisons require adjacent fiscal-year observations. Reporting periods can use later amended or comparative filings.',
      ...(FINANCIAL.has(research.lens.id) ? ['Financial institutions use industry-specific asset, funding and book-capital measures; industrial operating-cash-flow/debt screens are excluded. Consolidated book capital is not regulatory legal-entity capital.'] : []),
      ...(asOf ? ['The cutoff admits only observations whose complete loaded source evidence was filed by that date. Later comparative facts are excluded; the model does not reconstruct earlier vintages or fetch replacements.'] : []),
    ] };
}
