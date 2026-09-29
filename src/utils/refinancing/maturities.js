import { validFinancialPeriodDates } from '../financialPeriodDates.js';

export const REFINANCING_VERSION = 'refinancing-v1';

// FASB 2026 documentation: legacy "NextTwelveMonths" is the next FISCAL year.
// Rolling concepts are a distinct family. Never add the two families together.
// https://xbrl.fasb.org/us-gaap/2026/elts/us-gaap-doc-2026.xml
export const MATURITY_BUCKETS = Object.freeze([
  { key: 'next12m', label: 'Next fiscal year', year: 1, suffix: 'InNextTwelveMonths', rollingSuffix: 'InNextRollingTwelveMonths' },
  { key: 'year2', label: 'Fiscal year +2', year: 2, suffix: 'InYearTwo', rollingSuffix: 'InRollingYearTwo' },
  { key: 'year3', label: 'Fiscal year +3', year: 3, suffix: 'InYearThree', rollingSuffix: 'InRollingYearThree' },
  { key: 'year4', label: 'Fiscal year +4', year: 4, suffix: 'InYearFour', rollingSuffix: 'InRollingYearFour' },
  { key: 'year5', label: 'Fiscal year +5', year: 5, suffix: 'InYearFive', rollingSuffix: 'InRollingYearFive' },
  { key: 'after5', label: 'Thereafter', year: null, suffix: 'AfterYearFive', rollingSuffix: 'InRollingAfterYearFive' },
]);
const PREFIX = 'LongTermDebtMaturitiesRepaymentsOfPrincipal';
const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);
const DAY = 86400000;
const ACCN = /^\d{10}-\d{2}-\d{6}$/;
const CIK = /^\d{1,10}$/;
const annualDuration = row => {
  if (!row.start || !validFinancialPeriodDates(row)) return false;
  const days = (Date.parse(row.end) - Date.parse(row.start)) / DAY + 1;
  return days >= 350 && days <= 380;
};

function normalizeCik(value) {
  const text = String(value ?? '').replace(/^CIK/i, '');
  return CIK.test(text) && Number(text) > 0 ? text.padStart(10, '0') : null;
}

function segmented(row) {
  // The SEC companyfacts API itself excludes dimensional facts. Reject them
  // explicitly as well so future alternate inputs cannot double-count debt.
  return row.hasSegments === true || ['segment', 'segments', 'dimensions', 'members'].some(key => {
    const value = row[key];
    return value != null && (typeof value !== 'object' || Object.keys(value).length > 0);
  });
}

function validRow(row, cutoff) {
  return row && typeof row.val === 'number' && Number.isFinite(row.val)
    && Math.abs(row.val) <= Number.MAX_SAFE_INTEGER
    && ANNUAL_FORMS.has(row.form) && ACCN.test(row.accn || '')
    && validFinancialPeriodDates(row) && typeof row.filed === 'string'
    && row.filed <= cutoff && !segmented(row);
}

const dollarRows = (taxonomy, tag) => Array.isArray(taxonomy[tag]?.units?.USD) ? taxonomy[tag].units.USD : [];

