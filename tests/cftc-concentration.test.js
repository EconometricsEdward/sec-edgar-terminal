import assert from 'node:assert/strict';
import test from 'node:test';
import { CFTC_CONCENTRATION_FIELDS, buildCftcConcentration, cftcConcentrationMatchesHistory, cftcConcentrationQuery, cftcConcentrationSourceUrl } from '../src/utils/cftcConcentration.js';
import { CFTC_CONCENTRATION_FRESH_MS, createCftcConcentrationLoader, validateConcentrationRequest } from '../src/utils/cftcConcentrationServer.js';
import { GET, OPTIONS } from '../src/app/api/v1/cftc/concentration/route.js';

const now = Date.parse('2026-09-14T12:00:00.000Z');
const request = { family: 'tff', code: '134741', reportDate: '2026-09-08' };
// Exact public Socrata response, checked against the official dataset metadata
// September 14, 2026. These are percentages already, not contract counts.
const sofr = {
  id: '260908134741F', market_and_exchange_names: 'SOFR-3M - CHICAGO MERCANTILE EXCHANGE',
  report_date_as_yyyy_mm_dd: '2026-09-08T00:00:00.000', cftc_contract_market_code: '134741',
  cftc_market_code: 'CME ', contract_units: '($2,500 x Contract IMM Index)',
  futonly_or_combined: 'FutOnly', open_interest_all: '13294407',
  conc_gross_le_4_tdr_long: '17.5', conc_gross_le_4_tdr_short: '17.2',
  conc_gross_le_8_tdr_long: '29.2', conc_gross_le_8_tdr_short: '26.4',
};
const wti = {
  id: '260908067651F', market_and_exchange_names: 'WTI-PHYSICAL - NEW YORK MERCANTILE EXCHANGE',
  report_date_as_yyyy_mm_dd: '2026-09-08T00:00:00.000', cftc_contract_market_code: '067651',
  cftc_market_code: 'NYME', contract_units: '(CONTRACTS OF 1,000 BARRELS)',
  futonly_or_combined: 'FutOnly', open_interest_all: '1939911',
  conc_gross_le_4_tdr_long: '16.4', conc_gross_le_4_tdr_short: '18.7',
  conc_gross_le_8_tdr_long: '29.1', conc_gross_le_8_tdr_short: '29.1',
};
const build = (rows = [sofr], identity = request) => buildCftcConcentration({ ...identity, rows, retrievedAt: new Date(now).toISOString() });
const selected = { family: 'tff', reportBasis: 'futures_only', reportDate: '2026-09-08', code: '134741', venueCode: 'CME', units: sofr.contract_units, openInterest: 13294407 };
const response = () => { const value = build(); return { ...value, freshness: { cache_status: 'source', retrieved_at: value.retrieved_at } }; };

function sourceFetcher(calls = [], rows = [sofr]) {
  return async (family, query, options) => {
    calls.push({ family, query, options });
    return { rows, sourceUrl: cftcConcentrationSourceUrl({ ...request, family }) };
  };
}

test('official TFF and disaggregated gross All fields preserve published percentage values and provenance', () => {
  const tff = build(), energy = build([wti], { ...request, family: 'disaggregated', code: '067651' });
  assert.equal(tff.status, 'ready');
  assert.deepEqual(tff.concentration.top4, { longPct: 17.5, shortPct: 17.2 });
  assert.deepEqual(tff.concentration.top8, { longPct: 29.2, shortPct: 26.4 });
  assert.deepEqual(energy.concentration.top4, { longPct: 16.4, shortPct: 18.7 });
  assert.deepEqual(energy.concentration.top8, { longPct: 29.1, shortPct: 29.1 });
  assert.equal(tff.contract.venueCode, 'CME'); assert.equal(tff.contract.openInterest, 13294407);
  assert.equal(tff.concentration.population, 'all_reportable_traders');
  assert.equal(tff.concentration.denominator, 'total_open_interest');
  assert.equal(tff.source.datasetId, 'gpe5-46if'); assert.equal(energy.source.datasetId, '72hh-3qpy');
  assert.deepEqual(tff.source.raw, sofr); assert.deepEqual(tff.source.fields, CFTC_CONCENTRATION_FIELDS);
  const query = cftcConcentrationQuery(request);
  assert.equal(query.$limit, 3);
  assert.match(query.$where, /futonly_or_combined='FutOnly'/);
  assert.match(query.$where, /report_date_as_yyyy_mm_dd='2026-09-08T00:00:00.000'/);
  assert.doesNotMatch(query.$select, /conc_net|conc_gross_le_[48]_tdr_(long|short)_[12]/);
});

