import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createCompareResearchLoader, loadCompareResearchCompany } from '../src/utils/compareResearchServer.js';
import { matchingCompareResult } from '../src/utils/compareResponseValidation.js';
import { buildCompareCompany, COMPARE_VERSION, COMPARE_MAPPING_VERSION } from '../src/utils/compareResearch.js';
import { packAnalysisCompany, unpackAnalysisCompany } from '../src/utils/analysisResearch.js';
import { PreparedSecUnavailableError } from '../src/utils/secDocumentStore.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const selection = { ticker: 'SMALL', basis: 'annual', asOf: '' };
const company = { ticker: 'SMALL', cik: '0001234567', companyName: 'Comparison fixture', sic: '3571',
  facts: { 'us-gaap': { Revenues: { units: { USD: [{ val: 100.125, start: '2024-01-01', end: '2024-12-31',
    fy: 2024, fp: 'FY', form: '10-K', filed: '2025-02-01', accn: '0001234567-25-000001' }] } } } }, filings: [], historyLimited: false };
const resultFor = (settings = selection) => packAnalysisCompany(buildCompareCompany({ ...company, ticker: settings.ticker }, settings));
const dependencies = { preparedRead: async () => null, read: async () => null, write: async () => true, load: async () => company };

test('concurrent comparison readers share prepared lookup, source calculation and one compact storage write', async () => {
  let release, preparedReads = 0, reads = 0, loads = 0, builds = 0, writes = 0;
  const load = createCompareResearchLoader({ ...dependencies,
    preparedRead: async settings => { preparedReads++; assert.equal(settings.format, 'packed'); return null; },
    read: async () => { reads++; return null; },
    load: async () => { loads++; return new Promise(resolve => { release = resolve; }); },
    build: (...args) => { builds++; return buildCompareCompany(...args); },
    write: async (type, id, value, ttl) => {
      writes++; assert.equal(type, 'compare-research'); assert.equal(id, `${COMPARE_VERSION}:SMALL:annual:`); assert.equal(ttl, 300);
      const saved = JSON.parse(gunzipSync(Buffer.from(value.gzip, 'base64')));
      assert.equal(saved.packed, true); assert.equal(saved.mappingVersion, COMPARE_MAPPING_VERSION);
      assert.equal(saved.metrics.revenue[0].value, 100.125);
      assert.equal(saved.sourceCatalog[saved.metrics.revenue[0].sourceIds[0]].accession, '0001234567-25-000001');
      return true;
    },
  });
  const requests = Array.from({ length: 40 }, () => load(selection));
  await tick(); release(company);
  const responses = await Promise.all(requests);
  assert.deepEqual([preparedReads, reads, loads, builds, writes], [1, 1, 1, 1, 1]);
  assert.ok(responses.every(value => value === responses[0]));
  assert.equal(responses[0].serializedPayload, JSON.stringify(responses[0].payload));
  assert.equal(unpackAnalysisCompany(responses[0].payload).metrics.revenue[0].sources[0].value, 100.125);
});

test('prepared response preserves original retrieval/stale headers without touching raw sources or optional cache', async () => {
  const payload = resultFor();
  const prepared = { payload, cacheSource: 'supabase-prepared', stale: true,
    metadata: { fetchedAt: '2025-02-01T00:00:00.000Z', revalidatedAt: '2025-02-02T00:00:00.000Z', expiresAt: '2025-02-03T00:00:00.000Z' } };
  const unexpected = async () => assert.fail('A prepared result must not request other sources.');
  const load = createCompareResearchLoader({ preparedRead: async () => prepared, read: async () => null, load: unexpected, write: unexpected });
  const result = await load(selection);
  assert.equal(result.payload, payload); assert.equal(result.cacheSource, 'supabase-prepared');
  assert.equal(result.headers['X-Data-Fetched-At'], prepared.metadata.fetchedAt);
  assert.equal(result.headers['X-Data-Stale'], 'true');
});

