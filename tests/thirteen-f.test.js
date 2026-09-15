import test from 'node:test';
import assert from 'node:assert/strict';
import { parse13FCover, parse13FInformationTable, reconcile13FTable, assemble13FPeriod, summarize13FPortfolio, compare13FPortfolios } from '../src/utils/thirteenF.js';

const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
function coverXml({ period = '06-30-2026', form = '13F-HR', managerCik = '0001747057', count = 1, value = 100, amendment = null, amendmentNumber = 1, confidential = false, reportType = form.startsWith('13F-NT') ? '13F NOTICE' : '13F HOLDINGS REPORT' } = {}) {
  return `<?xml version="1.0"?><edgarSubmission xmlns="http://www.sec.gov/edgar/thirteenffiler"><headerData><submissionType>${form}</submissionType><filerInfo><filer><credentials><cik>${managerCik}</cik></credentials></filer><periodOfReport>${period}</periodOfReport></filerInfo></headerData><formData><coverPage><reportCalendarOrQuarter>${period}</reportCalendarOrQuarter><isAmendment>${amendment ? 'true' : 'false'}</isAmendment>${amendment ? `<amendmentNo>${amendmentNumber}</amendmentNo><amendmentInfo><amendmentType>${amendment}</amendmentType></amendmentInfo>` : ''}<filingManager><name>D1 Capital &amp; Partners</name></filingManager><reportType>${reportType}</reportType></coverPage><summaryPage><tableEntryTotal>${count}</tableEntryTotal><tableValueTotal>${value}</tableValueTotal>${confidential ? '<isConfidentialOmitted>true</isConfidentialOmitted>' : ''}</summaryPage></formData></edgarSubmission>`;
}
function rowXml({ cusip = '00827B106', issuer = 'AFFIRM HLDGS INC', classTitle = 'COM CL A', value = 100, quantity = 10, quantityType = 'SH', putCall = null, discretion = 'SOLE' } = {}) {
  return `<infoTable><nameOfIssuer>${escape(issuer)}</nameOfIssuer><titleOfClass>${escape(classTitle)}</titleOfClass><cusip>${cusip}</cusip>${value === null ? '' : `<value>${value}</value>`}<shrsOrPrnAmt>${quantity === null ? '' : `<sshPrnamt>${quantity}</sshPrnamt>`}<sshPrnamtType>${quantityType}</sshPrnamtType></shrsOrPrnAmt>${putCall ? `<putCall>${putCall}</putCall>` : ''}<investmentDiscretion>${discretion}</investmentDiscretion><votingAuthority><Sole>${quantity ?? 0}</Sole><Shared>0</Shared><None>0</None></votingAuthority></infoTable>`;
}
const tableXml = (rows = [{}]) => `<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">${rows.map(rowXml).join('')}</informationTable>`;
const parseCover = (options = {}, expected = {}) => parse13FCover(coverXml(options), { filingDate: '2026-08-14', cik: '1747057', ...expected });
let accession = 0;
function report(rows = [{}], options = {}, expected = {}) {
  const cover = parseCover({ count: rows.length, value: rows.reduce((sum, row) => sum + (row.value ?? 100), 0), ...options }, expected);
  const table = parse13FInformationTable(tableXml(rows), cover);
  return { cover, ...table, filing: { accession: `0001747057-26-${String(++accession).padStart(6, '0')}`, filingDate: cover.filingDate, reportDate: cover.period, form: cover.form, primaryUrl: 'https://www.sec.gov/example.xml', indexUrl: 'https://www.sec.gov/example-index.html', tableUrls: [] } };
}

