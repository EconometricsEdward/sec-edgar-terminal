import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as validation from '../src/utils/marketResearchValidation.js';
import * as formatting from '../src/utils/marketResearch.js';
import { MARKET_SECTOR_COMPANY_METRICS, pageMarketSectorCompanies } from '../src/utils/marketSectorCompanies.js';

function hooks() {
  const slots = []; let cursor = 0; let effects = []; let dirty = false;
  return { react: { ...React,
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, update => { const next = typeof update === 'function' ? update(slots[i].value) : update; if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useEffect(fn, deps) { const i = cursor++; const previous = slots[i]; if (!previous || deps.some((dep, index) => !Object.is(dep, previous.deps[index]))) { slots[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  }, render(fn) { let result; let attempts = 0; do { dirty = false; cursor = 0; result = fn(); const pending = effects; effects = []; for (const effect of pending) effect(); if (++attempts > 30) throw new Error('Unstable hook render'); } while (dirty); return result; }, dispose() { for (const slot of slots) slot?.cleanup?.(); } };
}
function component(react = React) {
  const require = createRequire(import.meta.url);
  const compiled = require('typescript').transpileModule(readFileSync(new URL('../src/app/market/MarketSectorCompanies.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: require('typescript').ModuleKind.CommonJS, jsx: require('typescript').JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react') return react;
    if (name === 'next/link') return function Link({ prefetch: _prefetch, ...props }) { return React.createElement('a', props); };
    if (name.endsWith('.css')) return {};
    if (name.endsWith('marketResearchValidation.js')) return validation;
    if (name.endsWith('marketResearch.js')) return formatting;
    return require(name);
  }, loaded, loaded.exports);
  return loaded.exports;
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props?.children)) { const result = find(child, predicate); if (result) return result; }
  return null;
}
const sector = { id: 'sector-technology', label: 'Technology', count: 30 };
const generatedAt = '2026-09-19T00:00:00.000Z';
function snapshot() {
  return { version: 'market-sector-companies-v1', generatedAt, companies: Array.from({ length: 30 }, (_, i) => {
    const metrics = Object.fromEntries(MARKET_SECTOR_COMPANY_METRICS.map(key => [key, i === 29 ? null : key === 'currentRatio' ? 1.25 : 30 - i]));
    return { ticker: `CO${i}`, name: `Company ${i}`, cik: String(i + 1).padStart(10, '0'), sic: '7372', sectorId: sector.id,
      metrics: { annual: metrics, ttm: metrics }, reports: { annual: { end: '2025-12-31', filed: '2026-02-01', form: '10-K', accession: '0000000001-26-000001' }, ttm: { end: '2026-06-30', filed: '2026-08-01', form: '10-Q', accession: '0000000001-26-000002' } } };
  }) };
}
function pageFor(path) {
  const params = new URL(path, 'https://example.test').searchParams;
  return pageMarketSectorCompanies(snapshot(), { ...Object.fromEntries(params), page: Number(params.get('page')) });
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('sector company explorer requests bounded pages and renders risk ratios, dates and safe research links', async () => {
  const harness = hooks(); const calls = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async path => { calls.push(path); return { ok: true, json: async () => pageFor(path) }; };
  const Explorer = component(harness.react).default;
  let props = { sector, basis: 'ttm', generatedAt, metric: 'currentRatio', direction: 'desc', query: '', page: 1, onChange(patch) { props = { ...props, ...(patch.companyMetric ? { metric: patch.companyMetric } : {}), ...(patch.companyPage ? { page: patch.companyPage } : {}) }; } };
  try {
    harness.render(() => Explorer(props)); await settle();
    const tree = harness.render(() => Explorer(props)); const html = renderToStaticMarkup(tree);
    assert.equal(calls.length, 1); assert.match(calls[0], /sort=currentRatio/);
    assert.match(html, /1\.25×/); assert.doesNotMatch(html, /1\.25%/);
    assert.match(html, /25 of 30 companies/); assert.match(html, /29<\/b> with data/);
    assert.match(html, /\/analysis\/CO0\?basis=ttm/); assert.match(html, /\/risk\?ticker=CO0/);
    assert.match(html, /2026-06-30/); assert.match(html, /www.sec.gov\/Archives\/edgar\/data\/1\/000000000126000002\/0000000001-26-000002-index.html/);
    find(tree, node => node.props?.['aria-label'] === 'Next company page').props.onClick();
    harness.render(() => Explorer(props)); await settle();
    const second = harness.render(() => Explorer(props));
    assert.equal(calls.length, 2); assert.match(calls[1], /page=2/);
    assert.match(renderToStaticMarkup(second), /26–30 of 30 companies/);
    assert.match(renderToStaticMarkup(second), /1 unavailable/);
  } finally { harness.dispose(); globalThis.fetch = originalFetch; }
});

test('rapid search edits debounce and old request responses cannot populate a new selection', async () => {
  const harness = hooks(); const calls = []; const deferred = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = (path, options) => { calls.push({ path, signal: options.signal }); return new Promise(resolve => deferred.push(() => resolve({ ok: true, json: async () => pageFor(path) }))); };
  const Explorer = component(harness.react).default; const patches = [];
  let props = { sector, basis: 'annual', generatedAt, metric: 'revenueGrowth', direction: 'desc', query: '', page: 2, onChange(patch) { patches.push(patch); props = { ...props, query: patch.companyQuery ?? props.query, page: patch.companyPage ?? props.page }; } };
  try {
    let tree = harness.render(() => Explorer(props));
    find(tree, node => node.type === 'input').props.onChange({ target: { value: 'CO' } }); tree = harness.render(() => Explorer(props));
    find(tree, node => node.type === 'input').props.onChange({ target: { value: 'CO1' } }); harness.render(() => Explorer(props));
    assert.equal(calls.length, 1);
    await new Promise(resolve => setTimeout(resolve, 280));
    assert.deepEqual(patches, [{ companyQuery: 'CO1', companyPage: 1 }]);
    harness.render(() => Explorer(props)); assert.equal(calls.length, 2); assert.equal(calls[0].signal.aborted, true);
    deferred[0](); await settle(); tree = harness.render(() => Explorer(props));
    assert.doesNotMatch(renderToStaticMarkup(tree), /Analyze CO25/);
    assert.match(renderToStaticMarkup(tree), /Loading the sector/);
    deferred[1](); await settle(); tree = harness.render(() => Explorer(props));
    assert.match(renderToStaticMarkup(tree), /11 matching companies/); assert.doesNotMatch(renderToStaticMarkup(tree), /Analyze CO25/);
  } finally { harness.dispose(); globalThis.fetch = originalFetch; }
});

test('mismatched API selection becomes a retryable error and fresh pages are reused', async () => {
  const harness = hooks(); const calls = []; const originalFetch = globalThis.fetch;
  let wrong = true;
  globalThis.fetch = async path => { calls.push(path); const value = pageFor(path); return { ok: true, json: async () => ({ ...value, basis: wrong ? 'annual' : 'ttm' }) }; };
  const Explorer = component(harness.react).default;
  let props = { sector, basis: 'ttm', generatedAt, metric: 'equityToAssets', direction: 'asc', query: '', page: 1, onChange() {} };
  try {
    harness.render(() => Explorer(props)); await settle(); let tree = harness.render(() => Explorer(props));
    assert.match(renderToStaticMarkup(tree), /could not be verified/);
    wrong = false;
    find(tree, node => node.type === 'button' && node.props.children === 'Retry companies').props.onClick();
    harness.render(() => Explorer(props)); await settle(); tree = harness.render(() => Explorer(props));
    assert.match(renderToStaticMarkup(tree), /Analyze CO28/);
    props = { ...props, page: 2 }; harness.render(() => Explorer(props)); await settle(); harness.render(() => Explorer(props));
    props = { ...props, page: 1 }; tree = harness.render(() => Explorer(props));
    assert.equal(calls.length, 3, 'returning to a fresh loaded page uses the bounded in-memory cache');
    assert.match(renderToStaticMarkup(tree), /Analyze CO28/);
  } finally { harness.dispose(); globalThis.fetch = originalFetch; }
});

test('company filing links reject malformed identity and include only trusted SEC host', () => {
  const { companyFilingUrl } = component();
  assert.equal(companyFilingUrl({ cik: 'javascript:alert(1)', report: { accession: '0000000001-26-000001' } }), null);
  assert.equal(companyFilingUrl({ cik: '0000000001', report: { accession: '../../other' } }), null);
  assert.equal(companyFilingUrl({ cik: '0000000001', report: null }), null);
  assert.match(companyFilingUrl({ cik: '0000000001', report: { accession: '0000000001-26-000001' } }), /^https:\/\/www\.sec\.gov\/Archives\//);
});
