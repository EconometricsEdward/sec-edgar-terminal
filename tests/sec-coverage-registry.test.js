import test from 'node:test';
import assert from 'node:assert/strict';
import previous from '../src/data/sec-coverage-2026-09-08.json' with { type: 'json' };
import { secCoverageFingerprint } from '../src/utils/secCoverageMembership.js';
import { createSecCoverageRegistry, installSecCoverageRegistry } from '../src/utils/secCoverageRegistry.js';
import { readPreparedSecDocument, refreshSecDocument, secDocumentIdentity, isSecPreparedReadEnabled, getSecPreparedCompany } from '../src/utils/secDocumentStore.js';
import { readPreparedAnalysis, prepareFinancialCompany, financialPreparedKey } from '../src/utils/preparedFinancialData.js';
import { readPreparedCompare, readPreparedPortfolio } from '../src/utils/preparedResearchStore.js';
import { ANALYSIS_VERSION, buildAnalysisCompany, packAnalysisCompany } from '../src/utils/analysisResearch.js';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const production = { VERCEL_ENV: 'production' };
function universe(change = () => {}) {
  const value = structuredClone(previous); change(value.issuers);
  value.securities = value.issuers.flatMap(row => row.aliases.map(ticker => ({ ticker, cik: row.cik })));
  value.issuerCount = value.issuers.length; value.securityCount = value.securities.length;
  value.membershipFingerprint = secCoverageFingerprint(value.issuers);
  value.id = `sec-coverage-v1:ivv:${value.reference.asOf}:${value.membershipFingerprint.slice(0, 16)}`;
  return value;
}
const control = { nextCheckAt: '2026-09-14T00:00:00Z', lastCheckedAt: '2026-09-13T12:00:00Z', lastError: null, errorCount: 0, leaseUntil: null };
const state = (active = previous, candidate = null, retained = []) => ({ schema: 1, active, candidate, retained, control });
const renamed = universe(rows => { const row = rows.find(row => row.ticker === 'AMZN'); row.ticker = 'AMZNX'; row.aliases = ['AMZNX']; });

test('production registry coalesces concurrent reads, caches five minutes, and refreshes before new lookups', async () => {
  let calls = 0, now = NOW, current = state();
  const registry = createSecCoverageRegistry({ env: production, now: () => now, read: async () => { calls++; return current; } });
  const values = await Promise.all(Array.from({ length: 20 }, () => registry.load()));
  assert.equal(calls, 1); assert.equal(values.every(value => value === values[0]), true);
  assert.equal(Object.isFrozen(values[0].active.issuers[0].aliases), true);
  current = state(renamed); now += 299999; await registry.load();
  assert.equal(registry.getActiveCompany('AMZNX'), null); assert.equal(calls, 1);
  now++; await registry.load({ required: true });
  assert.equal(registry.getActiveCompany('AMZN'), null);
  assert.equal(registry.getActiveCompany('AMZNX').cik, '0001018724'); assert.equal(calls, 2);
});

test('readers retain validated membership through outages while required workers fail without static fallback', async () => {
  let now = NOW, calls = 0, failing = true;
  const registry = createSecCoverageRegistry({ env: production, now: () => now, read: () => { calls++; if (failing) throw new Error('offline'); return state(renamed); } });
  assert.equal((await registry.load()).active.id, previous.id);
  await assert.rejects(registry.load({ required: true }), error => error.status === 503);
  assert.equal(calls, 1);
  failing = false; now += 30000; await registry.load({ required: true });
  assert.equal(registry.getActiveCompany('AMZNX').cik, '0001018724');
  failing = true; now += 300000;
  assert.equal((await registry.load()).active.id, renamed.id);
  await assert.rejects(registry.load({ required: true }), error => error.code === 'SEC_COVERAGE_REGISTRY_UNAVAILABLE');
  assert.equal(registry.getActiveCompany('AMZN'), null); assert.equal(calls, 3);
});

test('local, preview, and rollback environments use the immutable static cohort without remote reads', async () => {
  for (const env of [{}, { VERCEL_ENV: 'preview', EDGAR_DATASTORE_BROAD_COVERAGE: '1' }, { VERCEL_ENV: 'production', EDGAR_DATASTORE_BROAD_COVERAGE: '0' }]) {
    const registry = createSecCoverageRegistry({ env, now: () => NOW, read: () => assert.fail('No registry read outside production broad coverage.') });
    registry.install(state(renamed));
    assert.equal((await registry.load({ force: true, required: true })).active.id, previous.id);
    assert.equal(registry.getActiveCompany('AMZNX'), null); assert.ok(registry.getActiveCompany('AMZN'));
  }
});

