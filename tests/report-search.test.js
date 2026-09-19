import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportSearch, parseReportSearch, parseReportFundSearch } from '../src/utils/reportSearchServer.js';
import { GET } from '../src/app/api/reports/search/route.js';

const CIK = '0000036405', SERIES = 'S000002848';
const companies = { TT: { cik: '0001466258', name: 'Trane Technologies plc' }, F: { cik: '0000037996', name: 'FORD MOTOR CO' },
  VTI: { cik: CIK, name: 'VANGUARD INDEX FUNDS' }, TESTX: { cik: CIK, name: 'A fund directory alias' } };
const funds = { VTI: { cik: CIK, seriesId: SERIES, classId: 'C000007807' },
  VTSAX: { cik: CIK, seriesId: SERIES, classId: 'C000007808' },
  TESTX: { cik: CIK, seriesId: 'S000099999', classId: 'C000099999' } };
const owner = (cik = CIK, name = 'VANGUARD INDEX FUNDS') => `<tr><td><a href="/cgi-bin/browse-edgar?CIK=${cik}">${cik}</a></td><td><a href="/cgi-bin/browse-edgar?CIK=${cik}">${name}</a></td></tr>`;
const series = (id = SERIES, name = 'Vanguard Total Stock Market Index Fund') => `<tr><td><a href="/cgi-bin/browse-edgar?CIK=${id}">${id}</a></td><td><a href="/cgi-bin/browse-edgar?CIK=${id}&amp;scd=series">${name}</a></td></tr>`;
const page = (body = owner() + series(), count = 1) => `<title>EDGAR Series Results</title>Found ${count} records (limited to 4000).<table>${body}</table>`;
const setup = (overrides = {}) => createReportSearch({ operatingDirectory: async () => companies, fundDirectory: async () => funds,
  fetchSec: async () => new Response(page()), filerSearch: async query => ({ query, results: [], truncated: false }), ...overrides });

test('strict report searches accept names, single-letter company symbols, CIK and SEC series', () => {
  assert.deepEqual(parseReportSearch(new URLSearchParams({ q: ' F ', kind: 'company' })), { query: 'F', kind: 'company', cik: null });
  assert.equal(parseReportSearch(new URLSearchParams({ q: 'CIK 36405', kind: 'nport' })).cik, CIK);
  assert.equal(parseReportSearch(new URLSearchParams({ q: ' S000002848 ', kind: 'nport' })).query, SERIES);
  for (const params of ['q=AAPL&q=MSFT&kind=company', 'q=AAPL&kind=company&x=1', 'q=AAPL&kind=other', 'q=0&kind=company', 'q=12345678901&kind=company', 'q=%3Cscript%3E&kind=company', 'q=https://sec.gov&kind=company'])
    assert.throws(() => parseReportSearch(new URLSearchParams(params)), { status: 400 });
});

test('company directory covers non-example issuers and never labels a known fund a company', async () => {
  const search = setup();
  assert.equal((await search({ query: 'Trane', kind: 'company' })).results[0].ticker, 'TT');
  assert.equal((await search({ query: 'F', kind: 'company' })).results[0].ticker, 'F');
  assert.equal((await search({ query: 'VTI', kind: 'company' })).results.length, 0);
  assert.equal((await search({ query: 'TESTX', kind: 'company' })).results.length, 0);
});

test('company CIK lookup keeps unlisted issuer CIK without inventing a ticker', async () => {
  const search = setup({ filerSearch: async query => ({ query, results: [{ cik: '0000123456', name: 'Unlisted Issuer', formTypes: [] }], truncated: false }) });
  const result = await search({ query: '123456', kind: 'company' });
  assert.equal(result.results[0].id, '0000123456');
  assert.equal(result.results[0].ticker, undefined);
  assert.equal((await search({ query: 'Unlisted Issuer', kind: 'company' })).results[0].id, '0000123456');
});

test('every mapped N-PORT ticker works without curated names or a fund-name fetch', async () => {
  const search = setup({ fetchSec: async () => { throw new Error('Exact ticker must not trigger name search'); } });
  const result = await search({ query: 'testx', kind: 'nport' });
  assert.equal(result.results[0].ticker, 'TESTX');
  assert.equal(result.results[0].seriesId, 'S000099999');
  assert.equal(result.results[0].cik, CIK);
});

test('live SEC names join on both CIK and series, retaining separate share-class choices', async () => {
  const calls = [];
  const search = setup({ fundDirectory: async () => ({ ...funds, WRONG: { cik: '0000999999', seriesId: SERIES, classId: 'C000007809' } }),
    fetchSec: async (url, options) => { calls.push({ url, options }); return new Response(page()); } });
  const result = await search({ query: 'Vanguard Total Stock', kind: 'nport' });
  assert.deepEqual(result.results.map(item => item.ticker), ['VTI', 'VTSAX']);
  assert.equal(result.results[0].name, 'Vanguard Total Stock Market Index Fund');
  assert.equal(new URL(calls[0].url).searchParams.get('scname'), 'Vanguard Total Stock');
  assert.equal(new URL(calls[0].url).searchParams.get('view'), 'mutual-fund');
  assert.equal(calls[0].options.maxBytes, 2 * 1024 * 1024);
});

