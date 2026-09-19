import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { prepareResearchViews } from '../src/utils/preparedResearchViews.js';
import { readPreparedCompare, readPreparedPortfolio, researchPreparedKey, researchHotCacheEligible } from '../src/utils/preparedResearchStore.js';
import { buildCompareCompany } from '../src/utils/compareResearch.js';
import { packAnalysisCompany, unpackAnalysisCompany } from '../src/utils/analysisResearch.js';
import { packPortfolioCompany, unpackPortfolioCompany } from '../src/utils/portfolioEvidenceCodec.js';
import { buildPortfolioCompanyFromDocuments, loadCachedPortfolioCompany, loadFreshPortfolioCompany } from '../src/utils/portfolioResearchServer.js';
import { isSecPreparedReadEnabled } from '../src/utils/secDocumentStore.js';
import { enrichAnalysisCompanySources } from '../src/utils/analysisResearchSources.js';

function fixture(ticker = 'AAPL', cik = '0000320193') {
  const now = Date.now(), fetchedAt = new Date(now - 60000).toISOString();
  const metadata = { fetchedAt, revalidatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString() };
  const obs = (val, year, instant = false) => ({ val, end: `${year}-12-31`, ...(instant ? {} : { start: `${year}-01-01` }),
    fy: year, fp: 'FY', form: '10-K', filed: `${year + 1}-02-01`, accn: `${cik}-${String(year + 1).slice(-2)}-000001` });
  const tags = { Revenues: [obs(100, 2024), obs(123.4567, 2025)], Assets: [obs(500, 2024, true), obs(600, 2025, true)],
    StockholdersEquity: [obs(100, 2024, true), obs(120, 2025, true)], NetIncomeLoss: [obs(22, 2025)],
    NetCashProvidedByUsedInOperatingActivities: [obs(30, 2025)], PaymentsToAcquirePropertyPlantAndEquipment: [obs(0, 2025)] };
  const facts = { 'us-gaap': Object.fromEntries(Object.entries(tags).map(([key, values]) => [key, { units: { USD: values } }])) };
  const submissions = { cik: Number(cik), name: 'Public company fixture', sic: '3571', tickers: [ticker],
    filings: { recent: { accessionNumber: [], form: [], filingDate: [], primaryDocument: [] } } };
  const sources = [submissions, { cik: Number(cik), facts }].map((payload, index) => ({ payload,
    metadata: { ...metadata, generation: String(index + 1), versionId: `version-${index}`, contentHash: `hash-${index}`, documentContentHash: `hash-${index}` } }));
  const company = { ticker, cik, companyName: submissions.name, sic: submissions.sic, facts, filings: [], historyLimited: false };
  const documents = { [`/submissions/CIK${cik}.json`]: submissions, [`/api/xbrl/companyfacts/CIK${cik}.json`]: sources[1].payload };
  return { company, sources, documents, metadata };
}

function storage(sources) {
  const records = new Map(), writes = [], claims = [], released = [], hot = new Map();
  const dependencies = { mode: 'shadow',
    begin: async (_dataset, key) => { const claim = { generation: String(claims.length + 1), key }; claims.push(claim); return claim; },
    reserve: async () => true,
    manifests: async (dataset, keys) => dataset === 'sec'
      ? sources.map((source) => ({ id: source.metadata.versionId, generation: '999', contentHash: source.metadata.contentHash }))
      : keys.map((key) => records.get(key) ? { metadata: records.get(key).metadata } : null),
    read: async (dataset, key) => { assert.equal(dataset, 'financial'); return records.get(key) || null; },
    publish: async (value) => { writes.push(value); const envelope = { payload: value.payload, metadata: value.metadata }; records.set(value.key, envelope); return envelope; },
    revalidate: async (_dataset, key, next) => { records.get(key).metadata = { ...records.get(key).metadata, revalidatedAt: next.revalidatedAt, expiresAt: next.expiresAt }; return true; },
    release: async (_dataset, key) => { released.push(key); return true; },
    hotWrite: async (_namespace, key, value) => { hot.set(key, value); return true; },
  };
  return { records, writes, claims, released, hot, dependencies };
}
const stable = (value) => JSON.parse(JSON.stringify({ ...value, observedAt: undefined }));

