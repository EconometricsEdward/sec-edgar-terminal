import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('prewarming refreshes legacy text only after a real successful fetch and never invents its retrieval date', () => {
  // A separate process enables the existing legacy cache adapter against a
  // fixture transport without changing cache configuration for other tests.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { gzipSync, gunzipSync } from 'node:zlib';
    process.env.KV_REST_API_URL = 'https://disclosure-cache-fixture.invalid';
    process.env.KV_REST_API_TOKEN = 'fixture-only';
    const { disclosureSettings, readDisclosureDocument, prewarmDisclosureCompany } = await import('./src/utils/disclosureResearchServer.js');
    const cik = '0000999820', accession = cik + '-26-000001';
    const base = 'Our liquidity arrangements include a revolving credit facility available to fund operating expenses and capital projects. We evaluate facility conditions throughout each financial reporting period.';
    const legacy = base + ' The retained legacy source has not been dated.';
    const fresh = base + ' The newly fetched source confirms current disclosure wording.';
    const cache = new Map(); let sourceFetches = 0, permitFresh = false;
    const textWrites = [];
    global.fetch = async (input, options = {}) => {
      const url = new URL(input);
      if (url.hostname === 'disclosure-cache-fixture.invalid') {
        const pieces = url.pathname.split('/'), operation = pieces[1], key = decodeURIComponent(pieces[2] || '');
        if (operation === 'get') {
          const value = cache.get(key) || (key.startsWith('warm:disclosure-text-v1:') ? { gzip: gzipSync(legacy).toString('base64') } : null);
          return Response.json({ result: value ? JSON.stringify(value) : null });
        }
        if (operation === 'set') {
          const value = JSON.parse(options.body);
          cache.set(key, value);
          if (key.startsWith('warm:disclosure-text-v1:')) textWrites.push(value);
          return Response.json({ result: 'OK' });
        }
        throw new Error('Unexpected fixture cache operation');
      }
      if (url.hostname === 'data.sec.gov') return Response.json({ name: 'Legacy Cache Fixture', filings: { recent: {
        accessionNumber: [accession], form: ['10-K'], filingDate: ['2026-02-01'], reportDate: ['2025-12-31'], primaryDocument: ['report.htm'],
      }, files: [] } });
      assert.equal(url.hostname, 'www.sec.gov');
      sourceFetches++;
      return permitFresh ? new Response('<p>' + fresh + '</p>') : new Response('Unavailable', { status: 403 });
    };
    const settings = disclosureSettings(new URLSearchParams({ query: 'liquidity', start: '2025-01-01', comparison: 'none' }));
    const oldReview = await readDisclosureDocument(cik, accession, 'report.htm', settings);
    assert.match(oldReview.matches[0].text, /retained legacy source/);
    assert.equal(sourceFetches, 0, 'Ordinary readers can still use undated legacy text.');
    const failed = await prewarmDisclosureCompany(cik, { maxDocuments: 1 });
    assert.equal(failed.failed, 1);
    assert.equal(sourceFetches, 1, 'A scheduler actually refreshes the source.');
    assert.equal(textWrites.length, 0, 'A failed refresh must never stamp legacy text as freshly retrieved.');
    const retainedReview = await readDisclosureDocument(cik, accession, 'report.htm', settings);
    assert.match(retainedReview.matches[0].text, /retained legacy source/);
    permitFresh = true;
    const beforeFetch = Date.now();
    const refreshed = await prewarmDisclosureCompany(cik, { maxDocuments: 1 });
    assert.equal(refreshed.failed, 0);
    assert.equal(sourceFetches, 2);
    assert.equal(textWrites.length, 1);
    const stored = textWrites[0];
    assert.equal(gunzipSync(Buffer.from(stored.gzip, 'base64')).toString('utf8'), fresh);
    assert.ok(Date.parse(stored.sourceRetrievedAt) >= beforeFetch);
    assert.ok(Date.parse(stored.sourceRetrievedAt) <= Date.now());
    await prewarmDisclosureCompany(cik, { maxDocuments: 1 });
    assert.equal(sourceFetches, 2, 'Known source timestamps do not force another SEC refresh.');
  `], { cwd: process.cwd(), stdio: 'pipe', timeout: 15_000 });
});

test('legacy reader indexing refreshes only after response, deduplicates work, and bounds background source requests', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { gzipSync, gunzipSync } from 'node:zlib';
    process.env.KV_REST_API_URL = 'https://disclosure-background-fixture.invalid';
    process.env.KV_REST_API_TOKEN = 'fixture-only';
    const { disclosureSettings, readDisclosureDocument } = await import('./src/utils/disclosureResearchServer.js');
    const cik = '0000999821';
    const prose = 'Our liquidity arrangements include a revolving credit facility available to fund operating expenses and capital projects. We evaluate facility conditions throughout each financial reporting period.';
    const legacy = prose + ' This is retained legacy wording.';
    const fresh = prose + ' This is newly retrieved source wording.';
    const cache = new Map(), deferred = [], writes = [];
    let sourceFetches = 0;
    global.fetch = async (input, options = {}) => {
      const url = new URL(input);
      if (url.hostname === 'disclosure-background-fixture.invalid') {
        const parts = url.pathname.split('/'), key = decodeURIComponent(parts[2] || '');
        if (parts[1] === 'get') {
          const value = cache.get(key) || (key.startsWith('warm:disclosure-text-v1:') ? { gzip: gzipSync(legacy).toString('base64') } : null);
          return Response.json({ result: value ? JSON.stringify(value) : null });
        }
        const value = JSON.parse(options.body);
        cache.set(key, value);
        if (key.startsWith('warm:disclosure-text-v1:')) writes.push(value);
        return Response.json({ result: 'OK' });
      }
      if (url.hostname === 'data.sec.gov') return Response.json({ name: 'Background Cache Fixture', filings: { recent: {
        accessionNumber: [1, 2, 3, 4].map(i => cik + '-26-00000' + i), form: ['10-K', '10-K', '10-K', '10-K'],
        filingDate: ['2026-02-01', '2026-02-02', '2026-02-03', '2022-02-01'],
        reportDate: ['2025-12-31', '2025-12-31', '2025-12-31', '2021-12-31'],
        primaryDocument: ['report1.htm', 'report2.htm', 'report3.htm', 'report4.htm'],
      }, files: [] } });
      assert.equal(url.hostname, 'www.sec.gov'); sourceFetches++;
      return url.pathname.endsWith('report2.htm') ? new Response('Unavailable', { status: 403 }) : new Response('<p>' + fresh + '</p>');
    };
    const settings = disclosureSettings(new URLSearchParams({ query: 'liquidity', start: '2021-01-01', comparison: 'none' }));
    const read = i => readDisclosureDocument(cik, cik + '-26-00000' + i, 'report' + i + '.htm', settings, 1, { deferIndexWrite: callback => deferred.push(callback) });
    const first = await read(1);
    assert.match(first.matches[0].text, /retained legacy wording/);
    assert.equal(sourceFetches, 0, 'The foreground reader must not refresh its source.');
    await read(1);
    assert.equal(deferred.length, 1, 'Repeated readers share one scheduled refresh.');
    await read(2); await read(3);
    assert.equal(deferred.length, 2, 'At most two legacy source refreshes can be pending.');
    assert.equal(sourceFetches, 0);
    const beforeRefresh = Date.now();
    await Promise.all(deferred.slice(0, 2).map(callback => callback()));
    assert.equal(sourceFetches, 2);
    assert.equal(writes.length, 1, 'The failed source gets no newly invented timestamp.');
    assert.equal(gunzipSync(Buffer.from(writes[0].gzip, 'base64')).toString('utf8'), fresh);
    assert.ok(Date.parse(writes[0].sourceRetrievedAt) >= beforeRefresh);
    await read(2);
    assert.equal(deferred.length, 2, 'Failed refreshes back off instead of looping on each reader.');
    const retained = await read(2);
    assert.match(retained.matches[0].text, /retained legacy wording/);
    await read(4);
    assert.equal(deferred.length, 2, 'Filings outside index retention never incur a background refresh.');
    await read(3);
    assert.equal(deferred.length, 3, 'A freed slot can prepare another recently requested filing.');
    await deferred[2]();
    assert.equal(sourceFetches, 3);
  `], { cwd: process.cwd(), stdio: 'pipe', timeout: 15_000 });
});
