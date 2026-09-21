import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerDealerResearchLoader, createBrokerDealerFilingReader } from '../src/utils/brokerDealerResearch.js';

const cik = '0000003001';
const filing = (number, filingDate = '2026-03-02', form = 'X-17A-5') => ({ accession: `0000950170-26-${String(number).padStart(6, '0')}`, form, filingDate, reportDate: '2025-12-31', primaryDoc: 'primary_doc.xml' });
const archive = (number, filingFrom = '2025-01-01', filingTo = '2025-12-31') => ({ name: `CIK${cik}-submissions-${String(number).padStart(3, '0')}.json`, filingFrom, filingTo, filingCount: 1 });
const company = (filings = [], archives = []) => ({ cik, ticker: cik, kind: 'filer', name: 'Example Broker LLC', filings, archives, observedAt: '2026-09-21T00:00:00Z', coverage: { omittedRecords: 0 } });

test('research rejects malformed saved selections before loading a filer', async () => {
  let calls = 0;
  const load = createBrokerDealerResearchLoader({ loadCompany: async () => { calls++; return company(); } });
  for (const options of [{ accession: '../other' }, { archive: '../CIK0000003001-submissions-001.json' }, { filed: '2026-02-30' }]) await assert.rejects(load(cik, options), { status: 400 });
  assert.equal(calls, 0);
});

test('an accession must occur in this filer manifest, and its prefix need not equal the registrant CIK', async () => {
  const current = filing(1); let read = 0;
  const load = createBrokerDealerResearchLoader({ loadCompany: async () => company([current]), readFiling: async (resolved, selected) => { read++; assert.equal(resolved.cik, cik); assert.equal(selected, current); return { analysis: { status: 'ready' } }; } });
  const result = await load(cik, { accession: current.accession, filed: current.filingDate });
  assert.equal(result.status, 'available');
  assert.equal(read, 1);
  await assert.rejects(load(cik, { accession: filing(2).accession }), { status: 404 });
  await assert.rejects(load(cik, { accession: current.accession, filed: '2026-03-03' }), { status: 404 });
  assert.equal(read, 1, 'Unverified saved selections cannot reach document extraction');
});

test('only X-17A-5 originals and amendments enter broker-dealer research', async () => {
  const current = filing(3, '2026-08-28', 'X-17A-5/A'), unrelated = filing(4, '2026-09-01', '10-K');
  const load = createBrokerDealerResearchLoader({ loadCompany: async () => company([current, unrelated]), readFiling: async () => { throw new Error('Metadata-only lookup cannot extract'); } });
  assert.equal((await load(cik, { metadataOnly: true })).filing.accession, current.accession);
  await assert.rejects(load(cik, { accession: unrelated.accession, metadataOnly: true }), { status: 422 });
  const absent = await createBrokerDealerResearchLoader({ loadCompany: async () => company([unrelated]) })(cik, { metadataOnly: true });
  assert.equal(absent.status, 'not-applicable');
  assert.equal(absent.coverage.complete, true);
});

test('saved archived selections are loaded from the verified manifest and retain archive provenance', async () => {
  const history = archive(1), selected = filing(5, '2025-08-28');
  const calls = [];
  const load = createBrokerDealerResearchLoader({ loadCompany: async () => company([filing(6)], [history]), loadArchive: async (identifier, name, options) => {
    calls.push({ identifier, name, options });
    return { cik, archive: history, filings: [selected] };
  } });
  const result = await load(cik, { accession: selected.accession, archive: history.name, filed: selected.filingDate, metadataOnly: true, refresh: true });
  assert.equal(result.filing.accession, selected.accession);
  assert.equal(result.filing.archive, history.name);
  assert.equal(calls[0].identifier, cik);
  assert.equal(calls[0].options.refresh, true);
  assert.equal(result.coverage.archivesChecked, 1);
  assert.equal(result.coverage.complete, true);
  await assert.rejects(load(cik, { archive: 'CIK0000003002-submissions-001.json', metadataOnly: true }), { status: 400 });
  assert.equal(calls.length, 1);
});

test('another filer archive payload cannot resolve or expose a requested accession', async () => {
  const history = archive(2), selected = filing(7, '2025-08-28'); let reads = 0;
  const load = createBrokerDealerResearchLoader({ loadCompany: async () => company([], [history]), loadArchive: async () => ({ cik: '0000003002', archive: history, filings: [selected] }), readFiling: async () => { reads++; } });
  await assert.rejects(load(cik, { accession: selected.accession, archive: history.name }), { status: 502 });
  assert.equal(reads, 0);
});