test('mapping rollout rejects old prepared/warm projections and recalculates from the guarded source loader', async () => {
  for (const preparedRead of [async () => { throw new PreparedSecUnavailableError('Old prepared projection'); },
    async () => ({ payload: { ...resultFor(), mappingVersion: 'old' } })]) {
    let loads = 0;
    const load = createCompareResearchLoader({ ...dependencies, preparedRead,
      read: async () => ({ gzip: gzipSync(JSON.stringify({ ...resultFor(), mappingVersion: 'old' })).toString('base64') }),
      load: async () => { loads++; return company; },
    });
    assert.equal((await load(selection)).payload.mappingVersion, COMPARE_MAPPING_VERSION); assert.equal(loads, 1);
  }
  const unexpectedFailure = createCompareResearchLoader({ ...dependencies, preparedRead: async () => { throw new Error('Unexpected storage error'); } });
  await assert.rejects(unexpectedFailure(selection), /Unexpected storage error/);
});

test('bases and cutoff dates have distinct work and cache identities; source enrichment receives both', async () => {
  const writes = [], seen = [];
  const load = createCompareResearchLoader({ ...dependencies,
    write: async (_type, id) => { writes.push(id); },
    load: async (ticker, settings) => { seen.push({ ticker, basis: settings.basis, asOf: settings.asOf }); return company; },
  });
  const selections = [selection, { ...selection, basis: 'quarter' },
    { ...selection, asOf: '2025-01-01' }, { ...selection, asOf: '2025-03-01' }];
  const results = await Promise.all(selections.map(value => load(value)));
  assert.equal(new Set(writes).size, 4); assert.deepEqual(seen, selections);
  assert.equal(results[2].payload.periods.length, 0); assert.equal(results[3].payload.metrics.revenue[0].value, 100.125);
});

test('temporarily unavailable source enrichment gets a brief cache lifetime and no stale window', async () => {
  let savedTtl;
  const load = createCompareResearchLoader({ ...dependencies,
    load: async () => ({ ...company, sourceCoverage: { filingFallback: { status: 'unavailable' } } }),
    write: async (_type, _id, _value, ttl) => { savedTtl = ttl; },
  });
  const result = await load(selection);
  assert.equal(savedTtl, 60); assert.match(result.headers['Cache-Control'], /max-age=0, s-maxage=(59|60), must-revalidate/);
  assert.doesNotMatch(result.headers['Cache-Control'], /stale-while-revalidate/);
});

test('shared-cache hit retains original observation date without rewriting or repacking', async () => {
  const payload = { ...resultFor(), observedAt: '2025-02-01T00:00:00.000Z' };
  const serializedPayload = JSON.stringify(payload);
  const load = createCompareResearchLoader({ ...dependencies,
    now: () => Date.parse(payload.observedAt) + 120000,
    preparedRead: async () => assert.fail('A current warm result must not redownload the prepared projection.'),
    read: async () => ({ gzip: gzipSync(serializedPayload).toString('base64') }),
    load: async () => assert.fail('Warm result must not retrieve SEC data.'),
    pack: () => assert.fail('Warm compact data must not be repacked.'),
    write: async () => assert.fail('Reading a cache must not refresh its retention.'),
  });
  const result = await load(selection);
  assert.equal(result.cacheSource, 'warm'); assert.equal(result.serializedPayload, serializedPayload);
  assert.equal(result.payload.observedAt, payload.observedAt);
  assert.equal(result.headers['Cache-Control'], 'public, max-age=60, s-maxage=180, must-revalidate');
  assert.equal(result.headers['X-Data-Expires-At'], '2025-02-01T00:05:00.000Z');
});

test('warm cache reads cannot extend a calculation past its original freshness deadline', async () => {
  for (const offset of [-301000, 120000]) {
    let loads = 0;
    const payload = { ...resultFor(), observedAt: new Date(Date.now() + offset).toISOString() };
    const load = createCompareResearchLoader({ ...dependencies,
      read: async () => ({ gzip: gzipSync(JSON.stringify(payload)).toString('base64') }),
      load: async () => { loads++; return company; },
    });
    assert.equal((await load(selection)).cacheSource, 'upstream'); assert.equal(loads, 1);
  }
  const clock = Date.now(), payload = { ...resultFor(), observedAt: new Date(clock - 299000).toISOString() };
  const load = createCompareResearchLoader({ ...dependencies, now: () => clock,
    read: async () => ({ gzip: gzipSync(JSON.stringify(payload)).toString('base64') }),
  });
  assert.equal((await load(selection)).headers['Cache-Control'], 'public, max-age=1, s-maxage=1, must-revalidate');
});