test('cover identity, namespaced fields, and nearest-dollar units are normalized', () => {
  const cover = parseCover();
  assert.equal(cover.cik, '0001747057');
  assert.equal(cover.managerName, 'D1 Capital & Partners');
  assert.equal(cover.period, '2026-06-30');
  assert.equal(cover.valueMultiplier, 1);
  assert.equal(cover.confidentialOmitted, false);
  const prefixed = coverXml().replace(/(<\/?)(edgarSubmission|headerData|submissionType|filerInfo|filer|credentials|cik|periodOfReport|formData|coverPage|reportCalendarOrQuarter|isAmendment|filingManager|name|reportType|summaryPage|tableEntryTotal|tableValueTotal)(?=[\s>])/g, '$1f:$2').replace('xmlns=', 'xmlns:f=');
  assert.equal(parse13FCover(prefixed, { filingDate: '2026-08-14' }).cik, cover.cik);
  assert.equal(parse13FCover(coverXml().replace('<isAmendment>false</isAmendment>', ''), { filingDate: '2026-08-14' }).isAmendment, false);
});

test('value units use actual filing date, including late amendments for old quarters', () => {
  const old = parseCover({ period: '09-30-2022' }, { filingDate: '2022-11-14' });
  assert.equal(old.valueMultiplier, 1000);
  assert.equal(parse13FInformationTable(tableXml(), old).totalValueUsd, 100000);
  const revised = parseCover({ period: '09-30-2022', form: '13F-HR/A', amendment: 'RESTATEMENT' }, { filingDate: '2023-01-03' });
  assert.equal(revised.valueMultiplier, 1);
  assert.equal(parse13FInformationTable(tableXml(), revised).totalValueUsd, 100);
  assert.equal(parseCover({ period: '09-30-2022' }, { filingDate: '2023-01-02' }).valueMultiplier, 1000);
});

test('cover requires verified CIK, form, quarter and filing date', () => {
  assert.throws(() => parseCover({}, { cik: '123' }), /CIK/);
  assert.throws(() => parseCover({}, { form: '13F-HR\/A' }), /form/);
  assert.throws(() => parseCover({}, { period: '2026-03-31' }), /period/);
  assert.throws(() => parseCover({}, { filingDate: null }), /date/);
  assert.throws(() => parseCover({ period: '06-31-2026' }), /date/);
  assert.throws(() => parseCover({ period: '06-29-2026' }), /date/);
  assert.throws(() => parseCover({ form: 'NPORT-P' }), /identity/);
  assert.throws(() => parseCover({ form: '13F-HR/A' }), /amendment/);
  assert.throws(() => parseCover({ form: '13F-HR/A', amendment: 'UNKNOWN' }), /amendment/);
});

test('XML parser rejects DTD, entity expansion, malformed structure, and duplicate identity', () => {
  const base = coverXml();
  for (const input of [base.replace('<edgarSubmission ', '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><edgarSubmission '), base.replace('D1 Capital &amp; Partners', '&external;'), base.replace('</filer>', '</credentials>'), base + '<extra/>', base.replace('<cik>0001747057</cik>', '<cik>0001747057</cik><cik>0000000123</cik>'), base.replace('xmlns=', 'a="1" a="2" xmlns='), base.replace('&amp;', '&#0;')]) {
    assert.throws(() => parse13FCover(input, { filingDate: '2026-08-14' }), /Invalid SEC 13F/);
  }
  assert.throws(() => parse13FCover('x'.repeat(24 * 1024 * 1024 + 1), { filingDate: '2026-08-14' }), /oversized/);
});

test('information tables preserve leading-zero CUSIPs and option/quantity identities', () => {
  const rows = [{ value: 10 }, { putCall: 'Put', value: 20 }, { putCall: 'Call', value: 30 }, { quantityType: 'PRN', value: 40 }];
  const portfolio = assemble13FPeriod([report(rows)]);
  assert.equal(portfolio.holdings.length, 4);
  assert.ok(portfolio.holdings.every((holding) => holding.cusip === '00827B106'));
  assert.equal(new Set(portfolio.holdings.map((holding) => holding.key)).size, 4);
  const summary = summarize13FPortfolio(portfolio);
  assert.deepEqual([summary.ordinaryValueUsd, summary.putValueUsd, summary.callValueUsd, summary.principalValueUsd], [10, 20, 30, 40]);
  assert.equal(summary.top5Pct, 100);
});