test('seven prepared views retain the existing financial engines and evidence without extra source requests', async () => {
  const { company, sources, documents, metadata } = fixture();
  const state = storage(sources);
  const result = await prepareResearchViews(company, sources, state.dependencies);
  assert.equal(result.status, 'prepared'); assert.equal(state.writes.length, 7);
  for (const write of state.writes) {
    assert.equal(write.metadata.fetchedAt, metadata.fetchedAt);
    assert.equal(write.metadata.inputDocuments.length, 2);
    if (write.metadata.view === 'compare') {
      const enriched = await enrichAnalysisCompanySources(company, { basis: write.metadata.basis });
      assert.deepEqual(stable(write.payload), stable(packAnalysisCompany(buildCompareCompany(enriched, { basis: write.metadata.basis }))));
      assert.ok(write.metadata.sourceCoverage);
      assert.equal(write.metadata.compareMappingVersion, write.payload.mappingVersion);
    } else {
      const existing = await loadFreshPortfolioCompany(company, write.metadata.basis, {
        retrievedAt: metadata.fetchedAt, secJson: async (path) => { assert.ok(documents[path]); return documents[path]; },
      });
      assert.deepEqual(JSON.parse(JSON.stringify(unpackPortfolioCompany(write.payload))), JSON.parse(JSON.stringify(existing)));
    }
  }
  const annual = state.writes.find((write) => write.metadata.view === 'compare' && write.metadata.basis === 'annual');
  assert.equal(unpackAnalysisCompany(annual.payload).metrics.revenue[0].value, 123.4567);
  const portfolio = state.writes.find((write) => write.metadata.view === 'portfolio' && write.metadata.basis === 'annual');
  assert.equal(unpackPortfolioCompany(portfolio.payload).metrics.capex.value, 0);
  assert.equal(unpackPortfolioCompany(portfolio.payload).metrics.debt.value, null);
});

test('prepared Compare reads use compact evidence, retain aliases and never request raw facts', async () => {
  const { company, sources, metadata } = fixture();
  const payload = packAnalysisCompany(buildCompareCompany(company, { basis: 'annual' }));
  let hotCalls = 0, durableCalls = 0;
  const dependencies = { mode: 'supabase', enabled: () => true, lookup: () => company,
    hotRead: async () => { hotCalls++; return { gzip: gzipSync(JSON.stringify(payload)).toString('base64'), metadata }; },
    read: async () => { durableCalls++; throw new Error('Raw or durable fetch is unexpected on a hot hit.'); } };
  const packed = await readPreparedCompare({ ticker: 'ALIAS', format: 'packed' }, dependencies);
  assert.equal(packed.payload.packed, true); assert.equal(packed.payload.ticker, 'ALIAS');
  assert.equal(packed.payload.cik, company.cik); assert.equal(durableCalls, 0);
  const expanded = await readPreparedCompare({ ticker: 'AAPL' }, dependencies);
  assert.equal(expanded.payload.metrics.revenue[0].value, 123.4567);
  assert.ok(expanded.payload.metrics.revenue[0].sources[0].documentUrl.startsWith('https://www.sec.gov/'));
  assert.equal(hotCalls, 2);
  const cold = await readPreparedCompare({ ticker: 'AAPL' }, { ...dependencies,
    hotRead: async () => { throw new Error('Redis unavailable'); },
    read: async (dataset, key) => { assert.equal(dataset, 'financial'); assert.equal(key, researchPreparedKey('compare', company.cik, 'annual'));
      return { payload, metadata: sources[0].metadata }; },
  });
  assert.equal(cold.cacheSource, 'supabase-prepared');
  assert.deepEqual(stable(cold.payload), stable(expanded.payload));
});