test('fund parser preserves registrant boundaries, entities, and rejects a donorless/conflicting series', () => {
  const second = 'S000012345', secondCik = '0000999999';
  const parsed = parseReportFundSearch(page(owner() + series() + owner(secondCik, 'Other &amp; Trust') + series(second, 'Growth &amp; Income'), 2));
  assert.equal(parsed.series[1].cik, secondCik);
  assert.equal(parsed.series[1].name, 'Growth & Income');
  assert.throws(() => parseReportFundSearch(page(series())), /without a verified registrant/);
  assert.throws(() => parseReportFundSearch(page(owner() + series() + owner(secondCik) + series())), /conflicting/);
  assert.throws(() => parseReportFundSearch('<title>SEC.gov | Request Rate Threshold Exceeded</title>'), /unrecognized/);
  assert.throws(() => parseReportFundSearch('<title>EDGAR Series Results</title>Broken response'), /coverage/);
  assert.equal(parseReportFundSearch(page('', 0)).series.length, 0);
  assert.equal(parseReportFundSearch(page().replace('Found 1 records (limited to 4000).', 'Items 1 - 8')).series[0].seriesId, SERIES);
});

test('13F names exclude non-reporting similarly named entities; notices remain explicit', async () => {
  const search = setup({ filerSearch: async query => ({ query, results: [
    { cik: '0001747057', name: 'D1 Capital Partners L.P.', formTypes: ['13F-HR'] },
    { cik: '0001745259', name: 'D1 Capital Partners Onshore LP', formTypes: [] },
    { cik: '0001234567', name: 'D1 Related Manager', formTypes: ['13F-NT'] },
  ], truncated: false }) });
  const result = await search({ query: 'D1 Capital', kind: '13f' });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].id, '0001747057');
  assert.match(result.results[1].detail, /notice filer/);
});

test('fund CIK, class, and series never choose an arbitrary sibling portfolio', async () => {
  const search = setup();
  assert.deepEqual((await search({ query: SERIES, kind: 'nport' })).results.map(item => item.id), ['VTI', 'VTSAX']);
  assert.deepEqual((await search({ query: 'C000007808', kind: 'nport' })).results.map(item => item.id), ['VTSAX']);
  assert.equal((await search({ query: CIK, kind: 'nport' })).results.length, 3);
});

test('source failure retains exact fund directory identities without masquerading as a complete name search', async () => {
  const search = setup({ fetchSec: async () => new Response('Unavailable', { status: 503 }) });
  const result = await search({ query: SERIES, kind: 'nport' });
  assert.equal(result.results.length, 2);
  assert.match(result.warning, /names are temporarily unavailable/);
  assert.deepEqual(result.warnings, [result.warning]);
  await assert.rejects(search({ query: 'Vanguard Total Stock', kind: 'nport' }), { status: 503 });
  await assert.rejects(search({ query: 'S000000001', kind: 'nport' }), { status: 503 });
});

test('unmapped fund series stay exact SEC series choices and never inherit another series ticker', async () => {
  const search = setup({ fetchSec: async () => new Response(page(owner() + series('S000000001'))) });
  const result = await search({ query: 'Vanguard Total Stock', kind: 'nport' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, 'S000000001');
  assert.equal(result.results[0].ticker, undefined);
  assert.equal(result.results[0].cik, CIK);
  assert.match(result.results[0].detail, /No ticker required/);
  const exact = await search({ query: 'S000000001', kind: 'nport' });
  assert.equal(exact.results[0].id, 'S000000001');
});

test('bounded cache deduplicates in-flight work, normalizes key, clones results and releases failures', async () => {
  let calls = 0, clock = 0;
  const search = setup({ now: () => clock, ttlMs: 100, maxEntries: 1, operatingDirectory: async () => { calls++; return companies; } });
  const [first, second] = await Promise.all([search({ query: 'Trane', kind: 'company' }), search({ query: 'trane', kind: 'company' })]);
  assert.equal(calls, 1);
  assert.equal(second.query, 'trane');
  first.results[0].name = 'Mutated';
  assert.equal((await search({ query: 'TRANE', kind: 'company' })).results[0].name, 'Trane Technologies plc');
  await search({ query: 'Ford', kind: 'company' });
  await search({ query: 'Trane', kind: 'company' });
  assert.equal(calls, 3);
  clock = 101;
  await search({ query: 'Trane', kind: 'company' });
  assert.equal(calls, 4);
  let failures = 0;
  const retry = setup({ operatingDirectory: async () => { if (++failures === 1) throw new Error('Source down'); return companies; } });
  await assert.rejects(retry({ query: 'TT', kind: 'company' }));
  assert.equal((await retry({ query: 'TT', kind: 'company' })).results.length, 1);
});

test('search result limit is explicit and does not silently omit broader matches', async () => {
  const entries = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`X${index}`, { cik: String(1000 + index).padStart(10, '0'), name: `Independent ${index}` }]));
  const result = await setup({ operatingDirectory: async () => entries })({ query: 'Independent', kind: 'company' });
  assert.equal(result.results.length, 20);
  assert.equal(result.truncated, true);
});

test('route rejects unbounded or duplicate parameters before any SEC work', async () => {
  const response = await GET(new Request('https://example.com/api/reports/search?kind=company&q=AAPL&q=MSFT'));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
});
