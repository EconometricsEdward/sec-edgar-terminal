import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { normalizeHoldingCompanyRequest, parseScheduleIssuer, resolveHoldingCompanyEvidence } from '../src/utils/thirteenFCompanyIdentity.js';
import { createThirteenFCompanyIdentityLoader, THIRTEEN_F_ISSUER_EVIDENCE_CACHE_TYPE } from '../src/utils/thirteenFCompanyIdentityServer.js';

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


function sharedEvidenceStore() {
  const entries = new Map(), writes = [];
  return { entries, writes, cacheEnabled: () => true,
    readEvidence: async (type, id, options) => {
      assert.equal(type, THIRTEEN_F_ISSUER_EVIDENCE_CACHE_TYPE);
      assert.ok(options.timeoutMs <= 1500 && options.deadline <= Date.now() + 1500);
      return entries.has(id) ? { payload: structuredClone(entries.get(id)) } : null;
    },
    writeEvidence: async (type, id, value, ttl, options) => {
      assert.equal(type, THIRTEEN_F_ISSUER_EVIDENCE_CACHE_TYPE);
      assert.ok(options.timeoutMs <= 1500 && options.deadline <= Date.now() + 1500);
      assert.ok(ttl > 0 && ttl <= 6 * 3600);
      assert.equal(options.expiresAt, value.expiresAt);
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024);
      writes.push({ id, value: structuredClone(value), ttl, expiresAt: options.expiresAt });
      entries.set(id, structuredClone(value));
      return { stored: true };
    },
  };
}
const freshIdentityLoader = (options = {}) => createThirteenFCompanyIdentityLoader({ now: () => NOW,
  fetchSec: async url => response(url.includes('search-index') ? search([hit()]) : xml()),
  companyLoader: async () => company, ...options });
const resignEvidence = value => { value.integrity = createHash('sha256').update(JSON.stringify([value.schemaVersion, value.cusip, value.observedAt, value.expiresAt, value.evidence, value.coverage])).digest('hex'); return value; };

test('verified issuer evidence survives a cold loader without repeating SEC search and XML downloads', async () => {
  const store = sharedEvidenceStore();
  const first = await freshIdentityLoader(store)(holding, { period: '2026-06-30' });
  assert.equal(first.status, 'resolved');
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].value.observedAt, new Date(NOW).toISOString());
  assert.equal(store.writes[0].expiresAt, new Date(NOW + 6 * 3600000).toISOString());
  let companies = 0;
  const second = freshIdentityLoader({ ...store, now: () => NOW + 3600000,
    fetchSec: async () => { throw new Error('fresh shared proof must not repeat SEC ownership searches'); },
    companyLoader: async cik => { companies++; assert.equal(cik, company.cik); return company; },
  });
  const cached = await second(holding, { period: '2026-06-30' });
  assert.equal(cached.status, 'resolved');
  assert.equal(cached.observedAt, first.observedAt);
  assert.equal(companies, 1, 'shared evidence still requires issuer submissions verification');
  assert.equal(store.writes.length, 1, 'reading shared evidence never renews its observation or storage expiry');
  const conflict = await second({ ...holding, issuer: 'ANOTHER COMPANY INC' });
  assert.equal(conflict.code, 'ISSUER_NAME_CONFLICT');
  assert.equal(companies, 1, 'holding name checks rerun before company retrieval');
  assert.equal((await second({ ...holding, classTitle: 'PREFERRED STOCK' })).code, 'SECURITY_CLASS_CONFLICT');
});

test('shared proof restores only its remaining lifetime in the local cache', async () => {
  const store = sharedEvidenceStore();
  await freshIdentityLoader(store)(holding);
  let current = NOW + 5 * 3600000, searches = 0;
  const loader = freshIdentityLoader({ ...store, now: () => current,
    fetchSec: async url => { if (url.includes('search-index')) searches++; return response(url.includes('search-index') ? search([hit()]) : xml()); },
  });
  assert.equal((await loader(holding)).observedAt, new Date(NOW).toISOString());
  assert.equal(searches, 0);
  current = NOW + 6 * 3600000 + 1;
  assert.equal((await loader(holding)).observedAt, new Date(current).toISOString());
  assert.equal(searches, 1, 'an hour-old local hit cannot restart the six-hour shared freshness window');
});

