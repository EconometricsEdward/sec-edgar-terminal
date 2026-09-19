import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNportReport, buildThirteenFReport } from '../src/utils/fundReport.js';
import { portfolioSummary } from '../src/utils/fundResearch.js';

const options = { generatedAt: '2026-09-19T00:00:00.000Z' };
const section = (report, id) => report.sections.find(item => item.id === id);
const metric = (report, label) => report.summary.find(item => item.label === label)?.value;
function nport(rows = null, fields = {}) {
  const value = {
    status: 'ready', ticker: 'ZZZFX', cik: '0000000100', seriesId: 'S000000123', classId: 'C000000123',
    name: 'Noncatalog Global Portfolio', registrant: 'Sample Registered Trust', identity: 'SEC series matched',
    asOf: '2026-06-30', filingDate: '2026-08-25', accession: '0000000100-26-000001', form: 'NPORT-P',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/100/000000010026000001/primary_doc.xml',
    filingUrl: 'https://www.sec.gov/Archives/edgar/data/100/000000010026000001/0000000100-26-000001-index.html',
    retrievedAt: '2026-09-18T12:00:00.000Z',
    fundInfo: { totAssets: 1200, totLiabs: 200, netAssets: 1000, netAssetsSource: 'reported', cash: 0 },
    holdings: rows || [
      { id: 1, name: 'Sample Bond', title: 'Senior notes', tickerSymbol: null, cusip: '001234567', isin: 'US0012345678', balance: 10, units: 'PA', value: 100, pctOfNav: 10, weightSource: 'reported', assetCat: 'DBT', invCountry: 'US', payoffProfile: 'Long' },
      { id: 2, name: 'Option', title: 'Put option', tickerSymbol: 'ZZZ', cusip: null, isin: null, balance: 2, units: 'CT', value: -20, pctOfNav: -2, weightSource: 'reported', assetCat: 'DE', invCountry: 'US', payoffProfile: 'Short' },
      { id: 3, name: 'Unvalued Security', title: null, tickerSymbol: null, cusip: null, isin: null, balance: null, units: null, value: null, pctOfNav: null, weightSource: 'unavailable', assetCat: 'OTH', invCountry: 'Unknown', payoffProfile: null },
      { id: 4, name: 'Zero value position', title: null, tickerSymbol: null, cusip: null, isin: null, balance: 0, units: 'NS', value: 0, pctOfNav: 0, weightSource: 'reported', assetCat: 'EC', invCountry: 'GB', payoffProfile: 'Long' },
    ], ...fields,
  };
  value.summary = portfolioSummary(value);
  return value;
}
function thirteenF(fields = {}) {
  const portfolio = {
    cik: '0001747057', managerName: 'Noncatalog Institutional Manager', period: '2026-06-30',
    complete: true, comparable: true, confidentialOmitted: false, reportType: '13F HOLDINGS REPORT', totalValueUsd: 300,
    positionCount: 3, entryCount: 4, amendmentCount: 1, issues: [], otherManagers: [],
    holdings: [
      { issuer: 'Same Issuer', classTitle: 'COM', cusip: '001234567', putCall: null, quantityType: 'SH', valueUsd: 150, quantity: 15, weightPct: 50, sourceRowCount: 2, investmentDiscretion: 'SOLE, DFND', otherManager: null, votingAuthority: { sole: 10, shared: 5, none: 0 } },
      { issuer: 'Same Issuer', classTitle: 'COM', cusip: '001234567', putCall: 'CALL', quantityType: 'SH', valueUsd: 100, quantity: 10, weightPct: 100 / 3, sourceRowCount: 1, investmentDiscretion: 'SOLE', otherManager: null, votingAuthority: { sole: 0, shared: 0, none: 10 } },
      { issuer: 'Bond Issuer', classTitle: 'NOTE', cusip: '009876543', putCall: null, quantityType: 'PRN', valueUsd: 50, quantity: 50, weightPct: 50 / 3, sourceRowCount: 1, investmentDiscretion: 'SOLE', otherManager: null, votingAuthority: { sole: 0, shared: 0, none: 0 } },
    ],
    filings: [
      { accession: '0001747057-26-000001', form: '13F-HR', filingDate: '2026-08-12', indexUrl: 'https://www.sec.gov/Archives/original-index.html', primaryUrl: 'https://www.sec.gov/Archives/original.xml', tableUrls: ['https://www.sec.gov/Archives/table-original.xml'], isAmendment: false, amendmentType: null, amendmentNumber: null, superseded: true },
      { accession: '0001747057-26-000002', form: '13F-HR/A', filingDate: '2026-08-15', indexUrl: 'https://www.sec.gov/Archives/restatement-index.html', primaryUrl: 'https://www.sec.gov/Archives/restatement.xml', tableUrls: ['https://www.sec.gov/Archives/table-restatement.xml'], isAmendment: true, amendmentType: 'RESTATEMENT', amendmentNumber: 1, superseded: false },
    ],
    ...fields,
  };
  return { status: 'ready', manager: { cik: '0001747057', name: 'Noncatalog Institutional Manager' }, portfolio,
    selectedPeriod: '2026-06-30', coverage: { selectedPeriodComplete: true, historyComplete: true, note: 'All relevant filings checked.' }, observedAt: '2026-09-18T12:00:00.000Z' };
}

