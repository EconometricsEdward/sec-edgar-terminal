import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { prepareFinancialCompany, readPreparedAnalysis, financialPreparedKey, refreshSecFinancialCohort, sampleFinancialShadow } from '../src/utils/preparedFinancialData.js';
import { buildAnalysisCompany, packAnalysisCompany, unpackAnalysisCompany } from '../src/utils/analysisResearch.js';

const now = Date.now();
const metadata = { fetchedAt: new Date(now - 60000).toISOString(), revalidatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), documentContentHash: 'source-hash' };
const obs = (val, year = 2025, extra = {}) => ({ val, start: `${year}-01-01`, end: `${year}-12-31`, fy: year, fp: 'FY', form: '10-K', filed: `${year + 1}-02-01`, accn: `0000320193-${String(year + 1).slice(-2)}-000001`, ...extra });
const instant = (val, year) => { const point = obs(val, year); delete point.start; return point; };
const tags = {
  Revenues: [obs(100, 2024), obs(110, 2024, { filed: '2026-02-01', accn: '0000320193-26-000001' }), obs(200.12345)],
  Assets: [instant(1000, 2024), instant(1200, 2025)],
  StockholdersEquity: [instant(100, 2024), instant(150, 2025)],
  NetIncomeLoss: [obs(20)],
  NetCashProvidedByUsedInOperatingActivities: [obs(30)],
  PaymentsToAcquirePropertyPlantAndEquipment: [obs(0)],
  PaymentsOfDividends: [obs(5)],
};
const facts = { 'us-gaap': Object.fromEntries(Object.entries(tags).map(([tag, values]) => [tag, { units: { USD: values } }])) };
const submissions = { cik: '320193', name: 'Apple financial fixture', sic: '3571', filings: { recent: { form: [] } } };
const company = { ticker: 'AAPL', cik: '0000320193', companyName: submissions.name, sic: submissions.sic, facts, filings: [], historyLimited: false };
const docs = (key) => ({ payload: key.endsWith(':submissions') ? submissions : { cik: '320193', facts }, metadata });
const stable = (value) => JSON.parse(JSON.stringify({ ...value, observedAt: undefined }));

test('all four prepared bases exactly retain existing calculations, evidence, precision and missing values', async () => {
  const writes = [];
  const result = await prepareFinancialCompany('AAPL', { mode: 'shadow', read: async (dataset, key) => dataset === 'sec' ? docs(key) : null,
    begin: async () => ({ generation: 1 }), publish: async (value) => { writes.push(value); }, legacyWrite: async () => true });
  assert.equal(result.bases.length, 4);
  for (const write of writes) {
    assert.deepEqual(stable(write.payload), stable(packAnalysisCompany(buildAnalysisCompany(company, { basis: write.metadata.basis, asOf: '' }))));
    assert.equal(write.metadata.fetchedAt, metadata.fetchedAt);
    assert.equal(write.metadata.inputDocuments.length, 2);
    assert.equal(write.metadata.publishedAt, null);
  }
  const annual = unpackAnalysisCompany(writes.find((write) => write.metadata.basis === 'annual').payload);
  assert.equal(annual.metrics.revenue[0].value, 200.12345);
  assert.equal(annual.metrics.revenue[1].value, 110);
  assert.equal(annual.metrics.revenue[1].sources[0].end, '2024-12-31');
  assert.equal(annual.metrics.revenue[1].sources[0].filed, '2026-02-01');
  assert.equal(annual.metrics.revenue[1].sources[0].revised, true);
  assert.equal(annual.metrics.capex[0].value, 0);
  assert.equal(annual.metrics.cashReturned[0].value, null);
  const observed = writes[0].observations.find((row) => row.metric === 'revenue');
  assert.equal(observed.periodEnd, '2025-12-31');
  assert.equal(writes[0].payload.sourceCatalog[observed.context.sourceIds[0]].unit, 'USD');
  assert.ok(writes.every((write) => write.observations.every((row) => Buffer.byteLength(JSON.stringify(row.context)) < 8192)));
});

test('prepared reader uses compact snapshot through Redis failure, never loads SEC facts', async () => {
  let reads = 0;
  const payload = packAnalysisCompany(buildAnalysisCompany(company, { basis: 'annual' }));
  const value = await readPreparedAnalysis({ ticker: 'AAPL' }, { mode: 'supabase', hotRead: async () => { throw new Error('Redis unavailable'); }, hotWrite: async () => false,
    read: async (dataset) => { reads++; assert.equal(dataset, 'financial'); return { payload, metadata }; } });
  assert.equal(reads, 1); assert.deepEqual(value.payload, payload);
  assert.equal(value.cacheSource, 'supabase-prepared');
  await assert.rejects(readPreparedAnalysis({ ticker: 'AAPL' }, { mode: 'supabase', hotRead: async () => null, read: async () => { throw new Error('Supabase down'); } }), (error) => error.status === 503);
  await assert.rejects(readPreparedAnalysis({ ticker: 'AAPL' }, { mode: 'supabase', hotRead: async () => null, read: async () => null }), (error) => error.status === 503);
});

