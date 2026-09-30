import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskFinancialTimeline, compareRiskTimelinePassages, extractRiskTimelinePassages, selectRiskTimelineFilings } from '../src/utils/riskTimeline.js';
import { loadRiskTimeline } from '../src/utils/riskTimelineEvidenceServer.js';

const cik = '0000000001';
const filing = year => ({ accession: `0000000001-${String(year + 1).slice(-2)}-000001`, form: '10-K',
  reportDate: `${year}-12-31`, filingDate: `${year + 1}-02-01`, primaryDoc: 'report.htm',
  documentUrl: `https://www.sec.gov/Archives/edgar/data/1/0000000001${String(year + 1).slice(-2)}000001/report.htm` });
const filings = [filing(2024), filing(2025)];
function fact(year, val, duration = false) {
  return { val, end: `${year}-12-31`, ...(duration ? { start: `${year}-01-01` } : {}),
    fy: year, fp: 'FY', form: '10-K', filed: `${year + 1}-02-01`, accn: filing(year).accession };
}
const fixture = (extra = {}) => ({ 'us-gaap': Object.fromEntries(Object.entries({
  Assets: [fact(2024, 1000), fact(2025, 1100)],
  NetIncomeLoss: [fact(2024, 100, true), fact(2025, 60, true)],
  NetCashProvidedByUsedInOperatingActivities: [fact(2024, 100, true), fact(2025, 40, true)],
  DebtCurrent: [fact(2024, 20), fact(2025, 40)],
  Deposits: [fact(2024, 500), fact(2025, 300)], ...extra,
}).map(([tag, rows]) => [tag, { units: { USD: rows } }])) });
const document = paragraph => `Item 1A. Risk Factors\n\n${paragraph}\n\nItem 7. Management Discussion and Analysis\n\nOur operating results reflect the business conditions and the cash flow effects of working capital, which are described in detail in this section.\n\nItem 8. Financial Statements`;
function textComparison(before, after) {
  return compareRiskTimelinePassages(extractRiskTimelinePassages(document(before), filings[0]),
    extractRiskTimelinePassages(document(after), filings[1]), filings[0], filings[1]);
}

test('selection keeps four chronological original reports from one form family', () => {
  const result = selectRiskTimelineFilings([...Array.from({ length: 6 }, (_, i) => filing(2020 + i)),
    { ...filing(2025), form: '10-K/A', accession: '0000000001-26-000002' },
    { ...filing(2024), form: '20-F' }]);
  assert.deepEqual(result.map(row => row.reportDate), ['2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31']);
  assert.ok(result.every(row => row.form === '10-K'));
});

test('before/after amounts exclude later restatements and retain actual input accessions', () => {
  const revised = { ...fact(2024, 900, true), filed: '2026-03-01', accn: '0000000001-26-000003' };
  const result = buildRiskFinancialTimeline(fixture({ NetCashProvidedByUsedInOperatingActivities: [fact(2024, 100, true), fact(2025, 40, true), revised] }), 3571, cik, filings);
  const cash = result.events.find(event => event.topic === 'cash');
  assert.equal(cash.before.value, 100); assert.equal(cash.after.value, 40);
  assert.equal(cash.before.sources[0].accession, filings[0].accession);
  assert.ok(cash.before.sources.every(source => source.filed <= cash.before.filing.filingDate));
  assert.equal(cash.level, 'weakening'); assert.doesNotMatch(cash.note, /Quarterly/);
});

test('bank holding companies use earnings/deposits while lenders and insurers do not inherit deposit measures', () => {
  for (const sic of [6021, 6712]) {
    const result = buildRiskFinancialTimeline(fixture(), sic, cik, filings);
    assert.ok(result.events.some(event => event.label === 'Deposits'));
    assert.ok(result.events.some(event => event.label === 'Net income'));
    assert.ok(result.events.every(event => event.label !== 'Operating cash flow'));
  }
  for (const sic of [6141, 6211, 6311]) {
    const result = buildRiskFinancialTimeline(fixture(), sic, cik, filings);
    assert.ok(result.events.every(event => event.label !== 'Deposits'));
    assert.equal(result.events.find(event => event.label === 'Net income')?.level, 'context');
  }
});

test('missing periods and changed debt concept scope cannot become a financial change', () => {
  const missing = buildRiskFinancialTimeline(fixture({ NetCashProvidedByUsedInOperatingActivities: [fact(2025, 40, true)] }), 3571, cik, filings);
  assert.ok(!missing.events.some(event => event.topic === 'cash'));
  assert.equal(missing.coverage.find(row => row.topic === 'cash').status, 'unavailable');
  const gap = buildRiskFinancialTimeline(fixture(), 3571, cik, [filing(2020), filing(2025)]);
  assert.equal(gap.events.length, 0);
});

