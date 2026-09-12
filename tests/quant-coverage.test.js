import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import seed from '../src/data/quant-coverage.json' with { type: 'json' };
import { QUANT_GROUPS, QUANT_BATCHES, quantBatch } from '../src/utils/quantGroups.js';
import { parseHoldingsCsv } from '../src/utils/quantMembership.js';
import { filingFingerprint, needsFactsRefresh, membershipId } from '../src/utils/quantCoverageServer.js';
import { readSnapshot, writeSnapshot } from '../src/utils/snapshotCache.js';
import { buildUniverseSnapshot } from '../src/utils/marketUniverse.js';
import { chooseUniversePublication } from '../src/utils/marketUniverseServer.js';
import { GET as cron } from '../src/app/api/cron/quant-coverage/route.js';

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
  const cached = { company: {}, fingerprint, factsRetrievedAt: '2026-09-09' };
  assert.equal(needsFactsRefresh(cached, fingerprint, Date.parse('2026-09-10')), false);
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
  const original = process.env.CRON_SECRET; process.env.CRON_SECRET = 'test';
  try {
    for (const query of ['batch=16', 'batch=-1', 'batch=0&batch=1', 'batch=0&membership=1', 'membership=2', '']) {
      response = await cron(new Request(`https://example.test/api/cron/quant-coverage?${query}`, { headers: { authorization: 'Bearer test' } }));
      assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
  } finally { if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original; }
});
