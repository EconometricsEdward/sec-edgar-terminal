import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const universe = JSON.parse(readFileSync(new URL('../public/portfolio/portfolio-demo-100-universe.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/app/workspace/demo/changes/page.tsx', import.meta.url), 'utf8');

function summaryPage({ result = null, enabled = true, error = false } = {}) {
  let reads = 0;
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const testModule = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react/jsx-runtime') return require(name);
    if (name === 'next/link') return function TestLink({ prefetch: _prefetch, ...props }) { return createElement('a', props); };
    if (name === 'next/cache') return { unstable_cache: fn => fn };
    if (name.endsWith('/siteMetadata')) return { buildPageMetadata: value => value };
    if (name.endsWith('/cftcFeature.js')) return { isCftcEnabled: () => enabled };
    if (name.endsWith('/portfolioCftcPreparation.js')) return { readPreparedDemoCftcChanges: async ({ days }) => {
      reads += 1; assert.equal(days, 30);
      if (error) throw new Error('private storage failure');
      return result;
    } };
    if (name.endsWith('/portfolio-demo-100-universe.json')) return universe;
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected public page dependency: ${name}`);
  }, testModule, testModule.exports);
  return { module: testModule.exports, reads: () => reads, html: async () => renderToStaticMarkup(await testModule.exports.default()) };
}

function snapshot() {
  const issuer = universe.companies[0];
  const filing = { form: '10-K', filed: '2026-02-25', url: `https://www.sec.gov/Archives/edgar/data/${Number(issuer.cik)}/000000000026000001/annual.htm`,
    text: 'Our operations depend on commodity input markets and may be affected by changes in their prices.' };
  return {
    generatedAt: '2026-09-16T10:00:00Z', cutoff: '2026-08-18',
    coverage: { checked: 100, linked: 1, noLink: 99, noFiling: 0, unavailable: 0, uniqueMarkets: 1, marketsChecked: 1, marketUnavailable: 0, staleMarkets: 0, partialMarkets: 0 },
    companyChecks: universe.companies.map((company, index) => ({ ticker: company.ticker, cik: company.cik, status: index ? 'no_matches' : 'linked', checkedAt: '2026-09-16T09:00:00Z' })),
    events: Array.from({ length: 25 }, (_, index) => ({ id: `event-${index}`, reportDate: '2026-09-08', priorDate: '2026-09-01',
      title: `Market comparison ${index}`, description: 'Net share of total open interest increased by 1.50 percentage points.', netPctChange: 1.5,
      openInterestChangePct: -2, traderGroupLabel: 'Managed Money', marketPath: '/market?tab=positioning&contract=067651',
      cftcSource: 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json', retrievedAt: '2026-09-12T12:00:00Z',
      sourceCurrency: 'current', historyStatus: 'ready', relatedCompanies: [{ ticker: issuer.ticker, candidate: { reason: 'A candidate business connection supported by filing evidence.', filing } }] })),
    methodology: 'A weekly comparison is not a statistical significance test.', limitation: 'Market observations do not report individual company positions.',
    preparation: { status: 'ready', checkedAt: '2026-09-16T10:00:00Z', nextCheckAt: '2026-09-17T10:00:00Z', totalCompanies: 100, completedCompanies: 100 },
  };
}

