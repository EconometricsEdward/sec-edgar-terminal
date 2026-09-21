import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerDealerHistorySettings, createBrokerDealerHistoryLoader } from '../src/utils/brokerDealerHistory.js';
import { GET } from '../src/app/api/broker-dealer/history/route.js';

const cik = '0001690976';
const filing = (year, extra = {}) => ({ accession: `${cik}-${String(year).slice(-2)}-000001`, form: 'X-17A-5', reportDate: `${year}-06-30`, filingDate: `${year}-08-28`, primaryDoc: 'primary_doc.xml', ...extra });
const archive = (n, from = '2015-01-01', to = '2023-12-31') => ({ name: `CIK${cik}-submissions-${String(n).padStart(3, '0')}.json`, filingFrom: from, filingTo: to });
const company = (filings = [], archives = [], coverage = {}) => ({ cik, ticker: cik, name: 'ASL CAPITAL MARKETS INC.', kind: 'filer', filings, archives, coverage, observedAt: '2026-09-21T00:00:00Z' });
const recent = () => Array.from({ length: 9 }, (_, index) => filing(2026 - index));

test('default catalog selects five distinct most recent periods and keeps older filings adjustable without extracting PDFs', async () => {
  let archiveCalls = 0;
  const load = createBrokerDealerHistoryLoader({ loadCompany: async () => company(recent()), loadArchive: async () => { archiveCalls++; throw new Error('Unexpected archive fetch'); } });
  const data = await load(cik);
  assert.equal(data.filings.length, 9);
  assert.equal(data.periods.length, 9);
  assert.deepEqual(data.selectedFilings.map(row => row.reportDate), [2026, 2025, 2024, 2023, 2022].map(year => `${year}-06-30`));
  assert.equal(data.coverage.selectionComplete, true);
  assert.equal(data.coverage.allHistoryLoaded, true);
  assert.equal(archiveCalls, 0);
  const href = new URL(data.selectedFilings[0].researchHref, 'https://example.test');
  assert.equal(href.pathname, '/api/broker-dealer/report');
  assert.equal(href.searchParams.get('cik'), cik);
  assert.equal(href.searchParams.get('accession'), filing(2026).accession);
  assert.equal(href.searchParams.get('filed'), '2026-08-28');
  assert.equal('filings' in data.company, false, 'Company metadata does not duplicate the SEC manifest');
});

test('latest amendment wins its period, while a recently filed amendment never displaces a newer reporting period', async () => {
  const amendment = filing(2024, { accession: `${cik}-26-000011`, form: 'X-17A-5/A', filingDate: '2026-09-01' });
  const load = createBrokerDealerHistoryLoader({ loadCompany: async () => company([amendment, ...recent()]) });
  const data = await load(cik);
  assert.equal(data.filings.length, 10);
  assert.equal(data.periods.length, 9);
  assert.equal(data.selectedFilings[0].accession, filing(2026).accession);
  assert.equal(data.selectedFilings[2].accession, amendment.accession);
  assert.equal(data.selectedFilings[2].amendmentCount, 1);
  assert.deepEqual(data.selectedFilings[2].versions.map(row => row.accession), [amendment.accession, filing(2024).accession]);
  const exact = await load(cik, { accessions: [filing(2024).accession] });
  assert.equal(exact.selectedFilings[0].form, 'X-17A-5');
});

test('unknown or future report dates remain individually selectable and never become invented annual periods', async () => {
  const unknown = filing(2026, { reportDate: '' });
  const future = filing(2025, { reportDate: '2026-12-31' });
  const load = createBrokerDealerHistoryLoader({ loadCompany: async () => company([unknown, future, filing(2024)]) });
  const data = await load(cik);
  assert.equal(data.selectedFilings[0].reportDate, '');
  assert.equal(data.selectedFilings[0].periodKey, `accession:${unknown.accession}`);
  assert.equal(data.filings.find(row => row.accession === future.accession).reportDate, '');
  assert.equal(data.coverage.unknownPeriods, 2);
  const filtered = await load(cik, { from: '2024-01-01', to: '2026-12-31' });
  assert.deepEqual(filtered.selectedFilings.map(row => row.reportDate), ['2024-06-30']);
  assert.equal(filtered.coverage.selectionComplete, false, 'Unknown dates prevent claiming a complete date-filtered result');
});