test('portfolio prepared hit returns current complete evidence without source fetching or recalculation', async () => {
  const { company, documents, metadata } = fixture();
  const built = await buildPortfolioCompanyFromDocuments(company, 'annual', documents, { retrievedAt: metadata.fetchedAt });
  let reads = 0;
  const preparedRead = (selection) => readPreparedPortfolio(selection, { mode: 'supabase', enabled: () => true,
    hotRead: async () => null, read: async (dataset) => { reads++; assert.equal(dataset, 'financial'); return { payload: packPortfolioCompany(built.payload), metadata }; },
  });
  const result = await loadCachedPortfolioCompany(company, 'annual', { preparedRead,
    secJson: async () => { throw new Error('A prepared portfolio must not fetch SEC documents.'); },
  });
  assert.equal(reads, 1); assert.deepEqual(JSON.parse(JSON.stringify(result.metrics)), JSON.parse(JSON.stringify(built.payload.metrics)));
  assert.equal(result.cache.source, 'supabase-prepared'); assert.equal(result.retrievedAt, metadata.fetchedAt);
});

test('production broad Compare and Portfolio reads preserve aliases and an explicit rollback avoids prepared storage', async () => {
  const { company, documents, metadata } = fixture('GOOGL', '0001652044');
  const compare = packAnalysisCompany(buildCompareCompany(company, { basis: 'annual' }));
  const portfolio = packPortfolioCompany((await buildPortfolioCompanyFromDocuments(company, 'annual', documents,
    { retrievedAt: metadata.fetchedAt })).payload);
  const reads = [];
  const dependencies = env => ({ mode: 'supabase', enabled: cik => isSecPreparedReadEnabled(cik, env),
    hotRead: async () => { throw new Error('Broad readers must not fetch Redis company documents.'); },
    read: async (dataset, key) => {
      assert.equal(dataset, 'financial'); reads.push(key);
      return { payload: key === researchPreparedKey('compare', company.cik, 'annual') ? compare : portfolio, metadata };
    },
  });
  for (const reader of [readPreparedCompare, readPreparedPortfolio]) {
    const active = await reader({ ticker: 'GOOG' }, dependencies({ VERCEL_ENV: 'production' }));
    assert.equal(active.payload.ticker, 'GOOG'); assert.equal(active.payload.cik, company.cik);
    assert.equal(active.cacheSource, 'supabase-prepared');
  }
  assert.deepEqual(reads, ['compare', 'portfolio'].map(kind => researchPreparedKey(kind, company.cik, 'annual')));
  assert.equal(compare.ticker, 'GOOGL'); assert.equal(portfolio.ticker, 'GOOGL');
  for (const reader of [readPreparedCompare, readPreparedPortfolio]) {
    assert.equal(await reader({ ticker: 'GOOG' }, dependencies({ VERCEL_ENV: 'production', EDGAR_DATASTORE_BROAD_COVERAGE: '0' })), null);
  }
  assert.equal(reads.length, 2);
});

test('unpublished, historical and disabled projections retain existing bounded paths; storage outage fails closed', async () => {
  const noRead = async () => { throw new Error('No storage access expected.'); };
  for (const [selection, mode, enabled] of [[{ ticker: 'AAPL' }, 'off', true], [{ ticker: 'AAPL' }, 'shadow', true],
    [{ ticker: 'AAPL', asOf: '2024-01-01' }, 'supabase', true], [{ ticker: 'AAPL' }, 'supabase', false]])
    assert.equal(await readPreparedCompare(selection, { mode, enabled: () => enabled, hotRead: noRead, read: noRead }), null);
  assert.equal(await readPreparedCompare({ ticker: 'AAPL' }, { mode: 'supabase', enabled: () => true, hotRead: async () => null, read: async () => null }), null);
  await assert.rejects(readPreparedCompare({ ticker: 'AAPL' }, { mode: 'supabase', enabled: () => true, hotRead: async () => null,
    read: async () => { throw new Error('Storage is unavailable'); } }), (error) => error.status === 503);
});

