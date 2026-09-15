import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHoldingCompanyRequest, parseScheduleIssuer, resolveHoldingCompanyEvidence } from '../src/utils/thirteenFCompanyIdentity.js';
import { createThirteenFCompanyIdentityLoader } from '../src/utils/thirteenFCompanyIdentityServer.js';

const NOW = Date.parse('2026-09-15T12:00:00Z');
const holding = { issuer: 'MAPLEBEAR INC', classTitle: 'COM', cusip: '565394103', quantityType: 'SH', putCall: null };
const expected = { form: 'SCHEDULE 13G/A', filingDate: '2026-04-27', ciks: ['0001579091', '0002012383'] };
// Minimal structured covers preserve the SEC X01/X02 nesting and distinction
// between an issuer and BlackRock's reporting-person CIK.
function xml({ kind = 'G', old = false, cik = '0001579091', cusip = '565394103', name = 'MAPLEBEAR INC', classTitle = 'Common Stock', event = '03/31/2026', extra = '' } = {}) {
  return `<?xml version="1.0"?><edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13${kind}"><headerData><submissionType>SCHEDULE 13${kind}/A</submissionType><filerInfo><filer><filerCredentials><cik>0002012383</cik></filerCredentials></filer></filerInfo></headerData><formData><coverPageHeader><securitiesClassTitle>${classTitle}</securitiesClassTitle><${kind === 'D' ? 'dateOfEvent' : 'eventDateRequiresFilingThisStatement'}>${event}</${kind === 'D' ? 'dateOfEvent' : 'eventDateRequiresFilingThisStatement'}><issuerInfo><${kind === 'D' ? 'issuerCIK' : 'issuerCik'}>${cik}</${kind === 'D' ? 'issuerCIK' : 'issuerCik'}><issuerName>${name}</issuerName>${old ? `<${kind === 'D' ? 'issuerCUSIP' : 'issuerCusip'}>${cusip}</${kind === 'D' ? 'issuerCUSIP' : 'issuerCusip'}>` : `<issuerCusips><issuerCusipNumber>${cusip}</issuerCusipNumber></issuerCusips>`}${extra}</issuerInfo></coverPageHeader><items><item1><issuerName>Unrelated free-text name</issuerName></item1></items></formData></edgarSubmission>`;
}
const proof = (overrides = {}) => ({ ...parseScheduleIssuer(xml(), expected), ...overrides });
const resolve = (rows, item = holding, period = '2026-06-30') => resolveHoldingCompanyEvidence(item, rows, { period, now: NOW });

test('X01 and X02 ownership covers identify the issuer, never the reporting person', () => {
  for (const kind of ['G', 'D']) for (const old of [true, false]) {
    const row = parseScheduleIssuer(xml({ kind, old }), { ...expected, form: `SCHEDULE 13${kind}/A` });
    assert.equal(row.cik, '0001579091');
    assert.notEqual(row.cik, '0002012383');
    assert.equal(row.name, 'MAPLEBEAR INC');
    assert.deepEqual(row.cusips, ['565394103']);
    assert.equal(row.eventDate, '2026-03-31');
  }
});

test('ownership parser rejects wrong forms, dates, CIK metadata and duplicate identity fields', () => {
  assert.throws(() => parseScheduleIssuer(xml(), { ...expected, form: '13F-HR' }));
  assert.throws(() => parseScheduleIssuer(xml(), { ...expected, ciks: ['0002012383'] }));
  assert.throws(() => parseScheduleIssuer(xml({ event: '06/30/2026' }), expected));
  assert.throws(() => parseScheduleIssuer(xml({ event: '02/31/2026' }), expected));
  assert.throws(() => parseScheduleIssuer(xml({ extra: '<issuerCik>0002012383</issuerCik>' }), expected));
  assert.throws(() => parseScheduleIssuer(xml({ extra: '<issuerCusip>67066G104</issuerCusip>' }), expected));
});

test('bounded non-expanding XML parsing rejects entity declarations and false nested evidence', () => {
  assert.throws(() => parseScheduleIssuer(xml().replace('<edgarSubmission', '<!DOCTYPE a [<!ENTITY foo SYSTEM "file:///secret">]><edgarSubmission'), expected));
  assert.throws(() => parseScheduleIssuer(xml().replace('MAPLEBEAR INC', '<issuerCik>0001579091</issuerCik>'), expected));
  assert.throws(() => parseScheduleIssuer(`${xml()}${xml()}`, expected));
  assert.throws(() => parseScheduleIssuer(xml().replace('</issuerCik>', '</bad:issuerCik>'), expected));
  assert.throws(() => parseScheduleIssuer('x'.repeat(2 * 1024 * 1024 + 1), expected));
});