test('period dates and counts can be adjusted, and exact selections preserve specified original versions', async () => {
  const load = createBrokerDealerHistoryLoader({ loadCompany: async () => company(recent()) });
  const data = await load(cik, { limit: 2, from: '2019-01-01', to: '2022-12-31' });
  assert.deepEqual(data.selectedFilings.map(row => row.reportDate), ['2022-06-30', '2021-06-30']);
  const exact = await load(cik, { accessions: [filing(2018).accession, filing(2020).accession] });
  assert.deepEqual(exact.selectedFilings.map(row => row.reportDate), ['2020-06-30', '2018-06-30']);
  assert.equal((await load(cik, { limit: 10 })).selectedFilings.length, 9);
});

test('archive discovery fetches only enough recent history for five periods and offers the remaining verified archives', async () => {
  const first = archive(1), older = archive(2, '2010-01-01', '2018-12-31');
  const calls = [];
  const load = createBrokerDealerHistoryLoader({ loadCompany: async () => company([filing(2026), filing(2025)], [older, first]), loadArchive: async (_, name) => {
    calls.push(name);
    return { cik, archive: first, filings: [filing(2023), filing(2022), filing(2021)] };
  } });
  const data = await load(cik);
  assert.deepEqual(calls, [first.name]);
  assert.equal(data.selectedFilings.length, 5);
  assert.equal(data.coverage.selectionComplete, true);
  assert.equal(data.coverage.allHistoryLoaded, false);
  assert.equal(data.coverage.remainingArchives, 1);
  assert.ok(data.archives.find(row => row.name === older.name).historyHref.includes(older.name));
  const oldRow = data.selectedFilings.find(row => row.reportDate === '2021-06-30');
  assert.equal(oldRow.archive, first.name);
  assert.equal(new URL(oldRow.researchHref, 'https://example.test').searchParams.get('archive'), first.name);
});

test('an archive that might contain a late amendment is checked even when five periods are already present', async () => {
  const history = archive(1, '2025-01-01', '2026-09-01');
  const amended = filing(2025, { accession: `${cik}-26-000012`, form: 'X-17A-5/A', filingDate: '2026-09-01' });
  let calls = 0;
  const load = createBrokerDealerHistoryLoader({ loadCompany: async () => company(recent(), [history]), loadArchive: async () => { calls++; return { cik, archive: history, filings: [amended] }; } });
  const data = await load(cik);
  assert.equal(calls, 1);
  assert.equal(data.selectedFilings[1].accession, amended.accession);
});

test('old date ranges and exact archive selections recover filings beyond the default recent five', async () => {
  const history = archive(3, '2014-01-01', '2017-12-31');
  const selected = filing(2016); let calls = 0;
  const load = createBrokerDealerHistoryLoader({ loadCompany: async () => company(recent(), [history]), loadArchive: async (_, name) => { calls++; assert.equal(name, history.name); return { cik, archive: history, filings: [selected] }; } });
  const filtered = await load(cik, { from: '2015-01-01', to: '2017-12-31' });
  assert.deepEqual(filtered.selectedFilings.map(row => row.accession), [selected.accession]);
  const exact = await load(cik, { archive: history.name, accessions: [selected.accession] });
  assert.equal(exact.selectedFilings[0].archive, history.name);
  assert.equal(calls, 2);
});

test('partial archive failures retain readable current records without claiming complete history', async () => {
  const history = archive(1); const load = createBrokerDealerHistoryLoader({ loadCompany: async () => company([filing(2026)], [history]), loadArchive: async () => { throw new Error('SEC unavailable'); } });
  const data = await load(cik);
  assert.equal(data.selectedFilings.length, 1);
  assert.equal(data.coverage.selectionComplete, false);
  assert.deepEqual(data.coverage.failedArchives, [history.name]);
  await assert.rejects(load(cik, { accessions: [filing(2018).accession] }), { status: 502 });
  const absent = createBrokerDealerHistoryLoader({ loadCompany: async () => company([], [history]), loadArchive: async () => { throw new Error('SEC unavailable'); } });
  await assert.rejects(absent(cik), { status: 502 });
});

test('archive identity mismatches cannot expose another filer and missing validated selections do not substitute the latest filing', async () => {
  const history = archive(1);
  const unsafe = createBrokerDealerHistoryLoader({ loadCompany: async () => company([filing(2026)], [history]), loadArchive: async () => ({ cik: '0000000001', archive: history, filings: [filing(2017)] }) });
  const data = await unsafe(cik);
  assert.equal(data.filings.length, 1);
  assert.equal(data.coverage.selectionComplete, false);
  await assert.rejects(unsafe(cik, { accessions: [filing(2017).accession] }), { status: 502 });
  const safe = createBrokerDealerHistoryLoader({ loadCompany: async () => company([filing(2026), filing(2025, { form: '10-K' })]) });
  await assert.rejects(safe(cik, { accessions: [filing(2017).accession] }), { status: 404 });
  await assert.rejects(safe(cik, { accessions: [filing(2025).accession] }), { status: 422 });
});

