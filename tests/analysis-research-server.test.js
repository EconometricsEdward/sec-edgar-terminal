import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createInteractiveAnalysisLoader } from '../src/utils/analysisResearchServer.js';
import { buildAnalysisCompany, packAnalysisCompany, ANALYSIS_VERSION } from '../src/utils/analysisResearch.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const selection = { ticker: 'SMALL', basis: 'annual', asOf: '' };
const company = { ticker: 'SMALL', cik: '0001234567', companyName: 'Financial fixture', sic: '3571',
  facts: { 'us-gaap': { Revenues: { units: { USD: [{ val: 100.125, start: '2024-01-01', end: '2024-12-31',
    fy: 2024, fp: 'FY', form: '10-K', filed: '2025-02-01', accn: '0001234567-25-000001' }] } } } }, filings: [], historyLimited: false };
const resultFor = (settings = selection) => packAnalysisCompany(buildAnalysisCompany({ ...company, ticker: settings.ticker }, settings));
const dependencies = { read: async () => null, write: async () => true, sample: async () => null, load: async () => company };

test('concurrent Analysis requests reuse the full calculation, evidence and one five-minute storage write', async () => {
  let release, loads = 0, builds = 0, writes = 0;
  const load = createInteractiveAnalysisLoader({ ...dependencies,
    load: async () => { loads++; return new Promise(resolve => { release = resolve; }); },
    build: (...args) => { builds++; return buildAnalysisCompany(...args); },
    write: async (type, id, value, ttl) => {
      writes++; assert.equal(type, 'analysis-research'); assert.equal(id, `${ANALYSIS_VERSION}:SMALL:annual:`);
      assert.equal(ttl, 300);
      const saved = JSON.parse(gunzipSync(Buffer.from(value.gzip, 'base64')));
      assert.equal(saved.metrics.revenue[0].value, 100.125);
      assert.equal(saved.sourceCatalog[saved.metrics.revenue[0].sourceIds[0]].accession, '0001234567-25-000001');
      return true;
    },
  });
  const requests = Array.from({ length: 40 }, () => load(selection));
  await tick(); release(company);
  const responses = await Promise.all(requests);
  assert.equal(loads, 1); assert.equal(builds, 1); assert.equal(writes, 1);
  assert.ok(responses.every(value => value === responses[0]));
  assert.equal(responses[0].serializedPayload, JSON.stringify(responses[0].payload));
});

test('bases and filing cutoffs have distinct work and cache identities', async () => {
  const writes = [];
  const load = createInteractiveAnalysisLoader({ ...dependencies, write: async (_type, id) => { writes.push(id); } });
  const selections = [selection, { ...selection, basis: 'quarter' },
    { ...selection, asOf: '2025-01-01' }, { ...selection, asOf: '2025-03-01' }];
  const results = await Promise.all(selections.map(value => load(value)));
  assert.equal(new Set(writes).size, 4);
  for (const [index, response] of results.entries()) {
    assert.equal(response.payload.basis, selections[index].basis);
    assert.equal(response.payload.asOf || '', selections[index].asOf);
  }
  assert.equal(results[2].payload.periods.length, 0);
  assert.equal(results[3].payload.metrics.revenue[0].value, 100.125);
});

test('a shared-cache response retains its original calculation timestamp and is not rewritten', async () => {
  const payload = { ...resultFor(), observedAt: '2025-02-01T00:00:00.000Z' };
  const load = createInteractiveAnalysisLoader({ ...dependencies,
    read: async () => ({ gzip: gzipSync(JSON.stringify(payload)).toString('base64') }),
    load: async () => assert.fail('A cache hit must not retrieve SEC sources.'),
    write: async () => assert.fail('A cache hit must not extend retention.'),
  });
  const response = await load(selection);
  assert.equal(response.cacheSource, 'warm'); assert.deepEqual(response.payload, JSON.parse(JSON.stringify(payload)));
});

test('corrupt or mismatched cached selections never serve another company, basis, cutoff or calculator', async () => {
  for (const changes of [{ ticker: 'OTHER' }, { basis: 'quarter' }, { asOf: '2024-01-01' }, { version: 'old' }, { packed: false }]) {
    let loads = 0;
    const load = createInteractiveAnalysisLoader({ ...dependencies,
      read: async () => ({ gzip: gzipSync(JSON.stringify({ ...resultFor(), ...changes })).toString('base64') }),
      load: async () => { loads++; return company; },
    });
    assert.equal((await load(selection)).cacheSource, 'upstream'); assert.equal(loads, 1);
  }
  const load = createInteractiveAnalysisLoader({ ...dependencies, read: async () => ({ gzip: 'corrupt' }) });
  assert.equal((await load(selection)).payload.metrics.revenue[0].value, 100.125);
});

