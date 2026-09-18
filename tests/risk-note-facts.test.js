import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRiskNoteFacts, verifiesJointRegistrantFacts } from '../src/utils/riskNoteFacts.js';
import { SEC_EVIDENCE_CONTINUITY } from '../src/utils/secEvidenceContinuity.js';
import { parseRiskNoteRequest, selectRiskNoteFiling, discoverRiskNoteFacts } from '../src/utils/riskNoteFactsServer.js';

const cik = '0000123456';
const filing = { form: '10-Q', reportDate: '2026-06-30', filed: '2026-07-30', accession: '0000123456-26-000020', primaryDoc: 'company-20260630.htm',
  url: 'https://www.sec.gov/Archives/edgar/data/123456/000012345626000020/company-20260630.htm' };
const header = `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
  xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:ixt="http://www.xbrl.org/inlineXBRL/transformation/2020-02-12"
  xmlns:srt="http://fasb.org/srt/2026" xmlns:company="https://example.test/2026" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`;
const units = '<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><xbrli:unit id="pure"><xbrli:measure>xbrli:pure</xbrli:measure></xbrli:unit>';
const fx = [['us-gaap:DerivativeInstrumentRiskAxis', 'us-gaap:ForeignExchangeContractMember'], ['us-gaap:HedgingDesignationAxis', 'us-gaap:DesignatedAsHedgingInstrumentMember']];
const credit = [['us-gaap:ConcentrationRiskByTypeAxis', 'us-gaap:CreditConcentrationRiskMember'], ['us-gaap:ConcentrationRiskByBenchmarkAxis', 'us-gaap:TradeAccountsReceivableMember'], ['srt:MajorCustomersAxis', 'company:CustomerOneMember']];
function context(id, end = filing.reportDate, dimensions = fx, { issuer = cik, start = null, typed = '', scenario = '' } = {}) {
  return `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">${issuer}</xbrli:identifier><xbrli:segment>${dimensions.map(([axis, member]) => `<xbrldi:explicitMember dimension="${axis}">${member}</xbrldi:explicitMember>`).join('')}${typed}</xbrli:segment></xbrli:entity><xbrli:period>${start ? `<xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate>` : `<xbrli:instant>${end}</xbrli:instant>`}</xbrli:period>${scenario}</xbrli:context>`;
}
function fact(id, value, attributes = '') {
  return `<ix:nonFraction name="us-gaap:DerivativeNotionalAmount" contextRef="${id}" unitRef="usd" scale="6" format="ixt:num-dot-decimal" id="fact-${id}" ${attributes}>${value}</ix:nonFraction>`;
}
const extract = source => extractRiskNoteFacts(`${header}${units}${source}</html>`, { cik, filing });

test('joint registrant evidence requires both verified identities, exact period and a known filing', async () => {
  const successor = '0002115436', predecessor = '0000034088';
  const transition = SEC_EVIDENCE_CONTINUITY[successor];
  const selected = { ...filing, ...transition.source, form: '10-Q', primaryDoc: 'xom-20260630.htm' };
  const document = header.replace('<html ', '<html xmlns:dei="http://xbrl.sec.gov/dei/2026" ') + units
    + context('base', selected.reportDate, [], { issuer: predecessor, start: '2026-01-01' })
    + context('joint', selected.reportDate, [['dei:LegalEntityAxis', 'company:SuccessorMember']], { issuer: predecessor, start: '2026-01-01' })
    + context('amount', selected.reportDate, fx, { issuer: predecessor }) + fact('amount', '123')
    + `<ix:nonNumeric name="dei:EntityCentralIndexKey" contextRef="base">${predecessor}</ix:nonNumeric>`
    + `<ix:nonNumeric name="dei:EntityCentralIndexKey" contextRef="joint">${successor}</ix:nonNumeric>`
    + '<ix:nonNumeric name="dei:DocumentType" contextRef="base">10-Q</ix:nonNumeric>'
    + '<ix:nonNumeric name="dei:DocumentPeriodEndDate" contextRef="base">June 30, 2026</ix:nonNumeric></html>';
  const options = { cik: successor, predecessorCik: predecessor, filing: selected };
  assert.equal(verifiesJointRegistrantFacts(document, options), true);
  assert.equal(verifiesJointRegistrantFacts(document.replace(`>${successor}<`, '>0000999999<'), options), false);
  assert.equal(verifiesJointRegistrantFacts(document.replace('June 30, 2026', 'June 29, 2026'), options), false);
  const dependencies = setup([selected], { lookupTicker: async () => ({ cik: successor }),
    loadSubmissions: async () => ({ cik: successor, filings: { recent: manifestRows([selected]), files: [] } }), loadFiling: async () => document });
  const result = await discoverRiskNoteFacts({ ticker: 'XOM' }, dependencies);
  assert.equal(result.cik, successor);
  assert.equal(result.coverage.factCik, predecessor);
  assert.equal(result.rows[0].current.value, 123_000_000);
  const invalid = await discoverRiskNoteFacts({ ticker: 'XOM' }, { ...dependencies, loadFiling: async () => document.replace(`>${successor}<`, '>0000999999<') });
  assert.equal(invalid.rows.length, 0);
});

