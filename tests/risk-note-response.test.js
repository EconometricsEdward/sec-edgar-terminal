import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRiskNoteResponse, RISK_NOTE_RESPONSE_VERSION } from '../src/utils/riskNoteResponse.js';
import { RISK_NOTE_FACTS_VERSION } from '../src/utils/riskNoteFacts.js';

const current = { value: 3_000_000, end: '2026-06-30', start: null, contextId: 'current', sourceUrl: 'https://www.sec.gov/Archives/example.htm#current', tag: 'us-gaap:DerivativeNotionalAmount' };
const row = { id: 'notional', kind: 'derivative_notional', category: 'other_derivative', label: 'Derivatives', unit: 'USD', dimensions: [], current, prior: { ...current, contextId: 'prior', end: '2025-12-31' } };
const response = () => ({ schemaVersion: RISK_NOTE_RESPONSE_VERSION, ticker: 'XOM', basis: 'ttm', asOf: null, checkedAt: '2026-09-18T12:00:00.000Z', status: 'ready', rows: [structuredClone(row)],
  filing: { form: '10-Q', reportDate: '2026-06-30', filed: '2026-08-01', accession: '0000000001-26-000001', url: 'https://www.sec.gov/Archives/example.htm' }, coverage: {}, limitations: [] });

test('the client response contract uses the server parser schema version', () => {
  assert.equal(RISK_NOTE_RESPONSE_VERSION, RISK_NOTE_FACTS_VERSION);
});

test('note responses match the exact company, reporting basis and filing cutoff', () => {
  const body = response();
  assert.equal(matchesRiskNoteResponse(body, 'XOM'), true);
  assert.equal(matchesRiskNoteResponse(body, 'AAPL'), false);
  assert.equal(matchesRiskNoteResponse(body, 'XOM', 'annual'), false);
  assert.equal(matchesRiskNoteResponse(body, 'XOM', 'ttm', '2026-09-01'), false);
  body.asOf = '2026-09-01';
  assert.equal(matchesRiskNoteResponse(body, 'XOM', 'ttm', '2026-09-01'), true);
  assert.equal(matchesRiskNoteResponse(body, 'XOM'), false);
  body.asOf = '2026-07-01';
  assert.equal(matchesRiskNoteResponse(body, 'XOM', 'ttm', body.asOf), false, 'a document filed after the cutoff is not eligible');
  body.asOf = null;
  body.basis = 'annual';
  assert.equal(matchesRiskNoteResponse(body, 'XOM', 'annual'), false, 'a quarterly document cannot stand in for annual evidence');
  body.filing.form = '10-K';
  assert.equal(matchesRiskNoteResponse(body, 'XOM', 'annual'), true);
});

test('valid empty results stay distinct from unavailable or mismatched data', () => {
  const empty = { ...response(), status: 'no_matches', rows: [] };
  assert.equal(matchesRiskNoteResponse(empty, 'XOM'), true);
  assert.equal(matchesRiskNoteResponse({ ...empty, status: 'no_filing', filing: null }, 'XOM'), true);
  for (const patch of [{ status: 'ready' }, { status: 'unavailable' }, { status: 'no_filing' }, { schemaVersion: 'risk-note-facts-v2' }, { filing: null }])
    assert.equal(matchesRiskNoteResponse({ ...empty, ...patch }, 'XOM'), false);
  for (const body of [null, [], {}, 'invalid']) assert.equal(matchesRiskNoteResponse(body, 'XOM'), false);
});

test('malformed rows and impossible comparisons cannot reach the chart consumers', () => {
  for (const patch of [{ current: null }, { dimensions: null }, { dimensions: [null] }, { prior: undefined },
    { current: { ...current, value: '3000000' } }, { current: { ...current, value: Infinity } },
    { current: { ...current, end: '2026-02-30' } }, { current: { ...current, end: '2025-12-31' } },
    { prior: { ...current, end: '2026-06-30' } }]) {
    const body = response(); body.rows[0] = { ...body.rows[0], ...patch };
    assert.equal(matchesRiskNoteResponse(body, 'XOM'), false);
  }
});

test('new fair-value measures retain their kind and can pass without becoming notionals', () => {
  const body = response();
  body.rows[0] = { ...body.rows[0], kind: 'derivative_fair_value', current: { ...current, value: 0 }, prior: null };
  assert.equal(matchesRiskNoteResponse(body, 'XOM'), true);
  assert.equal(body.rows[0].kind, 'derivative_fair_value');
  assert.equal(body.rows[0].current.value, 0);
});
