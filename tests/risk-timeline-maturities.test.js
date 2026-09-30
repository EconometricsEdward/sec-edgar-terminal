import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskMaturityHistory, hasRiskMaturityHistory, RISK_MATURITY_HISTORY_LIMIT } from '../src/utils/riskTimelineMaturities.js';
import { MATURITY_BUCKETS, extractRefinancingProfile } from '../src/utils/refinancing/maturities.js';
import { isRefinancingProfile } from '../src/utils/refinancing/projection.js';

const PREFIX = 'LongTermDebtMaturitiesRepaymentsOfPrincipal';
const OPTIONS = { cik: '0000000001', asOf: '2026-09-30' };
const filing = (year, index = 1, changes = {}) => ({
  accession: `0000000001-${String(year + 1).slice(-2)}-${String(index).padStart(6, '0')}`,
  form: '10-K', filingDate: `${year + 1}-02-15`, reportDate: `${year}-12-31`,
  primaryDoc: `issuer-${year}.htm`, ...changes,
});
const manifest = rows => ({ cik: 1, sic: 3571, filings: { recent: {
  accessionNumber: rows.map(row => row.accession), form: rows.map(row => row.form),
  filingDate: rows.map(row => row.filingDate), reportDate: rows.map(row => row.reportDate),
  primaryDocument: rows.map(row => row.primaryDoc),
} } });
function add(company, tag, row, unit = 'USD') {
  const concept = company.facts['us-gaap'][tag] ||= { units: {} };
  (concept.units[unit] ||= []).push(row);
}
function schedule(company, selected, values = [100, 200, 300, 400, 500, 600], rolling = false) {
  MATURITY_BUCKETS.forEach((bucket, index) => {
    if (values[index] == null) return;
    add(company, PREFIX + (rolling ? bucket.rollingSuffix : bucket.suffix), {
      val: values[index], accn: selected.accession, form: selected.form, filed: selected.filingDate,
      end: selected.reportDate, fy: Number(selected.reportDate.slice(0, 4)), fp: 'FY',
    });
  });
}
function fixture(rows = [filing(2024), filing(2025)]) {
  const company = { cik: 1, facts: { 'us-gaap': {} } };
  rows.forEach(row => schedule(company, row));
  return { company, submissions: manifest(rows), rows };
}
const build = ({ company, submissions }, options = OPTIONS) => buildRiskMaturityHistory(company, submissions, options);

test('verified original schedules retain the compact six-bucket schema and oldest-to-newest evidence', () => {
  const data = fixture();
  const snapshot = structuredClone(data);
  const history = build(data);
  assert.deepEqual(history.map(row => row.asOf), ['2024-12-31', '2025-12-31']);
  assert.deepEqual(history.map(row => row.accession), data.rows.map(row => row.accession));
  assert.ok(history.every(row => row.status === 'ready' && isRefinancingProfile(row, OPTIONS.cik)));
  assert.ok(history.every(row => row.buckets.length === 6 && row.currency === 'USD'));
  assert.ok(history.every(row => row.sourceUrl.endsWith(`${row.accession}-index.html`)));
  assert.ok(history.every(row => !Object.hasOwn(row.buckets[0], 'source')));
  assert.deepEqual(data, snapshot, 'Projection must not mutate the source facts or manifest');
});

test('each historical schedule is checked at its original filing date, rather than discarded as stale today', () => {
  const data = fixture([filing(2021), filing(2022), filing(2023)]);
  assert.equal(extractRefinancingProfile(data.company, OPTIONS).status, 'unavailable');
  assert.equal(build(data).length, 3);
  assert.equal(build(data)[0].asOf, '2021-12-31');
});

test('later comparative facts, amended schedules and unknown accessions cannot restate the original timeline', () => {
  const data = fixture();
  const original = data.rows[0], latest = data.rows[1];
  schedule(data.company, { ...latest, reportDate: original.reportDate }, [900, 900, 900, 900, 900, 900]);
  const amendment = filing(2024, 99, { form: '10-K/A', filingDate: '2026-03-01' });
  const unverified = filing(2024, 98, { filingDate: '2025-03-01' });
  schedule(data.company, amendment, [999, 999, 999, 999, 999, 999]);
  schedule(data.company, unverified, [888, 888, 888, 888, 888, 888]);
  data.submissions = manifest([...data.rows, amendment]);
  const history = build(data);
  assert.equal(history.length, 2);
  assert.equal(history[0].accession, original.accession);
  assert.equal(history[0].buckets[0].value, 100);
  assert.equal(history[0].totalScheduled, 2100);
});

test('duplicate reports of one year use the earliest original and duplicate manifest rows do not add snapshots', () => {
  const original = filing(2024), later = filing(2024, 2, { filingDate: '2025-03-01' });
  const data = fixture([later, original, original, filing(2025)]);
  schedule(data.company, later, [999, 999, 999, 999, 999, 999]);
  const history = build(data);
  assert.equal(history.length, 2);
  assert.equal(history[0].accession, original.accession);
  assert.equal(history[0].buckets[0].value, 100);
});

