import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isBankDirectory, loadBankDirectory } from '../src/app/analysis/banks/directoryRecovery.js';

const directory = {
  bankCount: 4445,
  periods: ['2026-06-30', '2026-03-31', '2025-12-31', '2025-09-30'],
  banks: [{ id_rssd: 493741, legal_name: 'ALLIANCE BANK', city: 'FRANCESVILLE', state: 'IN', prepared_quarters: 4 }],
};

test('directory recovery validates data without confusing an unavailable directory with an empty one', () => {
  assert.equal(isBankDirectory(directory), true);
  assert.equal(isBankDirectory({ bankCount: 0, banks: [], periods: [] }), true);
  for (const invalid of [null, {}, { banks: [], unavailable: true }, { ...directory, bankCount: null },
    { ...directory, periods: ['invalid'] }, { ...directory, banks: [{ ...directory.banks[0], id_rssd: '../company' }] },
    { ...directory, banks: [{ ...directory.banks[0], legal_name: {} }] },
    { ...directory, banks: [{ ...directory.banks[0], state: {} }] }]) {
    assert.equal(isBankDirectory(invalid), false);
  }
});

test('directory recovery performs one read-only uncached request and returns validated data', async () => {
  const requests = [];
  const loaded = await loadBankDirectory({ fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json(directory);
  } });
  assert.deepEqual(loaded, directory);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/banks?q=');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.method, undefined);
  assert.equal(requests[0].options.body, undefined);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('a failed recovery or invalid success body is rejected without a retry loop or invented counts', async () => {
  for (const response of [Response.json({ error: 'Unavailable' }, { status: 503 }), Response.json({ banks: [] })]) {
    let calls = 0;
    await assert.rejects(loadBankDirectory({ fetchImpl: async () => { calls++; return response; } }));
    assert.equal(calls, 1);
  }
});

test('leaving the directory cancels an in-flight recovery request', async () => {
  const controller = new AbortController();
  let outgoingSignal;
  const result = loadBankDirectory({ signal: controller.signal, fetchImpl: (_url, options) => {
    outgoingSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(outgoingSignal.aborted, true);
});

const require = createRequire(import.meta.url);
const ts = require('typescript');
function renderDirectory(data) {
  const source = readFileSync(new URL('../src/app/analysis/banks/BankDirectory.jsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const testModule = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'next/link') return function Link({ prefetch: _prefetch, ...props }) { return createElement('a', props); };
    if (name === './BankSearch') return function BankSearch() { return createElement('input', { 'aria-label': 'Find a bank' }); };
    if (name === './directoryRecovery.js') return { isBankDirectory, loadBankDirectory };
    if (name.endsWith('/viewModel.js')) return { quarterLabel: period => period };
    if (name.endsWith('.css')) return new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : String(key) });
    throw new Error(`Unexpected directory dependency: ${name}`);
  }, testModule, testModule.exports);
  return renderToStaticMarkup(createElement(testModule.exports.default, { directory: data }));
}

test('unavailable SSR directory retains search and renders unknown counts plus recovery status', () => {
  const html = renderDirectory({ banks: [], unavailable: true });
  assert.match(html, /aria-label="Find a bank"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Reconnecting to the bank directory/);
  assert.match(html, /<button[^>]*disabled[^>]*>Retrying/);
  assert.equal((html.match(/<strong>—<\/strong>/g) || []).length, 2);
  assert.doesNotMatch(html, /<strong>0<\/strong>|Ready to explore/);
});

test('successful SSR directory retains bank counts and profile links without triggering recovery UI', () => {
  const html = renderDirectory(directory);
  assert.match(html, /<strong>4,445<\/strong>/);
  assert.match(html, /<strong>4<\/strong>/);
  assert.match(html, /href="\/analysis\/banks\/493741"/);
  assert.match(html, /ALLIANCE BANK/);
  assert.doesNotMatch(html, /Reconnecting|Retry directory|<strong>—<\/strong>/);
});

test('stale but valid directory retains data and identifies its saved time without recovery UI', () => {
  for (const cachedAt of ['2026-09-27T15:30:00.000Z', Date.parse('2026-09-27T15:30:00.000Z')]) {
    const html = renderDirectory({ ...directory, stale: true, cachedAt });
    assert.match(html, /Showing the last available directory/);
    assert.match(html, /dateTime="2026-09-27T15:30:00.000Z"/);
    assert.match(html, /2026-09-27 15:30 UTC/);
    assert.match(html, /<strong>4,445<\/strong>/);
    assert.doesNotMatch(html, /Reconnecting|Retry directory|<strong>—<\/strong>/);
  }
});

test('invalid optional saved times are omitted safely without hiding the valid directory', () => {
  for (const cachedAt of [undefined, 'not a date', {}, 1e100]) {
    const html = renderDirectory({ ...directory, stale: true, cachedAt });
    assert.match(html, /Showing the last available directory/);
    assert.match(html, /ALLIANCE BANK/);
    assert.doesNotMatch(html, /Invalid Date|NaN|<time/);
  }
});
