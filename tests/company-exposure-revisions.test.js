import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyExposureRevisionCache, companyExposureDocumentKey, COMPANY_EXPOSURE_DOCUMENT_TYPE, COMPANY_EXPOSURE_REVISION_TYPE } from '../src/utils/companyExposureRevisionCache.js';
import { discoverCompanyExposures, createCompanyExposureLoader } from '../src/utils/companyExposureServer.js';

const CIK = '0000001234', STARTED = Date.parse('2026-09-01T12:00:00.000Z');
const selection = { cik: CIK }, text = 'Our borrowings accrue interest based on SOFR and expose us to changing funding costs.';
const annual = { accession: '0000001234-26-000001', form: '10-K', filed: '2026-02-01', reportDate: '2025-12-31', primaryDoc: 'annual.htm' };
const quarter = { accession: '0000001234-26-000002', form: '10-Q', filed: '2026-08-01', reportDate: '2026-06-30', primaryDoc: 'quarter.htm' };
function manifest(items = [annual]) {
  const fields = { accessionNumber: 'accession', form: 'form', filingDate: 'filed', reportDate: 'reportDate', primaryDocument: 'primaryDoc' };
  return { cik: CIK, name: 'Verified Company', filings: { recent: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, items.map(item => item[field])])), files: [] } };
}
function sharedCache() {
  const values = new Map(), reads = [], writes = [];
  let clock = STARTED;
  return { values, reads, writes, setTime: value => { clock = value; },
    create: (options = {}) => createCompanyExposureRevisionCache({ enabled: () => true, now: () => clock,
      read: async (type, key) => { reads.push({ type, key }); return values.has(`${type}:${key}`) ? { payload: structuredClone(values.get(`${type}:${key}`)) } : null; },
      write: async (type, key, payload, ttl) => { writes.push({ type, key, ttl }); values.set(`${type}:${key}`, structuredClone(payload)); return { stored: true }; }, ...options }),
  };
}

test('a current manifest can reuse immutable source text and the same extraction revision after the latest snapshot expires', async () => {
  const shared = sharedCache(); let manifests = 0, downloads = 0;
  const options = time => ({ now: new Date(time), revisionCache: shared.create(),
    loadSubmissions: async () => { manifests++; return manifest(); },
    loadFilingText: async () => { downloads++; return { text, retrievedAt: new Date(STARTED).toISOString() }; },
  });
  const first = await discoverCompanyExposures(selection, options(STARTED));
  const nextTime = STARTED + 7 * 86400000; shared.setTime(nextTime);
  const next = await discoverCompanyExposures(selection, options(nextTime));
  assert.equal(manifests, 2); assert.equal(downloads, 1);
  assert.equal(next.checkedAt, new Date(nextTime).toISOString());
  assert.equal(next.generatedAt, first.generatedAt);
  assert.equal(next.sources[0].retrievedAt, first.sources[0].retrievedAt);
  assert.deepEqual(next.rows, first.rows);
  assert.equal(shared.writes.filter(write => write.type === COMPANY_EXPOSURE_DOCUMENT_TYPE).length, 1);
  assert.equal(shared.writes.filter(write => write.type === COMPANY_EXPOSURE_REVISION_TYPE).length, 1);
  assert.ok(shared.writes.every(write => write.ttl === 30 * 86400));
});

