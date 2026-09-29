import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRefinancingProfile, MATURITY_BUCKETS, REFINANCING_VERSION } from '../src/utils/refinancing/maturities.js';

const PREFIX = 'LongTermDebtMaturitiesRepaymentsOfPrincipal';
const ACCN = '0000000001-26-000001';
const options = { ticker: 'TEST', sector: 'Industrials', asOf: '2026-09-29' };
const row = (val, overrides = {}) => ({ val, end: '2025-12-31', filed: '2026-02-01', accn: ACCN, form: '10-K', fp: 'FY', fy: 2025, ...overrides });
function fixture({ values = [100, 200, 300, 400, 500, 600], overrides = {}, rolling = false } = {}) {
  const facts = { 'us-gaap': {} };
  MATURITY_BUCKETS.forEach((bucket, i) => {
    if (values[i] != null) facts['us-gaap'][PREFIX + (rolling ? bucket.rollingSuffix : bucket.suffix)] = { units: { USD: [row(values[i], overrides)] } };
  });
  return { cik: 1, entityName: 'Test issuer', facts };
}
function add(data, tag, val, overrides = {}, unit = 'USD') {
  const concept = data.facts['us-gaap'][tag] ||= { units: {} };
  (concept.units[unit] ||= []).push(row(val, overrides));
  return data;
}
function financials(data) {
  add(data, 'CashAndCashEquivalentsAtCarryingValue', 350);
  add(data, 'NetCashProvidedByUsedInOperatingActivities', 500, { start: '2025-01-01' });
  add(data, 'OperatingIncomeLoss', 90, { start: '2025-01-01' });
  add(data, 'InterestExpense', 30, { start: '2025-01-01' });
  return data;
}
const extract = data => extractRefinancingProfile(data, options);

test('a coherent principal schedule produces sourced calendar years and independently specified coverage ratios', () => {
  const profile = extract(financials(fixture()));
  assert.equal(profile.schemaVersion, REFINANCING_VERSION);
  assert.equal(profile.status, 'ready');
  assert.equal(profile.cik, '0000000001');
  assert.equal(profile.name, 'Test issuer');
  assert.equal(profile.asOf, '2025-12-31');
  assert.equal(profile.totalScheduled, 2100);
  assert.equal(profile.reportedSubtotal, 2100);
  assert.equal(profile.coverage.complete, true);
  assert.deepEqual(profile.buckets.map(b => b.calendarYear), [2026, 2027, 2028, 2029, 2030, null]);
  assert.equal(profile.buckets[0].startDate, '2026-01-01');
  assert.equal(profile.buckets[0].endDate, '2026-12-31');
  assert.equal(profile.buckets[5].startDate, '2031-01-01');
  assert.equal(profile.buckets[5].endDate, null);
  assert.equal(profile.metrics.cashToNext12m.value, 3.5);
  assert.equal(profile.metrics.interestCoverage.value, 3);
  assert.equal(profile.metrics.operatingCashFlow.value, 500);
  assert.equal(profile.metrics.operatingCashFlow.startDate, '2025-01-01');
  assert.match(profile.sourceUrl, /\/1\/000000000126000001\/0000000001-26-000001-index\.html$/);
  assert.ok(profile.buckets.every(b => b.source.accession === ACCN && b.source.unit === 'USD'));
});

test('noncalendar fiscal years retain fiscal labels and explicitly estimated anniversary dates', () => {
  const profile = extract(fixture({ overrides: { end: '2025-09-27' } }));
  assert.equal(profile.buckets[0].label, 'Next fiscal year');
  assert.equal(profile.buckets[0].calendarYear, null);
  assert.equal(profile.buckets[0].dateBasis, 'anniversary-estimate');
  assert.ok(profile.warnings.some(w => w.includes('52/53-week')));
  assert.equal(profile.buckets[1].startDate, '2026-09-28');
});

