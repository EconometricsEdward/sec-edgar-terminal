import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FUND_CATALOG } from '../src/utils/fundResearch.js';
import * as selectors from '../src/utils/fundPublicSelectors.js';
import * as publicMetadata from '../src/utils/fundPublicMetadata.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const files = {
  brief: '../src/app/fund/FundResearchBrief.tsx',
  fund: '../src/app/fund/[ticker]/page.tsx',
  manager: '../src/app/fund/manager/[cik]/page.tsx',
  directory: '../src/app/fund/page.tsx',
};
function fixture(result = null, fail = false) {
  const calls = [];
  function compile(kind) {
    const source = readFileSync(new URL(files[kind], import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const testModule = { exports: {} };
    new Function('require', 'module', 'exports', compiled)(name => {
      if (name === 'react/jsx-runtime' || name === 'react') return require(name);
      if (name === 'next/link') return function Link({ prefetch: _prefetch, ...props }) { return createElement('a', props); };
      if (name === 'next/cache') return { unstable_cache: fn => fn };
      if (name === 'next/navigation') return { notFound: () => { throw new Error('NOT_FOUND'); } };
      if (name.endsWith('/siteMetadata')) return { buildPageMetadata: value => value, SITE_URL: 'https://secedgarterminal.com' };
      if (name.endsWith('/fundResearch')) return { FUND_CATALOG };
      if (name.endsWith('/fundPublicSelectors.js')) return selectors;
      if (name.endsWith('/fundPublicMetadata.js')) return publicMetadata;
      if (name.endsWith('/fundPublicResearch.js')) return {
        readPublicFundSummary: async (...args) => { calls.push(['fund', ...args]); if (fail) throw new Error('private credentials'); return result; },
        readPublicManagerSummary: async (...args) => { calls.push(['manager', ...args]); if (fail) throw new Error('private credentials'); return result; },
      };
      if (name.endsWith('/FundResearchBrief')) return compile('brief');
      if (name.endsWith('/FundClient')) return function Client(props) { return createElement('div', { 'data-client-ticker': props.urlTicker, 'data-client-accession': props.selectedAccession }); };
      if (name.endsWith('/FundsWorkspace')) return function Workspace() { return createElement('div', { 'data-workspace': 'preserved' }); };
      if (name.endsWith('.css')) return new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : String(key) });
      throw new Error(`Unexpected public page dependency: ${name}`);
    }, testModule, testModule.exports);
    return testModule.exports;
  }
  return { compile, calls };
}
const props = (key, value, query = {}) => ({ params: Promise.resolve({ [key]: value }), searchParams: Promise.resolve(query) });
function summary(kind = 'nport') {
  return {
    kind, status: 'ready', ticker: kind === 'nport' ? 'VOO' : undefined, cik: '0001350694', name: 'Fixture portfolio', stale: true,
    reportDate: '2026-06-30', filingDate: '2026-08-14', checkedAt: '2026-09-16T10:30:00Z', retrievedAt: '2026-09-16T10:29:00Z',
    totalValueUsd: 100000, valueLabel: kind === 'nport' ? 'Net assets' : 'Reported 13F holdings value', positionCount: 12, top10WeightPct: 45,
    topHoldings: Array.from({ length: 12 }, (_, index) => ({ name: `Holding ${index}`, identifier: `CUSIP${index}`, valueUsd: index ? null : 10000, weightPct: index ? null : 10, weightSource: 'calculated', putCall: kind === '13f' ? 'PUT' : null })),
    sources: Array.from({ length: 32 }, (_, index) => ({ label: `Source ${index}`, url: `https://www.sec.gov/Archives/source-${index}.xml` })),
    limitations: ['Confidential holdings are omitted.', 'Missing figures are not zero.'],
    interactiveUrl: '/fund?view=13f&managerCik=0001350694', summaryUrl: '/api/v1/managers/0001350694',
  };
}

test('fund directory exposes all existing fund and manager research links without reading sources', async () => {
  const f = fixture();
  const html = renderToStaticMarkup(f.compile('directory').default());
  assert.match(html, /data-workspace="preserved"/);
  for (const fund of FUND_CATALOG) assert.ok(html.includes(`href="/fund/${fund.ticker}"`));
  for (const manager of selectors.PUBLIC_FUND_MANAGERS) assert.ok(html.includes(`href="/fund/manager/${manager.cik}"`));
  const schema = JSON.parse(html.match(/<script id="fund-research-directory"[^>]*>(.*?)<\/script>/s)[1]);
  assert.equal(schema['@type'], 'CollectionPage');
  assert.equal(schema.mainEntity.numberOfItems, FUND_CATALOG.length + selectors.PUBLIC_FUND_MANAGERS.length);
  assert.equal(new Set(schema.mainEntity.itemListElement.map(item => item.url)).size, schema.mainEntity.numberOfItems);
  assert.equal(f.calls.length, 0);
});

