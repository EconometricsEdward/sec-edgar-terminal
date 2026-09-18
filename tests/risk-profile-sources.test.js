import test from 'node:test';
import assert from 'node:assert/strict';
import { latestRiskProfileFiling, mergeRiskProfileCompanyFacts, supplementRiskProfileFacts, prepareRiskProfileSources } from '../src/utils/riskProfileSources.js';
import { reportingPeriods, selectFinancialFact, sourceDocumentUrl } from '../src/utils/xbrlPeriods.js';
import { extractCompanyInlineFacts, extractInlineFilingIdentity } from '../src/utils/riskNoteFacts.js';

const cik = '0000021344', now = new Date('2026-09-18'), today = '2026-09-18';
const filing = { accession: '0001628280-26-050503', filed: '2026-07-29', reportDate: '2026-07-03', form: '10-Q', primaryDoc: 'ko-20260703.htm',
  url: 'https://www.sec.gov/Archives/edgar/data/21344/000162828026050503/ko-20260703.htm' };
const record = (val, end = '2026-04-03', extra = {}) => ({ val, end, accn: '0001628280-26-028802', filed: '2026-04-30', form: '10-Q', fy: 2026, fp: 'Q1', ...extra });
const company = (id = cik) => ({ cik: Number(id), facts: { 'us-gaap': { Assets: { units: { USD: [record(100)] } } } } });
const manifest = (id = cik) => ({ cik: Number(id), filings: { recent: { accessionNumber: [filing.accession], filingDate: [filing.filed], reportDate: [filing.reportDate], form: [filing.form], primaryDocument: [filing.primaryDoc] } } });
const context = (id, { issuer = cik, start = null, end = filing.reportDate, dimension = '' } = {}) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">${issuer}</xbrli:identifier>${dimension ? `<xbrli:segment><xbrldi:explicitMember dimension="custom:Axis">${dimension}</xbrldi:explicitMember></xbrli:segment>` : ''}</xbrli:entity><xbrli:period>${start ? `<xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate>` : `<xbrli:instant>${end}</xbrli:instant>`}</xbrli:period></xbrli:context>`;
const fact = (tag, value, id, ctx = 'instant', unit = 'usd') => `<ix:nonFraction name="us-gaap:${tag}" contextRef="${ctx}" unitRef="${unit}" id="${id}">${value}</ix:nonFraction>`;
const row = (label, content) => `<tr><td>${label}</td><td>${content}</td></tr>`;
const doc = (body = '', options = {}) => `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:dei="http://xbrl.sec.gov/dei/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:custom="https://example.test/2026">${context('instant', options)}${context('duration', { ...options, start: '2026-01-01' })}${context('segment', { ...options, dimension: 'custom:SegmentMember' })}<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><xbrli:unit id="eur"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>${[['DocumentFiscalYearFocus', '2026'], ['DocumentFiscalPeriodFocus', 'Q2'], ['DocumentPeriodEndDate', filing.reportDate], ['DocumentType', '10-Q']].map(([tag,value]) => `<ix:nonNumeric name="dei:${tag}" contextRef="duration">${value}</ix:nonNumeric>`).join('')}${body}</html>`;
const balance = () => `<table>${row('Current Assets', '')}${row('Marketable securities', fact('MarketableSecurities', '20', 'securities'))}${row('Total Current Assets', fact('AssetsCurrent', '60', 'current-assets'))}${row('Total Assets', fact('Assets', '120', 'assets'))}${row('Current Liabilities', '')}${row('Loans and notes payable', fact('NotesAndLoansPayable', '4', 'notes'))}${row('Current portion of long-term debt', fact('LongTermDebtCurrent', '6', 'maturities'))}${row('Total Current Liabilities', fact('LiabilitiesCurrent', '30', 'current-liabilities'))}${row('Total Liabilities and Equity', fact('LiabilitiesAndStockholdersEquity', '120', 'balance'))}</table>`;
const fallback = html => ({ loadCompanyFacts: async () => { throw new Error('Unexpected predecessor'); }, loadFiling: async () => html });

