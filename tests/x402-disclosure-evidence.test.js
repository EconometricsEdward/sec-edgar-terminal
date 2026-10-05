import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { paidDisclosureEvidenceSelection, createPaidDisclosureEvidenceReader } from '../src/utils/x402DisclosureEvidence.js';
import { X402_DISCLOSURE_EVIDENCE_SCHEMA } from '../src/utils/x402DisclosureEvidenceSchema.js';

const at = Date.parse('2026-10-04T15:00:00Z');
const now = () => at;
const selected = (query = 'liquidity', parameters = {}) => paidDisclosureEvidenceSelection(new Request(
  `https://secedgarterminal.com/api/x402/v1/disclosure-evidence?${new URLSearchParams({ query, ...parameters })}`), { now });
const coverage = { documents: 2, passages: 30, oldestFilingDate: '2026-01-01', newestFilingDate: '2026-10-03',
  lastIndexedAt: '2026-10-04T14:00:00Z', retentionDays: 730, rawPayloadBytes: 10000, privateObject: 'secret-index-path' };
function candidate(text = 'Our liquidity position improved during the reporting period.', index = 0, overrides = {}) {
  return { cik: '0000320193', accession: '0000320193-26-000001', primaryDoc: 'aapl-2026.htm', ticker: 'AAPL',
    companyName: 'Apple Inc.', form: '10-K', filingDate: '2026-09-30', reportDate: '2026-06-30',
    parserVersion: 1, sourceRetrievedAt: '2026-10-04T12:00:00Z', indexedAt: '2026-10-04T13:00:00Z',
    textHash: 'a'.repeat(64), indexedPassages: 20, totalPassages: 30, complete: false,
    preparedText: 'secret-full-text', _source: { objectPath: 'secret-source-path' },
    sourceUrl: 'https://private.example/secret', score: 0.8, rank: 1,
    passage: { index, sectionId: 'risk', section: 'Risk Factors', text, internal: 'secret-passage-metadata' }, ...overrides };
}
const results = (rows, overrides = {}) => ({ results: rows, hasMore: false, coverage, ...overrides });
const reader = (rows, options = {}) => createPaidDisclosureEvidenceReader({ search: async () => results(rows), now, ...options });
const schema = new Ajv({ allErrors: true }).compile(X402_DISCLOSURE_EVIDENCE_SCHEMA);

test('selector uses exact CIKs, bounded dates and shared grammar without aliases', () => {
  assert.deepEqual(selected('"material weakness" AND NOT remediation', { ciks: '0000320193,0000789019', forms: '10-K,10-K/A', section: 'risk', limit: '20' }), {
    query: '"material weakness" AND NOT remediation', ciks: ['0000320193', '0000789019'], forms: ['10-K', '10-K/A'],
    section: 'risk', start: '2024-10-04', end: '2026-10-04', offset: 0, limit: 20, format: 'json' });
  const bad = [
    ['NOT breach', {}], ['liquidity OR NOT breach', {}], ['liquid*', {}], ['liquidity AND', {}], ['x', {}], ['liquidity '.repeat(120), {}],
    ['liquidity', { ciks: '320193' }], ['liquidity', { ciks: 'AAPL' }], ['liquidity', { ciks: '0000000000' }],
    ['liquidity', { ciks: '0000320193,0000320193' }], ['liquidity', { ciks: Array.from({ length: 11 }, (_, i) => String(i + 1).padStart(10, '0')).join(',') }],
    ['liquidity', { forms: '10-K,10-k' }], ['liquidity', { forms: '10-K,10-K' }], ['liquidity', { amendments: 'true' }],
    ['liquidity', { section: 'document' }], ['liquidity', { section: '8k:1.5' }], ['liquidity', { start: '2024-10-03' }],
    ['liquidity', { end: '2026-10-05' }], ['liquidity', { start: '2026-02-30' }], ['liquidity', { start: '2026-09-30', end: '2026-01-01' }],
    ['liquidity', { limit: '21' }], ['liquidity', { limit: '0' }], ['liquidity', { limit: '01' }], ['liquidity', { offset: '10000' }],
    ['liquidity', { offset: '-1' }], ['liquidity', { format: 'html' }], ['liquidity', { ticker: 'AAPL' }], ['liquidity', { ciks: '' }],
  ];
  for (const [query, params] of bad) assert.equal(selected(query, params), null, JSON.stringify([query, params]));
  assert.equal(paidDisclosureEvidenceSelection({ url: 'https://example.com/?query=liquidity&query=debt' }, { now }), null);
});

