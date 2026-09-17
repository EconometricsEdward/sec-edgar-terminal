import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as routes from '../src/utils/siteRoutes.js';
import * as market from '../src/utils/marketResearch.js';

function loadComponent(path, overrides = {}) {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name in overrides) return overrides[name];
    if (name.endsWith('.css')) return {};
    if (name.endsWith('siteRoutes.js')) return routes;
    if (name.endsWith('marketResearch.js')) return market;
    return require(name);
  }, testModule, testModule.exports);
  return testModule.exports.default;
}

test('Market company names and tickers link directly to the correct Analysis route without speculative prefetch', () => {
  const linkProps = [];
  const Directory = loadComponent('../src/app/market/MarketCompanyDirectory.tsx', {
    'next/link': props => { linkProps.push(props); const { prefetch: _prefetch, ...anchor } = props; return createElement('a', anchor); },
  });
  const html = renderToStaticMarkup(createElement(Directory, {
    companies: [
      { ticker: 'AAPL', cik: '1', name: 'Apple Inc.', cohorts: [], sector: 'Information Technology' },
      { ticker: 'BRK-B', cik: '2', name: 'Berkshire Hathaway', cohorts: ['financials'] },
      { ticker: '../help', cik: '3', name: 'Invalid ticker', cohorts: [] },
    ], sectors: [{ id: 'financials', label: 'Financials' }], basis: 'ttm',
  }));
  assert.equal(linkProps.filter(link => link.href === '/analysis/AAPL?basis=ttm').length, 2);
  assert.equal(linkProps.filter(link => link.href === '/analysis/BRK-B?basis=ttm').length, 2);
  assert.ok(linkProps.every(link => link.prefetch === false));
  assert.doesNotMatch(html, /href="[^"]*(?:help|market)/);
  assert.match(html, /Financials/);
  assert.match(html, /Search covered companies/);
});

test('Market company directory bounds initial HTML while retaining a complete result count', () => {
  const Directory = loadComponent('../src/app/market/MarketCompanyDirectory.tsx');
  const html = renderToStaticMarkup(createElement(Directory, {
    companies: Array.from({ length: 1434 }, (_, i) => ({ ticker: `T${i}`, cik: String(i), name: `Company ${i}`, cohorts: [] })),
    sectors: [],
  }));
  assert.equal((html.match(/scope="row"/g) || []).length, 50);
  assert.match(html, /1–50 of 1,434 companies/);
  assert.match(html, /href="\/analysis\/T0"/);
  assert.doesNotMatch(html, /href="\/analysis\/T50"/);
});

test('retired Market bookmarks redirect before snapshot reads and preserve supported settings', async () => {
  let reads = 0;
  const Page = loadComponent('../src/app/market/page.tsx', {
    './MarketOverviewClient': { default: () => null },
    '../../utils/siteMetadata': { buildPageMetadata: value => value },
    '../../utils/marketOverviewServer.js': { readMarketOverview: async () => { reads++; return null; } },
    '../../utils/cftcFeature.js': { isCftcEnabled: () => true },
    'next/navigation': { redirect: path => { throw new Error(`Redirect:${path}`); } },
  });
  for (const tab of ['companies', 'fundamentals', 'factors']) {
    await assert.rejects(Page({ searchParams: Promise.resolve({ tab, basis: 'annual', q: 'AAPL' }) }), {
      message: 'Redirect:/market?tab=sectors&basis=annual',
    });
  }
  assert.equal(reads, 0);
  await Page({ searchParams: Promise.resolve({ tab: 'sectors' }) });
  assert.equal(reads, 1);
});