test('source version changes are rejected after claims; revalidation-only generations remain usable', async () => {
  const { company, sources } = fixture(); const state = storage(sources);
  state.dependencies.manifests = async () => {
    assert.equal(state.claims.length, 7);
    return sources.map((source, index) => ({ id: source.metadata.versionId, contentHash: index ? 'new-hash' : source.metadata.contentHash }));
  };
  await assert.rejects(prepareResearchViews(company, sources, state.dependencies), /SEC inputs changed/);
  assert.equal(state.writes.length, 0); assert.equal(state.released.length, 7);
  const next = storage(sources);
  await prepareResearchViews(company, sources, next.dependencies);
  assert.equal(next.writes.length, 7);
});

test('unchanged views reuse stored calculations and retain original retrieval time', async () => {
  const { company, sources } = fixture(); const state = storage(sources);
  await prepareResearchViews(company, sources, state.dependencies);
  const result = await prepareResearchViews(company, sources.map((source) => ({ ...source,
    metadata: { ...source.metadata, revalidatedAt: new Date().toISOString() } })), state.dependencies);
  assert.equal(state.writes.length, 7); assert.ok(result.bases.every((view) => view.status === 'unchanged'));
  assert.ok([...state.hot.values()].every((view) => view.metadata.fetchedAt === sources[0].metadata.fetchedAt));
});

test('broad coverage does not replicate per-company views into Redis', async () => {
  const { company, sources } = fixture('AMZN', '0001018724'); const state = storage(sources);
  state.dependencies.reserve = async () => { throw new Error('Broad preparation must not add Redis fences.'); };
  assert.equal(researchHotCacheEligible(company.cik), false);
  await prepareResearchViews(company, sources, state.dependencies);
  assert.equal(state.writes.length, 7); assert.equal(state.hot.size, 0);
  state.dependencies.read = async () => { throw new Error('Unchanged broad views must not download stored objects.'); };
  const unchanged = await prepareResearchViews(company, sources, state.dependencies);
  assert.ok(unchanged.bases.every((view) => view.status === 'unchanged'));
});

test('deadlines stop safely and XOM requires the existing verified predecessor chain', async () => {
  const { company, sources } = fixture(); const state = storage(sources);
  const stopped = await prepareResearchViews(company, sources, { ...state.dependencies, deadline: Date.now() });
  assert.equal(stopped.status, 'busy'); assert.equal(state.claims.length, 0);
  const xom = fixture('XOM', '0002115436');
  const skipped = await buildPortfolioCompanyFromDocuments(xom.company, 'annual', xom.documents, { retrievedAt: xom.metadata.fetchedAt });
  assert.equal(skipped.status, 'skipped'); assert.match(skipped.reason, /predecessor/);
});

