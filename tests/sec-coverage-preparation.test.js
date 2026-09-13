import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  SEC_MIGRATION_COHORT, SEC_PREPARED_COHORT, getSecPreparedCompany,
  isSecPreparedReadEnabled, secDocumentIdentity, readPreparedSecDocument, refreshSecDocument,
} from '../src/utils/secDocumentStore.js';
import {
  FINANCIAL_PREPARED_BASES, financialPreparedKey, prepareFinancialCompany,
  readPreparedAnalysis, refreshSecCoverageCompany,
} from '../src/utils/preparedFinancialData.js';
import { buildAnalysisCompany, packAnalysisCompany } from '../src/utils/analysisResearch.js';

const cik = '0001652044';
const paths = [`/submissions/CIK${cik}.json`, `/api/xbrl/companyfacts/CIK${cik}.json`];
const now = Date.now();
const metadata = {
  fetchedAt: new Date(now - 48 * 3600000).toISOString(),
  revalidatedAt: new Date(now - 3600000).toISOString(),
  expiresAt: new Date(now + 24 * 3600000).toISOString(),
  documentContentHash: 'verified-source-hash', generation: '9007199254740993',
};
const observation = (value, year = 2025, extra = {}) => ({
  val: value, start: `${year}-01-01`, end: `${year}-12-31`, fy: year, fp: 'FY',
  form: '10-K', filed: `${year + 1}-02-01`, accn: `${cik}-${String(year + 1).slice(-2)}-000001`, ...extra,
});
const instant = (value, year) => { const point = observation(value, year); delete point.start; return point; };
const facts = { 'us-gaap': Object.fromEntries(Object.entries({
  Revenues: [observation(90, 2024), observation(100.125)],
  Assets: [instant(200, 2024), instant(240, 2025)],
  StockholdersEquity: [instant(100, 2024), instant(120, 2025)],
  NetIncomeLoss: [observation(25)],
  NetCashProvidedByUsedInOperatingActivities: [observation(30)],
  PaymentsToAcquirePropertyPlantAndEquipment: [observation(0)],
}).map(([tag, values]) => [tag, { units: { USD: values } }])) };
const submissions = { cik: Number(cik), name: 'Alphabet coverage fixture', sic: '7370', filings: { recent: { form: [] } } };
const company = { ticker: 'GOOGL', cik, companyName: submissions.name, sic: submissions.sic, facts, filings: [], historyLimited: false };
const documents = paths.map((path, index) => ({
  payload: index === 0 ? submissions : { cik: Number(cik), facts },
  metadata: { ...metadata, documentContentHash: `verified-source-${index}`, resource: index === 0 ? 'submissions' : 'companyfacts' },
  stale: false,
}));
const sourceForKey = key => documents[key.endsWith(':submissions') ? 0 : 1];
const rejectNetwork = async () => { throw new Error('Unexpected provider or cache mutation.'); };

function memoryPreparation() {
  const stored = new Map(), writes = [], validations = [], sourceReads = [];
  let generation = 0;
  const options = {
    mode: 'shadow',
    begin: async (_dataset, key) => ({ key, generation: ++generation, owner: 'coverage-test' }),
    read: async (dataset, key) => {
      if (dataset === 'sec') { sourceReads.push(key); return sourceForKey(key); }
      assert.equal(dataset, 'financial'); return stored.get(key) || null;
    },
    publish: async value => {
      writes.push(value);
      const envelope = { payload: value.payload, metadata: { ...value.metadata, generation: String(value.claim.generation) } };
      stored.set(value.key, envelope); return envelope;
    },
    revalidate: async (dataset, key, validation) => { validations.push({ dataset, key, ...validation }); return true; },
    release: async () => true,
    reserveLegacy: rejectNetwork,
    legacyWrite: rejectNetwork,
  };
  return { stored, writes, validations, sourceReads, options };
}