test('newer original filings are selected from exact company manifest only', () => {
  assert.deepEqual(latestRiskProfileFiling(manifest(), cik, today), filing);
  assert.equal(latestRiskProfileFiling(manifest(123), cik, today), null);
  for (const changes of [{ primaryDocument: ['../evil.htm'] }, { form: ['10-Q/A'] }, { filingDate: ['2026-12-31'] }, { reportDate: ['2026-02-30'] }, { accessionNumber: ['bogus'] }]) {
    const source = manifest(); Object.assign(source.filings.recent, changes);
    assert.equal(latestRiskProfileFiling(source, cik, today), null);
  }
});

test('verified inline source fills missing latest period with exact provenance', async () => {
  const result = await prepareRiskProfileSources({ cik, company: company(), submissions: manifest(), now }, fallback(doc(balance())));
  assert.equal(result.sourceCoverage.filingFallback.status, 'applied');
  assert.equal(result.sourceCoverage.companyFactsThrough, '2026-04-03');
  assert.equal(reportingPeriods(result.facts, 'quarter')[0].end, filing.reportDate);
  const source = selectFinancialFact(result.facts, ['Assets'], reportingPeriods(result.facts, 'quarter')[0]).source;
  assert.equal(source.value, 120);
  assert.equal(source.sourceCik, cik);
  assert.equal(source.documentUrl, `${filing.url}#assets`);
  assert.equal(sourceDocumentUrl('0000000001', source), `${filing.url}#assets`);
});

test('generic securities and debt get classification only from a bounded primary balance section', () => {
  const result = supplementRiskProfileFacts(company().facts, doc(balance()), { cik, filing });
  const securities = result.facts['us-gaap'].MarketableSecurities.units.USD[0];
  assert.equal(securities.balanceClassification, 'current');
  assert.equal(securities.classificationEvidence.subtotalFactId, 'current-assets');
  const notes = result.facts['us-gaap'].NotesAndLoansPayable.units.USD[0];
  assert.equal(notes.balanceClassification, 'current');
  assert.equal(notes.debtScope, 'short-term-component');
  assert.equal(notes.classificationEvidence.separateCurrentMaturitiesFactId, 'maturities');
  assert.equal(result.classifiedFacts, 2);
});

test('classification cannot guess from a generic tag, hidden table or an unclassified statement', () => {
  for (const body of [balance().replace('Current Assets', 'Assets'), balance().replace('<table>', '<table style="display:none">'),
    balance().replace('name="us-gaap:AssetsCurrent"', 'name="custom:AssetsCurrent"')]) {
    const result = supplementRiskProfileFacts(company().facts, doc(body), { cik, filing });
    assert.equal(result.facts['us-gaap'].MarketableSecurities.units.USD[0].balanceClassification, undefined);
  }
});

test('notes payable is not treated as a short-term component without distinct current maturities', () => {
  const result = supplementRiskProfileFacts(company().facts, doc(balance().replace('name="us-gaap:LongTermDebtCurrent"', 'name="custom:LongTermDebtCurrent"')), { cik, filing });
  const notes = result.facts['us-gaap'].NotesAndLoansPayable.units.USD[0];
  assert.equal(notes.balanceClassification, 'current'); assert.equal(notes.debtScope, undefined);
});

test('dimensioned, custom namespace, wrong unit, future contexts and conflicting duplicate facts are not injected', () => {
  const extra = fact('NetIncomeLoss', '5', 'net', 'segment') + fact('Cash', '10', 'cash').replace('name="us-gaap:Cash"', 'name="custom:Cash"')
    + fact('Revenues', '100', 'revenue', 'duration', 'eur') + fact('InterestExpense', '1', 'i1', 'duration') + fact('InterestExpense', '2', 'i2', 'duration');
  const result = supplementRiskProfileFacts(company().facts, doc(balance() + extra), { cik, filing });
  for (const tag of ['NetIncomeLoss', 'Cash', 'Revenues', 'InterestExpense']) assert.equal(result.facts['us-gaap'][tag], undefined);
});