function sourceFor(row, tag, cik) {
  return {
    taxonomy: 'us-gaap', tag, unit: 'USD', value: row.val,
    start: row.start || null, end: row.end, filed: row.filed,
    accession: row.accn, form: row.form,
    documentUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${row.accn.replaceAll('-', '')}/${row.accn}-index.html`,
  };
}

function resolveRows(rows) {
  if (!rows.length) return { row: null, reason: 'not_reported' };
  // Repeated identical observations are harmless; conflicting values within the
  // same filing/context are ambiguous, not additional principal to add up.
  if (new Set(rows.map(row => row.val)).size !== 1) return { row: null, reason: 'conflicting_facts' };
  if (rows[0].val < 0) return { row: null, reason: 'negative_principal' };
  return { row: rows[0], reason: null };
}

function shiftYear(date, years) {
  const parsed = new Date(`${date}T00:00:00Z`);
  const month = parsed.getUTCMonth();
  parsed.setUTCFullYear(parsed.getUTCFullYear() + years);
  if (parsed.getUTCMonth() !== month) parsed.setUTCDate(0);
  return parsed.toISOString().slice(0, 10);
}
const nextDay = date => new Date(Date.parse(date) + DAY).toISOString().slice(0, 10);

function bucketDates(asOf, year) {
  const calendar = asOf.endsWith('-12-31');
  return {
    startDate: nextDay(shiftYear(asOf, year ? year - 1 : 5)),
    endDate: year ? shiftYear(asOf, year) : null,
    calendarYear: calendar && year ? Number(asOf.slice(0, 4)) + year : null,
    dateBasis: calendar ? 'calendar-year' : 'anniversary-estimate',
  };
}

const missingMetric = (reason = 'not_reported_in_schedule_filing') => ({
  value: null, tag: null, startDate: null, endDate: null, source: null, reason,
});

function financialMetrics(taxonomy, schedule, cik, cutoff, financialInstitution) {
  const matching = (tag, duration) => dollarRows(taxonomy, tag).filter(row =>
    validRow(row, cutoff) && row.accn === schedule.accn && row.end === schedule.end
    && row.filed === schedule.filed && row.form === schedule.form
    && (duration ? annualDuration(row) : !row.start));
  const choose = (tags, duration, nonnegative = false) => {
    for (const tag of tags) {
      const rows = matching(tag, duration);
      if (!rows.length) continue;
      const unique = new Set(rows.map(row => `${row.start || ''}:${row.val}`));
      if (unique.size !== 1) return missingMetric('conflicting_facts');
      const row = rows[0];
      if (nonnegative && row.val < 0) return missingMetric('negative_balance');
      return { value: row.val, tag, startDate: row.start || null, endDate: row.end,
        source: sourceFor(row, tag, cik), reason: null };
    }
    return missingMetric();
  };
  const cash = choose(['CashAndCashEquivalentsAtCarryingValue'], false, true);
  const operatingCashFlow = choose(['NetCashProvidedByUsedInOperatingActivities'], true);
  const operatingIncome = choose(['OperatingIncomeLoss'], true);
  // Net interest, interest income and capitalized interest are not expenses.
  // InterestAndDebtExpense is deliberately omitted because its scope can include
  // debt costs beyond interest. Missing gross expense remains unavailable.
  const interestExpense = choose(['InterestExpense', 'InterestExpenseNonoperating'], true);
  let interestCoverage = missingMetric('compatible_annual_operating_income_and_interest_required');
  if (financialInstitution) interestCoverage = missingMetric('not_comparable_for_financial_institutions');
  else if (operatingIncome.value != null && interestExpense.value > 0
    && operatingIncome.startDate === interestExpense.startDate) {
    interestCoverage = {
      value: operatingIncome.value / interestExpense.value, tag: null,
      startDate: operatingIncome.startDate, endDate: schedule.end, source: null,
      sources: [operatingIncome.source, interestExpense.source], reason: null,
      formula: 'Reported operating income / positive reported interest expense',
    };
  }
  return { cash, operatingCashFlow, operatingIncome, interestExpense, interestCoverage };
}

/** Pure extraction: no network/database/cache work. Companyfacts contains only
 * standard-taxonomy, entity-wide facts (SEC API documentation). Custom-tag and
 * debt-instrument schedules are intentionally unavailable rather than guessed.
 * Annual-only selection prevents mixing a fiscal-year remainder and rolling
 * twelve-month maturities. USD is the only supported aggregation currency.
 */
export function extractRefinancingProfile(companyfacts, options = {}) {
  const cutoff = options.asOf || new Date().toISOString().slice(0, 10);
  if (!validFinancialPeriodDates({ end: cutoff })) throw new Error('Invalid refinancing cutoff date.');
  const maxAgeDays = options.maxAgeDays ?? 550;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 730) throw new Error('Invalid maturity schedule age bound.');
  const sourceCik = normalizeCik(companyfacts?.cik);
  const cik = normalizeCik(options.cik) || sourceCik;
  const base = {
    schemaVersion: REFINANCING_VERSION, cik, ticker: String(options.ticker || '').slice(0, 20),
    name: String(options.name || companyfacts?.entityName || '').slice(0, 300),
    sector: String(options.sector || 'Unclassified').slice(0, 100), currency: 'USD',
    status: 'unavailable', reason: 'no_supported_annual_schedule', asOf: null, filedAt: null, accession: null, form: null,
    sourceUrl: null, basis: null, buckets: [], totalScheduled: null, reportedSubtotal: null,
    coverage: { reportedBuckets: 0, totalBuckets: 6, complete: false, reason: 'no_supported_annual_schedule' },
    metrics: Object.fromEntries(['cash', 'operatingCashFlow', 'operatingIncome', 'interestExpense', 'interestCoverage', 'cashToNext12m']
      .map(key => [key, missingMetric('no_supported_annual_schedule')])), warnings: [],
  };
  if (!cik || (sourceCik && sourceCik !== cik)) {
    base.coverage.reason = 'invalid_or_mismatched_cik';
    base.reason = base.coverage.reason;
    return base;
  }
  const taxonomy = companyfacts?.facts?.['us-gaap'] || {};
  const groups = new Map();
  for (const basis of ['fiscal', 'rolling']) {
    for (const bucket of MATURITY_BUCKETS) {
      const tag = PREFIX + (basis === 'fiscal' ? bucket.suffix : bucket.rollingSuffix);
      for (const row of dollarRows(taxonomy, tag)) {
        if (!validRow(row, cutoff) || row.start) continue;
        const key = `${row.end}|${row.accn}|${basis}`;
        let group = groups.get(key);
        if (!group) {
          group = { end: row.end, accn: row.accn, filed: row.filed, form: row.form, basis, rows: new Map() };
          groups.set(key, group);
        }
        if (row.filed !== group.filed || row.form !== group.form) { group.invalid = true; continue; }
        if (!group.rows.has(bucket.key)) group.rows.set(bucket.key, []);
        group.rows.get(bucket.key).push(row);
      }
    }
  }
  const candidates = [...groups.values()].filter(group => !group.invalid)
    .sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed)
      || b.accn.localeCompare(a.accn) || b.rows.size - a.rows.size || a.basis.localeCompare(b.basis));
  const schedule = candidates[0];
  if (!schedule) return base;
  if ((Date.parse(cutoff) - Date.parse(schedule.end)) / DAY > maxAgeDays) {
    base.coverage.reason = 'schedule_too_old';
    base.reason = base.coverage.reason;
    base.warnings.push(`Latest supported annual schedule is dated ${schedule.end}; it is outside the ${maxAgeDays}-day coverage window.`);
    return base;
  }
  const buckets = MATURITY_BUCKETS.map(bucket => {
    const tag = PREFIX + (schedule.basis === 'fiscal' ? bucket.suffix : bucket.rollingSuffix);
    const { row, reason } = resolveRows(schedule.rows.get(bucket.key) || []);
    const dates = bucketDates(schedule.end, bucket.year);
    const label = schedule.basis === 'fiscal' ? bucket.label
      : bucket.key === 'next12m' ? 'Next 12 months' : bucket.year ? `Rolling year ${bucket.year}` : 'Thereafter';
    return { key: bucket.key, label, value: row?.val ?? null, ...dates,
      tag, source: row ? sourceFor(row, tag, cik) : null, reason };
  });
  const reportedBuckets = buckets.filter(bucket => bucket.value != null).length;
  const reportedSubtotal = reportedBuckets ? buckets.reduce((sum, bucket) => sum + (bucket.value ?? 0), 0) : null;
  const complete = reportedBuckets === MATURITY_BUCKETS.length;
  const sic = Number(options.sic);
  const financialInstitution = options.financialInstitution === true || (sic >= 6000 && sic <= 6399) || options.sector === 'Financials';
  const metrics = financialMetrics(taxonomy, schedule, cik, cutoff, financialInstitution);
  const next = buckets[0];
  metrics.cashToNext12m = metrics.cash.value != null && next.value > 0
    ? { value: metrics.cash.value / next.value, tag: null, startDate: null, endDate: schedule.end, source: null,
      sources: [metrics.cash.source, next.source], reason: null,
      formula: 'Cash and cash equivalents / reported next-year principal maturities' }
    : missingMetric('positive_next_year_maturities_and_cash_required');
  const warnings = [];
  if (!complete) warnings.push('Only reported maturity buckets are shown. Missing amounts are unknown, not zero.');
  if (buckets.some(bucket => bucket.reason === 'conflicting_facts')) warnings.push('Conflicting facts in this filing were excluded.');
  if (!schedule.end.endsWith('-12-31')) warnings.push('Fiscal-year periods do not align with calendar years. Anniversary dates are indicative; 52/53-week calendars and fiscal-year changes can shift year ends.');
  warnings.push('Maturities describe principal scheduled at the filing date, not a forecast of refinancing needs. Cash and cash flow have other uses; short-term borrowings and leases are outside this schedule.');
  return { ...base, status: reportedBuckets ? 'ready' : 'unavailable', reason: complete ? null : 'partial_schedule', asOf: schedule.end, filedAt: schedule.filed,
    accession: schedule.accn, form: schedule.form, sourceUrl: sourceFor({ ...schedule, val: null }, '', cik).documentUrl,
    basis: schedule.basis, buckets, reportedSubtotal, totalScheduled: complete ? reportedSubtotal : null,
    coverage: { reportedBuckets, totalBuckets: 6, complete, reason: complete ? null : 'partial_schedule' }, metrics, warnings };
}