test('public initial HTML includes dated real findings, primary sources and all 100 company checks with bounded events', async () => {
  const page = summaryPage({ result: snapshot() });
  const html = await page.html();
  assert.equal(page.module.metadata.path, '/workspace/demo/changes');
  assert.equal(page.reads(), 1);
  assert.match(html, /Market comparison 0</);
  assert.match(html, /Market comparison 19</);
  assert.doesNotMatch(html, /Market comparison 20</);
  assert.match(html, /Showing the 20 most recent of 25 qualifying changes/);
  assert.match(html, /100 of 100 checks completed/);
  assert.match(html, /1\.50 percentage points/);
  assert.match(html, /datetime="2026-09-08"/i);
  assert.match(html, /href="https:\/\/www.sec.gov\/Archives/);
  assert.match(html, /href="https:\/\/publicreporting.cftc.gov\/resource\/72hh-3qpy.json"/);
  for (const company of universe.companies) assert.ok(html.includes(`href="/filings/${company.ticker}"`));
  assert.match(html, /candidate connection does not establish the size, direction or materiality/i);
  assert.doesNotMatch(html, /NaN|undefined|private storage failure/);
});

test('public summary distinguishes stale, partial, absent and disabled research without acquisition', async () => {
  const stale = snapshot();
  stale.preparation.status = 'stale'; stale.coverage.checked = 99; stale.coverage.unavailable = 1;
  stale.companyChecks[0].status = 'unavailable';
  const html = await summaryPage({ result: stale }).html();
  assert.match(html, /Refresh due/);
  assert.match(html, /99 of 100 checks completed/);
  assert.match(html, /Check incomplete · retry needed/);
  assert.match(html, /Some company or market checks are incomplete/);
  for (const error of [false, true]) {
    const missing = await summaryPage({ error }).html();
    assert.match(missing, /Prepared research is not yet available/);
    assert.match(missing, /0 of 100 checks completed/);
    assert.doesNotMatch(missing, /Market comparison|private storage failure/);
  }
  const disabled = summaryPage({ enabled: false, result: snapshot() });
  assert.match(await disabled.html(), /CFTC research is currently disabled/);
  assert.equal(disabled.reads(), 0);
});

async function routeFixture() {
  const { mock } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const root = process.argv[1];
  let enabled = true, calls = 0, result = null, fail = false;
  mock.module(new URL('src/utils/cftcFeature.js', root).href, { namedExports: { isCftcEnabled: () => enabled } });
  mock.module(new URL('src/utils/portfolioCftcChanges.js', root).href, { namedExports: { PORTFOLIO_CFTC_CHANGES_VERSION: 'edgar.portfolio-cftc-changes.v2' } });
  mock.module(new URL('src/utils/portfolioCftcPreparation.js', root).href, { namedExports: { readPreparedDemoCftcChanges: async ({ days, signal }) => {
    calls += 1; assert.equal(days, 30); assert.ok(signal instanceof AbortSignal);
    if (fail) throw new Error('private provider credential details');
    return result;
  } } });
  const { GET, OPTIONS } = await import(new URL('src/app/api/v1/cftc/portfolio-changes/demo/route.js', root).href);
  const request = (query = '') => new Request(`https://secedgarterminal.com/api/v1/cftc/portfolio-changes/demo${query}`);
  for (const query of ['?days=0', '?days=91', '?days=1.5', '?days=030', '?days=', '?days=30&days=30', '?ticker=AAPL']) {
    const response = await GET(request(query));
    assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(calls, 0);
  const missing = await GET(request());
  assert.equal(missing.status, 503); assert.equal((await missing.json()).code, 'DEMO_CFTC_NOT_PREPARED');
  assert.equal(missing.headers.get('retry-after'), '60');
  result = { preparation: { status: 'stale', completedCompanies: 100 }, events: [], coverage: { checked: 100 } };
  const ready = await GET(request('?days=30'));
  assert.equal(ready.status, 200); assert.deepEqual(await ready.json(), result);
  assert.equal(ready.headers.get('cache-control'), 'public, max-age=0, s-maxage=60, stale-while-revalidate=60');
  assert.equal(ready.headers.get('access-control-allow-origin'), '*');
  fail = true;
  const failed = await GET(request());
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private provider/);
  const beforeDisabled = calls; enabled = false;
  const disabled = await GET(request());
  assert.equal(disabled.status, 503); assert.equal(calls, beforeDisabled);
  assert.equal((await disabled.json()).code, 'CFTC_DISABLED');
  assert.equal(OPTIONS().status, 204);
  mock.restoreAll();
}

test('public GET only reads prepared research, validates windows and does not cache unavailable responses', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e',
    `await (${routeFixture.toString()})();`, new URL('../', import.meta.url).href],
  { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
});