test('verified XOM supporting documents preserve predecessor evidence in every prepared portfolio basis', async () => {
  const current = fixture('XOM', '0002115436'), predecessor = fixture('XOM', '0000034088');
  current.company.facts = {}; current.sources[1].payload.facts = {};
  const supportingSources = Object.keys(predecessor.documents).map((path, index) => ({ path,
    envelope: { ...predecessor.sources[index], metadata: { ...predecessor.sources[index].metadata,
      versionId: `prior-version-${index}`, contentHash: `prior-hash-${index}`, documentContentHash: `prior-hash-${index}` } } }));
  const state = storage([...current.sources, ...supportingSources.map((source) => source.envelope)]);
  const result = await prepareResearchViews(current.company, current.sources, { ...state.dependencies, supportingSources });
  assert.equal(result.bases.filter((view) => view.kind === 'portfolio' && view.status === 'updated').length, 4);
  const annual = state.writes.find((write) => write.metadata.view === 'portfolio' && write.metadata.basis === 'annual');
  const payload = unpackPortfolioCompany(annual.payload);
  assert.equal(payload.cik, '0002115436'); assert.equal(payload.evidenceContinuity.status, 'applied');
  assert.equal(payload.metrics.revenue.value, 123.4567);
  assert.equal(payload.metrics.revenue.sources[0].sourceCik, '0000034088');
  assert.match(payload.metrics.revenue.sources[0].documentUrl, /\/34088\//);
  assert.equal(annual.metadata.inputDocuments.length, 4);
  await assert.rejects(prepareResearchViews(fixture().company, fixture().sources, { ...state.dependencies, supportingSources }), /verified ExxonMobil/);
});

test('an interrupted scheduled worker releases all acquired view claims without publishing partial calculations', async () => {
  const { company, sources } = fixture(), state = storage(sources), controller = new AbortController();
  const manifestRead = state.dependencies.manifests;
  state.dependencies.manifests = async (...args) => { controller.abort(); return manifestRead(...args); };
  const result = await prepareResearchViews(company, sources, { ...state.dependencies, signal: controller.signal });
  assert.equal(result.status, 'busy'); assert.equal(state.claims.length, 7);
  assert.equal(state.released.length, 7); assert.equal(state.writes.length, 0);
});

test('prepared Compare shares source enrichment and skips it when unchanged verified inputs are reusable', async () => {
  const { company, sources } = fixture(), state = storage(sources), calls = [];
  let filingReads = 0;
  const dependencies = { ...state.dependencies,
    loadFiling: async () => { filingReads++; return 'verified document'; },
    enrichCompany: async (value, settings, options) => {
      calls.push(settings.basis);
      await options.loadFiling({ url: 'https://www.sec.gov/Archives/verified-primary.htm' });
      return { ...value, sourceCoverage: { filingFallback: { status: 'applied' }, continuity: { status: 'not-applicable' },
        sourceDocuments: [{ kind: 'inline-filing', contentHash: 'verified-hash', url: 'https://www.sec.gov/Archives/verified-primary.htm' }] } };
    },
  };
  await prepareResearchViews(company, sources, dependencies);
  assert.deepEqual(calls, ['annual', 'quarter']);
  assert.equal(filingReads, 1);
  const written = state.writes.filter(write => write.metadata.view === 'compare');
  assert.equal(written.length, 3);
  assert.ok(written.every(write => write.metadata.supplementalDocuments[0].contentHash === 'verified-hash'));
  await prepareResearchViews(company, sources, dependencies);
  assert.equal(calls.length, 2);
  assert.equal(state.writes.length, 7);
});

test('unavailable supplemental evidence does not publish a degraded prepared comparison', async () => {
  const { company, sources } = fixture(), state = storage(sources);
  const result = await prepareResearchViews(company, sources, { ...state.dependencies,
    enrichCompany: async value => ({ ...value, sourceCoverage: { filingFallback: { status: 'unavailable' } } }),
  });
  assert.equal(result.status, 'busy');
  assert.equal(state.writes.filter(write => write.metadata.view === 'compare').length, 0);
  assert.equal(state.writes.filter(write => write.metadata.view === 'portfolio').length, 4);
  assert.equal(state.released.length, 3);
});

test('old Compare mapping payloads are rejected even if the storage schema version is current', async () => {
  const { company, metadata } = fixture();
  const payload = packAnalysisCompany(buildCompareCompany(company, { basis: 'annual' }));
  delete payload.mappingVersion;
  await assert.rejects(readPreparedCompare({ ticker: 'AAPL', format: 'packed' }, {
    mode: 'supabase', enabled: () => true, lookup: () => company, loadRegistry: async () => {},
    hotRead: async () => null, read: async () => ({ payload, metadata }),
  }), /validation|refresh/);
});