test('production activates every prepared issuer and an explicit rollback retains only pilot readers', async () => {
  assert.deepEqual(SEC_MIGRATION_COHORT.map(row => row.ticker), ['AAPL', 'MSFT', 'JPM', 'ACU']);
  assert.equal(SEC_PREPARED_COHORT.length, 501);
  assert.equal(new Set(SEC_PREPARED_COHORT.map(row => row.cik)).size, 501);
  assert.equal(secDocumentIdentity(paths[0]).covered, true);
  const production = { VERCEL_ENV: 'production' };
  const off = { VERCEL_ENV: 'production', EDGAR_DATASTORE_BROAD_COVERAGE: '0' };
  const on = { VERCEL_ENV: 'production', EDGAR_DATASTORE_BROAD_COVERAGE: '1' };
  for (const row of SEC_PREPARED_COHORT) {
    assert.equal(isSecPreparedReadEnabled(row.cik, production), true);
    assert.equal(isSecPreparedReadEnabled(row.cik, off), SEC_MIGRATION_COHORT.some(pilot => pilot.cik === row.cik));
  }
  for (const row of SEC_MIGRATION_COHORT) assert.equal(isSecPreparedReadEnabled(row.cik, off), true);
  assert.equal(isSecPreparedReadEnabled(cik, off), false);
  assert.equal(isSecPreparedReadEnabled(cik, on), true);
  assert.equal(isSecPreparedReadEnabled('0000000001', on), false);
  assert.equal(isSecPreparedReadEnabled('0000000001', production), false);
  const rollback = { mode: 'supabase', read: rejectNetwork, hotRead: rejectNetwork, readEnabled: value => isSecPreparedReadEnabled(value, off) };
  assert.equal(await readPreparedSecDocument(paths[0], rollback), null);
  assert.equal(await readPreparedAnalysis({ ticker: 'GOOG' }, rollback), null);
  assert.equal(financialPreparedKey('GOOG', 'annual', '2025-12-31'), null);
});

test('alias responses preserve the requested security while all financial storage keys use one CIK', async () => {
  assert.equal(getSecPreparedCompany('GOOG'), getSecPreparedCompany('GOOGL'));
  assert.equal(financialPreparedKey('GOOG', 'annual'), financialPreparedKey('GOOGL', 'annual'));
  assert.equal(financialPreparedKey('BRK.B', 'annual'), financialPreparedKey('BRK-B', 'annual'));
  const payload = JSON.parse(JSON.stringify(packAnalysisCompany(buildAnalysisCompany(company, { basis: 'annual' }))));
  const envelope = { payload, metadata, serializedPayload: JSON.stringify(payload) };
  const keys = [];
  const options = { mode: 'supabase', readEnabled: () => true,
    hotRead: async (_namespace, key) => { keys.push(key); return null; },
    read: async (dataset, key) => { assert.equal(dataset, 'financial'); keys.push(key); return envelope; },
  };
  const [first, second] = await Promise.all([
    readPreparedAnalysis({ ticker: 'GOOG' }, options), readPreparedAnalysis({ ticker: 'GOOGL' }, options),
  ]);
  assert.equal(first.payload.ticker, 'GOOG'); assert.equal(second.payload.ticker, 'GOOGL');
  assert.equal(first.payload.cik, second.payload.cik);
  assert.deepEqual(JSON.parse(first.serializedPayload), first.payload);
  assert.equal(envelope.payload.ticker, 'GOOGL');
  assert.equal(keys.filter(key => key.includes(`CIK${cik}`)).length, 2);
  assert.equal(keys.filter(key => key.includes(':GOOGL:')).length, 2);
  const hot = await readPreparedAnalysis({ ticker: 'GOOG' }, { ...options,
    hotRead: async () => ({ gzip: gzipSync(JSON.stringify(payload)).toString('base64'), metadata }), read: rejectNetwork,
  });
  assert.equal(hot.payload.ticker, 'GOOG');
  assert.equal(hot.cacheSource, 'warm-prepared');
  assert.equal(JSON.parse(hot.serializedPayload).ticker, 'GOOG');
});

