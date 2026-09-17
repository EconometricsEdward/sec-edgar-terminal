import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import universe from '../public/portfolio/portfolio-demo-100-universe.json' with { type: 'json' };
import { COMPANY_CFTC_SCHEMA_VERSION } from '../src/utils/companyCftc.js';
import { createPortfolioCftcPreparation, PORTFOLIO_PREPARATION_POLICY as POLICY } from '../src/utils/portfolioCftcPreparation.js';
import { disposableCachePolicy } from '../supabase/functions/edgar-data-gateway/cachePolicy.js';
import { PORTFOLIO_PREPARED_CACHE_TYPE as TYPE, PORTFOLIO_DEMO_CIKS } from '../supabase/functions/edgar-data-gateway/portfolioDemoPolicy.js';

const START = Date.parse('2026-09-16T12:00:00Z');
const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function filing(company, suffix = '000001') {
  const accession = `${company.cik}-26-${suffix}`;
  return { accession, form: '10-K', filed: '2026-01-15', reportDate: '2025-12-31', primaryDoc: 'annual.htm',
    url: `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${accession.replaceAll('-', '')}/annual.htm` };
}
function context(company, clock, suffix) {
  return { schemaVersion: COMPANY_CFTC_SCHEMA_VERSION, ticker: company.ticker, cik: company.cik,
    companyName: company.name, asOf: null, generatedAt: new Date(clock).toISOString(), status: 'no_matches', retryable: false,
    filing: filing(company, suffix), links: [], coverage: {}, limitations: [] };
}
function fixture({ warm = false } = {}) {
  let clock = START, enabled = true, failTicker = '', loseState = false, readGate, suffix = '000001';
  const records = new Map(), writes = [], sources = [], discoveries = [];
  const read = async (_, id) => {
    const value = records.get(id);
    return value && Date.parse(value.expiresAt) > clock ? copy(value) : null;
  };
  const deps = {
    now: () => clock, enabled: () => enabled, read,
    readMany: async (_, ids) => Promise.all(ids.map(id => read(TYPE, id))),
    put: async (_, id, value, ttl, options) => {
      assert.ok(options.ifHash, 'every preparation mutation uses CAS');
      const previous = await read(TYPE, id);
      writes.push({ id, ttl, options: copy({ ifHash: options.ifHash, expiresAt: options.expiresAt }) });
      if (loseState && id === 'DEMO-STATE' && previous) return { stored: false, reason: 'changed' };
      if (options.ifHash === 'absent' ? !!previous : previous?.rawSha256 !== options.ifHash) return { stored: false, reason: 'changed' };
      const expiresAt = new Date(Math.min(clock + ttl * 1000, Date.parse(options.expiresAt) || Infinity)).toISOString();
      const row = { payload: copy(value), rawSha256: hash(value), expiresAt };
      records.set(id, row); return { stored: true, rawSha256: row.rawSha256, expiresAt };
    },
    warmContext: async ticker => warm ? context(universe.companies.find(item => item.ticker === ticker), clock) : null,
    readSubmissions: async company => {
      sources.push(company.ticker);
      if (readGate) await readGate;
      if (company.ticker === failTicker) throw Object.assign(new Error('private source detail'), { code: 'SEC_SOURCE_UNAVAILABLE' });
      const f = filing(company, suffix);
      return { filings: { recent: { accessionNumber: [f.accession], form: [f.form], filingDate: [f.filed], reportDate: [f.reportDate], primaryDocument: [f.primaryDoc] } } };
    },
    discover: async selection => { discoveries.push(selection.ticker); return context(universe.companies.find(item => item.ticker === selection.ticker), clock, suffix); },
    history: async () => { throw new Error('No histories should be fetched for companies without supported links'); },
  };
  const api = createPortfolioCftcPreparation(deps);
  return { api, deps, records, writes, sources, discoveries,
    advance: ms => { clock += ms; }, setEnabled: value => { enabled = value; }, failTicker: value => { failTicker = value; },
    loseState: () => { loseState = true; }, gate: value => { readGate = value; }, revise: () => { suffix = '000002'; } };
}
async function complete(f) {
  let result;
  for (let i = 0; i < 18; i++) {
    result = await f.api.runPortfolioCftcPreparation({ maxCompanies: 6 });
    if (result.status === 'prepared') return result;
    assert.equal(result.status, 'progress');
  }
  assert.fail(`Did not complete: ${JSON.stringify(result)}`);
}