test('separate discretion rows aggregate into one economic position without losing entry totals', () => {
  const portfolio = assemble13FPeriod([report([{ value: 100, quantity: 10 }, { value: 50, quantity: 5, discretion: 'DFND' }])]);
  assert.equal(portfolio.positionCount, 1);
  assert.equal(portfolio.entryCount, 2);
  assert.equal(portfolio.holdings[0].valueUsd, 150);
  assert.equal(portfolio.holdings[0].quantity, 15);
  assert.equal(portfolio.holdings[0].sourceRowCount, 2);
  assert.equal(portfolio.holdings[0].votingAuthority.sole, 15);
  assert.equal(portfolio.holdings[0].weightPct, 100);
});

test('missing values and quantities never become zero; incomplete totals disable shares and summary', () => {
  for (const rows of [[{ value: null }], [{ quantity: null }]]) {
    const parsed = parse13FInformationTable(tableXml(rows), parseCover());
    assert.equal(parsed.complete, false);
    assert.ok(parsed.issues.length > 0);
    if (rows[0].value === null) assert.equal(parsed.holdings[0].valueUsd, null);
    else assert.equal(parsed.holdings[0].quantity, null);
    const portfolio = assemble13FPeriod([{ ...report(), ...parsed }]);
    assert.equal(portfolio.complete, false);
    assert.equal(portfolio.totalValueUsd, null);
    assert.equal(portfolio.holdings[0].weightPct, null);
    assert.equal(summarize13FPortfolio(portfolio).top10Pct, null);
  }
});

test('actual zero values stay zero and zero denominators remain unavailable', () => {
  const portfolio = assemble13FPeriod([report([{ value: 0, quantity: 0 }])]);
  assert.equal(portfolio.complete, true);
  assert.equal(portfolio.totalValueUsd, 0);
  assert.equal(portfolio.holdings[0].valueUsd, 0);
  assert.equal(portfolio.holdings[0].weightPct, null);
  assert.equal(summarize13FPortfolio(portfolio).top5Pct, null);
});

test('table row and value totals must reconcile exactly, including combined attachments', () => {
  const cover = parseCover({ count: 2, value: 300 });
  const a = parse13FInformationTable(tableXml([{ value: 100 }]), cover, { validateTotals: false });
  const b = parse13FInformationTable(tableXml([{ value: 200, cusip: '02079K305' }]), cover, { validateTotals: false });
  assert.equal(reconcile13FTable([...a.holdings, ...b.holdings], cover).complete, true);
  assert.equal(reconcile13FTable(a.holdings, cover).complete, false);
  assert.equal(parse13FInformationTable(tableXml([{ value: 299 }, { value: 0 }]), cover).complete, false);
  assert.throws(() => parse13FInformationTable(tableXml([{ cusip: '123' }]), cover), /identity/);
  assert.throws(() => parse13FInformationTable(tableXml([{ putCall: 'SHORT' }]), cover), /identity/);
});

test('nonfinite and unsafe reported values remain unavailable', () => {
  for (const value of ['NaN', '-1', '1e6', '9007199254740992']) {
    const parsed = parse13FInformationTable(tableXml([{ value }]), parseCover());
    assert.equal(parsed.holdings[0].valueUsd, null);
    assert.equal(parsed.complete, false);
  }
  const overflow = assemble13FPeriod([report([{ value: 1, quantity: 5000000000000000 }, { value: 1, quantity: 5000000000000000 }])]);
  assert.equal(overflow.complete, false);
  assert.equal(overflow.holdings[0].quantity, null);
});

test('new-holdings amendments supplement originals and evidence retains both accessions', () => {
  const original = report([{ value: 100 }]);
  const addition = report([{ cusip: '02079K305', value: 200 }], { form: '13F-HR/A', amendment: 'NEW HOLDINGS' }, { filingDate: '2026-08-20' });
  const portfolio = assemble13FPeriod([addition, original]);
  assert.equal(portfolio.complete, true);
  assert.equal(portfolio.totalValueUsd, 300);
  assert.equal(portfolio.holdings.length, 2);
  assert.equal(portfolio.filings.length, 2);
  assert.equal(portfolio.amendmentCount, 1);
});