test('verified share-class aliases preserve the requested label, with exact symbols and CIK validation taking priority', async () => {
  const aliasCompany = { ...company, ticker: 'BRK-B', cik: '0001067983' };
  const lookedUp = [], loaded = [];
  const alias = await loadCompareResearchCompany('BRK.B', { basis: 'annual' }, {
    lookup: async ticker => { lookedUp.push(ticker); return ticker === 'BRK-B' ? { cik: aliasCompany.cik } : null; },
    load: async ticker => { loaded.push(ticker); return aliasCompany; },
  });
  assert.deepEqual(lookedUp, ['BRK.B', 'BRK-B']); assert.deepEqual(loaded, ['BRK-B']);
  assert.equal(alias.ticker, 'BRK.B'); assert.equal(alias.cik, aliasCompany.cik);
  const exact = await loadCompareResearchCompany('BRK.B', {}, {
    lookup: async ticker => { assert.equal(ticker, 'BRK.B'); return { cik: company.cik }; },
    load: async ticker => { assert.equal(ticker, 'BRK.B'); return company; },
  });
  assert.equal(exact.cik, company.cik);
  await assert.rejects(loadCompareResearchCompany('UNKNOWN.A', {}, {
    lookup: async () => null, load: async () => assert.fail('Unknown aliases must not load sources.'),
  }), /No SEC operating company/);
  await assert.rejects(loadCompareResearchCompany('BRK.B', {}, {
    lookup: async () => ({ cik: aliasCompany.cik }), load: async () => company,
  }), /identity changed/);
});

test('corrupt, obsolete, foreign-selection and invalid catalog results fall through to a valid recalculation', async () => {
  for (const modify of [d => { d.ticker = 'OTHER'; }, d => { d.basis = 'quarter'; }, d => { d.asOf = '2024-01-01'; },
    d => { d.version = 'old'; }, d => { delete d.mappingVersion; }, d => { d.packed = false; },
    d => { d.metrics.revenue[0].sourceIds = [d.sourceCatalog.length]; }, d => { d.cik = '0'; }]) {
    let loads = 0;
    const bad = resultFor(); modify(bad);
    const load = createCompareResearchLoader({ ...dependencies,
      read: async () => ({ gzip: gzipSync(JSON.stringify(bad)).toString('base64') }),
      load: async () => { loads++; return company; },
    });
    assert.equal((await load(selection)).cacheSource, 'upstream'); assert.equal(loads, 1);
  }
  const corrupt = createCompareResearchLoader({ ...dependencies, read: async () => ({ gzip: 'corrupt' }) });
  assert.equal((await corrupt(selection)).payload.metrics.revenue[0].value, 100.125);
});

test('optional cache outages do not discard valid calculations; source failure stays explicit', async () => {
  const fail = async () => { throw new Error('Optional cache unavailable'); };
  const load = createCompareResearchLoader({ ...dependencies, read: fail, write: fail });
  assert.equal((await load(selection)).payload.metrics.revenue[0].value, 100.125);
  let attempts = 0;
  const failedSource = createCompareResearchLoader({ ...dependencies,
    load: async () => { if (++attempts === 1) throw new Error('SEC unavailable'); return company; },
  });
  await assert.rejects(failedSource(selection), /SEC unavailable/);
  assert.equal((await failedSource(selection)).payload.metrics.revenue[0].value, 100.125);
});

