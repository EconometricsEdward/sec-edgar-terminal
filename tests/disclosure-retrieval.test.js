import test from 'node:test';
import assert from 'node:assert/strict';
import { disclosureSettings, readDisclosureDocument, scanDisclosureCompany, prewarmDisclosureCompany, disclosureCompanyHistory } from '../src/utils/disclosureResearchServer.js';

const prose = 'Our liquidity arrangements include a revolving credit facility available to fund operating expenses and capital projects. We evaluate the facility and covenant conditions throughout each financial reporting period.';
const settings = (extra = {}) => disclosureSettings(new URLSearchParams({ query: 'liquidity', forms: '10-K', start: '2025-01-01', comparison: 'none', ...extra }));
function submissions(cik, count = 1) {
  return { name: 'Retrieval Fixture', filings: { recent: {
    accessionNumber: Array.from({ length: count }, (_, i) => `${cik}-26-${String(count - i).padStart(6, '0')}`),
    form: Array(count).fill('10-K'), filingDate: Array.from({ length: count }, (_, i) => `2026-02-${String(count - i).padStart(2, '0')}`),
    reportDate: Array(count).fill('2025-12-31'), primaryDocument: Array.from({ length: count }, (_, i) => `report${count - i}.htm`),
  }, files: [] } };
}

test('standalone exhibit verifies text using recent filing metadata without historical downloads or comparisons', async () => {
  const original = global.fetch, calls = [], deferred = [];
  const cik = '0000999811';
  const data = submissions(cik);
  data.filings.files = [{ name: `CIK${cik}-submissions-001.json`, filingFrom: '2024-01-01', filingTo: '2025-12-31' }];
  global.fetch = async url => {
    calls.push(String(url));
    if (String(url).endsWith(`/CIK${cik}.json`)) return Response.json(data);
    if (String(url).endsWith('/exhibit99.htm')) return new Response(`<p>${prose}</p>`);
    throw new Error('An unnecessary archive or prior report was requested.');
  };
  try {
    const result = await readDisclosureDocument(cik, `${cik}-26-000001`, 'exhibit99.htm', settings(), 1, { deferIndexWrite: callback => deferred.push(callback) });
    assert.equal(calls.length, 2);
    assert.equal(result.form, '10-K');
    assert.equal(result.filingDate, '2026-02-01');
    assert.equal(result.reportDate, '2025-12-31');
    assert.equal(result.primaryDoc, 'exhibit99.htm');
    assert.equal(result.pair.kind, 'exhibit');
    assert.equal(result.pair.prior, null);
    assert.equal(result.matches.length, 1);
    assert.ok(result.matches.every(p => p.change === 'uncompared'));
    assert.equal(deferred.length, 1, 'Index persistence is registered for after the response.');
    await deferred[0]();
  } finally { global.fetch = original; }
});

