import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalize13FHistoryRequest, create13FHistoryLoader } from '../src/utils/thirteenFHistoryServer.js';
import { GET } from '../src/app/api/fund-13f/history/route.js';

const CIK = '0001747057';
const PERIOD = '2026-06-30';
const KEY = '00827B106|SECURITY|SH';
const keysJson = JSON.stringify([KEY]);
function position(cusip = '00827B106') {
  return { key: `${cusip}|SECURITY|SH`, cusip, issuer: 'Example Company', classTitle: 'COM', putCall: null, quantityType: 'SH', quantity: 10, valueUsd: 100, weightPct: 100 };
}
function report(overrides = {}) {
  return {
    status: 'ready', manager: { cik: CIK, name: 'Fixture Capital LP' }, selectedPeriod: PERIOD,
    portfolio: { cik: CIK, period: PERIOD, holdings: [position()], totalValueUsd: 100, positionCount: 1, entryCount: 1, complete: true, comparable: true, confidentialOmitted: false, reportType: '13F HOLDINGS REPORT', amendmentCount: 0, filings: [], issues: [] },
    coverage: { historyComplete: true, selectedPeriodComplete: true }, observedAt: '2026-09-15T15:00:00.000Z', ...overrides,
  };
}

test('history requests require a specific calendar quarter and bounded distinct position keys', () => {
  assert.deepEqual(normalize13FHistoryRequest('1747057', PERIOD, keysJson), { cik: CIK, period: PERIOD, keys: [KEY] });
  assert.deepEqual(normalize13FHistoryRequest(CIK, PERIOD, '[]').keys, []);
  for (const [cik, period, keys] of [
    ['0', PERIOD, keysJson], [CIK, '', keysJson], [CIK, '2026-06-29', keysJson], [CIK, PERIOD, undefined],
    [CIK, PERIOD, 'not json'], [CIK, PERIOD, '{}'], [CIK, PERIOD, 'null'], [CIK, PERIOD, '[null]'],
    [CIK, PERIOD, JSON.stringify([KEY, KEY])], [CIK, PERIOD, JSON.stringify(Array(33).fill(KEY))],
    [CIK, PERIOD, ' '.repeat(1801)], [CIK, PERIOD, '"00827B106|SECURITY|SH"'],
    [CIK, PERIOD, '["https://www.sec.gov/source"]'], [CIK, PERIOD, '["00827B106|SECURITY|SH|COM"]'],
    [CIK, PERIOD, '["__proto__"]'],
  ]) assert.throws(() => normalize13FHistoryRequest(cik, period, keys), { status: 400 });
});

test('history loader forwards verified identities and cancellation while retaining only projected holdings', async () => {
  const full = report();
  const rows = [position(), ...Array.from({ length: 10000 }, (_, index) => position(String(index).padStart(9, '0')))];
  full.portfolio = { ...full.portfolio, holdings: rows, positionCount: rows.length, entryCount: rows.length, totalValueUsd: rows.length * 100 };
  const controller = new AbortController();
  let captured;
  const loader = create13FHistoryLoader({ loadReport: async (cik, options) => { captured = { cik, options }; return full; } });
  const result = await loader('1747057', { period: PERIOD, keys: [KEY, '999999999|CALL|SH'], signal: controller.signal });
  assert.equal(captured.cik, CIK);
  assert.equal(captured.options.period, PERIOD);
  assert.equal(captured.options.signal, controller.signal);
  assert.equal(result.manager.cik, CIK);
  assert.equal(result.projection.totalValueUsd, rows.length * 100);
  assert.equal(result.projection.positionCount, rows.length);
  assert.deepEqual(result.projection.trackedKeys, [KEY, '999999999|CALL|SH']);
  assert.equal(result.projection.positions[KEY].quantity, 10);
  assert.equal(result.projection.positions['999999999|CALL|SH'], null);
  assert.equal(Object.hasOwn(result, 'portfolio'), false);
  assert.equal(Object.hasOwn(result.projection, 'holdings'), false);
  assert.ok(JSON.stringify(result).length < 5000, 'A 10,001-position portfolio must remain a compact response for two tracked keys.');
  assert.equal(full.portfolio.holdings.length, rows.length);
});

test('history loader rejects cross-manager, cross-period, missing and unexpected upstream responses', async () => {
  const valid = report();
  for (const data of [null, {}, { ...valid, status: 'stale' }, { ...valid, manager: { ...valid.manager, cik: '0000000123' } },
    { ...valid, selectedPeriod: '2026-03-31' }, { ...valid, portfolio: null },
    { ...valid, portfolio: { ...valid.portfolio, cik: '0000000123' } },
    { ...valid, portfolio: { ...valid.portfolio, period: '2026-03-31' } },
  ]) {
    const loader = create13FHistoryLoader({ loadReport: async () => data });
    await assert.rejects(loader(CIK, { period: PERIOD, keys: [KEY] }), { status: 502 });
  }
});

