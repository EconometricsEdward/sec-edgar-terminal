import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildAnalysisCompany, packAnalysisCompany } from '../src/utils/analysisResearch.js';
import { ANALYSIS_VERSION, ANALYSIS_MAPPING_VERSION } from '../src/utils/analysisVersion.js';
import { buildAnalysisDirectory } from '../src/utils/analysisDirectory.js';
import { readAnalysisSettings } from '../src/utils/analysisNotebook.js';
import { createPublicAnalysisReader, publicAnalysisSelection } from '../src/utils/analysisPublicResearch.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const files = {
  brief: '../src/app/analysis/AnalysisResearchBrief.tsx',
  company: '../src/app/analysis/[ticker]/page.tsx',
  directory: '../src/app/analysis/page.tsx',
  sampler: '../src/app/analysis/AnalysisDirectory.tsx',
  broker: '../src/components/broker-dealer/BrokerDealerAnalytics.tsx',
};
const companies = [
  { ticker: 'AAPL', cik: '0000320193', name: 'Apple fixture', sector: 'Technology' },
  { ticker: 'JPM', cik: '0000019617', name: 'JPMorgan fixture', sector: 'Financials' },
  { ticker: 'MSFT', cik: '0000789019', name: 'Microsoft fixture', sector: 'Technology' },
];
const now = Date.now();
const metadata = { fetchedAt: new Date(now - 3600000).toISOString(), revalidatedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 3600000).toISOString() };
function financialModel(basis = 'annual') {
  const duration = (val, year, quarter = false) => ({ val, start: `${year}-${quarter ? '04' : '01'}-01`,
    end: `${year}-${quarter ? '06-30' : '12-31'}`, fy: year, fp: quarter ? 'Q2' : 'FY', form: quarter ? '10-Q' : '10-K',
    filed: `${year + (quarter ? 0 : 1)}-${quarter ? '08' : '02'}-01`, accn: `0000320193-${String(year + (quarter ? 0 : 1)).slice(-2)}-${quarter ? '000002' : '000001'}` });
  const tags = {};
  for (const [tag, current, old, instant] of [
    ['Revenues', 500, 400, false], ['NetIncomeLoss', 50, 30, false], ['OperatingIncomeLoss', 75, 60, false],
    ['NetCashProvidedByUsedInOperatingActivities', 100, 80, false], ['PaymentsToAcquirePropertyPlantAndEquipment', 10, 5, false],
    ['Assets', 1000, 900, true], ['StockholdersEquity', 200, 180, true],
  ]) {
    const rows = [duration(current, 2025), duration(old, 2024), duration(current / 4, 2026, true), duration(old / 4, 2025, true)];
    if (instant) rows.forEach(row => { delete row.start; });
    tags[tag] = { units: { USD: rows } };
  }
  return packAnalysisCompany(buildAnalysisCompany({ ticker: 'AAPL', cik: '0000320193', companyName: 'Apple fixture', sic: 3571,
    facts: { 'us-gaap': tags }, filings: [] }, { basis }));
}
function fixture({ fail = false, available = true, broker = null } = {}) {
  const calls = [], cacheCalls = [], clientProps = [], registryCalls = [], brokerCalls = [];
  const reader = createPublicAnalysisReader({ read: async ({ basis }) => ({ payload: financialModel(basis), metadata }) });
  function compile(kind) {
    const source = readFileSync(new URL(files[kind], import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const testModule = { exports: {} };
    new Function('require', 'module', 'exports', compiled)(name => {
      if (name === 'react/jsx-runtime' || name === 'react') return require(name);
      if (name === 'next/link') return function Link({ prefetch: _prefetch, ...props }) { return createElement('a', props); };
      if (name === 'next/cache') return { unstable_cache: (fn, keys) => (...args) => { cacheCalls.push({ keys, args }); return fn(...args); } };
      if (name === 'next/navigation') return { notFound: () => { throw new Error('NOT_FOUND'); } };
      if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (name.endsWith('/siteMetadata')) return { buildPageMetadata: value => value };
      if (name.endsWith('/cftcFeature.js')) return { isCftcEnabled: () => true };
      if (name.endsWith('/analysisVersion.js')) return { ANALYSIS_VERSION, ANALYSIS_MAPPING_VERSION };
      if (name.endsWith('/analysisDirectory.js')) return { buildAnalysisDirectory };
      if (name.endsWith('/AnalysisDirectory')) return compile('sampler');
      if (name.endsWith('/analysisNotebook.js')) return { readAnalysisSettings };
      if (name.endsWith('/secCoverageRegistry.js')) return {
        loadSecCoverageRegistry: async () => { registryCalls.push('registry'); },
        getActiveSecCoverageCompany: ticker => companies.find(company => company.ticker === ticker),
        getActiveSecCoverageCompanies: () => companies,
      };
      if (name.endsWith('/analysisPublicResearch.js')) return { publicAnalysisSelection,
        readPublicAnalysis: async selection => { calls.push(selection); if (fail) throw new Error('private credentials'); return available ? reader(selection) : { status: 'not-prepared' }; },
      };
      if (name.endsWith('/AnalysisResearchBrief')) return compile('brief');
      if (name.endsWith('/AnalysisWorkspace')) return function Workspace(props) {
        clientProps.push(props); return createElement('div', { id: 'analysis-workspace', 'data-client-ticker': props.urlTicker, 'data-workspace': 'preserved' });
      };
      if (name.endsWith('/CompanySearch')) return function CompanySearch() { return createElement('div', { 'data-company-search': 'preserved' }); };
      if (name.endsWith('/brokerDealerResearch.js')) return { loadBrokerDealerResearch: async (cik, options) => {
        brokerCalls.push({ cik, ...options });
        if (!broker) throw new Error('No broker-dealer fixture was requested');
        return options.metadataOnly ? { ...broker, analysis: undefined } : broker;
      } };
      if (name.endsWith('/BrokerDealerAnalytics')) return compile('broker');
      if (name.endsWith('.css')) return new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : String(key) });
      throw new Error(`Unexpected public page dependency: ${name}`);
    }, testModule, testModule.exports);
    return testModule.exports;
  }
  return { compile, calls, cacheCalls, clientProps, registryCalls, brokerCalls };
}
const props = (query = {}, ticker = 'AAPL') => ({ params: Promise.resolve({ ticker }), searchParams: Promise.resolve(query) });

