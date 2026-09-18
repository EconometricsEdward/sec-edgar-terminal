import test from 'node:test';
import assert from 'node:assert/strict';
import { extractConcentrationFacts, buildCompanyConcentrations } from '../src/utils/companyConcentrations.js';
import { extractCompanyInlineFacts, extractInlineFilingIdentity } from '../src/utils/riskNoteFacts.js';
import { matchesCompanyConcentrations, COMPANY_CONCENTRATIONS_VERSION } from '../src/utils/companyConcentrationResponse.js';
import { parseCompanyConcentrationsRequest } from '../src/utils/companyConcentrationsServer.js';

// Exact Q2 values, tag names and dimensions from BAC's 2026 Q2 Note 17.
const filing = { reportDate: '2026-06-30', form: '10-Q', url: 'https://www.sec.gov/Archives/edgar/data/70858/000007085826000394/bac-20260630.htm' };
const tag = 'RevenuesNetOfInterestExpenseFullTaxEquivalentBasis';
const headers = '<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:srt="http://fasb.org/srt/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:dei="http://xbrl.sec.gov/dei/2026" xmlns:bac="http://www.bankofamerica.com/20260630">';
const context = (id, dimensions = [], start = '2026-04-01') => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">70858</xbrli:identifier>${dimensions.length ? `<xbrli:segment>${dimensions.map(([axis, member]) => `<xbrldi:explicitMember dimension="${axis}">${member}</xbrldi:explicitMember>`).join('')}</xbrli:segment>` : ''}</xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>`;
const fact = (id, contextId, concept, value) => `<ix:nonFraction id="${id}" name="${concept}" contextRef="${contextId}" unitRef="usd" scale="6"${value < 0 ? ' sign="-"' : ''}>${Math.abs(value)}</ix:nonFraction>`;
const segment = member => [['srt:ConsolidationItemsAxis', 'us-gaap:OperatingSegmentsMember'], ['us-gaap:StatementBusinessSegmentsAxis', `bac:${member}`]];
const observations = [
  ['f-6395', 'total', [], 31721],
  ['f-6397', 'consumer', segment('ConsumerBankingSegmentMember'), 11336],
  ['f-6399', 'wealth', segment('GlobalWealthAndInvestmentManagementSegmentMember'), 6871],
  ['f-6461', 'banking', segment('GlobalBankingSegmentMember'), 6236],
  ['f-6463', 'markets', segment('GlobalMarketsSegmentMember'), 8022],
  ['f-6465', 'other', [['srt:ConsolidationItemsAxis', 'bac:CorporateReconcilingItemsAndEliminationsMember']], -744],
];
const html = (rows = observations) => headers + '<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>'
  + (rows.some(row => row[1] === 'total') ? '' : context('total'))
  + rows.map(([id, key, dimensions, value]) => context(key, dimensions) + fact(id, key, `bac:${tag}`, value)).join('')
  + fact('f-112', 'total', 'us-gaap:Revenues', 31558) + '</html>';
const extract = (source = html(), cik = '70858') => extractConcentrationFacts(source, { cik, filing }).rows;

test('BAC reviewed FTE mapping reconciles segments and signed All Other to FTE, never GAAP revenue', () => {
  const groups = buildCompanyConcentrations(extract(), { filing }).revenue;
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.denominator.value, 31721000000);
  assert.equal(g.rows.length, 5);
  assert.equal(g.reconciles, true);
  assert.equal(g.rows.reduce((sum, row) => sum + row.value, 0), g.denominator.value);
  const other = g.rows.find(row => row.value < 0);
  assert.equal(other.value, -744000000); assert.equal(other.share, null);
  assert.equal(other.fact.sourceUrl, `${filing.url}#f-6465`);
  assert.match(g.reportingBasis, /taxable-equivalent/);
  assert.match(g.note, /differs from GAAP/);
});

test('custom mapping requires exact issuer, namespace, reviewed concept and authentic dimension namespaces', () => {
  assert.equal(extract(html(), '1234').length, 0);
  for (const source of [html().replaceAll('www.bankofamerica.com', 'www.unreviewed.com'), html().replaceAll('20260630', '20251231'),
    html().replaceAll(`bac:${tag}`, 'bac:RevenueLikeThis'), html().replace('http://fasb.org/srt/2026', 'http://example.test/srt')]) {
    assert.equal(buildCompanyConcentrations(extract(source), { filing }).revenue.length, 0);
  }
  assert.equal(extractCompanyInlineFacts(html(), { cik: '70858', filing, concepts: new Set([tag]) }).rows.length, 0);
});

test('missing FTE total never substitutes GAAP total and incomplete categories do not claim reconciliation', () => {
  const noTotal = buildCompanyConcentrations(extract(html(observations.filter(row => row[1] !== 'total'))), { filing }).revenue[0];
  assert.equal(noTotal.denominator, null); assert.equal(noTotal.reconciles, false);
  assert.ok(noTotal.rows.every(row => row.share === null));
  const noOther = buildCompanyConcentrations(extract(html(observations.filter(row => row[1] !== 'other'))), { filing }).revenue[0];
  assert.equal(noOther.reconciles, false);
  assert.equal(buildCompanyConcentrations(extract(), { filing, basis: 'annual' }).revenue.length, 0);
});