test('same-filing aggregated data wins over conflicting document values, with no false classification', () => {
  const source = company().facts;
  source['us-gaap'].MarketableSecurities = { units: { USD: [record(99, filing.reportDate, { accn: filing.accession, filed: filing.filed })] } };
  const result = supplementRiskProfileFacts(source, doc(balance()), { cik, filing });
  assert.equal(result.facts['us-gaap'].MarketableSecurities.units.USD.length, 1);
  assert.equal(result.facts['us-gaap'].MarketableSecurities.units.USD[0].val, 99);
  assert.equal(result.facts['us-gaap'].MarketableSecurities.units.USD[0].balanceClassification, undefined);
});

test('bad issuer, fiscal period, taxonomy or absent current financial anchor fails fallback and retains old facts', async () => {
  for (const html of [doc(balance(), { issuer: '0000000001' }), doc(balance()).replace('>Q2<', '>FY<'),
    doc(balance()).replace('http://fasb.org/us-gaap/2026', 'https://evil.test/us-gaap/2026'), doc(fact('Cash', '10', 'cash'))]) {
    const result = await prepareRiskProfileSources({ cik, company: company(), submissions: manifest(), now }, fallback(html));
    assert.equal(result.sourceCoverage.filingFallback.status, 'unavailable');
    assert.equal(reportingPeriods(result.facts, 'quarter')[0].end, '2026-04-03');
    assert.match(result.sourceCoverage.notices[0], /newer SEC filing/);
  }
});

test('SEC failure is a disclosed partial profile, never an empty replacement', async () => {
  const result = await prepareRiskProfileSources({ cik, company: company(), submissions: manifest(), now }, { ...fallback(''), loadFiling: async () => { throw new Error('timeout'); } });
  assert.equal(result.sourceCoverage.filingFallback.status, 'unavailable');
  assert.equal(result.facts['us-gaap'].Assets.units.USD[0].val, 100);
});

test('current facts avoid document retrieval unless source classification is needed', async () => {
  const current = company(); current.facts['us-gaap'].Assets.units.USD = [record(120, filing.reportDate, { accn: filing.accession, filed: filing.filed, fp: 'Q2' })];
  let calls = 0;
  const load = { ...fallback(''), loadFiling: async () => { calls++; return doc(balance()); } };
  const one = await prepareRiskProfileSources({ cik, company: current, submissions: manifest(), now }, load);
  assert.equal(one.sourceCoverage.filingFallback.status, 'not-needed'); assert.equal(calls, 0);
  current.facts['us-gaap'].MarketableSecurities = { units: { USD: [record(20, filing.reportDate, { accn: filing.accession, filed: filing.filed, fp: 'Q2' })] } };
  const two = await prepareRiskProfileSources({ cik, company: current, submissions: manifest(), now }, load);
  assert.equal(two.sourceCoverage.filingFallback.reason, 'classification'); assert.equal(calls, 1);
});

test('only reviewed predecessor pre-transition history joins the current legal identity', async () => {
  const currentCik = '0002115436', predecessorCik = '0000034088';
  const current = company(currentCik); current.facts['us-gaap'].Assets.units.USD = [record(464, '2026-06-30')];
  const prior = company(predecessorCik); prior.facts['us-gaap'].Assets.units.USD = [record(460, '2025-12-31', { accn: '0000034088-26-000010', filed: '2026-02-20', form: '10-K', fp: 'FY' }), record(999, '2026-09-30')];
  const merged = mergeRiskProfileCompanyFacts([current, prior, company('0000000001')], { cik: currentCik, today });
  assert.equal(merged['us-gaap'].Assets.units.USD.length, 2);
  assert.equal(merged['us-gaap'].Assets.units.USD[1].sourceCik, predecessorCik);
  assert.equal(reportingPeriods(merged, 'annual')[0].end, '2025-12-31');
  assert.equal(mergeRiskProfileCompanyFacts([current, prior], { cik: currentCik, today: '2026-07-01' })['us-gaap'].Assets.units.USD.length, 1);
  const noTransition = mergeRiskProfileCompanyFacts([company(), prior], { cik, today });
  assert.equal(noTransition['us-gaap'].Assets.units.USD.length, 1);
});

