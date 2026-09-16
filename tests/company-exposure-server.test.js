import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { companyExposureFilings, selectCompanyExposureFilings, discoverCompanyExposures, restoreCompanyExposureSnapshot, parseCompanyExposureRequest, loadCompanyExposures } from '../src/utils/companyExposureServer.js';
import { COMPANY_EXPOSURE_MAX_TEXT } from '../src/utils/companyExposure.js';
import { GET, OPTIONS } from '../src/app/api/v1/cftc/company-exposures/route.js';

const now = new Date('2026-09-13T12:00:00Z'), cik = '0000320193';
const annual = { form: '10-K', filed: '2026-02-01', reportDate: '2025-12-31' };
const quarterly = { form: '10-Q', filed: '2026-08-01', reportDate: '2026-06-30' };
const positive = 'Our copper production revenue is exposed to changes in copper prices and customer demand.';
function rows(items) {
  const output = { accessionNumber: [], form: [], filingDate: [], reportDate: [], primaryDocument: [] };
  for (const [i, item] of items.entries()) {
    output.accessionNumber.push(item.accession || `0000950170-26-${String(i + 1).padStart(6, '0')}`);
    output.form.push(item.form || '10-K'); output.filingDate.push(item.filed); output.reportDate.push(item.reportDate);
    output.primaryDocument.push(item.primaryDoc || `report${i}.htm`);
  }
  return output;
}
function setup(items = [annual, quarterly], overrides = {}) {
  return { now, lookupTicker: async () => ({ cik, name: 'Example Company' }),
    loadSubmissions: async () => ({ cik, name: 'Example Company', filings: { recent: rows(items), files: [] } }),
    loadFilingText: async () => ({ text: positive }), ...overrides };
}
const selection = { ticker: 'AAPL', asOf: null };

test('exposure requests permit only exact ticker and valid SEC filing-date cutoff', () => {
  assert.deepEqual(parseCompanyExposureRequest('https://example.test/?ticker=brk-b&asOf=2026-09-01', now), { ticker: 'BRK-B', asOf: '2026-09-01' });
  for (const query of ['ticker=AAPL&ticker=XOM', 'ticker=AAPL&url=https://example.test', 'ticker=AAPL&asOf=', 'ticker=AAPL&asOf=2026-02-30', 'ticker=AAPL&asOf=2026-09-14', 'ticker=../AAPL']) {
    assert.throws(() => parseCompanyExposureRequest(`https://example.test/?${query}`, now), { status: 400 });
  }
});

test('selection requires a complete newer fiscal quarter as well as a newer filing date', () => {
  const available = companyExposureFilings(rows([
    annual, quarterly,
    { form: '10-K/A', filed: '2026-08-20', reportDate: '2025-12-31' },
    { form: '10-Q/A', filed: '2026-08-22', reportDate: '2026-06-30' },
    { form: '10-Q', filed: '2026-08-25', reportDate: '2025-09-30' },
    { form: '10-Q', filed: '2026-09-20', reportDate: '2026-06-30' },
    { form: '10-Q', filed: '2026-08-30', reportDate: '2026-06-30', primaryDoc: '../bad.htm' },
    { form: '10-Q', filed: '2026-08-30', reportDate: null },
    { form: '10-Q', filed: '2026-08-30', reportDate: '2027-01-01' },
  ]), cik, '2026-09-13');
  const selected = selectCompanyExposureFilings(available);
  assert.deepEqual(selected.map(item => [item.role, item.filed, item.reportDate]), [['annual', '2026-02-01', '2025-12-31'], ['quarterly', '2026-08-01', '2026-06-30']]);
  // Filing-agent accession numbers are legitimate even though their CIK prefix differs.
  assert.ok(selected[0].url.startsWith('https://www.sec.gov/Archives/edgar/data/320193/0000950170'));
  assert.equal(companyExposureFilings(rows([annual]), 'bad', '2026-09-13').length, 0);
});