test('Analysis initial HTML includes actual current/prior financial values, units, reporting dates and SEC evidence without JavaScript', async () => {
  const f = fixture(), page = f.compile('company');
  const html = renderToStaticMarkup(await page.default(props()));
  assert.match(html, /financial highlights/); assert.match(html, /500 USD/); assert.match(html, /400 USD/);
  assert.match(html, /90 USD/); assert.match(html, /calculated/);
  assert.match(html, /2025-12-31/); assert.match(html, /2024-12-31/);
  assert.match(html, /Fiscal 2025 FY/);
  assert.match(html, /Sources checked/); assert.match(html, /Calculated/);
  assert.match(html, /href="https:\/\/www.sec.gov\/Archives\//);
  assert.match(html, /2026-02-01/); assert.match(html, /0000320193-26-000001/);
  assert.match(html, /href="\/api\/v1\/analysis\/AAPL"/);
  assert.match(html, /href="#analysis-workspace"/); assert.match(html, /data-workspace="preserved"/);
  assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")|NaN|undefined|private credentials/);
  assert.deepEqual(f.calls, [{ ticker: 'AAPL', basis: 'annual', end: '', asOf: '' }]);
  assert.equal(f.clientProps[0].preloadedCik, '0000320193');
});

test('Financial highlights start collapsed using native disclosure while the complete financial evidence remains in server HTML', async () => {
  const f = fixture(), page = f.compile('company');
  const html = renderToStaticMarkup(await page.default(props()));
  const disclosure = html.match(/<details\b([^>]*)><summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/section>/);
  assert.ok(disclosure, 'a native disclosure makes highlights available without client JavaScript');
  assert.doesNotMatch(disclosure[1], /\bopen(?:\s|=|$)/, 'highlights must start collapsed');
  assert.match(disclosure[2], /Apple fixture — financial highlights/);
  assert.match(disclosure[2], /AAPL · Annual/);
  assert.match(disclosure[2], /Period ending <time dateTime="2025-12-31">2025-12-31<\/time>/);
  assert.match(disclosure[2], /Prepared research/);
  assert.doesNotMatch(disclosure[2], /<(?:a|button|input|select)\b/, 'the disclosure control must not contain competing interactive elements');
  assert.match(disclosure[3], /<nav[^>]*aria-label="Financial summary links"/);
  assert.match(disclosure[3], /500 USD/);
  assert.match(disclosure[3], /href="#analysis-summary-sources"/);
  assert.match(disclosure[3], /<details[^>]*><summary>Source filings, coverage &amp; interpretation<\/summary><div id="analysis-summary-sources"/,
    'source anchors target content inside the nested disclosure so fragment navigation can reveal it');
  assert.match(disclosure[3], /href="https:\/\/www.sec.gov\/Archives\//);
});

test('quarter and selected end remain exact in HTML, public JSON links and initial interactive settings', async () => {
  const f = fixture(), page = f.compile('company');
  const html = renderToStaticMarkup(await page.default(props({ basis: 'quarter', end: '2025-06-30' })));
  assert.match(html, /Standalone quarter/); assert.match(html, /100 USD/);
  assert.match(html, /data-basis="quarter"/); assert.match(html, /data-end="2025-06-30"/);
  assert.match(html, /href="\/api\/v1\/analysis\/AAPL\?basis=quarter&amp;end=2025-06-30"/);
  assert.deepEqual(f.calls, [{ ticker: 'AAPL', basis: 'quarter', end: '2025-06-30', asOf: '' }]);
  assert.equal(f.clientProps[0].initialSettings.basis, 'quarter'); assert.equal(f.clientProps[0].initialSettings.end, '2025-06-30');
  assert.equal(f.cacheCalls.length, 0, 'historical end dates must not create persistent cache variants');
});

test('historical filing cutoffs display an explicit unavailable brief without substituting current financial values', async () => {
  const f = fixture(), page = f.compile('company');
  const query = { basis: 'annual', asOf: '2025-08-01', view: 'scenarios', scenarioRevenue: '-12' };
  const html = renderToStaticMarkup(await page.default(props(query)));
  assert.match(html, /current-vintage values have not been substituted/);
  assert.doesNotMatch(html, /500 USD|400 USD/); assert.match(html, /data-asof="2025-08-01"/);
  assert.equal(f.cacheCalls.length, 0);
  assert.equal(f.clientProps[0].initialSettings.asOf, '2025-08-01');
  assert.equal(f.clientProps[0].initialSettings.scenarioRevenue, -12);
  assert.equal((await page.generateMetadata(props(query))).robots.index, false);
});

test('personal workspace query settings are preserved for users and excluded from shared summary cache keys', async () => {
  const f = fixture(), page = f.compile('company');
  const query = { basis: 'annual', units: 'raw', pins: 'revenue,netIncome', view: 'notebook', briefTitle: 'Private draft title', baseline: 'previous' };
  const html = renderToStaticMarkup(await page.default(props(query)));
  assert.deepEqual(f.cacheCalls.map(call => call.args), [['AAPL', 'annual']]);
  assert.doesNotMatch(JSON.stringify(f.cacheCalls), /Private draft title|notebook|pins|previous/);
  assert.deepEqual(f.clientProps[0].initialSettings.pins, ['revenue', 'netIncome']);
  assert.equal(f.clientProps[0].initialSettings.briefTitle, 'Private draft title');
  assert.match(html, /id="analysis-public-brief" hidden=""/);
  assert.equal((await page.generateMetadata(props(query))).robots.index, false);
  assert.equal((await page.generateMetadata(props({ basis: 'quarter' }))).path, '/analysis/AAPL?basis=quarter');
});

test('malformed selectors never read prepared models; storage failures reveal no internal errors', async () => {
  const f = fixture(), page = f.compile('company');
  for (const query of [{ basis: ['annual', 'quarter'] }, { end: ['2025-12-31'] }, { asOf: ['2025-08-01'] },
    { basis: 'monthly' }, { end: '2025-02-30' }, { asOf: '2100-01-01' }]) {
    await assert.rejects(() => page.default(props(query)), /NOT_FOUND/);
    assert.equal((await page.generateMetadata(props(query))).robots.index, false);
  }
  assert.equal(f.calls.length, 0);
  const failed = fixture({ fail: true });
  const html = renderToStaticMarkup(await failed.compile('company').default(props()));
  assert.match(html, /temporarily unavailable/); assert.doesNotMatch(html, /private credentials|500 USD/);
  assert.match(html, /data-workspace="preserved"/);
});

test('Analysis company directory renders registry identities, source-free discovery links and preserved search tools', async () => {
  const f = fixture(), html = renderToStaticMarkup(await f.compile('directory').default());
  for (const company of companies) {
    assert.ok(html.includes(`href="/analysis/${company.ticker}"`));
    assert.ok(html.includes(company.name));
  }
  assert.match(html, /Technology/); assert.match(html, /Financials/);
  assert.match(html, /data-company-search="preserved"/);
  assert.match(html, /A few places to start/);
  assert.match(html, /CFTC market context/);
  assert.match(html, /sample companies/);
  assert.doesNotMatch(html, /Choose a company|Your research sequence|Notebook/);
  assert.equal(f.registryCalls.length, 1); assert.equal(f.calls.length, 0);
});

test('CIK broker-dealers render annual-report evidence and indexable identities without XBRL or stock ticker lookup', async () => {
  const cik = '0000123456', accession = '0000123456-26-000001';
  const url = `https://www.sec.gov/Archives/edgar/data/123456/${accession.replaceAll('-', '')}/annual.pdf`;
  const broker = { status: 'available', company: { cik, name: 'Independent Securities LLC' },
    filing: { form: 'X-17A-5', accession, filingDate: '2026-02-27', reportDate: '2025-12-31' }, filings: [],
    selectedDocument: { name: 'annual.pdf', url },
    analysis: { status: 'partial', metrics: [{ id: 'totalAssets', label: 'Total assets', value: 10000000, unit: 'USD', periodEnd: '2025-12-31',
      source: { url, page: 3, text: 'Total assets 10,000' } }], coverage: { disclosedStatements: ['financial-condition'] } } };
  const f = fixture({ broker }), page = f.compile('company');
  const meta = await page.generateMetadata(props({}, cik));
  assert.equal(meta.path, `/analysis/${cik}`);
  assert.equal(meta.robots?.index, undefined);
  assert.match(meta.title, /Independent Securities LLC/);
  assert.equal(f.brokerCalls.every(call => call.metadataOnly), true, 'SEO metadata never parses financial statements');
  const html = renderToStaticMarkup(await page.default(props({}, cik)));
  assert.match(html, /\$10,000,000/);
  assert.match(html, /annual\.pdf#page=3/);
  assert.match(html, /X-17A-5/);
  assert.match(html, /href="\/reports\?q=0000123456"/);
  assert.doesNotMatch(html, /tickerSymbol|data-client-ticker/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.clientProps.length, 0);
  const before = f.brokerCalls.filter(call => !call.metadataOnly).length;
  const unsupported = renderToStaticMarkup(await page.default(props({ basis: 'ttm' }, cik)));
  assert.match(unsupported, /not inferred/);
  assert.equal(f.brokerCalls.filter(call => !call.metadataOnly).length, before);
  assert.equal((await page.generateMetadata(props({ basis: 'ttm' }, cik))).robots.index, false);
});

async function routeFixture() {
  const { mock } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const root = process.argv[1];
  const { publicAnalysisSelection } = await import(new URL('src/utils/analysisPublicResearch.js', root).href);
  let result = null, fail = false;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Public summary unexpectedly attempted source acquisition'); };
  mock.module(new URL('src/utils/analysisPublicResearch.js', root).href, { namedExports: {
    publicAnalysisSelection,
    readPublicAnalysis: async selection => { calls.push(selection); if (fail) throw new Error('private credentials'); return result; },
  } });
  const route = await import(new URL('src/app/api/v1/analysis/[ticker]/route.js', root).href);
  const params = Promise.resolve({ ticker: 'aapl' });
  const request = query => new Request(`https://secedgarterminal.com/api/v1/analysis/aapl${query}`);
  for (const query of ['?refresh=1', '?units=millions', '?view=scenarios', '?basis=', '?end=', '?asOf=', '?basis=quarter&basis=ttm',
    '?basis=month', '?end=2025-02-30', '?asOf=2100-01-01', '?end=2025-12-31&end=2024-12-31']) {
    const response = await route.GET(request(query), { params });
    assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  }
  assert.equal(calls.length, 0);
  const missing = await route.GET(request(''), { params });
  assert.equal(missing.status, 503); assert.equal(missing.headers.get('cache-control'), 'private, no-store');
  assert.equal(missing.headers.get('retry-after'), '60');
  result = { status: 'not-prepared', asOf: '2025-08-01', reason: 'This cutoff is not prepared.' };
  const cutoff = await route.GET(request('?basis=quarter&end=2025-06-30&asOf=2025-08-01'), { params });
  assert.equal(cutoff.status, 503); assert.deepEqual(await cutoff.json(), result);
  assert.deepEqual(calls.at(-1), { ticker: 'AAPL', basis: 'quarter', end: '2025-06-30', asOf: '2025-08-01' });
  result = { status: 'ready', stale: true, period: { start: '2025-01-01', end: '2025-12-31' }, metrics: [], sourceCatalog: [] };
  const success = await route.GET(request('?basis=annual'), { params });
  assert.equal(success.status, 200); assert.deepEqual(await success.json(), result);
  assert.equal(success.headers.get('cache-control'), 'public, max-age=0, s-maxage=60, stale-while-revalidate=60');
  assert.equal(success.headers.get('access-control-allow-origin'), '*');
  fail = true;
  const failed = await route.GET(request(''), { params });
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private credentials/);
  assert.equal(route.OPTIONS().status, 204);
  globalThis.fetch = originalFetch;
  mock.restoreAll();
}
test('Analysis public JSON rejects acquisition and personal flags, preserves selections and stale status, and never caches misses', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `await (${routeFixture.toString()})();`, new URL('../', import.meta.url).href],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
});

