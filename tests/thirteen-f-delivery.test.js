import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import * as delivery from '../src/utils/thirteenFDelivery.js';
import { summarize13FPortfolio } from '../src/utils/thirteenF.js';
import { GET } from '../src/app/api/fund-13f/route.js';

const CIK = '0001350694', PERIOD = '2026-06-30';
function fixture(count = 997) {
  const totalValueUsd = count * (count + 1) / 2;
  const holdings = Array.from({ length: count }, (_, index) => {
    const cusip = String(index).padStart(9, '0'), putCall = index % 9 === 0 ? 'PUT' : index % 8 === 0 ? 'CALL' : null;
    const quantityType = index % 7 === 0 ? 'PRN' : 'SH';
    return { key: `${cusip}|${putCall || 'SECURITY'}|${quantityType}`, cusip, issuer: `Issuer ${String(index).padStart(4, '0')}`, classTitle: 'COMMON', putCall, quantityType, quantity: index * 10, valueUsd: index + 1, weightPct: (index + 1) / totalValueUsd * 100, investmentDiscretion: 'SOLE', sourceRowCount: 1 };
  });
  const observedAt = new Date().toISOString();
  const portfolio = { cik: CIK, period: PERIOD, holdings, totalValueUsd, positionCount: count, entryCount: count, complete: true, comparable: true, confidentialOmitted: false, issues: [], filings: [{ accession: '0001350694-26-000001', form: '13F-HR', filingDate: '2026-08-14', indexUrl: 'https://www.sec.gov/Archives/edgar/data/1350694/000135069426000001/0001350694-26-000001-index.htm', tableUrls: ['https://www.sec.gov/Archives/edgar/data/1350694/000135069426000001/table.xml'] }] };
  const summary = summarize13FPortfolio(portfolio); delete summary.holdings;
  return { status: 'ready', manager: { cik: CIK, name: 'Fixture Capital' }, selectedPeriod: PERIOD, reports: [{ period: PERIOD, filingCount: 1, latestFiled: '2026-08-14', forms: ['13F-HR'] }], portfolio, summary, coverage: { selectedPeriodComplete: true }, observedAt, cache: { status: 'shared', stale: false, checkedAt: observedAt, freshUntil: new Date(Date.now() + 300000).toISOString() } };
}
const opts = query => delivery.normalize13FDelivery(new URLSearchParams(query));

test('997-position overview and page responses preserve all financial denominators and evidence without copying the full table', () => {
  const source = fixture(), before = JSON.stringify(source);
  const summary = delivery.project13FDelivery(source, { mode: 'summary' });
  const page = delivery.project13FDelivery(source, { mode: 'holdings' });
  for (const result of [summary, page]) {
    assert.equal(result.summary, source.summary);
    assert.equal(result.portfolio.totalValueUsd, source.portfolio.totalValueUsd);
    assert.equal(result.portfolio.positionCount, 997);
    assert.equal(result.portfolio.filings, source.portfolio.filings);
    assert.equal(result.coverage, source.coverage);
    assert.equal(result.delivery.holdingsComplete, false);
    assert.equal(result.portfolio.holdings[0].weightPct, source.portfolio.holdings.at(-1).weightPct);
    assert.equal(delivery.valid13FDelivery(result, { mode: result.delivery.mode }), true);
  }
  assert.equal(summary.portfolio.holdings.length, 10);
  assert.equal(page.portfolio.holdings.length, 25);
  assert.equal(JSON.stringify(source), before, 'Projection cannot truncate or reorder the prepared source');
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < Buffer.byteLength(before) * 0.06);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < Buffer.byteLength(before) * 0.08);
});

test('Every holding is reachable exactly once across server pages and an explicit full export retains all 997 rows', () => {
  const source = fixture(), rows = [];
  const snapshot = delivery.thirteenFReportVersion(source);
  for (let offset = 0; offset < 997; offset += 25) {
    const options = { mode: 'holdings', offset, snapshot };
    const page = delivery.project13FDelivery(source, options);
    assert.equal(delivery.valid13FDelivery(page, options), true);
    rows.push(...page.portfolio.holdings);
  }
  assert.equal(rows.length, 997);
  assert.equal(new Set(rows.map(row => row.key)).size, 997);
  assert.deepEqual(rows.map(row => row.valueUsd), Array.from({ length: 997 }, (_, index) => 997 - index));
  const full = delivery.project13FDelivery(source, { mode: 'full', snapshot });
  assert.equal(full.portfolio.holdings.length, 997);
  assert.equal(full.delivery.holdingsComplete, true);
  assert.equal(delivery.valid13FDelivery(full), true);
});

test('Search and security filters find positions outside the initial page and never renormalize weights', () => {
  const source = fixture();
  const options = { mode: 'holdings', query: '000000007', type: 'principal', sort: 'name' };
  const result = delivery.project13FDelivery(source, options);
  assert.equal(result.portfolio.holdings.length, 1);
  assert.equal(result.portfolio.holdings[0], source.portfolio.holdings[7]);
  assert.equal(result.delivery.filteredTotal, 1);
  assert.equal(result.delivery.total, 997);
  assert.equal(delivery.valid13FDelivery(result, options), true);
  for (const type of ['PUT', 'CALL', 'ordinary', 'principal']) {
    const expected = delivery.select13FHoldings(source.portfolio.holdings, { type });
    const page = delivery.project13FDelivery(source, { mode: 'holdings', type });
    assert.equal(page.delivery.filteredTotal, expected.length);
    assert.deepEqual(page.portfolio.holdings, expected.slice(0, 25));
  }
});