test('N-PORT report preserves arbitrary fund identity, fraction units, nulls, negatives and identifiers', () => {
  const data = nport();
  const before = structuredClone(data);
  const report = buildNportReport(data, options);
  assert.equal(report.kind, 'nport');
  assert.equal(report.entity.id, 'ZZZFX');
  assert.equal(report.entity.seriesId, 'S000000123');
  assert.equal(report.period.asOf, '2026-06-30');
  assert.equal(report.period.filingDate, '2026-08-25');
  const rows = section(report, 'all-holdings').rows;
  assert.equal(rows.length, 4);
  assert.equal(rows[0].cusip, '001234567');
  assert.equal(rows[0].weight, 0.1);
  assert.equal(rows.find(row => row.name === 'Option').weight, -0.02);
  assert.equal(rows.find(row => row.name === 'Option').payoffProfile, 'Short');
  assert.equal(rows.find(row => row.name === 'Zero value position').value, 0);
  assert.equal(rows.find(row => row.name === 'Unvalued Security').value, null);
  assert.equal(report.coverage.status, 'partial');
  assert.equal(metric(report, 'Known holdings value'), 80);
  assert.equal(metric(report, 'Top 10 positive weights'), 0.1);
  assert.deepEqual(data, before);
});

test('N-PORT full workbook rows are not limited by the browser page or PDF preview', () => {
  const data = nport(Array.from({ length: 125 }, (_, i) => ({ ...nport().holdings[0], id: i + 1, name: `Security ${i}`, value: i + 1, pctOfNav: (i + 1) / 10 })));
  const report = buildNportReport(data, options);
  assert.equal(section(report, 'all-holdings').rows.length, 125);
  assert.equal(section(report, 'all-holdings').pdfRowLimit, 0);
  assert.equal(section(report, 'top-positions').rows.length, 10);
  assert.equal(report.coverage.recordCount, 125);
  assert.equal(report.coverage.status, 'ready');
  assert.equal(metric(report, 'Reported holdings value'), 7875);
});

test('N-PORT rejects truncated responses and unavailable or unverifiable source identities', () => {
  assert.throws(() => buildNportReport({ status: 'unavailable', reason: 'No public N-PORT filing.' }), /No public/);
  assert.throws(() => buildNportReport(nport(null, { responseScope: 'summary' })), { code: 'INCOMPLETE_REPORT_RESPONSE' });
  assert.throws(() => buildNportReport(nport(null, { pagination: { portfolioTotal: 100 } })), { code: 'INCOMPLETE_REPORT_RESPONSE' });
  const truncated = nport(); truncated.holdings.pop();
  assert.throws(() => buildNportReport(truncated), { code: 'INCOMPLETE_REPORT_RESPONSE' });
  assert.throws(() => buildNportReport(nport(null, { cik: 'bad' })), { code: 'INVALID_REPORT_SOURCE' });
  assert.throws(() => buildNportReport(nport(null, { sourceUrl: 'https://evil.example/primary.xml' })), { code: 'INVALID_REPORT_SOURCE' });
});

test('N-PORT differentiates series, derived NAV, amendment and retained source clocks', () => {
  const report = buildNportReport(nport(null, { ticker: 'ABCDE', seriesId: 'S000000999', name: 'Different series', form: 'NPORT-P/A',
    fundInfo: { totAssets: 500, totLiabs: 50, netAssets: 450, netAssetsSource: 'assets less liabilities', cash: null },
    cache: { stale: true, checkedAt: '2026-09-10T12:00:00.000Z' } }), options);
  assert.equal(report.entity.name, 'Different series');
  assert.match(report.summary[0].detail, /Calculated/);
  assert.equal(report.generatedAt, options.generatedAt);
  assert.ok(report.notes.some(note => note.includes('2026-09-10T12:00:00.000Z')));
  assert.ok(report.notes.some(note => note.includes('amended N-PORT')));
  assert.ok(report.notes.some(note => note.includes('Multiple share classes')));
});