test('inline facts retain exact dimensions, scale, dates and source anchors; current and prior match', () => {
  const result = extract(context('now') + context('prior', '2025-12-31') + fact('now', '<span>61,313</span>') + fact('prior', '62,647'));
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.current.value, 61_313_000_000);
  assert.equal(row.prior.value, 62_647_000_000);
  assert.equal(row.prior.end, '2025-12-31');
  assert.equal(row.category, 'foreign_exchange');
  assert.equal(row.label, 'Foreign exchange · Accounting hedges');
  assert.equal(row.current.sourceUrl, `${filing.url}#fact-now`);
  assert.equal(row.dimensions.length, 2);
});

test('SEC HTTP-200 blocking pages remain unavailable rather than cached as no matches', () => {
  for (const html of ['<html><title>SEC.gov | Your Request Originates from an Undeclared Automated Tool</title></html>',
    '<html><h1>Request Rate Threshold Exceeded</h1></html>', '<html><title>Access Denied</title></html>'])
    assert.throws(() => extractRiskNoteFacts(html, { cik, filing }), { status: 503 });
});

test('accounting designations and additional dimensions are separate, never summed or cross-compared', () => {
  const nondesignated = [fx[0], ['us-gaap:HedgingDesignationAxis', 'us-gaap:NondesignatedMember']];
  const result = extract(context('now') + context('prior', '2025-12-31', nondesignated) + context('other', filing.reportDate, [...fx, ['company:RegionAxis', 'company:EuropeMember']])
    + fact('now', '10') + fact('prior', '20') + fact('other', '4'));
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find(row => !row.label.includes('Europe')).prior, null);
});

test('credit concentration percentages use pure units and retain their benchmark and context dates', () => {
  const html = context('now', filing.reportDate, credit, { start: '2026-01-01' }) + context('prior', '2025-12-31', credit, { start: '2025-01-01' })
    + '<ix:nonFraction name="us-gaap:ConcentrationRiskPercentage1" contextRef="now" unitRef="pure" scale="-2">47</ix:nonFraction>'
    + '<ix:nonFraction name="us-gaap:ConcentrationRiskPercentage1" contextRef="prior" unitRef="pure" scale="-2">46</ix:nonFraction>';
  const [row] = extract(html).rows;
  assert.equal(row.kind, 'credit_concentration');
  assert.equal(row.current.value, .47);
  assert.equal(row.prior.value, .46);
  assert.equal(row.current.start, '2026-01-01');
  assert.equal(row.label, 'Customer One · Trade Accounts Receivable');
});

test('sales concentration and custom members impersonating credit risk do not become credit concentration', () => {
  for (const member of ['us-gaap:SalesConcentrationRiskMember', 'company:CreditConcentrationRiskMember']) {
    const dims = [[credit[0][0], member], ...credit.slice(1)];
    const result = extract(context('now', filing.reportDate, dims) + '<ix:nonFraction name="us-gaap:ConcentrationRiskPercentage1" contextRef="now" unitRef="pure" scale="-2">18</ix:nonFraction>');
    assert.equal(result.rows.length, 0);
  }
});

test('missing context, another issuer, unsupported typed dimensions and scenario facts are unavailable', () => {
  for (const contextHtml of ['', context('now', filing.reportDate, fx, { issuer: '9999999' }),
    context('now', filing.reportDate, fx, { typed: '<xbrldi:typedMember dimension="company:CounterpartyAxis"><company:Name>A</company:Name></xbrldi:typedMember>' }),
    context('now', filing.reportDate, fx, { scenario: '<xbrli:scenario><company:Scenario>Estimated</company:Scenario></xbrli:scenario>' })]) {
    assert.equal(extract(contextHtml + fact('now', '100')).rows.length, 0);
  }
});