test('discovery preserves separate annual and quarterly source identities and retrieval dates', async () => {
  const calls = [];
  const result = await discoverCompanyExposures(selection, setup(undefined, {
    loadFilingText: async (issuerCik, filing) => { calls.push([issuerCik, filing.form]); return { text: positive, retrievedAt: '2026-09-13T12:00:01Z' }; },
  }));
  assert.equal(result.status, 'ready'); assert.equal(result.retryable, false);
  assert.equal(result.coverage.filingsScanned, 2); assert.equal(result.coverage.filingsFailed, 0);
  assert.deepEqual(calls.map(item => item[1]), ['10-K', '10-Q']);
  assert.deepEqual(result.sources.map(source => [source.role, source.filed, source.reportDate, source.status]), [['annual', '2026-02-01', '2025-12-31', 'ready'], ['quarterly', '2026-08-01', '2026-06-30', 'ready']]);
  assert.equal(result.checkedAt, now.toISOString());
  assert.equal(result.sources[0].retrievedAt, '2026-09-13T12:00:01Z');
  assert.ok(result.rows.length);
  for (const row of result.rows) for (const evidence of row.evidence) {
    const source = result.sources.find(item => item.accession === evidence.accession);
    assert.ok(source); assert.equal(evidence.url, source.url); assert.equal(evidence.filed, source.filed); assert.equal(evidence.reportDate, source.reportDate);
  }
});

test('historical cutoff excludes future publications rather than backdating a newer report', async () => {
  const result = await discoverCompanyExposures({ ticker: 'AAPL', asOf: '2026-07-31' }, setup());
  assert.equal(result.status, 'ready'); assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].role, 'annual'); assert.equal(result.coverage.quarterlyAvailable, false);
});

test('failed newest quarter stays visible and does not silently fall back to an older quarter', async () => {
  let snapshot;
  const requested = [];
  const result = await discoverCompanyExposures(selection, setup([annual, quarterly, { form: '10-Q', filed: '2026-05-01', reportDate: '2026-03-31' }], {
    loadFilingText: async (_cik, filing) => { requested.push(filing.filed); if (filing.form === '10-Q') throw new Error('Upstream unavailable'); return { text: positive }; },
    onSnapshot: value => { snapshot = value; },
  }));
  assert.equal(result.status, 'partial'); assert.equal(result.retryable, true); assert.equal(result.coverage.filingsFailed, 1);
  assert.equal(result.sources[1].filed, '2026-08-01'); assert.equal(result.sources[1].status, 'unavailable');
  assert.equal(result.sources[1].retrievedAt, null); assert.equal(snapshot, undefined);
  assert.deepEqual(requested, ['2026-02-01', '2026-08-01']); assert.ok(result.rows.length);
  assert.ok(result.rows.every(row => row.evidence.every(evidence => evidence.role === 'annual')));
});

test('quarterly evidence remains usable when its eligible annual source cannot be read', async () => {
  const result = await discoverCompanyExposures(selection, setup(undefined, {
    loadFilingText: async (_cik, filing) => { if (filing.form === '10-K') throw new Error('Upstream unavailable'); return { text: positive }; },
  }));
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.annualAvailable, false); assert.equal(result.coverage.quarterlyAvailable, true);
  assert.equal(result.sources[0].status, 'unavailable'); assert.ok(result.rows.length);
  assert.ok(result.rows.every(row => row.evidence.every(evidence => evidence.role === 'quarterly')));
});

test('quarterly-only, no matching passages, no filing and complete source failure stay distinct', async () => {
  const onlyQuarter = await discoverCompanyExposures(selection, setup([quarterly]));
  assert.equal(onlyQuarter.status, 'ready'); assert.equal(onlyQuarter.coverage.annualAvailable, false); assert.equal(onlyQuarter.sources[0].role, 'quarterly');
  const noMatches = await discoverCompanyExposures(selection, setup([annual], { loadFilingText: async () => ({ text: 'Our consolidated financial statements are presented in accordance with the applicable accounting policies.' }) }));
  assert.equal(noMatches.status, 'no_matches'); assert.equal(noMatches.coverage.filingsScanned, 1);
  const missing = await discoverCompanyExposures(selection, setup([]));
  assert.equal(missing.status, 'no_filing'); assert.equal(missing.retryable, false); assert.equal(missing.sources.length, 0);
  const failed = await discoverCompanyExposures(selection, setup(undefined, { loadFilingText: async () => ({ error: 'blocked' }) }));
  assert.equal(failed.status, 'unavailable'); assert.equal(failed.retryable, true); assert.equal(failed.sources.length, 2);
  assert.equal(failed.coverage.filingsFailed, 2); assert.equal(failed.rows.length, 0);
});

