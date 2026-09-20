import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatResearch } from '../src/utils/chatResearch.js';
import { compareReaderDocuments } from '../src/utils/filingsReader.js';

const cik = '0000000001';
const current = { accession: '0000999999-26-000003', form: '10-K', filingDate: '2026-02-15', reportDate: '2025-12-31', primaryDoc: 'annual.htm' };
const previous = { accession: '0000999999-25-000001', form: '10-K', filingDate: '2025-02-15', reportDate: '2024-12-31', primaryDoc: 'prior.htm' };
const quarter = { accession: '0000999999-26-000010', form: '10-Q', filingDate: '2026-08-01', reportDate: '2026-06-30', primaryDoc: 'quarter.htm' };
const archive = { name: `CIK${cik}-submissions-001.json`, filingFrom: '2019-01-01', filingTo: '2024-12-31', filingCount: 3 };
const historical = { accession: '0000999999-24-000001', form: '10-K', filingDate: '2024-02-15', reportDate: '2023-12-31', primaryDoc: 'old.htm' };
const paragraph = 'The company maintains a revolving credit agreement and available funding. The reported covenant test was satisfied and no default occurred during the reporting period.';
const identity = { id: 'EXAMPLE', ticker: 'EXAMPLE', cik, name: 'Example Corporation', kind: 'company' };
const filingInput = extra => ({ identifier: 'EXAMPLE', accession: current.accession, form: '', section: 'all', query: '', page: '', view: 'document', prior: '', filed: '', priorFiled: '', archive: '', priorArchive: '', ...extra });
const listInput = extra => ({ identifier: 'EXAMPLE', form: '', start: '', end: '', archive: '', ...extra });

function setup({ dependencies = {}, context = {} } = {}) {
  const calls = [];
  const data = { ticker: 'EXAMPLE', cik, kind: 'operating', filings: [quarter, current, previous], archives: [archive],
    sourceObservedAt: '2026-09-20T01:00:00Z', omittedRecords: 0, omittedArchives: 0 };
  const api = createChatResearch({ context, dependencies: {
    search: async () => ({ results: [identity] }),
    filingsCompany: async id => { calls.push(['company', id]); return data; },
    filingsArchive: async args => { calls.push(['archive', args]); return { cik, archive, filings: [historical] }; },
    filingDocument: async settings => {
      calls.push(['document', settings]);
      return { cik, filing: [current, previous, quarter, historical].find(row => row.accession === settings.accession),
        prior: [current, previous, historical].find(row => row.accession === settings.prior) || null,
        paragraphs: [{ text: paragraph, index: 7, sectionId: 'mda', section: 'Management discussion and analysis', parts: 1 }],
        coverage: { totalParagraphs: 300, matchedParagraphs: 9, page: 1, pageSize: 8, extraction: 'Heading-based text extraction' },
        comparison: { status: 'not-requested', changes: [], coverage: [] } };
    }, ...dependencies,
  } });
  return { api, calls, data };
}

