import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { prepareDisclosureIndexDocument, readPreparedDisclosureText, indexDisclosureText, searchDisclosurePassageIndex } from '../src/utils/disclosurePassageIndex.js';
import { parseDisclosureQuery } from '../src/utils/disclosureQuery.js';
import { validDisclosureIndexDocument } from '../supabase/functions/edgar-data-gateway/disclosurePolicy.js';

const today = new Date().toISOString().slice(0, 10);
const fixture = (overrides = {}) => ({ cik: '0000320193', ticker: 'AAPL', companyName: 'Apple Inc.',
  filing: { accession: '0000320193-26-000001', primaryDoc: 'aapl-2026.htm', form: '10-K', filingDate: today, reportDate: today },
  text: 'Item 1A. Risk Factors\n\nWe identified a material weakness in controls and began remediation this year. No customer information was compromised in the cybersecurity incident.\n\nWe have no debt covenant breach. Our liquidity was adequate during the reporting period and we repaid obligations when due.',
  sourceRetrievedAt: new Date(Date.now() - 20000).toISOString(), ...overrides });
const settings = query => ({ query, parsed: parseDisclosureQuery(query), start: '2024-01-01', end: today, forms: ['10-K'], section: 'all', scope: 'paragraph' });

test('bounded preparation retains full paragraphs, real section labels, and fingerprint-verifiable full text', () => {
  const source = fixture(); const prepared = prepareDisclosureIndexDocument(source);
  assert.equal(prepared.document.complete, true);
  assert.equal(prepared.document.textHash, createHash('sha256').update(source.text).digest('hex'));
  assert.equal(prepared.passages[1].sectionId, 'risk');
  assert.equal(validDisclosureIndexDocument(prepared.document, prepared.passages), true);
  const long = prepareDisclosureIndexDocument(fixture({ text: `${source.text}\n\n${'Liquidity disclosures '.repeat(600)}` }));
  assert.equal(long.document.complete, false);
  assert.equal(long.document.preparedText, null);
  assert.equal(long.passages.length, prepared.passages.length, 'oversized paragraphs omitted whole, never truncated before NOT matching');
  const many = prepareDisclosureIndexDocument(fixture({ text: Array.from({ length: 400 }, (_, i) => `Paragraph ${i}. ${'Debt and liquidity details. '.repeat(60)}`).join('\n\n') }));
  assert.ok(many.passages.length <= 180);
  assert.ok(Buffer.byteLength(JSON.stringify(many)) <= 280000);
  assert.equal(many.document.complete, false);
  assert.equal(prepareDisclosureIndexDocument(fixture({ filing: { ...source.filing, filingDate: '2008-01-01' } })), null);
});

test('prepared text rejects partial coverage and corrupt fingerprints; optional storage fails open', async () => {
  const input = fixture(); const prepared = prepareDisclosureIndexDocument(input);
  const read = async () => ({ complete: true, text: input.text, textHash: prepared.document.textHash, sourceRetrievedAt: input.sourceRetrievedAt });
  assert.equal((await readPreparedDisclosureText(input, { read })).text, input.text);
  assert.equal(await readPreparedDisclosureText(input, { read: async () => ({ ...(await read()), complete: false }) }), null);
  assert.equal(await readPreparedDisclosureText(input, { read: async () => ({ ...(await read()), text: 'tampered' }) }), null);
  assert.equal((await indexDisclosureText(input, { write: async () => { throw new Error('offline'); } })).reason, 'index_unavailable');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readPreparedDisclosureText({ ...input, signal: controller.signal }, { read: async () => { throw controller.signal.reason; } }));
});

test('exact Boolean verification rejects FTS false positives and document-wide exclusions defer to full review', async () => {
  const source = fixture(); const prepared = prepareDisclosureIndexDocument(source);
  const rows = prepared.passages.map(passage => ({ ...prepared.document, passage, rank: 1, score: 0.7, indexedAt: new Date().toISOString(), indexedPassages: prepared.passages.length }));
  const search = async () => ({ results: rows, coverage: { documents: 1 }, hasMore: false });
  const noBreach = await searchDisclosurePassageIndex(settings('covenant AND NOT breach'), {}, { search });
  assert.equal(noBreach.results.length, 0);
  const result = await searchDisclosurePassageIndex(settings('"material weakness" AND remediation'), {}, { search });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'indexed-match');
  assert.equal(result.results[0].preparedRank, 1);
  assert.equal(result.results[0].previews[0].text.includes('No customer information'), true);
  assert.equal(result.coverage.partial, true);
  const qualified = `There is no evidence, after ${'our investigation and independent review '.repeat(25)}, of a cybersecurity breach.`;
  const qualifiedSearch = async () => ({ results: [{ ...rows[0], passage: { ...rows[0].passage, text: qualified } }], hasMore: false });
  const qualifiedResult = await searchDisclosurePassageIndex(settings('cybersecurity'), {}, { search: qualifiedSearch });
  assert.equal(qualifiedResult.results[0].previews[0].text, qualified, 'leading negation must survive a late match');
  const documentSearch = await searchDisclosurePassageIndex({ ...settings('covenant AND NOT breach'), scope: 'document' }, {}, { search: async () => { throw new Error('should not query partial index'); } });
  assert.equal(documentSearch.coverage.reason, 'document_scope_requires_full_review');
});

