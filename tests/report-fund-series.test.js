import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportSeriesFundLoader } from '../src/utils/reportFundSeriesServer.js';
import { createFundLoader } from '../src/utils/fundResearchServer.js';
import { createFundResearchCache } from '../src/utils/fundResearchCache.js';
import { buildNportReport } from '../src/utils/fundReport.js';

const SERIES = 'S000006027', CIK = '0000819118', ACCESSION = '0000035402-26-004626';
const CLOCK = Date.parse('2026-09-19T16:00:00.000Z');
const html = (series = SERIES, cik = CIK) => `<title>EDGAR Series Results</title>Found 1 records<table>
  <tr><td><a href="/cgi-bin/browse-edgar?CIK=${cik}">${cik}</a></td><td><a href="/cgi-bin/browse-edgar?CIK=${cik}">Fidelity Trust</a></td></tr>
  <tr><td><a href="/cgi-bin/browse-edgar?CIK=${series}">${series}</a></td><td><a href="/cgi-bin/browse-edgar?CIK=${series}">Exact Series Portfolio</a></td></tr></table>`;
const xml = (series = SERIES, cik = CIK) => `<edgarSubmission><genInfo><regCik>${cik}</regCik><regName>Fidelity Trust</regName><seriesName>Exact Series Portfolio</seriesName><seriesId>${series}</seriesId><repPdDate>2026-05-31</repPdDate></genInfo><fundInfo><totAssets>1000</totAssets><totLiabs>0</totLiabs><netAssets>1000</netAssets><cshNotRptdInCorD>0</cshNotRptdInCorD></fundInfo><invstOrSecs><invstOrSec><name>Holding</name><valUSD>1000</valUSD><pctVal>100</pctVal><assetCat>EC</assetCat><invCountry>US</invCountry><payoffProfile>Long</payoffProfile></invstOrSec></invstOrSecs></edgarSubmission>`;
function fixture({ search = html(), document = xml() } = {}) {
  const calls = [];
  const fetchSec = async (url, options) => {
    calls.push(url); assert.ok(options.signal); assert.equal(options.cache, 'no-store');
    if (url.includes('view=mutual-fund')) return new Response(search);
    if (url.includes('/submissions/')) return Response.json({ cik: Number(CIK), name: 'Fidelity Trust', filings: { recent: {
      form: ['NPORT-P'], accessionNumber: [ACCESSION], filingDate: ['2026-07-24'], reportDate: ['2026-05-31'], primaryDocument: ['primary_doc.xml'],
    } } });
    if (url.includes('browse-edgar')) return new Response(`<feed><entry><accession-number>${ACCESSION}</accession-number><filing-date>2026-07-24</filing-date><filing-type>NPORT-P</filing-type></entry></feed>`);
    if (url.endsWith('/primary_doc.xml')) return new Response(document);
    throw new Error(`Unexpected URL ${url}`);
  };
  return { calls, fetchSec, load: createReportSeriesFundLoader({ fetchSec, now: () => CLOCK }) };
}

test('exact SEC series loading verifies registrant and portfolio without guessing a ticker or class', async () => {
  const { load, calls } = fixture();
  const data = await load(SERIES);
  assert.equal(data.status, 'ready');
  assert.equal(data.ticker, SERIES);
  assert.equal(data.seriesId, SERIES);
  assert.equal(data.classId, null);
  assert.equal(data.cik, CIK);
  assert.equal(data.identity, 'SEC series matched');
  assert.equal(data.holdings.length, 1);
  assert.ok(calls.some(url => url.includes(`CIK=${SERIES}&view=mutual-fund`)));
  assert.ok(calls.some(url => url.includes(`CIK=${SERIES}&type=NPORT-P`)));
  const report = buildNportReport(data);
  assert.equal(report.entity.id, SERIES);
  assert.equal(report.entity.ticker, undefined);
  assert.equal(report.entity.name, 'Exact Series Portfolio');
  await load(SERIES);
  assert.equal(calls.length, 4, 'Independent prepared series cache avoids a second SEC fetch');
});

test('series lookup rejects a neighboring series, conflicting owner, or blocked SEC search before loading a portfolio', async () => {
  for (const search of [html('S000099999'), html(SERIES, '0000999999'), '<title>SEC.gov | Request threshold</title>']) {
    const { load } = fixture({ search });
    await assert.rejects(load(SERIES), /matched to one registrant|incomplete fund filing metadata|unrecognized/);
  }
});

test('exact-series report rejects XML for a sibling series or different registrant', async () => {
  for (const document of [xml('S000099999'), xml(SERIES, '0000999999')]) {
    const { load } = fixture({ document });
    await assert.rejects(load(SERIES), /series does not match|registrant does not match/);
  }
});

test('ordinary ticker loader keeps its required share-class check and series-only entry rejects other identifiers', async () => {
  const { fetchSec } = fixture();
  const cache = createFundResearchCache({ enabled: () => false, now: () => CLOCK });
  const ordinary = createFundLoader({ fundLookup: async () => ({ cik: CIK, seriesId: SERIES, classId: null }),
    fetchSec, cache, now: () => CLOCK });
  await assert.rejects(ordinary(SERIES), /identity could not be verified/);
  const { load } = fixture();
  for (const id of ['FXAIX', CIK, 'S123', 'S000006027;']) await assert.rejects(load(id), { status: 400 });
});