test('latest discovery checks only archives that could be newer and retains failure coverage', async () => {
  const current = filing(8, '2026-03-02'), newer = filing(9, '2026-08-28');
  const oldHistory = archive(3), newerHistory = archive(4, '2026-01-01', '2026-09-01');
  const calls = [];
  const load = createBrokerDealerResearchLoader({ loadCompany: async () => company([current], [oldHistory, newerHistory]), loadArchive: async (_, name) => { calls.push(name); return { cik, archive: newerHistory, filings: [newer] }; } });
  const result = await load(cik, { metadataOnly: true });
  assert.deepEqual(calls, [newerHistory.name]);
  assert.equal(result.filing.accession, newer.accession);
  assert.equal(result.coverage.complete, true);
  const partial = await createBrokerDealerResearchLoader({ loadCompany: async () => company([current], [newerHistory]), loadArchive: async () => { throw new Error('SEC unavailable'); } })(cik, { metadataOnly: true });
  assert.equal(partial.filing.accession, current.accession);
  assert.equal(partial.coverage.complete, false);
  assert.deepEqual(partial.coverage.failedArchives, [newerHistory.name]);
});

test('incomplete archive discovery cannot claim there are no broker-dealer annual reports', async () => {
  const history = archive(5);
  const load = createBrokerDealerResearchLoader({ loadCompany: async () => company([], [history]), loadArchive: async () => { throw new Error('SEC unavailable'); } });
  await assert.rejects(load(cik, { metadataOnly: true }), { status: 502 });
});

test('saved accession search bounded before all candidate archives reports temporary incompleteness, not definitive absence', async () => {
  const archives = Array.from({ length: 9 }, (_, index) => archive(index + 10)); let calls = 0;
  const load = createBrokerDealerResearchLoader({ loadCompany: async () => company([], archives), loadArchive: async (_, name) => { calls++; return { cik, archive: archives.find(item => item.name === name), filings: [] }; } });
  await assert.rejects(load(cik, { accession: filing(99).accession, metadataOnly: true }), { status: 502 });
  assert.equal(calls, 8);
});


test('selected periodic attachment retains its own family and dates within annual filing context', async () => {
  const selected = filing(60);
  const text = 'FOCUS REPORT\nPART II\nUNAUDITED\nFor the period beginning October 1, 2025 and ending December 31, 2025\nStatement of Financial Condition\nDecember 31, 2025\nTotal assets $1,000\nTotal liabilities 800\nMembers equity 200';
  const read = createBrokerDealerFilingReader({ loadDocument: async () => ({
    cover: { part: 'Part III', periodBegin: '2025-01-01', reportDate: '2025-12-31', accountantName: 'Annual Auditor' },
    selectedDocument: { name: 'quarter.pdf', url: 'https://www.sec.gov/Archives/edgar/data/3001/000095017026000060/quarter.pdf' },
    pages: [{ pageNumber: 1, text }], extraction: { limitations: [] },
  }) });
  const result = await read(company([selected]), selected);
  assert.equal(result.classification.family, 'periodic-focus');
  assert.equal(result.classification.period.start, '2025-10-01');
  assert.equal(result.filing.periodBegin, '2025-10-01');
  assert.equal(result.classification.audit.status, 'explicitly-unaudited');
  assert.equal(result.filing.classification.family, 'annual-report');
  assert.equal(result.filing.classification.audit.status, 'not-established');
  assert.equal(result.analysis.classification.family, 'periodic-focus');
  assert.equal(result.analysis.basis, 'quarter');
  assert.ok(!result.analysis.limitations.some(value => /amended annual|Public annual reports/.test(value)));
});

test('annual-only consumers inspect unknown candidates but do not substitute a newer periodic filing', async () => {
  const periodic = { ...filing(62, '2026-08-28'), description: 'Part II' };
  const annual = filing(61, '2026-03-02');
  const reads = [];
  const load = createBrokerDealerResearchLoader({ loadCompany: async () => company([periodic, annual]), readFiling: async (_, selected) => {
    reads.push(selected.accession);
    return { filing: selected, classification: { family: selected.accession === annual.accession ? 'annual-report' : 'periodic-focus' }, analysis: {} };
  } });
  const result = await load(cik, { family: 'annual-report' });
  assert.equal(result.filing.accession, annual.accession);
  assert.deepEqual(reads, [periodic.accession, annual.accession]);
  await assert.rejects(load(cik, { accession: periodic.accession, family: 'annual-report' }), { status: 422 });
});


test('annual-only lookup can find the annual attachment within a mixed accession without relabeling a periodic document', async () => {
  const selected = { ...filing(63), description: 'Part II' };
  const reads = [];
  const load = createBrokerDealerResearchLoader({ loadCompany: async () => company([selected]), readFiling: async (_, row, options) => {
    reads.push(options.document || 'periodic.pdf');
    return { filing: row, selectedDocument: { name: options.document || 'periodic.pdf' },
      classification: { family: options.document === 'annual.pdf' ? 'annual-report' : 'periodic-focus' }, analysis: {},
      documents: [{ name: 'periodic.pdf', format: 'pdf', classification: { family: 'periodic-focus' } }, { name: 'annual.pdf', format: 'pdf', classification: { family: 'annual-report' } }] };
  } });
  const result = await load(cik, { family: 'annual-report', accession: selected.accession });
  assert.equal(result.selectedDocument.name, 'annual.pdf');
  assert.deepEqual(reads, ['periodic.pdf', 'annual.pdf']);
  await assert.rejects(load(cik, { family: 'annual-report', accession: selected.accession, document: 'periodic.pdf' }), { status: 422 });
});
