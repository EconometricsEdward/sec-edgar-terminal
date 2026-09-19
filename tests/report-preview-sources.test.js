import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicReportSources, reportPreviewSecUrl, usesPublicReportSources } from '../src/utils/reportPreviewSources.js';
import { buildAnalysisCompany } from '../src/utils/analysisResearch.js';
import { project13FDelivery } from '../src/utils/thirteenFDelivery.js';

const NOW = Date.parse('2026-09-19T18:00:00.000Z');
const CIK = '0000000100', SERIES = 'S000000123', ACCESSION = '0000000100-26-000001';
const fundHtml = `<title>EDGAR Series Results</title>Found 1 records<table>
<tr><td><a href="/cgi-bin/browse-edgar?CIK=${CIK}">${CIK}</a></td><td><a href="/cgi-bin/browse-edgar?CIK=${CIK}">Noncatalog Trust</a></td></tr>
<tr><td><a href="/cgi-bin/browse-edgar?CIK=${SERIES}">${SERIES}</a></td><td><a href="/cgi-bin/browse-edgar?CIK=${SERIES}">Noncatalog Global Portfolio</a></td></tr></table>`;
const fundXml = `<edgarSubmission><genInfo><regCik>${CIK}</regCik><regName>Noncatalog Trust</regName><seriesName>Noncatalog Global Portfolio</seriesName><seriesId>${SERIES}</seriesId><repPdDate>2026-06-30</repPdDate></genInfo><fundInfo><totAssets>10000</totAssets><totLiabs>0</totLiabs><netAssets>10000</netAssets><cshNotRptdInCorD>0</cshNotRptdInCorD></fundInfo><invstOrSecs>${Array.from({ length: 125 }, (_, i) => `<invstOrSec><name>Holding ${i}</name><valUSD>10</valUSD><pctVal>0.1</pctVal><assetCat>EC</assetCat><invCountry>US</invCountry><payoffProfile>Long</payoffProfile></invstOrSec>`).join('')}</invstOrSecs></edgarSubmission>`;
const submissions = { cik: Number(CIK), name: 'Noncatalog Trust', filings: { recent: { form: ['NPORT-P'], accessionNumber: [ACCESSION],
  filingDate: ['2026-08-24'], reportDate: ['2026-06-30'], primaryDocument: ['primary_doc.xml'] } } };
function sourceFixture() {
  const calls = [];
  const fetchPublic = async (input, options) => {
    const url = new URL(input); calls.push(url);
    assert.equal(url.origin, 'https://secedgarterminal.com');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    assert.equal(options.cache, 'no-store'); assert.ok(options.signal);
    const path = url.searchParams.get('path') || '';
    if (path === '/files/company_tickers.json') return Response.json({ 0: { cik_str: 1, title: 'Independent Company', ticker: 'ZZZ' } });
    if (path === '/files/company_tickers_mf.json') return Response.json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[100, SERIES, 'C000000123', 'ZZZFX']] });
    if (path.includes('view=mutual-fund')) return new Response(fundHtml);
    if (path.startsWith('/submissions/')) return Response.json(submissions);
    if (path.includes('output=atom')) return new Response(`<feed><entry><accession-number>${ACCESSION}</accession-number><filing-date>2026-08-24</filing-date><filing-type>NPORT-P</filing-type></entry></feed>`);
    if (path.endsWith('/primary_doc.xml')) return new Response(fundXml);
    throw new Error(`Unexpected public endpoint ${url.pathname} ${path}`);
  };
  return { calls, sources: createPublicReportSources({ fetchPublic, now: () => NOW }) };
}