test('bounded archive discovery and omitted metadata remain incomplete rather than definitive absence', async () => {
  const archives = Array.from({ length: 9 }, (_, index) => archive(index + 1)); let calls = 0;
  const load = createBrokerDealerHistoryLoader({ loadCompany: async () => company([filing(2026)], archives), loadArchive: async (_, name) => { calls++; return { cik, archive: archives.find(row => row.name === name), filings: [] }; } });
  const data = await load(cik);
  assert.equal(calls, 8);
  assert.equal(data.coverage.remainingArchives, 1);
  assert.equal(data.coverage.selectionComplete, false);
  const omitted = createBrokerDealerHistoryLoader({ loadCompany: async () => company(recent(), [], { omittedRecords: 1, omittedArchives: 1 }) });
  assert.equal((await omitted(cik)).coverage.selectionComplete, false);
});

test('invalid selections are rejected before SEC requests and date filters cannot silently override exact accessions', async () => {
  let calls = 0;
  const load = createBrokerDealerHistoryLoader({ loadCompany: async () => { calls++; return company(); } });
  for (const options of [{ limit: 11 }, { limit: 0 }, { limit: 2.5 }, { from: '2026-02-30' }, { from: '2026-01-01', to: '2025-12-31' }, { archive: '../other' }, { accessions: ['../other'] }, { accessions: [filing(2026).accession], to: '2025-01-01' }, { accessions: Array(11).fill(filing(2026).accession) }]) await assert.rejects(load(cik, options), { status: 400 });
  await assert.rejects(load('../other'), { status: 400 });
  assert.equal(calls, 0);
  const settings = brokerDealerHistorySettings(new URLSearchParams(`cik=1690976&accession=${filing(2026).accession},${filing(2025).accession}`));
  assert.equal(settings.identifier, cik);
  assert.equal(settings.limit, 5);
  assert.equal(settings.accessions.length, 2);
});

test('aborted history discovery propagates cancellation rather than returning a partially cached success', async () => {
  const history = archive(1), controller = new AbortController();
  const load = createBrokerDealerHistoryLoader({ loadCompany: async () => company([filing(2026)], [history]), loadArchive: async () => { controller.abort(); controller.signal.throwIfAborted(); } });
  await assert.rejects(load(cik, { signal: controller.signal }), { name: 'AbortError' });
});

test('history query parsing rejects blank, repeated, conflicting and unknown parameters', () => {
  const invalidQueries = [
    'cik=', 'cik=+++', 'ticker=', 'limit=', 'limit=+++', 'from=', 'to=', 'archive=', 'accession=',
    'limit=5&limit=6', 'cik=1690976&cik=1690976', 'ticker=ASL&ticker=ASL',
    'from=2025-01-01&from=2026-01-01', 'to=2026-01-01&to=2026-12-31',
    `archive=${archive(1).name}&archive=${archive(1).name}`,
    'cik=1690976&ticker=ASL', 'cik=1690976&ticker=1690976',
    'unknown=1', 'refresh=true', 'document=statement.pdf', 'limit=1e1', 'limit=0x5', 'limit=5.0',
  ];
  for (const query of invalidQueries) {
    const params = new URLSearchParams(query);
    if (!params.has('cik') && !params.has('ticker')) params.set('cik', cik);
    assert.throws(() => brokerDealerHistorySettings(params), { status: 400 }, query);
  }
  assert.throws(() => brokerDealerHistorySettings(new URLSearchParams()), { status: 400 });
  const ticker = brokerDealerHistorySettings(new URLSearchParams('ticker=brk.b&limit=10'));
  assert.equal(ticker.identifier, 'BRK.B');
  assert.equal(ticker.limit, 10);
  const multiple = brokerDealerHistorySettings(new URLSearchParams(`cik=${cik}&accession=${filing(2026).accession}&accession=${filing(2025).accession}`));
  assert.equal(multiple.accessions.length, 2, 'Repeated accession keys remain supported');
});

test('malformed metadata requests return uncached noindex errors before source requests', async () => {
  const response = await GET(new Request(`https://example.test/api/broker-dealer/history?cik=${cik}&limit=`));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
  assert.match((await response.json()).error, /blank/i);
});
