import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerDealerDocumentLoader, parseBrokerDealerDocumentIndex, parseBrokerDealerCover, selectBrokerDealerDocument, validBrokerDealerDocumentName, readBrokerDealerBytes } from '../src/utils/brokerDealerDocuments.js';
import { analyzeBrokerDealerReport } from '../src/utils/brokerDealerAnalytics.js';

const cik = '0000002001';
const filing = number => ({ accession: `0000950170-26-${String(number).padStart(6, '0')}`, form: 'X-17A-5', filingDate: '2026-08-28', reportDate: '', primaryDoc: 'primary_doc.xml' });
const base = record => `https://www.sec.gov/Archives/edgar/data/2001/${record.accession.replaceAll('-', '')}/`;
const row = (name, type = 'FULL', description = 'Public financial statements', href = name) => `<tr><td>1</td><td>${description}</td><td><a href="${href}">${name}</a></td><td>${type}</td><td>3000</td></tr>`;
const manifest = () => `<table>${row('primary_doc.xml', 'X-17A-5', 'Facing page')}${row('public_financials.pdf')}${row('consent.pdf', 'EX-23', 'Accountant consent')}</table>`;
const cover = '<edgarSubmission><periodEnd>06-30-2026</periodEnd><periodBegin>07-01-2025</periodBegin><accountantName>Example &amp; Co.</accountantName><typeOfBDRegistrant>Broker-dealer</typeOfBDRegistrant></edgarSubmission>';
const text = 'Statement of Financial Condition\nJune 30, 2026\nU.S. dollars\nTotal assets 1,000\nTotal liabilities 800\nTotal members equity 200';
const extracted = () => ({ pages: [{ pageNumber: 1, text, lines: text.split('\n').map(text => ({ text })) }], extraction: { status: 'text', pageCount: 1, pagesRead: 1, pagesWithText: 1, limitations: [] } });

function setup(record, overrides = {}) {
  const calls = [], writes = [];
  const load = createBrokerDealerDocumentLoader({
    cacheGet: async () => null,
    cacheSet: async (...args) => writes.push(args),
    extractPdf: async bytes => { assert.match(new TextDecoder().decode(bytes), /^%PDF-/); return extracted(); },
    fetchSec: async (url, options) => {
      calls.push({ url, options });
      if (url === `${base(record)}${record.accession}-index.html`) return new Response(manifest());
      if (url === `${base(record)}primary_doc.xml`) return new Response(cover);
      if (url === `${base(record)}public_financials.pdf`) return new Response('%PDF-1.7\nfixture', { headers: { 'content-type': 'application/pdf' } });
      throw new Error(`Unexpected request: ${url}`);
    }, ...overrides,
  });
  return { load, calls, writes };
}

test('attachment index accepts only exact files under the selected CIK and accession', () => {
  const record = filing(100);
  const malicious = [
    'https://example.com/public.pdf', '//example.com/public.pdf',
    `${base(record).replace('/2001/', '/2002/')}public.pdf`,
    `${base(filing(101))}public.pdf`, '../other.pdf', '%2e%2e/other.pdf',
    'subfolder/public.pdf', 'public.pdf?download=1', 'public.pdf#page=2',
    'https://www.sec.gov@evil.example/public.pdf', 'https://user:pass@www.sec.gov/public.pdf',
    'javascript:alert(1)', 'file:///etc/passwd', 'public\\other.pdf',
  ];
  const html = `${row('public_financials.pdf', 'FULL', 'Public statement')}${row('primary_doc.xml', 'X-17A-5', 'Facing page')}${malicious.map(href => row('bad.pdf', 'FULL', 'Bad', href)).join('')}`;
  const documents = parseBrokerDealerDocumentIndex(html, cik, record);
  assert.deepEqual(documents.map(doc => doc.name), ['public_financials.pdf', 'primary_doc.xml']);
  assert.ok(documents.every(doc => doc.url.startsWith(base(record))));
  assert.throws(() => parseBrokerDealerDocumentIndex(row('bad.pdf', 'FULL', '', '//example.com/bad.pdf'), cik, record), /usable attachment index/);
  assert.throws(() => parseBrokerDealerDocumentIndex(html, '../2001', record), { status: 400 });
});

test('document selection prioritizes a financial PDF over cover XML and consent without treating FULL as complete statements', () => {
  const documents = parseBrokerDealerDocumentIndex(manifest(), cik, filing(102));
  const selected = selectBrokerDealerDocument(documents);
  assert.equal(selected.name, 'public_financials.pdf');
  assert.equal(selected.type, 'FULL');
  assert.equal(selectBrokerDealerDocument(documents, 'primary_doc.xml').format, 'xml');
  assert.throws(() => selectBrokerDealerDocument(documents, 'unlisted.pdf'), { status: 400 });
  assert.throws(() => selectBrokerDealerDocument(documents, '../other.pdf'), { status: 400 });
  const analysis = analyzeBrokerDealerReport({ ...filing(102), reportDate: '2026-06-30', pages: extracted().pages, type: selected.type, documentUrl: selected.url });
  assert.ok(analysis.coverage.availableMetrics.includes('totalAssets'));
  assert.ok(analysis.coverage.missingMetrics.includes('netIncome'));
  assert.equal(analysis.coverage.scope, 'public-attachment-only');
  assert.match(analysis.limitations.join(' '), /Profitability is unavailable/);
});

