import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisCompany, packAnalysisCompany } from '../src/utils/analysisResearch.js';
import { buildCompanyReport, createCompanyReportLoader, createReportCikCompanyLoader } from '../src/utils/companyReport.js';

const generatedAt = '2026-09-19T12:00:00.000Z';
const annual = (val, year = 2025, instant = false) => ({
  val, end: `${year}-12-31`, ...(instant ? {} : { start: `${year}-01-01` }),
  fy: year, fp: 'FY', form: '10-K', filed: `${year + 1}-02-01`, accn: `0000000001-${String(year + 1).slice(2)}-000001`,
});
const facts = (tags, sic = 3571) => ({ ticker: 'UNLISTED', cik: '0000000001', companyName: 'Independent issuer', sic,
  filings: [], facts: { 'us-gaap': Object.fromEntries(Object.entries(tags).map(([key, rows]) => [key, { units: { USD: rows } }])) } });
function company(sic = 3571) {
  return buildAnalysisCompany(facts({
    Assets: [annual(1000, 2024, true), annual(1200, 2025, true)],
    StockholdersEquity: [annual(400, 2024, true), annual(500, 2025, true)],
    Liabilities: [annual(700, 2025, true)], AssetsCurrent: [annual(300, 2025, true)],
    LiabilitiesCurrent: [annual(150, 2025, true)], CashAndCashEquivalentsAtCarryingValue: [annual(90, 2025, true)],
    LongTermDebtCurrent: [annual(40, 2025, true)], ShortTermBorrowings: [annual(0, 2025, true)], LongTermDebtNoncurrent: [annual(160, 2025, true)],
    Revenues: [annual(400, 2024), annual(500)], NetIncomeLoss: [annual(20, 2024), annual(25)],
    OperatingIncomeLoss: [annual(80)], InterestExpenseNonoperating: [annual(10)],
    NetCashProvidedByUsedInOperatingActivities: [annual(0, 2024), annual(-10)],
    PaymentsToAcquirePropertyPlantAndEquipment: [annual(8)],
    InterestIncomeExpenseNet: [annual(100)], NoninterestIncome: [annual(50)], NoninterestExpense: [annual(60)],
    Deposits: [annual(600, 2025, true)], LoansAndLeasesReceivableNetReportedAmount: [annual(700, 2025, true)],
    PremiumsEarnedNet: [annual(900)], InvestmentIncomeNet: [annual(40)],
  }, sic), { basis: 'annual' });
}
const row = (report, key) => report.sections.flatMap(section => section.rows).find(item => item.key === key);

test('company report uses existing mapped amounts, fractional percentages and signed cash flow for arbitrary issuers', () => {
  const report = buildCompanyReport(company(), { generatedAt });
  assert.equal(report.entity.ticker, 'UNLISTED');
  assert.equal(report.schema, 'edgar.report.v1');
  assert.equal(report.kind, 'company');
  assert.equal(report.generatedAt, generatedAt);
  assert.equal(row(report, 'revenue').p0, 500);
  assert.equal(row(report, 'netMargin').p0, 0.05);
  assert.equal(row(report, 'netMargin').unit, 'percent');
  assert.equal(row(report, 'currentRatio').p0, 2);
  assert.equal(row(report, 'currentRatio').unit, 'ratio');
  assert.equal(row(report, 'totalDebt').p0, 200);
  assert.equal(row(report, 'operatingInterestCoverage').p0, 8);
  assert.equal(row(report, 'operatingCashFlow').p0, -10);
  assert.equal(row(report, 'operatingCashFlow').p1, 0);
  assert.equal(row(report, 'freeCashFlow').p0, -18);
  assert.equal(report.sections.find(section => section.id === 'balance').rows.some(item => item.key === 'shortTermInvestments'), false);
  assert.equal(row(report, 'shortTermInvestments').value, null);
  assert.match(report.highlights.find(item => item.title.includes('year earlier')).text, /increased 25%/);
  assert.match(report.highlights.find(item => item.title.includes('Earnings')).text, /-\$10/);
});