test('history loader does not call SEC ingestion for invalid input and preserves upstream error semantics', async () => {
  let calls = 0;
  const failure = Object.assign(new Error('Quarter absent'), { status: 404, code: 'PERIOD_NOT_FOUND' });
  const loader = create13FHistoryLoader({ loadReport: async () => { calls += 1; throw failure; } });
  await assert.rejects(loader(CIK, { period: PERIOD, keys: [KEY, KEY] }), { status: 400 });
  assert.equal(calls, 0);
  await assert.rejects(loader(CIK, { period: PERIOD, keys: [KEY] }), failure);
  assert.equal(calls, 1);
});

test('history projections preserve incomplete and confidential scope rather than upgrading evidence', async () => {
  const complete = report();
  for (const fields of [
    { complete: false, comparable: false, totalValueUsd: null, issues: ['Missing amendment'] },
    { complete: true, comparable: false, confidentialOmitted: true },
    { complete: true, comparable: false, reportType: '13F COMBINATION REPORT' },
  ]) {
    const source = { ...complete, portfolio: { ...complete.portfolio, ...fields } };
    const result = await create13FHistoryLoader({ loadReport: async () => source })(CIK, { period: PERIOD, keys: [KEY] });
    assert.equal(result.projection.complete, fields.complete);
    assert.equal(result.projection.comparable, false);
    assert.equal(result.projection.positions[KEY].quantity, 10);
    if (!fields.complete) {
      assert.equal(result.projection.totalValueUsd, null);
      assert.equal(result.projection.top10Pct, null);
      assert.equal(result.projection.positions[KEY].weightPct, null);
    }
  }
});

test('a verified unavailable result remains unavailable without an invented holdings projection', async () => {
  const source = report({ status: 'unavailable', portfolio: null, reason: 'No public holdings table is available.' });
  const result = await create13FHistoryLoader({ loadReport: async () => source })(CIK, { period: PERIOD, keys: [KEY] });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.projection, null);
  assert.equal(result.reason, source.reason);
  assert.deepEqual(result.coverage, source.coverage);
});

test('history API rejects duplicate, unknown and malformed query parameters with private errors', async () => {
  const valid = new URLSearchParams({ cik: CIK, period: PERIOD, keys: keysJson }).toString();
  const original = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('Invalid input must not reach a network request'); };
  try {
    for (const query of ['', `cik=${CIK}&period=${PERIOD}`, `${valid}&cik=1`, `${valid}&period=2026-03-31`, `${valid}&keys=[]`, `${valid}&url=https://www.sec.gov/`, `cik=${CIK}&period=2026-06-29&keys=[]`, `cik=${CIK}&period=${PERIOD}&keys=null`, `cik=0&period=${PERIOD}&keys=[]`]) {
      const response = await GET(new Request(`https://example.com/api/fund-13f/history?${query}`));
      assert.equal(response.status, 400, query);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.ok((await response.json()).error);
    }
    assert.equal(fetched, false);
  } finally { globalThis.fetch = original; }
});

test('history API distinguishes a quarter absent from SEC history from a temporary retrieval failure', async () => {
  const original = globalThis.fetch;
  const cik = '0000098751';
  globalThis.fetch = async (url) => {
    if (String(url) === `https://data.sec.gov/submissions/CIK${cik}.json`) return Response.json({ cik: Number(cik), name: 'No 13F history fixture', filings: { recent: { accessionNumber: [], form: [], filingDate: [] }, files: [] } });
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const query = new URLSearchParams({ cik, period: PERIOD, keys: '[]' });
    const response = await GET(new Request(`https://example.com/api/fund-13f/history?${query}`));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const data = await response.json();
    assert.equal(data.code, 'PERIOD_NOT_FOUND');
    assert.match(data.error, /No public 13F report was found/);
    assert.doesNotMatch(data.error, /Retry/);
  } finally { globalThis.fetch = original; }
});

function importHistoryHook() {
  const file = new URL('../src/app/fund/use13FHistory.ts', import.meta.url);
  const localRequire = createRequire(file);
  const ts = localRequire('typescript');
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const testModule = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(localRequire, testModule, testModule.exports);
  return testModule.exports.use13FHistory;
}

test('history hook renders an empty identity safely and seeds only the selected quarter during initial render', () => {
  const use13FHistory = importHistoryHook();
  let state;
  function Probe({ data, count = 8 }) { state = use13FHistory(data, { count }); return createElement('p', null, state.history.cik || 'No manager selected'); }
  assert.match(renderToStaticMarkup(createElement(Probe, { data: undefined })), /No manager selected/);
  assert.equal(state.total, 0);
  assert.equal(state.history.quarters.length, 0);
  renderToStaticMarkup(createElement(Probe, { data: report(), count: 4 }));
  assert.equal(state.total, 4);
  assert.equal(state.completed, 1);
  assert.equal(state.loading, true);
  assert.deepEqual(state.history.quarters.map((quarter) => quarter.status), ['loading', 'loading', 'loading', 'ready']);
  assert.equal(state.history.quarters.at(-1).positions[KEY].valueUsd, 100);
});
