import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBrokerDealerDocument as classify } from '../src/utils/brokerDealerClassification.js';
import { BROKER_DEALER_FORM, BROKER_DEALER_FORM_DESCRIPTION, isBrokerDealerForm, brokerDealerFormDescription } from '../src/utils/brokerDealerForms.js';
const url = 'https://www.sec.gov/Archives/edgar/data/1001/000000100126000001/public.pdf';
const page = (text, pageNumber = 1) => ({ text, pageNumber });
const document = { name: 'public.pdf', url };
const body = 'REPORT OF INDEPENDENT REGISTERED PUBLIC ACCOUNTING FIRM\nWe have audited the accompanying statement of financial condition of Example Securities LLC as of June 30, 2026, and the related notes. In our opinion, the financial statement presents fairly, in all material respects, the financial position of the Company.\nBasis for Opinion\nWe conducted our audit in accordance with PCAOB standards.';
const balance = 'STATEMENT OF FINANCIAL CONDITION\nAS OF JUNE 30, 2026\nASSETS\nCash $1,000\nTotal assets $10,000\nTotal liabilities $8,000\nMembers equity $2,000';
const annualCover = 'ANNUAL REPORTS\nFORM X-17A-5\nPART III\nFACING PAGE\nFILING FOR THE PERIOD BEGINNING 07/01/25 AND ENDING 06/30/26\nTYPE OF REGISTRANT (check all applicable boxes):\nBroker dealer\nACCOUNTANT IDENTIFICATION\nINDEPENDENT PUBLIC ACCOUNTANT\nExample Audit LLP';
const notes = 'NOTES TO STATEMENT OF FINANCIAL CONDITION\n1. Organization and basis of presentation.\n' + 'The Company is a securities broker dealer registered with the SEC. '.repeat(5) + 'The Company reconciles its computation of net capital with the FOCUS Part II report.';

test('raw form code uses a neutral description and does not classify a document', () => {
  assert.equal(BROKER_DEALER_FORM, 'X-17A-5');
  assert.equal(BROKER_DEALER_FORM_DESCRIPTION, 'Broker-dealer report');
  assert.equal(isBrokerDealerForm('X-17A-5/A'), true);
  assert.equal(brokerDealerFormDescription('X-17A-5/A'), 'Broker-dealer report amendment');
  const result = classify({ filing: { form: 'X-17A-5', reportDate: '2026-06-30', filingDate: '2026-08-31' }, cover: { accountantName: 'Example Audit LLP' } });
  assert.equal(result.family, 'unknown');
  assert.equal(result.audit.status, 'not-established');
  assert.equal(result.period.frequency, 'unknown');
  assert.equal(result.period.end, '2026-06-30');
});

test('Part III and substantive auditor report distinguish annual audited financial-condition-only reports', () => {
  const result = classify({ selectedDocument: document, pages: [page(annualCover), page(body, 3), page(balance, 4), page(notes, 5)] });
  assert.equal(result.family, 'annual-report');
  assert.equal(result.label, 'Annual audited report');
  assert.deepEqual(result.parts, ['Part III']);
  assert.deepEqual(result.audit, { status: 'auditor-report-present', scope: 'financial-condition' });
  assert.deepEqual(result.period, { start: '2025-07-01', end: '2026-06-30', frequency: 'annual' });
  assert.deepEqual(result.components, ['auditor-report', 'financial-condition', 'notes']);
  assert.equal(result.evidence.find(item => item.kind === 'auditor-report').url, `${url}#page=3`);
  assert.ok(!result.parts.includes('Part II'), 'A notes reference must not reclassify the report');
});

test('Part III alone establishes family, neither audit nor reporting frequency', () => {
  const result = classify({ pages: [page('FORM X-17A-5\nPART III\nFACING PAGE\nACCOUNTANT IDENTIFICATION\nExample Audit LLP')] });
  assert.equal(result.family, 'annual-report');
  assert.equal(result.label, 'Annual report');
  assert.equal(result.audit.status, 'not-established');
  assert.equal(result.period.frequency, 'unknown');
});