test('fund initial HTML contains dated positions, source evidence and the exact selected accession', async () => {
  const f = fixture(summary());
  const page = f.compile('fund');
  const accession = '0001350694-26-000001';
  const html = renderToStaticMarkup(await page.default(props('ticker', 'VOO', { accession, q: 'APPLE', tab: 'holdings' })));
  assert.deepEqual(f.calls, [['fund', 'VOO', accession]]);
  assert.match(html, new RegExp(`data-client-accession="${accession}"`));
  assert.match(html, /Holding 9</); assert.doesNotMatch(html, /Holding 10</);
  assert.match(html, /Source 31/);
  assert.match(html, /10:30 AM UTC/);
  assert.match(html, /calculated/);
  assert.match(html, /Refresh due/);
  assert.match(html, /datetime="2026-06-30"/i);
  assert.match(html, /href="#fund-workspace"/);
  assert.match(html, /href="\/api\/v1\/funds\/VOO\?accession=0001350694-26-000001"/);
  assert.doesNotMatch(html, /NaN|undefined|private credentials/);
  const metadata = await page.generateMetadata(props('ticker', 'VOO', { accession }));
  assert.equal(metadata.path, `/fund/VOO?accession=${accession}`);
  assert.equal(metadata.alternates.types['application/json'], `https://secedgarterminal.com/api/v1/funds/VOO?accession=${accession}`);
  assert.match(metadata.description, /2026-06-30/);
  const schema = JSON.parse(html.match(/<script id="reported-portfolio-data"[^>]*>(.*?)<\/script>/s)[1]);
  const dataset = schema['@graph'].find(item => item['@type'] === 'Dataset');
  assert.equal(dataset.url, `https://secedgarterminal.com/fund/VOO?accession=${accession}`);
  assert.equal(dataset.distribution.contentUrl, metadata.alternates.types['application/json']);
  assert.equal(dataset.temporalCoverage, '2026-06-30');
  assert.match(dataset.description, /newer filing or amendment may be missing/);
  assert.equal(dataset.isBasedOn.length, 32);
  assert.equal(dataset.dateModified, undefined, 'a source check is not a modified dataset');
});

test('manager brief keeps quarter selection, option identity, completeness limitations and the interactive link', async () => {
  const f = fixture(summary('13f'));
  const page = f.compile('manager');
  const html = renderToStaticMarkup(await page.default(props('cik', '1350694', { period: '2026-06-30' })));
  assert.deepEqual(f.calls, [['manager', '0001350694', '2026-06-30']]);
  assert.match(html, /<h1>Fixture portfolio<\/h1>/);
  assert.match(html, /PUT/);
  assert.match(html, /not total assets under management/);
  assert.match(html, /Confidential holdings are omitted/);
  assert.match(html, /href="\/api\/v1\/managers\/0001350694\?period=2026-06-30"/);
  assert.match(html, /<details[^>]* open=""/);
  const metadata = await page.generateMetadata(props('cik', '1350694', { period: '2026-06-30' }));
  assert.equal(metadata.alternates.types['application/json'], 'https://secedgarterminal.com/api/v1/managers/0001350694?period=2026-06-30');
  const schema = JSON.parse(html.match(/<script id="reported-portfolio-data"[^>]*>(.*?)<\/script>/s)[1]);
  const dataset = schema['@graph'].find(item => item['@type'] === 'Dataset');
  assert.match(dataset.description, /not total assets under management/);
  assert.equal(dataset.variableMeasured[2].unitText, 'percent of reconciled public 13F holdings value');
});

test('unprepared historical or unknown selections are not indexed, and malformed selectors never read storage', async () => {
  for (const kind of ['fund', 'manager']) {
    const f = fixture(null, true), page = f.compile(kind);
    const key = kind === 'fund' ? 'ticker' : 'cik', known = kind === 'fund' ? 'VOO' : '0001350694';
    const query = kind === 'fund' ? { accession: '0001350694-26-000001' } : { period: '2026-06-30' };
    const html = renderToStaticMarkup(await page.default(props(key, known, query)));
    assert.match(html, /Prepared portfolio unavailable/); assert.doesNotMatch(html, /private credentials|Disclosed positions/);
    const schema = JSON.parse(html.match(/<script id="reported-portfolio-data"[^>]*>(.*?)<\/script>/s)[1]);
    assert.deepEqual(schema['@graph'].map(item => item['@type']), ['BreadcrumbList']);
    assert.equal((await page.generateMetadata(props(key, known, query))).robots.index, false);
    assert.equal((await page.generateMetadata(props(key, known))).robots, undefined);
    assert.equal((await page.generateMetadata(props(key, kind === 'fund' ? 'UNKNOWN' : '0000000001'))).robots.index, false);
    const count = f.calls.length;
    const malformed = kind === 'fund' ? [{ accession: ['0001350694-26-000001', '0001350694-26-000002'] }, { accession: 'bad' }] : [{ period: ['2026-06-30', '2026-03-31'] }, { period: '2099-06-30' }, { period: '2026-02-31' }];
    for (const selection of malformed) await assert.rejects(() => page.default(props(key, known, selection)), /NOT_FOUND/);
    assert.equal(f.calls.length, count);
  }
});