test('document name and facing-page parsers reject traversal and invalid financial dates', () => {
  for (const name of ['public.pdf', 'report-2025.htm', 'primary_doc.xml', 'statement.txt']) assert.equal(validBrokerDealerDocumentName(name), true);
  for (const name of ['../public.pdf', 'a..pdf', 'sub/report.pdf', '%2e%2e.pdf', 'https://example.com/a.pdf', 'a.pdf#page=1', 'a.pdf?x=1', 'a.pdf\n', 'a.exe']) assert.equal(validBrokerDealerDocumentName(name), false, name);
  assert.equal(parseBrokerDealerCover(cover).reportDate, '2026-06-30');
  assert.equal(parseBrokerDealerCover(cover).periodBegin, '2025-07-01');
  assert.equal(parseBrokerDealerCover('<periodEnd>02-30-2026</periodEnd>').reportDate, '');
  assert.equal(parseBrokerDealerCover('<periodEnd>not a date</periodEnd>').reportDate, '');
});

test('loader resolves its manifest before extracting and prevents arbitrary document URL requests', async () => {
  const record = filing(103), { load, calls, writes } = setup(record);
  const result = await load(cik, record);
  assert.equal(result.selectedDocument.name, 'public_financials.pdf');
  assert.equal(result.cover.reportDate, '2026-06-30');
  assert.equal(result.format, 'pdf-text');
  assert.match(result.text, /^Page 1/);
  assert.deepEqual(calls.map(call => call.url), [`${base(record)}${record.accession}-index.html`, `${base(record)}primary_doc.xml`, `${base(record)}public_financials.pdf`]);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  assert.ok(writes.every(write => write[3] === 86400 * 7));
  const count = calls.length;
  for (const document of ['unknown.pdf', 'https://example.com/secret.pdf', '../private.pdf']) await assert.rejects(load(cik, record, { document }), { status: 400 });
  assert.equal(calls.length, count, 'Invalid requested documents cannot trigger arbitrary fetches');
  const again = await load(cik, record);
  assert.equal(calls.length, count, 'Validated immutable filing extraction is reused');
  assert.equal(again.extractedAt, result.extractedAt);
});

test('a non-PDF response is rejected before the PDF extractor and remains retryable', async () => {
  const record = filing(104); let extracts = 0;
  const { load } = setup(record, { fetchSec: async url => new Response(url.endsWith('-index.html') ? manifest() : url.endsWith('.xml') ? cover : '<html>Access denied</html>'), extractPdf: async () => { extracts++; return extracted(); } });
  await assert.rejects(load(cik, record), /valid PDF/);
  assert.equal(extracts, 0);
});

test('bounded document reads reject declared and streamed oversized responses', async () => {
  await assert.rejects(readBrokerDealerBytes(new Response('abc', { headers: { 'content-length': '99' } }), 8), { status: 422 });
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBrokerDealerBytes(new Response(stream), 8), { status: 422 });
  assert.equal(cancelled, true);
  await assert.rejects(readBrokerDealerBytes(new Response(null)), /empty document/);
  await assert.rejects(readBrokerDealerBytes(new Response('blocked', { status: 403 })), /HTTP 403/);
});

test('retryable extraction failures are not retained in either local or shared caches', async () => {
  const record = filing(105); let attempts = 0;
  const { load, writes } = setup(record, { extractPdf: async () => ++attempts === 1
    ? { pages: [], extraction: { status: 'unavailable', retryable: true, limitations: ['Transient extraction failure'] } }
    : extracted() });
  assert.equal((await load(cik, record)).extraction.retryable, true);
  assert.equal(writes.filter(write => write[0].includes('-document.')).length, 0);
  assert.equal((await load(cik, record)).extraction.status, 'text');
  assert.equal(attempts, 2);
});

test('malformed cached manifests are discarded and reloaded from the SEC index', async () => {
  for (const [number, documents] of [[106, []], [107, [null]]]) {
    const record = filing(number);
    const { load, calls } = setup(record, { cacheGet: async namespace => namespace.includes('-manifest.') ? { cik, documents } : null });
    const result = await load(cik, record);
    assert.equal(result.selectedDocument.name, 'public_financials.pdf');
    assert.ok(calls.some(call => call.url.endsWith('-index.html')));
  }
});

test('cached extraction from another CIK is discarded before displaying financial text', async () => {
  const record = filing(108);
  const { load, calls } = setup(record, { cacheGet: async namespace => namespace.includes('-document.') ? { ...extracted(), cik: '0000002002', extractedAt: '2025-01-01T00:00:00Z' } : null });
  const result = await load(cik, record);
  assert.equal(result.cik, cik);
  assert.ok(calls.some(call => call.url.endsWith('/public_financials.pdf')));
  assert.notEqual(result.extractedAt, '2025-01-01T00:00:00Z');
});