test('canceling one comparison reader does not cancel another reader of the same source', async () => {
  let release, sourceSignal;
  const load = createCompareResearchLoader({ ...dependencies,
    load: async (_ticker, options) => { sourceSignal = options.signal; return new Promise(resolve => { release = resolve; }); },
  });
  const controller = new AbortController();
  const first = load(selection, controller.signal), second = load(selection);
  await tick(); controller.abort(new Error('Reader left'));
  await assert.rejects(first, /Reader left/); assert.equal(sourceSignal.aborted, false);
  release(company); assert.equal((await second).payload.metrics.revenue[0].value, 100.125);
});

test('distinct in-flight selections are bounded and cancellation of all readers stops source work', async () => {
  const signals = [];
  const load = createCompareResearchLoader({ ...dependencies,
    load: async (_ticker, { signal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const requests = controllers.map((controller, i) => load({ ...selection, ticker: `CO${i}` }, controller.signal));
  await tick();
  await assert.rejects(load({ ...selection, ticker: 'BUSY' }), error => error.status === 503);
  controllers.forEach(controller => controller.abort(new Error('Closed')));
  await Promise.allSettled(requests); await tick();
  assert.equal(signals.length, 8); assert.ok(signals.every(signal => signal.aborted));
});

test('abandoned storage reads count toward capacity and cannot remove a later retry', async () => {
  let releaseOld, releaseSource, preparedReads = 0, loads = 0;
  const load = createCompareResearchLoader({ ...dependencies,
    preparedRead: async () => ++preparedReads === 1 ? new Promise(resolve => { releaseOld = resolve; }) : null,
    load: async () => { loads++; return new Promise(resolve => { releaseSource = resolve; }); },
  });
  const controller = new AbortController();
  const abandoned = load(selection, controller.signal);
  await tick(); controller.abort(new Error('Reader left'));
  await assert.rejects(abandoned, /Reader left/);
  const retry = load(selection); await tick(); assert.equal(loads, 1);
  releaseOld(null); await tick();
  const joined = load(selection); await tick(); assert.equal(preparedReads, 2);
  releaseSource(company);
  const [first, second] = await Promise.all([retry, joined]); assert.equal(first, second);
});

test('completed results are not retained beyond the existing external cache lifetime', async () => {
  let loads = 0;
  const load = createCompareResearchLoader({ ...dependencies, load: async () => { loads++; return company; } });
  await load(selection); await load(selection); assert.equal(loads, 2);
});

test('packed validation rejects malformed metric shapes, values, periods and evidence before decode', () => {
  assert.equal(matchingCompareResult(resultFor(), selection), true);
  for (const modify of [d => { d.metrics.revenue = {}; }, d => { d.metrics.revenue = []; },
    d => { d.metrics.revenue[0].value = '100'; }, d => { d.metrics.revenue[0].calculationIds = [-1]; },
    d => { d.periods[0].end = '2024-02-31'; }, d => { d.sourceCatalog[0].documentUrl = 'https://example.com/filing'; },
    d => { d.sourceCatalog[0].documentUrl = d.sourceCatalog[0].documentUrl.replace('/1234567/', '/886982/'); },
    d => { d.sourceCatalog[0].sourceCik = '0000886982'; },
    d => { d.sourceCatalog[0].documentUrl = d.sourceCatalog[0].documentUrl.replace('000123456725000001', '000123456725000002'); }]) {
    const bad = resultFor(); modify(bad); assert.equal(matchingCompareResult(bad, selection), false);
  }
  const wrongCutoff = resultFor({ ...selection, asOf: '2025-03-01' });
  wrongCutoff.sourceCatalog[0].filed = '2025-03-02';
  assert.equal(matchingCompareResult(wrongCutoff, { ...selection, asOf: '2025-03-01' }), false);
});

test('packed SEC source identity validation retains verified predecessor and joint-filing links', () => {
  const data = resultFor(); data.cik = '0002115436';
  Object.assign(data.sourceCatalog[0], { sourceCik: '0000034088', accession: '0000034088-26-000093' });
  for (const cik of ['34088', '2115436']) {
    data.sourceCatalog[0].documentUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/000003408826000093/xom-20260630.htm`;
    assert.equal(matchingCompareResult(data, selection), true);
  }
});