test('shared evidence rejects corrupt, mismatched, future, expired, oversized and unbound source records', async () => {
  const seed = sharedEvidenceStore();
  await freshIdentityLoader(seed)(holding);
  const original = seed.entries.get(holding.cusip);
  const cases = [
    value => { value.evidence[0].name = 'UNRELATED ISSUER'; },
    value => { value.cusip = '67066G104'; resignEvidence(value); },
    value => { value.observedAt = new Date(NOW + 1).toISOString(); value.expiresAt = new Date(NOW + 3600000).toISOString(); resignEvidence(value); },
    value => { value.observedAt = new Date(NOW - 6 * 3600000).toISOString(); value.expiresAt = new Date(NOW).toISOString(); resignEvidence(value); },
    value => { value.expiresAt = new Date(NOW + 7 * 3600000).toISOString(); resignEvidence(value); },
    value => { value.evidence[0].url = value.evidence[0].url.replace('www.sec.gov', 'attacker.example'); resignEvidence(value); },
    value => { value.evidence[0].accession = '0002012383-26-999999'; resignEvidence(value); },
    value => { value.evidence[0].sourceUrl = 'https://www.sec.gov/unrelated'; resignEvidence(value); },
    value => { value.evidence[0].indexUrl = 'https://www.sec.gov/unrelated'; resignEvidence(value); },
    value => { value.evidence[0].cusips = ['67066G104']; resignEvidence(value); },
    value => { value.coverage.matchingDocuments = 2; resignEvidence(value); },
    value => { value.oversized = 'x'.repeat(128 * 1024); },
  ];
  for (const mutate of cases) {
    const store = sharedEvidenceStore(), value = structuredClone(original);
    mutate(value); store.entries.set(holding.cusip, value);
    let searches = 0;
    const loader = freshIdentityLoader({ ...store, fetchSec: async url => {
      if (url.includes('search-index')) searches++;
      return response(url.includes('search-index') ? search([hit()]) : xml());
    } });
    assert.equal((await loader(holding)).status, 'resolved');
    assert.equal(searches, 1, `rejected ${mutate}`);
    assert.equal(store.writes.length, 1);
  }
});

test('failed, conflicting, unmatched or unverified issuer discovery never publishes shared evidence', async () => {
  const cases = [
    { fetchSec: async url => response(url.includes('search-index') ? search([]) : xml()) },
    { fetchSec: async url => response(url.includes('search-index') ? search([hit()]) : xml({ name: 'UNRELATED INC' })) },
    { fetchSec: async url => response(url.includes('search-index') ? search([hit()]) : xml({ cusip: '67066G104' })) },
    { fetchSec: async url => url.includes('search-index') ? response(search([hit()])) : response('busy', 503) },
    { companyLoader: async () => ({ ...company, cik: '0002012383' }) },
    { companyLoader: async () => ({ ...company, filings: [{ form: 'NPORT-P' }] }) },
    { fetchSec: async url => response(url.includes('search-index')
      ? search([hit(), hit({ accession: '0002012383-26-001751', ciks: ['0000000001', '0002012383'] })])
      : url.includes('/data/1/') ? xml({ cik: '0000000001' }) : xml()) },
  ];
  for (const options of cases) {
    const store = sharedEvidenceStore();
    const result = await freshIdentityLoader({ ...store, ...options })(holding).catch(() => null);
    assert.notEqual(result?.status, 'resolved');
    assert.equal(store.writes.length, 0);
  }
});

test('complete bounded searches and valid CUSIP special characters remain shareable', async () => {
  for (const cusip of ['565394103', '56539410*', '56539410@', '56539410#']) {
    const store = sharedEvidenceStore();
    const loader = freshIdentityLoader({ ...store, fetchSec: async url => response(url.includes('search-index') ? search([hit()], 1000) : xml({ cusip })) });
    const result = await loader({ ...holding, cusip });
    assert.equal(result.status, 'resolved');
    assert.equal(result.coverage.bounded, true);
    assert.equal(store.writes.length, 1);
    assert.equal(store.writes[0].id, cusip);
  }
});

