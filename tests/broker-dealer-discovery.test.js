import test from 'node:test';
import assert from 'node:assert/strict';
import { isBrokerDealerForm, normalizeBrokerDealerForm, brokerDealerFormDescription } from '../src/utils/brokerDealerForms.js';
import { filingFamily, normalizeFilingRows, filterFilings, selectFilingBaseline } from '../src/utils/filingsResearch.js';
import { createSecFilerSearch } from '../src/utils/secFilerSearchServer.js';
import { secFilerResearchPath, hasBrokerDealerFilings } from '../src/utils/secFilerSearch.js';
import { rankGlobalFilerMatches } from '../src/utils/globalFilerMatches.js';
import { buildGlobalSearch } from '../src/utils/globalSearchEngine.js';
import { routeSearch } from '../src/utils/searchRouter.js';

const cik = '0000001001';
const filer = { cik, name: 'Example Securities LLC', formTypes: ['X-17A-5'] };
const map = { AAPL: { ticker: 'AAPL', cik: '0000320193', name: 'Apple Inc.', isFund: false } };
const report = (number, form, filingDate, reportDate) => ({ accession: `0000001001-26-${String(number).padStart(6, '0')}`, form, filingDate, reportDate, primaryDoc: 'public.pdf' });
const page = hits => ({ hits: { total: { value: hits.length, relation: 'eq' }, hits } });
const hit = (id, name, form) => ({ _source: { ciks: [id], display_names: [`${name}  (CIK ${id})`], form } });

test('broker-dealer form aliases identify a neutral family without establishing report type', () => {
  for (const form of ['X-17A-5', 'x17a5', 'Form X 17A 5', 'broker dealer annual reports']) {
    assert.equal(normalizeBrokerDealerForm(form), 'X-17A-5');
    assert.equal(filingFamily(form), 'broker-dealer');
  }
  assert.equal(normalizeBrokerDealerForm('x-17a-5/a'), 'X-17A-5/A');
  assert.match(brokerDealerFormDescription('X-17A-5/A'), /Broker-dealer report amendment/);
  for (const form of ['FOCUS', '17a-5', 'FOCUS Part II', 'X-17A-5 EXHIBIT', '10-K', 'X-17A-5\n']) assert.equal(isBrokerDealerForm(form), false, form);
});

test('metadata-only broker-dealer rows remain unclassified and preserve sources and amendment filters', () => {
  const reports = [report(1, 'X-17A-5', '2026-03-02', ''), report(2, 'X-17A-5/A', '2026-08-19', '2023-09-30'), report(3, '10-K', '2026-03-01', '2025-12-31')];
  const rows = normalizeFilingRows({ accessionNumber: reports.map(row => row.accession), form: reports.map(row => row.form), filingDate: reports.map(row => row.filingDate), reportDate: reports.map(row => row.reportDate), primaryDocument: reports.map(row => row.primaryDoc) }, cik);
  assert.equal(rows.find(row => row.accession === reports[0].accession).reportDate, '', 'A filing year never becomes a reporting period');
  assert.equal(rows[0].brokerDealer, true);
  assert.equal(rows[0].classification.family, 'unknown');
  assert.equal(filterFilings(rows, { family: 'annual' }).length, 1, 'X-17A-5 is not automatically an annual report');
  assert.equal(filterFilings(rows, { family: 'broker-dealer' }).length, 2);
  assert.match(rows[0].formLabel, /Broker-dealer report amendment/);
  assert.match(rows[0].documentUrl, /public\.pdf$/);
  assert.equal(filterFilings(rows, { form: 'x17a5' }).length, 2);
  assert.equal(filterFilings(rows, { form: 'X-17A-5', amendments: 'exclude' }).length, 1);
  assert.equal(filterFilings(rows, { form: 'X-17A-5', amendments: 'only' })[0].form, 'X-17A-5/A');
  assert.equal(filterFilings(rows, { form: 'X-17A-5/A' }).length, 1);
  assert.equal(filterFilings(rows, { query: 'broker dealer annual report' }).length, 2);
  assert.equal(filterFilings(rows, { query: 'broker dealer annual reports' }).length, 2);
  assert.equal(filterFilings(rows, { query: 'x17a5' }).length, 2);
  assert.equal(filterFilings(rows, { form: '10-K' }).length, 1);
});

