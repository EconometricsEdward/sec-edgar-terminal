import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as market from '../src/utils/marketResearch.js';
import * as overview from '../src/utils/marketOverview.js';
import * as macro from '../src/utils/marketMacroSummary.js';
import * as quant from '../src/utils/quantGroups.js';
import * as validation from '../src/utils/marketResearchValidation.js';

function component(path, overrides = {}, exported = 'default') {
  const require = createRequire(import.meta.url);
  const compiled = require('typescript').transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: require('typescript').ModuleKind.CommonJS, jsx: require('typescript').JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name in overrides) return overrides[name];
    if (name.endsWith('.css')) return {};
    if (name.endsWith('marketResearch.js')) return market;
    if (name.endsWith('marketOverview.js')) return overview;
    if (name.endsWith('marketMacroSummary.js')) return macro;
    if (name.endsWith('quantGroups.js')) return quant;
    if (name.endsWith('marketResearchValidation.js')) return validation;
    if (name.startsWith('./Market')) return () => null;
    return require(name);
  }, loaded, loaded.exports);
  return loaded.exports[exported];
}

function hooks() {
  const slots = []; let cursor = 0; let effects = []; let dirty = false;
  return {
    react: { ...React,
      useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, update => { const next = typeof update === 'function' ? update(slots[i].value) : update; if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; } }]; },
      useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
      useCallback(fn) { cursor++; return fn; },
      useEffect(fn, deps) { const i = cursor++; const previous = slots[i]; if (!previous || deps.some((dep, index) => !Object.is(dep, previous.deps[index]))) { slots[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
    },
    render(fn) { let result; let attempts = 0; do { dirty = false; cursor = 0; result = fn(); const pending = effects; effects = []; for (const effect of pending) effect(); if (++attempts > 30) throw new Error('Unstable hook render'); } while (dirty); return result; },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function summary() {
  return macro.buildMarketMacroSummary({ generatedAt: new Date().toISOString(), companies: [{ ticker: 'AAPL', cik: '320193', sic: '3571', sector: 'Technology', cohorts: [], reports: { ttm: { end: '2026-06-30' } }, metrics: { ttm: { revenueGrowth: 5, netMargin: 20, cashFlowMargin: 25, capexIntensity: 3, equityToAssets: 30, netIncome: 100 } } }], cohorts: [] });
}

function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props?.children)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

test('Market preserves local search, uses replace/push only for URL changes, and restores browser history', t => {
  const harness = hooks(), writes = [], listeners = new Map(), originalWindow = globalThis.window;
  const navigate = (method, path) => { writes.push({ method, path }); window.location.search = new URL(path, 'https://example.test').search; };
  globalThis.window = { location: { pathname: '/market', search: '?tab=sectors', origin: 'https://example.test' },
    history: { replaceState: (_state, _title, path) => navigate('replace', path), pushState: (_state, _title, path) => navigate('push', path) },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  t.after(() => { harness.dispose(); globalThis.window = originalWindow; });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Fresh summaries must not refetch'); });
  const result = summary(), initialData = { generatedAt: result.generatedAt, summaries: { annual: result, ttm: result } };
  const Client = component('../src/app/market/MarketOverviewClient.tsx', { react: harness.react, 'next/dynamic': () => () => null,
    '../../utils/marketResearchValidation.js': { isMarketBriefing: () => true } });
  const render = () => harness.render(() => Client({ initialData }));
  let tree = render();
  const sector = () => findElement(tree, node => typeof node.props?.onCompanyViewChange === 'function').props;
  assert.deepEqual(writes, []);
  sector().onCompanyViewChange({ companyQuery: 'Apple' }); tree = render();
  assert.equal(sector().companyQuery, 'Apple');
  assert.equal(writes.at(-1).method, 'replace');
  assert.equal(new URLSearchParams(window.location.search).get('companyQuery'), 'Apple');
  const queryWrites = writes.length;
  sector().onCompanyViewChange({ companyQuery: 'Apple ' }); tree = render();
  assert.equal(sector().companyQuery, 'Apple ', 'typing whitespace still updates the input when the canonical URL is unchanged');
  assert.equal(writes.length, queryWrites);
  sector().onMetric('revenueGrowth'); tree = render();
  assert.equal(writes.length, queryWrites, 'selecting the active metric is a no-op');
  sector().onMetric('netMargin'); tree = render();
  assert.equal(writes.at(-1).method, 'replace');
  assert.equal(sector().metric, 'netMargin');
  const sectorPath = writes.at(-1).path;
  findElement(tree, node => node.type === 'button' && React.Children.toArray(node.props.children).includes('Market Briefing')).props.onClick();
  tree = render();
  assert.equal(writes.at(-1).method, 'push');
  const count = writes.length;
  window.location.search = new URL(sectorPath, 'https://example.test').search;
  listeners.get('popstate')(); tree = render();
  assert.equal(sector().metric, 'netMargin');
  assert.equal(writes.length, count, 'restoring a canonical URL must not navigate again');
});

test('disabled CFTC direct links restore the SEC view and omit positioning controls', t => {
  const harness = hooks(), originalWindow = globalThis.window;
  globalThis.window = { location: { pathname: '/market', search: '?tab=positioning&basis=annual', origin: 'https://example.test' },
    history: { replaceState(_state, _title, path) { window.location.search = new URL(path, 'https://example.test').search; } },
    addEventListener() {}, removeEventListener() {} };
  t.after(() => { harness.dispose(); globalThis.window = originalWindow; });
  const result = summary(), initialData = { generatedAt: result.generatedAt, summaries: { annual: result, ttm: result } };
  const Client = component('../src/app/market/MarketOverviewClient.tsx', { react: harness.react, 'next/dynamic': () => () => null });
  const tree = harness.render(() => Client({ initialData, cftcEnabled: false }));
  assert.equal(new URLSearchParams(window.location.search).get('basis'), 'annual');
  assert.notEqual(new URLSearchParams(window.location.search).get('tab'), 'positioning');
  const html = renderToStaticMarkup(tree);
  assert.doesNotMatch(html, /CFTC Positioning|Positioning across futures/);
  assert.match(html, /Market Briefing/);
});

test('direct CFTC URL restores before SEC loading; navigating to sectors makes one compact request', async () => {
  const harness = hooks(); const calls = []; const listeners = new Map(); const originalWindow = globalThis.window; const originalFetch = globalThis.fetch;
  globalThis.window = { location: { pathname: '/market', search: '?tab=positioning', origin: 'https://example.test' }, history: { replaceState(_state, _title, path) { const url = new URL(path, 'https://example.test'); window.location.search = url.search; } }, addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  const result = summary();
  globalThis.fetch = async path => { calls.push(path); return { ok: true, json: async () => ({ version: 'market-briefing-v1', generatedAt: result.generatedAt, requested: 1, summaries: { annual: result, ttm: result }, failureCount: 0 }) }; };
  const Client = component('../src/app/market/MarketOverviewClient.tsx', { react: harness.react, 'next/dynamic': () => () => null, '../../utils/marketResearchValidation.js': { isMarketBriefing: () => true } });
  try {
    harness.render(() => Client({}));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [], 'CFTC visitors must not request any SEC snapshot');
    window.location.search = '?tab=sectors'; listeners.get('popstate')();
    harness.render(() => Client({}));
    await new Promise(resolve => setImmediate(resolve));
    harness.render(() => Client({}));
    assert.deepEqual(calls, ['/api/market-briefing']);
    window.location.search = '?tab=positioning'; listeners.get('popstate')(); harness.render(() => Client({}));
    window.location.search = '?tab=sectors'; listeners.get('popstate')(); harness.render(() => Client({}));
    assert.deepEqual(calls, ['/api/market-briefing'], 'fresh summaries survive tab navigation');
  } finally { harness.dispose(); globalThis.window = originalWindow; globalThis.fetch = originalFetch; }
});

test('overview mounts no constituent request; sector view opens companies while industry details stay closed', () => {
  let mounts = 0;
  const Sector = component('../src/app/market/MarketSectorPerformance.tsx', { 'next/dynamic': () => () => { mounts++; return null; } });
  const props = { summary: summary(), basis: 'ttm', statistic: 'median', selectedSector: 'all', metric: 'revenueGrowth', onStatistic() {}, onSector() {}, onMetric() {} };
  renderToStaticMarkup(React.createElement(Sector, { ...props, compact: true }));
  assert.equal(mounts, 0);
  renderToStaticMarkup(React.createElement(Sector, props));
  assert.equal(mounts, 1);
});

test('industry data validation binds sector and basis and rejects unusable metric denominators', () => {
  const validate = component('../src/app/market/MarketSectorIndustries.tsx', {}, 'isMarketIndustries');
  const sector = summary().sectors[0];
  const result = { version: 'market-industries-v1', generatedAt: new Date().toISOString(), sector: sector.id, basis: 'ttm', industries: sector.industries, missingIndustryCount: 0 };
  assert.equal(validate(result, sector.id, 'ttm'), true);
  assert.equal(validate(result, 'sector-energy', 'ttm'), false);
  assert.equal(validate(result, sector.id, 'annual'), false);
  assert.equal(validate({ ...result, generatedAt: 'invalid' }, sector.id, 'ttm'), false);
  const malformed = structuredClone(result); malformed.industries[0].metrics.revenueGrowth.count = 100;
  assert.equal(validate(malformed, sector.id, 'ttm'), false);
  assert.equal(validate({ ...result, industries: [...result.industries, ...result.industries] }, sector.id, 'ttm'), false);
});
