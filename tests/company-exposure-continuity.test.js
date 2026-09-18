import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCompanyExposures, restoreCompanyExposureSnapshot, createCompanyExposureLoader } from '../src/utils/companyExposureServer.js';
import { createCompanyExposureRevisionCache } from '../src/utils/companyExposureRevisionCache.js';

const currentCik = '0002115436', predecessorCik = '0000034088', now = new Date('2026-09-18T12:00:00Z');
const selection = { ticker: 'XOM', asOf: null };
const annual = { accession: '0000034088-26-000010', form: '10-K', filed: '2026-02-20', reportDate: '2025-12-31', primaryDoc: 'annual.htm' };
const quarter = { accession: '0000034088-26-000093', form: '10-Q', filed: '2026-08-03', reportDate: '2026-06-30', primaryDoc: 'quarter.htm' };
const text = 'Our crude oil production revenue is exposed to changes in WTI prices and customer demand.';
const rows = filings => Object.fromEntries(Object.entries({ accessionNumber: 'accession', form: 'form', filingDate: 'filed', reportDate: 'reportDate', primaryDocument: 'primaryDoc' })
  .map(([field, key]) => [field, filings.map(filing => filing[key])]));
const manifest = (cik, filings, files = []) => ({ cik, name: 'Exxon Mobil Corporation', filings: { recent: rows(filings), files } });
const noopRevisions = { document: async () => null, saveDocument: async () => {}, extraction: async () => null, saveExtraction: async () => {} };
const setup = overrides => ({ now, revisionCache: noopRevisions,
  lookupTicker: async () => ({ cik: currentCik, name: 'Exxon Mobil Corporation' }),
  loadSubmissions: async file => file === `CIK${currentCik}.json` ? manifest(currentCik, [quarter]) : manifest(predecessorCik, [annual]),
  loadFilingText: async () => ({ text }), ...overrides });