test('financial off/shadow, unmigrated companies and arbitrary historical cutoffs preserve bounded legacy route', async () => {
  const noRead = async () => { throw new Error('should not read'); };
  for (const [settings, mode] of [[{ ticker: 'AAPL' }, 'off'], [{ ticker: 'AAPL' }, 'shadow'], [{ ticker: 'UNKNOWN' }, 'supabase'], [{ ticker: 'AAPL', asOf: '2025-01-01' }, 'supabase']]) {
    assert.equal(await readPreparedAnalysis(settings, { mode, read: noRead, hotRead: noRead }), null);
  }
  assert.equal(financialPreparedKey('AAPL', 'invalid'), null);
});

test('unchanged financial inputs revalidate without recalc, preserving rollback response', async () => {
  const stored = new Map(); let published = 0, revalidated = 0, rollbackWrites = 0;
  const dependencies = { mode: 'shadow', bases: ['annual'], begin: async () => ({ generation: 1 }),
    read: async (dataset, key) => dataset === 'sec' ? docs(key) : stored.get(key) || null,
    publish: async (value) => { published++; stored.set(value.key, { payload: value.payload, metadata: value.metadata }); },
    revalidate: async () => { revalidated++; return true; }, legacyWrite: async () => { rollbackWrites++; return true; } };
  await prepareFinancialCompany('AAPL', dependencies);
  await prepareFinancialCompany('AAPL', dependencies);
  assert.equal(published, 1); assert.equal(revalidated, 1); assert.equal(rollbackWrites, 2);
  const prepared = [...stored.values()][0];
  assert.equal(await sampleFinancialShadow(company, prepared.payload, { mode: 'shadow', read: async () => prepared, now: now + 1e6, report: () => {} }), 'identical');
});

test('bounded cohort stops on failed company and resumes its cursor', async () => {
  const calls = [];
  const first = await refreshSecFinancialCohort({ maxCompanies: 2, refresh: async (path) => { calls.push(path); if (path.includes('0000789019')) throw new Error('provider unavailable'); return { status: 'updated' }; }, prepare: async () => ({ bases: [] }) });
  assert.equal(first.nextCursor, 1); assert.equal(first.done, false); assert.equal(calls.length, 3);
  const second = await refreshSecFinancialCohort({ cursor: first.nextCursor, maxCompanies: 1, refresh: async () => ({ status: 'unchanged' }), prepare: async () => ({ bases: [] }) });
  assert.equal(second.nextCursor, 2);
  await assert.rejects(refreshSecFinancialCohort({ maxCompanies: 100 }), /bounded/);
});

test('all financial output claims precede source capture and rollback writes carry their fences', async () => {
  let claims = 0, reserved = 0, sourceReads = 0;
  await prepareFinancialCompany('AAPL', { mode: 'shadow',
    begin: async (_dataset, key) => { claims++; return { key, generation: claims, owner: 'fixture-owner' }; },
    reserveLegacy: async () => { reserved++; return true; },
    read: async (dataset, key) => {
      if (dataset !== 'sec') return null;
      assert.equal(claims, 4); assert.equal(reserved, 4); sourceReads++; return docs(key);
    },
    publish: async (value) => ({ payload: value.payload, metadata: value.metadata }),
    legacyWrite: async (_namespace, _id, value, _ttl, claim) => {
      assert.ok(claim.fenceId.startsWith('financial-analysis-v1:'));
      assert.ok(claim.generation > 0); assert.equal(value.metadata.fetchedAt, metadata.fetchedAt); return true;
    },
  });
  assert.equal(sourceReads, 2);
});

test('prepared gzip hot cache preserves source metadata and never needs a database read', async () => {
  const payload = packAnalysisCompany(buildAnalysisCompany(company, { basis: 'annual' }));
  const hot = { gzip: gzipSync(JSON.stringify(payload)).toString('base64'), metadata };
  const result = await readPreparedAnalysis({ ticker: 'AAPL' }, { mode: 'supabase',
    hotRead: async (namespace) => { assert.equal(namespace, 'analysis-research'); return hot; },
    read: async () => { throw new Error('A hot read must not query storage.'); },
  });
  assert.equal(result.cacheSource, 'warm-prepared');
  assert.equal(result.metadata.fetchedAt, metadata.fetchedAt);
  assert.deepEqual(stable(result.payload), stable(payload));
});