test('exact AND/NOT verification retains the entire qualified paragraph and numeric entities', async () => {
  const qualified = `There is no evidence, after ${'our investigation and independent review '.repeat(25)}, of a cybersecurity breach. Liquidity remains adequate.`;
  const rows = [candidate('Liquidity improved but a material weakness remains.', 0), candidate('Liquidity improved after remediation.', 1), candidate(qualified, 2),
    candidate('Our liquidi&#116;y improved without a material weakness.', 3)];
  const response = await reader(rows)(selected('liquidity AND NOT "material weakness"'));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.rows[1].quote, qualified);
  assert.equal(payload.pagination.rawCandidatesScanned, 4);
  assert.equal(schema(payload), true, JSON.stringify(schema.errors));
  const exact = await (await reader(rows)(selected('cybersecurity AND breach'))).json();
  assert.equal(exact.rows[0].quote, qualified, 'query terms do not turn a negated statement into an affirmative event');
  const decoded = await (await reader([rows[3]])(selected('liquidity'))).json();
  assert.match(decoded.rows[0].quote, /liquidity/);
  assert.equal(decoded.rows[0].fingerprint, createHash('sha256').update(decoded.rows[0].quote).digest('hex'));
});

test('full paragraph context rejects a NOT term far from the positive match', async () => {
  const text = `A material weakness was discussed earlier. ${'Independent review continued throughout the quarter. '.repeat(60)} Liquidity improved.`;
  const response = await reader([candidate(text)])(selected('liquidity AND NOT "material weakness"'));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).pagination.rawCandidatesScanned, 1);
});

test('raw candidate pagination preserves valid overflow matches', async () => {
  const all = [candidate('Liquidity and covenant breach.', 0), candidate('Liquidity remained adequate.', 1),
    candidate('Liquidity and debt.', 2), candidate('Liquidity improved further.', 3)];
  const requests = [];
  const read = createPaidDisclosureEvidenceReader({ now, search: async (settings, options) => {
    requests.push(settings); assert.ok(options.signal);
    return results(all.slice(settings.offset), { hasMore: false });
  } });
  const first = await (await read(selected('liquidity AND NOT breach', { limit: '1' }))).json();
  assert.equal(first.rows[0].index, 1);
  assert.equal(first.pagination.rawCandidatesScanned, 2);
  assert.equal(first.pagination.nextOffset, 2);
  assert.equal(first.pagination.hasMore, true);
  const second = await (await read(selected('liquidity AND NOT breach', { limit: '1', offset: '2' }))).json();
  assert.equal(second.rows[0].index, 2, 'overflow matches are retried on the next raw candidate offset');
  assert.equal(second.pagination.nextOffset, 3);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].limit, 120);
  assert.deepEqual(requests[0].tickers, []);
  assert.deepEqual(requests[0].terms, ['liquidity']);
  const nearWindow = createPaidDisclosureEvidenceReader({ now, search: async settings => {
    assert.equal(settings.limit, 1); return results([all[1]], { hasMore: true });
  } });
  const last = await (await nearWindow(selected('liquidity', { offset: '9999', limit: '1' }))).json();
  assert.equal(last.pagination.hasMore, false);
  assert.equal(last.pagination.windowLimited, true);
  assert.equal(last.pagination.nextOffset, null);
});