test('one broad company refresh supplies two canonical documents to all financial and research views', async () => {
  const preparation = memoryPreparation(), refreshed = [];
  let researchCalls = 0;
  const result = await refreshSecCoverageCompany('GOOG', {
    refresh: async (path, options) => {
      refreshed.push(path); assert.equal(options.minRecheckAgeMs, 15 * 60000);
      return { status: 'current', envelope: documents[paths.indexOf(path)] };
    },
    read: rejectNetwork,
    prepare: ticker => { assert.equal(ticker, 'GOOGL'); return prepareFinancialCompany(ticker, preparation.options); },
    prepareViews: async (researchCompany, sources) => {
      researchCalls++; assert.deepEqual(researchCompany, company);
      assert.equal(sources[0], documents[0]); assert.equal(sources[1], documents[1]);
      return { status: 'prepared', views: [{ status: 'updated' }] };
    },
  });
  assert.equal(result.status, 'prepared'); assert.equal(result.ticker, 'GOOGL');
  assert.deepEqual(refreshed, paths); assert.equal(researchCalls, 1);
  assert.equal(preparation.sourceReads.length, 2);
  assert.deepEqual(preparation.writes.map(write => write.metadata.basis), FINANCIAL_PREPARED_BASES);
  for (const write of preparation.writes) {
    assert.equal(write.payload.ticker, 'GOOGL'); assert.ok(write.key.includes(`CIK${cik}`));
    assert.equal(write.metadata.fetchedAt, metadata.fetchedAt);
    assert.deepEqual(write.metadata.inputDocuments.map(input => input.contentHash), ['verified-source-0', 'verified-source-1']);
  }
});

test('recent source revalidation is reused without provider fetch, new timestamps, or Redis copies', async () => {
  const released = [], previous = structuredClone(documents[0]);
  previous.metadata.revalidatedAt = new Date(now - 5 * 60000).toISOString();
  const unchanged = structuredClone(previous);
  const result = await refreshSecDocument(paths[0], {
    mode: 'supabase', now: () => now, minRecheckAgeMs: 15 * 60000,
    begin: async () => ({ owner: 'coverage-test', generation: 7 }), read: async () => previous,
    fetchSec: rejectNetwork, publish: rejectNetwork, revalidate: rejectNetwork,
    reserveLegacy: rejectNetwork, legacyWrite: rejectNetwork,
    release: async (dataset, key, claim) => { released.push({ dataset, key, claim }); return true; },
  });
  assert.equal(result.status, 'current'); assert.equal(result.envelope, previous);
  assert.deepEqual(previous, unchanged); assert.deepEqual(result.rollback, []);
  assert.equal(released.length, 1); assert.equal(released[0].claim.generation, 7);
});

test('an expired or old source must revalidate even when the refresh interval is supplied', async () => {
  for (const previous of [
    { ...documents[0], metadata: { ...metadata, revalidatedAt: new Date(now - 16 * 60000).toISOString() } },
    { ...documents[0], metadata: { ...metadata, expiresAt: new Date(now - 1).toISOString() } },
  ]) {
    let fetched = 0, validated = 0;
    const result = await refreshSecDocument(paths[0], {
      mode: 'supabase', now: () => now, minRecheckAgeMs: 15 * 60000,
      begin: async () => ({ generation: 8 }), read: async () => previous,
      fetchSec: async () => { fetched++; return new Response(null, { status: 304 }); },
      revalidate: async () => { validated++; return true; },
      publish: rejectNetwork, reserveLegacy: rejectNetwork, legacyWrite: rejectNetwork, release: async () => true,
    });
    assert.equal(fetched, 1); assert.equal(validated, 1); assert.equal(result.status, 'unchanged');
    assert.equal(result.envelope.metadata.fetchedAt, metadata.fetchedAt);
    assert.equal(result.envelope.metadata.revalidatedAt, new Date(now).toISOString());
  }
});