test('conflicting document or period bindings for an accession fail closed', () => {
  const original = filing(2024);
  for (const conflict of [{ primaryDoc: 'other.htm' }, { reportDate: '2024-09-30' }, { filingDate: '2025-03-01' }]) {
    const data = fixture([original]);
    data.submissions = manifest([original, { ...original, ...conflict }]);
    assert.deepEqual(build(data), []);
  }
});

test('no manifest authority is inferred from accession prefixes, and a verified filing-agent accession is accepted', () => {
  const data = fixture([filing(2025, 1, { accession: '0001193125-26-000001' })]);
  assert.equal(build(data)[0].accession, '0001193125-26-000001');
  data.submissions.cik = 2;
  assert.deepEqual(build(data), []);
});

test('issuer mismatch, malformed manifests and invalid options return no history', () => {
  const base = fixture();
  for (const changes of [
    data => { data.company.cik = 2; },
    data => { data.submissions.cik = 2; },
    data => { data.submissions.filings.recent.form.pop(); },
    data => { delete data.submissions.filings.recent.primaryDocument; },
    data => { data.submissions.filings.recent.primaryDocument = ['../other.htm', '../other.htm']; },
    data => { data.submissions.filings.recent.filingDate = ['2025-02-30', '2026-02-30']; },
  ]) {
    const data = structuredClone(base); changes(data); assert.deepEqual(build(data), []);
  }
  assert.deepEqual(build(base, { ...OPTIONS, cik: '2' }), []);
  assert.deepEqual(build(base, { ...OPTIONS, asOf: '2026-02-30' }), []);
  assert.deepEqual(build(base, { ...OPTIONS, maxAgeDays: 731 }), []);
});

test('filing cutoff is respected, and future, quarterly or amended forms never become historical schedules', () => {
  const data = fixture([filing(2025)]);
  assert.deepEqual(build(data, { ...OPTIONS, asOf: '2026-02-14' }), []);
  for (const form of ['10-Q', '10-K/A', '20-F/A', '40-F/A']) {
    assert.deepEqual(build(fixture([filing(2025, 1, { form })])), []);
  }
  for (const form of ['20-F', '40-F']) {
    assert.equal(build(fixture([filing(2025, 1, { form })]))[0].form, form);
  }
});

test('partial schedules stay partial and only explicitly reported zero becomes zero', () => {
  const row = filing(2025);
  const company = { cik: 1, facts: { 'us-gaap': {} } };
  schedule(company, row, [0, null, 30, null, -5, 60]);
  const [history] = build({ company, submissions: manifest([row]) });
  assert.equal(history.totalScheduled, null);
  assert.equal(history.reportedSubtotal, 90);
  assert.deepEqual(history.buckets.map(bucket => bucket.value), [0, null, 30, null, null, 60]);
  assert.equal(history.coverage.complete, false);
  assert.equal(history.buckets[4].reason, 'negative_principal');
});

test('cash and annual flow evidence are kept only from the same exact original report and compatible period', () => {
  const data = fixture(), prior = data.rows[0], latest = data.rows[1];
  const observation = (row, val, changes = {}) => ({ val, accn: row.accession, filed: row.filingDate,
    end: row.reportDate, form: row.form, ...changes });
  add(data.company, 'CashAndCashEquivalentsAtCarryingValue', observation(prior, 200));
  add(data.company, 'CashAndCashEquivalentsAtCarryingValue', observation(latest, 300));
  add(data.company, 'NetCashProvidedByUsedInOperatingActivities', observation(prior, 400, { start: '2024-01-01' }));
  add(data.company, 'NetCashProvidedByUsedInOperatingActivities', observation(latest, 500, { start: '2025-01-01' }));
  add(data.company, 'NetCashProvidedByUsedInOperatingActivities', observation(latest, 999, { start: '2024-01-01', end: prior.reportDate }));
  add(data.company, 'InterestExpense', observation(latest, 10, { start: '2025-01-01', filed: '2026-03-01' }));
  const history = build(data);
  assert.deepEqual(history.map(profile => profile.metrics.cash.value), [200, 300]);
  assert.deepEqual(history.map(profile => profile.metrics.operatingCashFlow.value), [400, 500]);
  assert.equal(history[1].metrics.interestExpense.value, null);
});

test('predecessor identity and mismatched document URLs cannot be attached to a registrant schedule', () => {
  const data = fixture([filing(2025)]);
  const first = data.company.facts['us-gaap'][PREFIX + MATURITY_BUCKETS[0].suffix].units.USD[0];
  first.sourceCik = '0000000002';
  const second = data.company.facts['us-gaap'][PREFIX + MATURITY_BUCKETS[1].suffix].units.USD[0];
  second.documentUrl = `https://www.sec.gov/Archives/edgar/data/2/${second.accn.replaceAll('-', '')}/issuer-2025.htm`;
  const history = build(data)[0];
  assert.equal(history.buckets[0].value, null);
  assert.equal(history.buckets[1].value, null);
  assert.equal(history.coverage.reportedBuckets, 4);
  assert.equal(history.totalScheduled, null);
});