test('structured portfolio data preserves zero, omits missing metrics and escapes filing-sourced text', () => {
  const data = summary('13f');
  data.name = '</script><script>alert(1)</script>';
  data.totalValueUsd = null;
  data.positionCount = 0;
  data.top10WeightPct = Number.NaN;
  data.sources = [{ label: 'External', url: 'https://example.com/document' }, { label: 'Unsafe', url: 'https://user@www.sec.gov/document' }, { label: 'SEC', url: 'https://www.sec.gov/document' }];
  const schema = publicMetadata.publicPortfolioStructuredData(data, { pageUrl: 'https://secedgarterminal.com/fund/manager/0001350694', jsonUrl: 'https://secedgarterminal.com/api/v1/managers/0001350694', siteUrl: 'https://secedgarterminal.com' });
  const dataset = schema['@graph'].find(item => item['@type'] === 'Dataset');
  assert.deepEqual(dataset.variableMeasured, [{ '@type': 'PropertyValue', name: 'Disclosed positions', value: 0, unitText: 'positions' }]);
  assert.equal(dataset.isBasedOn.length, 1);
  const serialized = publicMetadata.serializeResearchJsonLd(schema);
  assert.doesNotMatch(serialized, /<\/script>/);
  assert.deepEqual(JSON.parse(serialized), schema);
});

async function routeFixture() {
  const { mock } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const root = process.argv[1];
  let result = null, fail = false, calls = [];
  mock.module(new URL('src/utils/fundPublicResearch.js', root).href, { namedExports: {
    readPublicFundSummary: async (...args) => { calls.push(['fund', ...args]); if (fail) throw new Error('private credentials'); return result; },
    readPublicManagerSummary: async (...args) => { calls.push(['manager', ...args]); if (fail) throw new Error('private credentials'); return result; },
  } });
  for (const kind of ['fund', 'manager']) {
    const isFund = kind === 'fund';
    const path = isFund ? 'src/app/api/v1/funds/[ticker]/route.js' : 'src/app/api/v1/managers/[cik]/route.js';
    const route = await import(new URL(path, root).href);
    const params = Promise.resolve(isFund ? { ticker: 'voo' } : { cik: '1350694' });
    const request = query => new Request(`https://secedgarterminal.com/public${query}`);
    const invalid = isFund ? ['?refresh=1', '?accession=', '?accession=bad', '?accession=0001350694-26-000001&accession=0001350694-26-000001'] : ['?refresh=1', '?period=', '?period=2099-12-31', '?period=2026-02-31', '?period=2026-06-30&period=2026-03-31'];
    calls = [];
    for (const query of invalid) {
      const response = await route.GET(request(query), { params });
      assert.equal(response.status, 400); assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    }
    assert.equal(calls.length, 0);
    result = null; fail = false;
    const missing = await route.GET(request(''), { params });
    assert.equal(missing.status, 503); assert.equal(missing.headers.get('retry-after'), '60');
    assert.equal(missing.headers.get('cache-control'), 'private, no-store');
    result = { status: 'ready', stale: true, reportDate: '2026-06-30', topHoldings: [] };
    const query = isFund ? '?accession=0001350694-26-000001' : '?period=2026-06-30';
    const success = await route.GET(request(query), { params });
    assert.equal(success.status, 200); assert.deepEqual(await success.json(), result);
    assert.equal(success.headers.get('access-control-allow-origin'), '*');
    assert.equal(success.headers.get('cache-control'), 'public, max-age=0, s-maxage=60, stale-while-revalidate=60');
    assert.equal(calls.at(-1)[1], isFund ? 'VOO' : '0001350694');
    assert.equal(calls.at(-1)[2], isFund ? '0001350694-26-000001' : '2026-06-30');
    assert.ok(calls.at(-1)[3].signal instanceof AbortSignal);
    fail = true;
    const failed = await route.GET(request(''), { params });
    assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private credentials/);
    assert.equal(route.OPTIONS().status, 204);
  }
  mock.restoreAll();
}
test('public JSON only reads prepared reports, rejects acquisition flags and preserves stale status without caching misses', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `await (${routeFixture.toString()})();`, new URL('../', import.meta.url).href],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
});