test('prepared keyspace exactly matches the demo, has finite retention and rejects arbitrary keys', () => {
  assert.deepEqual([...PORTFOLIO_DEMO_CIKS].sort(), universe.companies.map(company => company.cik).sort());
  assert.equal(disposableCachePolicy(TYPE, 'DEMO-CURRENT').maxRawBytes, 2 * 1024 * 1024);
  assert.equal(disposableCachePolicy(TYPE, 'DEMO-STATE').maxRawBytes, 16 * 1024);
  const p = disposableCachePolicy(TYPE, `CIK${universe.companies[0].cik}`);
  assert.equal(p.maxRawBytes, 48 * 1024); assert.equal(p.maxTtlSeconds, 14 * 86400);
  assert.equal(p.sourceCik, universe.companies[0].cik);
  for (const id of ['CIK0000000001', 'DEMO-2026-01-01', 'USER-PORTFOLIO', 'DEMO-STATE:OTHER']) assert.equal(disposableCachePolicy(TYPE, id), null);
  assert.equal(disposableCachePolicy(TYPE.replace('production', 'preview'), 'DEMO-CURRENT'), null);
});

test('bounded continuations prepare all100 without publishing partial results; readers have no source side effects', async () => {
  const f = fixture();
  const first = await f.api.runPortfolioCftcPreparation({ maxCompanies: 6 });
  assert.equal(first.completedCompanies, 6); assert.equal(first.status, 'progress');
  assert.equal(await f.api.readPreparedDemoCftcChanges(), null);
  assert.equal((await f.api.readPreparationProgress()).pendingCompanies, 94);
  const result = await complete(f);
  assert.equal(result.completedCompanies, 100); assert.equal(f.sources.length, 100);
  assert.equal(f.records.size, 102);
  const read = await f.api.readPreparedDemoCftcChanges();
  assert.equal(read.coverage.checked, 100); assert.equal(read.coverage.noLink, 100); assert.equal(read.coverage.limited, false);
  assert.equal(read.preparation.status, 'ready');
  const subset = await f.api.readPreparedPortfolioCftcChanges({ companies: universe.companies.slice(0, 4).map(company => ({ ticker: company.ticker, cik: company.cik, rowId: `row:${company.ticker}` })) });
  assert.equal(subset.coverage.checked, 4); assert.equal(subset.preparation.completedCompanies, 100);
  assert.equal(await f.api.readPreparedPortfolioCftcChanges({ companies: [{ ticker: 'ACU', cik: '0000002098' }] }), null);
  assert.equal(f.sources.length, 100);
  f.advance(POLICY.resultCheckMs + 1);
  const stale = await f.api.readPreparedDemoCftcChanges();
  assert.equal(stale.preparation.status, 'stale'); assert.equal(stale.generatedAt, read.generatedAt);
  assert.equal((await f.api.runPortfolioCftcPreparation()).status, 'prepared');
  assert.equal(f.sources.length, 100, 'fresh company contexts are reused for the market refresh');
  assert.equal(f.records.size, 103, 'fixed keys replace instead of accumulating versions');
});

test('daily accession checks reuse extracted context and only new filings trigger parsing', async () => {
  const f = fixture(); await complete(f); assert.equal(f.discoveries.length, 100);
  f.advance(POLICY.sourceCheckMs + 1); await complete(f);
  assert.equal(f.sources.length, 200); assert.equal(f.discoveries.length, 100);
  const rechecked = await f.api.readPreparedDemoCftcChanges();
  assert.ok(rechecked.companyChecks.every(check => check.checkedAt === new Date(START + POLICY.sourceCheckMs + 1).toISOString()),
    'company check dates reflect unchanged-filing revalidation, not original text extraction');
  assert.ok(f.records.get('DEMO-CURRENT').payload.contexts.every(entry => entry.context.generatedAt === new Date(START).toISOString()),
    'original evidence extraction dates remain unchanged');
  f.advance(POLICY.sourceCheckMs + 1); f.revise(); await complete(f);
  assert.equal(f.discoveries.length, 200);
  assert.ok(f.writes.every(write => write.ttl <= disposableCachePolicy(TYPE, write.id).maxTtlSeconds));
});