test('Incomplete reports preserve unavailable values; tied and zero quantities sort without losing security identities', () => {
  const source = fixture(50);
  source.portfolio.complete = false; source.portfolio.comparable = false; source.portfolio.totalValueUsd = null;
  source.coverage.selectedPeriodComplete = false;
  source.portfolio.holdings = source.portfolio.holdings.map((row, index) => ({ ...row, valueUsd: index === 0 ? 0 : null, quantity: null, weightPct: null }));
  const result = delivery.project13FDelivery(source, { mode: 'holdings', sort: 'quantity' });
  assert.equal(result.portfolio.complete, false);
  assert.equal(result.portfolio.totalValueUsd, null);
  assert.ok(result.portfolio.holdings.every(row => row.weightPct === null));
  const next = delivery.project13FDelivery(source, { mode: 'holdings', sort: 'quantity', offset: 25 });
  assert.equal(new Set([...result.portfolio.holdings, ...next.portfolio.holdings].map(row => row.key)).size, 50);
  assert.equal(delivery.project13FDelivery(source, { mode: 'summary' }).portfolio.holdings[0].valueUsd, 0);
});

test('A changed source revision cannot be mixed into an old page or export; partial delivery cannot pass as complete', () => {
  const source = fixture();
  const snapshot = delivery.thirteenFReportVersion(source);
  const updated = structuredClone(source); updated.portfolio.filings.push({ accession: '0001350694-26-000002' });
  for (const mode of ['full', 'holdings']) assert.throws(() => delivery.project13FDelivery(updated, { mode, snapshot }), { status: 409, code: 'REPORT_UPDATED' });
  const page = delivery.project13FDelivery(source, { mode: 'holdings' });
  assert.equal(delivery.valid13FDelivery(page, { mode: 'full' }), false);
  const corrupted = structuredClone(page); corrupted.delivery.mode = 'full';
  assert.equal(delivery.valid13FDelivery(corrupted), false);
  const wrongPage = structuredClone(page); wrongPage.delivery.offset = 25;
  assert.equal(delivery.valid13FDelivery(wrongPage, { mode: 'holdings' }), false);
  assert.equal(delivery.valid13FDelivery(page, { mode: 'holdings', query: 'different' }), false);
});

test('Malformed, duplicated and unbounded delivery selectors are rejected before source work', async () => {
  for (const query of ['delivery=', 'delivery=other', 'delivery=summary&delivery=summary', 'offset=25', 'delivery=summary&q=test', 'delivery=holdings&offset=1', 'delivery=holdings&offset=20025', 'delivery=holdings&offset=-25', 'delivery=holdings&offset=025', 'delivery=holdings&type=unknown', 'delivery=holdings&sort=random', 'delivery=holdings&q=' + 'x'.repeat(161), 'delivery=holdings&q=a%00b', 'snapshot=', 'snapshot=made-up', 'delivery=holdings&snapshot=../file']) {
    assert.throws(() => opts(query), { status: 400 });
    const response = await GET(new Request(`https://example.test/api/fund-13f?cik=${CIK}&${query}`));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

function client() {
  const source = readFileSync(new URL('../src/app/fund/ThirteenFWorkspace.tsx', import.meta.url), 'utf8') + '\nexport { fetchReport as testFetch };';
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const output = { exports: {} };
  const require = name => {
    if (name === 'react') return React;
    if (name.endsWith('thirteenFDelivery.js')) return delivery;
    if (name === 'next/dynamic') return () => () => null;
    return {};
  };
  new Function('require', 'module', 'exports', compiled)(require, output, output.exports);
  return output.exports.testFetch;
}

test('Browser delivery cache separates summaries from full reports and reuses full data for later pages', async () => {
  const fetchReport = client(), source = fixture(), originalFetch = globalThis.fetch, urls = [];
  globalThis.fetch = async input => {
    const url = new URL(input, 'https://example.test'); urls.push(url);
    return Response.json(delivery.project13FDelivery(source, opts(url.search)));
  };
  try {
    const signal = new AbortController().signal;
    const summary = await fetchReport(CIK, '', signal, false, { mode: 'summary' });
    assert.equal(summary.portfolio.holdings.length, 10);
    assert.equal(urls[0].searchParams.get('delivery'), 'summary');
    const full = await fetchReport(CIK, PERIOD, signal, false, { mode: 'full' });
    assert.equal(full.portfolio.holdings.length, 997);
    assert.equal(urls.length, 2, 'A summary must never satisfy a full-portfolio request');
    const page = await fetchReport(CIK, PERIOD, signal, false, { mode: 'holdings', offset: 25, snapshot: summary.delivery.version });
    assert.equal(page.portfolio.holdings.length, 25);
    assert.equal(page.portfolio.holdings[0].valueUsd, 972);
    assert.equal(urls.length, 2, 'Reuse a verified cached full portfolio for subsequent pages');
    await fetchReport(CIK, PERIOD, signal, true, { mode: 'summary' });
    await fetchReport(CIK, PERIOD, signal, false, { mode: 'full' });
    assert.equal(urls.length, 4, 'Refresh invalidates full and projected browser aliases together');
  } finally { globalThis.fetch = originalFetch; }
});

test('Browser rejects a returned page that does not match the requested snapshot or offset', async () => {
  const fetchReport = client(), source = fixture(), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(delivery.project13FDelivery(source, { mode: 'holdings', offset: 0 }));
  try { await assert.rejects(fetchReport(CIK, PERIOD, new AbortController().signal, false, { mode: 'holdings', offset: 25 }), /did not match/); }
  finally { globalThis.fetch = originalFetch; }
});
