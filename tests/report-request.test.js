import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReportRequest, reportMatchesSelection } from '../src/utils/reportRequest.js';

test('report requests distinguish share-class tickers from SEC manager identities', () => {
  assert.deepEqual(normalizeReportRequest(new URLSearchParams('kind=company&id=brk.b&basis=ttm')), { kind: 'company', id: 'BRK.B', basis: 'ttm' });
  assert.deepEqual(normalizeReportRequest(new URLSearchParams('kind=13f&id=1067983')), { kind: '13f', id: '0001067983', basis: 'annual' });
  for (const query of ['kind=13f&id=0', 'kind=company&id=https://evil.example', 'kind=nport&id=VTI&id=VOO', 'kind=13f&id=abc', 'kind=company&id=AAPL&basis=yesterday']) {
    assert.throws(() => normalizeReportRequest(new URLSearchParams(query)), { status: 400 });
  }
});
test('report response binds identity and reporting basis to the request', () => {
  const report = { schema: 'edgar.report.v1', kind: 'company', entity: { id: 'KO', name: 'Coca-Cola', cik: '0000021344' }, generatedAt: '2026-09-19T00:00:00Z', period: { basis: 'annual' }, summary: [], sections: [], sources: [], highlights: [], notes: [], coverage: { status: 'partial' } };
  assert.equal(reportMatchesSelection(report, { kind: 'company', id: 'KO', basis: 'annual' }), true);
  assert.equal(reportMatchesSelection(report, { kind: 'company', id: 'AAPL', basis: 'annual' }), false);
  assert.equal(reportMatchesSelection(report, { kind: 'company', id: 'KO', basis: 'ttm' }), false);
  assert.equal(reportMatchesSelection(report, { kind: 'nport', id: 'KO' }), false);
});

test('market reports require their own identity and a supported fundamentals basis', () => {
  assert.deepEqual(normalizeReportRequest(new URLSearchParams('kind=market&id=market&basis=ttm')), { kind: 'market', id: 'MARKET', basis: 'ttm' });
  for (const query of ['kind=market&id=AAPL', 'kind=market&id=MARKET&basis=quarter', 'kind=market&id=MARKET&id=AAPL']) {
    assert.throws(() => normalizeReportRequest(new URLSearchParams(query)), { status: 400 });
  }
  const report = { schema: 'edgar.report.v1', kind: 'market', entity: { id: 'MARKET', name: 'Market overview', cik: '' }, generatedAt: '2026-09-19T00:00:00Z', period: { basis: 'ttm' }, summary: [], sections: [], sources: [], highlights: [], notes: [], coverage: { status: 'partial' } };
  assert.equal(reportMatchesSelection(report, { kind: 'market', id: 'MARKET', basis: 'ttm' }), true);
  assert.equal(reportMatchesSelection(report, { kind: 'market', id: 'MARKET', basis: 'annual' }), false);
  assert.equal(reportMatchesSelection({ ...report, entity: { ...report.entity, cik: '123' } }, { kind: 'market', id: 'MARKET', basis: 'ttm' }), false);
});
