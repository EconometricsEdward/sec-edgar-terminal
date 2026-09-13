import test from 'node:test';
import assert from 'node:assert/strict';
import { companyExposureMapCsv, companyExposureEvidenceMarkdown } from '../src/app/risk/exposurePresentation.js';

const annual = { id: 'annual-1', role: 'annual', form: '10-K', filed: '2026-02-24', reportDate: '2025-12-31', accession: '0000093410-26-000078', url: 'https://www.sec.gov/Archives/edgar/data/93410/000009341026000078/cvx-20251231.htm', text: 'Our floating-rate debt was $0 million in 2025.', amounts: [{ text: '$0 million', kind: 'balance', context: 'Our floating-rate debt was $0 million in 2025.' }] };
const row = { id: 'borrowing-sofr', category: 'borrowing', marketLabel: 'SOFR', channelExplanation: 'Borrowing tied to a disclosed rate.', benchmark: { family: 'tff', contract: '134741', group: 'leveraged-funds', label: 'Three-Month SOFR', fit: 'named-reference', basisLimit: 'A market benchmark, not a maturity match.' }, evidence: [annual, { ...annual, id: 'quarter-1', role: 'quarterly', form: '10-Q', filed: '2026-08-06', reportDate: '2026-06-30', text: 'Our financing uses SOFR.', amounts: [] }] };
const data = { ticker: 'CVX', companyName: 'Example company', cik: '0000093410', asOf: '2026-08-31', checkedAt: '2026-09-13T01:00:00Z', status: 'ready', rows: [row], limitations: ['Only the selected annual and quarterly filings are reviewed.'] };

test('exposure CSV retains each source, zero, missing amounts and distinct clocks without aggregating', () => {
  const csv = companyExposureMapCsv(data);
  assert.equal(csv.split('\r\n').length, 3);
  assert.match(csv, /Reported balance: \$0 million/);
  assert.match(csv, /No amount safely extracted/);
  assert.match(csv, /"2026-02-24","2025-12-31"/);
  assert.match(csv, /"2026-08-06","2026-06-30"/);
  assert.match(csv, /2026-09-13T01:00:00Z/);
  assert.match(csv, /do not add across passages/);
  assert.equal(companyExposureMapCsv({ rows: [] }).split('\r\n').length, 1);
});

test('exports preserve notional and sensitivity labels and resist spreadsheet formulas in source text', () => {
  const copy = structuredClone(data);
  copy.companyName = '=HYPERLINK("https://example.test")';
  copy.rows[0].evidence = [{ ...annual, text: '+Untrusted, "source" text', amounts: [{ text: '$12 billion', kind: 'notional', context: 'Outstanding derivative contracts' }, { text: '$20 million', kind: 'sensitivity', context: 'Hypothetical change from a 10% shock' }] }];
  const csv = companyExposureMapCsv(copy);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /"'\+Untrusted, ""source"" text"/);
  assert.match(csv, /Derivative notional: \$12 billion/);
  assert.match(csv, /Disclosed sensitivity: \$20 million/);
});

test('portable evidence notes bind amounts to their passages and label current-market link as unsnapshotted', () => {
  const note = companyExposureEvidenceMarkdown(data, row);
  assert.match(note, /SEC filing cutoff: 2026-08-31/);
  assert.match(note, /Filed 2026-02-24 · Fiscal period ended 2025-12-31/);
  assert.match(note, /> Our floating-rate debt was \$0 million in 2025\./);
  assert.match(note, /Reported balance: \$0 million/);
  assert.match(note, /does not contain a CFTC observation snapshot/);
  assert.match(note, /view=exposures&asOf=2026-08-31/);
  assert.doesNotMatch(companyExposureEvidenceMarkdown(data, { ...row, benchmark: null }), /market\?tab/);
});

test('exports attribute named benchmark support to the exact passage and preserve contrary evidence', () => {
  const copy = structuredClone(data);
  copy.rows[0].evidence = [
    { ...annual, benchmark: row.benchmark },
    { ...annual, id: 'generic', role: 'quarterly', benchmark: { ...row.benchmark, fit: 'proxy' } },
    { ...annual, id: 'negative', role: 'quarterly', benchmark: null, disclosureDirection: 'qualifying-or-negative', text: 'We no longer have SOFR borrowings.' },
  ];
  const lines = companyExposureMapCsv(copy).split('\r\n');
  assert.match(lines[1], /"named-reference"/);
  assert.match(lines[2], /"proxy"/);
  assert.doesNotMatch(lines[2], /named-reference/);
  assert.match(lines[3], /"unmapped".*"qualifying-or-negative"/);
  const note = companyExposureEvidenceMarkdown(copy, copy.rows[0]);
  assert.match(note, /Benchmark support in this passage: Three-Month SOFR — suggested proxy/);
  assert.match(note, /This passage qualifies or denies an exposure/);
});