async function brokerRouteFixture() {
  const { mock } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const root = process.argv[1], calls = [];
  let failed = false, available = true, retryable = false, analysisStatus = 'partial';
  const cik = '0000123456';
  mock.module(new URL('src/utils/rateLimit.js', root).href, { namedExports: {
    checkRateLimit: async () => ({ allowed: true }), getClientIp: () => 'fixture', rateLimitedResponse: () => new Response(null, { status: 429 }),
  } });
  mock.module(new URL('src/utils/brokerDealerResearch.js', root).href, { namedExports: {
    readBrokerDealerFiling: () => assert.fail('The CIK route must use verified broker-dealer discovery'),
    loadBrokerDealerResearch: async (id, options) => {
      calls.push(id); assert.ok(options.signal); if (failed) throw new Error('private credentials');
      return { status: available ? 'available' : 'not-applicable', company: { cik, name: 'Independent Securities LLC' },
        analysis: { status: analysisStatus, cik, name: 'Independent Securities LLC', metrics: analysisStatus === 'unavailable' ? [] : [{ id: 'totalAssets', value: 1000 }] },
        extraction: { retryable },
        filing: { form: 'X-17A-5', accession: '0000123456-26-000001' } };
    },
  } });
  const route = await import(new URL('src/app/api/v1/analysis/[ticker]/route.js', root).href);
  const request = (id = cik, query = '') => route.GET(new Request(`https://secedgarterminal.com/api/v1/analysis/${id}${query}`), { params: Promise.resolve({ ticker: id }) });
  assert.equal((await request('0000000000')).status, 400);
  assert.equal((await request(cik, '?basis=ttm')).status, 422);
  assert.equal((await request(cik, '?asOf=2025-01-01')).status, 422);
  assert.equal(calls.length, 0);
  const response = await request(), json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(json.schemaVersion, 'edgar.broker-dealer-analysis.v1');
  assert.equal(json.cik, cik); assert.equal(json.filing.form, 'X-17A-5');
  assert.equal(json.metrics[0].value, 1000);
  assert.equal(json.ticker, undefined);
  assert.match(response.headers.get('Cache-Control'), /public.*s-maxage=3600/);
  retryable = true;
  analysisStatus = 'unavailable';
  const transientMissing = await request();
  assert.equal(transientMissing.status, 503, 'A temporary extraction failure remains retryable');
  assert.match(transientMissing.headers.get('Cache-Control'), /private.*no-store/);
  assert.doesNotMatch(transientMissing.headers.get('Cache-Control'), /s-maxage/);
  assert.equal((await transientMissing.json()).status, 'unavailable');
  analysisStatus = 'partial';
  const transientPartial = await request();
  assert.equal(transientPartial.status, 200, 'Already extracted figures remain usable during a partial outage');
  assert.match(transientPartial.headers.get('Cache-Control'), /private.*no-store/);
  assert.doesNotMatch(transientPartial.headers.get('Cache-Control'), /s-maxage/);
  const partial = await transientPartial.json();
  assert.equal(partial.status, 'partial');
  assert.equal(partial.metrics[0].value, 1000);
  retryable = false;
  const recovered = await request();
  assert.equal(recovered.status, 200);
  assert.match(recovered.headers.get('Cache-Control'), /public.*s-maxage=3600/);
  available = false;
  assert.equal((await request()).status, 404);
  failed = true;
  const failure = await request();
  assert.equal(failure.status, 503);
  assert.match(failure.headers.get('Cache-Control'), /no-store/);
  assert.doesNotMatch(await failure.text(), /private credentials/);
}
test('public CIK analysis returns source-linked broker-dealer research and rejects unsupported bases before parsing', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `await (${brokerRouteFixture.toString()})();`, new URL('../', import.meta.url).href], { stdio: 'pipe' });
});

test('HTML-only research agents wait for metadata while ordinary browsers retain streaming', async () => {
  const { default: config } = await import('../next.config.mjs');
  for (const agent of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'Bingbot', 'Twitterbot', 'Slackbot']) {
    assert.equal(config.htmlLimitedBots.test(agent), true, agent);
  }
  assert.equal(config.htmlLimitedBots.test('Mozilla/5.0 Chrome/140.0 Safari/537.36'), false);
});