test('document path and cancelled requests are rejected before issuer or filing traffic', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('No request should be issued.'); };
  try {
    for (const document of ['../secret.htm', 'https://evil.test/a.htm', '//evil.test/a.htm', 'foo//bar.htm', 'file.htm?redirect=evil', '%2e%2e/secret.htm', 'a\\b.htm'])
      await assert.rejects(readDisclosureDocument('0000999812', '0000999812-26-000001', document, settings()), /document format/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(scanDisclosureCompany('0000999812', settings(), '', { signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(readDisclosureDocument('0000999812', '0000999812-26-000001', 'report.htm', settings(), 1, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 0);
  } finally { global.fetch = original; }
});

test('company scan reviews at most two filings concurrently and retains filing order', async () => {
  const original = global.fetch, cik = '0000999813', data = submissions(cik, 3);
  let active = 0, peak = 0;
  const pending = [];
  global.fetch = async url => {
    if (String(url).includes('/submissions/')) return Response.json(data);
    active++; peak = Math.max(peak, active);
    if (String(url).endsWith('report1.htm')) { active--; return new Response(`<p>${prose}</p>`); }
    return new Promise(resolve => {
      pending.push(() => { active--; resolve(new Response(`<p>${prose}</p>`)); });
      if (pending.length === 2) { pending[1](); pending[0](); }
    });
  };
  try {
    const result = await scanDisclosureCompany(cik, settings({ depth: '3' }));
    assert.equal(peak, 2);
    assert.deepEqual(result.filings.map(f => f.primaryDoc), ['report3.htm', 'report2.htm', 'report1.htm']);
    assert.equal(result.reviewed, 3);
  } finally { global.fetch = original; }
});

test('cancelling a running scan aborts its transport and stops queued inspections', async () => {
  const original = global.fetch, cik = '0000999814', controller = new AbortController();
  let documentRequests = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes('/submissions/')) return Response.json(submissions(cik, 3));
    documentRequests++;
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw new DOMException('Stopped by the reader.', 'AbortError');
  };
  try {
    await assert.rejects(scanDisclosureCompany(cik, settings({ depth: '3' }), '', { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(documentRequests, 1);
  } finally { global.fetch = original; }
});

test('scheduled preparation is bounded and does not download old submissions archives', async () => {
  const original = global.fetch, cik = '0000999815', calls = [];
  const data = submissions(cik, 3);
  data.filings.files = [{ name: `CIK${cik}-submissions-001.json`, filingFrom: '2024-01-01', filingTo: '2025-12-31' }];
  global.fetch = async url => {
    calls.push(String(url));
    return String(url).includes('/submissions/') ? Response.json(data) : new Response(`<p>${prose}</p>`);
  };
  try {
    const result = await prewarmDisclosureCompany(cik, { maxDocuments: 1 });
    assert.equal(result.selected, 1);
    assert.equal(result.failed, 0);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].endsWith('report3.htm'));
    await assert.rejects(prewarmDisclosureCompany(cik, { maxDocuments: 50 }), /one or two/);
  } finally { global.fetch = original; }
});


test('concurrent source checks share issuer metadata without sharing cancellation', async () => {
  const original = global.fetch, cik = '0000999830';
  const first = new AbortController(), second = new AbortController();
  let calls = 0, transport, release, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  global.fetch = async (url, options) => {
    calls++; transport = options.signal;
    markStarted();
    return new Promise(resolve => { release = () => resolve(Response.json(submissions(cik))); });
  };
  try {
    const pendingFirst = disclosureCompanyHistory(cik, settings(), { signal: first.signal, recentOnly: true });
    const pendingSecond = disclosureCompanyHistory(cik, settings(), { signal: second.signal, recentOnly: true });
    const cancelled = assert.rejects(pendingFirst, { name: 'AbortError' });
    await started;
    first.abort();
    await cancelled;
    assert.equal(transport.aborted, false, 'Another reader still needs the shared source.');
    release();
    const result = await pendingSecond;
    assert.equal(result.cik, cik);
    assert.equal(result.filings.length, 1);
    assert.equal(calls, 1, 'Two simultaneous readers share one submissions request.');
    await disclosureCompanyHistory(cik, settings(), { recentOnly: true });
    assert.equal(calls, 1, 'A later document reuses fresh issuer metadata.');
  } finally { global.fetch = original; }
});

test('last metadata reader cancellation stops the transport and allows an immediate retry', async () => {
  const original = global.fetch, cik = '0000999831', controller = new AbortController();
  let calls = 0, transport, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  global.fetch = async (url, options) => {
    calls++;
    if (calls > 1) return Response.json(submissions(cik));
    transport = options.signal;
    markStarted();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  try {
    const pending = disclosureCompanyHistory(cik, settings(), { signal: controller.signal, recentOnly: true });
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    await started;
    controller.abort();
    await cancelled;
    assert.equal(transport.aborted, true);
    const result = await disclosureCompanyHistory(cik, settings(), { recentOnly: true });
    assert.equal(result.cik, cik);
    assert.equal(calls, 2);
  } finally { global.fetch = original; }
});

test('old accession selects its archive first and stops after matching the requested source', async () => {
  const original = global.fetch, cik = '0000999832', accession = `${cik}-18-000001`, calls = [];
  const data = submissions(cik);
  data.filings.files = Array.from({ length: 10 }, (_, i) => ({
    name: `CIK${cik}-submissions-${String(i + 1).padStart(3, '0')}.json`,
    filingFrom: `${2026 - i}-01-01`, filingTo: `${2026 - i}-12-31`,
  }));
  const archive = { accessionNumber: [accession], form: ['10-K'], filingDate: ['2018-02-01'], reportDate: ['2017-12-31'], primaryDocument: ['old-report.htm'] };
  global.fetch = async url => {
    calls.push(String(url));
    if (String(url).endsWith(`/CIK${cik}.json`)) return Response.json(data);
    if (String(url).endsWith('-submissions-009.json')) return Response.json(archive);
    if (String(url).endsWith('/old-report.htm')) return new Response(`<p>${prose}</p>`);
    throw new Error('Unrelated archive should not be downloaded for a standalone reader.');
  };
  try {
    const result = await readDisclosureDocument(cik, accession, 'old-report.htm', settings({ start: '2017-01-01' }));
    assert.equal(result.accession, accession);
    assert.equal(result.filingDate, '2018-02-01');
    assert.equal(result.matches.length, 1);
    assert.equal(calls.length, 3, 'Only submissions, the matching archive and the source document are fetched.');
    assert.ok(calls[1].endsWith('-submissions-009.json'));
  } finally { global.fetch = original; }
});

test('mismatched issuer metadata is rejected and never retained as a successful source', async () => {
  const original = global.fetch, cik = '0000999833';
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return Response.json({ ...submissions(cik), cik: calls === 1 ? '999834' : Number(cik) });
  };
  try {
    await assert.rejects(disclosureCompanyHistory(cik, settings(), { recentOnly: true }), /does not match/);
    const result = await disclosureCompanyHistory(cik, settings(), { recentOnly: true });
    assert.equal(result.cik, cik);
    assert.equal(calls, 2);
  } finally { global.fetch = original; }
});
