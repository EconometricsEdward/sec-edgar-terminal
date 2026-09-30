import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { maturityView, comparableRiskChanges } from '../src/app/risk/riskEvidenceModel.js';
import { projectRiskMarketContext, createRiskContextRead } from '../src/utils/riskMarketContext.js';
import { extractRefinancingProfile } from '../src/utils/refinancing/maturities.js';
import { compactRefinancingProfile } from '../src/utils/refinancing/projection.js';

const funding = { kind: 'funding', generatedAt: '2026-09-29T23:10:00Z', availability: 'ready', rates: [
  { date: '2026-09-25', series: 'SOFR', value: 3.9, p1: 3.83, p99: 3.99, volume: 2900 },
  { date: '2026-09-25', series: 'TGCR', value: 3.89 },
  { date: '2026-09-28', series: 'SOFR', value: 4, p1: 3.83, p99: 4.03, volume: 3000 },
  { date: '2026-09-28', series: 'TGCR', value: 3.95 },
], fails: [{ date: '2026-09-23', deliver: 110000, receive: 100000 }] };
const derivatives = { kind: 'derivatives', generatedAt: '2026-09-29T23:10:00Z', observations: [
  { date: '2026-09-04', asset: 'rates', measure: 'outstanding', product: 'TOTAL', dimension: 'clearing', bucket: 'Total', value: 2000 },
  { date: '2026-09-04', asset: 'rates', measure: 'outstanding', product: 'TOTAL', dimension: 'clearing', bucket: 'Cleared', value: 1500 },
  { date: '2026-09-04', asset: 'rates', measure: 'outstanding', product: 'TOTAL', dimension: 'clearing', bucket: 'Uncleared', value: 500 },
] };

test('funding spreads use same-date percentages, bps conversion, and retain source units', () => {
  const value = projectRiskMarketContext(funding, derivatives);
  assert.equal(value.funding.latest.spreadBps, 5);
  assert.equal(value.funding.latest.dispersionBps, 20);
  assert.equal(value.funding.latest.volumeBillions, 3000);
  assert.equal(value.funding.fails[0].deliver, 110000);
  assert.equal(value.derivatives.swaps[0].clearedShare, 75);
  assert.equal(value.derivatives.swaps[0].total, 2000);
  assert.equal(value.derivatives.swaps[1].total, null);
  const incomplete = structuredClone(funding);
  incomplete.rates.pop();
  assert.equal(projectRiskMarketContext(incomplete, null).funding.latest.spreadBps, null);
});

test('market projection is small and finite with real prepared provider fixtures', () => {
  const load = name => JSON.parse(readFileSync(new URL(`../src/data/market-research/${name}.json`, import.meta.url)));
  const value = projectRiskMarketContext(load('funding'), load('derivatives'));
  assert.ok(value.funding.rates.length <= 67);
  assert.ok(value.funding.fails.length <= 14);
  assert.equal(value.derivatives.swaps.length, 3);
  assert.ok(value.derivatives.swaps.every(swap => swap.trend.length <= 16));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 30000);
});

test('shared market reads coalesce concurrent visitors and do not read per company', async () => {
  let calls = 0, time = 0;
  const read = createRiskContextRead({ now: () => time, read: async kind => { calls++; return kind === 'funding' ? funding : derivatives; } });
  const values = await Promise.all(Array.from({ length: 30 }, () => read()));
  assert.equal(calls, 2);
  assert.ok(values.every(value => value === values[0]));
  time = 59000; await read(); assert.equal(calls, 2);
  time = 61000; await read(); assert.equal(calls, 4);
});

test('failed market reads cool down, partial sources recover, and rollback avoids CFTC reads', async () => {
  let calls = 0, time = 0;
  const fail = createRiskContextRead({ now: () => time, read: async () => { calls++; throw new Error('offline'); } });
  await assert.rejects(fail()); await assert.rejects(fail()); assert.equal(calls, 2);
  time = 10001; await assert.rejects(fail()); assert.equal(calls, 4);
  const kinds = [];
  const disabled = createRiskContextRead({ derivativesEnabled: false, read: async kind => { kinds.push(kind); return funding; } });
  assert.equal((await disabled()).derivatives, null);
  assert.deepEqual(kinds, ['funding']);
  const partial = createRiskContextRead({ read: async kind => { if (kind === 'derivatives') throw new Error('offline'); return funding; } });
  assert.equal((await partial()).funding.latest.sofr, 4);
});

test('maturity concentrations need complete schedules; elapsed buckets and thereafter remain explicit', () => {
  const schedule = { buckets: [
    { key: 'next12m', value: 0, endDate: '2026-06-30' }, { key: 'year2', value: 20, endDate: '2027-06-30' },
    { key: 'year3', value: 10 }, { key: 'year4', value: 10 }, { key: 'year5', value: 10 }, { key: 'after5', value: 150 },
  ], coverage: { complete: true }, totalScheduled: 200 };
  const view = maturityView(schedule, '2026-09-30');
  assert.equal(view.peak.key, 'year2');
  assert.equal(view.nearShare, .1);
  assert.equal(view.buckets[0].elapsed, true);
  assert.equal(view.buckets[1].elapsed, false);
  assert.equal(view.buckets[0].value, 0);
  schedule.buckets[0].value = null; schedule.coverage.complete = false;
  assert.equal(maturityView(schedule, '2026-09-30').nearShare, null);
  assert.equal(maturityView(null, '2026-09-30').peak, null);
});

test('change table compares adjacent dated evidence and never treats a missing prior as zero', () => {
  const profile = { basis: 'ttm', periods: [{ end: '2026-06-30' }, { end: '2026-03-31' }], metrics: [
    { id: 'margin', value: .15, format: 'pct', series: [{ end: '2026-03-31', value: .1 }, { end: '2026-06-30', value: .15 }] },
    { id: 'missing', value: 10, series: [{ end: '2026-03-31', value: null }, { end: '2026-06-30', value: 10 }] },
    { id: 'loss_years', value: 1, format: 'count', series: [{ end: '2026-03-31', value: 0 }, { end: '2026-06-30', value: 1 }] },
  ] };
  const changes = comparableRiskChanges(profile);
  assert.equal(changes.length, 1); assert.equal(changes[0].deltaFormat, 'pp');
  assert.ok(Math.abs(changes[0].delta - .05) < 1e-10);
  profile.periods[1].end = '2025-06-30';
  assert.deepEqual(comparableRiskChanges(profile), []);
});

test('adding maturities is pure extraction of original registrant facts with a bounded payload', () => {
  const row = { end: '2025-12-31', filed: '2026-02-01', form: '10-K', accn: '0000000001-26-000001', val: 100 };
  const company = { cik: 1, facts: { 'us-gaap': Object.fromEntries(['InNextTwelveMonths','InYearTwo','InYearThree','InYearFour','InYearFive','AfterYearFive']
    .map(suffix => [`LongTermDebtMaturitiesRepaymentsOfPrincipal${suffix}`, { units: { USD: [row] } }])) } };
  const value = compactRefinancingProfile(extractRefinancingProfile(company, { cik: 1, asOf: '2026-09-30' }));
  assert.equal(value.status, 'ready'); assert.equal(value.totalScheduled, 600);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 6000);
  assert.equal(extractRefinancingProfile(company, { cik: 2, asOf: '2026-09-30' }).status, 'unavailable');
});