test('candidate and retained issuers are admitted for preparation without changing active public aliases', async () => {
  const registry = createSecCoverageRegistry({ env: production, now: () => NOW });
  registry.install(state(previous, renamed));
  assert.equal(registry.getActiveCompany('AMZN').ticker, 'AMZN');
  assert.equal(registry.getActiveCompany('AMZNX'), null);
  assert.equal(registry.getAdmittedCompany('0001018724').ticker, 'AMZNX');
  const old = previous.issuers.find(row => row.ticker === 'AMZN');
  const replaced = universe(rows => { const row = rows.find(row => row.ticker === 'AMZN'); row.ticker = 'NEWCO'; row.cik = '0000999999'; row.aliases = ['NEWCO']; });
  registry.install(state(replaced, null, [old]));
  assert.equal(registry.isActiveCik(old.cik), false); assert.equal(registry.isAdmittedCik(old.cik), true);
  assert.equal(registry.getActiveCompany('AMZN'), null); assert.equal(registry.getAdmittedCompany('AMZN').cik, old.cik);
});

test('an older in-flight read cannot overwrite a newly installed maintenance publication', async () => {
  let release;
  const registry = createSecCoverageRegistry({ env: production, now: () => NOW, read: () => new Promise(resolve => { release = resolve; }) });
  const pending = registry.load({ required: true }); await Promise.resolve();
  registry.install(state(renamed)); release(state());
  assert.equal((await pending).active.id, renamed.id);
  assert.equal(registry.getActiveCompany('AMZNX').cik, '0001018724');
});

test('invalid, oversized, ambiguous, or backward registry replacements cannot corrupt validated state', () => {
  const registry = createSecCoverageRegistry({ env: production, now: () => NOW }); registry.install(state());
  const ambiguous = universe(rows => { rows.find(row => row.ticker === 'AMZN').cik = '0000999999'; });
  for (const invalid of [null, { ...state(), schema: 2 }, { ...state(), extra: 'x'.repeat(524288) },
    { ...state(), retained: [previous.issuers[0]] }, state(previous, ambiguous),
    { ...state(), control: { ...control, errorCount: -1 } },
  ]) assert.throws(() => registry.install(invalid), error => error.status === 503);
  assert.equal(registry.getActiveCompanies().length, 500); assert.ok(registry.getActiveCompany('AMZN'));
});

