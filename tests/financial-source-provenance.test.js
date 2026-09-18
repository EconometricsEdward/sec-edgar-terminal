import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFinancialFact, sourceDocumentUrl } from '../src/utils/xbrlPeriods.js';
import { buildSourceUrl } from '../src/utils/xbrlParser.js';

const accession = '0000034088-26-000093';
const documentUrl = 'https://www.sec.gov/Archives/edgar/data/2115436/000003408826000093/xom-20260630.htm';
const period = { end: '2026-06-30', kind: 'instant' };
function facts(observation) {
  return { 'us-gaap': { Assets: { units: { USD: [{ val: 464478000000, end: period.end, form: '10-Q', filed: '2026-08-03', accn: accession, ...observation }] } } } };
}

test('inline filing observations retain exact source and classification evidence', () => {
  const classificationEvidence = { method: 'balance-sheet-section', documentUrl, factId: 'f-123' };
  const point = selectFinancialFact(facts({ sourceCik: '2115436', documentUrl, factId: 'f-123', sourceType: 'inline-filing', balanceClassification: 'current', classificationEvidence }), ['Assets'], period);
  assert.equal(point.value, 464478000000);
  assert.equal(point.source.sourceCik, '2115436');
  assert.deepEqual(point.source.classificationEvidence, classificationEvidence);
  assert.equal(sourceDocumentUrl('34088', point.source), `${documentUrl}#f-123`);
  assert.equal(buildSourceUrl('34088', point.source), `${documentUrl}#f-123`);
});

test('predecessor observations cite predecessor archives and company concepts', () => {
  const point = selectFinancialFact(facts({ sourceCik: '34088' }), ['Assets'], period);
  assert.equal(sourceDocumentUrl('2115436', point.source), 'https://www.sec.gov/Archives/edgar/data/34088/000003408826000093/');
  assert.equal(buildSourceUrl('2115436', point.source), 'https://data.sec.gov/api/xbrl/companyconcept/CIK0000034088/us-gaap/Assets.json');
});

test('exact document links cannot redirect source evidence outside its issuer/accession', () => {
  const expected = 'https://www.sec.gov/Archives/edgar/data/2115436/000003408826000093/';
  for (const invalidUrl of [documentUrl.replace('sec.gov', 'example.com'), documentUrl.replace('/2115436/', '/34088/'), `${documentUrl}?redirect=elsewhere`, 'javascript:alert(1)']) {
    assert.equal(sourceDocumentUrl('2115436', { accession, documentUrl: invalidUrl }), expected);
  }
  assert.equal(sourceDocumentUrl('2115436', { accession, sourceCik: 'not-an-issuer' }), null);
  assert.equal(buildSourceUrl('2115436', { tag: 'Assets', sourceCik: 'not-an-issuer' }), null);
});

test('ordinary companyfacts retain existing concept and filing links', () => {
  const point = selectFinancialFact(facts({}), ['Assets'], period);
  assert.equal(buildSourceUrl('2115436', point.source), 'https://data.sec.gov/api/xbrl/companyconcept/CIK0002115436/us-gaap/Assets.json');
  assert.equal(sourceDocumentUrl('2115436', point.source), 'https://www.sec.gov/Archives/edgar/data/2115436/000003408826000093/');
});
