import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as routes from '../src/utils/siteRoutes.js';
import * as market from '../src/utils/marketResearch.js';

function loadComponent(path, overrides = {}, exported = 'default') {
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
  return testModule.exports[exported];
}

const generatedAt = '2026-09-19T12:00:00.000Z';
const directory = (companies, extra = {}) => ({ version: 'market-directory-v1', generatedAt, query: '', sector: 'all', page: 1, pageSize: 50, total: companies.length, companies, failureCount: 0, ...extra });
const openedDirectory = result => {
  const states = [true, '', '', 'all', 1, result, false, '', 0];
  return { ...React, useState: initial => [states.length ? states.shift() : initial, () => {}] };
};

test('Market company names and tickers link directly to the correct Analysis route without speculative prefetch', () => {
  const linkProps = [];
  const result = directory([
    { ticker: 'AAPL', cik: '1', name: 'Apple Inc.', sector: 'Information Technology' },
    { ticker: 'BRK-B', cik: '2', name: 'Berkshire Hathaway', sector: 'Financials' },
  ]);
  const Directory = loadComponent('../src/app/market/MarketCompanyDirectory.tsx', {
    react: openedDirectory(result),
    'next/link': props => { linkProps.push(props); const { prefetch: _prefetch, ...anchor } = props; return createElement('a', anchor); },
  });
  const html = renderToStaticMarkup(createElement(Directory, { total: result.total, generatedAt, sectors: [{ id: 'sector-financials', label: 'Financials' }], basis: 'ttm' }));
  assert.equal(linkProps.filter(link => link.href === '/analysis/AAPL?basis=ttm').length, 2);
  assert.equal(linkProps.filter(link => link.href === '/analysis/BRK-B?basis=ttm').length, 2);
  assert.ok(linkProps.every(link => link.prefetch === false));
  assert.match(html, /Financials/);
  assert.match(html, /Search covered companies/);
});

test('5,000-company directory sends no company rows or search work in its closed initial HTML', () => {
  const Directory = loadComponent('../src/app/market/MarketCompanyDirectory.tsx');
  const html = renderToStaticMarkup(createElement(Directory, { total: 5000, generatedAt, sectors: [] }));
  assert.equal((html.match(/scope="row"/g) || []).length, 0);
  assert.match(html, /5,000 loaded issuers/);
  assert.doesNotMatch(html, /market-company-search|href="\/analysis\//);
});

test('opened directory renders one server page while retaining the full 5,000-company count', () => {
  const result = directory(Array.from({ length: 50 }, (_, i) => ({ ticker: `T${i}`, cik: String(i + 1), name: `Company ${i}`, sector: 'Technology' })), { total: 5000 });
  const Directory = loadComponent('../src/app/market/MarketCompanyDirectory.tsx', { react: openedDirectory(result) });
  const html = renderToStaticMarkup(createElement(Directory, { total: 5000, generatedAt, sectors: [] }));
  assert.equal((html.match(/scope="row"/g) || []).length, 50);
  assert.match(html, /1–50 of 5,000 companies/);
  assert.match(html, /href="\/analysis\/T0"/);
  assert.doesNotMatch(html, /href="\/analysis\/T50"/);
});

test('company page validation rejects cross-query responses, duplicates, oversized pages and invalid routes', () => {
  const validate = loadComponent('../src/app/market/MarketCompanyDirectory.tsx', {}, 'isMarketDirectoryPage');
  const company = { ticker: 'AAPL', cik: '0000320193', name: 'Apple Inc.', sector: 'Technology' };
  const result = directory([company]);
  const expected = { query: '', sector: 'all', page: 1 };
  assert.equal(validate(result, expected), true);
  assert.equal(validate({ ...result, query: 'bac' }, expected), false);
  assert.equal(validate({ ...result, sector: 'sector-energy' }, expected), false);
  assert.equal(validate({ ...result, companies: [{ ...company, ticker: '../help' }] }, expected), false);
  assert.equal(validate({ ...result, total: 2, companies: [company, { ...company, cik: '320193', ticker: 'OTHER' }] }, expected), false);
  assert.equal(validate({ ...result, total: 51, companies: Array(51).fill(company) }, expected), false);
  assert.equal(validate(result, { ...expected, page: 9 }), true, 'a shrinking snapshot may clamp to its last page');
});

test('Market page is a static shell with no visitor-triggered SEC snapshot read', () => {
  const overrides = {
    './MarketOverviewClient': { default: () => null },
    '../../utils/siteMetadata': { buildPageMetadata: value => value },
    '../../utils/cftcFeature.js': { isCftcEnabled: () => true },
    '../../utils/marketOverviewServer.js': { readMarketOverview: () => { throw new Error('Unexpected full-universe read'); } },
  };
  const Page = loadComponent('../src/app/market/page.tsx', overrides);
  const dynamic = loadComponent('../src/app/market/page.tsx', overrides, 'dynamic');
  assert.equal(dynamic, 'force-static');
  const rendered = Page();
  assert.equal(rendered.props.cftcEnabled, true);
  assert.equal(rendered.props.initialData, undefined);
});
