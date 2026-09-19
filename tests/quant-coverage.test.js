import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import seed from '../src/data/quant-coverage.json' with { type: 'json' };
import { QUANT_GROUPS, QUANT_BATCHES, QUANT_TARGET_ISSUERS, QUANT_MAX_CHECKS_PER_BATCH, quantBatch, quantSectorForSic } from '../src/utils/quantGroups.js';
import { parseHoldingsCsv, buildExpandedMembership, retainedQuantBaseline, quantExcludedCandidates, isQuantMembership } from '../src/utils/quantMembership.js';
import { filingFingerprint, needsFactsRefresh, membershipId, QUANT_ATLAS_CACHE, QUANT_COMPANY_CACHE, QUANT_COVERAGE_CACHE, quantCandidateEligibility, quantCheckpointFresh, readQuantCheckpoints, assembleQuantAtlas, chooseQuantAtlasPublication } from '../src/utils/quantCoverageServer.js';
import { cacheDeploymentScope } from '../src/utils/cacheScope.js';
import { readSnapshot, writeSnapshot } from '../src/utils/snapshotCache.js';
import { buildUniverseSnapshot } from '../src/utils/marketUniverse.js';
import { chooseUniversePublication } from '../src/utils/marketUniverseServer.js';
import { GET as cron } from '../src/app/api/cron/quant-coverage/route.js';
import { MARKET_REVENUE_VERSION, MARKET_RISK_VERSION } from '../src/utils/marketResearchData.js';

test('coverage manifest maps 1,505 exposures to 1,500 unique issuers in bounded stable shards', () => {
  assert.equal(seed.securities, 1505); assert.equal(seed.issuers, 1500);
  assert.equal(new Set(seed.rows.map(r => r.cik)).size, 1500);
  assert.equal(seed.rows.reduce((n, r) => n + r.aliases.length, 0), 1505);
  assert.ok(seed.rows.every(r => QUANT_GROUPS.some(g => g.label === r.sector)));
  const buckets = Array.from({ length: QUANT_BATCHES }, (_, i) => seed.rows.filter(r => quantBatch(r.cik) === i));
  assert.equal(buckets.flat().length, 1500); assert.ok(buckets.every(b => b.length <= 120));
  assert.equal(membershipId(seed), membershipId({ ...seed, checked_at: '2030-01-01' }));
  assert.notEqual(membershipId(seed), membershipId({ ...seed, rows: seed.rows.slice(1) }));
});

test('quant cache namespaces isolate production, preview commits and local work', () => {
  assert.equal(cacheDeploymentScope('production', 'abcdef'), 'production');
  assert.equal(cacheDeploymentScope('preview', 'abcdef1234567890'), 'preview-abcdef123456');
  assert.equal(cacheDeploymentScope('preview', ''), 'preview-unknown');
  assert.equal(cacheDeploymentScope('development', 'abcdef'), 'local');
  assert.match(QUANT_COVERAGE_CACHE, /^quant-coverage-v2:(?:local|production|preview-[a-z0-9]+)$/);
  assert.match(QUANT_COMPANY_CACHE, /^quant-company-v2:(?:local|production|preview-[a-z0-9]+)$/);
  assert.match(QUANT_ATLAS_CACHE, /^quant-atlas-v2:(?:local|production|preview-[a-z0-9]+)$/);
});

test('holdings parser handles class shares, quoted names, duplicates and completeness gates', () => {
  const source = { fund: 'IVV', min: 1, max: 10, url: 'https://example.test/holdings' };
  const csv = 'Fund Holdings as of,"Sep 08, 2026"\nTicker,Name,Sector,Asset Class,Exchange\n"BRK B","Issuer, Inc.",Financials,Equity,NYSE\n"BRK B",Duplicate,Financials,Equity,NYSE\nXXX,Private,Financials,Equity,NO MARKET (E.G. UNLISTED)\nUSD,Cash,Cash and/or Derivatives,Cash,-\n';
  const parsed = parseHoldingsCsv(csv, source, Date.parse('2026-09-10'));
  assert.deepEqual(parsed.rows.map(r => r.ticker), ['BRK-B']); assert.equal(parsed.rows[0].name, 'Issuer, Inc.');
  assert.throws(() => parseHoldingsCsv(csv.slice(0, csv.indexOf('USD,')), source, Date.parse('2026-09-10')), /incomplete/);
  assert.throws(() => parseHoldingsCsv(csv + '"', source, Date.parse('2026-09-10')), /incomplete/);
  assert.throws(() => parseHoldingsCsv(csv, source, Date.parse('2026-10-10')), /stale/);
  assert.throws(() => parseHoldingsCsv(csv.replace('Financials', 'Unknown'), source, Date.parse('2026-09-10')), /unsupported sector/);
});