test('predecessor retrieval identity mismatch is disclosed, not attached', async () => {
  const currentCik = '0002115436';
  const result = await prepareRiskProfileSources({ cik: currentCik, company: company(currentCik), submissions: manifest(currentCik), now },
    { loadCompanyFacts: async () => company('0000000001'), loadFiling: async () => { throw new Error('unavailable'); } });
  assert.equal(result.sourceCoverage.continuity.status, 'partial');
  assert.equal(result.facts['us-gaap'].Assets.units.USD.length, 1);
  assert.match(result.sourceCoverage.notices[0], /predecessor history could not/);
});

test('nested joint-filing DEI text retains each issuer context without borrowing parent identity', () => {
  const outer = (name, text) => `<ix:nonNumeric name="dei:${name}" contextRef="other">${text}</ix:nonNumeric>`;
  const type = '<ix:nonNumeric name="dei:DocumentType" contextRef="duration">10-Q</ix:nonNumeric>';
  const nested = doc(balance()).replace(type, outer('DocumentType', type)).replace('</html>', `${context('other', { issuer: '0001045610', start: '2026-01-01' })}</html>`);
  assert.equal(extractInlineFilingIdentity(nested, { cik, filing }).documentType, '10-Q');
  const splitDate = nested.replace('>2026-07-03</ix:nonNumeric>', '><span>July 3, </span><span>2026</span></ix:nonNumeric>');
  assert.equal(extractInlineFilingIdentity(splitDate, { cik, filing }).documentPeriodEndDate, filing.reportDate);
  assert.equal(supplementRiskProfileFacts(company().facts, nested, { cik, filing }).facts['us-gaap'].Assets.units.USD.at(-1).val, 120);
  // A similarly named extension or a dimensional other-issuer fact does not
  // inherit the verified top-level document's issuer or DEI namespace.
  assert.equal(extractInlineFilingIdentity(nested.replace(type, type.replace('name="dei:DocumentType"', 'name="custom:DocumentType"')), { cik, filing }), null);
  assert.equal(extractInlineFilingIdentity(nested.replace(type, type.replace('contextRef="duration"', 'contextRef="other"')), { cik, filing }), null);
  assert.equal(extractInlineFilingIdentity(nested.replace(type, `<ix:exclude>${type}</ix:exclude>`), { cik, filing }), null);
});

test('rounded duplicates retain the actual highest-precision cash fact in either source order', () => {
  const exact = fact('Cash', '1765043000', 'precise').replace('id="precise"', 'id="precise" decimals="-3"');
  const rounded = fact('Cash', '1765000000', 'rounded').replace('id="rounded"', 'id="rounded" decimals="-6"');
  for (const html of [exact + rounded, rounded + exact]) {
    const result = extractCompanyInlineFacts(doc(html), { cik, filing, concepts: new Set(['Cash']), reconcilePrecision: true });
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].value, 1765043000); assert.equal(result.rows[0].factId, 'precise');
    assert.equal(result.rows[0].sourceUrl, `${filing.url}#precise`);
    assert.equal(extractCompanyInlineFacts(doc(html), { cik, filing, concepts: new Set(['Cash']) }).rows.length, 0);
  }
});

test('rounding reconciliation rejects conflicts, missing/unsupported precision, touching intervals and inconsistent chains', () => {
  const duplicate = (value, decimals, index) => fact('Cash', String(value), `d${index}`).replace(`id="d${index}"`, `id="d${index}"${decimals == null ? '' : ` decimals="${decimals}"`}`);
  const cases = [
    [[1765043000, '-3'], [1764000000, '-6']],
    [[1765043000, '-3'], [1765000000, null]],
    [[1765043000, '-3'], [1765000000, 'bad']],
    [[1765043000, '-3'], [1765000000, '-99']],
    [[100, '0'], [101, '0']],
    [[100, '-1'], [109, '-1']],
    [[100, '-1'], [109, '-1'], [118, '-1']],
    [[100, 'INF'], [101, 'INF']],
    [[100, '0'], [101, '0'], [100, '0']],
  ];
  for (const values of cases) {
    const result = extractCompanyInlineFacts(doc(values.map(([value, decimals], index) => duplicate(value, decimals, index)).join('')), { cik, filing, concepts: new Set(['Cash']), reconcilePrecision: true });
    assert.equal(result.rows.length, 0, JSON.stringify(values));
  }
});