test('a newer negative disclosure remains source evidence, never a quiet stale-positive replacement', async () => {
  const result = await discoverCompanyExposures(selection, setup(undefined, {
    loadFilingText: async (_cik, filing) => ({ text: filing.form === '10-K' ? positive : 'We no longer have any copper production revenue or exposure to changes in copper prices.' }),
  }));
  assert.equal(result.sources[1].status, 'ready'); assert.equal(result.coverage.quarterlyAvailable, true);
  assert.equal(result.sources[1].reportDate, '2026-06-30');
  const qualifying = result.rows.flatMap(row => row.evidence.filter(item => item.role === 'quarterly'));
  assert.ok(qualifying.length, 'The newer explicit denial must remain visible beside the annual evidence.');
  for (const evidence of qualifying) {
    assert.match(evidence.text, /no longer/);
    assert.equal(evidence.disclosureDirection, 'qualifying-or-negative');
    assert.equal(evidence.benchmark, null);
  }
});

test('bounded history is restricted to the current CIK and reports missing coverage', async () => {
  const calls = [];
  const files = [1, 2, 3].map(i => ({ name: `CIK${cik}-submissions-00${i}.json`, filingFrom: `${2026 - i}-01-01`, filingTo: `${2026 - i}-12-31` }));
  files.unshift({ name: 'CIK0000000001-submissions-001.json', filingFrom: '2026-01-01', filingTo: '2026-12-31' });
  const result = await discoverCompanyExposures(selection, setup([], {
    loadSubmissions: async name => { calls.push(name); return calls.length === 1 ? { cik, filings: { recent: rows([quarterly]), files } } : rows([]); },
  }));
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.historyFilesScanned, 2);
  assert.equal(result.coverage.historyLimited, true); assert.equal(result.coverage.searchComplete, false);
  assert.deepEqual(calls, [`CIK${cik}.json`, `CIK${cik}-submissions-001.json`, `CIK${cik}-submissions-002.json`]);
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].role, 'quarterly');
});

test('history outages retain readable evidence and explicitly identify the unchecked history', async () => {
  const result = await discoverCompanyExposures(selection, setup([], {
    loadSubmissions: async name => {
      if (name.includes('-submissions-')) throw new Error('Unavailable archive');
      return { cik, filings: { recent: rows([quarterly]), files: [{ name: `CIK${cik}-submissions-001.json`, filingFrom: '2025-01-01', filingTo: '2026-01-31' }] } };
    },
  }));
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.searchComplete, false); assert.equal(result.coverage.historyFailures.length, 1);
  assert.equal(result.coverage.historyFailures[0].name, `CIK${cik}-submissions-001.json`);
});

test('manifest CIK mismatch cannot attach another company’s evidence or guess a predecessor', async () => {
  let read = false;
  const result = await discoverCompanyExposures(selection, setup(undefined, {
    loadSubmissions: async () => ({ cik: '0000000001', filings: { recent: rows([annual]) } }),
    loadFilingText: async () => { read = true; return { text: positive }; },
  }));
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'SEC_SOURCE_IDENTITY_MISMATCH'); assert.equal(read, false); assert.equal(result.rows.length, 0);
  await assert.rejects(discoverCompanyExposures(selection, setup([], { lookupTicker: async () => null })), { status: 404 });
});

test('cache restores only bound source text and regenerates derived classifications', async () => {
  let snapshot;
  const result = await discoverCompanyExposures(selection, setup(undefined, { onSnapshot: value => { snapshot = value; } }));
  assert.ok(snapshot); assert.equal(snapshot.rows, undefined);
  snapshot.rows = [{ category: 'fabricated', amount: 999999999 }];
  const restored = restoreCompanyExposureSnapshot(snapshot, selection, new Date('2026-09-13T12:05:00Z'));
  assert.ok(restored); assert.deepEqual(restored.rows, result.rows); assert.equal(restored.checkedAt, result.checkedAt);
  assert.equal(restored.generatedAt, '2026-09-13T12:05:00.000Z'); assert.equal(restored.sources[0].retrievedAt, now.toISOString());
  for (const mutate of [
    value => { value.cik = '0000000001'; },
    value => { value.ticker = 'XOM'; },
    value => { value.companyName = 'A different issuer'; },
    value => { value.checkedAt = '2026-09-13T11:00:00Z'; },
    value => { value.asOf = '2026-01-01'; },
    value => { value.sources[0].url = 'https://evil.example/filing.htm'; },
    value => { value.sources[0].filed = '2025-02-01'; },
    value => { value.sources[0].accession = value.sources[1].accession; },
    value => { value.sources[0].role = 'quarterly'; },
    value => { value.sources[1].reportDate = '2025-09-30'; },
    value => { value.sources[0].gzip = gzipSync('Our bitcoin holdings on the balance sheet total $100 billion.').toString('base64'); },
    value => { value.sources[0].gzip = 'corrupt'; },
    value => { value.sources[0].retrievedAt = '2020-01-01T00:00:00Z'; },
    value => { value.sources[0].retrievedAt = '2099-01-01T00:00:00Z'; },
    value => { value.sources[0].textCharactersRetrieved = 0; },
    value => { value.historyFilesScanned = 9; },
    value => { value.sources.push(value.sources[0]); },
    value => { value.sources.pop(); },
  ]) {
    const corrupt = structuredClone(snapshot); mutate(corrupt);
    assert.equal(restoreCompanyExposureSnapshot(corrupt, selection, now), null, mutate.toString());
  }
});