test('missing, blank, suppressed and invalid percentages never silently become zero; published zero remains valid', () => {
  for (const input of [undefined, null, '', ' ', '.', 'suppressed', 'NaN', '12%', -1, 100.1]) {
    const value = build([{ ...sofr, conc_gross_le_4_tdr_long: input }]);
    assert.equal(value.status, 'partial'); assert.equal(value.concentration.top4.longPct, null);
    assert.equal(value.concentration.top8.longPct, 29.2);
    assert.ok(value.concentration.unavailable.conc_gross_le_4_tdr_long);
  }
  assert.equal(build([{ ...sofr, conc_gross_le_4_tdr_long: '0.0' }]).concentration.top4.longPct, 0);
  const oldCacheShape = { ...sofr };
  for (const key of Object.values(CFTC_CONCENTRATION_FIELDS)) delete oldCacheShape[key];
  assert.equal(build([oldCacheShape]).status, 'unavailable');
  assert.equal(build([]).status, 'unavailable'); assert.equal(build([]).contract, null);
  for (const oi of [null, '0', '-1', '1.5', '9007199254740993']) assert.equal(build([{ ...sofr, open_interest_all: oi }]).status, 'unavailable');
});

test('inconsistent top-four/top-eight data quarantines that side without mixing long and short', () => {
  const value = build([{ ...sofr, conc_gross_le_4_tdr_long: '30' }]);
  assert.equal(value.status, 'partial');
  assert.equal(value.concentration.top4.longPct, null); assert.equal(value.concentration.top8.longPct, null);
  assert.equal(value.concentration.top4.shortPct, 17.2); assert.equal(value.concentration.top8.shortPct, 26.4);
  assert.equal(value.concentration.unavailable.conc_gross_le_4_tdr_long, 'top_four_exceeds_top_eight');
});

test('mismatched basis/date/contract, incomplete identities, ambiguous and conflicting rows are rejected', () => {
  for (const mutation of [{ futonly_or_combined: 'Combined' }, { cftc_contract_market_code: '067651' }, { report_date_as_yyyy_mm_dd: '2026-09-01T00:00:00.000' }, { report_date_as_yyyy_mm_dd: '2026-09-08arbitrary' }, { cftc_market_code: '' }, { contract_units: null }, { id: null }, { conc_gross_le_4_tdr_long: [] }]) assert.throws(() => build([{ ...sofr, ...mutation }]), { code: 'CFTC_CONCENTRATION_INVALID' });
  assert.equal(build([sofr, { ...sofr }]).status, 'ready');
  assert.throws(() => build([sofr, { ...sofr, conc_gross_le_4_tdr_long: '18' }]), /Conflicting/);
  assert.throws(() => build([sofr, sofr, sofr]), /ambiguous/);
});

test('browser validation binds percentages, source URL and raw inputs to exact selected history identity', () => {
  assert.equal(cftcConcentrationMatchesHistory(response(), selected), true);
  for (const change of [{ code: '067651' }, { family: 'disaggregated' }, { reportDate: '2026-09-01' }, { reportBasis: 'combined' }, { venueCode: 'NYME' }, { units: 'barrels' }, { openInterest: 1 }]) assert.equal(cftcConcentrationMatchesHistory(response(), { ...selected, ...change }), false);
  for (const change of [value => { value.concentration.top4.longPct = 99; }, value => { value.source.url = 'https://other.example/source'; }, value => { value.source.datasetId = '72hh-3qpy'; }, value => { value.concentration.population = 'leveraged-funds'; }, value => { value.status = 'partial'; }, value => { value.freshness.retrieved_at = '2026-09-01T00:00:00Z'; }, value => { value.source.raw.conc_gross_le_8_tdr_long = '100'; }, value => { value.source.fields.top4Long = 'conc_net_le_4_tdr_long_all'; }]) {
    const value = response(); change(value); assert.equal(cftcConcentrationMatchesHistory(value, selected), false);
  }
  const unavailable = build([]); unavailable.freshness = { cache_status: 'source', retrieved_at: unavailable.retrieved_at };
  assert.equal(cftcConcentrationMatchesHistory(unavailable, selected), true);
});