test('annual checklist and table of contents do not prove statements or audit report are present', () => {
  const checklist = 'OATH OR AFFIRMATION\nThis filing contains (check all applicable boxes):\n(a) Statement of financial condition\n(b) Statement of income\n(c) Statement of cash flows\n(d) Notes to financial statements\n(e) Independent public accountant report\n(f) Computation of net capital\nFINRA 100,000 SEC 200,000 Other 300,000';
  const result = classify({ pages: [page(annualCover), page(checklist, 2), page('TABLE OF CONTENTS\nReport of independent auditors 3\nStatement of financial condition 4\nStatement of cash flows 5', 3)] });
  assert.equal(result.family, 'annual-report');
  assert.deepEqual(result.components, []);
  assert.equal(result.audit.status, 'not-established');
});

for (const part of ['II', 'IIA']) test(`Part ${part} distinguishes periodic FOCUS without presuming unaudited status`, () => {
  const result = classify({ pages: [page(`SECURITIES AND EXCHANGE COMMISSION\nFINANCIAL AND OPERATIONAL COMBINED UNIFORM SINGLE REPORT\nFORM X-17A-5\nPART ${part}\nFACING PAGE\nFILING FOR THE PERIOD BEGINNING 04/01/2026 AND ENDING 06/30/2026\nCheck here if respondent is filing an audited report`)] });
  assert.equal(result.family, 'periodic-focus');
  assert.equal(result.label, 'Periodic FOCUS report');
  assert.deepEqual(result.parts, [`Part ${part}`]);
  assert.equal(result.audit.status, 'not-established');
  assert.equal(result.period.frequency, 'quarterly');
});

test('periodic family, annual frequency, and actual audit status remain independent', () => {
  const result = classify({ pages: [page('FORM X-17A-5\nSCHEDULE I\nFILING FOR THE PERIOD BEGINNING 01/01/2025 AND ENDING 12/31/2025'), page(body, 2)] });
  assert.equal(result.family, 'periodic-focus');
  assert.deepEqual(result.parts, ['Schedule I']);
  assert.equal(result.period.frequency, 'annual');
  assert.equal(result.audit.status, 'auditor-report-present');
  assert.equal(result.label, 'Periodic FOCUS report');
});

test('explicit unaudited heading is distinct from usual assumptions about periodic reports', () => {
  const result = classify({ pages: [page('FORM X-17A-5\nPART IIA\nFACING PAGE\nUNAUDITED\nFILING FOR THE PERIOD BEGINNING 06/01/2026 AND ENDING 06/30/2026')] });
  assert.equal(result.family, 'periodic-focus');
  assert.equal(result.audit.status, 'explicitly-unaudited');
  assert.equal(result.period.frequency, 'monthly');
});

test('annual accountant name and full FOCUS title on Part III cover are not periodic or audit proof', () => {
  const result = classify({ pages: [page('FORM X-17A-5\nPART III\nFINANCIAL AND OPERATIONAL COMBINED UNIFORM SINGLE REPORT\nFACING PAGE\nINDEPENDENT PUBLIC ACCOUNTANT\nExample Accountant LLP')] });
  assert.equal(result.family, 'annual-report');
  assert.equal(result.audit.status, 'not-established');
  assert.deepEqual(result.parts, ['Part III']);
});

test('selected attachments are classified independently of another annual cover', () => {
  const shared = { filing: { part: 'Part III', reportDate: '2026-06-30' }, cover: { formPart: 'Part III', periodBegin: '2025-07-01', reportDate: '2026-06-30', accountantName: 'Example Audit LLP' } };
  const unknown = classify({ ...shared, selectedDocument: { name: 'exemption.pdf', description: 'Exemption Report' }, pages: [page('Exemption report\nThe Company claims an exemption from Rule 15c3-3.')] });
  assert.equal(unknown.family, 'unknown');
  assert.equal(unknown.audit.status, 'not-established');
  const periodic = classify({ ...shared, selectedDocument: document, pages: [page('FORM X-17A-5\nPART II\nFILING FOR THE PERIOD BEGINNING 01/01/2026 AND ENDING 03/31/2026')] });
  assert.equal(periodic.family, 'periodic-focus');
  assert.deepEqual(periodic.period, { start: '2026-01-01', end: '2026-03-31', frequency: 'quarterly' });
  const noDates = classify({ ...shared, selectedDocument: document, pages: [page('FORM X-17A-5\nPART II')] });
  assert.equal(noDates.period.end, '');
  assert.equal(noDates.period.frequency, 'unknown');
});