test('missing periods remain unknown and a partial schedule cannot claim a total', () => {
  const profile = extract(fixture({ values: [100, null, 0, null, 500, 600] }));
  assert.equal(profile.status, 'ready');
  assert.equal(profile.reportedSubtotal, 1200);
  assert.equal(profile.totalScheduled, null);
  assert.equal(profile.coverage.reportedBuckets, 4);
  assert.equal(profile.buckets[1].value, null);
  assert.equal(profile.buckets[2].value, 0);
});

test('latest filing wins without backfilling missing buckets from another accession', () => {
  const data = fixture();
  add(data, PREFIX + 'InNextTwelveMonths', 80, { accn: '0000000001-26-000002', form: '10-K/A', filed: '2026-03-01' });
  const profile = extract(data);
  assert.equal(profile.accession, '0000000001-26-000002');
  assert.equal(profile.buckets[0].value, 80);
  assert.equal(profile.buckets[1].value, null);
  assert.equal(profile.coverage.reportedBuckets, 1);
});

test('newest balance-sheet date takes priority over a later filing of an old comparative schedule', () => {
  const data = fixture();
  for (const bucket of MATURITY_BUCKETS) add(data, PREFIX + bucket.suffix, 9000, { end: '2024-12-31', filed: '2026-03-01', accn: '0000000001-26-000002' });
  assert.equal(extract(data).totalScheduled, 2100);
});

test('duplicates are not added and conflicting observations are withheld', () => {
  const data = fixture();
  add(data, PREFIX + 'InNextTwelveMonths', 100);
  assert.equal(extract(data).totalScheduled, 2100);
  add(data, PREFIX + 'InYearTwo', 250);
  const profile = extract(data);
  assert.equal(profile.buckets[1].value, null);
  assert.equal(profile.buckets[1].reason, 'conflicting_facts');
  assert.equal(profile.totalScheduled, null);
  assert.equal(profile.reportedSubtotal, 1900);
});

test('negative principal is not accepted while explicitly reported zero is preserved', () => {
  const profile = extract(fixture({ values: [0, -1, 300, 400, 500, 600] }));
  assert.equal(profile.buckets[0].value, 0);
  assert.equal(profile.buckets[1].reason, 'negative_principal');
  assert.equal(profile.metrics.cashToNext12m.value, null);
});

test('leases, current debt, instrument facts, currencies, and custom taxonomy tags are not substituted', () => {
  const data = fixture({ values: [] });
  add(data, 'LongTermDebtCurrent', 400);
  add(data, 'LongTermDebtAndCapitalLeaseObligationsMaturitiesRepaymentsOfPrincipalInNextTwelveMonths', 500);
  add(data, 'LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths', 600, {}, 'EUR');
  add(data, 'LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo', 700, { dimensions: { DebtInstrumentAxis: 'NoteA' } });
  data.facts.test = { [PREFIX + 'InYearThree']: { units: { USD: [row(800)] } } };
  assert.equal(extract(data).status, 'unavailable');
});

test('fiscal and rolling maturity families are selected separately and never summed', () => {
  const data = fixture({ rolling: true });
  const rolling = extract(data);
  assert.equal(rolling.basis, 'rolling');
  assert.equal(rolling.buckets[0].label, 'Next 12 months');
  assert.equal(rolling.totalScheduled, 2100);
  for (const bucket of MATURITY_BUCKETS) add(data, PREFIX + bucket.suffix, 1);
  const combined = extract(data);
  assert.equal(combined.totalScheduled, 6);
  assert.equal(combined.basis, 'fiscal');
});

test('quarterly schedules and duration-tagged maturities are withheld', () => {
  assert.equal(extract(fixture({ overrides: { form: '10-Q', fp: 'Q4' } })).status, 'unavailable');
  assert.equal(extract(fixture({ overrides: { start: '2025-01-01' } })).status, 'unavailable');
});