test('bounded loader coalesces same identity, preserves fetched time, and refreshes source corrections without history-cache changes', async () => {
  let clock = now; const calls = [];
  const loader = createCftcConcentrationLoader({ now: () => clock, fetchResource: sourceFetcher(calls) });
  const [a, b] = await Promise.all([loader.load(request), loader.load(request)]);
  assert.equal(calls.length, 1); assert.equal(a.freshness.cache_status, 'source'); assert.deepEqual(a, b);
  assert.equal(calls[0].options.retries, 0); assert.ok(calls[0].options.signal instanceof AbortSignal);
  clock += 1000;
  const cached = await loader.load(request); assert.equal(cached.freshness.cache_status, 'memory'); assert.equal(cached.retrieved_at, a.retrieved_at);
  cached.concentration.top4.longPct = 99;
  assert.equal((await loader.load(request)).concentration.top4.longPct, 17.5);
  clock += CFTC_CONCENTRATION_FRESH_MS;
  assert.equal((await loader.load(request)).freshness.cache_status, 'source'); assert.equal(calls.length, 2);
});

test('a cancelled viewer does not cancel another viewer sharing the bounded source request', async () => {
  let finish;
  const loader = createCftcConcentrationLoader({ now: () => now, fetchResource: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController(), first = loader.load({ ...request, signal: controller.signal });
  const second = loader.load(request); controller.abort();
  await assert.rejects(first, { code: 'CFTC_REQUEST_CANCELLED' });
  finish({ rows: [sofr], sourceUrl: cftcConcentrationSourceUrl(request) });
  assert.equal((await second).status, 'ready');
});

test('source failures back off and disabled, invalid or excessive pending requests do not reach source', async () => {
  let clock = now, calls = 0;
  const failing = createCftcConcentrationLoader({ now: () => clock, fetchResource: async () => { calls++; throw new Error('Source unavailable'); } });
  await assert.rejects(failing.load(request)); await assert.rejects(failing.load(request)); assert.equal(calls, 1);
  clock += 60_001; await assert.rejects(failing.load(request)); assert.equal(calls, 2);
  const disabled = createCftcConcentrationLoader({ enabled: () => false, fetchResource: async () => { assert.fail('Disabled source called'); } });
  await assert.rejects(disabled.load(request), { code: 'CFTC_DISABLED' });
  for (const change of [{ code: "134741' OR 1=1" }, { family: 'legacy' }, { reportDate: 'latest' }, { reportDate: '2099-01-01' }, { reportDate: '2010-01-01' }]) assert.throws(() => validateConcentrationRequest({ ...request, ...change }, now));
  let finish;
  const busy = createCftcConcentrationLoader({ now: () => now, maxPending: 1, fetchResource: () => new Promise(resolve => { finish = resolve; }) });
  const pending = busy.load(request);
  await assert.rejects(busy.load({ ...request, code: '067651' }), { code: 'CFTC_CONCENTRATION_BUSY' });
  finish({ rows: [sofr], sourceUrl: cftcConcentrationSourceUrl(request) }); await pending;
});

test('memory capacity is bounded and a different source URL cannot be cached as official evidence', async () => {
  let calls = 0;
  const loader = createCftcConcentrationLoader({ now: () => now, maxEntries: 2, fetchResource: async (family, query) => {
    calls++;
    const code = /cftc_contract_market_code='([^']+)'/.exec(query.$where)[1];
    return { rows: [], sourceUrl: cftcConcentrationSourceUrl({ ...request, family, code }) };
  } });
  for (const code of ['111111', '222222', '333333', '111111']) await loader.load({ ...request, code });
  assert.equal(calls, 4);
  const forged = createCftcConcentrationLoader({ now: () => now, fetchResource: async () => ({ rows: [sofr], sourceUrl: 'https://other.example/source' }) });
  await assert.rejects(forged.load(request), { code: 'CFTC_CONCENTRATION_INVALID' });
});

test('public endpoint rejects unknown or duplicate parameters and obeys feature rollback', async () => {
  const previous = process.env.CFTC_ENABLED;
  try {
    process.env.CFTC_ENABLED = 'true';
    for (const query of ['family=tff&contract=134741&date=latest', 'family=tff&contract=134741&date=2026-09-08&group=leveraged-funds', 'family=tff&family=tff&contract=134741&date=2026-09-08']) {
      const result = await GET(new Request(`https://example.test/api/v1/cftc/concentration?${query}`));
      assert.equal(result.status, 400); assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
    }
    process.env.CFTC_ENABLED = 'false';
    const result = await GET(new Request('https://example.test/api/v1/cftc/concentration?family=tff&contract=134741&date=2026-09-08'));
    assert.equal(result.status, 503); assert.equal((await result.json()).code, 'CFTC_DISABLED');
    assert.equal(OPTIONS().status, 204);
  } finally { if (previous === undefined) delete process.env.CFTC_ENABLED; else process.env.CFTC_ENABLED = previous; }
});