test('only reconstructed SEC URLs and explicit public identity fields are delivered', async () => {
  const payload = await (await reader([candidate()])(selected('liquidity'))).json();
  assert.equal(payload.rows[0].sourceUrl, 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-2026.htm');
  assert.equal(payload.rows[0].identityProof, 'retained-sec-document-identifiers');
  assert.equal(payload.coverage.documents, 2);
  assert.equal(payload.coverage.indexedPassages, 30);
  assert.equal(payload.coverage.partial, true);
  assert.equal(payload.rows[0].documentComplete, false);
  assert.doesNotMatch(JSON.stringify(payload), /secret-|private\.example|preparedText|rawPayloadBytes|"score"|"rank"/);
});

test('retained paragraph ordinals can exceed the nonempty paragraph count', async () => {
  // Production retains the parser's ordinal before whitespace-only paragraphs
  // are filtered. Match its independent index bound and PostgreSQL timestamps.
  const row = candidate('Liquidity remains adequate.', 6587, {
    totalPassages: 4298, indexedPassages: 180,
    indexedAt: '2026-10-04T13:00:00.961744+00:00',
  });
  const read = createPaidDisclosureEvidenceReader({ now, search: async () => results([row], {
    coverage: { ...coverage, passages: 200, lastIndexedAt: '2026-10-04T14:00:00.269814+00:00' },
  }) });
  const response = await read(selected());
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.rows[0].index, 6587);
  assert.equal(payload.rows[0].totalPassages, 4298);
  assert.equal(payload.rows[0].indexedPassages, 180);
  assert.equal(payload.rows[0].quote, row.passage.text);
  assert.equal(schema(payload), true, JSON.stringify(schema.errors));
});

test('corrupt source identity, dates, parser and retained paragraph bounds fail closed before delivery', async () => {
  const mutations = [
    row => ({ ...row, cik: '320193' }), row => ({ ...row, accession: 'invalid' }), row => ({ ...row, primaryDoc: '../secret.htm' }),
    row => ({ ...row, primaryDoc: 'https://private.example/secret.htm' }), row => ({ ...row, parserVersion: 2 }),
    row => ({ ...row, form: 'INVALID' }), row => ({ ...row, ticker: '<script>' }), row => ({ ...row, textHash: 'unknown' }),
    row => ({ ...row, filingDate: '2026-02-30' }), row => ({ ...row, filingDate: '2026-10-05' }),
    row => ({ ...row, sourceRetrievedAt: '2026-10-04T16:00:00Z' }), row => ({ ...row, sourceRetrievedAt: '2026-09-01T00:00:00Z' }),
    row => ({ ...row, sourceRetrievedAt: '2026-02-30T00:00:00Z' }), row => ({ ...row, indexedAt: '2026-10-04T11:00:00Z' }),
    row => ({ ...row, indexedAt: '2026-10-04T16:00:00Z' }), row => ({ ...row, complete: true }),
    row => ({ ...row, indexedPassages: 181 }), row => ({ ...row, passage: { ...row.passage, text: 'liquidity '.repeat(700) } }),
    row => ({ ...row, passage: { ...row.passage, text: 'liquidity\u0000' } }), row => ({ ...row, passage: { ...row.passage, index: 200000 } }),
    row => ({ ...row, passage: { ...row.passage, index: -1 } }), row => ({ ...row, passage: { ...row.passage, index: 0.5 } }),
    row => ({ ...row, passage: { ...row.passage, sectionId: 'all' } }), row => ({ ...row, passage: { ...row.passage, sectionId: '8k:1.05' } }),
  ];
  for (const mutate of mutations) {
    const response = await reader([candidate(), mutate(candidate('Liquidity remained adequate.', 1))])(selected('liquidity', { limit: '1' }));
    assert.equal(response.status, 503, JSON.stringify(mutate(candidate())));
  }
  assert.equal((await reader([candidate(), candidate()])(selected())).status, 503, 'duplicate paragraph identities are corrupt');
  assert.equal((await reader([candidate(), candidate('Liquidity improved.', 1, { textHash: 'b'.repeat(64) })])(selected())).status, 503, 'one retained document cannot have conflicting generations');
  assert.equal((await reader([candidate()])(selected('liquidity', { ciks: '0000789019' }))).status, 503, 'RPC selectors are checked against every retained row');
  assert.equal((await reader([candidate()])(selected('liquidity', { forms: '10-Q' }))).status, 503);
});

