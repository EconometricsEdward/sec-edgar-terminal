import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './fixtures/refinancing-market-summaries.json' with { type: 'json' };
import { buildMarketCompany, marketCompanySummary } from '../src/utils/marketResearchData.js';
import { extractRefinancingProfile, REFINANCING_VERSION } from '../src/utils/refinancing/maturities.js';
import { buildRefinancingWall, compactRefinancingProfile, packRefinancingProfile, isRefinancingProfile,
  isRefinancingWall, REFINANCING_MAX_BYTES } from '../src/utils/refinancing/projection.js';
import { publishRefinancingWall, readRefinancingWall, retainedRefinancingWall,
  encodeRefinancingCache, decodeRefinancingCache, REFINANCING_WALL_KEY } from '../src/utils/refinancing/server.js';
import { refreshQuantRefinancingMappings, applyPreparedRevenueCorrections, needsRefinancingMapping } from '../src/utils/quantCoverageServer.js';

const checkedAt = '2026-09-29T02:00:00.000Z', now = Date.parse(checkedAt);
const accession = '0000000001-26-000001';
const fact = value => ({ val: value, end: '2025-12-31', filed: '2026-02-01', accn: accession, form: '10-K', fy: 2025, fp: 'FY' });
const facts = { cik: 1, entityName: 'Test', facts: { 'us-gaap': Object.fromEntries(Object.entries({
  Assets: [fact(1000)], Revenues: [{ ...fact(500), start: '2025-01-01' }],
  LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: [fact(100)],
  LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo: [fact(0)],
  CashAndCashEquivalentsAtCarryingValue: [fact(200)],
}).map(([key, rows]) => [key, { units: { USD: rows } }])) } };
const fullCompany = () => buildMarketCompany({ ticker: 'TEST', cik: '0000000001', name: 'Test', sic: '3571', facts: facts.facts }, [], checkedAt);
const atlas = (companies = fixtures.companies, generatedAt = checkedAt) => ({ companies, generatedAt, requested: companies.length });
const envelope = value => ({ payload: value, metadata: { fetchedAt: checkedAt, revalidatedAt: checkedAt, expiresAt: '2026-09-30T03:00:00.000Z' } });

test('maturity checkpoint packing round-trips all evidence fields consumed by the public projection', () => {
  const profile = extractRefinancingProfile(facts, { ticker: 'TEST', asOf: '2026-09-29' });
  const packed = packRefinancingProfile(profile);
  assert.equal(packed.packed, true);
  assert.deepEqual(compactRefinancingProfile(packed), compactRefinancingProfile(profile));
  assert.equal(isRefinancingProfile(compactRefinancingProfile(packed), '0000000001'), true);
  assert.equal(marketCompanySummary(fullCompany()).refinancing.packed, true);
  assert.equal(needsRefinancingMapping({ company: { refinancing: packed } }), false);
  assert.equal(needsRefinancingMapping({ company: {} }), true);
  const unsupported = packRefinancingProfile(extractRefinancingProfile({ cik: 1, facts: {} }, { asOf: '2026-09-29' }));
  assert.equal(needsRefinancingMapping({ company: { refinancing: unsupported } }), false, 'missing schedules are negatively cached');
});

test('coverage counts distinguish unprepared, unavailable, partial, complete and reported zero', () => {
  const company = marketCompanySummary(fullCompany());
  const pending = { ...company, ticker: 'PENDING', cik: '0000000002', refinancing: null };
  const unavailable = { ...company, ticker: 'MISSING', cik: '0000000003',
    refinancing: packRefinancingProfile(extractRefinancingProfile({ cik: 3, facts: {} }, { asOf: '2026-09-29' })) };
  const value = buildRefinancingWall(atlas([company, pending, unavailable]));
  assert.equal(isRefinancingWall(value), true);
  assert.deepEqual(value.coverage, { totalCandidates: 3, loadedCompanies: 3, checkedCompanies: 2, coveredCompanies: 1,
    completeCompanies: 0, missingScheduleCompanies: 1, pendingCompanies: 1 });
  const profile = value.companies.find(row => row.ticker === 'TEST').profile;
  assert.equal(profile.buckets[1].value, 0);
  assert.equal(profile.buckets[2].value, null);
  assert.equal(profile.totalScheduled, null);
  assert.equal(profile.reportedSubtotal, 100);
  assert.equal(profile.buckets[0].source, undefined);
  assert.match(profile.sourceUrl, /sec\.gov\/Archives/);
});

test('a realistic 5000-issuer universe remains inside the existing atlas, durable and shared-cache ceilings', () => {
  const companies = Array.from({ length: 5000 }, (_, index) => {
    const company = fixtures.companies[index % fixtures.companies.length], cik = String(index + 1).padStart(10, '0');
    return { ...company, cik, ticker: `ISS${index}`, name: `${company.name} ${index}`,
      refinancing: { ...company.refinancing, cik } };
  });
  const universe = atlas(companies), value = buildRefinancingWall(universe);
  assert.ok(Buffer.byteLength(JSON.stringify(universe)) < 32 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < REFINANCING_MAX_BYTES);
  assert.equal(isRefinancingWall(value), true);
  const cached = encodeRefinancingCache(value);
  assert.ok(Buffer.byteLength(JSON.stringify(cached)) < 1800000);
  assert.equal(decodeRefinancingCache(cached, now).companies.length, 5000);
});