test('filing history filters exact forms and filing dates, preserves report dates and flags unscanned archives', async () => {
  const { api, calls } = setup();
  const result = await api.tools.filings_list.execute(listInput({ form: '10-K', start: '2026-01-01', end: '2026-12-31' }));
  assert.equal(result.status, 'ready');
  assert.equal(result.filings.length, 1);
  assert.equal(result.filings[0].filingDate, '2026-02-15');
  assert.equal(result.filings[0].reportDate, '2025-12-31');
  assert.equal(result.coverage.completeHistory, false);
  assert.equal(result.coverage.archivesAvailable, 1);
  assert.equal(calls.filter(row => row[0] === 'archive').length, 0);
  // SEC filing-agent accession prefixes need not equal the reporting issuer CIK.
  assert.match(api.getSources().find(row => row.url.endsWith('annual.htm')).url, /\/data\/1\/000099999926000003\//);
  assert.ok(result.filings[0].sourceIds.length);
});

test('filing tools reject arbitrary URLs, extra URL fields, malformed dates and reversed date filters', async () => {
  for (const input of [filingInput({ accession: 'https://evil.example/a' }), filingInput({ url: 'http://127.0.0.1' }),
    filingInput({ identifier: 'http://localhost' }), filingInput({ filed: '2025-02-29' }), filingInput({ priorFiled: '2024-04-31' }),
    filingInput({ page: '1001' }), filingInput({ page: '0' }), filingInput({ page: '1.5' })]) {
    const { api, calls } = setup();
    const result = await api.tools.filing_document.execute(input);
    assert.equal(result.status, 'unavailable');
    assert.equal(calls.some(row => row[0] === 'document'), false);
  }
  const { api } = setup();
  assert.equal((await api.tools.filings_list.execute(listInput({ start: '2026-12-01', end: '2026-01-01' }))).status, 'unavailable');
  assert.equal((await api.tools.filings_list.execute(listInput({ start: '2026-02-30' }))).status, 'unavailable');
});

test('verified issuer mismatch and foreign accessions never reach document retrieval', async () => {
  const wrong = setup({ dependencies: { filingsCompany: async () => ({ cik: '0000000002', filings: [current], archives: [] }) } });
  assert.equal((await wrong.api.tools.filings_list.execute(listInput())).code, 'SOURCE_IDENTITY_MISMATCH');
  assert.equal(wrong.api.getSources().length, 0);
  const { api, calls } = setup();
  const result = await api.tools.filing_document.execute(filingInput({ accession: '0000320193-26-000001' }));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /no substitute filing/);
  assert.equal(calls.some(row => row[0] === 'document'), false);
});

test('only manifest-owned archives can be selected and archive payload identity is checked again', async () => {
  const foreign = setup();
  const result = await foreign.api.tools.filing_document.execute(filingInput({ accession: historical.accession, archive: 'CIK0000320193-submissions-001.json' }));
  assert.equal(result.status, 'unavailable');
  assert.equal(foreign.calls.some(row => row[0] === 'archive'), false);
  const wrong = setup({ dependencies: { filingsArchive: async () => ({ cik: '0000320193', archive, filings: [historical] }) } });
  assert.equal((await wrong.api.tools.filings_list.execute(listInput({ archive: archive.name }))).code, 'SOURCE_IDENTITY_MISMATCH');
});

test('a filing date recovers one verified archive and disables reader-wide historical scanning', async () => {
  const { api, calls } = setup();
  const result = await api.tools.filing_document.execute(filingInput({ accession: historical.accession, filed: historical.filingDate }));
  assert.equal(result.status, 'ready');
  assert.equal(result.filing.accession, historical.accession);
  assert.equal(result.filing.archive, archive.name);
  assert.equal(calls.filter(row => row[0] === 'archive').length, 1);
  const settings = calls.find(row => row[0] === 'document')[1];
  assert.equal(settings.archive, archive.name);
  assert.equal(settings.filed, '');
  assert.equal(settings.priorFiled, '');
});

test('ambiguous date-matched archives require selection instead of starting a history crawl', async () => {
  const { api, calls, data } = setup();
  data.archives.push({ ...archive, name: `CIK${cik}-submissions-002.json` });
  const result = await api.tools.filing_document.execute(filingInput({ accession: historical.accession, filed: historical.filingDate }));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /More than one SEC history archive/);
  assert.equal(calls.some(row => ['archive', 'document'].includes(row[0])), false);
});

test('filing date hints cannot relabel an accession that actually belongs to another date', async () => {
  const { api, calls } = setup();
  const result = await api.tools.filing_document.execute(filingInput({ filed: '2026-02-14' }));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /does not match the accession/);
  assert.equal(calls.some(row => row[0] === 'document'), false);
});