test('every populated observation retains full raw SEC source provenance and formulas', () => {
  const report = buildCompanyReport(company(), { generatedAt });
  const catalog = new Map(report.sources.map(source => [source.id, source]));
  const appendix = report.sections.find(section => section.id === 'observations');
  assert.equal(appendix.pdfRowLimit, 0);
  for (const observation of appendix.rows.filter(item => item.value !== null)) {
    assert.ok(observation.sourceIds.length > 0, observation.key);
    for (const id of observation.sourceIds) {
      const source = catalog.get(id);
      assert.ok(source, id);
      assert.match(source.url, /^https:\/\/www.sec.gov\/Archives\/edgar\/data\//);
      assert.equal(typeof source.value, 'number');
      assert.match(source.accession, /^\d{10}-\d{2}-\d{6}$/);
      assert.match(source.concept, /^us-gaap:/);
    }
  }
  const margin = appendix.rows.find(item => item.key === 'netMargin' && item.period === '2025-12-31');
  assert.match(margin.formula, /Net income/);
  assert.deepEqual(margin.sourceIds.map(id => catalog.get(id).value), [25, 500]);
  assert.equal(report.period.filingDate, '2026-02-01');
});

test('bank and insurance company reports preserve their industry-specific revenue mappings', () => {
  const bank = buildCompanyReport(company(6021), { generatedAt });
  assert.equal(row(bank, 'bankRevenue').p0, 150);
  assert.equal(row(bank, 'revenue'), undefined);
  assert.equal(row(bank, 'currentRatio'), undefined);
  assert.equal(bank.summary.find(item => /net interest expense/i.test(item.label))?.value ?? bank.summary[0].value, 150);
  assert.ok(bank.notes.some(note => note.includes('Bank revenue is net of interest expense')));
  const insurer = buildCompanyReport(company(6311), { generatedAt });
  assert.equal(row(insurer, 'premiumsEarned').p0, 900);
  assert.equal(row(insurer, 'revenue'), undefined);
  assert.ok(insurer.summary.some(item => item.label.toLowerCase().includes('premium') && item.value === 900));
});

test('packed and unpacked analysis produce the same report without losing source IDs', () => {
  const analysis = company();
  assert.deepEqual(buildCompanyReport(packAnalysisCompany(analysis), { generatedAt }), buildCompanyReport(analysis, { generatedAt }));
});

test('unverifiable source URLs and incompatible dates become missing, never fabricated values', () => {
  const analysis = company();
  analysis.metrics.revenue[0].sources[0].documentUrl = 'https://example.com/not-sec';
  analysis.metrics.currentRatio[0].sources[0].end = '2024-12-31';
  const report = buildCompanyReport(analysis, { generatedAt });
  assert.equal(row(report, 'revenue').p0, null);
  assert.equal(row(report, 'currentRatio').value, null);
  const observation = report.sections.find(section => section.id === 'observations').rows.find(item => item.key === 'revenue');
  assert.equal(observation.classification, 'unavailable');
  assert.equal(observation.sourceIds.length, 0);
  assert.match(observation.reason, /provenance/);
  assert.equal(report.highlights.some(item => item.title.includes('year earlier')), false);
});

function history(basis) {
  const periods = Array.from({ length: 12 }, (_, index) => {
    const year = 2025 - Math.floor(index / 4), quarter = 4 - index % 4;
    if (basis === 'annual') return { kind: basis, start: `${2025 - index}-01-01`, end: `${2025 - index}-12-31`, fp: 'FY' };
    const ends = ['03-31', '06-30', '09-30', '12-31'];
    const end = `${year}-${ends[quarter - 1]}`;
    return { kind: basis, start: basis === 'quarter' ? `${year}-${String(quarter * 3 - 2).padStart(2, '0')}-01` : `${year - (quarter === 4 ? 0 : 1)}-${String(quarter === 4 ? 1 : quarter * 3 + 1).padStart(2, '0')}-01`, end, fp: `Q${quarter}` };
  });
  return { ticker: 'ANY.NEW', name: 'Any issuer', cik: '77', basis, lens: 'corporate', periods,
    definitions: [{ key: 'totalAssets', label: 'Total assets', format: 'currency', category: 'balance' }],
    metrics: { totalAssets: periods.map((period, index) => ({ value: index + 1, period, classification: 'reported', sources: [{
      taxonomy: 'us-gaap', tag: 'Assets', value: index + 1, unit: 'USD', start: null, end: period.end, filed: '2026-02-01', form: '10-K', accession: '0000000077-26-000001', documentUrl: 'https://www.sec.gov/Archives/edgar/data/77/000000007726000001/report.htm',
    }] })) } };
}
test('history stays bounded to five annual and eight quarterly or TTM periods', () => {
  for (const [basis, count] of [['annual', 5], ['quarter', 8], ['ttm', 8]]) {
    const report = buildCompanyReport(history(basis), { generatedAt });
    assert.equal(report.sections[0].columns.length, count + 1);
    assert.equal(report.coverage.recordCount, count);
    assert.equal(report.entity.cik, '0000000077');
  }
});

test('year-over-year insight is withheld when source concepts or bases are incompatible', () => {
  const analysis = company();
  analysis.metrics.revenue[1].sources[0].tag = 'SalesRevenueNet';
  assert.equal(buildCompanyReport(analysis, { generatedAt }).highlights.some(item => item.title.includes('year earlier')), false);
});

test('company report loader uses a matching prepared result and avoids interactive acquisition', async () => {
  let loads = 0;
  const load = createCompanyReportLoader({ readPrepared: async selection => {
    assert.deepEqual(selection, { ticker: 'UNLISTED', basis: 'annual', asOf: '' });
    return { payload: packAnalysisCompany(company()) };
  }, loadInteractive: async () => { loads++; }, now: () => generatedAt });
  const report = await load({ ticker: ' unlisted ' });
  assert.equal(report.entity.ticker, 'UNLISTED');
  assert.equal(loads, 0);
});

test('company report loader falls back for nonprepared issuers and rejects wrong identity, basis and cancellation', async () => {
  const load = createCompanyReportLoader({ readPrepared: async () => null,
    loadInteractive: async selection => { assert.equal(selection.ticker, 'UNLISTED'); return { payload: company() }; }, now: () => generatedAt });
  assert.equal((await load({ ticker: 'UNLISTED' })).kind, 'company');
  const mismatch = createCompanyReportLoader({ readPrepared: async () => ({ payload: { ...company(), ticker: 'OTHER' } }), loadInteractive: async () => assert.fail('must not load') });
  await assert.rejects(mismatch({ ticker: 'UNLISTED' }), /did not match/);
  await assert.rejects(load({ ticker: 'UNLISTED', basis: 'ytd' }), /basis/);
  await assert.rejects(load({ ticker: 'UNLISTED' }, AbortSignal.abort(new Error('stop'))), /stop/);
  const unavailable = createCompanyReportLoader({ readPrepared: async () => { throw Object.assign(new Error('Not prepared'), { name: 'PreparedSecUnavailableError' }); }, loadInteractive: async () => ({ payload: company() }), now: () => generatedAt });
  assert.equal((await unavailable({ ticker: 'UNLISTED' })).kind, 'company');
});

test('a company without any verified numerical observations gets an actionable coverage error', () => {
  const analysis = history('annual');
  analysis.metrics.totalAssets = analysis.metrics.totalAssets.map(point => ({ ...point, value: null }));
  assert.throws(() => buildCompanyReport(analysis, { generatedAt }), error => error.status === 422 && /Try another basis/.test(error.message));
});


test('CIK company loading validates both canonical SEC documents before mapping an untickered issuer', async () => {
  const requested = [], id = '0000000001';
  const input = facts({ Assets: [annual(1200, 2025, true)], Revenues: [annual(500)] });
  const load = createReportCikCompanyLoader({ loadJson: async path => {
    requested.push(path);
    return path.startsWith('/submissions/')
      ? { cik: 1, name: 'Untickered SEC issuer', sic: 3571, tickers: [], filings: { recent: { accessionNumber: [] } } }
      : { cik: 1, facts: input.facts };
  }, enrich: async (company, settings) => { assert.equal(settings.basis, 'annual'); return company; } });
  const loaded = await load(id, { basis: 'annual' });
  assert.equal(loaded.ticker, id);
  assert.equal(loaded.cik, id);
  assert.deepEqual(requested.sort(), ['/api/xbrl/companyfacts/CIK0000000001.json', '/submissions/CIK0000000001.json']);
  const report = buildCompanyReport(buildAnalysisCompany(loaded, { basis: 'annual' }), { generatedAt });
  assert.equal(report.entity.id, id);
  assert.equal(report.entity.ticker, undefined);
  assert.equal(report.entity.name, 'Untickered SEC issuer');
  assert.match(report.subtitle, /CIK 0000000001/);
  assert.equal(row(report, 'revenue').p0, 500);
});

test('CIK loading rejects crossed source identities and aborts before acquisition', async () => {
  let enriched = false;
  const load = createReportCikCompanyLoader({ loadJson: async path => path.startsWith('/submissions/')
    ? { cik: 2, name: 'Wrong issuer', filings: { recent: { accessionNumber: [] } } }
    : { cik: 1, facts: {} }, enrich: async company => { enriched = true; return company; } });
  await assert.rejects(load('0000000001'), error => error.status === 502 && /selected company CIK/.test(error.message));
  assert.equal(enriched, false);
  await assert.rejects(load('0000000000'), error => error.status === 400);
  await assert.rejects(load('0000000001', { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
});

test('company report selection sends numeric CIKs to exact-identity loader and keeps requested ID', async () => {
  let calls = 0;
  const load = createCompanyReportLoader({ readPrepared: async () => assert.fail('ticker-only prepared lookup is skipped'),
    loadInteractive: async () => assert.fail('ticker lookup cannot guess an untickered issuer'),
    loadCik: async selection => { calls++; assert.equal(selection.ticker, '0000000001'); return { payload: { ...company(), ticker: selection.ticker } }; },
    now: () => generatedAt });
  const report = await load({ ticker: '0000000001' });
  assert.equal(report.entity.id, '0000000001');
  assert.equal(report.entity.cik, '0000000001');
  assert.equal(calls, 1);
  const mismatch = createCompanyReportLoader({ loadCik: async () => ({ payload: { ...company(), ticker: '0000000002' } }) });
  await assert.rejects(mismatch({ ticker: '0000000002' }), /did not match/);
  await assert.rejects(load({ ticker: '0000000000' }), error => error.status === 400);
});