test('annual comparisons use verified prior-year fiscal periods and same-period originals for late amendments', () => {
  const current = report(5, 'X-17A-5', '2026-08-28', '2026-06-30');
  const prior = report(2, 'X-17A-5', '2025-08-28', '2025-06-30');
  const halfYear = report(3, 'X-17A-5', '2026-03-01', '2025-12-31');
  const original = report(1, 'X-17A-5', '2023-11-30', '2023-09-30');
  const earlierAmendment = report(4, 'X-17A-5/A', '2026-07-30', '2023-09-30');
  const lateAmendment = report(6, 'X-17A-5/A', '2026-09-01', '2023-09-30');
  const reports = [current, prior, halfYear, original, earlierAmendment, lateAmendment];
  assert.equal(selectFilingBaseline(current, reports).prior, null, 'Raw form metadata cannot establish comparable document types');
  reports.forEach(row => { row.classification = { family: 'annual-report', period: { frequency: 'annual' } }; });
  assert.equal(selectFilingBaseline(current, reports).prior, prior);
  assert.equal(selectFilingBaseline(lateAmendment, reports).prior, original);
  assert.equal(selectFilingBaseline({ ...current, reportDate: '' }, reports).prior, null);
  assert.equal(selectFilingBaseline({ ...lateAmendment, reportDate: '' }, reports).prior, null);
});

test('name discovery retains untickered annual reporters alongside managers without extra requests', async () => {
  const calls = [];
  const search = createSecFilerSearch({ fetchSec: async url => {
    calls.push(url);
    const params = new URL(url).searchParams;
    if (params.has('keysTyped')) return Response.json(page([{ _id: '1002', _source: { entity: 'Example Securities Private Fund LLC' } }]));
    assert.equal(params.get('forms'), '13F-HR,13F-NT,X-17A-5');
    return Response.json(page([hit('0000001002', 'Example Securities Management LLC', '13F-HR'), hit(cik, filer.name, 'X-17A-5'), hit(cik, filer.name, 'X-17A-5/A')]));
  } });
  const result = await search('Example Securities');
  assert.equal(calls.length, 2);
  assert.equal(result.results[0].cik, cik);
  assert.deepEqual(result.results[0].formTypes, ['X-17A-5', 'X-17A-5/A']);
  assert.equal(Object.hasOwn(result.results[0], 'ticker'), false);
  assert.equal(result.warning, undefined);
});

test('explicit CIK discovery recognizes original annual reports and amendments in submissions', async () => {
  const search = createSecFilerSearch({ fetchSec: async () => Response.json({ cik, name: filer.name, tickers: [], filings: { recent: { form: ['X-17A-5', 'X-17A-5/A', 'FOCUS'] } } }) });
  const result = await search(cik);
  assert.equal(hasBrokerDealerFilings(result.results[0]), true);
  assert.deepEqual(result.results[0].formTypes, ['X-17A-5', 'X-17A-5/A']);
});

test('annual search aliases use existing filings routes and carry name intent without invented tickers', () => {
  for (const query of ['X-17A-5', 'x17a5', 'broker dealer annual reports', 'broker dealer filings', 'periodic FOCUS', 'FOCUS Part II', 'FOCUS Part IIA', 'Part III', 'Schedule I']) {
    assert.equal(buildGlobalSearch(query, null).directPath, '/filings?form=X-17A-5');
    assert.equal(routeSearch(query, null).path, '/filings?form=X-17A-5');
  }
  assert.equal(buildGlobalSearch('X-17A-5/A', map).directPath, '/filings?form=X-17A-5/A');
  for (const directory of [map, null]) {
    const plan = buildGlobalSearch('Brean annual report', directory);
    assert.equal(plan.lookupQuery, 'Brean');
    assert.equal(plan.filingIntent, 'annual');
    assert.equal(plan.directPath, null);
  }
  const explicit = buildGlobalSearch('Example Securities X-17A-5/A', map);
  assert.equal(explicit.lookupQuery, 'Example Securities');
  assert.equal(explicit.filingIntent, 'X-17A-5/A');
  assert.equal(buildGlobalSearch('CIK 1001 X-17A-5', null).directPath, '/filings/0000001001?form=X-17A-5');
  assert.equal(buildGlobalSearch('AAPL X-17A-5', map).directPath, '/filings/AAPL?form=X-17A-5');
  const matches = rankGlobalFilerMatches(filer.name, [filer], { filingIntent: explicit.filingIntent });
  assert.equal(matches.exactPath, '/filings/0000001001?form=X-17A-5/A');
  assert.match(matches.items[0].description, /Broker-dealer filings.*CIK 0000001001/);
  assert.equal(matches.items[0].identityType, 'cik');
  assert.equal(Object.hasOwn(matches.items[0], 'ticker'), false);
  assert.equal(secFilerResearchPath({ ...filer, formTypes: ['13F-HR', 'X-17A-5'] }), '/filings/0000001001?form=X-17A-5');
});