test('exact security identifier and corroborating class/name establish company identity', () => {
  const result = resolve([proof()]);
  assert.equal(result.status, 'resolved');
  assert.equal(result.issuer.cik, '0001579091');
  assert.equal(result.issuer.ticker, undefined);
  assert.equal(resolve([proof({ cusips: ['67066G104'] })]).code, 'NO_VERIFIED_IDENTITY');
  assert.equal(resolve([]).code, 'NO_VERIFIED_IDENTITY');
  assert.equal(resolve([proof({ name: 'MAPLEBEAR FINANCIAL HOLDINGS INC' })]).code, 'ISSUER_NAME_CONFLICT');
  assert.equal(resolve([proof({ name: 'OTHER ISSUER INC' })]).code, 'ISSUER_NAME_CONFLICT');
  assert.equal(resolve([proof({ classTitle: 'Class B Common Stock' })], { ...holding, classTitle: 'CL A' }).code, 'SECURITY_CLASS_CONFLICT');
  assert.equal(resolve([proof({ classTitle: 'Preferred Stock' })]).code, 'SECURITY_CLASS_CONFLICT');
  assert.equal(resolve([proof({ classTitle: 'Class A Common Stock, Class B Common Stock' })], { ...holding, classTitle: 'CL B' }).status, 'resolved');
});

test('conflicting issuer CIKs and stale historical security evidence remain unresolved', () => {
  assert.equal(resolve([proof(), proof({ cik: '0000000001' })]).code, 'AMBIGUOUS_IDENTITY');
  assert.equal(resolve([proof({ filingDate: '2022-04-27', eventDate: '2022-03-31' })]).code, 'STALE_IDENTITY');
  assert.equal(resolve([proof()], holding, '2018-06-30').code, 'STALE_IDENTITY');
  assert.equal(resolve([proof({ filingDate: '2027-01-01' })]).code, 'INVALID_EVIDENCE');
});

// SEC structured cover examples for these reported 13F spelling variants:
// Coca-Cola Co/The: /data/21344/000210011926000313/xslSCHEDULE_13G_X02/primary_doc.xml
// Moody's Corporation: /data/1059556/000090266426002468/xslSCHEDULE_13G_X02/primary_doc.xml
// Occidental Petroleum Corp: /data/797468/000210011926000971/xslSCHEDULE_13G_X02/primary_doc.xml
const issuerNameCases = [
  { issuer: 'COCA COLA CO', names: ['Coca-Cola Co/The', 'The Coca-Cola Company'], cik: '0000021344', cusip: '191216100' },
  { issuer: 'MOODYS CORP', names: ["Moody's Corporation", 'Moody’s Corporation', 'Moody`s Corporation'], cik: '0001059556', cusip: '615369105' },
  { issuer: 'OCCIDENTAL PETE CORP', names: ['Occidental Petroleum Corp', 'OCCIDENTAL PETROLEUM CORPORATION'], cik: '0000797468', cusip: '674599105' },
];

test('SEC boundary articles, possessive punctuation and PETE abbreviations corroborate exact issuer proof', () => {
  for (const item of issuerNameCases) for (const name of item.names) {
    const parsed = parseScheduleIssuer(xml({ name, cik: item.cik, cusip: item.cusip }), { ...expected, ciks: [item.cik, '0002012383'] });
    const result = resolve([parsed], { ...holding, issuer: item.issuer, cusip: item.cusip });
    assert.equal(result.status, 'resolved', `${item.issuer} / ${name}`);
    assert.equal(result.issuer.cik, item.cik);
  }
});

test('issuer spelling normalization never substitutes names for exact CUSIP, unique CIK or compatible share class', () => {
  for (const item of issuerNameCases) {
    const position = { ...holding, issuer: item.issuer, cusip: item.cusip };
    const evidence = proof({ name: item.names[0], cik: item.cik, cusips: [item.cusip] });
    assert.equal(resolve([], position).code, 'NO_VERIFIED_IDENTITY');
    assert.equal(resolve([{ ...evidence, cusips: ['565394103'] }], position).code, 'NO_VERIFIED_IDENTITY');
    assert.equal(resolve([evidence, { ...evidence, cik: '0000000001' }], position).code, 'AMBIGUOUS_IDENTITY');
    assert.equal(resolve([{ ...evidence, classTitle: 'Class B Common Stock' }], { ...position, classTitle: 'CL A' }).code, 'SECURITY_CLASS_CONFLICT');
  }
});

