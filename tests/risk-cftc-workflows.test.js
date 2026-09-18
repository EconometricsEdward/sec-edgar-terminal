import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRiskBasis, normalizeRiskView, parseRiskLocation, riskViewPath } from '../src/app/risk/riskNavigation.js';
import { fcmChange, fcmComparisonCsv, fcmMoney, fcmRatio, fcmSignals, filterFcmFirms } from '../src/app/risk/fcmPresentation.js';

const firm = (overrides = {}) => ({
  id: 'firm-a', legalName: 'BROKER A LLC', reportDate: '2026-07-31', adjustedNetCapital: 300, netCapitalRequirement: 100,
  excessNetCapital: 200, capitalCoverage: 3, customerSegregationRequired: 1000, customerAssetsInSegregation: 1100,
  customerSegregationExcess: 100, previous: { reportDate: '2026-06-30', adjustedNetCapital: 250, netCapitalRequirement: 100, excessNetCapital: 150, capitalCoverage: 2.5 },
  changes: { adjustedNetCapital: 50, netCapitalRequirement: 0, excessNetCapital: 50, excessNetCapitalPct: 100 / 3, capitalCoverage: 0.5 },
  comparisonStatus: 'matched-legal-name', sourceUrl: 'https://www.cftc.gov/current-report.xlsx', ...overrides,
});

test('CFTC links retain broker capital and send retired market context to business exposures', () => {
  assert.deepEqual(parseRiskLocation('?view=fcm&entity=firm-a'), { ticker: '', view: 'fcm', basis: 'ttm', entity: 'firm-a', asOf: '' });
  assert.deepEqual(parseRiskLocation('?symbol=jpm&view=cftc'), { ticker: 'JPM', view: 'exposures', basis: 'ttm', entity: '', asOf: '' });
  assert.equal(riskViewPath('?ticker=JPM&view=fcm&entity=firm-a', 'cftc'), '/risk?ticker=JPM&view=exposures&entity=firm-a&exposurePanel=markets');
  assert.equal(riskViewPath('?ticker=JPM&view=cftc', 'overview'), '/risk?ticker=JPM');
  assert.equal(normalizeRiskView('unrecognized'), 'overview');
});

test('disabled CFTC views fall back to company overview without losing the ticker', () => {
  assert.equal(normalizeRiskView('cftc', false), 'overview');
  assert.equal(normalizeRiskView('fcm', false), 'overview');
  assert.equal(normalizeRiskView('exposures', false), 'overview');
  assert.equal(normalizeRiskView('stress', false), 'overview');
  assert.deepEqual(parseRiskLocation('?ticker=BAC&view=cftc', false), { ticker: 'BAC', view: 'overview', basis: 'ttm', entity: '', asOf: '' });
  assert.equal(riskViewPath('?ticker=BAC&view=fcm', 'fcm', false), '/risk?ticker=BAC');
});

test('bookmarked market context links retain the company and reporting selection in Market links', () => {
  for (const key of ['view', 'tab']) {
    const search = `?symbol=GS&basis=annual&${key}=cftc&asOf=2026-06-30`;
    const restored = parseRiskLocation(search);
    assert.deepEqual(restored, { ticker: 'GS', view: 'exposures', basis: 'annual', entity: '', asOf: '2026-06-30' });
    const target = new URL(riskViewPath(search, restored.view), 'https://secedgarterminal.com');
    assert.equal(target.searchParams.get('view'), 'exposures');
    assert.equal(target.searchParams.get('exposurePanel'), 'markets');
    assert.equal(target.searchParams.has('tab'), false);
    assert.equal(target.searchParams.get('symbol'), 'GS');
    assert.equal(target.searchParams.get('basis'), 'annual');
    assert.equal(target.searchParams.get('asOf'), '2026-06-30');
    assert.equal(parseRiskLocation(target.search).view, 'exposures');
  }
});