test('periodic FOCUS search intent finds public broker-dealer filings without classifying the results', () => {
  const plan = buildGlobalSearch('Example Securities periodic FOCUS', null);
  assert.equal(plan.lookupQuery, 'Example Securities');
  assert.equal(plan.filingIntent, 'X-17A-5');
  assert.equal(buildGlobalSearch('CIK 1001 FOCUS Part IIA', null).directPath, '/filings/0000001001?form=X-17A-5');
  const shortcut = buildGlobalSearch('periodic FOCUS', null);
  assert.match(shortcut.items[0].description, /confidential FOCUS reports are not included/);
  assert.equal(isBrokerDealerForm('periodic FOCUS'), false, 'A search alias never becomes evidence about a filing');
  const rows = normalizeFilingRows({ accessionNumber: ['0000001001-26-000001'], form: ['X-17A-5'], filingDate: ['2026-03-02'], reportDate: ['2025-12-31'] }, cik);
  assert.equal(filterFilings(rows, { query: 'periodic FOCUS' }).length, 1);
  assert.equal(rows[0].classification.family, 'unknown');
});

test('periodic comparisons exclude annual documents and different reporting frequencies', () => {
  const periodic = (number, end, frequency = 'quarterly') => ({ ...report(number, 'X-17A-5', `2026-0${number}-01`, end), classification: { family: 'periodic-focus', parts: ['Part II'], period: { frequency } } });
  const current = periodic(5, '2026-03-31'), prior = periodic(4, '2025-12-31');
  const annual = { ...periodic(3, '2025-12-31'), classification: { family: 'annual-report', period: { frequency: 'annual' } } };
  const monthly = periodic(2, '2026-02-28', 'monthly');
  const partIIA = { ...periodic(3, '2025-12-31'), classification: { family: 'periodic-focus', parts: ['Part IIA'], period: { frequency: 'quarterly' } } };
  assert.equal(selectFilingBaseline(current, [annual, monthly, partIIA]).prior, null);
  assert.equal(selectFilingBaseline(current, [current, prior, annual, monthly]).prior, prior);
  assert.equal(selectFilingBaseline({ ...current, classification: { family: 'periodic-focus', period: { frequency: 'unknown' } } }, [prior, annual, monthly]).prior, null);
});


test('periodic amendments require matching document parts and established period starts', () => {
  const original = { ...report(1, 'X-17A-5', '2026-04-01', '2026-03-31'), classification: { family: 'periodic-focus', parts: ['Part II'], period: { frequency: 'quarterly', start: '2026-01-01', end: '2026-03-31' } } };
  const amendment = { ...report(2, 'X-17A-5/A', '2026-05-01', '2026-03-31'), classification: original.classification };
  assert.equal(selectFilingBaseline(amendment, [original]).prior, original);
  for (const classification of [
    { ...original.classification, parts: ['Part IIA'] },
    { ...original.classification, period: { ...original.classification.period, start: '' } },
    { ...original.classification, period: { ...original.classification.period, start: '2026-02-01' } },
  ]) assert.equal(selectFilingBaseline(amendment, [{ ...original, classification }]).prior, null);
});