test('public source adapter is preview-only and SEC paths are narrowly allowlisted', () => {
  assert.equal(usesPublicReportSources({ VERCEL_ENV: 'preview' }), true);
  for (const env of [{}, { VERCEL_ENV: 'production' }, { VERCEL_ENV: 'development' }]) assert.equal(usesPublicReportSources(env), false);
  for (const input of ['http://www.sec.gov/files/company_tickers.json', 'https://evil.example/files/company_tickers.json',
    'https://www.sec.gov@evil.example/files/company_tickers.json', 'https://u:p@www.sec.gov/files/company_tickers.json',
    'https://www.sec.gov/robots.txt', 'https://data.sec.gov/submissions/CIK0000000000.json',
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=S000000123&view=mutual-fund&scd=series&count=100&redirect=evil',
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&action=getcompany&CIK=S000000123&view=mutual-fund&scd=series&count=100'])
    assert.throws(() => reportPreviewSecUrl(input), { status: 400 });
  const url = reportPreviewSecUrl('https://www.sec.gov/files/company_tickers.json');
  assert.equal(url.origin, 'https://secedgarterminal.com'); assert.equal(url.pathname, '/api/sec');
  assert.equal(url.searchParams.get('path'), '/files/company_tickers.json');
});

test('preview search uses full public directories and preserves exact ticker/series identities', async () => {
  const { sources } = sourceFixture();
  const company = await sources.searchReports({ kind: 'company', query: 'ZZZ' });
  assert.equal(company.results[0].id, 'ZZZ');
  const fund = await sources.searchReports({ kind: 'nport', query: 'ZZZFX' });
  assert.equal(fund.results[0].seriesId, SERIES);
  const named = await sources.searchReports({ kind: 'nport', query: 'Noncatalog Global' });
  assert.equal(named.results[0].name, 'Noncatalog Global Portfolio'); assert.match(named.warning, /one distinctive word/);
});

test('full N-PORT reports load all raw positions without browser pagination or remote cache writes', async () => {
  for (const id of ['ZZZFX', SERIES]) {
    const { sources, calls } = sourceFixture();
    const report = await sources.prepareReport({ kind: 'nport', id, basis: 'annual' }, AbortSignal.timeout(10000));
    assert.equal(report.entity.id, id); assert.equal(report.entity.seriesId, SERIES);
    assert.equal(report.coverage.recordCount, 125);
    assert.equal(report.sections.find(section => section.id === 'all-holdings').rows.length, 125);
    assert.equal(calls.length, 4);
    assert.ok(calls.every(url => url.pathname === '/api/sec'));
  }
});

test('company public analysis retains source clocks and rejects mismatched ticker or basis', async () => {
  const fact = { val: 123, start: '2025-01-01', end: '2025-12-31', form: '10-K', filed: '2026-02-01', fy: 2025, fp: 'FY', accn: '0000000001-26-000001' };
  const payload = buildAnalysisCompany({ ticker: 'ZZZ', cik: '0000000001', companyName: 'Independent Company', sic: 3571,
    filings: [], facts: { 'us-gaap': { Revenues: { units: { USD: [fact] } } } } }, { basis: 'annual' });
  const sources = createPublicReportSources({ now: () => NOW, fetchPublic: async input => {
    assert.equal(new URL(input).pathname, '/api/analysis-research');
    return Response.json(payload, { headers: { 'X-Data-Fetched-At': '2026-09-01T12:00:00Z', 'X-Data-Revalidated-At': '2026-09-18T12:00:00Z', 'X-Data-Stale': 'true' } });
  } });
  const report = await sources.prepareReport({ kind: 'company', id: 'ZZZ', basis: 'annual' });
  assert.equal(report.coverage.status, 'partial');
  assert.ok(report.notes.some(note => note.includes('2026-09-01')));
  assert.ok(report.notes.some(note => note.includes('2026-09-18')));
  await assert.rejects(sources.prepareReport({ kind: 'company', id: 'OTHER', basis: 'annual' }), /did not match/);
  await assert.rejects(sources.prepareReport({ kind: 'company', id: 'ZZZ', basis: 'quarter' }), /did not match/);
});

test('13F public delivery verifies complete positions and exact manager identity', async () => {
  const data = { status: 'ready', manager: { cik: CIK, name: 'Noncatalog Manager' }, selectedPeriod: '2026-06-30', observedAt: '2026-09-18T12:00:00.000Z',
    coverage: { selectedPeriodComplete: true }, portfolio: { cik: CIK, period: '2026-06-30', complete: true, positionCount: 1, entryCount: 1,
      totalValueUsd: 100, amendmentCount: 0, holdings: [{ key: '123:SH', issuer: 'Holding', cusip: '001234567', quantityType: 'SH', valueUsd: 100, quantity: 1, weightPct: 100 }],
      filings: [{ accession: ACCESSION, form: '13F-HR', filingDate: '2026-08-24', indexUrl: `https://www.sec.gov/Archives/edgar/data/100/000000010026000001/${ACCESSION}-index.html` }] } };
  let payload = project13FDelivery(data);
  const sources = createPublicReportSources({ now: () => NOW, fetchPublic: async input => {
    const url = new URL(input); assert.equal(url.pathname, '/api/fund-13f'); assert.equal(url.searchParams.get('delivery'), 'full');
    return Response.json(payload);
  } });
  const report = await sources.prepareReport({ kind: '13f', id: CIK, basis: 'annual' });
  assert.equal(report.coverage.recordCount, 1);
  payload = { ...payload, portfolio: { ...payload.portfolio, holdings: [] } };
  await assert.rejects(sources.prepareReport({ kind: '13f', id: CIK, basis: 'annual' }), /complete holdings/);
  await assert.rejects(sources.prepareReport({ kind: '13f', id: '0000000200', basis: 'annual' }), /did not match/);
});

test('source errors, declared oversized bodies and invalid input fail before report creation', async () => {
  let calls = 0;
  const sources = createPublicReportSources({ fetchPublic: async () => { calls++; return new Response('unavailable', { status: 503 }); } });
  await assert.rejects(sources.prepareReport({ kind: 'company', id: 'https://evil.example', basis: 'annual' }), { status: 400 });
  assert.equal(calls, 0);
  await assert.rejects(sources.prepareReport({ kind: 'company', id: 'ZZZ', basis: 'annual' }), { status: 503 });
  const big = createPublicReportSources({ fetchPublic: async () => new Response('{}', { headers: { 'content-length': String(41 * 1024 * 1024) } }) });
  await assert.rejects(big.prepareReport({ kind: 'company', id: 'ZZZ', basis: 'annual' }), { status: 413 });
});