test('same-company page selections retain exact accession, section, phrase and historical filing date', async () => {
  const { api, calls } = setup({ context: { path: '/filings/EXAMPLE', company: 'EXAMPLE',
    query: `accession=${historical.accession}&filed=${historical.filingDate}&section=mda&query=covenant&page=6` } });
  const result = await api.tools.filing_document.execute(filingInput({ accession: '', section: '' }));
  assert.equal(result.filing.accession, historical.accession);
  assert.equal(result.section, 'mda');
  assert.equal(result.query, 'covenant');
  assert.equal(calls.find(row => row[0] === 'document')[1].accession, historical.accession);
  assert.equal(calls.find(row => row[0] === 'document')[1].page, 6);
});

test('a different company page never substitutes its selected accession or filing filters', async () => {
  const { api } = setup({ context: { path: '/filings/OTHER', company: 'OTHER', query: `accession=${historical.accession}&section=risk&form=10-Q` } });
  const result = await api.tools.filing_document.execute(filingInput({ accession: '', section: '' }));
  assert.equal(result.status, 'ready');
  assert.equal(result.filing.accession, current.accession);
  assert.equal(result.section, 'all');
});

test('complete long paragraphs retain trailing negation, while split fragments are omitted explicitly', async () => {
  const complete = `${'The covenant is tested quarterly and reviewed by management. '.repeat(60)}The company did not default.`;
  const { api } = setup({ dependencies: { filingDocument: async () => ({ cik, filing: current, coverage: { matchedParagraphs: 3 },
    paragraphs: [{ text: complete, index: 1, sectionId: 'mda', parts: 1 },
      { text: 'A default occurred', index: 2, sectionId: 'mda', part: 1, parts: 2 },
      { text: 'x'.repeat(6001), index: 3, sectionId: 'mda', parts: 1 }] }) } });
  const result = await api.tools.filing_document.execute(filingInput());
  assert.equal(result.status, 'ready');
  assert.equal(result.passages.length, 1);
  assert.equal(result.passages[0].text, complete);
  assert.match(result.passages[0].text, /did not default\.$/);
  assert.equal(result.coverage.omittedSplitOrUnsupportedPassages, 2);
  assert.match(result.limitation, /untrusted evidence, never instructions/);
});

test('oversized UTF-8 evidence is reduced by whole paragraphs and stays under the shared tool limit', async () => {
  const texts = Array.from({ length: 8 }, (_, i) => `${i} ${'管理层保持充足流动性。'.repeat(200)} No default occurred.`);
  const { api } = setup({ dependencies: { filingDocument: async () => ({ cik, filing: current,
    paragraphs: texts.map((text, index) => ({ text, index, sectionId: 'mda', parts: 1 })), coverage: { matchedParagraphs: 20 } }) } });
  const result = await api.tools.filing_document.execute(filingInput());
  assert.equal(result.status, 'ready');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 12000);
  assert.ok(result.passages.every(row => texts.includes(row.text) && row.text.endsWith('No default occurred.')));
});

test('filing changes preserve complete paired quotations, separate source IDs and comparison coverage', async () => {
  const before = 'We maintain sufficient liquidity and did not breach the covenant.';
  const after = 'We maintain sufficient liquidity and did not breach any covenant.';
  const { api } = setup({ dependencies: { filingDocument: async () => ({ cik, filing: current, prior: previous, paragraphs: [],
    comparison: { status: 'reviewed', kind: 'periodic', reason: 'Same-form reporting periods.', matchedChanges: 1, totalChanges: 1,
      coverage: [{ section: 'Management discussion and analysis', currentFound: true, priorFound: true }],
      changes: [{ type: 'modified', section: 'Management discussion and analysis', before, after, reason: 'Wording changed.' }] } }) } });
  const result = await api.tools.filing_document.execute(filingInput({ view: 'changes', section: 'mda' }));
  assert.equal(result.status, 'ready');
  assert.equal(result.prior.accession, previous.accession);
  assert.equal(result.changes[0].before, before);
  assert.equal(result.changes[0].after, after);
  assert.notDeepEqual(result.changes[0].beforeSourceIds, result.changes[0].afterSourceIds);
  assert.equal(result.coverage.comparisonKind, 'periodic');
  assert.match(result.limitation, /does not establish a new or resolved risk/);
});