test('optional cache and shadow failures do not discard valid calculations; source failures still fail', async () => {
  const fail = async () => { throw new Error('optional service unavailable'); };
  const load = createInteractiveAnalysisLoader({ ...dependencies, read: fail, write: fail, sample: fail });
  assert.equal((await load(selection)).payload.metrics.revenue[0].value, 100.125);
  let attempts = 0;
  const failedSource = createInteractiveAnalysisLoader({ ...dependencies,
    load: async () => { if (++attempts === 1) throw new Error('SEC unavailable'); return company; },
  });
  await assert.rejects(failedSource(selection), /SEC unavailable/);
  assert.equal((await failedSource(selection)).payload.metrics.revenue[0].value, 100.125);
});

test('canceling one Analysis reader preserves the shared load for remaining readers', async () => {
  let release, sourceSignal;
  const load = createInteractiveAnalysisLoader({ ...dependencies,
    load: async (_ticker, options) => { sourceSignal = options.signal; return new Promise(resolve => { release = resolve; }); },
  });
  const controller = new AbortController();
  const first = load(selection, controller.signal), second = load(selection);
  await tick(); controller.abort(new Error('reader left'));
  await assert.rejects(first, /reader left/); assert.equal(sourceSignal.aborted, false);
  release(company); assert.equal((await second).payload.metrics.revenue[0].value, 100.125);
});

test('distinct in-flight selections are bounded and canceling all readers stops source work', async () => {
  const signals = [];
  const load = createInteractiveAnalysisLoader({ ...dependencies,
    load: async (_ticker, { signal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const requests = controllers.map((controller, i) => load({ ...selection, ticker: `CO${i}` }, controller.signal));
  await tick();
  await assert.rejects(load({ ...selection, ticker: 'BUSY' }), error => error.status === 503);
  controllers.forEach(controller => controller.abort(new Error('closed')));
  await Promise.allSettled(requests); await tick();
  assert.equal(signals.length, 8); assert.ok(signals.every(signal => signal.aborted));
});

test('completed results are not retained past the existing shared-cache lifetime', async () => {
  let loads = 0;
  const load = createInteractiveAnalysisLoader({ ...dependencies, load: async () => { loads++; return company; } });
  await load(selection); await load(selection); assert.equal(loads, 2);
});

test('an immediate retry survives abandoned cache work and its eventual cleanup', async () => {
  let releaseOldRead, releaseSource, reads = 0, loads = 0;
  const load = createInteractiveAnalysisLoader({ ...dependencies,
    read: async () => ++reads === 1 ? new Promise(resolve => { releaseOldRead = resolve; }) : null,
    load: async () => { loads++; return new Promise(resolve => { releaseSource = resolve; }); },
  });
  const controller = new AbortController();
  const abandoned = load(selection, controller.signal);
  await tick(); controller.abort(new Error('reader left'));
  await assert.rejects(abandoned, /reader left/);
  const retry = load(selection);
  await tick(); assert.equal(loads, 1);
  releaseOldRead(null); await tick();
  const joinedRetry = load(selection);
  await tick(); assert.equal(reads, 2); assert.equal(loads, 1);
  releaseSource(company);
  const [first, second] = await Promise.all([retry, joinedRetry]);
  assert.equal(first, second); assert.equal(first.payload.metrics.revenue[0].value, 100.125);
});

test('abandoned unresolved reads still count against the eight-task bound until they settle', async () => {
  const releases = []; let reads = 0;
  const load = createInteractiveAnalysisLoader({ ...dependencies,
    read: async () => ++reads <= 8 ? new Promise(resolve => releases.push(resolve)) : null,
  });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const requests = controllers.map((controller, i) => load({ ...selection, ticker: `CO${i}` }, controller.signal));
  await tick(); controllers.forEach(controller => controller.abort(new Error('closed')));
  await Promise.allSettled(requests);
  await assert.rejects(load(selection), error => error.status === 503);
  assert.equal(reads, 8);
  releases.forEach(resolve => resolve(null)); await tick();
  assert.equal((await load(selection)).payload.metrics.revenue[0].value, 100.125);
});