test('tracked SQL verifies service-only access, exact document replacement, stale writes, search filters and quotas', async () => {
  const db = new PGlite();
  try {
    // Fixtures use ISO UTC dates; PGlite's bundled default timezone can be behind UTC.
    await db.exec("set timezone='UTC';");
    await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public to service_role;');
    await db.exec(await readFile(new URL('../supabase/migrations/20260915070149_edgar_disclosure_passage_index.sql', import.meta.url), 'utf8'));
    const call = async (query, params = []) => (await db.query(query, params)).rows[0]?.value;
    const put = data => call('select public.edgar_disclosure_replace($1,$2::jsonb,$3::jsonb) as value', ['production', JSON.stringify(data.document), JSON.stringify(data.passages)]);
    const lookup = data => call('select public.edgar_disclosure_document($1,$2,$3,$4,$5) as value', ['production', data.document.cik, data.document.accession, data.document.primaryDoc, 1]);
    const search = ({ terms = ['material weakness'], offset = 0, limit = 120, tickers = [], section = 'all' } = {}) => call('select public.edgar_disclosure_search($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as value', ['production', terms, '2024-01-01', today, ['10-K'], [], tickers, section, offset, limit, 1]);
    await db.exec('set role anon;');
    await assert.rejects(search(), /permission denied/);
    await assert.rejects(db.query('select * from edgar_private.disclosure_documents'), /permission denied/);
    await db.exec('reset role; set role authenticated;');
    await assert.rejects(search(), /permission denied/);
    await db.exec('reset role; set role service_role;');
    const original = prepareDisclosureIndexDocument(fixture());
    assert.equal((await put(original)).stored, true);
    assert.equal((await put(original)).deduplicated, true);
    assert.equal((await lookup(original)).text, original.document.preparedText);
    const first = await search(); assert.equal(first.results.length, 1); assert.equal(first.coverage.documents, 1);
    assert.equal(first.results[0].rank, 1); assert.equal(typeof first.results[0].score, 'number');
    assert.equal((await search({ tickers: ['MSFT'] })).results.length, 0);
    assert.equal((await search({ section: 'mda' })).results.length, 0);
    assert.equal((await search({ terms: ['liquidity', 'controls'], limit: 1 })).hasMore, true);
    const secondPage = await search({ terms: ['liquidity', 'controls'], limit: 1, offset: 1 });
    assert.equal(secondPage.results.length, 1); assert.equal(secondPage.results[0].rank, 2);
    const replacement = prepareDisclosureIndexDocument(fixture({ text: 'Item 1A. Risk Factors\n\nThe company completed remediation of the prior material weakness. The implemented control improvements operated effectively in the reporting period.', sourceRetrievedAt: new Date(Date.now() - 10000).toISOString() }));
    assert.equal((await put(replacement)).stored, true);
    assert.equal((await put(original)).reason, 'stale_generation');
    assert.equal((await search({ terms: ['liquidity'] })).results.length, 0, 'atomic replacement removes old passages');
    assert.equal((await search({ terms: ['remediation'] })).results.length, 1);
    // A broad multi-document query must paginate before exceeding the narrow
    // gateway's response budget, even with Unicode and long paragraphs.
    for (let i = 1; i <= 4; i++) {
      const longText = Array.from({ length: 40 }, (_, p) => `Liquidity paragraph ${p}. ${'éééé narrative '.repeat(320)}`).join('\n\n');
      const data = prepareDisclosureIndexDocument(fixture({ text: longText, filing: { ...fixture().filing, accession: `0000320193-26-00010${i}` } }));
      assert.equal((await put(data)).stored, true);
    }
    const broad = await search({ terms: ['liquidity'] });
    assert.ok(Buffer.byteLength(JSON.stringify(broad)) < 512 * 1024);
    assert.equal(broad.hasMore, true);
    assert.ok(broad.results.length > 0 && broad.results.length < 120);
    const broken = { ...replacement, document: { ...replacement.document, textHash: 'a'.repeat(64), sourceRetrievedAt: new Date().toISOString() } };
    await assert.rejects(put(broken), /check constraint/);
    assert.equal((await lookup(replacement)).textHash, replacement.document.textHash, 'failed generation rolls back original document and passages');
    // Populate accounting-only fixture rows to exercise both eviction bounds
    // without allocating 100 MiB of repeated source text in the test runtime.
    await db.exec(`insert into edgar_private.disclosure_documents(namespace,cik,accession,primary_doc,ticker,form,filing_date,parser_version,text_hash,source_retrieved_at,indexed_at,metadata,total_passages,indexed_passages,complete,payload_bytes)
      select 'production',lpad(i::text,10,'0'),'0000000001-26-'||lpad(i::text,6,'0'),'fixture.htm','FIX','10-K',current_date,1,repeat('b',64),now()-interval '1 day',now()-interval '1 day','{}',1,1,false,200000 from generate_series(1,600) i;`);
    const newest = prepareDisclosureIndexDocument(fixture({ filing: { ...fixture().filing, accession: '0000320193-26-000009' } }));
    assert.equal((await put(newest)).stored, true);
    const stats = (await db.query('select count(*)::int as documents,sum(payload_bytes)::int as bytes from edgar_private.disclosure_documents')).rows[0];
    assert.ok(stats.documents <= 600); assert.ok(stats.bytes <= 104857600);
    const definitions = (await db.query("select prosecdef,proconfig from pg_proc where proname like 'edgar_disclosure_%'")).rows;
    assert.equal(definitions.length, 3); assert.ok(definitions.every(row => !row.prosecdef));
    assert.ok(definitions.every(row => row.proconfig.includes('search_path=""')));
  } finally { await db.close(); }
});