test('prepared filing connections reuse one snapshot for exact identities in mixed portfolios without source work', async () => {
  const f = fixture({ warm: true }); await complete(f);
  const selected = universe.companies.slice(0, 2).map(({ ticker, cik }) => ({ ticker, cik }));
  let reads = 0; const originalRead = f.deps.read;
  f.deps.read = async (...args) => { reads++; return originalRead(...args); };
  f.api = createPortfolioCftcPreparation(f.deps);
  const writes = f.writes.length;
  const result = await f.api.readPreparedPortfolioMarketConnections([...selected,
    { ticker: 'ACU', cik: '0000002098' }, { ticker: selected[0].ticker, cik: selected[1].cik }]);
  assert.equal(reads, 1); assert.equal(result.length, 2);
  assert.deepEqual(result.map(({ ticker, cik }) => ({ ticker, cik })), selected);
  assert.ok(result.every(row => row.status === 'no_matches' && row.context.status === 'no_matches'
    && row.checkedAt === new Date(START).toISOString() && row.preparation.status === 'ready'));
  assert.equal(f.sources.length, 0); assert.equal(f.discoveries.length, 0); assert.equal(f.writes.length, writes);
  assert.equal(await f.api.readPreparedPortfolioMarketConnections([{ ticker: selected[0].ticker, cik: selected[1].cik }]), null);
  assert.equal(reads, 1, 'unmatched public identities do not read a snapshot');
  f.setEnabled(false);
  assert.equal(await f.api.readPreparedPortfolioMarketConnections(selected), null);
  assert.equal(reads, 1, 'disabled environments cannot access prepared production data');
});

test('prepared filing connections preserve recheck dates and explicitly mark aging data', async () => {
  const f = fixture({ warm: true }); await complete(f);
  const selected = universe.companies.slice(0, 1);
  f.advance(POLICY.resultCheckMs + 1);
  const stale = await f.api.readPreparedPortfolioMarketConnections(selected);
  assert.equal(stale[0].preparation.status, 'stale');
  assert.equal(stale[0].checkedAt, new Date(START).toISOString());
  f.advance(POLICY.sourceCheckMs); await complete(f);
  const fresh = await f.api.readPreparedPortfolioMarketConnections(selected);
  assert.equal(fresh[0].preparation.status, 'ready');
  assert.equal(fresh[0].context.generatedAt, new Date(START).toISOString(), 'source extraction time is never rewritten');
  assert.equal(fresh[0].checkedAt, new Date(START + POLICY.resultCheckMs + 1 + POLICY.sourceCheckMs).toISOString());
});

test('prepared filing connections reject invalid snapshots and expired source checks even if a record outlives its TTL', async () => {
  const f = fixture({ warm: true }); await complete(f);
  const selected = universe.companies.slice(0, 1), saved = f.records.get('DEMO-CURRENT');
  const valid = copy(saved);
  saved.payload.contexts[0].context.cik = universe.companies[1].cik;
  assert.equal(await f.api.readPreparedPortfolioMarketConnections(selected), null);
  f.records.set('DEMO-CURRENT', valid);
  valid.expiresAt = '2027-01-01T00:00:00Z';
  f.advance(POLICY.snapshotRetentionSeconds * 1000);
  assert.equal(await f.api.readPreparedPortfolioMarketConnections(selected), null, 'snapshot age has a hard retention bound');
  valid.payload.checkedAt = new Date(START + POLICY.snapshotRetentionSeconds * 1000).toISOString();
  valid.payload.nextCheckAt = new Date(Date.parse(valid.payload.checkedAt) + POLICY.resultCheckMs).toISOString();
  assert.deepEqual(await f.api.readPreparedPortfolioMarketConnections(selected), [], 'recent publication cannot renew expired company source checks');
});

test('fresh validated warm contexts bootstrap the same100 without filing downloads', async () => {
  const f = fixture({ warm: true }); await complete(f);
  assert.equal(f.sources.length, 0); assert.equal(f.discoveries.length, 0);
});

test('failed company remains incomplete, retries after backoff, and does not replace last successful snapshot', async () => {
  const f = fixture(); await complete(f); const prior = f.records.get('DEMO-CURRENT').rawSha256;
  f.advance(POLICY.sourceCheckMs + 1); f.failTicker(universe.companies[0].ticker);
  for (let i = 0; i < 18; i++) await f.api.runPortfolioCftcPreparation();
  assert.equal(f.records.get('DEMO-CURRENT').rawSha256, prior);
  const progress = await f.api.readPreparationProgress(); assert.equal(progress.completedCompanies, 99); assert.equal(progress.unavailableCompanies, 1);
  assert.equal(JSON.stringify(progress).includes('private source detail'), false);
  f.failTicker(''); f.advance(120_001);
  assert.equal((await f.api.runPortfolioCftcPreparation()).status, 'prepared');
});

test('concurrent invocation yields to active CAS lease and lost state ownership prevents publication', async () => {
  const f = fixture(); let release;
  f.gate(new Promise(resolve => { release = resolve; }));
  const running = f.api.runPortfolioCftcPreparation({ maxCompanies: 1 });
  while (!f.sources.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.api.runPortfolioCftcPreparation()).status, 'busy');
  release(); await running;
  f.gate(null); f.loseState();
  const result = await f.api.runPortfolioCftcPreparation();
  assert.equal(result.status, 'busy'); assert.equal(f.records.has('DEMO-CURRENT'), false);
});

