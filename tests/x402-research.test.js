import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAnalysisCompany, packAnalysisCompany } from '../src/utils/analysisResearch.js';
import { createPaidResearchReaders, paidResearchSelection, x402DataOptions, x402DataHead } from '../src/utils/x402Research.js';

const at = Date.parse('2026-10-04T15:00:00Z');
const request = (path, query = '') => new Request(`https://secedgarterminal.com/api/x402/v1/${path}${query}`);
test('paid selectors reject acquisition paths, duplicate, arbitrary and excessive selectors', () => {
  assert.deepEqual(paidResearchSelection(request('financials/AAPL', '?basis=ttm'), 'financials', 'AAPL'), { ticker: 'AAPL', basis: 'ttm' });
  assert.deepEqual(paidResearchSelection(request('factor-universe'), 'factor-universe'), { basis: 'ttm', limit: 100, offset: 0, snapshot: '' });
  for (const query of ['?limit=101', '?offset=-1', '?offset=10000', '?limit=1&limit=2', '?asOf=2025-01-01', '?snapshot=bad', '?limit=', '?basis=ttm&basis=annual']) {
    assert.equal(paidResearchSelection(request('factor-universe', query), 'factor-universe'), null, query);
  }
  for (const ticker of ['3001', '../AAPL', 'AAPL/MSFT', '', 'A'.repeat(16)]) assert.equal(paidResearchSelection(request('financials/AAPL'), 'financials', ticker), null);
  assert.equal(paidResearchSelection(request('refinancing', '?basis=annual'), 'refinancing'), null);
});

test('paid full financial history preserves calculator evidence and never exposes storage metadata', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/analysis-gs-sec-facts.json', import.meta.url), 'utf8'));
  const payload = packAnalysisCompany(buildAnalysisCompany({ ...fixture, cik: String(fixture.cik).padStart(10, '0') }, { basis: 'quarter' }));
  payload.owner = 'do-not-return';
  const calls = [];
  const readers = createPaidResearchReaders({ now: () => at, financialRead: async selected => {
    calls.push(selected);
    return { payload, owner: 'private', metadata: { fetchedAt: new Date(at - 60000).toISOString(), expiresAt: new Date(at + 60000).toISOString(), objectPath: 'private' } };
  } });
  const response = await readers.financials({ ticker: 'GS', basis: 'quarter' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.model.periods.length, payload.periods.length);
  assert.deepEqual(result.model.metrics, JSON.parse(JSON.stringify(payload.metrics)));
  assert.deepEqual(result.model.sourceCatalog, payload.sourceCatalog);
  assert.equal(result.model.owner, undefined);
  assert.equal(result.owner, undefined);
  assert.equal(result.objectPath, undefined);
  assert.match(result.limitations.join(' '), /not an as-filed/);
  assert.deepEqual(calls, [{ ticker: 'GS', basis: 'quarter', asOf: '' }]);
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) assert.match(response.headers.get(header), /no-store/);
});

test('missing, corrupt or too-old prepared financial models return uncharged failure', async () => {
  for (const financialRead of [async () => null, async () => { throw new Error('private exception'); }, async () => ({ payload: {}, metadata: {} })]) {
    const response = await createPaidResearchReaders({ financialRead, now: () => at }).financials({ ticker: 'GS', basis: 'quarter' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'DATA_NOT_PREPARED');
  }
});

test('pagination caps large prepared datasets and refuses mixed snapshot or out-of-range pages', async () => {
  let value = { schema_version: 'fixture', generated_at: '2026-10-04T14:00:00Z', rows: Array.from({ length: 205 }, (_, i) => ({ ticker: `T${i}`, value: i })) };
  const readers = createPaidResearchReaders({ universeRead: async () => value });
  const first = await (await readers.page('factor-universe', { basis: 'ttm', limit: 100, offset: 0, snapshot: '' })).json();
  assert.equal(first.rows.length, 100);
  assert.equal(first.pagination.total, 205);
  assert.equal(first.pagination.nextOffset, 100);
  const end = await (await readers.page('factor-universe', { basis: 'ttm', limit: 100, offset: 200, snapshot: first.pagination.snapshot })).json();
  assert.equal(end.rows.length, 5);
  assert.equal(end.pagination.nextOffset, null);
  value = { ...value, rows: value.rows.map((row, i) => i === 0 ? { ...row, value: 999 } : row) };
  assert.equal((await readers.page('factor-universe', { basis: 'ttm', limit: 100, offset: 100, snapshot: first.pagination.snapshot })).status, 409, 'equal timestamps with changed values are fenced');
  assert.equal((await readers.page('factor-universe', { basis: 'ttm', limit: 100, offset: 205, snapshot: '' })).status, 416);
});

test('HEAD and CORS discovery never invoke a paid GET', () => {
  assert.equal(x402DataHead().status, 405);
  assert.equal(x402DataOptions().status, 204);
  assert.match(x402DataOptions().headers.get('access-control-allow-headers'), /PAYMENT-SIGNATURE/);
});

test('paid pagination refuses computed fallback clocks without a retained snapshot', async () => {
  const readers = createPaidResearchReaders({ universeRead: async () => ({ cache_status: 'computed-from-prepared-sec', rows: [{ ticker: 'GS' }] }) });
  const response = await readers.page('factor-universe', { basis: 'ttm', limit: 100, offset: 0, snapshot: '' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'DATA_NOT_PREPARED');
});
