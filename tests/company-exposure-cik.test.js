import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCompanyExposures, normalizeCompanyExposureCikRequest, restoreCompanyExposureSnapshot, loadCompanyExposuresByCik } from '../src/utils/companyExposureServer.js';

const now = new Date('2026-09-15T12:00:00Z'), cik = '0000320193';
const selection = { cik, ticker: null, asOf: null };
const text = 'Our copper production revenue is exposed to changes in copper prices and customer demand.';
const manifest = () => ({ cik, name: 'Verified Company', filings: { recent: {
  accessionNumber: ['0000950170-26-000001'], form: ['10-K'], filingDate: ['2026-02-01'],
  reportDate: ['2025-12-31'], primaryDocument: ['annual.htm'],
}, files: [] } });
const setup = overrides => ({ now, lookupTicker: async () => { throw new Error('Unexpected ticker lookup'); },
  loadSubmissions: async () => manifest(), loadFilingText: async () => ({ text }), ...overrides });

test('direct CIK normalization has the same historical cutoff validation without inventing a ticker', () => {
  assert.deepEqual(normalizeCompanyExposureCikRequest('320193', null, now), selection);
  for (const value of ['', '0', '0000000000', '../320193', 'AAPL', '320193.0', '00000320193'])
    assert.throws(() => normalizeCompanyExposureCikRequest(value, null, now), { code: 'INVALID_CIK' });
  for (const asOf of ['', '2026-02-30', '2026-09-16', '1993-12-31'])
    assert.throws(() => normalizeCompanyExposureCikRequest(cik, asOf, now), { code: 'INVALID_AS_OF' });
  assert.deepEqual(normalizeCompanyExposureCikRequest(cik, '2026-08-01', now), { ...selection, asOf: '2026-08-01' });
});

test('direct CIK discovery uses only that company’s manifest and annual source; ticker lookup is never used', async () => {
  const calls = [];
  const result = await discoverCompanyExposures({ cik }, setup({
    loadSubmissions: async file => { calls.push(file); return manifest(); },
    loadFilingText: async (issuerCik, filing) => { calls.push([issuerCik, filing.url]); return { text }; },
  }));
  assert.equal(result.status, 'ready'); assert.equal(result.cik, cik); assert.equal(result.ticker, null);
  assert.equal(result.companyName, 'Verified Company');
  assert.equal(calls[0], `CIK${cik}.json`); assert.equal(calls[1][0], cik);
  assert.match(calls[1][1], /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\//);
  assert.ok(result.rows.some(value => value.marketId === 'copper'));
  await assert.rejects(discoverCompanyExposures({ cik, ticker: 'AAPL' }, setup()), { code: 'INVALID_REQUEST' });
});

test('direct CIK discovery refuses mismatched or nameless issuer manifests without reading their documents', async () => {
  let calls = 0;
  for (const replacement of [{ ...manifest(), cik: '0000000099' }, { ...manifest(), name: '' }]) {
    const result = await discoverCompanyExposures({ cik }, setup({ loadSubmissions: async () => replacement,
      loadFilingText: async () => { calls++; return { text }; } }));
    assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'SEC_SOURCE_IDENTITY_MISMATCH'); assert.equal(result.rows.length, 0);
  }
  assert.equal(calls, 0);
});

test('direct CIK source snapshots bind their issuer selection and cannot be reused for a different company or ticker', async () => {
  let snapshot;
  const original = await discoverCompanyExposures(selection, setup({ onSnapshot: value => { snapshot = value; } }));
  assert.ok(snapshot); assert.equal(snapshot.ticker, null); assert.equal(snapshot.cik, cik);
  const restored = restoreCompanyExposureSnapshot(snapshot, selection, now);
  assert.ok(restored); assert.deepEqual(restored.rows, original.rows); assert.equal(restored.cik, cik);
  assert.equal(restoreCompanyExposureSnapshot(snapshot, { ...selection, cik: '0000000099' }, now), null);
  assert.equal(restoreCompanyExposureSnapshot(snapshot, { ticker: 'AAPL', asOf: null }, now), null);
  assert.equal(restoreCompanyExposureSnapshot(snapshot, { ...selection, asOf: '2026-08-01' }, now), null);
});

test('direct CIK loader respects the existing CFTC feature switch before transport', async () => {
  const previous = process.env.CFTC_ENABLED;
  try {
    process.env.CFTC_ENABLED = 'false';
    await assert.rejects(loadCompanyExposuresByCik(cik), { code: 'CFTC_DISABLED' });
  } finally { if (previous === undefined) delete process.env.CFTC_ENABLED; else process.env.CFTC_ENABLED = previous; }
});