test('exact metadata part is supported but incidental mentions are not', () => {
  assert.equal(classify({ cover: { formPart: 'Part III' } }).family, 'annual-report');
  assert.equal(classify({ selectedDocument: { description: 'FORM X-17A-5 PART IIA' } }).family, 'periodic-focus');
  assert.equal(classify({ selectedDocument: { description: 'Notes discussing FOCUS Part II reconciliation' } }).family, 'unknown');
  assert.equal(classify({ selectedDocument: { description: 'Annual Audited Financial Statements' } }).audit.status, 'not-established');
});

test('auditor report alone cannot establish an annual family or annual duration', () => {
  const result = classify({ pages: [page(body), page(balance, 2), page(notes + ' Prior year ended June 30, 2025.', 3)] });
  assert.equal(result.family, 'unknown');
  assert.equal(result.audit.status, 'auditor-report-present');
  assert.equal(result.period.frequency, 'unknown');
});

test('auditor disclaimer is retained without the annual audited label', () => {
  const disclaimer = 'Independent Auditor\'s Report\nDisclaimer of Opinion\nWe were engaged to audit the accompanying financial statements of Example Securities LLC for the year ended June 30, 2026. We do not express an opinion on the financial statements.';
  const result = classify({ pages: [page(annualCover), page(disclaimer, 2)] });
  assert.equal(result.family, 'annual-report');
  assert.equal(result.audit.status, 'auditor-report-present');
  assert.equal(result.audit.scope, 'financial-statements');
  assert.equal(result.label, 'Annual report');
  assert.ok(result.limitations.some(message => /disclaimer of opinion/.test(message)));
});

test('compliance examination and auditor cover titles do not establish financial audit', () => {
  const result = classify({ pages: [page(annualCover), page('Independent Auditor\'s Report\nWe have examined the Company compliance report. In our opinion the compliance statements are fairly stated.', 2)] });
  assert.equal(result.audit.status, 'not-established');
  assert.equal(result.label, 'Annual report');
});

test('ASL overlapping headings and OCR Part llI are normalized without inventing absent statements', () => {
  const result = classify({ pages: [page(annualCover.replace('PART III', 'PART llI').replace('07/01/25', '07/01 /25')), page(body.replace('We have audited', 'We We have audited'), 5), page(balance.replace('STATEMENT OF FINANCIAL CONDITION', 'STATEMENT OF FINANCIAL CONDITION STATEMENT OF FINANCIAL CONDITION'), 6)] });
  assert.deepEqual(result.parts, ['Part III']);
  assert.equal(result.label, 'Annual audited report');
  assert.equal(result.period.frequency, 'annual');
  assert.ok(result.components.includes('financial-condition'));
  assert.ok(!result.components.includes('income'));
  assert.ok(!result.components.includes('cash-flows'));
});

test('mixed actual annual and periodic headings require document review', () => {
  const result = classify({ pages: [page(annualCover), page('FORM X-17A-5\nPART II', 7)] });
  assert.equal(result.family, 'unknown');
  assert.deepEqual(result.parts, ['Part III', 'Part II']);
  assert.ok(result.limitations.some(message => /both annual and periodic/.test(message)));
});

test('filing and signature dates never become reporting dates', () => {
  const result = classify({ filing: { filingDate: '2026-08-31', form: 'X-17A-5' }, pages: [page('FORM X-17A-5\nPART III\nSigned August 27, 2026')] });
  assert.equal(result.period.start, '');
  assert.equal(result.period.end, '');
  assert.equal(result.period.frequency, 'unknown');
});

