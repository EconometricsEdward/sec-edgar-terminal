import test from 'node:test';
import assert from 'node:assert/strict';
import { riskDebtBalances, riskMarketableSecurities, riskLiabilitiesBalance } from '../src/utils/riskFinancialMappings.js';
import { assessRisk } from '../src/utils/riskAnalysis.js';

const accession = '0000000001-26-000001';
const period = { fy: 2025, fp: 'FY', kind: 'annual', end: '2025-12-31', start: '2025-01-01' };
const documentUrl = 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/company.htm';
function facts(values) {
  return { 'us-gaap': Object.fromEntries(Object.entries(values).map(([tag, val]) => [tag,
    { units: { USD: [{ val, end: period.end, fy: 2025, fp: 'FY', form: '10-K', filed: '2026-02-01', accn: accession }] } }])) };
}
function annotate(f, tag, classification = 'current') {
  Object.assign(f['us-gaap'][tag].units.USD[0], { balanceClassification: classification,
    classificationEvidence: { method: 'balance-sheet-section', documentUrl, factId: 'fact1', subtotalFactId: 'subtotal1' } });
}

test('noncurrent debt-plus-lease taxonomy is kept separate from reported current debt', () => {
  const value = riskDebtBalances(facts({ DebtCurrent: 10, LongTermDebtAndCapitalLeaseObligations: 32 }), period);
  assert.equal(value.current.value, 10);
  assert.equal(value.noncurrent.value, 32);
  assert.equal(value.total.value, 42);
  assert.equal(value.total.sources.length, 2);
  assert.match(value.total.sources[1].scopeNote, /Includes lease obligations/);
});
test('including-current long-term total is never added to current maturities a second time', () => {
  const f = facts({ LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: 40,
    LongTermDebtAndCapitalLeaseObligationsCurrent: 5, ShortTermBorrowings: 2 });
  const value = riskDebtBalances(f, period);
  assert.equal(value.current.value, 7);
  assert.equal(value.noncurrent.value, 35);
  assert.equal(value.total.value, 42);
  assert.ok(value.total.calculations.some((item) => /− current maturities/.test(item.formula)));
});
test('pure long-term total can reconcile an explicit noncurrent balance into current maturities', () => {
  const value = riskDebtBalances(facts({ LongTermDebt: 40, LongTermDebtNoncurrent: 35, ShortTermBorrowings: 2 }), period);
  assert.equal(value.current.value, 7);
  assert.equal(value.noncurrent.value, 35);
  assert.equal(value.total.value, 42);
});
test('direct aggregate current debt wins over its separately reported components', () => {
  const value = riskDebtBalances(facts({ DebtCurrent: 7, LongTermDebtCurrent: 5, ShortTermBorrowings: 2,
    CommercialPaper: 1, LongTermDebtNoncurrent: 35 }), period);
  assert.equal(value.current.value, 7);
  assert.deepEqual(value.current.sources.map((source) => source.tag), ['DebtCurrent']);
  assert.equal(value.total.value, 42);
});
test('commercial paper plus explicitly reported other short-term borrowings both enter current debt', () => {
  const value = riskDebtBalances(facts({ CommercialPaper: 5.360, OtherShortTermBorrowings: 1.258,
    LongTermDebtCurrent: 3.837, LongTermDebtNoncurrent: 40 }), period);
  assert.equal(value.current.value, 10.455);
  assert.deepEqual(value.current.sources.map((source) => source.tag), ['LongTermDebtCurrent', 'CommercialPaper', 'OtherShortTermBorrowings']);
});
test('short-term aggregate is preferred to overlapping paper and other components', () => {
  const value = riskDebtBalances(facts({ ShortTermBorrowings: 6, CommercialPaper: 5, OtherShortTermBorrowings: 1,
    LongTermDebtCurrent: 4, LongTermDebtNoncurrent: 40 }), period);
  assert.equal(value.current.value, 10);
  assert.deepEqual(value.current.sources.map((source) => source.tag), ['LongTermDebtCurrent', 'ShortTermBorrowings']);
});
test('generic notes-and-loans cannot be assigned to current debt without source classification', () => {
  const f = facts({ NotesAndLoansPayable: 2, LongTermDebtAndCapitalLeaseObligationsCurrent: 5,
    LongTermDebtAndCapitalLeaseObligations: 35 });
  assert.equal(riskDebtBalances(f, period).current.value, null);
  annotate(f, 'NotesAndLoansPayable');
  assert.equal(riskDebtBalances(f, period).current.value, null);
  Object.assign(f['us-gaap'].NotesAndLoansPayable.units.USD[0], { debtScope: 'short-term-component' });
  f['us-gaap'].NotesAndLoansPayable.units.USD[0].classificationEvidence.separateCurrentMaturitiesFactId = 'fact-maturities';
  assert.equal(riskDebtBalances(f, period).current.value, 7);
});
test('unclassified notes-and-loans prevent narrower commercial paper from masquerading as all short-term borrowing', () => {
  const f = facts({ NotesAndLoansPayable: 332, CommercialPaper: 250, LongTermDebtAndCapitalLeaseObligationsCurrent: 4493,
    LongTermDebtAndCapitalLeaseObligations: 39065 });
  assert.equal(riskDebtBalances(f, period).current.value, null);
  assert.equal(riskDebtBalances(f, period).total.value, null);
});
test('negative and mismatched-date debt amounts never make usable total debt', () => {
  const f = facts({ DebtCurrent: 10, LongTermDebtNoncurrent: -5 });
  assert.equal(riskDebtBalances(f, period).total.value, null);
  f['us-gaap'].LongTermDebtNoncurrent.units.USD[0].val = 5;
  f['us-gaap'].LongTermDebtNoncurrent.units.USD[0].end = '2024-12-31';
  assert.equal(riskDebtBalances(f, period).total.value, null);
});
test('a total lower than current maturities cannot create a negative noncurrent balance', () => {
  const value = riskDebtBalances(facts({ LongTermDebt: 3, LongTermDebtCurrent: 5, ShortTermBorrowings: 2 }), period);
  assert.equal(value.noncurrent.value, null);
  assert.equal(value.current.value, 7);
  // The contradictory long-term aggregate cannot bypass its failed split.
  assert.equal(value.total.value, null);
});
test('reconciliations never mix revised components from different filing accessions', () => {
  const f = facts({ LongTermDebt: 40, LongTermDebtCurrent: 5, ShortTermBorrowings: 2 });
  f['us-gaap'].LongTermDebtCurrent.units.USD[0].accn = '0000000001-25-000009';
  assert.equal(riskDebtBalances(f, period).noncurrent.value, null);
  assert.equal(riskDebtBalances(f, period).current.value, null);
});
test('unchanged historical comparisons use the latest common filing without losing an omitted component', () => {
  const f = facts({ CommercialPaper: 0, LongTermDebtCurrent: 3, LongTermDebtNoncurrent: 40 });
  for (const tag of ['LongTermDebtCurrent', 'LongTermDebtNoncurrent']) {
    f['us-gaap'][tag].units.USD.push({ ...f['us-gaap'][tag].units.USD[0],
      accn: '0000000001-26-000009', filed: '2026-08-01', fp: 'Q2', form: '10-Q' });
  }
  const value = riskDebtBalances(f, period);
  assert.equal(value.current.value, 3);
  assert.equal(value.noncurrent.value, 40);
  assert.equal(value.total.value, 43);
  assert.ok(value.total.sources.every((source) => source.accession === accession));
  assert.equal(value.noncurrent.source.accession, '0000000001-26-000009');
});
test('common-filing fallback does not restore an obsolete amount after a later revision', () => {
  const f = facts({ CommercialPaper: 0, LongTermDebtCurrent: 3, LongTermDebtNoncurrent: 40 });
  f['us-gaap'].LongTermDebtCurrent.units.USD.push({ ...f['us-gaap'].LongTermDebtCurrent.units.USD[0], val: 4,
    accn: '0000000001-26-000009', filed: '2026-08-01', fp: 'Q2', form: '10-Q' });
  const value = riskDebtBalances(f, period);
  assert.equal(value.current.value, null);
  assert.equal(value.total.value, null);
});
test('explicit current investment totals include their exact scope without adding overlapping securities', () => {
  const f = facts({ ShortTermInvestments: 56, MarketableSecuritiesCurrent: 12, LongTermInvestments: 8 });
  const current = riskMarketableSecurities(f, period, 'current');
  assert.equal(current.value, 56);
  assert.equal(current.sources.length, 1);
  assert.match(current.sources[0].scopeNote, /not a cash balance/);
  assert.equal(riskMarketableSecurities(f, period, 'noncurrent').value, 8);
});
test('generic marketable securities require exact observation and SEC filing evidence', () => {
  const f = facts({ MarketableSecurities: 3 });
  assert.equal(riskMarketableSecurities(f, period, 'current').value, null);
  annotate(f, 'MarketableSecurities');
  assert.equal(riskMarketableSecurities(f, period, 'current').value, 3);
  assert.equal(riskMarketableSecurities(f, period, 'noncurrent').value, null);
  f['us-gaap'].MarketableSecurities.units.USD[0].classificationEvidence.documentUrl = 'https://www.sec.gov/Archives/edgar/data/1/000000000125000009/other.htm';
  assert.equal(riskMarketableSecurities(f, period, 'current').value, null);
});
test('broad investments and receivables, maturity disclosures, and stale generic classifications are excluded', () => {
  const f = facts({ LongTermInvestmentsAndReceivablesNet: 40, AvailableForSaleSecuritiesDebtMaturitiesWithinOneYearFairValue: 2,
    MarketableSecurities: 3 });
  annotate(f, 'MarketableSecurities');
  f['us-gaap'].MarketableSecurities.units.USD[0].end = '2024-12-31';
  assert.equal(riskMarketableSecurities(f, period, 'current').value, null);
  assert.equal(riskMarketableSecurities(f, period, 'noncurrent').value, null);
});
test('liabilities require complete reported components and do not assume absent minority or temporary equity is zero', () => {
  const f = facts({ Assets: 100, StockholdersEquity: 30, StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: 35,
    LiabilitiesCurrent: 20 });
  assert.equal(riskLiabilitiesBalance(f, period).value, null);
  Object.assign(f['us-gaap'], facts({ LiabilitiesNoncurrent: 45 })['us-gaap']);
  assert.equal(riskLiabilitiesBalance(f, period).value, 65);
  Object.assign(f['us-gaap'], facts({ Liabilities: 64 })['us-gaap']);
  assert.equal(riskLiabilitiesBalance(f, period).value, 64);
});
test('mapped balances retain the exact reported amounts and source scopes in Risk profile output', () => {
  const f = facts({ Assets: 100, Liabilities: 65, StockholdersEquity: 35, DebtCurrent: 10,
    LongTermDebtAndCapitalLeaseObligations: 32, ShortTermInvestments: 20 });
  const profile = assessRisk(f, 3571, 1);
  assert.equal(profile.reportedBalances.totalDebt.at(-1).value, 42);
  assert.equal(profile.reportedBalances.currentMarketableSecurities.at(-1).value, 20);
  assert.ok(profile.reportedBalances.totalDebt.at(-1).sources.every((source) => source.documentUrl && source.scopeNote));
});