test('company exposure deep links preserve filing cutoff across risk views and browser restoration', () => {
  assert.deepEqual(parseRiskLocation('?ticker=xom&view=exposures&asOf=2025-06-30'), { ticker: 'XOM', view: 'exposures', basis: 'ttm', entity: '', asOf: '2025-06-30' });
  assert.equal(riskViewPath('?ticker=XOM&view=exposures&asOf=2025-06-30', 'stress'), '/risk?ticker=XOM&asOf=2025-06-30');
  assert.equal(riskViewPath('?ticker=XOM&view=stress&asOf=2025-06-30', 'exposures'), '/risk?ticker=XOM&view=exposures&asOf=2025-06-30');
  assert.deepEqual(parseRiskLocation('?ticker=XOM&view=exposures&asOf=2025-06-30', false), { ticker: 'XOM', view: 'overview', basis: 'ttm', entity: '', asOf: '2025-06-30' });
});

test('retired risk tabs restore the profile without losing company or annual basis', () => {
  for (const view of ['stress', 'disclosures', 'unknown']) {
    const search = `?ticker=BRK-B&basis=annual&view=${view}&asOf=2025-06-30`;
    const restored = parseRiskLocation(search);
    assert.deepEqual(restored, { ticker: 'BRK-B', view: 'overview', basis: 'annual', entity: '', asOf: '2025-06-30' });
    assert.equal(riskViewPath(search, restored.view), '/risk?ticker=BRK-B&basis=annual&asOf=2025-06-30');
  }
});

test('risk basis is shareable and browser restoration defaults unsupported values to TTM', () => {
  assert.equal(normalizeRiskBasis('annual'), 'annual');
  for (const value of [undefined, '', 'ttm', 'quarter', 'ANNUAL']) assert.equal(normalizeRiskBasis(value), 'ttm');
  const annualPath = riskViewPath('?ticker=JPM&basis=annual', 'cftc');
  assert.equal(annualPath, '/risk?ticker=JPM&basis=annual&exposurePanel=markets&view=exposures');
  assert.equal(parseRiskLocation(new URL(annualPath, 'https://secedgarterminal.com').search).basis, 'annual');
  assert.equal(parseRiskLocation('?ticker=JPM&basis=quarter').basis, 'ttm');
  assert.equal(parseRiskLocation('?symbol=%20brk-b%20').ticker, 'BRK-B');
});

test('capital presentation preserves zero, missing values, raw dollars and coverage multiples', () => {
  assert.equal(fcmMoney(0), '$0');
  assert.equal(fcmMoney(null), 'Unavailable');
  assert.equal(fcmMoney(NaN), 'Unavailable');
  assert.equal(fcmMoney(914023371), '$914,023,371');
  assert.equal(fcmRatio(914023371 / 307391117), '2.97×');
  assert.equal(fcmRatio(undefined), 'Unavailable');
  assert.equal(fcmChange(0), '$0');
  assert.equal(fcmChange(-0.25, true), '-0.25×');
  assert.equal(fcmChange(null), 'No prior comparison');
});

test('capital review observations distinguish regulatory deficits, cushion declines, and screening thresholds', () => {
  assert.deepEqual(fcmSignals(firm()), []);
  const thin = fcmSignals(firm({ capitalCoverage: 1.249, changes: { excessNetCapital: -20, excessNetCapitalPct: -10 } }));
  assert.deepEqual(thin.map(signal => [signal.id, signal.level]), [['cushion-decline', 'moderate'], ['coverage', 'moderate']]);
  assert.equal(fcmSignals(firm({ capitalCoverage: 1.25 })).length, 0);
  const deficit = fcmSignals(firm({ excessNetCapital: -1, capitalCoverage: .99, customerSegregationExcess: -5, changes: null }));
  assert.deepEqual(deficit.map(signal => signal.id), ['capital-deficit', 'segregation-deficit']);
  assert.deepEqual(fcmSignals(firm({ excessNetCapital: null, capitalCoverage: null, customerSegregationExcess: null, changes: null })), []);
});

test('peer screen sorts actual available observations first and never mutates source records', () => {
  const rows = [firm({ id: 'missing', legalName: 'MISSING', capitalCoverage: null, changes: null }), firm({ id: 'high', legalName: 'HIGH', capitalCoverage: 4 }), firm({ id: 'low', legalName: 'LOW', capitalCoverage: 1.1, changes: { excessNetCapital: -50, excessNetCapitalPct: -25 } })];
  assert.deepEqual(filterFcmFirms(rows, '', false, 'coverage').map(row => row.id), ['low', 'high', 'missing']);
  assert.deepEqual(filterFcmFirms(rows, '', false, 'decline').map(row => row.id), ['low', 'high', 'missing']);
  assert.deepEqual(filterFcmFirms(rows, '', true).map(row => row.id), ['low']);
  assert.deepEqual(filterFcmFirms(rows, 'hiGH').map(row => row.id), ['high']);
  assert.deepEqual(rows.map(row => row.id), ['missing', 'high', 'low']);
});