test('periodic monthly duration overrides incompatible annual metadata and retains its stated end', () => {
  const result = classify({ selectedDocument: document, cover: { formPart: 'Part III', periodBegin: '2025-07-01', reportDate: '2026-06-30' }, pages: [page('FORM X-17A-5\nPART II\nFor the month ended December 31, 2025')] });
  assert.equal(result.family, 'periodic-focus');
  assert.deepEqual(result.period, { start: '', end: '2025-12-31', frequency: 'monthly' });
  assert.ok(result.evidence.some(item => item.kind === 'reporting-period' && item.excerpt.includes('month ended December 31, 2025')));
});

test('prior annual prose cannot classify a current periodic report as annual frequency', () => {
  const result = classify({ pages: [page('FORM X-17A-5\nPART II\nAs of June 30, 2026'), page(balance, 2), page(notes + ' The computation for the year ended December 31, 2025 was audited.', 3)] });
  assert.equal(result.family, 'periodic-focus');
  assert.equal(result.period.end, '2026-06-30');
  assert.equal(result.period.frequency, 'unknown');
});

test('matching annual cover fills a missing start without overriding selected document dates', () => {
  const result = classify({ selectedDocument: document, cover: { formPart: 'Part III', periodBegin: '2025-07-01', reportDate: '2026-06-30' }, pages: [page('FORM X-17A-5\nPART III'), page(balance, 2)] });
  assert.deepEqual(result.period, { start: '2025-07-01', end: '2026-06-30', frequency: 'annual' });
  const mismatched = classify({ selectedDocument: document, cover: { formPart: 'Part III', periodBegin: '2025-07-01', reportDate: '2026-06-30' }, pages: [page('FORM X-17A-5\nPART III'), page(balance.replace('JUNE 30, 2026', 'DECEMBER 31, 2025'), 2)] });
  assert.deepEqual(mismatched.period, { start: '', end: '2025-12-31', frequency: 'unknown' });
});

test('annual duration and actual auditor body establish annual family even without a Part III heading', () => {
  const result = classify({ selectedDocument: document, pages: [page(body.replace('as of June 30, 2026', 'for the year ended June 30, 2026'))] });
  assert.equal(result.family, 'annual-report');
  assert.equal(result.period.end, '2026-06-30');
  assert.equal(result.period.frequency, 'annual');
  assert.ok(result.evidence.some(item => item.kind === 'reporting-period'));
});

test('older combined facing page and oath establish Part III but not checklist contents', () => {
  const result = classify({ pages: [page(annualCover + '\nOATH OR AFFIRMATION\nThis filing contains (check all applicable boxes):\nStatement of cash flows\nReport of independent public accountant')] });
  assert.equal(result.family, 'annual-report');
  assert.deepEqual(result.parts, ['Part III']);
  assert.equal(result.period.frequency, 'annual');
  assert.deepEqual(result.components, []);
  assert.equal(result.audit.status, 'not-established');
});

test('an explicit structured formPart Roman numeral is distinct from a generic description', () => {
  assert.equal(classify({ cover: { formPart: 'III' } }).family, 'annual-report');
  assert.equal(classify({ selectedDocument: { part: 'IIA' } }).family, 'periodic-focus');
  assert.equal(classify({ selectedDocument: { description: 'III' } }).family, 'unknown');
});