test('slow or failing optional shared reads and writes retain a bounded SEC fallback', async () => {
  for (const phase of ['readEvidence', 'writeEvidence']) {
    const store = sharedEvidenceStore();
    let expired = false, finished = false;
    const loader = freshIdentityLoader({ ...store, cacheIoMs: 5,
      [phase]: async (...args) => {
        const options = args.at(-1);
        options.signal.addEventListener('abort', () => { expired = true; }, { once: true });
        await new Promise(resolve => setTimeout(resolve, 40));
        finished = true;
        throw new Error('slow optional storage');
      },
    });
    assert.equal((await loader(holding)).status, 'resolved');
    assert.equal(expired, true);
    assert.equal(finished, false, 'research does not wait for optional storage beyond its deadline');
  }
  const store = sharedEvidenceStore();
  assert.equal((await freshIdentityLoader({ ...store, readEvidence: async () => { throw new Error('cache outage'); }, writeEvidence: async () => { throw new Error('cache outage'); } })(holding)).status, 'resolved');
});

function deferredIdentityResponse() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('aborting the sole issuer consumer cancels its SEC request and permits a fresh retry', async () => {
  const started = deferredIdentityResponse(), controller = new AbortController();
  let searches = 0, sourceSignal;
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW, cacheEnabled: () => false,
    fetchSec: async (_url, { signal }) => {
      searches++;
      if (searches > 1) return response(search([]));
      sourceSignal = signal; started.resolve();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, companyLoader: async () => { throw new Error('An unmatched issuer cannot load company data'); },
  });
  const request = loader(holding, { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await started.promise; controller.abort(); await rejected;
  assert.equal(sourceSignal.aborted, true);
  assert.equal((await loader(holding)).status, 'unresolved');
  assert.equal(searches, 2);
});

test('one cancelled consumer does not abort shared issuer evidence needed by another', async () => {
  const started = deferredIdentityResponse(), waiting = deferredIdentityResponse();
  const firstController = new AbortController(), survivorController = new AbortController();
  let sourceSignal, searches = 0;
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW, cacheEnabled: () => false,
    fetchSec: async (_url, { signal }) => { searches++; sourceSignal = signal; started.resolve(); return waiting.promise; },
    companyLoader: async () => { throw new Error('An unmatched issuer cannot load company data'); },
  });
  const first = loader(holding, { signal: firstController.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await started.promise;
  const survivor = loader({ ...holding, putCall: 'PUT' }, { signal: survivorController.signal });
  firstController.abort(); await rejected;
  assert.equal(sourceSignal.aborted, false);
  waiting.resolve(response(search([])));
  assert.equal((await survivor).status, 'unresolved');
  assert.equal(searches, 1);
});

test('late cleanup from aborted issuer work cannot delete a newer shared retry or publish stale evidence', async () => {
  const started = [deferredIdentityResponse(), deferredIdentityResponse()];
  const waiting = [deferredIdentityResponse(), deferredIdentityResponse()];
  const controller = new AbortController();
  let searches = 0;
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW, cacheEnabled: () => false,
    fetchSec: async () => {
      const index = searches++;
      assert.ok(index < 2, 'a concurrent visitor must join the newer retry');
      started[index].resolve(); return waiting[index].promise;
    }, companyLoader: async () => { throw new Error('An unmatched issuer cannot load company data'); },
  });
  const first = loader(holding, { signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await started[0].promise; controller.abort(); await rejected;
  const second = loader(holding);
  await started[1].promise;
  // Simulate a transport that acknowledges cancellation late. The newer entry
  // must survive its cleanup, and the abandoned empty search cannot be cached.
  waiting[0].resolve(response(search([])));
  await new Promise(resolve => setImmediate(resolve));
  const third = loader(holding);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(searches, 2);
  waiting[1].resolve(response(search([], 7)));
  const results = await Promise.all([second, third]);
  assert.ok(results.every(result => result.coverage.indexedMatches === 7));
});

test('last-consumer cancellation during shared-cache lookup cannot start a SEC fallback', async () => {
  const started = deferredIdentityResponse(), controller = new AbortController();
  let sources = 0, cacheSignal;
  const loader = createThirteenFCompanyIdentityLoader({ now: () => NOW, cacheEnabled: () => true,
    readEvidence: async (_type, _cusip, { signal }) => {
      cacheSignal = signal; started.resolve();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, fetchSec: async () => { sources++; return response(search([])); },
  });
  const request = loader(holding, { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await started.promise; controller.abort(); await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cacheSignal.aborted, true); assert.equal(sources, 0);
});