test('empty exact pages are uncharged 404 with a raw cursor; missing index is uncharged 503', async () => {
  const noMatch = await reader([candidate('Debt obligations were repaid.')], { search: async () => results([candidate('Debt obligations were repaid.')], { hasMore: true }) })(selected());
  assert.equal(noMatch.status, 404);
  const body = await noMatch.json();
  assert.equal(body.code, 'NO_MATCHING_EVIDENCE');
  assert.equal(body.pagination.nextOffset, 1);
  assert.equal(body.pagination.hasMore, true);
  assert.equal((await reader([])(selected())).status, 404);
  for (const response of [null, {}, results([], { hasMore: true }), results([candidate()], { coverage: { ...coverage, lastIndexedAt: 'future' } })]) {
    assert.equal((await reader([], { search: async () => response })(selected())).status, 503);
  }
  assert.equal((await reader([], { search: async () => results([], { coverage: { documents: 0, passages: 0, oldestFilingDate: null, newestFilingDate: null, lastIndexedAt: null, retentionDays: 730 } }) })(selected())).status, 503);
  assert.equal((await reader([], { search: async () => { throw new Error('private-database-credential'); } })(selected())).status, 503);
  let calls = 0;
  const read = createPaidDisclosureEvidenceReader({ now, search: async () => { calls++; return results([]); } });
  assert.equal((await read({ ...selected(), scope: 'document' })).status, 400);
  assert.equal(calls, 0);
});

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\r' && text[i + 1] === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += char;
  }
  return rows;
}

test('CSV preserves the same full evidence and coverage while neutralizing formula-like text', async () => {
  const text = '=Liquidity("adequate")\nThe qualification remains attached.';
  const read = reader([candidate(text, 0, { companyName: '@Malicious issuer' })]);
  const json = await (await read(selected())).json();
  const response = await read(selected('liquidity', { format: 'csv' }));
  assert.match(response.headers.get('Content-Type'), /text\/csv/);
  const [columns, values] = parseCsv(await response.text());
  const csv = Object.fromEntries(columns.map((key, index) => [key, values[index]]));
  assert.equal(csv.quote, `'${json.rows[0].quote}`);
  assert.equal(csv.companyName, `'${json.rows[0].companyName}`);
  for (const key of ['cik', 'accession', 'primaryDoc', 'form', 'sourceUrl', 'sourceRetrievedAt', 'section', 'sectionId', 'fingerprint', 'documentFingerprint']) assert.equal(csv[key], json.rows[0][key]);
  assert.deepEqual(JSON.parse(csv.coverage), json.coverage);
  assert.deepEqual(JSON.parse(csv.pagination), json.pagination);
  assert.deepEqual(JSON.parse(csv.selection), json.selection);
  assert.deepEqual(JSON.parse(csv.limitations), json.limitations);
});

test('implementation uses only the retained data-store candidate query and pure schemas', () => {
  const source = readFileSync(new URL('../src/utils/x402DisclosureEvidence.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ searchDisclosureIndexCandidates \} from '\.\/dataStore\.js'/);
  assert.doesNotMatch(source, /\bfetch\s*\(|tickerMap|searchDisclosurePassageIndex/);
  const schemaSource = readFileSync(new URL('../src/utils/x402DisclosureEvidenceSchema.js', import.meta.url), 'utf8');
  assert.doesNotMatch(schemaSource, /\bimport\b/);
});