// Observed text from Brean's scanned 2025 annual facing page. The visible PDF
// says Part III; OCR drops the last I and corrupts the date separators. Keeping
// this noisy source text prevents a dealer-specific correction from hiding the bug.
const annualOcrCover = `PUBLIC VERSION
SECURITIES AND EXCHANGE COMMISSION Expires: Nov. 30, 2026
Washington, D.C. 20549 Estimated average burden
hours per response: 12
ANNUAL REPORTS
FORM X-17A-5 8-40742
PART II
FACING PAGE
Information Required Pursuant to Rules 17a-5, 17a-12, and 18a-7 under the Securities Exchange Act of 1934
FILING FOR THE PERIOD BEGINNING 01 101 12025 AND ENDING 1 2/31 12025
MM/DD/YY MM/DD/YY
A. REGISTRANT IDENTIFICATION
TYPE OF REGISTRANT (check all applicable boxes):
Broker-dealer`;
const yearEndBody = body.replaceAll('June 30, 2026', 'December 31, 2025');
const yearEndBalance = balance.replaceAll('JUNE 30, 2026', 'DECEMBER 31, 2025');
const yearEndNotes = notes.replace('NOTES TO STATEMENT OF FINANCIAL CONDITION\n', 'NOTES TO STATEMENT OF FINANCIAL CONDITION\nFor the Year Ended December 31, 2025\n');
const noisyAnnualPages = method => [{ ...page(annualOcrCover), method }, page(yearEndBody, 5), page(yearEndBalance, 6), page(yearEndNotes, 7)];

test('observed annual-cover OCR Part II does not override corroborated annual report contents', () => {
  const result = classify({ selectedDocument: document, pages: noisyAnnualPages('ocr') });
  assert.equal(result.family, 'annual-report');
  assert.equal(result.label, 'Annual audited report');
  assert.deepEqual(result.parts, [], 'The missing third numeral is not invented');
  assert.equal(result.audit.status, 'auditor-report-present');
  assert.deepEqual(result.period, { start: '', end: '2025-12-31', frequency: 'annual' });
  assert.ok(result.evidence.some(item => item.kind === 'ambiguous-part' && item.page === 1 && item.excerpt.includes('PART II')));
  assert.ok(result.evidence.some(item => item.kind === 'reporting-period' && item.page === 7));
  assert.ok(result.limitations.some(item => /OCR part heading/.test(item)));
  assert.ok(!result.components.includes('operational-schedules'));
});

test('native annual/periodic conflicts cannot use the narrow OCR resolution', () => {
  const result = classify({ pages: noisyAnnualPages('native') });
  assert.equal(result.family, 'unknown');
  assert.deepEqual(result.parts, ['Part II']);
  assert.ok(!result.evidence.some(item => item.kind === 'ambiguous-part'));
});

test('OCR annual/periodic conflict needs actual auditor and financial-statement support', () => {
  for (const pages of [[{ ...page(annualOcrCover), method: 'ocr' }], [{ ...page(annualOcrCover), method: 'ocr' }, page(yearEndBody, 5)]]) {
    const result = classify({ pages });
    assert.equal(result.family, 'unknown');
    assert.deepEqual(result.parts, ['Part II']);
  }
});

test('audited annual-duration Part II stays periodic without conflicting annual template', () => {
  const result = classify({ pages: [{ ...page('FORM X-17A-5\nPART II\nFACING PAGE\nFILING FOR THE PERIOD BEGINNING 01/01/2025 AND ENDING 12/31/2025'), method: 'ocr' }, page(yearEndBody, 5), page(yearEndBalance, 6)] });
  assert.equal(result.family, 'periodic-focus');
  assert.deepEqual(result.parts, ['Part II']);
  assert.equal(result.audit.status, 'auditor-report-present');
  assert.equal(result.period.frequency, 'annual');
});

test('a separate genuine periodic heading still prevents mixed-file annual classification', () => {
  const result = classify({ pages: [...noisyAnnualPages('ocr'), { ...page('FORM X-17A-5\nPART II\nFOCUS REPORT', 8), method: 'native' }] });
  assert.equal(result.family, 'unknown');
  assert.deepEqual(result.parts, ['Part II']);
  assert.ok(result.evidence.some(item => item.kind === 'part' && item.page === 8));
});

test('verified matching XML range supplies exact dates after ambiguous annual-cover OCR', () => {
  const result = classify({ selectedDocument: document, cover: { periodBegin: '2025-01-01', reportDate: '2025-12-31' }, pages: noisyAnnualPages('ocr') });
  assert.equal(result.family, 'annual-report');
  assert.deepEqual(result.period, { start: '2025-01-01', end: '2025-12-31', frequency: 'annual' });
});