test('different fiscal and rolling schedule families retain distinct bases and date windows', () => {
  const rows = [filing(2024, 1, { reportDate: '2024-09-28' }), filing(2025)];
  const company = { cik: 1, facts: { 'us-gaap': {} } };
  schedule(company, rows[0]);
  schedule(company, rows[1], [100, 200, 300, 400, 500, 600], true);
  const history = build({ company, submissions: manifest(rows) });
  assert.deepEqual(history.map(profile => profile.basis), ['fiscal', 'rolling']);
  assert.equal(history[0].buckets[0].dateBasis, 'anniversary-estimate');
  assert.equal(history[0].buckets[0].label, 'Next fiscal year');
  assert.equal(history[1].buckets[0].label, 'Next 12 months');
});

test('unsupported custom, dimensional or foreign-currency schedules remain unavailable', () => {
  for (const alter of [
    company => { company.facts.example = company.facts['us-gaap']; delete company.facts['us-gaap']; },
    company => { Object.values(company.facts['us-gaap']).forEach(concept => { concept.units.EUR = concept.units.USD; delete concept.units.USD; }); },
    company => { Object.values(company.facts['us-gaap']).forEach(concept => { concept.units.USD.forEach(row => { row.dimensions = { DebtInstrumentAxis: 'NoteA' }; }); }); },
  ]) {
    const data = fixture([filing(2025)]); alter(data.company); assert.deepEqual(build(data), []);
  }
  assert.deepEqual(build({ company: { cik: 1, facts: {} }, submissions: manifest([filing(2025)]) }), []);
});

test('only the newest three supported distinct years survive the bounded history projection', () => {
  const data = fixture([filing(2022), filing(2023), filing(2024), filing(2025)]);
  const history = build(data);
  assert.equal(RISK_MATURITY_HISTORY_LIMIT, 3);
  assert.equal(history.length, RISK_MATURITY_HISTORY_LIMIT);
  assert.deepEqual(history.map(profile => profile.asOf), ['2023-12-31', '2024-12-31', '2025-12-31']);
  assert.ok(JSON.stringify(history).length < 16_000, 'The retained projection stays compact');
});

test('cache reuse accepts supported and empty projections only for a verified issuer', () => {
  assert.equal(hasRiskMaturityHistory({ cik: OPTIONS.cik, refinancingHistory: build(fixture()) }), true);
  assert.equal(hasRiskMaturityHistory({ cik: OPTIONS.cik, refinancingHistory: [] }), true);
  assert.equal(hasRiskMaturityHistory({ cik: OPTIONS.cik }), false);
  assert.equal(hasRiskMaturityHistory({ refinancingHistory: [] }), false);
  assert.equal(hasRiskMaturityHistory({ cik: '0', refinancingHistory: [] }), false);
  assert.equal(hasRiskMaturityHistory({ cik: OPTIONS.cik, refinancingHistory: {} }), false);
  assert.equal(hasRiskMaturityHistory({ cik: '0000000002', refinancingHistory: build(fixture()) }), false);
});

test('cache reuse rejects oversized, duplicate, reversed or filing-inverted histories', () => {
  const good = build(fixture([filing(2023), filing(2024), filing(2025)]));
  const value = history => ({ cik: OPTIONS.cik, refinancingHistory: history });
  assert.equal(hasRiskMaturityHistory(value([...good, good[0]])), false);
  assert.equal(hasRiskMaturityHistory(value([good[0], good[0]])), false);
  assert.equal(hasRiskMaturityHistory(value([...good].reverse())), false);
  const late = build(fixture([filing(2024, 1, { filingDate: '2026-03-01' })]))[0];
  assert.equal(hasRiskMaturityHistory(value([late, good[2]])), false);
});

test('cache reuse rejects amended, malformed or unavailable schedules that otherwise resemble history', () => {
  const good = build(fixture())[0];
  for (const changes of [
    { form: '10-K/A' }, { form: '10-Q' }, { status: 'unavailable' }, { cik: '0000000002' },
    { sourceUrl: 'https://example.test/filing.htm' }, { asOf: '2024-02-30' },
    { coverage: { ...good.coverage, reportedBuckets: 7 } },
    { buckets: good.buckets.map((bucket, index) => index === 0 ? { ...bucket, value: NaN } : bucket) },
  ]) assert.equal(hasRiskMaturityHistory({ cik: OPTIONS.cik, refinancingHistory: [{ ...good, ...changes }] }), false);
});

test('same-day original annual filings retain valid chronology without inventing an availability order', () => {
  const history = build(fixture([filing(2024, 1, { filingDate: '2026-02-15' }), filing(2025)]));
  assert.equal(history.length, 2);
  assert.equal(hasRiskMaturityHistory({ cik: OPTIONS.cik, refinancingHistory: history }), true);
});

test('the generator excludes a late older report instead of producing a cache-ineligible history', () => {
  const data = fixture([filing(2023), filing(2024, 1, { filingDate: '2026-03-01' }), filing(2025)]);
  const history = build(data);
  assert.deepEqual(history.map(profile => profile.asOf), ['2023-12-31', '2025-12-31']);
  assert.equal(hasRiskMaturityHistory({ cik: OPTIONS.cik, refinancingHistory: history }), true);
});