test('the midnight coverage cycle revalidates a daytime backfill before its 25-hour source TTL expires', async () => {
  const cycleAt = Date.parse('2026-09-14T00:00:00.000Z');
  const fetchedAt = '2026-09-13T08:00:00.000Z';
  const prior = documents.map(source => ({ ...source, metadata: { ...source.metadata,
    fetchedAt, revalidatedAt: fetchedAt, expiresAt: '2026-09-14T09:00:00.000Z' } }));
  let providerCalls = 0, revalidations = 0;
  const result = await refreshSecCoverageCompany('GOOG', {
    refresh: (path, options) => refreshSecDocument(path, { ...options,
      mode: 'supabase', now: () => cycleAt,
      begin: async () => ({ generation: 9 }), read: async () => prior[paths.indexOf(path)],
      fetchSec: async () => { providerCalls++; return new Response(null, { status: 304 }); },
      revalidate: async (_dataset, _key, value) => {
        revalidations++; assert.equal(value.revalidatedAt, '2026-09-14T00:00:00.000Z');
        assert.equal(value.expiresAt, '2026-09-15T01:00:00.000Z'); return true;
      },
      publish: rejectNetwork, reserveLegacy: rejectNetwork, legacyWrite: rejectNetwork, release: async () => true,
    }),
    prepare: async () => ({ status: 'prepared', bases: [] }),
    prepareViews: async (_company, sources) => {
      assert.ok(sources.every(source => source.metadata.fetchedAt === fetchedAt));
      assert.ok(sources.every(source => source.metadata.revalidatedAt === '2026-09-14T00:00:00.000Z'));
      return { status: 'prepared', bases: [] };
    },
  });
  assert.equal(result.status, 'prepared'); assert.equal(providerCalls, 2); assert.equal(revalidations, 2);
});

test('latest metric projections retain correct units, nulls, actual zeroes, and complete evidence references', async () => {
  const preparation = memoryPreparation();
  await prepareFinancialCompany('GOOG', { ...preparation.options, bases: ['annual'] });
  const { payload, observations } = preparation.writes[0];
  assert.equal(observations.length, payload.definitions.length);
  assert.equal(new Set(observations.map(row => row.metric)).size, observations.length);
  const get = key => observations.find(row => row.metric === key);
  assert.equal(get('revenue').value, 100.125); assert.equal(get('revenue').unit, 'USD');
  assert.equal(get('capex').value, 0); assert.equal(get('capex').context.classification, 'reported');
  assert.equal(get('cashReturned').value, null);
  assert.equal(get('epsBasic').value, null); assert.equal(get('epsBasic').unit, 'USD/shares');
  assert.equal(get('sharesDiluted').value, null); assert.equal(get('sharesDiluted').unit, 'shares');
  assert.equal(get('netMargin').unit, '%');
  for (const row of observations) {
    const point = payload.metrics[row.metric][0];
    assert.equal(row.value, Number.isFinite(point.value) ? point.value : null);
    assert.equal(row.periodEnd, payload.periods[0].end);
    assert.deepEqual(row.context.sourceIds, point.sourceIds);
    assert.deepEqual(row.context.calculationIds, point.calculationIds);
    assert.equal(row.context.evidenceLocation, 'version_snapshot.sourceCatalog');
    assert.ok(row.context.sourceIds.every(id => payload.sourceCatalog[id]));
    assert.ok(row.context.calculationIds.every(id => payload.calculationCatalog[id]));
    if (row.context.classification === 'unavailable') assert.equal(row.value, null);
  }
});

test('unchanged broad-company inputs revalidate existing versions without recalculation or duplicate publication', async () => {
  const preparation = memoryPreparation();
  await prepareFinancialCompany('GOOG', preparation.options);
  const before = structuredClone([...preparation.stored.entries()]);
  const next = await prepareFinancialCompany('GOOGL', preparation.options);
  assert.equal(preparation.writes.length, 4); assert.equal(preparation.validations.length, 4);
  assert.ok(next.bases.every(result => result.status === 'unchanged'));
  assert.deepEqual([...preparation.stored.entries()], before);
  assert.equal(preparation.sourceReads.length, 4);
  for (const validation of preparation.validations) {
    assert.equal(validation.revalidatedAt, metadata.revalidatedAt);
    assert.equal(validation.expiresAt, metadata.expiresAt);
  }
});