test('annual maturity comparisons retain separate obligation windows', () => {
  const result = buildRiskFinancialTimeline(fixture({ LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: [fact(2024, 10), fact(2025, 30)] }), 3571, cik, filings);
  const event = result.events.find(row => row.label === 'Next-year principal maturities');
  assert.ok(event); assert.equal(event.before.window.start, '2025-01-01');
  assert.equal(event.after.window.start, '2026-01-01'); assert.match(event.note, /different obligation windows/);
});

test('contract years and numerical covenant changes remain meaningful text changes', () => {
  const paragraph = 'Our credit facility includes financial covenants that require compliance with the defined leverage ratio and reporting obligations. The credit facility expires in 2027 and supports general corporate purposes.';
  const result = textComparison(paragraph, paragraph.replace('2027', '2030'));
  assert.ok(result.events.some(event => event.topic === 'covenants'));
  assert.match(result.events.find(event => event.topic === 'covenants').before.text, /2027/);
});

test('rolling reporting-date-only boilerplate is suppressed', () => {
  const paragraph = 'Our credit facility includes financial covenants that require compliance with the defined leverage ratio and reporting obligations. As of January 1, 2024 we were in compliance with all financial covenants.';
  assert.equal(textComparison(paragraph, paragraph.replace('2024', '2025')).events.length, 0);
});

test('a newly worded collateral requirement can match prior funding prose and keeps negation intact', () => {
  const before = 'Our credit facility provides financing for general corporate purposes under contractual terms with the lender. The facility does not require additional collateral, and the financing commitments remain available subject to the stated conditions.';
  const after = before.replace('does not require additional collateral', 'requires additional collateral');
  const result = textComparison(before, after);
  const event = result.events.find(event => event.topic === 'collateral');
  assert.ok(event); assert.equal(event.level, 'review');
  assert.match(event.before.text, /does not require/); assert.match(event.after.text, /requires/);
});

test('unmatched passages and absent topics remain coverage gaps instead of risk events', () => {
  const before = 'Our business operates in several competitive markets with diverse products and services. Management continually assesses economic conditions and operational performance across the organization.';
  const after = 'A single significant customer accounted for a large share of annual revenue, and the customer relationship has no minimum purchase requirement. Concentration exposes the business to decisions made by that customer.';
  const result = textComparison(before, after);
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.find(row => row.topic === 'covenants').status, 'missing');
  assert.equal(result.coverage.find(row => row.topic === 'customers').status, 'uncompared');
});

test('unrecognized sections cannot claim a paired covenant revision', () => {
  const before = 'Our credit facility has financial covenants that require the company to maintain specific financial ratios throughout the duration of the agreement and to provide audited financial information to the lender.';
  const a = extractRiskTimelinePassages(before, filings[0]), b = extractRiskTimelinePassages(before.replace('specific financial ratios', 'a minimum coverage ratio'), filings[1]);
  assert.equal(compareRiskTimelinePassages(a, b, filings[0], filings[1]).events.length, 0);
});

const dependencies = { loadCompany: async () => ({ ticker: 'TEST', cik, sic: '3571', name: 'Test issuer', kind: 'operating', filings, archives: [] }),
  loadFacts: async () => ({ cik: 1, facts: fixture() }),
  loadDocument: async () => ({ text: document('Our credit facility includes covenants and collateral requirements under the financing arrangements that support the company’s general corporate purposes and ongoing funding activities.') }) };

test('financial reads do not trigger filing-document fetches', async () => {
  let fetched = 0;
  const result = await loadRiskTimeline('TEST', { mode: 'annual' }, { ...dependencies, loadDocument: async () => { fetched++; throw new Error('not expected'); } });
  assert.equal(result.status, 'ready'); assert.equal(fetched, 0); assert.ok(result.events.length);
});

test('failed prior text and financial source create unavailable successor coverage without bridging', async () => {
  const result = await loadRiskTimeline('TEST', { mode: 'annual', includeText: true }, { ...dependencies,
    loadFacts: async () => { throw new Error('temporary failure'); },
    loadDocument: async (_cik, f) => { if (f.accession === filings[0].accession) throw new Error('temporary failure'); return dependencies.loadDocument(); } });
  assert.equal(result.status, 'partial'); assert.equal(result.events.length, 0);
  assert.equal(result.coverage.financial.find(row => row.current === filings[1].accession).status, 'unavailable');
  assert.equal(result.coverage.text.find(row => row.current === filings[1].accession && row.topic === 'covenants').status, 'unavailable');
});

test('manifest and company-facts issuer identities are verified', async () => {
  await assert.rejects(loadRiskTimeline('TEST', {}, { ...dependencies, loadCompany: async () => ({ ...await dependencies.loadCompany(), ticker: 'OTHER' }) }), /did not verify/);
  const mismatch = await loadRiskTimeline('TEST', {}, { ...dependencies, loadFacts: async () => ({ cik: 2, facts: fixture() }) });
  assert.equal(mismatch.status, 'partial'); assert.equal(mismatch.events.length, 0);
});