test('shared cache verifies integrity, enforces a hard retention boundary and keeps original source dates', () => {
  const value = buildRefinancingWall(atlas());
  const cached = encodeRefinancingCache(value);
  assert.equal(decodeRefinancingCache(cached, now + 26 * 3600000).cache.status, 'stale');
  assert.equal(decodeRefinancingCache(cached, now + 26 * 3600000).sourceSnapshotAt, checkedAt);
  assert.throws(() => decodeRefinancingCache(cached, now + 7 * 86400000), /retention/);
  assert.throws(() => decodeRefinancingCache({ ...cached, sha256: '0'.repeat(64) }, now), /integrity/);
  assert.equal(retainedRefinancingWall({ ...value, generatedAt: '2026-10-01T00:00:00Z' }, now), null);
  const broken = structuredClone(value); broken.companies[0].profile.totalScheduled += 10;
  assert.equal(isRefinancingWall(broken), false);
  const wrongIssuer = structuredClone(value); wrongIssuer.companies[0].profile.cik = '0000000999';
  assert.equal(isRefinancingWall(wrongIssuer), false);
});

test('public reads issue exactly one durable snapshot read and never recover through SEC or a universe scan', async () => {
  const value = buildRefinancingWall(atlas()), calls = [];
  const data = await readRefinancingWall({ mode: 'supabase', now: () => now,
    read: async (...args) => { calls.push(args); return envelope(value); } });
  assert.equal(data.coverage.coveredCompanies, 4);
  assert.deepEqual(calls, [['financial', REFINANCING_WALL_KEY, { allowStale: true }]]);
  let misses = 0;
  await assert.rejects(readRefinancingWall({ mode: 'supabase', now: () => now, read: async () => { misses++; return null; } }), /unavailable/);
  assert.equal(misses, 1);
  await assert.rejects(readRefinancingWall({ mode: 'off', read: async () => { throw new Error('must not read'); } }), /not available/);
});

test('publication uses an existing fenced dataset key and preserves newer completed snapshots', async () => {
  const value = buildRefinancingWall(atlas()), calls = [];
  const deps = { mode: 'supabase', now: () => now,
    begin: async (...args) => { calls.push(['begin', ...args]); return { owner: 'test', generation: 1 }; },
    release: async (...args) => calls.push(['release', ...args]),
    publish: async payload => calls.push(['publish', payload]), read: async () => null };
  const result = await publishRefinancingWall(atlas(), deps);
  assert.equal(result.coverage.coveredCompanies, 4);
  const written = calls.find(call => call[0] === 'publish')[1];
  assert.equal(written.key, REFINANCING_WALL_KEY);
  assert.equal(written.metadata.parserVersion, REFINANCING_VERSION);
  assert.equal(written.metadata.revalidatedAt, checkedAt);
  calls.length = 0;
  await publishRefinancingWall(atlas(fixtures.companies, '2026-09-28T02:00:00.000Z'), { ...deps, read: async () => envelope(value) });
  assert.equal(calls.filter(call => call[0] === 'publish').length, 0);
  assert.equal(calls.filter(call => call[0] === 'release').length, 1);
});

test('bounded seeding uses archived facts, preserves source clocks and reaches retained-atlas publication', async () => {
  const { refinancing: _profile, ...company } = marketCompanySummary(fullCompany());
  const record = { company, checkedAt, factsRetrievedAt: checkedAt, factsValidatedAt: checkedAt, fingerprint: 'unchanged' };
  const writes = [], reads = [];
  const result = await refreshQuantRefinancingMappings({ now: () => now, deadline: now + 40000,
    readAtlas: async () => atlas([company]), readMany: async () => [record],
    prepared: async (...args) => { reads.push(args); return envelope(facts); },
    write: async (...args) => { writes.push(args); return true; }, acquire: async () => 'lease', release: async () => {} });
  assert.equal(result.checked, 1); assert.equal(result.covered, 1);
  assert.deepEqual(reads, [['/api/xbrl/companyfacts/CIK0000000001.json', { allowStale: true }]]);
  const saved = writes[0][2];
  assert.equal(saved.checkedAt, checkedAt); assert.equal(saved.factsRetrievedAt, checkedAt);
  assert.equal(saved.factsValidatedAt, checkedAt); assert.equal(saved.fingerprint, 'unchanged');
  assert.equal(saved.company.refinancing.packed, true);
  const updated = await applyPreparedRevenueCorrections(atlas([{ ...company, checkedAt, factsRetrievedAt: checkedAt }]), { readMany: async () => [saved] });
  assert.equal(updated.companies[0].refinancing.schemaVersion, REFINANCING_VERSION);
  assert.equal(buildRefinancingWall(updated).coverage.coveredCompanies, 1);
});

test('seeding skips locked shards, unsupported decisions, aborted budgets and incompatible source identities', async () => {
  const { refinancing: _profile, ...company } = marketCompanySummary(fullCompany());
  const record = { company, checkedAt, factsRetrievedAt: checkedAt };
  let reads = 0, writes = 0;
  const deps = { now: () => now, deadline: now + 40000, readAtlas: async () => atlas([company]), readMany: async () => [record],
    prepared: async () => { reads++; return envelope({ ...facts, cik: 9 }); }, write: async () => { writes++; return true; },
    acquire: async () => 'lease', release: async () => {} };
  const invalid = await refreshQuantRefinancingMappings(deps);
  assert.equal(invalid.unavailable, 1); assert.equal(writes, 0);
  reads = 0;
  const locked = await refreshQuantRefinancingMappings({ ...deps, acquire: async () => null });
  assert.equal(locked.skipped, 1);
  const unsupported = await refreshQuantRefinancingMappings({ ...deps, readMany: async () => [{ eligibility: 'unsupported' }] });
  assert.equal(unsupported.skipped, 1);
  await refreshQuantRefinancingMappings({ ...deps, deadline: now });
  assert.equal(reads, 0);
});
