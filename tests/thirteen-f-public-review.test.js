import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { CFTC_LAUNCH_CATALOG } from '../src/utils/cftc.js';
import * as publicReview from '../src/utils/thirteenFPublicReview.js';

const CIK = '0001350694', ISSUER = '0000001234', PERIOD = '2026-06-30', CHECKED = '2026-09-15T12:00:00.000Z';
const SOFR = CFTC_LAUNCH_CATALOG.find(market => market.code === '134741');
const source = () => ({ url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000001/report.htm',
  accession: '0000001234-26-000001', form: '10-K', filed: '2026-02-20', reportDate: '2025-12-31' });
function fixture() {
  const market = { key: 'tff:134741:leveraged-funds', family: 'tff', contract: '134741', group: 'leveraged-funds',
    label: SOFR.label, fit: 'named-reference', basisLimit: 'Issuer borrowing-rate reference; not measured sensitivity.',
    holdingCount: 80, valueUsd: 240, sharePct: 24 };
  return {
    job: { cik: CIK, period: PERIOD, total: 997, state: 'working', portfolioComplete: true,
      denominatorUsd: 1000, coverage: { selectedPeriodComplete: true }, reportCheckedAt: CHECKED },
    report: { cik: CIK, period: PERIOD, managerName: 'Fixture Capital', totalValueUsd: 1000, complete: true, observedAt: CHECKED },
    coverage: { total: 997, reviewed: 135, attempted: 140, available: 140, checked: 130, linked: 80,
      unchecked: 857, unresolved: 5, unavailable: 3, partial: 2, stale: 4, linkedSharePct: 24 },
    markets: [market], rows: Array.from({ length: 50 }, (_, index) => ({
      holding: { key: `${String(index).padStart(9, '0')}|SECURITY|SH`, issuer: `Company ${index}` },
      issuer: { cik: ISSUER, name: `Company ${index}` }, status: 'linked', checked: true, checkedAt: CHECKED,
      markets: [market], sources: [source()], stale: index === 0,
    })), page: { offset: 0, limit: 50, total: 997 }, publicationVersion: 'published-1', publishedAt: CHECKED,
  };
}

function component({ snapshot = fixture(), fail = false, enabled = true } = {}) {
  const calls = [];
  const code = ts.transpileModule(readFileSync(new URL('../src/app/fund/ManagerMarketResearch.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const result = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'next/cache') return { unstable_cache: fn => fn };
    if (name === 'next/link') return function Link({ prefetch: _prefetch, ...props }) { return React.createElement('a', props); };
    if (name.endsWith('/thirteenFPublicReview.js')) return publicReview;
    if (name.endsWith('/cftcFeature.js')) return { isCftcEnabled: () => enabled };
    if (name.endsWith('/thirteenFReviewStore.js')) return { thirteenFReviewStore: {
      snapshot: async (...args) => { calls.push(args); if (fail) throw new Error('private storage failure'); return snapshot; },
      enqueue: () => { throw new Error('A public visit must not enqueue research'); },
    } };
    if (name.endsWith('.css')) return new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : String(key) });
    throw new Error(`Unexpected component dependency ${name}`);
  }, result, result.exports);
  return { ...result.exports, calls };
}

test('saved manager HTML publishes exact aggregate coverage and sources without acquiring or preparing research', async () => {
  const view = component();
  const html = renderToStaticMarkup(await view.default({ cik: CIK, period: PERIOD }));
  assert.equal(view.calls.length, 1);
  assert.deepEqual(view.calls[0][0], { cik: CIK, period: PERIOD });
  assert.equal(view.calls[0][1].timeoutMs, 2000);
  assert.ok(view.calls[0][1].signal instanceof AbortSignal);
  assert.match(html, /130/); assert.match(html, /997/); assert.match(html, /857/); assert.match(html, /24\.00%/);
  assert.match(html, /full reconciled 13F value of \$1,000/);
  assert.match(html, /not measured economic exposures/);
  assert.match(html, /shares below must not be added together/);
  assert.match(html, /datetime="2026-06-30"/i);
  assert.match(html, /datetime="2026-02-20"/i);
  assert.match(html, /datetime="2025-12-31"/i);
  assert.match(html, /Evidence checked/);
  assert.match(html, /4 saved holding reviews await/);
  assert.match(html, /first 50 holdings/);
  assert.equal((html.match(/<h4>/g) || []).length, 3, 'Source examples remain bounded, distinct from aggregate coverage');
  assert.match(html, /href="https:\/\/www.sec.gov\/Archives\/edgar\/data\/1234\/000000123426000001\/report.htm"/);
  assert.match(html, /data-publication-version="published-1"/);
});