async function withProductionRegistry(value, callback) {
  const priorEnv = process.env.VERCEL_ENV, priorBroad = process.env.EDGAR_DATASTORE_BROAD_COVERAGE;
  process.env.VERCEL_ENV = 'production'; process.env.EDGAR_DATASTORE_BROAD_COVERAGE = '1';
  try { installSecCoverageRegistry(value); await callback(); }
  finally {
    installSecCoverageRegistry(state());
    if (priorEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = priorEnv;
    if (priorBroad === undefined) delete process.env.EDGAR_DATASTORE_BROAD_COVERAGE; else process.env.EDGAR_DATASTORE_BROAD_COVERAGE = priorBroad;
  }
}
const freshMetadata = () => ({ fetchedAt: new Date(Date.now() - 1000).toISOString(), revalidatedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });

test('candidate ticker changes cannot invalidate active Analysis and requested ticker is serialized with validated CIK', async () => {
  await withProductionRegistry(state(previous, renamed), async () => {
    const payload = { packed: true, version: ANALYSIS_VERSION, ticker: 'AMZNX', cik: '0001018724', basis: 'annual', periods: [], sourceCatalog: [] };
    const options = { mode: 'supabase', hotRead: async () => null, read: async () => ({ payload, metadata: freshMetadata() }) };
    const result = await readPreparedAnalysis({ ticker: 'AMZN' }, options);
    assert.equal(result.payload.ticker, 'AMZN'); assert.equal(JSON.parse(result.serializedPayload).ticker, 'AMZN');
    assert.equal(result.payload.cik, '0001018724'); assert.equal(payload.ticker, 'AMZNX');
    assert.equal(financialPreparedKey('AMZNX', 'annual'), financialPreparedKey('0001018724', 'annual'));
    assert.equal(await readPreparedAnalysis({ ticker: 'AMZNX' }, options), null);
    await assert.rejects(readPreparedAnalysis({ ticker: 'AMZN' }, { ...options, read: async () => ({ payload: { ...payload, cik: '0000999999' }, metadata: freshMetadata() }) }), error => error.status === 503);
  });
});

test('removed issuers including former pilots leave prepared public reads and retain source preparation eligibility', async () => {
  const removed = previous.issuers.filter(row => ['AMZN', 'AAPL'].includes(row.ticker));
  const active = universe(rows => { for (const row of rows) if (['AMZN', 'AAPL'].includes(row.ticker)) { row.ticker = `${row.ticker}NEW`; row.aliases = [row.ticker]; row.cik = row.cik === '0001018724' ? '0000999998' : '0000999999'; } });
  await withProductionRegistry(state(active, null, removed), async () => {
    const options = { mode: 'supabase', read: () => assert.fail('Removed issuer must use existing on-demand path.'), hotRead: () => assert.fail('Removed issuer must bypass prepared cache.') };
    for (const row of removed) {
      assert.equal(isSecPreparedReadEnabled(row.cik), false);
      assert.equal(secDocumentIdentity(`/submissions/CIK${row.cik}.json`).covered, true);
      assert.equal(getSecPreparedCompany(row.cik).cik, row.cik);
      assert.equal(await readPreparedSecDocument(`/submissions/CIK${row.cik}.json`, options), null);
      assert.equal(await readPreparedAnalysis({ ticker: row.ticker }, options), null);
      assert.equal(await readPreparedCompare({ ticker: row.ticker, cik: row.cik }, options), null);
      assert.equal(await readPreparedPortfolio({ ticker: row.ticker, cik: row.cik }, options), null);
    }
    assert.equal(isSecPreparedReadEnabled('0000002098'), true);
    assert.equal(isSecPreparedReadEnabled('0000320193', { VERCEL_ENV: 'production', EDGAR_DATASTORE_BROAD_COVERAGE: '0' }), true);
  });
});

test('required membership failure stops workers before any data claim or source request', async () => {
  const options = { mode: 'supabase', loadRegistry: async options => { assert.equal(options.required, true); throw Object.assign(new Error('membership unavailable'), { status: 503 }); },
    begin: () => assert.fail('No dataset claim before membership validation.'), fetchSec: () => assert.fail('No source fetch before membership validation.') };
  await assert.rejects(refreshSecDocument('/submissions/CIK0000320193.json', options), error => error.status === 503);
  await assert.rejects(prepareFinancialCompany('AAPL', options), error => error.status === 503);
});

test('raw source changes republish Analysis provenance even when financial calculations are identical', async () => {
  const cik = '0001018724', company = { ticker: 'AMZN', cik, companyName: 'Example', sic: '5961', facts: {}, filings: [], historyLimited: false };
  const documents = [{ payload: { cik, name: company.companyName, sic: company.sic, filings: { recent: { form: [] } } }, metadata: { ...freshMetadata(), documentContentHash: 'a'.repeat(64) } },
    { payload: { cik, facts: {} }, metadata: { ...freshMetadata(), documentContentHash: 'b'.repeat(64) } }];
  const stored = new Map(), publications = []; let revalidations = 0;
  const options = { mode: 'shadow', bases: ['annual'], begin: async () => ({ owner: 'test', generation: 1 }),
    read: async (dataset, key) => dataset === 'sec' ? documents[key.endsWith(':submissions') ? 0 : 1] : stored.get(key),
    publish: async value => { publications.push(value); stored.set(value.key, { payload: value.payload, metadata: value.metadata }); return stored.get(value.key); },
    revalidate: async () => { revalidations++; return true; }, release: async () => true };
  await prepareFinancialCompany(cik, options);
  documents[0] = { ...documents[0], metadata: { ...documents[0].metadata, documentContentHash: 'c'.repeat(64) } };
  await prepareFinancialCompany(cik, options);
  await prepareFinancialCompany(cik, options);
  assert.equal(publications.length, 2); assert.equal(revalidations, 1);
  assert.notEqual(publications[0].metadata.financialInputHash, publications[1].metadata.financialInputHash);
  assert.equal(publications[0].metadata.financialCompanyHash, publications[1].metadata.financialCompanyHash);
  assert.equal(publications[1].identityInputs.inputDocuments[0].contentHash, 'c'.repeat(64));
  assert.equal(publications[0].metadata.inputDocuments[0].contentHash, 'a'.repeat(64));
  const stable = value => ({ ...value, observedAt: undefined });
  assert.deepEqual(stable(publications[0].payload), stable(publications[1].payload));
  assert.deepEqual(stable(publications[1].payload), stable(packAnalysisCompany(buildAnalysisCompany(company, { basis: 'annual', asOf: '' }))));
});