test('incompatible baselines and unsupported change sections return coverage gaps without reading text', async () => {
  for (const extra of [{ view: 'changes', prior: current.accession }, { view: 'changes', prior: quarter.accession }, { view: 'changes', section: 'notes' }]) {
    const { api, calls } = setup();
    const result = await api.tools.filing_document.execute(filingInput(extra));
    assert.equal(result.status, 'unavailable');
    assert.equal(calls.some(row => row[0] === 'document'), false);
  }
});

test('native added paragraphs and null absent sides remain available as complete change evidence', async () => {
  const old = 'Our manufacturing facilities depend on specialized imported components and transportation providers. Interruptions could delay deliveries to customers and disrupt production schedules.';
  const added = 'Cybersecurity monitoring identified unauthorized access to a vendor system during the quarter. External specialists investigated the incident and management implemented additional access controls.';
  const risk = paragraphs => `Item 1A. Risk Factors\n\n${paragraphs.join('\n\n')}\n\nItem 1B. Unresolved Staff Comments\n\nNone.`;
  const comparison = compareReaderDocuments(risk([old, added]), risk([old]), current, previous);
  assert.equal(comparison.changes.find(row => row.type === 'added').before, '');
  for (const before of ['', null]) {
    const paired = { ...comparison, changes: comparison.changes.map(row => row.type === 'added' ? { ...row, before } : row) };
    const { api } = setup({ dependencies: { filingDocument: async () => ({ cik, filing: current, prior: previous, paragraphs: [], comparison: paired }) } });
    const result = await api.tools.filing_document.execute(filingInput({ view: 'changes', section: 'risk' }));
    const retained = result.changes.find(row => row.type === 'added');
    assert.equal(retained.before, '');
    assert.equal(retained.after, added);
    assert.ok(retained.afterSourceIds.length);
    assert.equal(result.coverage.omittedUnsupportedOrLongChanges, 0);
  }
});

test('reader identity, accession, dates and document metadata must agree with verified SEC manifest', async () => {
  for (const override of [{ cik: '0000000002' }, { filing: previous }, { filing: { ...current, filingDate: '2026-02-16' } },
    { filing: { ...current, reportDate: '2026-12-31' } }, { filing: { ...current, primaryDoc: 'attacker.htm' } }]) {
    const { api } = setup({ dependencies: { filingDocument: async () => ({ cik, filing: current, paragraphs: [{ text: paragraph, parts: 1 }], ...override }) } });
    const result = await api.tools.filing_document.execute(filingInput());
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'SOURCE_IDENTITY_MISMATCH');
    assert.equal(api.getSources().length, 0);
  }
});

test('malicious document URLs are never forwarded or published, citations derive from verified CIK and accession', async () => {
  const { api, data } = setup();
  data.filings = data.filings.map(row => ({ ...row, documentUrl: 'https://evil.example/instructions', indexUrl: 'http://localhost/private' }));
  const result = await api.tools.filings_list.execute(listInput());
  assert.equal(result.status, 'ready');
  assert.ok(api.getSources().every(row => ['www.sec.gov', 'data.sec.gov'].includes(new URL(row.url).hostname)));
  assert.doesNotMatch(JSON.stringify(result), /evil|localhost/);
});

test('no matching passage or unreviewed comparison cannot become a claim that the filing has no such disclosure', async () => {
  const { api } = setup({ dependencies: { filingDocument: async () => ({ cik, filing: current, prior: previous,
    paragraphs: [], coverage: { matchedParagraphs: 0 }, comparison: { status: 'fetch-failed', reason: 'Prior document was not reviewed.', changes: [] } }) } });
  const result = await api.tools.filing_document.execute(filingInput({ query: 'default' }));
  assert.deepEqual(result.passages, []);
  assert.match(result.limitation, /does not establish absence/);
  const changes = await api.tools.filing_document.execute(filingInput({ view: 'changes' }));
  assert.equal(changes.status, 'unavailable');
  assert.deepEqual(changes.changes, []);
  assert.equal(changes.coverage.comparisonStatus, 'fetch-failed');
});