test('latest restatement replaces earlier baseline and additions, then accepts subsequent additions', () => {
  const original = report([{ value: 100 }]);
  const addition = report([{ cusip: '02079K305', value: 200 }], { form: '13F-HR/A', amendment: 'NEW HOLDINGS' }, { filingDate: '2026-08-15' });
  const restatement = report([{ value: 150 }], { form: '13F-HR/A', amendment: 'RESTATEMENT', amendmentNumber: 2 }, { filingDate: '2026-08-16' });
  const finalAddition = report([{ cusip: '02079K305', value: 250 }], { form: '13F-HR/A', amendment: 'NEW HOLDINGS', amendmentNumber: 3 }, { filingDate: '2026-08-17' });
  const portfolio = assemble13FPeriod([original, addition, restatement, finalAddition]);
  assert.equal(portfolio.complete, true);
  assert.equal(portfolio.totalValueUsd, 400);
  assert.deepEqual(portfolio.filings.map((filing) => filing.superseded), [true, true, false, false]);
});

test('orphan additions, duplicate originals, and overlapping additions do not create a complete portfolio', () => {
  const original = report();
  const addition = report([{ value: 200 }], { form: '13F-HR/A', amendment: 'NEW HOLDINGS' }, { filingDate: '2026-08-20' });
  assert.equal(assemble13FPeriod([addition]).complete, false);
  const overlap = assemble13FPeriod([original, addition]);
  assert.equal(overlap.complete, false);
  assert.equal(overlap.holdings[0].valueUsd, 100);
  assert.equal(overlap.totalValueUsd, null);
  assert.equal(assemble13FPeriod([original, report()]).complete, false);
  assert.throws(() => assemble13FPeriod([original, original]), /duplicate filing/);
  const missingAmendment = report([{ cusip: '02079K305', value: 200 }], { form: '13F-HR/A', amendment: 'NEW HOLDINGS', amendmentNumber: 2 }, { filingDate: '2026-08-20' });
  assert.equal(assemble13FPeriod([original, missingAmendment]).complete, false);
});

test('a later restatement may replace unavailable earlier table data, but never missing history', () => {
  const original = { ...report(), complete: false, issues: ['Earlier table unavailable.'] };
  const restatement = report([{ value: 200 }], { form: '13F-HR/A', amendment: 'RESTATEMENT' }, { filingDate: '2026-08-20' });
  assert.equal(assemble13FPeriod([original, restatement]).complete, true);
  assert.equal(assemble13FPeriod([{ ...original, historyComplete: false }, restatement]).complete, false);
});

test('confidential and combination reports distinguish reconciled public data from comparison eligibility', () => {
  for (const options of [{ confidential: true }, { reportType: '13F COMBINATION REPORT' }]) {
    const portfolio = assemble13FPeriod([report([{}], options)]);
    assert.equal(portfolio.complete, true);
    assert.equal(portfolio.comparable, false);
    assert.equal(portfolio.totalValueUsd, 100);
  }
  const notice = assemble13FPeriod([report([], { form: '13F-NT' })]);
  assert.equal(notice.complete, false);
  assert.equal(notice.totalValueUsd, null);
  assert.equal(notice.positionCount, 0);
});

test('comparisons classify exact reported identities and quantity changes without price inference', () => {
  const before = assemble13FPeriod([report([{ cusip: '00827B106', quantity: 10, value: 100 }, { cusip: '02079K305', quantity: 20, value: 200 }, { cusip: '023135106', quantity: 30, value: 300 }], { period: '03-31-2026' }, { filingDate: '2026-05-15' })]);
  const after = assemble13FPeriod([report([{ cusip: '00827B106', quantity: 15, value: 90 }, { cusip: '02079K305', quantity: 10, value: 220 }, { cusip: '032654105', quantity: 5, value: 50 }])]);
  const result = compare13FPortfolios(before, after);
  assert.equal(result.available, true);
  assert.deepEqual(result.counts, { newlyReported: 1, noLongerReported: 1, increased: 1, decreased: 1, unchanged: 0 });
  const affirm = result.changes.find((change) => change.cusip === '00827B106');
  assert.equal(affirm.status, 'increased');
  assert.equal(affirm.quantityChangePct, 50);
  assert.equal(affirm.valueChangeUsd, -10);
  const addition = result.changes.find((change) => change.status === 'newly-reported');
  assert.equal(addition.quantityChangePct, null);
  assert.equal(result.totalValueChangeUsd, -240);
});

