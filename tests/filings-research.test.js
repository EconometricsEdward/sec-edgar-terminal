import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILINGS_SETTINGS, filingFamily, normalizeFilingRows, mergeFilings,
  normalizeFilingsSettings, readFilingsSettings, filingPath, filterFilings,
  summarizeFilingMonths, summarizeFilingFamilies, selectFilingBaseline,
} from '../src/utils/filingsResearch.js';
import { loadFilingsCompany, loadFilingsArchive, normalizeFilingsArchives } from '../src/utils/filingsResearchServer.js';

const acc = (n, year = '26') => `0000000001-${year}-${String(n).padStart(6, '0')}`;
const filing = (n, form = '10-Q', filed = '2026-08-05', report = '2026-06-30', extra = {}) => ({
  accession: acc(n), form, filingDate: filed, reportDate: report, primaryDoc: `report${n}.htm`,
  primaryDescription: '', items: '', family: filingFamily(form), isAmendment: form.endsWith('/A'), ...extra,
});
const rows = (filings) => ({
  accessionNumber: filings.map((f) => f.accession), form: filings.map((f) => f.form),
  filingDate: filings.map((f) => f.filingDate), reportDate: filings.map((f) => f.reportDate),
  primaryDocument: filings.map((f) => f.primaryDoc), primaryDocDescription: filings.map((f) => f.primaryDescription),
  items: filings.map((f) => f.items), size: filings.map((f) => f.size),
});

