#!/usr/bin/env node
/**
 * Local HTTP serving-helper rehearsal using real saved public payloads and an
 * injected Data API/Storage fixture. This is NOT a full Next/Vercel/Supabase
 * capacity test. No public upstream, production credentials, or writes occur.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createDataStore, stableDataStoreJson, dataStoreContentHash, DATA_STORE_LIMITS } from '../src/utils/dataStore.js';
import { prepareFinancialCompany, readPreparedAnalysis, financialPreparedKey, FINANCIAL_PREPARED_BASES } from '../src/utils/preparedFinancialData.js';
import { SEC_MIGRATION_COHORT, secDocumentIdentity, readPreparedSecDocument } from '../src/utils/secDocumentStore.js';
import { createCftcPersistence } from '../src/utils/cftcPersistence.js';
import { loadFreshPortfolioCompany, runPortfolioResearch } from '../src/utils/portfolioResearchServer.js';

const args = process.argv.slice(2);
if (args.includes('--help') || !args.length) {
  console.log('node scripts/data-migration-load.mjs --samples=/absolute/public-samples [--prepared=/absolute/financial-prepared-snapshots.json] [--out=/absolute/result.json] [--max-concurrency=50] [--latency-ms=20] [--driver=shared|worker] [--workload=stress|representative]\nUses saved audit samples; no external network. Tests 5/10/25/50 local concurrent clients (10 requests each) with Analysis hot-cache and forced prepared-miss modes. Data API/Storage delays are injected assumptions, not measured Supabase latency. Shared driver and stress workload are comparable to the original rehearsal. Representative uses the actual compact portfolio helper with prepared company cache fixtures; worker isolates client parsing/network work onto another thread.');
  process.exit(0);
}
const options = {};
for (const arg of args) {
  const match = /^--(samples|prepared|out|max-concurrency|latency-ms|driver|workload)=(.+)$/.exec(arg);
  if (!match || Object.hasOwn(options, match[1])) throw new Error('Unknown or repeated load option.');
  options[match[1]] = match[2];
}
for (const field of ['samples', 'prepared', 'out']) if (options[field] && !isAbsolute(options[field])) throw new Error('Fixture and output paths must be absolute.');
if (!options.samples) throw new Error('Provide --samples from the bounded audit.');
const maximumConcurrency = Number(options['max-concurrency'] || 50);
const latencyMs = Number(options['latency-ms'] || 20);
const driver = options.driver || 'shared';
if (!['shared', 'worker'].includes(driver)) throw new Error('Invalid driver mode.');
const workload = options.workload || 'stress';
if (!['stress', 'representative'].includes(workload)) throw new Error('Invalid workload.');
if (![5, 10, 25, 50].includes(maximumConcurrency) || !Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > 250) throw new Error('Invalid concurrency or fixture latency.');
const startedAt = new Date().toISOString();
const nativeFetch = globalThis.fetch;
let blockedUpstreamAttempts = 0;
globalThis.fetch = async () => { blockedUpstreamAttempts++; throw new Error('External transport is blocked in the local load rehearsal.'); };
const expiresAt = new Date(Date.now() + 3600000).toISOString();
const fixtures = new Map();
const objects = new Map();
const sourceEnvelopes = new Map();
const hotValues = new Map();
let fault = null;
let cacheMode = 'warm';
let counters;
const resetCounters = () => { counters = { dataApiReads: 0, objectReads: 0, fixtureResponseBytes: 0, hotReads: 0, hotHits: 0, hotWrites: 0 }; };
resetCounters();

async function sample(filename, maximum = 32 * 1024 * 1024) {
  const path = resolve(options.samples, filename);
  if ((await stat(path)).size > maximum) throw new Error('Saved sample is larger than the allowed fixture bound.');
  return readFile(path);
}
function install(dataset, key, payload, metadata, rawSource = null) {
  const bytes = rawSource || Buffer.from(stableDataStoreJson(payload));
  const contentHash = dataStoreContentHash(bytes);
  const base = { id: `${dataset}-${fixtures.size}`, contentHash, identityHash: contentHash, generation: 1, metadata: { ...metadata, expiresAt }, rawBytes: bytes.length, storedBytes: bytes.length };
  if (rawSource || bytes.length > DATA_STORE_LIMITS.compactBytes - 2048) {
    const objectPath = `fixture/${dataset}/snapshot/${contentHash}.json.gz`;
    const zipped = gzipSync(bytes, { level: 6 });
    objects.set(`/storage/v1/object/authenticated/edgar-durable-private/${objectPath}`, zipped);
    fixtures.set(`${dataset}:${key}`, { ...base, objectPath, storedBytes: zipped.length, payload: null });
  } else fixtures.set(`${dataset}:${key}`, { ...base, payload });
}

for (const company of SEC_MIGRATION_COHORT) {
  for (const resource of ['submissions', 'companyfacts']) {
    const raw = await sample(`${company.ticker.toLowerCase()}-${resource}.json`);
    const payload = JSON.parse(raw.toString('utf8'));
    if (Number(payload.cik) !== Number(company.cik)) throw new Error('SEC fixture identity mismatch.');
    const path = resource === 'submissions' ? `/submissions/CIK${company.cik}.json` : `/api/xbrl/companyfacts/CIK${company.cik}.json`;
    const identity = secDocumentIdentity(path);
    // Expiry/revalidation are explicitly fixture clock settings. Source content
    // and reporting/filing dates inside the captured document are untouched.
    const metadata = { fetchedAt: startedAt, revalidatedAt: startedAt, expiresAt, documentContentHash: dataStoreContentHash(raw), fixtureClock: true };
    const envelope = { payload, metadata };
    sourceEnvelopes.set(identity.key, envelope);
    install('sec', identity.key, payload, metadata, raw);
  }
}
if (options.prepared) {
  if ((await stat(options.prepared)).size > 32 * 1024 * 1024) throw new Error('Prepared fixture file too large.');
  const values = JSON.parse(await readFile(options.prepared, 'utf8'));
  if (!Array.isArray(values) || values.length !== 16) throw new Error('Require the four-company/four-basis prepared cohort.');
  for (const value of values) install('financial', value.key, value.payload, value.metadata);
} else {
  for (const company of SEC_MIGRATION_COHORT) {
    await prepareFinancialCompany(company.ticker, {
      mode: 'shadow', read: async (dataset, key) => dataset === 'sec' ? sourceEnvelopes.get(key) : null,
      begin: async () => ({ generation: 1 }), legacyWrite: async () => true,
      reserveLegacy: async () => true, release: async () => true,
      publish: async value => { install('financial', value.key, value.payload, value.metadata); },
    });
  }
}
const cftcResponses = await Promise.all([0, 1, 2].map(async index => JSON.parse((await sample(`cftc-${index}.json`, 4 * 1024 * 1024)).toString('utf8'))));
let replayNow = 0;
for (const [index, response] of cftcResponses.entries()) {
  if (response.status !== 'ready' || response.schema_version !== 'edgar.cftc-positioning.v1') throw new Error('CFTC fixture must be a validated ready response.');
  const savedAt = response.retrieved_at || response.freshness?.retrieved_at;
  if (!Number.isFinite(Date.parse(savedAt))) throw new Error('CFTC fixture retrieval time missing.');
  replayNow = Math.max(replayNow, Date.parse(savedAt));
  const key = index === 0 ? 'markets:tff:latest' : index === 1 ? 'markets:disaggregated:latest' : 'history:tff:13874A:leveraged-funds:latest:1y';
  install('cftc', key, { savedAt, response }, { fetchedAt: savedAt, expiresAt });
}
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
const store = createDataStore({
  env: { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'local-fixture-only', EDGAR_DATASTORE_NAMESPACE: 'fixture', EDGAR_DATASTORE_SEC: 'supabase', EDGAR_DATASTORE_FINANCIAL: 'supabase', EDGAR_DATASTORE_CFTC: 'supabase' },
  fetchImpl: async (input, init) => {
    const url = new URL(input);
    if (url.origin !== 'http://127.0.0.1:54321') throw new Error('Unexpected fixture origin.');
    await wait(latencyMs);
    if (fault === 'database') return Response.json({ code: 'FIXTURE_OUTAGE' }, { status: 503 });
    let bytes;
    if (url.pathname === '/rest/v1/rpc/edgar_get_version' && init.method === 'POST') {
      counters.dataApiReads++;
      const body = JSON.parse(init.body);
      const row = fault === 'missing' ? null : fixtures.get(`${body.p_dataset}:${body.p_key}`) || null;
      bytes = Buffer.from(JSON.stringify(row));
      counters.fixtureResponseBytes += bytes.length;
      return new Response(bytes, { headers: { 'Content-Type': 'application/json' } });
    }
    if (init.method === 'GET' && objects.has(url.pathname)) {
      counters.objectReads++;
      if (fault === 'storage') return Response.json({ code: 'FIXTURE_OUTAGE' }, { status: 503 });
      bytes = objects.get(url.pathname);
      counters.fixtureResponseBytes += bytes.length;
      return new Response(bytes, { headers: { 'Content-Type': 'application/gzip' } });
    }
    throw new Error('The fixture permits only version reads and known object reads.');
  },
});
const cftc = createCftcPersistence({ mode: () => 'supabase', read: store.readDataset, now: () => replayNow });
const hotRead = async (_namespace, key) => {
  counters.hotReads++;
  if (fault === 'redis') throw new Error('Injected Redis failure.');
  if (cacheMode === 'prepared-miss') return null;
  const value = hotValues.get(key) || null;
  if (value) counters.hotHits++;
  return value;
};
const analysis = (ticker, basis) => readPreparedAnalysis({ ticker, basis }, { mode: 'supabase', read: store.readDataset, hotRead });
const portfolioCompanies = new Map(), portfolioDirectory = {};
if (workload === 'representative') for (const company of SEC_MIGRATION_COHORT) {
  const submissions = sourceEnvelopes.get(secDocumentIdentity(`/submissions/CIK${company.cik}.json`).key).payload;
  const identity = { ticker: company.ticker, cik: company.cik, name: submissions.name };
  portfolioDirectory[company.ticker] = identity;
  for (const basis of ['annual', 'quarter']) {
    // The production company-cache value is built with its actual source/metric
    // helper, including complete provenance. Preparation is outside serving load.
    const result = await loadFreshPortfolioCompany(identity, basis, { secJson: async path => {
      const source = sourceEnvelopes.get(secDocumentIdentity(path)?.key);
      if (!source) throw new Error('Missing bounded portfolio fixture source.');
      return source.payload;
    } });
    if (result.factsUnavailable || !['ready', 'partial'].includes(result.status)) throw new Error('Portfolio fixture preparation failed.');
    portfolioCompanies.set(`${company.cik}:${basis}`, result);
  }
}
const paths = [
  '/cftc/markets?family=tff', '/cftc/markets?family=disaggregated', '/cftc/history',
  ...FINANCIAL_PREPARED_BASES.map(basis => `/analysis?basis=${basis}`),
  '/sec/submissions', ...['annual', 'quarter'].map(basis => `${workload === 'stress' ? '/portfolio-fanout' : '/portfolio'}?basis=${basis}`),
];
let serviceSamples = [];
const server = createServer(async (request, response) => {
  const serviceStarted = performance.now();
  let route;
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    route = url.pathname;
    const ticker = url.searchParams.get('ticker') || 'AAPL';
    const company = SEC_MIGRATION_COHORT.find(item => item.ticker === ticker);
    if (!company) throw Object.assign(new Error('Unknown fixture issuer.'), { status: 400 });
    let payload, serializedPayload;
    if (url.pathname === '/analysis') {
      const result = await analysis(ticker, url.searchParams.get('basis') || 'annual');
      payload = result?.payload; serializedPayload = result?.serializedPayload;
    }
    else if (url.pathname === '/sec/submissions') payload = (await readPreparedSecDocument(`/submissions/CIK${company.cik}.json`, { mode: 'supabase', read: store.readDataset }))?.payload;
    else if (url.pathname === '/sec/companyfacts') payload = (await readPreparedSecDocument(`/api/xbrl/companyfacts/CIK${company.cik}.json`, { mode: 'supabase', read: store.readDataset }))?.payload;
    else if (url.pathname === '/portfolio' && workload === 'representative') {
      payload = await runPortfolioResearch({ schema_version: 'edgar.portfolio.v1',
        holdings: ['AAPL', 'MSFT', 'AAPL', 'JPM', 'ACU'].map(ticker => ({ ticker })),
        allocation: { basis: 'none', normalize: false }, research: { basis: url.searchParams.get('basis') || 'annual' },
      }, { directory: portfolioDirectory, loadCompany: async (identity, basis) => {
        const result = portfolioCompanies.get(`${identity.cik}:${basis}`);
        if (!result) throw new Error('Missing prepared portfolio company.');
        return { ...result, cache: { status: 'cached', storedAt: result.retrievedAt } };
      } });
      if (payload.coverage.researchedIssuers !== 4 || payload.coverage.failed) throw new Error('Portfolio fixture returned incomplete coverage.');
    }
    else if (url.pathname === '/portfolio-fanout') {
      // Simulated repeated-company fan-out: five reads, including duplicate AAPL.
      // This is not the production portfolio handler, and does not invent a new
      // batching optimization that the deployed portfolio path does not have.
      const names = ['AAPL', 'MSFT', 'AAPL', 'JPM', 'ACU'];
      payload = await Promise.all(names.map(async name => (await analysis(name, url.searchParams.get('basis') || 'annual'))?.payload));
    } else if (url.pathname.startsWith('/cftc/')) {
      const key = url.pathname === '/cftc/history' ? 'history:tff:13874A:leveraged-funds:latest:1y' : `markets:${url.searchParams.get('family') || 'tff'}:latest`;
      payload = (await cftc.prepared(key, { validate: value => value.response?.status === 'ready' && value.response?.schema_version === 'edgar.cftc-positioning.v1' }))?.response;
    } else throw Object.assign(new Error('Unknown harness route.'), { status: 404 });
    if (!payload) throw Object.assign(new Error('Prepared fixture unavailable.'), { status: 503 });
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
    // Match the actual Analysis route's verified prepared JSON response path.
    // The synthetic portfolio stress response still serializes its five complete
    // objects, since there is no corresponding production route optimization.
    response.end(serializedPayload || JSON.stringify(payload));
  } catch (error) {
    response.writeHead(error.status || 500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'unavailable' }));
  } finally {
    serviceSamples.push({ path: route, elapsedMs: performance.now() - serviceStarted });
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = `http://127.0.0.1:${server.address().port}`;
const report = {
  kind: 'local-http-serving-helper-fixture-rehearsal', startedAt,
  assumptions: { fixtureRoundTripDelayMs: latencyMs, hotCacheDelayMs: 0, requestsPerSimulatedUser: 10, maximumConcurrency, driver, workload, responseCompression: 'none on local HTTP', publicUpstreams: 'blocked', fixtureExpiry: expiresAt },
  limitations: ['Not production Next.js route/UI execution, Vercel/CDN latency, real Supabase/RLS capacity, real Redis latency, or a 1000-user capacity guarantee.', 'Warm means Analysis hot cache; CFTC and SEC still read durable manifests. Prepared miss means Analysis hot-cache miss with prepared durable data available; verified immutable content can be reused in process.', 'Portfolio route deliberately stresses five full prepared Analysis responses including one duplicate; it is not the compact production portfolio response and does not claim production portfolio migration.', 'Data API/Storage delays and freshness clock are injected. Sample financial/report dates and full response sizes are retained.', `Load driver and HTTP server share one process ${driver === 'worker' ? 'with separate event-loop threads' : 'and one event-loop thread'}; loopback response bytes do not measure external service egress.`, 'Memory is process RSS including fixture data, caches, client buffers and any driver worker; cache limits count decoded JSON input bytes, not JavaScript object heap.'],
  stages: [], coldStartProbes: [], faultProbes: [],
};
if (workload === 'representative') {
  report.limitations[2] = 'Portfolio uses the actual runPortfolioResearch helper and full compact output, with current per-company cache fixtures built by loadFreshPortfolioCompany from saved SEC sources. This measures prepared cache hits, not cold portfolio recalculation, network cache misses, or Supabase portfolio persistence.';
  report.portfolioFixtures = [...portfolioCompanies].map(([key, value]) => ({ key, bytes: Buffer.byteLength(JSON.stringify(value)), status: value.status }));
}
function percentile(values, fraction) {
  if (!values.length) return null;
  return Math.round([...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]);
}
async function requestPath(path, ticker = 'AAPL') {
  const start = performance.now();
  const response = await nativeFetch(`${address}${path}${path.includes('?') ? '&' : '?'}ticker=${ticker}`, { signal: AbortSignal.timeout(15000) });
  const bytes = (await response.arrayBuffer()).byteLength;
  return { path: path.split('?')[0], elapsedMs: performance.now() - start, status: response.status, bytes };
}
async function runLoad(concurrency) {
  if (driver === 'worker') {
    // Driver has only a loopback fixture address; it cannot use public sources.
    const worker = new Worker(`
      const { parentPort, workerData: data } = require('node:worker_threads');
      (async () => {
        const samples = [];
        const origin = new URL(data.address).origin;
        if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Non-local driver origin.');
        await Promise.all(Array.from({ length: data.concurrency }, async (_, user) => {
          for (let page = 0; page < data.paths.length; page++) {
            const path = data.paths[(page + user) % data.paths.length];
            const ticker = data.tickers[user % data.tickers.length];
            const started = performance.now();
            try {
              const url = new URL(path + (path.includes('?') ? '&' : '?') + 'ticker=' + ticker, origin);
              if (url.origin !== origin) throw new Error('Driver origin mismatch.');
              const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
              const bytes = (await response.arrayBuffer()).byteLength;
              samples.push({ path: path.split('?')[0], elapsedMs: performance.now() - started, status: response.status, bytes });
            } catch { samples.push({ path: path.split('?')[0], elapsedMs: performance.now() - started, status: 0, bytes: 0 }); }
          }
        }));
        parentPort.postMessage(samples);
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { address, concurrency, paths, tickers: SEC_MIGRATION_COHORT.map(value => value.ticker) } });
    try { return (await once(worker, 'message'))[0]; }
    finally { await worker.terminate(); }
  }
  const samples = [];
  await Promise.all(Array.from({ length: concurrency }, async (_, user) => {
    for (let page = 0; page < paths.length; page++) {
      const path = paths[(page + user) % paths.length];
      const ticker = SEC_MIGRATION_COHORT[user % SEC_MIGRATION_COHORT.length].ticker;
      const started = performance.now();
      try { samples.push(await requestPath(path, ticker)); }
      catch { samples.push({ path: path.split('?')[0], elapsedMs: performance.now() - started, status: 0, bytes: 0 }); }
    }
  }));
  return samples;
}
try {
  cacheMode = 'prepared-miss';
  for (const path of ['/analysis?basis=ttm', '/sec/companyfacts']) {
    resetCounters();
    const probe = await requestPath(path);
    report.coldStartProbes.push({ ...probe, elapsedMs: Math.round(probe.elapsedMs), counters: { ...counters },
      limitation: 'Single cold immutable-content request with injected dependency latency; not a concurrent serverless cold-start test.' });
  }
  for (const mode of ['warm', 'prepared-miss']) {
    cacheMode = mode;
    if (mode === 'warm') for (const company of SEC_MIGRATION_COHORT) for (const basis of FINANCIAL_PREPARED_BASES) {
      const prepared = await store.readDataset('financial', financialPreparedKey(company.ticker, basis));
      if (!prepared) throw new Error('Prepared financial cohort incomplete.');
      hotValues.set(`${prepared.payload.version}:${company.ticker}:${basis}:`, {
        gzip: gzipSync(JSON.stringify(prepared.payload)).toString('base64'), metadata: prepared.metadata, stale: false,
      });
    }
    for (const concurrency of [5, 10, 25, 50].filter(value => value <= maximumConcurrency)) {
      resetCounters();
      const start = performance.now();
      serviceSamples = [];
      const cpuStart = process.cpuUsage();
      const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
      const samples = await runLoad(concurrency);
      loop.disable();
      const cpu = process.cpuUsage(cpuStart);
      const errors = samples.filter(value => value.status !== 200).length;
      const p95Ms = percentile(samples.map(value => value.elapsedMs), 0.95);
      const byRoute = Object.fromEntries([...new Set(samples.map(value => value.path))].map(path => {
        const subset = samples.filter(value => value.path === path);
        return [path, { requests: subset.length, p95Ms: percentile(subset.map(value => value.elapsedMs), 0.95), serverP95Ms: percentile(serviceSamples.filter(value => value.path === path).map(value => value.elapsedMs), 0.95), errors: subset.filter(value => value.status !== 200).length, responseBytes: subset.reduce((sum, value) => sum + value.bytes, 0) }];
      }));
      const stage = { mode, concurrency, requests: samples.length, elapsedMs: Math.round(performance.now() - start), p50Ms: percentile(samples.map(value => value.elapsedMs), 0.5), p95Ms, serverP95Ms: percentile(serviceSamples.map(value => value.elapsedMs), 0.95), eventLoopP95Ms: Math.round(loop.percentile(95) / 1e6), cpuMs: Math.round((cpu.user + cpu.system) / 1000), errors, errorRate: errors / samples.length, responseBytes: samples.reduce((sum, value) => sum + value.bytes, 0), rssMiB: Math.round(process.memoryUsage().rss / 1048576), counters: { ...counters }, byRoute, proposedLatencyTargetMs: mode === 'warm' ? 750 : 2000 };
      stage.meetsProposedFixtureTargets = p95Ms < stage.proposedLatencyTargetMs && stage.errorRate < 0.01;
      report.stages.push(stage);
      console.log(JSON.stringify({ mode, concurrency, p95Ms, errors, requests: stage.requests, rssMiB: stage.rssMiB }));
      if (stage.rssMiB > 1200 || p95Ms > 5000 || stage.errorRate > 0.1) { report.stoppedEarly = 'Memory, latency or error guard reached.'; break; }
    }
    if (report.stoppedEarly) break;
  }
  cacheMode = 'prepared-miss';
  // Establish one known verified content hit; no metadata is cached. A cold
  // source document has never been requested by the measured serving workload.
  fault = null;
  await requestPath('/analysis?basis=annual');
  for (const { injected, dependency, path, expectedStatus } of [
    { injected: 'redis', dependency: 'redis', path: '/analysis?basis=annual', expectedStatus: 200 },
    { injected: 'storage-verified-content-hit', dependency: 'storage', path: '/analysis?basis=annual', expectedStatus: 200 },
    { injected: 'storage-cold-content', dependency: 'storage', path: '/sec/companyfacts', expectedStatus: 503 },
    { injected: 'database', dependency: 'database', path: '/analysis?basis=annual', expectedStatus: 503 },
    { injected: 'missing', dependency: 'missing', path: '/analysis?basis=annual', expectedStatus: 503 },
  ]) {
    fault = dependency;
    const probe = await requestPath(path, injected === 'storage-cold-content' ? 'MSFT' : 'AAPL');
    report.faultProbes.push({ injected, expectedStatus, status: probe.status, passed: probe.status === expectedStatus });
  }
  fault = null;
  report.blockedUpstreamAttempts = blockedUpstreamAttempts;
  report.finishedAt = new Date().toISOString();
  if (options.out) await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ kind: report.kind, stages: report.stages.length, blockedUpstreamAttempts, faultProbes: report.faultProbes, stoppedEarly: report.stoppedEarly || null }));
} finally {
  globalThis.fetch = nativeFetch;
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
}