test('off mode has zero side effects and expired prepared data is not renewed by reads', async () => {
  const f = fixture(); f.setEnabled(false);
  assert.equal((await f.api.runPortfolioCftcPreparation()).status, 'disabled');
  assert.equal(await f.api.readPreparedDemoCftcChanges(), null); assert.equal(f.writes.length, 0);
  f.setEnabled(true); await complete(f); const writes = f.writes.length;
  f.advance(POLICY.snapshotRetentionSeconds * 1000 + 1);
  assert.equal(await f.api.readPreparedDemoCftcChanges(), null); assert.equal(f.writes.length, writes);
});

test('a worker losing its checkpoint CAS after source retrieval cannot publish a snapshot', async () => {
  const f = fixture(); let release;
  f.gate(new Promise(resolve => { release = resolve; }));
  const running = f.api.runPortfolioCftcPreparation({ maxCompanies: 1 });
  while (!f.sources.length) await new Promise(resolve => setImmediate(resolve));
  f.loseState(); release();
  const result = await running;
  assert.equal(result.status, 'deferred'); assert.equal(result.code, 'PREPARATION_LEASE_LOST');
  assert.equal(f.records.has('DEMO-CURRENT'), false);
});

test('snapshot next-check interval remains exact while the real clock advances between calls', async () => {
  const f = fixture({ warm: true });
  let tick = 0;
  f.deps.now = () => START + tick++;
  f.api = createPortfolioCftcPreparation(f.deps);
  await complete(f);
  const saved = f.records.get('DEMO-CURRENT').payload;
  assert.equal(Date.parse(saved.nextCheckAt) - Date.parse(saved.checkedAt), POLICY.resultCheckMs);
  assert.equal((await f.api.readPreparedDemoCftcChanges()).preparation.completedCompanies, 100);
});

test('shared market history is stored once, subset events retain only requested companies, and stale/partial flags survive reads', async () => {
  for (const status of ['stale', 'partial']) {
    const f = fixture({ warm: true }); let histories = 0;
    const linked = universe.companies.slice(0, 2);
    f.deps.warmContext = async ticker => {
      const company = universe.companies.find(item => item.ticker === ticker), value = context(company, START);
      if (!linked.some(item => item.ticker === ticker)) return value;
      value.status = 'ready';
      value.links = [{ id: 'crude', family: 'disaggregated', contract: '067651', group: 'managed-money',
        label: 'WTI Physical Crude Oil', reviewStatus: 'candidate',
        reason: 'The filing describes commodity price sensitivity.', reviewQuestion: 'What commodity sensitivity is disclosed?',
        evidence: [{ ...value.filing, text: 'Our operations produce crude oil and our revenue varies with commodity prices.' }] }];
      return value;
    };
    f.deps.history = async () => {
      histories++;
      const points = [{ reportDate: '2026-09-01', long: 140000, short: 125000, openInterest: 1000000 },
        { reportDate: '2026-09-08', long: 150000, short: 120000, openInterest: 1000000 }];
      return { status, report_family: 'disaggregated', report_basis: 'futures_only',
        selection: { contract: '067651', group: 'managed-money' }, retrieved_at: '2026-09-12T12:00:00Z',
        selected: { ...points[1], code: '067651', family: 'disaggregated', reportBasis: 'futures_only' },
        history: points, source: { url: 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json', dataset_id: '72hh-3qpy', report_basis: 'futures_only' } };
    };
    f.api = createPortfolioCftcPreparation(f.deps); await complete(f);
    assert.equal(histories, 1);
    const all = await f.api.readPreparedDemoCftcChanges();
    assert.equal(all.coverage[status === 'stale' ? 'staleMarkets' : 'partialMarkets'], 1);
    if (status === 'stale') assert.equal(all.preparation.status, 'stale');
    assert.equal(all.events[0].historyStatus, status); assert.equal(all.events[0].relatedCompanies.length, 2);
    const one = await f.api.readPreparedPortfolioCftcChanges({ companies: [{ ticker: linked[1].ticker, cik: linked[1].cik, rowId: 'my-row' }] });
    assert.equal(one.coverage.checked, 1); assert.equal(one.events[0].relatedCompanies.length, 1);
    assert.equal(one.events[0].relatedCompanies[0].rowId, 'my-row'); assert.equal(histories, 1);
  }
});