test('as-of cutoffs exclude future filings and stale schedules cannot masquerade as current', () => {
  assert.equal(extractRefinancingProfile(fixture(), { ...options, asOf: '2026-01-31' }).status, 'unavailable');
  assert.equal(extract(fixture({ overrides: { end: '2023-12-31', filed: '2024-02-01' } })).coverage.reason, 'schedule_too_old');
  assert.equal(extract(fixture({ overrides: { end: '2026-12-31' } })).status, 'unavailable');
});

test('cash and annual financial metrics must belong to the selected schedule filing and period', () => {
  const data = fixture();
  add(data, 'CashAndCashEquivalentsAtCarryingValue', 100, { end: '2026-06-30', filed: '2026-07-30', accn: '0000000001-26-000010', form: '10-Q' });
  add(data, 'NetCashProvidedByUsedInOperatingActivities', 200, { start: '2025-10-01' });
  add(data, 'OperatingIncomeLoss', 90, { start: '2025-01-01' });
  add(data, 'InterestExpense', 30, { start: '2025-01-01', accn: '0000000001-26-000002' });
  const profile = extract(data);
  assert.equal(profile.metrics.cash.value, null);
  assert.equal(profile.metrics.operatingCashFlow.value, null);
  assert.equal(profile.metrics.interestCoverage.value, null);
});

test('interest coverage needs identical annual durations and positive gross interest expense', () => {
  const data = financials(fixture());
  data.facts['us-gaap'].InterestExpense.units.USD[0].start = '2025-01-05';
  assert.equal(extract(data).metrics.interestCoverage.value, null);
  data.facts['us-gaap'].InterestExpense.units.USD[0].start = '2025-01-01';
  data.facts['us-gaap'].InterestExpense.units.USD[0].val = 0;
  assert.equal(extract(data).metrics.interestCoverage.value, null);
  data.facts['us-gaap'].InterestExpense.units.USD[0].val = 30;
  data.facts['us-gaap'].OperatingIncomeLoss.units.USD[0].val = -90;
  assert.equal(extract(data).metrics.interestCoverage.value, -3);
});

test('net interest, capitalized interest, restricted cash and debt costs are not interchangeable inputs', () => {
  const data = fixture();
  add(data, 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 1000);
  add(data, 'OperatingIncomeLoss', 100, { start: '2025-01-01' });
  for (const tag of ['InterestIncomeExpenseNet', 'InterestCostsCapitalized', 'InterestAndDebtExpense']) add(data, tag, 10, { start: '2025-01-01' });
  const profile = extract(data);
  assert.equal(profile.metrics.cash.value, null);
  assert.equal(profile.metrics.interestExpense.value, null);
  assert.equal(profile.metrics.interestCoverage.value, null);
});

test('financial institutions do not receive a misleading corporate interest coverage ratio', () => {
  const profile = extractRefinancingProfile(financials(fixture()), { ...options, sic: 6021 });
  assert.equal(profile.metrics.operatingIncome.value, 90);
  assert.equal(profile.metrics.interestCoverage.value, null);
  assert.equal(profile.metrics.interestCoverage.reason, 'not_comparable_for_financial_institutions');
});

test('identity, invalid-date, and malformed numeric safeguards fail closed', () => {
  assert.equal(extractRefinancingProfile(fixture(), { ...options, cik: '2' }).coverage.reason, 'invalid_or_mismatched_cik');
  assert.equal(extract({ ...fixture(), cik: null }).status, 'unavailable');
  assert.equal(extract(fixture({ overrides: { end: '2025-02-30' } })).status, 'unavailable');
  assert.equal(extract(fixture({ values: ['100', NaN, Infinity] })).status, 'unavailable');
  assert.throws(() => extractRefinancingProfile(fixture(), { asOf: '2026-02-30' }), /Invalid/);
  assert.throws(() => extractRefinancingProfile(fixture(), { maxAgeDays: 99999 }), /Invalid/);
});