test('comparisons require consecutive quarters, same manager, complete sources, and compatible scope', () => {
  const before = assemble13FPeriod([report([{}], { period: '03-31-2026' }, { filingDate: '2026-05-15' })]);
  const after = assemble13FPeriod([report()]);
  for (const candidate of [null, { ...after, cik: '0000001234' }, { ...after, period: '2026-09-30' }, { ...after, complete: false }, { ...after, confidentialOmitted: true }, { ...after, comparable: false }]) {
    const result = compare13FPortfolios(before, candidate);
    assert.equal(result.available, false);
    assert.equal(result.changes.length, 0);
    assert.ok(result.reason);
  }
});

test('an option appearing instead of shares does not imply an increase in the same position', () => {
  const before = assemble13FPeriod([report([{}], { period: '03-31-2026' }, { filingDate: '2026-05-15' })]);
  const after = assemble13FPeriod([report([{ putCall: 'CALL' }])]);
  assert.deepEqual(compare13FPortfolios(before, after).counts, { newlyReported: 1, noLongerReported: 1, increased: 0, decreased: 0, unchanged: 0 });
});

test('a class-title wording change with identical CUSIP does not fabricate an entry and exit', () => {
  const before = assemble13FPeriod([report([{ classTitle: 'COM' }], { period: '03-31-2026' }, { filingDate: '2026-05-15' })]);
  const after = assemble13FPeriod([report([{ classTitle: 'COMMON STOCK' }])]);
  assert.deepEqual(compare13FPortfolios(before, after).counts, { newlyReported: 0, noLongerReported: 0, increased: 0, decreased: 0, unchanged: 1 });
  const split = assemble13FPeriod([report([{ classTitle: 'COM' }, { classTitle: 'COMMON STOCK' }])]);
  assert.deepEqual(split.holdings[0].classTitles, ['COM', 'COMMON STOCK']);
  assert.equal(split.positionCount, 1);
});

test('amended notices need an amendment number but no holdings amendment type', () => {
  const xml = coverXml({ form: '13F-NT/A', amendment: 'RESTATEMENT', count: 0, value: 0 })
    .replace('<amendmentInfo><amendmentType>RESTATEMENT</amendmentType></amendmentInfo>', '')
    .replace('</coverPage>', '<otherManagersInfo><otherManager><cik>0000000123</cik><name>Reporting manager</name><form13FFileNumber>028-123</form13FFileNumber></otherManager></otherManagersInfo></coverPage>');
  const cover = parse13FCover(xml, { filingDate: '2026-08-14' });
  assert.equal(cover.amendmentType, null);
  assert.equal(cover.isAmendment, true);
  assert.deepEqual(cover.otherManagers, [{ sequenceNumber: null, cik: '0000000123', name: 'Reporting manager', fileNumber: '028-123' }]);
  const portfolio = assemble13FPeriod([{ cover, holdings: [], filing: { accession: '0001747057-26-000099', filingDate: '2026-08-14' } }]);
  assert.equal(portfolio.otherManagers[0].name, 'Reporting manager');
  assert.equal(portfolio.complete, false);
});

test('a restated 13F notice is not mistaken for a holdings-report baseline', () => {
  const cover = parseCover({ form: '13F-NT/A', amendment: 'RESTATEMENT', count: 0, value: 0 });
  const portfolio = assemble13FPeriod([{ cover, holdings: [], filing: { accession: '0001104659-26-105421', filingDate: '2026-08-14' } }]);
  assert.equal(portfolio.reportType, '13F NOTICE');
  assert.equal(portfolio.complete, false);
  assert.equal(portfolio.comparable, false);
  assert.equal(portfolio.totalValueUsd, null);
  assert.equal(portfolio.positionCount, 0);
  assert.deepEqual(portfolio.issues, ['This is a 13F notice; holdings are reported by another manager.']);
});