test('normalization preserves other issuer words, corporate distinctions and distinctive first names', () => {
  const conflicts = [
    ['COCA COLA CO', 'The Coca-Cola Bottling Company'],
    ['COCA COLA CO', 'Coca-Cola Europacific Partners'],
    ['MOODYS CORP', "Moody's Analytics Inc."],
    ['OCCIDENTAL PETE CORP', 'Occidental Petrochemicals Corporation'],
    ['OCCIDENTAL PETE CORP', 'Occidental Petroleum Resources Corporation'],
    ['PETE CORP', 'Petroleum Corporation'],
    ['THEATER CORP', 'Ater Corporation'],
  ];
  for (const [issuer, name] of conflicts) assert.equal(resolve([proof({ name })], { ...holding, issuer }).code, 'ISSUER_NAME_CONFLICT', `${issuer} / ${name}`);
});

test('options and depositary receipts keep their security semantics; funds and principal do not become operating stocks', () => {
  const option = resolve([proof()], { ...holding, putCall: 'CALL' });
  assert.equal(option.status, 'resolved');
  assert.equal(option.securityType, 'option');
  assert.match(option.reason, /underlying company/);
  const adr = resolve([proof()], { ...holding, classTitle: 'SPONSORED ADR' });
  assert.equal(adr.securityType, 'depositary_receipt');
  assert.match(adr.reason, /receipt/);
  assert.equal(resolve([], { ...holding, issuer: 'ISHARES TRUST', classTitle: 'CORE S&P500 ETF' }).code, 'FUND_SECURITY');
  assert.equal(resolve([], { ...holding, quantityType: 'PRN' }).code, 'PRINCIPAL_SECURITY');
});

test('public holding identity inputs cannot inject search syntax or SEC paths', () => {
  for (const cusip of ['565394103" OR *', '../secret', '000000000', '', '1234567890']) assert.throws(() => normalizeHoldingCompanyRequest({ ...holding, cusip }), { status: 400 });
  assert.throws(() => normalizeHoldingCompanyRequest({ ...holding, issuer: '<script>' }), { status: 400 });
  assert.throws(() => normalizeHoldingCompanyRequest({ ...holding, quantityType: 'USD' }), { status: 400 });
  assert.throws(() => normalizeHoldingCompanyRequest(holding, { period: '2026-02-31' }), { status: 400 });
  assert.throws(() => normalizeHoldingCompanyRequest(holding, { period: '2026-04-01' }), { status: 400 });
});

function hit({ accession = '0002012383-26-001750', form = 'SCHEDULE 13G/A', ciks = ['0001579091', '0002012383'], name = 'primary_doc.xml', sequence = 1, date = '2026-04-27' } = {}) {
  return { _id: `${accession}:${name}`, _source: { adsh: accession, form, ciks, sequence, file_date: date, xsl: 'xslSCHEDULE_13G_X02' } };
}
const search = (hits, total = hits.length) => ({ timed_out: false, _shards: { failed: 0 }, hits: { hits, total: { value: total, relation: 'eq' } } });
const company = { cik: '0001579091', name: 'Maplebear Inc.', tickers: ['CART'], kind: 'filer', filings: [{ form: '10-K' }], sic: '7389', sicDescription: 'Business services' };
const response = (value, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });

test('SEC resolver checks exact CUSIP in the primary cover and then loads that issuer CIK', async () => {
  const urls = [], companies = [];
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW,
    fetchSec: async (url, options) => { urls.push(url); assert.equal(options.maxBytes, 2 * 1024 * 1024); return response(url.includes('search-index') ? search([hit()]) : xml()); },
    companyLoader: async cik => { companies.push(cik); return company; },
  });
  const result = await loader(holding, { period: '2026-06-30' });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.issuer.tickers, ['CART']);
  assert.deepEqual(companies, ['0001579091']);
  assert.equal(new URL(urls[0]).searchParams.get('q'), '"565394103"');
  assert.equal(new URL(urls[0]).searchParams.get('forms'), 'SCHEDULE 13G,SCHEDULE 13D');
  assert.equal(result.evidence[0].url, 'https://www.sec.gov/Archives/edgar/data/1579091/000201238326001750/primary_doc.xml');
  assert.match(result.evidence[0].sourceUrl, /xslSCHEDULE_13G_X02\/primary_doc.xml$/);
  assert.equal(result.coverage.documentsChecked, 1);
  await loader({ ...holding, putCall: 'PUT' }, { period: '2026-03-31' });
  assert.equal(urls.length, 2, 'SEC proof is shared by CUSIP across dates and option rows');
});