test('filing fingerprint excludes unrelated reports but reconciliation cannot suppress new facts', () => {
  const submissions = { filings: { recent: { accessionNumber: ['A', 'B'], form: ['10-Q', '4'], acceptanceDateTime: ['2026-09-01', '2026-09-02'], reportDate: ['2026-06-30', ''] } } };
  const fingerprint = filingFingerprint(submissions);
  submissions.filings.recent.accessionNumber[1] = 'C'; assert.equal(filingFingerprint(submissions), fingerprint);
  const cached = { company: { revenueVersion: MARKET_REVENUE_VERSION, riskVersion: MARKET_RISK_VERSION }, fingerprint, factsRetrievedAt: '2026-09-09' };
  assert.equal(needsFactsRefresh(cached, fingerprint, Date.parse('2026-09-10')), false);
  assert.equal(needsFactsRefresh({ ...cached, company: {} }, fingerprint, Date.parse('2026-09-10')), true, 'an unchanged filing still needs corrected calculations');
  assert.equal(needsFactsRefresh({ ...cached, needsReconciliation: true }, fingerprint, Date.parse('2026-09-10')), true);
  assert.equal(needsFactsRefresh(cached, fingerprint, Date.parse('2026-09-20')), true);
  submissions.filings.recent.accessionNumber[0] = 'D'; assert.equal(needsFactsRefresh(cached, filingFingerprint(submissions), Date.parse('2026-09-10')), true);
});

test('immutable chunks round-trip and a failed write cannot replace a completed snapshot', async () => {
  const cache = new Map(), store = { get: async (type, id) => cache.get(`${type}/${id}`) ?? null, set: async (type, id, value) => { cache.set(`${type}/${id}`, value); return true; } };
  const old = { generated_at: '2026-09-09', evidence: 'completed' };
  assert.equal(await writeSnapshot('test', 'current', old, 100, store), true);
  const next = { data: randomBytes(900000).toString('base64') };
  let chunks = 0;
  const failing = { ...store, set: async (type, id, value) => type.endsWith(':chunks') && ++chunks === 2 ? false : store.set(type, id, value) };
  assert.equal(await writeSnapshot('test', 'current', next, 100, failing), false);
  assert.deepEqual(await readSnapshot('test', 'current', store), old);
  assert.equal(await writeSnapshot('test', 'current', next, 100, store), true);
  assert.deepEqual(await readSnapshot('test', 'current', store), next);
  const manifest = cache.get('test/current'); cache.delete(`test:chunks/${manifest.ids[0]}`);
  assert.equal(await readSnapshot('test', 'current', store), null);
});

test('membership change starts a new history segment and unknown sectors remain unclassified', () => {
  const now = new Date('2026-09-10'), company = { ticker: 'X', cik: '1', name: 'X', sic: '1234', cohorts: [] };
  const atlas = { generatedAt: now.toISOString(), requested: 1, companies: [company] };
  const previous = buildUniverseSnapshot(atlas, {}, { now }); previous.history = [{ sec_snapshot_at: '2026-09-01' }];
  const next = buildUniverseSnapshot({ ...atlas, coverage: { membership_id: 'new' } }, {}, { now });
  const result = chooseUniversePublication(previous, next, now.getTime());
  assert.equal(result.history.length, 1); assert.match(result.history_note, /Coverage membership changed/);
  assert.equal('sector_proxy' in next.rows[0], false); assert.equal(next.scopes.unclassified.companies, 1);
});