test('Filings retains every form family and counts foreign current reports only once', () => {
  const forms = ['10-K', '10-Q/A', '8-K/A', '6-K', '4', '4/A', 'SC 13G', '13F-HR', 'DEF 14A', 'S-3', '424B2', 'CORRESP', 'NT 10-K'];
  const normalized = normalizeFilingRows(rows(forms.map((form, i) => filing(i + 1, form))), '0000000001');
  assert.equal(normalized.length, forms.length);
  assert.equal(filingFamily('6-K'), 'current');
  assert.equal(filingFamily('4/A'), 'insider');
  assert.equal(filingFamily('DEF 14A'), 'proxy');
  assert.equal(filingFamily('NT 10-K'), 'other');
  assert.equal(summarizeFilingFamilies(normalized).reduce((sum, family) => sum + family.count, 0), forms.length);
});
test('Filings rejects malformed identities and dates while preserving filings missing primary documents', () => {
  const data = rows([
    filing(1), filing(2, '8-K', '2026-02-30'), filing(3, '4', '2026-09-03', '', { primaryDoc: '../escape.htm' }),
    filing(4, 'CORRESP', '2026-09-02', '', { primaryDoc: '' }),
  ]);
  data.accessionNumber.push('bad-accession'); data.form.push('10-K'); data.filingDate.push('2026-09-01');
  const normalized = normalizeFilingRows(data, '0000000001');
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].primaryDoc, '');
  assert.equal(normalized[0].documentUrl, '');
  assert.match(normalized[0].indexUrl, /\/1\/000000000126000003\/0000000001-26-000003-index.html$/);
  assert.deepEqual(normalizeFilingRows(data, 'evil/1'), []);
  assert.deepEqual(normalizeFilingRows({}, '0000000001'), []);
});
test('Filings merges overlapping archives by accession and keeps recent metadata', () => {
  const recent = filing(1, '8-K', '2026-08-31', '', { items: '2.02,9.01', primaryDescription: 'Earnings release' });
  const sameDay = filing(2, '4', '2026-08-31');
  const result = mergeFilings([recent], [{ ...recent, items: '', primaryDescription: '' }, sameDay, filing(3, '10-Q', '2026-05-01')]);
  assert.deepEqual(result.map((f) => f.accession), [acc(2), acc(1), acc(3)]);
  assert.equal(result[1].primaryDescription, 'Earnings release');
  assert.equal(result[1].items, '2.02,9.01');
});
test('Filings metadata filters combine dates, exact item labels, amendments and review status', () => {
  const list = [
    filing(1, '8-K', '2026-08-01', '', { items: '2.02,9.01' }),
    filing(2, '8-K/A', '2026-08-03', '', { items: '2.02,9.01' }),
    filing(3, '10-Q', '2026-08-05'), filing(4, '4', '2026-07-01', '', { items: '2.02' }),
  ];
  assert.deepEqual(filterFilings(list, { query: 'earnings release', item: '2.02', amendments: 'only' }).map((f) => f.accession), [acc(2)]);
  assert.equal(filterFilings(list, { start: '2026-08-02', end: '2026-08-05', family: 'current', amendments: 'exclude' }).length, 0);
  assert.equal(filterFilings(list, { item: '2.02' }).length, 2, 'An item on a non-8-K row cannot match');
  assert.equal(filterFilings(list, { start: '2026-09-01', end: '2026-08-01' }).length, 0);
  const records = { [acc(1)]: { reviewedAt: '2026-09-01T12:00:00Z' }, [acc(2)]: { queued: true } };
  assert.equal(filterFilings(list, { status: 'reviewed' }, records)[0].accession, acc(1));
  assert.equal(filterFilings(list, { status: 'queued' }, records)[0].accession, acc(2));
  assert.equal(filterFilings(list, { status: 'unreviewed' }, records).length, 3);
});
test('Filings settings share the full research view and reject invalid settings', () => {
  const settings = normalizeFilingsSettings({ query: '"earnings release" 9.01', family: 'current', form: '8-k/a', start: '2026-08-01', end: '2026-08-31', item: '2.02', amendments: 'only', status: 'queued', sort: 'oldest', view: 'timeline' });
  const path = filingPath('jpm', settings);
  assert.match(path, /^\/filings\/JPM\?/);
  assert.deepEqual(readFilingsSettings(path.split('?')[1]), settings);
  const invalid = normalizeFilingsSettings({ start: '2026-02-30', item: 'javascript:', family: 'invalid', form: '<script>', view: 'invalid' });
  assert.deepEqual(invalid, FILINGS_SETTINGS);
});
test('Filings chronological sort and month summaries use filing dates, not reporting dates', () => {
  const list = [filing(1, '10-K', '2026-02-01', '2025-12-31'), filing(2, '10-Q', '2026-08-01'), filing(3, '10-Q/A', '2026-08-02')];
  assert.deepEqual(filterFilings(list, {}).map((f) => f.accession), [acc(3), acc(2), acc(1)]);
  assert.deepEqual(filterFilings(list, { sort: 'oldest' }).map((f) => f.accession), [acc(1), acc(2), acc(3)]);
  const late = filing(4, '10-Q', '2026-09-01', '2025-09-30');
  assert.deepEqual(filterFilings([...list, late], { sort: 'report' }).map((f) => f.accession), [acc(3), acc(2), acc(1), acc(4)]);
  assert.deepEqual(summarizeFilingMonths(list), [
    { month: '2026-08', count: 2, amendments: 1, families: { quarterly: 2 } },
    { month: '2026-02', count: 1, amendments: 0, families: { annual: 1 } },
  ]);
});
test('Filings comparisons distinguish prior reporting period, annual season and same-period amendments', () => {
  const current = filing(8);
  const original = filing(7, '10-Q', '2026-05-02', '2026-03-31');
  const amendedPrevious = filing(6, '10-Q/A', '2026-07-01', '2026-03-31');
  const annualSeason = filing(4, '10-Q', '2025-08-01', '2025-06-30');
  const lateOlder = filing(5, '10-Q', '2026-07-02', '2025-09-30');
  const list = [current, original, amendedPrevious, annualSeason, lateOlder];
  assert.equal(selectFilingBaseline(current, list).prior.accession, original.accession);
  assert.equal(selectFilingBaseline(current, list, { comparison: 'year' }).prior.accession, annualSeason.accession);
  const amendment = filing(9, '10-Q/A', '2026-08-07');
  assert.equal(selectFilingBaseline(amendment, [...list, amendment]).prior.accession, current.accession);
  assert.equal(selectFilingBaseline(filing(10, '8-K', '2026-08-10'), list).prior, null);
  assert.equal(selectFilingBaseline({ ...amendment, reportDate: '' }, list).prior, null);
});
test('Filings archive manifest rejects another issuer, traversal, invalid ranges and duplicate names', () => {
  const good = { name: 'CIK0000000001-submissions-001.json', filingFrom: '2020-01-01', filingTo: '2025-12-31', filingCount: 100 };
  assert.deepEqual(normalizeFilingsArchives([
    good, good, { ...good, name: 'CIK0000000002-submissions-001.json' },
    { ...good, name: '../CIK0000000001-submissions-002.json' },
    { ...good, name: 'CIK0000000001-submissions-003.json', filingFrom: '2026-12-31' },
  ], '0000000001'), [good]);
});
test('Filings loaders preserve exact issuer, verify archived ownership, distinguish failed lookup and route funds', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  const archive = { name: 'CIK0000000001-submissions-001.json', filingFrom: '2020-01-01', filingTo: '2025-12-31', filingCount: 1 };
  let directoryFails = true;
  let malformedResponse = true;
  let incompleteManifest = false;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith('company_tickers.json')) {
      if (directoryFails) return new Response('unavailable', { status: 503 });
      return Response.json({ 0: { ticker: 'JPM', cik_str: 1, title: 'JPM exact issuer' }, 1: { ticker: 'AMJB', cik_str: 1, title: 'Associated security' }, 2: { ticker: 'BAD', cik_str: 2, title: 'Bad response' } });
    }
    if (String(url).endsWith('company_tickers_mf.json')) return Response.json({ data: [[3, 'S1', 'C1', 'TESTETF']] });
    if (String(url).endsWith('CIK0000000001.json')) return Response.json({ cik: '1', name: 'JPMORGAN CHASE', sic: '6021', exchanges: ['NYSE'], filings: { recent: rows([filing(2)]), files: [archive] } });
    if (String(url).endsWith(archive.name)) return Response.json(rows([filing(1, '4', '2025-12-31', '', { primaryDoc: 'xslF345X05/ownership.xml' })]));
    if (String(url).endsWith('CIK0000000002.json')) return Response.json({ cik: malformedResponse ? '99' : '2', name: 'Retried issuer', filings: { recent: rows([]), ...(incompleteManifest ? {} : { files: [] }) } });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await assert.rejects(loadFilingsCompany('JPM'), (error) => error.status === 502 && error.code === 'SEC_UNAVAILABLE');
    directoryFails = false;
    const company = await loadFilingsCompany('jpm');
    assert.equal(company.ticker, 'JPM');
    assert.equal(company.cik, '0000000001');
    assert.equal(company.name, 'JPMORGAN CHASE');
    assert.equal(company.filings.length, 1);
    assert.deepEqual(company.archives, [archive]);
    assert.ok(!requested.some((url) => url.includes('companyfacts')));
    const older = await loadFilingsArchive('JPM', archive.name);
    assert.equal(older.filings[0].form, '4');
    assert.equal(older.filings[0].archive, archive.name);
    await assert.rejects(loadFilingsArchive('JPM', 'CIK0000000002-submissions-001.json'), (error) => error.code === 'INVALID_ARCHIVE');
    assert.ok(!requested.some((url) => url.endsWith('CIK0000000002-submissions-001.json')));
    await assert.rejects(loadFilingsCompany('MISSING'), (error) => error.status === 404 && error.code === 'UNKNOWN_TICKER');
    assert.equal((await loadFilingsCompany('TESTETF')).redirect, '/fund/TESTETF');
    await assert.rejects(loadFilingsCompany('BAD'), /did not match/);
    malformedResponse = false;
    incompleteManifest = true;
    await assert.rejects(loadFilingsCompany('BAD'), /incomplete archive manifest/);
    incompleteManifest = false;
    assert.equal((await loadFilingsCompany('BAD')).name, 'Retried issuer', 'Malformed responses are not cached and cannot poison a retry');
  } finally { globalThis.fetch = originalFetch; }
});