test('unknown transforms, nil facts, negative notionals, invalid scale, ambiguous numbers and exclusions are not zero', () => {
  for (const [value, attrs] of [['—', ''], ['100', 'xsi:nil="true"'], ['100', 'sign="-"'], ['100', 'scale="99"'], ['1.234,56', ''],
    ['<ix:exclude>1</ix:exclude>100', ''], ['100', 'continuedAt="next"'], ['100', 'format="company:unknown"']]) {
    assert.equal(extract(context('now') + fact('now', value, attrs)).rows.length, 0, `${value} ${attrs}`);
  }
  const unknown = fact('now', '100').replace('ixt:num-dot-decimal', 'company:num-dot-decimal');
  assert.equal(extract(context('now') + unknown).rows.length, 0);
});

test('standard fixed-zero retains current zero notionals and the most recent zero comparison', () => {
  const zero = (id, value = '—', attrs = '') => fact(id, value, attrs).replace('ixt:num-dot-decimal', 'ixt:fixed-zero');
  for (const namespace of ['2020-02-12', '2022-02-16']) {
    const source = `${header.replace('transformation/2020-02-12', `transformation/${namespace}`)}${units}`;
    const compared = extractRiskNoteFacts(source + context('now') + fact('now', '328')
      + context('recent', '2025-12-31') + zero('recent')
      + context('older', '2025-06-30') + fact('older', '57') + '</html>', { cik, filing }).rows[0];
    assert.equal(compared.current.value, 328_000_000);
    assert.equal(compared.prior.value, 0);
    assert.equal(compared.prior.end, '2025-12-31');
    for (const displayed of ['-', '–', '—', '−', '', '0', '0.00']) {
      const result = extractRiskNoteFacts(source + context('now') + zero('now', displayed, 'sign="-"') + '</html>', { cik, filing });
      assert.equal(result.rows.length, 1, displayed);
      assert.equal(result.rows[0].current.value, 0);
      assert.equal(Object.is(result.rows[0].current.value, -0), false);
    }
  }
});

test('fixed-zero requires a supported namespace and unambiguous zero rendering', () => {
  const zero = fact('now', '—').replace('ixt:num-dot-decimal', 'ixt:fixed-zero');
  for (const content of [zero.replace('ixt:fixed-zero', 'company:fixed-zero'), zero.replace('>—<', '>100<'), zero.replace('>—<', '>Unavailable<'),
    zero.replace('scale="6"', 'scale="99"'), zero.replace('id="fact-now"', 'id="fact-now" xsi:nil="true"')])
    assert.equal(extract(context('now') + content).rows.length, 0);
  const unsupportedNamespace = (header + units + context('now') + zero + '</html>').replace('transformation/2020-02-12', 'transformation/2015-02-26');
  assert.equal(extractRiskNoteFacts(unsupportedNamespace, { cik, filing }).rows.length, 0);
});

test('unrecognized currency, misleading unit prefix and divided units are not USD', () => {
  for (const unit of [units.replace('iso4217:USD', 'iso4217:EUR'), units.replace('iso4217:USD', 'company:USD'),
    '<xbrli:unit id="usd"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>']) {
    assert.equal(extractRiskNoteFacts(header + unit + context('now') + fact('now', '100') + '</html>', { cik, filing }).rows.length, 0);
  }
});

test('custom concepts with the same name and forged taxonomy namespaces are excluded', () => {
  assert.equal(extract(context('now') + fact('now', '100').replace('us-gaap:DerivativeNotionalAmount', 'company:DerivativeNotionalAmount')).rows.length, 0);
  assert.equal(extractRiskNoteFacts((header + units + context('now') + fact('now', '100')).replace('http://fasb.org/us-gaap/2026', 'https://example.test/us-gaap/2026'), { cik, filing }).rows.length, 0);
});

test('conflicting duplicate facts and duplicate context identifiers cannot pick an arbitrary number', () => {
  assert.equal(extract(context('now') + fact('now', '100') + fact('now', '101')).rows.length, 0);
  assert.equal(extract(context('now') + context('now', '2025-12-31') + fact('now', '100')).rows.length, 0);
  assert.equal(extract(context('now') + fact('now', '100') + fact('now', '100')).rows.length, 1);
});

test('only current filing period appears; future or historical-only data cannot impersonate current', () => {
  for (const end of ['2026-07-01', '2025-12-31', '2026-02-30']) assert.equal(extract(context('now', end) + fact('now', '100')).rows.length, 0);
  assert.equal(extract(context('now', filing.reportDate, fx, { start: '2026-01-01' }) + fact('now', '100')).rows.length, 0);
});

test('ambiguous concentration durations ending on the same date are not interchangeable', () => {
  const percentage = id => `<ix:nonFraction name="us-gaap:ConcentrationRiskPercentage1" contextRef="${id}" unitRef="pure" scale="-2">20</ix:nonFraction>`;
  const result = extract(context('ytd', filing.reportDate, credit, { start: '2026-01-01' }) + context('quarter', filing.reportDate, credit, { start: '2026-04-01' }) + percentage('ytd') + percentage('quarter'));
  assert.equal(result.rows.length, 0);
});

