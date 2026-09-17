import test from 'node:test';
import assert from 'node:assert/strict';
import { reportingPeriods, selectFinancialFact } from '../src/utils/xbrlPeriods.js';

const options = { guardAnnualRevenueContext: true };
const annualAccession = '0001104659-26-017530';
const conflictingAccession = '0001104659-26-047689';
const annualPeriod = { kind: 'annual', start: '2025-01-01', end: '2025-12-31' };
const quarterPeriod = { kind: 'quarter', start: '2025-10-01', end: '2025-12-31' };
const observation = (start, end, val, filed, accn, fp, form = '10-Q', fy = Number(end.slice(0, 4))) =>
  ({ start, end, val, filed, accn, fp, form, fy });

// Public SEC Company Facts contexts for FIX. The Q1
// comparative is repeated as CY2025 in accession 0001104659-26-047689.
function entries() {
  return [
    observation('2025-01-01', '2025-03-31', 1831286000, '2025-04-24', '0001558370-25-005411', 'Q1'),
    observation('2025-01-01', '2025-06-30', 4004605000, '2025-07-24', '0001558370-25-009536', 'Q2'),
    observation('2025-04-01', '2025-06-30', 2173319000, '2025-07-24', '0001558370-25-009536', 'Q2'),
    observation('2025-01-01', '2025-09-30', 6455574000, '2025-10-23', '0001104659-25-101821', 'Q3'),
    observation('2025-01-01', '2025-12-31', 9101641000, '2026-02-19', annualAccession, 'FY', '10-K'),
    observation('2025-01-01', '2025-03-31', 1831286000, '2026-04-23', conflictingAccession, 'Q1', '10-Q', 2026),
    observation('2025-01-01', '2025-12-31', 1831286000, '2026-04-23', conflictingAccession, 'Q1', '10-Q', 2026),
    observation('2026-01-01', '2026-03-31', 2865332000, '2026-04-23', conflictingAccession, 'Q1'),
    observation('2026-01-01', '2026-06-30', 6130988000, '2026-07-23', '0001104659-26-086258', 'Q2'),
    observation('2026-04-01', '2026-06-30', 3265656000, '2026-07-23', '0001104659-26-086258', 'Q2'),
  ];
}
const facts = (values = entries()) => ({ 'us-gaap': { Revenues: { units: { USD: values } } } });
const select = (data, period, selectorOptions = options) => selectFinancialFact(data, ['Revenues'], period, 'USD', selectorOptions);

test('Market annual revenue cites supported annual filing when a quarterly filing repeats its Q1 value as a year', () => {
  const selected = select(facts(), annualPeriod);
  assert.equal(selected.value, 9101641000);
  assert.equal(selected.source.accession, annualAccession);
  assert.equal(selected.source.revised, true);
  assert.deepEqual(selected.source.contextWarnings, [{
    code: 'annual-revenue-context-conflict', accession: conflictingAccession,
    filed: '2026-04-23', value: 1831286000,
  }]);
  assert.match(selected.source.revisionNote, /negative fourth-quarter revenue/);
});

test('Market Q4 and subsequent TTM do not subtract nine months from a mis-tagged Q1 comparative', () => {
  const data = facts();
  assert.equal(select(data, quarterPeriod).value, 2646067000);
  const quarter = reportingPeriods(data, 'quarter')[0];
  const ttm = select(data, { ...quarter, kind: 'ttm' });
  assert.equal(ttm.value, 11228024000);
  assert.equal(ttm.sources.find((source) => source.end === '2025-12-31').accession, annualAccession);
  assert.equal(ttm.sources.find((source) => source.end === '2025-12-31').contextWarnings[0].accession, conflictingAccession);
});

test('Market guard is opt-in and never changes other financial selectors by default', () => {
  assert.equal(select(facts(), annualPeriod, {}).value, 1831286000);
  assert.equal(select(facts(), quarterPeriod, {}).value, -4624288000);
});

test('Market guard preserves annual amendments and genuine revised annual comparatives', () => {
  for (const form of ['10-K/A', '10-Q/A']) {
    const revised = observation('2025-01-01', '2025-12-31', 9200000000,
      '2026-08-01', '0001104659-26-090001', form === '10-K/A' ? 'FY' : 'Q2', form, 2026);
    const selected = select(facts([...entries(), revised]), annualPeriod);
    assert.equal(selected.value, revised.val);
    assert.equal(selected.source.accession, revised.accn);
  }
});

test('Market guard honors filing cutoffs and does not use later evidence to reject earlier observations', () => {
  const selected = select(facts(), { ...annualPeriod, asOf: '2026-03-01' });
  assert.equal(selected.value, 9101641000);
  assert.equal(selected.source.contextWarnings, undefined);
  assert.equal(selected.source.revised, false);
});

test('a negative implied quarter alone is not grounds to clamp or replace revised revenue', () => {
  const revised = entries().map((entry) => entry.accn === conflictingAccession && entry.end === annualPeriod.end
    ? { ...entry, val: 6000000000 } : entry);
  assert.equal(select(facts(revised), annualPeriod).value, 6000000000);
  assert.equal(select(facts(revised), quarterPeriod).value, -455574000);
});

test('duplicate shorter value alone is not grounds to reject annual revenue without contradictory annual evidence', () => {
  const noAnnualReport = entries().filter((entry) => entry.accn !== annualAccession);
  assert.equal(select(facts(noAnnualReport), annualPeriod).value, 1831286000);
  const noNineMonths = entries().filter((entry) => entry.end !== '2025-09-30');
  assert.equal(select(facts(noNineMonths), annualPeriod).value, 1831286000);
});

test('Market annual-context guard is independent of SEC fact order and does not mutate supplied facts', () => {
  const data = facts(entries().reverse());
  const before = JSON.stringify(data);
  assert.equal(select(data, annualPeriod).value, 9101641000);
  assert.equal(JSON.stringify(data), before);
});