test('busy source, interrupted execution, and an unfinished view cannot be marked prepared', async () => {
  let refreshed = 0;
  assert.equal((await refreshSecCoverageCompany('GOOG', {
    refresh: async () => { refreshed++; return { status: 'busy' }; }, prepare: rejectNetwork, prepareViews: rejectNetwork,
  })).status, 'busy');
  assert.equal(refreshed, 1);
  const controller = new AbortController(); controller.abort();
  assert.equal((await refreshSecCoverageCompany('GOOG', { signal: controller.signal, refresh: rejectNetwork })).status, 'busy');
  assert.equal((await refreshSecCoverageCompany('GOOG', {
    refresh: async path => ({ status: 'current', envelope: documents[paths.indexOf(path)] }),
    prepare: async () => ({ bases: [] }), prepareViews: async () => ({ views: [{ status: 'busy' }] }),
  })).status, 'busy');
});

test('independently disabled financial or research writers cannot complete issuer coverage', async () => {
  const refresh = async path => ({ status: 'current', envelope: documents[paths.indexOf(path)] });
  const financialOff = await refreshSecCoverageCompany('GOOG', {
    refresh, prepare: async () => ({ status: 'off', bases: [] }), prepareViews: rejectNetwork,
  });
  assert.notEqual(financialOff.status, 'prepared');
  const researchOff = await refreshSecCoverageCompany('GOOG', {
    refresh, prepare: async () => ({ status: 'prepared', bases: [] }), prepareViews: async () => ({ status: 'off', views: [] }),
  });
  assert.notEqual(researchOff.status, 'prepared');
});

test('Analysis preparation respects an expired deadline before any claim or source access', async () => {
  const result = await prepareFinancialCompany('GOOG', {
    mode: 'shadow', deadline: Date.now() + 59000,
    begin: rejectNetwork, read: rejectNetwork, publish: rejectNetwork,
  });
  assert.equal(result.status, 'busy'); assert.equal(result.bases.length, 4);
  assert.ok(result.bases.every(basis => basis.status === 'busy'));
});

test('interrupted Analysis releases unfinished claims and resumes from the completed basis', async () => {
  const preparation = memoryPreparation(), controller = new AbortController(), released = [];
  const publish = preparation.options.publish;
  const interrupted = await prepareFinancialCompany('GOOG', { ...preparation.options,
    signal: controller.signal, deadline: Date.now() + 225000,
    publish: async value => { const stored = await publish(value); controller.abort(); return stored; },
    release: async (_dataset, key) => { released.push(key); return true; },
  });
  assert.equal(interrupted.status, 'busy'); assert.equal(preparation.writes.length, 1);
  assert.equal(interrupted.bases.filter(basis => basis.status === 'updated').length, 1);
  assert.equal(interrupted.bases.filter(basis => basis.status === 'busy').length, 3);
  assert.equal(released.length, 3);
  const resumed = await prepareFinancialCompany('GOOG', preparation.options);
  assert.equal(resumed.status, 'prepared'); assert.equal(preparation.writes.length, 4);
  assert.equal(resumed.bases.filter(basis => basis.status === 'unchanged').length, 1);
  assert.equal(resumed.bases.filter(basis => basis.status === 'updated').length, 3);
});

test('coverage passes its budget into Analysis and stops if source retrieval exhausts that budget', async () => {
  const controller = new AbortController(), deadline = Date.now() + 225000;
  const result = await refreshSecCoverageCompany('GOOG', {
    signal: controller.signal, deadline,
    refresh: async path => ({ status: 'current', envelope: documents[paths.indexOf(path)] }),
    prepare: async (_ticker, options) => {
      assert.equal(options.signal, controller.signal); assert.equal(options.deadline, deadline);
      return { status: 'busy', bases: [] };
    }, prepareViews: rejectNetwork,
  });
  assert.equal(result.status, 'busy');
  let count = 0;
  const stopped = await refreshSecCoverageCompany('GOOG', {
    signal: controller.signal, deadline,
    refresh: async path => { if (++count === 2) controller.abort(); return { status: 'current', envelope: documents[paths.indexOf(path)] }; },
    prepare: rejectNetwork, prepareViews: rejectNetwork,
  });
  assert.equal(count, 2); assert.equal(stopped.status, 'busy');
});