test('protected customer account shortfalls remain independent and appear in the review filter', () => {
  const foreign = firm({ id: 'foreign', customerSegregationExcess: 9000, part30Excess: -50, clearedSwapsExcess: 7000 });
  const swaps = firm({ id: 'swaps', customerSegregationExcess: 9000, part30Excess: 7000, clearedSwapsExcess: -25 });
  assert.deepEqual(fcmSignals(foreign).map(signal => [signal.id, signal.level]), [['part30-deficit', 'high']]);
  assert.deepEqual(fcmSignals(swaps).map(signal => [signal.id, signal.level]), [['cleared-swaps-deficit', 'high']]);
  assert.equal(filterFcmFirms([foreign, swaps], '', true).length, 2);
  assert.deepEqual(fcmSignals(firm({ customerSegregationExcess: -1, part30Excess: -2, clearedSwapsExcess: -3 })).map(signal => signal.id), ['segregation-deficit', 'part30-deficit', 'cleared-swaps-deficit']);
  assert.deepEqual(fcmSignals(firm({ part30Excess: null, clearedSwapsExcess: null, retailForexObligation: 50000 })), []);
  assert.deepEqual(fcmSignals(firm({ part30Excess: 0, clearedSwapsExcess: 0 })), []);
});

test('CSV preserves each customer account category and retail forex obligations for both reports', () => {
  const current = { customerSegregationRequired: 100, customerAssetsInSegregation: 110, customerSegregationExcess: 10, targetResidualInterest: 7, part30Required: 200, part30Assets: 198, part30Excess: -2, clearedSwapsRequired: 300, clearedSwapsAssets: 297, clearedSwapsExcess: -3, retailForexObligation: 400 };
  const previous = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value + 1]));
  const exported = fcmComparisonCsv([firm({ ...current, previous: { reportDate: '2026-06-30', ...previous } })], { retrievedAt: '2026-09-13T00:00:00Z' });
  const [headers, values] = exported.split('\r\n').map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, '')));
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  assert.equal(row['Section 30.7 account funds USD'], '198');
  assert.equal(row['Section 30.7 customer requirement USD'], '200');
  assert.equal(row['Section 30.7 account excess USD'], '-2');
  assert.equal(row['Prior Section 30.7 account excess USD'], '-1');
  assert.equal(row['Cleared swaps account funds USD'], '297');
  assert.equal(row['Cleared swaps customer requirement USD'], '300');
  assert.equal(row['Cleared swaps account excess USD'], '-3');
  assert.equal(row['Prior Cleared swaps account excess USD'], '-2');
  assert.equal(row['Retail forex obligation USD'], '400');
  assert.equal(row['Prior Retail forex obligation USD'], '401');
  assert.equal(row['Target residual interest in segregation USD'], '7');
  assert.equal(headers.length, values.length);
});

test('CSV exports exact selected records with dated provenance and safe text cells, preserving negative numbers', () => {
  const csv = fcmComparisonCsv([firm({ legalName: '=FORMULA,"BROKER"', excessNetCapital: -123456789, customerSegregationRequired: null })], {
    retrievedAt: '2026-09-13T00:00:00Z', source: { reports: [{ reportDate: '2026-06-30', url: 'https://www.cftc.gov/prior-report.xlsx' }] },
  });
  assert.equal(csv.split('\r\n').length, 2);
  assert.match(csv, /"'=FORMULA,""BROKER"""/);
  assert.match(csv, /,-123456789,/);
  assert.match(csv, /"2026-07-31","2026-06-30"/);
  assert.match(csv, /https:\/\/www\.cftc\.gov\/prior-report\.xlsx/);
  assert.match(csv, /2026-09-13T00:00:00Z/);
  assert.doesNotMatch(csv, /undefined|null|NaN/);
});
