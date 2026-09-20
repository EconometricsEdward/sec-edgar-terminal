import test from 'node:test';
import assert from 'node:assert/strict';
import { readFilingReaderSelection, resolveFilingReaderSelection } from '../src/utils/filingReaderSelection.js';

const accession = '0000999999-26-000003';
const prior = '0000999999-25-000002';
const currentRow = { accession, form: '10-K', filingDate: '2026-02-15', reportDate: '2025-12-31', primaryDoc: 'annual.htm' };
const priorRow = { accession: prior, form: '10-K', filingDate: '2025-02-15', reportDate: '2024-12-31', primaryDoc: 'prior.htm' };
const archive = { name: 'CIK0000000001-submissions-001.json', filingFrom: '2024-01-01', filingTo: '2025-12-31' };
const company = () => ({ cik: '0000000001', filings: [currentRow, priorRow], archives: [archive] });
const parse = values => readFilingReaderSelection(new URLSearchParams({ accession, ...values }));

test('public filing links preserve exact reader filters and reject malformed or duplicate selectors', () => {
  assert.equal(readFilingReaderSelection('?form=10-K'), null);
  assert.deepEqual(parse({ prior, view: 'changes', section: 'mda', query: 'covenant (waiver)', page: '4', filed: '2026-02-15' }),
    { accession, prior, view: 'changes', section: 'mda', query: 'covenant (waiver)', page: 4, filed: '2026-02-15', priorFiled: '', archive: '', priorArchive: '' });
  for (const fields of [{ accession: 'https://evil.example' }, { prior: '../private' }, { archive: 'https://sec.gov/../../private' },
    { filed: '2025-02-29' }, { priorFiled: '2026-04-31' }, { page: '1001' }, { page: '0' }, { page: '1.5' },
    { section: 'https://evil.example' }, { view: 'fetch' }, { query: 'x'.repeat(201) }]) assert.throws(() => parse(fields));
  assert.throws(() => readFilingReaderSelection(`accession=${accession}&accession=${prior}`));
  const sanitized = parse({ url: 'http://127.0.0.1/private', primaryDoc: '../secret', query: 'https://example.org' });
  assert.equal('url' in sanitized, false);
  assert.equal('primaryDoc' in sanitized, false);
  // Queries are literal text, never requests, and may discuss a disclosed URL.
  assert.equal(sanitized.query, 'https://example.org');
});

test('recent linked accession and prior are resolved without loading any archives', async () => {
  const result = await resolveFilingReaderSelection(parse({ prior, view: 'changes', section: 'risk', page: '3' }), company(), () => {
    assert.fail('Recent filings must not load historical archives');
  });
  assert.equal(result.filing, currentRow);
  assert.equal(result.prior, priorRow);
  assert.deepEqual(result.initialSelection, { view: 'changes', section: 'risk', query: '', page: 3 });
  assert.deepEqual(result.archives, {});
});

test('historical link loads one manifest-owned archive, validates its CIK and retains returned archive identity', async () => {
  const data = company(); data.filings = [currentRow];
  const calls = [];
  const result = await resolveFilingReaderSelection(parse({ prior, priorFiled: '2025-02-15', view: 'changes' }), data, async name => {
    calls.push(name); return { cik: '1', archive, filings: [priorRow] };
  });
  assert.deepEqual(calls, [archive.name]);
  assert.equal(result.prior.archive, archive.name);
  assert.ok(result.archives[archive.name]);
  await assert.rejects(resolveFilingReaderSelection(parse({ prior, priorArchive: archive.name }), data,
    async () => ({ cik: '0000000002', archive, filings: [priorRow] })), /did not match/);
});

test('foreign or ambiguous archives and mismatching filing dates never silently open substitute filings', async () => {
  let reads = 0;
  const loader = async () => { reads++; return { cik: '1', archive, filings: [priorRow] }; };
  const data = company(); data.filings = [currentRow];
  await assert.rejects(resolveFilingReaderSelection(parse({ archive: 'CIK0000320193-submissions-001.json' }), data, loader), /does not belong/);
  await assert.rejects(resolveFilingReaderSelection(parse({ filed: '2026-02-16' }), data, loader), /matching dates/);
  await assert.rejects(resolveFilingReaderSelection(parse({ accession: '0000320193-26-000001' }), data, loader), /matching dates/);
  data.archives.push({ ...archive, name: 'CIK0000000001-submissions-002.json' });
  await assert.rejects(resolveFilingReaderSelection(parse({ prior, priorFiled: '2025-02-15' }), data, loader), /Several SEC archives/);
  assert.equal(reads, 0);
});

test('current and prior selections in one archive deduplicate the metadata load', async () => {
  let reads = 0;
  const data = company(); data.filings = []; data.archives[0] = { ...archive, filingTo: '2026-12-31' };
  const result = await resolveFilingReaderSelection(parse({ archive: archive.name, prior, priorArchive: archive.name }), data, async () => {
    reads++; return { cik: '1', archive: data.archives[0], filings: [currentRow, priorRow] };
  });
  assert.equal(reads, 1);
  assert.equal(result.filing.archive, archive.name);
  assert.equal(result.prior.archive, archive.name);
});