test('reviewed predecessor annual keeps its SEC identity beside the current registrant quarterly source', async () => {
  const requests = []; let snapshot;
  const result = await discoverCompanyExposures(selection, setup({
    loadFilingText: async (cik, filing) => { requests.push([cik, filing.role, filing.url]); return { text }; },
    onSnapshot: value => { snapshot = value; },
  }));
  assert.equal(result.status, 'ready'); assert.equal(result.cik, currentCik);
  assert.deepEqual(result.sources.map(source => [source.role, source.sourceCik]), [['annual', predecessorCik], ['quarterly', undefined]]);
  assert.deepEqual(requests.map(item => item[0]), [predecessorCik, currentCik]);
  assert.match(result.sources[0].url, /\/data\/34088\//); assert.match(result.sources[1].url, /\/data\/2115436\//);
  assert.equal(result.coverage.continuity.status, 'applied');
  assert.equal(result.coverage.continuity.evidenceFiled, '2026-08-03');
  assert.ok(result.rows.some(row => row.evidence.some(source => source.role === 'annual' && source.sourceCik === predecessorCik)));
  const restored = restoreCompanyExposureSnapshot(snapshot, selection, now);
  assert.deepEqual(restored.rows, result.rows); assert.deepEqual(restored.coverage.continuity, result.coverage.continuity);
  const tampered = structuredClone(snapshot); tampered.sources[0].sourceCik = '0000000001';
  assert.equal(restoreCompanyExposureSnapshot(tampered, selection, now), null);
});

test('historical cutoff cannot use future continuity evidence or current-period filings', async () => {
  const requests = [];
  const result = await discoverCompanyExposures({ ...selection, asOf: '2026-08-02' }, setup({
    loadSubmissions: async file => { requests.push(file); return manifest(currentCik, [quarter]); },
    loadFilingText: async () => assert.fail('No current filing or predecessor link was eligible by this cutoff.'),
  }));
  assert.equal(result.status, 'no_filing'); assert.deepEqual(requests, [`CIK${currentCik}.json`]);
  assert.equal(result.coverage.continuity, undefined); assert.deepEqual(result.sources, []);
});

test('predecessor identity mismatch or failed history produces explicit retryable partial evidence and no snapshot', async () => {
  for (const prior of [async () => { throw new Error('SEC timeout'); }, async () => manifest('0000000001', [annual]),
    async () => manifest(predecessorCik, [{ ...annual, reportDate: '2026-07-01', filed: '2026-08-01' }])]) {
    let snapshots = 0;
    const result = await discoverCompanyExposures(selection, setup({
      loadSubmissions: async file => file === `CIK${currentCik}.json` ? manifest(currentCik, [quarter]) : prior(),
      onSnapshot: () => { snapshots++; },
    }));
    assert.equal(result.status, 'partial'); assert.equal(result.retryable, true); assert.equal(result.coverage.searchComplete, false);
    assert.equal(result.coverage.continuity.status, 'partial'); assert.equal(result.coverage.historyFailures.length, 1);
    assert.equal(result.sources.length, 1); assert.equal(result.sources[0].role, 'quarterly'); assert.equal(snapshots, 0);
    assert.ok(result.rows.every(row => row.evidence.every(source => source.sourceCik === undefined)));
  }
});

test('a current annual and any unreviewed issuer avoid predecessor transport entirely', async () => {
  for (const cik of [currentCik, '0000001234']) {
    const requests = [];
    const result = await discoverCompanyExposures({ cik }, setup({ loadSubmissions: async file => {
      requests.push(file); return manifest(cik, [{ ...annual, accession: '0000001234-26-000001' }, quarter]);
    } }));
    assert.equal(result.status, 'ready'); assert.deepEqual(requests, [`CIK${cik}.json`]);
    assert.equal(result.coverage.continuity, undefined); assert.ok(result.sources.every(source => source.sourceCik === undefined));
  }
});

test('predecessor manifest archives share the existing two-file request budget', async () => {
  const files = [1, 2, 3].map(index => ({ name: `CIK${predecessorCik}-submissions-00${index}.json`, filingFrom: '2020-01-01', filingTo: '2025-12-31' }));
  const fetched = [];
  const result = await discoverCompanyExposures(selection, setup({ loadSubmissions: async file => {
    fetched.push(file);
    if (file === `CIK${currentCik}.json`) return manifest(currentCik, [quarter]);
    if (file === `CIK${predecessorCik}.json`) return manifest(predecessorCik, [], files);
    return rows([]);
  } }));
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.historyFilesScanned, 2);
  assert.equal(result.coverage.historyLimited, true); assert.ok(!fetched.includes(files[2].name));
});

test('verified predecessor document and extraction revisions can be reused after fresh manifest checks', async () => {
  const store = new Map(); let downloads = 0, manifests = 0;
  const revisionCache = createCompanyExposureRevisionCache({ enabled: () => true, now: () => now.getTime(),
    read: async (type, key) => ({ payload: store.get(`${type}:${key}`) }),
    write: async (type, key, value) => { store.set(`${type}:${key}`, value); },
  });
  const dependencies = setup({ revisionCache,
    loadSubmissions: async file => { manifests++; return file === `CIK${currentCik}.json` ? manifest(currentCik, [quarter]) : manifest(predecessorCik, [annual]); },
    loadFilingText: async () => { downloads++; return { text }; },
  });
  const first = await discoverCompanyExposures(selection, dependencies);
  const second = await discoverCompanyExposures(selection, dependencies);
  assert.equal(first.status, 'ready'); assert.equal(second.status, 'ready'); assert.equal(manifests, 4); assert.equal(downloads, 2);
  assert.deepEqual(second.rows, first.rows);
});

test('partial predecessor discovery is not retained by the source loader and retries the missing source', async () => {
  let discoveries = 0, writes = 0;
  const load = createCompanyExposureLoader({ enabled: () => true, now: () => now.getTime(), revisionCache: noopRevisions,
    read: async () => null, write: async () => { writes++; },
    discover: async checked => { discoveries++; return discoverCompanyExposures(checked, setup({ loadSubmissions: async file => {
      if (file === `CIK${currentCik}.json`) return manifest(currentCik, [quarter]);
      throw new Error('Predecessor temporarily unavailable');
    } })); },
  });
  assert.equal((await load(selection)).status, 'partial'); assert.equal((await load(selection)).status, 'partial');
  assert.equal(discoveries, 2); assert.equal(writes, 0);
});