test('issuer aliases stay separate for multiple trading classes', async () => {
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW,
    fetchSec: async url => response(url.includes('search-index') ? search([hit()]) : xml()),
    companyLoader: async () => ({ ...company, tickers: ['CLASSA', 'CLASSB'] }),
  });
  const result = await loader(holding);
  assert.deepEqual(result.issuer.tickers, ['CLASSA', 'CLASSB']);
  assert.equal(result.issuer.ticker, undefined);
});

test('no exact cover match and fund issuer never trigger unrelated company financials', async () => {
  let companies = 0;
  const noMatch = createThirteenFCompanyIdentityLoader({ now: () => NOW,
    fetchSec: async url => response(url.includes('search-index') ? search([hit()]) : xml({ cusip: '67066G104' })),
    companyLoader: async () => { companies++; return company; },
  });
  assert.equal((await noMatch(holding)).code, 'NO_VERIFIED_IDENTITY');
  assert.equal(companies, 0);
  const fund = createThirteenFCompanyIdentityLoader({ now: () => NOW,
    fetchSec: async url => response(url.includes('search-index') ? search([hit()]) : xml()),
    companyLoader: async () => ({ ...company, filings: [{ form: 'NPORT-P' }] }),
  });
  assert.equal((await fund(holding)).code, 'FUND_ISSUER');
});

test('partial SEC failures are retryable and never cached as a no-match', async () => {
  let fail = true, searches = 0;
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW,
    fetchSec: async url => { if (url.includes('search-index')) { searches++; return response(search([hit()])); } return fail ? response('busy', 503) : response(xml()); },
    companyLoader: async () => company,
  });
  await assert.rejects(loader(holding), /could not be verified/);
  fail = false;
  assert.equal((await loader(holding)).status, 'resolved');
  assert.equal(searches, 2);
});

test('malformed search metadata, incomplete shards and oversized responses are rejected', async () => {
  for (const payload of [search([hit({ ciks: ['../../etc'] })]), search([hit({ form: '13F-HR' })]), { ...search([hit()]), _shards: { failed: 1 } }, { ...search([hit()]), timed_out: true }]) {
    const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW, fetchSec: async () => response(payload), companyLoader: async () => company });
    await assert.rejects(loader(holding));
  }
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW, fetchSec: async () => response('x'.repeat(2 * 1024 * 1024 + 1)), companyLoader: async () => company });
  await assert.rejects(loader(holding), /supported document size/);
});

test('exhibits and path-traversal filenames never qualify as primary ownership proof', async () => {
  let calls = 0;
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW,
    fetchSec: async () => { calls++; return response(search([hit({ sequence: 2 }), hit({ name: '../primary_doc.xml' })])); },
    companyLoader: async () => { throw new Error('must not load issuer'); },
  });
  assert.equal((await loader(holding)).status, 'unresolved');
  assert.equal(calls, 1);
});

test('source processing is bounded and independent issuer locations are checked for conflicts', async () => {
  const hits = Array.from({ length: 10 }, (_, i) => hit({ accession: `0002012383-26-${String(i + 1).padStart(6, '0')}` }));
  hits.push(hit({ accession: '0002012383-26-000011', ciks: ['0000000001', '0002012383'], date: '2026-03-01' }));
  let documents = 0;
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW,
    fetchSec: async url => { if (url.includes('search-index')) return response(search(hits)); documents++; return response(url.includes('/data/1/') ? xml({ cik: '0000000001', event: '02/28/2026' }) : xml()); },
    companyLoader: async () => { throw new Error('ambiguous evidence must not load company'); },
  });
  assert.equal((await loader(holding)).code, 'AMBIGUOUS_IDENTITY');
  assert.equal(documents, 4);
});

test('issuer submission response must preserve the exact verified CIK', async () => {
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW,
    fetchSec: async url => response(url.includes('search-index') ? search([hit()]) : xml()),
    companyLoader: async () => ({ ...company, cik: '0002012383' }),
  });
  await assert.rejects(loader(holding), /did not match/);
});