test('unsupported contracts and wrong-issuer or non-SEC sources never become published evidence', () => {
  const snapshot = fixture();
  for (const mutate of [
    value => { value.url = 'https://example.com/report.htm'; },
    value => { value.url = value.url.replace('/1234/', '/9999/'); },
    value => { value.url = value.url.replace('000000123426000001', '000000123426000002'); },
    value => { value.url += '?redirect=https://example.com'; },
    value => { value.form = '8-K'; },
    value => { value.filed = '2026-09-17'; },
    value => { value.reportDate = '2026-06-30'; },
  ]) {
    const invalid = source(); mutate(invalid);
    assert.equal(publicReview.publicReviewSource(invalid, ISSUER, CHECKED), null);
  }
  snapshot.rows.forEach(row => { row.sources = [{ ...source(), url: 'https://example.com/report.htm' }]; });
  snapshot.markets.push({ ...snapshot.markets[0], key: 'tff:999999:leveraged-funds', contract: '999999', label: 'Invented market' });
  const model = publicReview.public13FReview(snapshot, { cik: CIK, period: PERIOD });
  assert.equal(model.markets.length, 1); assert.deepEqual(model.examples, []);
});

test('saved review keeps the full denominator and withholds percentages when coverage is incomplete', () => {
  for (const mutate of [value => { value.report.complete = false; }, value => { value.job.coverage.selectedPeriodComplete = false; },
    value => { value.job.denominatorUsd = 900; }, value => { value.report.totalValueUsd = null; }]) {
    const snapshot = fixture(); mutate(snapshot);
    const model = publicReview.public13FReview(snapshot, { cik: CIK, period: PERIOD });
    assert.equal(model.denominatorUsd, null);
    assert.equal(model.coverage.linkedSharePct, null);
    assert.equal(model.markets[0].sharePct, null);
    assert.equal(model.coverage.checked, 130); assert.equal(model.coverage.total, 997);
  }
});

test('manager and quarter mismatches are rejected and missing publications disappear quietly', async () => {
  const snapshot = fixture();
  assert.equal(publicReview.public13FReview(snapshot, { cik: '0000000001', period: PERIOD }), null);
  assert.equal(publicReview.public13FReview(snapshot, { cik: CIK, period: '2026-03-31' }), null);
  assert.equal(publicReview.public13FReview({ ...snapshot, publishedAt: '2099-01-01' }, { cik: CIK }), null);
  for (const settings of [{ snapshot: null }, { fail: true }]) assert.equal(await component(settings).default({ cik: CIK }), null);
  const disabled = component({ enabled: false });
  assert.equal(await disabled.default({ cik: CIK }), null); assert.equal(disabled.calls.length, 0);
  const latest = component(); await latest.default({ cik: CIK });
  assert.deepEqual(latest.calls[0][0], { cik: CIK, period: null });
  const different = renderToStaticMarkup(await latest.default({ cik: CIK, briefPeriod: '2026-03-31' }));
  assert.match(different, /Different saved quarter/);
  assert.match(different, /datetime="2026-03-31"/i);
});

test('public review cache bounds entries and bytes, deduplicates concurrent reads and expires saved quarters', async () => {
  const reads = [], start = Date.parse(CHECKED); let clock = start;
  const loader = publicReview.createPublic13FReviewReader({ now: () => clock, maxEntries: 2, ttlMs: 60,
    read: async selection => {
      reads.push(selection.cik); const saved = fixture();
      saved.job.cik = selection.cik; saved.report.cik = selection.cik;
      return saved;
    } });
  await Promise.all([loader(CIK), loader(CIK)]); assert.equal(reads.length, 1);
  await loader('0000000002'); await loader(CIK); await loader('0000000003');
  await loader(CIK); assert.equal(reads.length, 3, 'Recently used model survives LRU eviction');
  await loader('0000000002'); assert.equal(reads.length, 4, 'Oldest model was evicted');
  clock += 61; await loader(CIK); assert.equal(reads.length, 5);
  let oversizedReads = 0;
  const smallCache = publicReview.createPublic13FReviewReader({ maxBytes: 1, read: async () => { oversizedReads++; return fixture(); } });
  await smallCache(CIK); await smallCache(CIK); assert.equal(oversizedReads, 2, 'Oversized projections are not retained');
});

test('saved review timeout is bounded even if transport ignores cancellation', async () => {
  const read = publicReview.createPublic13FReviewReader({ budgetMs: 10, read: async () => new Promise(() => {}) });
  assert.equal(await read(CIK), null);
});
