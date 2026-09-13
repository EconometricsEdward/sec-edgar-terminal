import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesExposureRequest, selectExposureEvidence } from '../src/app/risk/exposureSelection.js';

test('quarterly evidence cannot inherit named benchmark proof available only in the annual filing', () => {
  const named = { family: 'disaggregated', contract: '067651', label: 'WTI crude', fit: 'named-reference', basisLimit: 'Named WTI reference' };
  const proxy = { ...named, fit: 'proxy', basisLimit: 'Crude proxy with unverified grade' };
  const rows = [{ id: 'revenue:oil', benchmark: named, evidence: [
    { id: 'quarter', role: 'quarterly', text: 'Our crude production...', benchmark: proxy },
    { id: 'annual', role: 'annual', text: 'Our WTI-linked sales...', benchmark: named },
  ] }];
  const quarter = selectExposureEvidence(rows, 'quarterly')[0];
  assert.deepEqual(quarter.benchmark, proxy);
  assert.deepEqual(quarter.benchmarkEvidenceIds, ['quarter']);
  assert.deepEqual(quarter.evidence.map(item => item.id), ['quarter']);
  assert.deepEqual(selectExposureEvidence(rows, 'annual')[0].benchmark, named);
  assert.deepEqual(selectExposureEvidence(rows)[0].benchmark, named);
  assert.deepEqual(selectExposureEvidence(rows)[0].benchmarkEvidenceIds, ['annual']);
  assert.equal(rows[0].evidence.length, 2);
});

test('evidence responses must match the selected company and explicit filing cutoff', () => {
  assert.equal(matchesExposureRequest({ ticker: 'JPM', asOf: null }, 'JPM'), true);
  assert.equal(matchesExposureRequest({ ticker: 'JPM', asOf: '2025-06-30' }, 'JPM', '2025-06-30'), true);
  assert.equal(matchesExposureRequest({ ticker: 'BAC', asOf: null }, 'JPM'), false);
  assert.equal(matchesExposureRequest({ ticker: 'JPM', asOf: null }, 'JPM', '2025-06-30'), false);
  assert.equal(matchesExposureRequest({ ticker: 'JPM', asOf: '2025-06-30' }, 'JPM'), false);
});

test('filtering away all benchmark evidence leaves company exposure visible and the market context unestablished', () => {
  const market = { fit: 'proxy', contract: '043602' };
  const rows = [{ id: 'borrowing:rates', benchmark: market, evidence: [
    { id: 'old', role: 'annual', benchmark: market }, { id: 'new', role: 'quarterly', benchmark: null },
  ] }, { id: 'only-annual', evidence: [{ id: 'other', role: 'annual', benchmark: null }] }];
  const shown = selectExposureEvidence(rows, 'quarterly');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].benchmark, null);
  assert.deepEqual(shown[0].benchmarkEvidenceIds, []);
  assert.match(shown[0].benchmarkUnavailableReason, /filing selection/);
  assert.deepEqual(shown[0].evidence.map(item => item.id), ['new']);
});

test('unmapped disclosures preserve the stated benchmark limitation under every source selection', () => {
  const rows = [{ id: 'cost:jet-fuel', benchmark: null, benchmarkUnavailableReason: 'Jet fuel is not a supported direct benchmark.', evidence: [{ id: 'fuel', role: 'annual', benchmark: null }] }];
  assert.equal(selectExposureEvidence(rows, 'annual')[0].benchmarkUnavailableReason, rows[0].benchmarkUnavailableReason);
  assert.deepEqual(selectExposureEvidence(rows, 'quarterly'), []);
});

test('quarterly qualifying evidence stays visible without reestablishing an annual market link', () => {
  const rows = [{ id: 'cost:gas', benchmark: { fit: 'proxy' }, evidence: [
    { id: 'annual-positive', role: 'annual', filed: '2026-02-01', disclosureDirection: 'connection', benchmark: { fit: 'proxy' } },
    { id: 'quarter-qualified', role: 'quarterly', filed: '2026-08-01', disclosureDirection: 'qualifying-or-negative', benchmark: null },
  ] }];
  const shown = selectExposureEvidence(rows, 'quarterly')[0];
  assert.equal(shown.benchmark, null);
  assert.deepEqual(shown.qualifyingEvidenceIds, ['quarter-qualified']);
  assert.equal(selectExposureEvidence(rows)[0].evidence[0].id, 'quarter-qualified');
});