test('new selected accessions and extraction engine versions invalidate only the affected reusable revision', async () => {
  const shared = sharedCache(), downloaded = [];
  const loadFilingText = async (_cik, filing) => { downloaded.push(filing.accession); return { text }; };
  const first = await discoverCompanyExposures(selection, { now: new Date(STARTED), revisionCache: shared.create(), loadSubmissions: async () => manifest(), loadFilingText });
  const nextTime = STARTED + 86400000; shared.setTime(nextTime);
  const withQuarter = await discoverCompanyExposures(selection, { now: new Date(nextTime), revisionCache: shared.create(), loadSubmissions: async () => manifest([annual, quarter]), loadFilingText });
  assert.deepEqual(downloaded, [annual.accession, quarter.accession]);
  assert.equal(withQuarter.sources[0].retrievedAt, first.sources[0].retrievedAt);
  const revisedTime = nextTime + 86400000; shared.setTime(revisedTime);
  const revised = await discoverCompanyExposures(selection, { now: new Date(revisedTime), revisionCache: shared.create({ extractionVersion: 'company-exposure-extraction.v2' }),
    loadSubmissions: async () => manifest([annual, quarter]), loadFilingText });
  assert.deepEqual(downloaded, [annual.accession, quarter.accession]);
  assert.equal(revised.generatedAt, new Date(revisedTime).toISOString());
  assert.equal(shared.writes.filter(write => write.type === COMPANY_EXPOSURE_REVISION_TYPE).length, 3);
});

test('unavailable current manifests cannot promote retained source or extraction revisions as fresh evidence', async () => {
  const shared = sharedCache();
  await discoverCompanyExposures(selection, { now: new Date(STARTED), revisionCache: shared.create(), loadSubmissions: async () => manifest(), loadFilingText: async () => ({ text }) });
  const writes = shared.writes.length;
  const next = await discoverCompanyExposures(selection, { now: new Date(STARTED + 86400000), revisionCache: shared.create(),
    loadSubmissions: async () => { throw new Error('SEC manifest unavailable'); },
    loadFilingText: async () => { assert.fail('No current manifest selected a filing.'); } });
  assert.equal(next.status, 'unavailable'); assert.equal(next.retryable, true); assert.deepEqual(next.rows, []);
  assert.equal(shared.writes.length, writes);
});

test('source and extraction tampering cause a bounded rebuild rather than changing source attribution', async () => {
  const shared = sharedCache(); let downloads = 0;
  const load = time => discoverCompanyExposures(selection, { now: new Date(time), revisionCache: shared.create(),
    loadSubmissions: async () => manifest(), loadFilingText: async () => { downloads++; return { text }; } });
  await load(STARTED);
  for (const [key, value] of shared.values) {
    if (key.startsWith(COMPANY_EXPOSURE_DOCUMENT_TYPE)) value.source.url = 'https://example.test/fabricated.htm';
    if (key.startsWith(COMPANY_EXPOSURE_REVISION_TYPE)) value.extracted.rows[0].evidence[0].url = 'https://example.test/fabricated.htm';
  }
  const nextTime = STARTED + 86400000; shared.setTime(nextTime);
  const rebuilt = await load(nextTime);
  assert.equal(downloads, 2); assert.equal(rebuilt.status, 'ready');
  assert.ok(rebuilt.rows.every(row => row.evidence.every(item => item.url.startsWith('https://www.sec.gov/Archives/edgar/data/1234/'))));
  const source = rebuilt.sources[0];
  assert.notEqual(companyExposureDocumentKey(CIK, source), companyExposureDocumentKey('0000009999', source));
  assert.notEqual(companyExposureDocumentKey(CIK, source), companyExposureDocumentKey(CIK, source, 'changed-parser'));
});

test('prepared issuer disclosure reads use only current cached manifests and preserve their original check times', async () => {
  const shared = sharedCache(); let snapshot;
  const original = await discoverCompanyExposures(selection, { now: new Date(STARTED), revisionCache: shared.create(),
    loadSubmissions: async () => manifest(), loadFilingText: async () => ({ text }), onSnapshot: value => { snapshot = value; } });
  let clock = STARTED + 1000;
  const load = createCompanyExposureLoader({ now: () => clock, read: async () => snapshot, revisionCache: shared.create(),
    discover: async () => { assert.fail('Prepared-only reads must not start SEC research.'); } });
  const prepared = await load.prepared(selection);
  assert.equal(prepared.checkedAt, original.checkedAt); assert.equal(prepared.generatedAt, original.generatedAt);
  clock = STARTED + 6 * 3600000;
  assert.equal(await load.prepared(selection), null);
});