test('request contract validates duplicate filters, cutoff dates, basis and unknown URL inputs', () => {
  const now = new Date('2026-09-18');
  assert.deepEqual(parseRiskNoteRequest('https://example.test/?ticker=aapl&basis=annual&asOf=2026-06-01', now), { ticker: 'AAPL', basis: 'annual', asOf: '2026-06-01' });
  for (const query of ['ticker=AAPL&ticker=XOM', 'ticker=AAPL&url=https://elsewhere.test', 'ticker=AAPL&basis=quarterly', 'ticker=../AAPL', 'ticker=AAPL&asOf=', 'ticker=AAPL&asOf=2026-02-30', 'ticker=AAPL&asOf=2026-09-19'])
    assert.throws(() => parseRiskNoteRequest(`https://example.test/?${query}`, now), { status: 400 });
});

function manifestRows(items) {
  return { accessionNumber: items.map(item => item.accession), form: items.map(item => item.form), filingDate: items.map(item => item.filed), reportDate: items.map(item => item.reportDate), primaryDocument: items.map(item => item.primaryDoc) };
}
const annual = { ...filing, form: '10-K', reportDate: '2025-12-31', filed: '2026-02-01', accession: '0000123456-26-000001', primaryDoc: 'annual.htm' };
const setup = (items = [annual, filing], overrides = {}) => ({ now: new Date('2026-09-18'), lookupTicker: async () => ({ cik, name: 'Example' }),
  loadSubmissions: async () => ({ cik, name: 'Example', filings: { recent: manifestRows(items), files: [] } }),
  loadFiling: async () => header + units + context('now') + fact('now', '100') + '</html>', ...overrides });

test('annual and current note selection use the latest eligible reporting period', () => {
  assert.equal(selectRiskNoteFiling([annual, filing], 'annual').accession, annual.accession);
  assert.equal(selectRiskNoteFiling([annual, filing], 'ttm').accession, filing.accession);
  const lateOldReport = { ...annual, filed: '2026-08-15' };
  assert.equal(selectRiskNoteFiling([filing, lateOldReport], 'ttm').accession, filing.accession);
});

test('server fetches one verified original filing and returns exact parser rows', async () => {
  const loaded = [];
  const result = await discoverRiskNoteFacts({ ticker: 'EXAMPLE', basis: 'ttm' }, setup(undefined, { loadFiling: async selected => {
    loaded.push(selected); return header + units + context('now') + fact('now', '100') + '</html>';
  } }));
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].accession, filing.accession);
  assert.equal(result.status, 'ready');
  assert.equal(result.rows[0].current.value, 100_000_000);
  assert.equal(result.coverage.historyFilesScanned, 0);
});

test('filing cutoff, amendments and source identity prevent silent substitutions', async () => {
  const loaded = [];
  const result = await discoverRiskNoteFacts({ ticker: 'EXAMPLE', basis: 'ttm', asOf: '2026-06-01' }, setup([annual, filing, { ...filing, form: '10-Q/A' }], { loadFiling: async selected => { loaded.push(selected); return header + units + '</html>'; } }));
  assert.equal(loaded[0].accession, annual.accession);
  assert.equal(result.status, 'no_matches');
  assert.equal(result.rows.length, 0);
  await assert.rejects(discoverRiskNoteFacts({ ticker: 'EXAMPLE' }, setup(undefined, { loadSubmissions: async () => ({ cik: 999, filings: { recent: manifestRows([filing]) } }) })), { status: 502 });
  await assert.rejects(discoverRiskNoteFacts({ ticker: 'EXAMPLE' }, setup(undefined, { loadFiling: async () => { throw new Error('Selected source unavailable'); } })), /Selected source unavailable/);
});

test('historical manifest search is bounded and exposes incomplete coverage', async () => {
  const files = [1, 2, 3].map(number => ({ name: `CIK${cik}-submissions-${number}.json`, filingFrom: '2020-01-01', filingTo: '2026-08-01' }));
  const result = await discoverRiskNoteFacts({ ticker: 'EXAMPLE' }, setup([], {
    loadSubmissions: async file => file === `CIK${cik}.json` ? { cik, filings: { recent: manifestRows([]), files } } : manifestRows([]),
    loadFiling: async () => { throw new Error('No filing should be loaded'); },
  }));
  assert.equal(result.status, 'no_filing');
  assert.equal(result.coverage.historyLimited, true);
  assert.equal(result.coverage.historyFilesScanned, 2);
  assert.deepEqual(result.rows, []);
});