test('legacy goods and service revenue preserve concept-specific denominators across issuers', () => {
  for (const concept of ['SalesRevenueGoodsNet', 'SalesRevenueServicesNet']) {
    const make = (value, dimensions) => ({ id: JSON.stringify([value, dimensions]), concept, value, dimensions, start: '2026-04-01', end: filing.reportDate, periodType: 'duration' });
    const rows = [make(100, []), make(60, [{ axis: 'srt:ProductOrServiceAxis', member: 'ex:AMember', label: 'A' }]), make(40, [{ axis: 'srt:ProductOrServiceAxis', member: 'ex:BMember', label: 'B' }])];
    const group = buildCompanyConcentrations(rows, { filing }).revenue[0];
    assert.equal(group.denominator.value, 100); assert.equal(group.reconciles, true);
    assert.match(group.denominatorLabel, concept.includes('Goods') ? /goods/ : /services/);
  }
});

test('concentration response rejects stale schemas and wrong reporting selections', () => {
  const body = { schemaVersion: COMPANY_CONCENTRATIONS_VERSION, ticker: 'BAC', basis: 'ttm', asOf: null, status: 'ready', ...buildCompanyConcentrations(extract(), { filing }) };
  assert.equal(matchesCompanyConcentrations(body, 'BAC'), true);
  assert.equal(matchesCompanyConcentrations({ ...body, schemaVersion: 'company-concentrations-v2' }, 'BAC'), false);
  assert.equal(matchesCompanyConcentrations(body, 'GS'), false);
  assert.equal(matchesCompanyConcentrations(body, 'BAC', 'annual'), false);
  assert.equal(matchesCompanyConcentrations(body, 'BAC', 'ttm', '2026-07-31'), false);
});

test('concentration version bypasses old HTTP responses without weakening strict selection parsing', () => {
  const url = 'https://example.test/api/risk/concentrations?ticker=BAC&basis=ttm';
  const now = new Date('2026-09-18');
  assert.deepEqual(parseCompanyConcentrationsRequest(url, now), { ticker: 'BAC', basis: 'ttm', asOf: null });
  assert.deepEqual(parseCompanyConcentrationsRequest(`${url}&v=${COMPANY_CONCENTRATIONS_VERSION}`, now), parseCompanyConcentrationsRequest(url, now));
  for (const query of ['v=company-concentrations-v2', `v=${COMPANY_CONCENTRATIONS_VERSION}&v=${COMPANY_CONCENTRATIONS_VERSION}`, `v=${COMPANY_CONCENTRATIONS_VERSION}&ticker=GS`, `v=${COMPANY_CONCENTRATIONS_VERSION}&extra=1`]) {
    assert.throws(() => parseCompanyConcentrationsRequest(`${url}&${query}`, now));
  }
});

test('capital-lease debt aliases preserve current, noncurrent and total scope without adding balances', () => {
  const make = (concept, value) => ({ id: concept, concept, value, dimensions: [], start: null, end: filing.reportDate, periodType: 'instant' });
  const rows = [make('Liabilities', 1000), make('LongTermDebtAndCapitalLeaseObligationsCurrent', 50), make('LongTermDebtAndCapitalLeaseObligations', 250), make('LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities', 300)];
  const group = buildCompanyConcentrations(rows, { filing }).funding;
  assert.equal(group.rows.length, 2); assert.equal(group.reconciles, false);
  assert.equal(group.rows.find(row => /Noncurrent/.test(row.label)).value, 250);
  assert.equal(group.rows.find(row => /^Current/.test(row.label)).value, 50);
  assert.ok(group.rows.every(row => /leases/.test(row.label)));
  const totalOnly = buildCompanyConcentrations(rows.filter(row => !['LongTermDebtAndCapitalLeaseObligations', 'LongTermDebtAndCapitalLeaseObligationsCurrent'].includes(row.concept)), { filing }).funding;
  assert.equal(totalOnly.rows.length, 1); assert.equal(totalOnly.rows[0].value, 300); assert.match(totalOnly.rows[0].label, /reported total/);
  const aggregateCurrent = buildCompanyConcentrations([...rows, make('DebtCurrent', 75)], { filing }).funding;
  assert.equal(aggregateCurrent.rows.length, 2); assert.equal(aggregateCurrent.rows.find(row => /^Current/.test(row.label)).value, 75);
});

test('filing fiscal identity requires matching DEI values and verified issuer reporting context', () => {
  const identity = { DocumentFiscalYearFocus: '2026', DocumentFiscalPeriodFocus: 'Q2', DocumentType: '10-Q', DocumentPeriodEndDate: '2026-06-30' };
  const content = headers + context('base') + Object.entries(identity).map(([name, value]) => `<ix:nonNumeric name="dei:${name}" contextRef="base">${value}</ix:nonNumeric>`).join('') + '</html>';
  assert.deepEqual(extractInlineFilingIdentity(content, { cik: '70858', filing }), { fiscalYear: 2026, fiscalPeriod: 'Q2', documentType: '10-Q', documentPeriodEndDate: '2026-06-30' });
  assert.equal(extractInlineFilingIdentity(content, { cik: '1234', filing }), null);
  assert.equal(extractInlineFilingIdentity(content.replace('>10-Q<', '>10-K<'), { cik: '70858', filing }), null);
  const conflicting = content.replace('</html>', '<ix:nonNumeric name="dei:DocumentFiscalPeriodFocus" contextRef="base">Q3</ix:nonNumeric></html>');
  assert.equal(extractInlineFilingIdentity(conflicting, { cik: '70858', filing }), null);
});