test('coverage refresh endpoints require authorization and reject unbounded batches', async () => {
  let response = await cron(new Request('https://example.test/api/cron/quant-coverage?batch=0'));
  assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const original = process.env.CRON_SECRET, originalEnvironment = process.env.VERCEL_ENV;
  process.env.CRON_SECRET = 'test'; process.env.VERCEL_ENV = 'production';
  try {
    for (const query of ['batch=16', 'batch=-1', 'batch=0&batch=1', 'batch=0&membership=1', 'membership=2', '']) {
      response = await cron(new Request(`https://example.test/api/cron/quant-coverage?${query}`, { headers: { authorization: 'Bearer test' } }));
      assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original;
    if (originalEnvironment === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = originalEnvironment;
  }
});

test('authorized preview deployments cannot mutate quant coverage caches', async () => {
  const original = process.env.CRON_SECRET, originalEnvironment = process.env.VERCEL_ENV;
  process.env.CRON_SECRET = 'test'; process.env.VERCEL_ENV = 'preview';
  try {
    const response = await cron(new Request('https://example.test/api/cron/quant-coverage?batch=0', { headers: { authorization: 'Bearer test' } }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original;
    if (originalEnvironment === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = originalEnvironment;
  }
});


function expandedDirectory() {
  const directory = Object.fromEntries(seed.rows.flatMap(row => row.aliases.map(alias => [alias, { cik: row.cik, name: row.name }])));
  for (let i = 0; i < 4000; i++) directory[`NEW${i}`] = { cik: String(9000000 + i).padStart(10, '0'), name: `Additional issuer ${i}` };
  directory.NEWA = { ...directory.NEW0 };
  return directory;
}

test('SEC expansion targets 5,000 distinct issuer candidates, preserving baseline identities and stable membership', () => {
  const directory = expandedDirectory();
  const expanded = buildExpandedMembership(seed, directory, seed, new Date('2026-09-19'));
  assert.equal(expanded.issuers, QUANT_TARGET_ISSUERS);
  assert.equal(new Set(expanded.rows.map(row => row.cik)).size, 5000);
  assert.equal(expanded.rows.filter(row => row.fund !== 'SEC').length, 1500);
  assert.equal(expanded.rows.filter(row => row.fund === 'SEC').length, 3500);
  assert.equal(expanded.securities, 5006, 'duplicate classes do not create companies');
  assert.equal(expanded.rows.find(row => row.ticker === 'NEW0').aliases.length, 2);
  assert.ok(isQuantMembership(expanded));
  const reordered = Object.fromEntries(Object.entries(directory).reverse());
  const later = buildExpandedMembership(seed, reordered, expanded, new Date('2026-09-20'));
  assert.equal(membershipId(later), membershipId(expanded), 'SEC directory order changes do not churn admitted candidates');
  assert.ok(Buffer.byteLength(JSON.stringify(expanded)) < 2 * 1024 * 1024);
  assert.equal(QUANT_MAX_CHECKS_PER_BATCH * QUANT_BATCHES * 2, 8192);
});

test('expansion rejects truncated directory, reassigned baseline identities and corrupt membership', () => {
  assert.throws(() => buildExpandedMembership(seed, {}), /incomplete/);
  const directory = expandedDirectory(); directory.AAPL.cik = '0000000001';
  assert.throws(() => buildExpandedMembership(seed, directory), /revalidated/);
  const value = structuredClone(seed); value.rows[1].cik = value.rows[0].cik;
  assert.equal(isQuantMembership(value), false);
  const repeated = structuredClone(seed); repeated.rows[0].aliases.push(repeated.rows[0].ticker);
  assert.equal(isQuantMembership(repeated), false);
});

test('supplemental issuer eligibility verifies SEC identity, operating reports and supported financial taxonomy', () => {
  const entry = { cik: '0000000001', fund: 'SEC' };
  const submissions = { cik: '1', entityType: 'operating', filings: { recent: { form: ['10-K', '8-K'] } } };
  assert.equal(quantCandidateEligibility(entry, submissions, { facts: { 'us-gaap': {} } }), null);
  assert.throws(() => quantCandidateEligibility(entry, { ...submissions, cik: '2' }), /identity/);
  assert.match(quantCandidateEligibility(entry, { ...submissions, entityType: 'investment' }), /not an operating/);
  assert.match(quantCandidateEligibility(entry, { ...submissions, filings: { recent: { form: ['NPORT-P'] } } }), /No supported/);
  assert.match(quantCandidateEligibility(entry, submissions, { facts: { 'ifrs-full': {} } }), /taxonomy/);
});

test('fresh checkpoints and unsupported candidates avoid repeated SEC work without renewing observation time', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const record = { company: { revenueVersion: MARKET_REVENUE_VERSION, riskVersion: MARKET_RISK_VERSION }, checkedAt: '2026-09-19T00:00:00Z' };
  assert.equal(quantCheckpointFresh(record, now), true);
  assert.equal(quantCheckpointFresh({ ...record, company: { ...record.company, riskVersion: undefined } }, now), false, 'a mapping upgrade becomes due without deleting old data');
  assert.equal(quantCheckpointFresh({ ...record, needsReconciliation: true }, now), false);
  assert.equal(quantCheckpointFresh({ ...record, checkedAt: '2026-09-18T00:00:00Z' }, now), false);
  assert.equal(quantCheckpointFresh({ eligibility: 'unsupported', checkedAt: '2026-09-14T00:00:00Z' }, now), true);
  assert.equal(quantCheckpointFresh({ eligibility: 'unsupported', checkedAt: '2026-09-01T00:00:00Z' }, now), false);
  assert.equal(quantCheckpointFresh({ ...record, checkedAt: '2026-09-20T00:00:00Z' }, now), false);
});

test('broad SEC SIC groups preserve important industry exceptions and unknown classification', () => {
  for (const [sic, sector] of [[6021, 'Financials'], [6798, 'Real Estate'], [2834, 'Health Care'], [1311, 'Energy'],
    [4911, 'Utilities'], [7372, 'Information Technology'], [3674, 'Information Technology'], [2086, 'Consumer Staples'],
    [3312, 'Materials'], [3711, 'Consumer Discretionary'], [4512, 'Industrials'], [9999, 'Unclassified']])
    assert.equal(quantSectorForSic(sic), sector);
});

function stagedAtlas(count = 2, now = Date.parse('2026-09-19T12:00:00Z')) {
  const date = new Date(now).toISOString();
  const entries = [
    { ticker: 'BASE1', cik: '0000000001', sector: 'Industrials', fund: 'IVV' },
    { ticker: 'BASE2', cik: '0000000002', sector: 'Financials', fund: 'IJR' },
    { ticker: 'NEW', cik: '0000000003', sector: 'Unclassified', fund: 'SEC' },
  ];
  const records = entries.map((entry, index) => index >= count ? null : ({ checkedAt: date, factsRetrievedAt: date, company: {
    version: 'market-research-v3', ticker: entry.ticker, cik: entry.cik, name: entry.ticker, sic: index === 2 ? '3674' : '6021',
    observedAt: date, cohorts: [], reports: { annual: null, ttm: null }, metrics: { annual: {}, ttm: {} },
    filingComparisons: { annual: null, ttm: null },
  } }));
  return assembleQuantAtlas({ issuers: entries.length, securities: entries.length, rows: entries, sources: seed.sources, checked_at: date }, records, now);
}

test('staged coverage publishes validated additions without waiting for all candidates and retains baseline gate', () => {
  const partial = stagedAtlas(2);
  assert.equal(partial.requested, 3); assert.equal(partial.companies.length, 2); assert.equal(partial.failures.length, 1);
  const expanded = stagedAtlas(3);
  assert.equal(expanded.companies[2].researchGroup.label, 'Information Technology');
  assert.match(expanded.companies[2].sectorSource, /SEC SIC/);
  assert.throws(() => stagedAtlas(1), /Baseline SEC coverage/);
});

test('a failed supplemental refresh cannot replace a recently completed larger publication', () => {
  const previous = stagedAtlas(3), next = stagedAtlas(2, Date.parse('2026-09-20T12:00:00Z'));
  assert.equal(chooseQuantAtlasPublication(previous, next, Date.parse('2026-09-20T12:00:00Z')), previous);
  assert.equal(chooseQuantAtlasPublication(previous, next, Date.parse('2026-09-27T12:00:00Z')), next, 'retention does not imply indefinite freshness');
  assert.equal(chooseQuantAtlasPublication(next, previous, Date.parse('2026-09-20T12:00:00Z')), previous);
});


test('provider outages retain original fund classification dates for at most thirty days', () => {
  const now = Date.parse('2026-09-19');
  const expanded = buildExpandedMembership(seed, expandedDirectory(), seed, new Date(now));
  const fallback = retainedQuantBaseline(expanded, now);
  assert.equal(fallback.issuers, seed.issuers);
  assert.deepEqual(fallback.sources, seed.sources);
  assert.equal(fallback.sources[0].as_of, '2026-09-08');
  assert.ok(isQuantMembership(fallback));
  assert.throws(() => retainedQuantBaseline(expanded, Date.parse('2026-10-10')), /retention/);
});


test('checkpoint reads use legacy fallback only for missing original-baseline issuers', async () => {
  const ids = [seed.rows[0].cik, seed.rows[1].cik, '0009000000'];
  const calls = [], current = { company: 'current' }, legacy = { company: 'retained' };
  const result = await readQuantCheckpoints(ids, {}, { production: true, readMany: async (type, requested) => {
    calls.push({ type, requested });
    return calls.length === 1 ? [current, null, null] : [legacy];
  } });
  assert.deepEqual(result, [current, legacy, null]);
  assert.deepEqual(calls[1].requested, [seed.rows[1].cik]);
  assert.equal(calls.length, 2);
});


test('unsupported supplemental slots are replaced without evicting baseline, successful or temporarily failed issuers', () => {
  const directory = expandedDirectory(), now = new Date('2026-09-19T12:00:00Z');
  const previous = buildExpandedMembership(seed, directory, seed, now);
  const entries = previous.rows.filter(row => row.fund === 'SEC').slice(0, 3);
  const records = [
    { eligibility: 'unsupported', checkedAt: now.toISOString(), reason: 'Unsupported taxonomy.' },
    { company: { cik: entries[1].cik }, eligibility: 'unsupported', checkedAt: now.toISOString() },
    { lastError: 'SEC coordination unavailable.', checkedAt: now.toISOString() },
  ];
  const excludedCandidates = quantExcludedCandidates(previous, entries, records, now.getTime());
  assert.equal(excludedCandidates.length, 1);
  const next = buildExpandedMembership(seed, directory, previous, now, { excludedCandidates });
  assert.equal(next.issuers, 5000);
  assert.equal(next.rows.some(row => row.cik === entries[0].cik), false);
  assert.ok(entries.slice(1).every(entry => next.rows.some(row => row.cik === entry.cik)));
  assert.equal(next.rows.filter(row => row.fund !== 'SEC').length, 1500);
  assert.ok(next.rows.some(row => !previous.rows.some(prior => prior.cik === row.cik)), 'the vacancy admits a new SEC candidate');
  assert.ok(isQuantMembership(next));
  const retained = quantExcludedCandidates(next, [], [], Date.parse('2026-10-01'));
  assert.equal(retained.length, 1, 'negative membership memory survives expiration of the original checkpoint');
  assert.equal(quantExcludedCandidates(next, [], [], Date.parse('2026-10-20')).length, 0);
});

test('membership preserves the SEC directory source date independently of the membership build date', () => {
  const membership = buildExpandedMembership(seed, expandedDirectory(), seed, new Date('2026-09-19'), { directoryFetchedAt: '2026-09-16T03:00:00Z' });
  assert.equal(membership.checked_at, '2026-09-19T00:00:00.000Z');
  const source = membership.sources.find(source => source.fund === 'SEC');
  assert.equal(source.as_of, '2026-09-16'); assert.equal(source.retrieved_at, '2026-09-16T03:00:00Z');
  assert.throws(() => buildExpandedMembership(seed, expandedDirectory(), seed, new Date('2026-09-19'), { directoryFetchedAt: '2026-09-01T00:00:00Z' }), /timestamp/);
});