test('compressed source cache preserves the extraction limit and visible truncation status', async () => {
  let snapshot;
  const text = `${positive}\n\n${'x'.repeat(COMPANY_EXPOSURE_MAX_TEXT)}`;
  const original = await discoverCompanyExposures(selection, setup([annual], { loadFilingText: async () => ({ text }), onSnapshot: value => { snapshot = value; } }));
  const restored = restoreCompanyExposureSnapshot(snapshot, selection, now);
  assert.ok(restored); assert.deepEqual(restored.rows, original.rows);
  assert.equal(restored.coverage.filings[0].textTruncated, true);
  assert.equal(restored.sources[0].textCharactersRetrieved, text.length);
});

test('due metadata refresh reuses exact source text while preserving its original retrieval dates', async () => {
  let snapshot, refreshedSnapshot, checks = 0;
  const original = await discoverCompanyExposures(selection, setup(undefined, { onSnapshot: value => { snapshot = value; } }));
  const later = new Date(now.getTime() + 24 * 3600 * 1000);
  const refreshed = await discoverCompanyExposures(selection, setup(undefined, {
    now: later, previousSnapshot: snapshot,
    loadSubmissions: async () => { checks++; return { cik, name: 'Example Company', filings: { recent: rows([annual, quarterly]), files: [] } }; },
    loadFilingText: async () => { assert.fail('Unchanged bound SEC documents must not be downloaded again.'); },
    onSnapshot: value => { refreshedSnapshot = value; },
  }));
  assert.equal(checks, 1); assert.equal(refreshed.status, 'ready');
  assert.equal(refreshed.checkedAt, later.toISOString());
  assert.deepEqual(refreshed.sources, original.sources);
  assert.deepEqual(refreshed.rows, original.rows);
  assert.ok(refreshedSnapshot);
  const restored = restoreCompanyExposureSnapshot(refreshedSnapshot, selection, later);
  assert.ok(restored); assert.deepEqual(restored.sources, original.sources);
  assert.equal(restored.checkedAt, later.toISOString());
});

test('new quarter downloads only the changed document and never replaces a failed newer source with old evidence', async () => {
  let snapshot;
  const oldQuarter = { ...quarterly, filed: '2026-05-01', reportDate: '2026-03-31', accession: '0000950170-26-000003', primaryDoc: 'old-quarter.htm' };
  await discoverCompanyExposures(selection, setup([annual, oldQuarter], { onSnapshot: value => { snapshot = value; } }));
  for (const failQuarter of [false, true]) {
    const downloaded = [];
    const refreshed = await discoverCompanyExposures(selection, setup([annual, quarterly], {
      now: new Date(now.getTime() + 7 * 3600 * 1000), previousSnapshot: snapshot,
      loadFilingText: async (_cik, filing) => {
        downloaded.push(filing.form);
        if (failQuarter) throw new Error('New quarter is temporarily unavailable.');
        return { text: 'We no longer have copper production revenue or exposure to copper prices.' };
      },
    }));
    assert.deepEqual(downloaded, ['10-Q']);
    assert.equal(refreshed.sources[0].retrievedAt, now.toISOString());
    assert.equal(refreshed.sources[1].reportDate, quarterly.reportDate);
    assert.equal(refreshed.status, failQuarter ? 'partial' : 'ready');
    assert.equal(refreshed.sources[1].status, failQuarter ? 'unavailable' : 'ready');
    assert.ok(refreshed.rows.every(row => row.evidence.every(evidence => evidence.reportDate !== oldQuarter.reportDate)));
  }
});