test('13F keeps options, principal units and aggregated source/voting fields distinct', () => {
  const data = thirteenF(); const before = structuredClone(data);
  const report = buildThirteenFReport(data, options);
  assert.equal(report.entity.id, '0001747057');
  assert.equal(report.kind, '13f');
  const rows = section(report, 'all-holdings').rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cusip, '001234567');
  assert.equal(rows[0].sourceRows, 2);
  assert.equal(rows[0].votingShared, 5);
  assert.equal(rows[0].weight, 0.5);
  assert.equal(rows[1].positionType, 'Call option');
  assert.equal(rows[2].quantityType, 'PRN');
  assert.equal(metric(report, 'Reported 13F value'), 300);
  assert.equal(metric(report, 'Top 10 positions'), 1);
  assert.equal(report.coverage.status, 'ready');
  assert.match(report.summary[0].detail, /not AUM or fund NAV/);
  assert.ok(report.notes.some(note => note.includes('not premiums')));
  assert.deepEqual(data, before);
});

test('13F source catalog preserves superseded filings but excludes them from active metric sources', () => {
  const report = buildThirteenFReport(thirteenF(), options);
  assert.equal(report.sources.length, 6);
  const rows = section(report, 'filing-sequence').rows;
  assert.equal(rows[0].treatment, 'Superseded');
  assert.equal(rows[1].treatment, 'Restated baseline');
  assert.equal(report.period.filingDate, '2026-08-15');
  assert.ok(report.summary[0].sourceIds.every(id => id.startsWith('13f-2')));
});

test('13F with incomplete quarter history or reconciliation retains rows and suppresses totals and weights', () => {
  for (const complete of [true, false]) {
    const data = thirteenF({ complete });
    if (complete) data.coverage.selectedPeriodComplete = false;
    const report = buildThirteenFReport(data, options);
    assert.equal(report.coverage.status, 'partial');
    assert.equal(metric(report, 'Reported 13F value'), null);
    assert.equal(metric(report, 'Top 10 positions'), null);
    assert.ok(section(report, 'all-holdings').rows.every(row => row.weight === null));
    assert.equal(section(report, 'all-holdings').rows[0].value, 150);
    assert.ok(report.charts[0].points.every(point => point.value === null));
  }
});

test('13F explicit confidential omissions and combination scope are visible without erasing reconciled public values', () => {
  for (const fields of [{ confidentialOmitted: true }, { reportType: '13F COMBINATION REPORT' }]) {
    const report = buildThirteenFReport(thirteenF(fields), options);
    assert.equal(report.coverage.status, 'partial');
    assert.equal(metric(report, 'Reported 13F value'), 300);
    assert.equal(metric(report, 'Top 10 positions'), 1);
    assert.ok(report.notes.some(note => fields.confidentialOmitted ? note.includes('explicitly omits') : note.includes('combination report')));
  }
});

test('13F rejects paginated, wrong-quarter, wrong-manager or source-free results', () => {
  assert.throws(() => buildThirteenFReport({ status: 'unavailable', reason: 'No Form 13F holdings found.' }), /No Form 13F/);
  assert.throws(() => buildThirteenFReport(thirteenF({ positionCount: 100 })), { code: 'INCOMPLETE_REPORT_RESPONSE' });
  assert.throws(() => buildThirteenFReport(thirteenF({ period: '2026-03-31' })), { code: 'INCOMPLETE_REPORT_RESPONSE' });
  assert.throws(() => buildThirteenFReport(thirteenF({ cik: '0000000001' })), { code: 'INCOMPLETE_REPORT_RESPONSE' });
  assert.throws(() => buildThirteenFReport(thirteenF({ filings: [] })), { code: 'INVALID_REPORT_SOURCE' });
});

test('13F true zero is retained while zero-denominator concentration stays unavailable', () => {
  const data = thirteenF({ totalValueUsd: 0 });
  data.portfolio.holdings = data.portfolio.holdings.map(row => ({ ...row, valueUsd: 0, weightPct: null }));
  const report = buildThirteenFReport(data, options);
  assert.equal(metric(report, 'Reported 13F value'), 0);
  assert.equal(metric(report, 'Top 10 positions'), null);
  assert.ok(section(report, 'all-holdings').rows.every(row => row.value === 0 && row.weight === null));
});