test('source reuse cannot turn an unavailable or structurally incomplete manifest into a successful refresh', async () => {
  let snapshot;
  await discoverCompanyExposures(selection, setup(undefined, { onSnapshot: value => { snapshot = value; } }));
  for (const unavailable of [false, true]) {
    let nextSnapshot;
    const refreshed = await discoverCompanyExposures(selection, setup(undefined, {
      now: new Date(now.getTime() + 7 * 3600 * 1000), previousSnapshot: snapshot,
      loadSubmissions: async () => {
        if (unavailable) throw new Error('SEC manifest unavailable.');
        const recent = rows([annual, quarterly]); recent.form.pop();
        return { cik, name: 'Example Company', filings: { recent, files: [] } };
      },
      loadFilingText: async () => { assert.fail('No complete manifest selected a source.'); },
      onSnapshot: value => { nextSnapshot = value; },
    }));
    assert.equal(refreshed.status, 'unavailable'); assert.equal(refreshed.retryable, true);
    assert.equal(refreshed.coverage.searchComplete, false); assert.equal(refreshed.rows.length, 0);
    assert.equal(nextSnapshot, undefined);
  }
});

test('a corrupted or expired source snapshot cannot be used to avoid retrieving selected documents', async () => {
  let snapshot;
  await discoverCompanyExposures(selection, setup([annual], { onSnapshot: value => { snapshot = value; } }));
  for (const corrupt of [false, true]) {
    let downloads = 0;
    const previousSnapshot = structuredClone(snapshot);
    if (corrupt) previousSnapshot.sources[0].retrievedAt = '2026-09-12T12:00:00Z';
    const refreshed = await discoverCompanyExposures(selection, setup([annual], {
      now: new Date(now.getTime() + (corrupt ? 7 : 25) * 3600 * 1000), previousSnapshot,
      loadFilingText: async () => { downloads++; return { text: positive }; },
    }));
    assert.equal(downloads, 1); assert.equal(refreshed.status, 'ready');
  }
});

test('unchecked relevant history remains partial even when selected source text can be reused', async () => {
  let snapshot, nextSnapshot;
  await discoverCompanyExposures(selection, setup(undefined, { onSnapshot: value => { snapshot = value; } }));
  const refreshed = await discoverCompanyExposures(selection, setup(undefined, {
    now: new Date(now.getTime() + 7 * 3600 * 1000), previousSnapshot: snapshot,
    loadSubmissions: async file => {
      if (file.includes('-submissions-')) throw new Error('Archive unavailable.');
      return { cik, name: 'Example Company', filings: { recent: rows([annual, quarterly]), files: [
        { name: `CIK${cik}-submissions-001.json`, filingFrom: '2026-01-01', filingTo: '2026-09-13' },
      ] } };
    },
    loadFilingText: async () => { assert.fail('Selected documents already have verified text.'); },
    onSnapshot: value => { nextSnapshot = value; },
  }));
  assert.equal(refreshed.status, 'partial'); assert.equal(refreshed.coverage.searchComplete, false);
  assert.equal(refreshed.coverage.historyFailures.length, 1); assert.ok(refreshed.rows.length);
  assert.equal(nextSnapshot, undefined);
});

test('a cancelled source request reports a bounded failure and does not hang discovery', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await discoverCompanyExposures(selection, setup([], { signal: controller.signal }));
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'COMPANY_EXPOSURE_TIMEOUT');
});

test('disabled endpoint fails closed before data discovery and query errors remain noncacheable', async () => {
  const prior = process.env.CFTC_ENABLED;
  try {
    process.env.CFTC_ENABLED = 'false';
    const disabled = await GET(new Request('https://example.test/api/v1/cftc/company-exposures?ticker=AAPL'));
    assert.equal(disabled.status, 503); assert.match(disabled.headers.get('cache-control'), /no-store/);
    assert.equal((await disabled.json()).code, 'CFTC_DISABLED');
    await assert.rejects(loadCompanyExposures(selection), { code: 'CFTC_DISABLED' });
    process.env.CFTC_ENABLED = 'true';
    const invalid = await GET(new Request('https://example.test/api/v1/cftc/company-exposures?ticker=AAPL&url=evil'));
    assert.equal(invalid.status, 400); assert.match(invalid.headers.get('cache-control'), /no-store/);
    assert.equal((await invalid.json()).code, 'UNKNOWN_QUERY_PARAMETER');
    assert.equal(OPTIONS().status, 204);
  } finally {
    if (prior === undefined) delete process.env.CFTC_ENABLED; else process.env.CFTC_ENABLED = prior;
  }
});
