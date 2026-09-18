import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareFinancialCompany, refreshSecFinancialCohort } from '../src/utils/preparedFinancialData.js';
import { ANALYSIS_MAPPING_VERSION } from '../src/utils/analysisVersion.js';

const cik = '0000320193';
const filings = [
  { accession: '0000320193-26-000001', form: '10-K', filed: '2026-02-01', end: '2025-12-31', start: '2025-01-01', fp: 'FY', doc: 'annual.htm', revenue: 325 },
  { accession: '0000320193-26-000002', form: '10-Q', filed: '2026-08-01', end: '2026-06-30', start: '2026-04-01', fp: 'Q2', doc: 'quarter.htm', revenue: 450 },
];
const html = row => `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:dei="http://xbrl.sec.gov/dei/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217">
  <xbrli:context id="instant"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">${cik}</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>${row.end}</xbrli:instant></xbrli:period></xbrli:context>
  <xbrli:context id="duration"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">${cik}</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>${row.start}</xbrli:startDate><xbrli:endDate>${row.end}</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
  ${[['DocumentFiscalYearFocus', row.end.slice(0, 4)], ['DocumentFiscalPeriodFocus', row.fp], ['DocumentPeriodEndDate', row.end], ['DocumentType', row.form]].map(([tag, value]) => `<ix:nonNumeric name="dei:${tag}" contextRef="duration">${value}</ix:nonNumeric>`).join('')}
  <ix:nonFraction name="us-gaap:Assets" contextRef="instant" unitRef="usd" id="assets">1200</ix:nonFraction>
  <ix:nonFraction name="us-gaap:Revenues" contextRef="duration" unitRef="usd" id="revenue">${row.revenue}</ix:nonFraction></html>`;

function preparation() {
  const at = Date.now(), stored = new Map(), writes = [], releases = [], validations = [];
  const metadata = { fetchedAt: new Date(at - 60000).toISOString(), revalidatedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 24 * 3600000).toISOString(), documentContentHash: 'original' };
  const submissions = { cik, name: 'Verified filing fixture', sic: '3571', filings: { recent: {
    accessionNumber: filings.map(row => row.accession), form: filings.map(row => row.form),
    filingDate: filings.map(row => row.filed), reportDate: filings.map(row => row.end), primaryDocument: filings.map(row => row.doc),
  } } };
  const facts = { 'us-gaap': { Assets: { units: { USD: [{ val: 1000, end: '2024-12-31', filed: '2025-02-01',
    accn: '0000320193-25-000001', form: '10-K', fy: 2024, fp: 'FY' }] } } } };
  const documents = [{ payload: submissions, metadata: { ...metadata } }, { payload: { cik, facts }, metadata: { ...metadata } }];
  const options = { mode: 'shadow', loadRegistry: async () => null,
    begin: async (_dataset, key) => ({ key, generation: 1 }), reserveLegacy: async () => true,
    read: async (dataset, key) => dataset === 'sec' ? documents[key.endsWith(':submissions') ? 0 : 1] : stored.get(key),
    publish: async value => { writes.push(value); const envelope = { payload: value.payload, metadata: value.metadata }; stored.set(value.key, envelope); return envelope; },
    release: async (_dataset, key) => { releases.push(key); return true; },
    revalidate: async (_dataset, key) => { validations.push(key); return true; }, legacyWrite: async () => true,
    loadCompanyFacts: async () => assert.fail('No predecessor is declared for this issuer.'),
  };
  return { documents, stored, writes, releases, validations, options };
}

test('prepared annual and current-period views use verified filing enrichment with immutable extra-source provenance', async () => {
  const run = preparation(), downloads = [];
  const options = { ...run.options, loadFiling: async selected => {
    downloads.push(selected.accession); return html(filings.find(row => row.accession === selected.accession));
  } };
  const result = await prepareFinancialCompany('AAPL', options);
  assert.equal(result.status, 'prepared');
  assert.deepEqual(downloads, filings.map(row => row.accession));
  const annual = run.writes.find(write => write.metadata.basis === 'annual');
  const quarter = run.writes.find(write => write.metadata.basis === 'quarter');
  assert.equal(annual.payload.metrics.revenue[0].value, 325);
  assert.equal(quarter.payload.metrics.revenue[0].value, 450);
  for (const write of run.writes) {
    const row = filings[write.metadata.basis === 'annual' ? 0 : 1];
    assert.equal(write.payload.sourceCoverage.filingFallback.status, 'applied');
    assert.equal(write.payload.periods[0].end, row.end);
    assert.equal(write.metadata.inputDocuments.length, 2);
    assert.deepEqual(write.metadata.supplementalDocuments, write.identityInputs.supplementalDocuments);
    const document = write.metadata.supplementalDocuments[0];
    assert.equal(document.accession, row.accession);
    assert.equal(document.contentHash, createHash('sha256').update(html(row)).digest('hex'));
    assert.equal(document.url, `https://www.sec.gov/Archives/edgar/data/320193/${row.accession.replaceAll('-', '')}/${row.doc}`);
  }
  const again = await prepareFinancialCompany('AAPL', options);
  assert.ok(again.bases.every(row => row.status === 'unchanged'));
  assert.equal(downloads.length, 2, 'Unchanged canonical inputs reuse verified accession-linked filing evidence.');
  assert.equal(run.writes.length, 4); assert.equal(run.validations.length, 4);
});

test('unavailable enrichment never overwrites or extends a good snapshot and resumes once verified', async () => {
  const run = preparation(); let unavailable = false;
  const options = { ...run.options, loadFiling: async selected => {
    if (unavailable) throw new Error('SEC filing timeout');
    return html(filings.find(row => row.accession === selected.accession));
  } };
  await prepareFinancialCompany('AAPL', options);
  const previous = structuredClone([...run.stored]);
  run.documents[0].metadata.documentContentHash = 'changed-submissions';
  unavailable = true;
  const missing = await prepareFinancialCompany('AAPL', options);
  assert.equal(missing.status, 'busy'); assert.ok(missing.bases.every(row => row.status === 'busy'));
  assert.equal(run.writes.length, 4); assert.equal(run.validations.length, 0); assert.equal(run.releases.length, 4);
  assert.deepEqual([...run.stored], previous);
  unavailable = false;
  const recovered = await prepareFinancialCompany('AAPL', options);
  assert.equal(recovered.status, 'prepared'); assert.equal(run.writes.length, 8);
  assert.ok(recovered.bases.every(row => row.status === 'updated'));
});

test('a verified filing with no supported extra facts preserves missing values and does not stall cohort preparation', async () => {
  const run = preparation(), annual = filings[0];
  const reported = { end: annual.end, accn: annual.accession, filed: annual.filed, form: annual.form, fy: 2025, fp: 'FY' };
  const facts = run.documents[1].payload.facts['us-gaap'];
  facts.Assets.units.USD.push({ ...reported, val: 1200 });
  facts.Revenues = { units: { USD: [{ ...reported, start: annual.start, val: annual.revenue }] } };
  // This generic concept requires a verified current/noncurrent section. The
  // verified document has no such classification, so debt must remain missing.
  facts.NotesAndLoansPayable = { units: { USD: [{ ...reported, val: 10 }] } };
  let downloads = 0;
  const options = { ...run.options, bases: ['annual'], loadFiling: async () => { downloads++; return html(annual); } };
  const visited = [];
  const cohort = await refreshSecFinancialCohort({ maxCompanies: 2, refresh: async () => ({ status: 'updated' }),
    prepare: async ticker => {
      visited.push(ticker);
      return ticker === 'AAPL' ? prepareFinancialCompany(ticker, options) : { status: 'prepared', bases: [] };
    },
  });
  assert.deepEqual(visited, ['AAPL', 'MSFT']); assert.equal(cohort.nextCursor, 2);
  const published = run.writes[0];
  assert.equal(published.payload.sourceCoverage.filingFallback.status, 'no-supported-facts');
  assert.equal(published.payload.sourceCoverage.supplementedThrough, annual.end);
  assert.equal(published.payload.metrics.revenue[0].value, annual.revenue);
  assert.equal(published.payload.metrics.totalDebt[0].value, null);
  assert.match(published.payload.sourceCoverage.notices.at(-1), /verified.*no supported consolidated facts/);
  assert.equal(published.metadata.supplementalDocuments.length, 1);
  const repeated = await prepareFinancialCompany('AAPL', options);
  assert.equal(repeated.status, 'prepared'); assert.equal(repeated.bases[0].status, 'unchanged');
  assert.equal(downloads, 1, 'The verified coverage limit does not trigger an endless source retry.');
});

test('a mapping revision republishes unchanged source inputs instead of revalidating old calculations', async () => {
  const run = preparation();
  const options = { ...run.options, loadFiling: async selected => html(filings.find(row => row.accession === selected.accession)) };
  await prepareFinancialCompany('AAPL', options);
  const originalHash = run.writes[0].metadata.financialInputHash;
  for (const previous of run.stored.values()) {
    previous.payload = { ...previous.payload, mappingVersion: 'analysis-mappings-obsolete' };
    previous.metadata = { ...previous.metadata, mappingVersion: 'analysis-mappings-obsolete' };
  }
  const current = await prepareFinancialCompany('AAPL', options);
  assert.ok(current.bases.every(row => row.status === 'updated'));
  assert.equal(run.writes.length, 8); assert.equal(run.validations.length, 0);
  const republished = run.writes[4];
  assert.equal(republished.metadata.financialInputHash, originalHash);
  assert.equal(republished.payload.mappingVersion, ANALYSIS_MAPPING_VERSION);
  assert.equal(republished.metadata.mappingVersion, ANALYSIS_MAPPING_VERSION);
  assert.equal(republished.identityInputs.mappingVersion, ANALYSIS_MAPPING_VERSION);
});

test('mutable predecessor evidence is rechecked, deduplicated per preparation, and changes immutable identity', async () => {
  const run = preparation(); let sourceVersion = 'first', downloads = 0, enrichments = 0;
  const options = { ...run.options,
    loadCompanyFacts: async () => { downloads++; return { version: sourceVersion }; },
    enrichCompany: async (company, _settings, loaders) => {
      enrichments++;
      const input = await loaders.loadCompanyFacts('0000034088');
      return { ...company, sourceCoverage: { filingFallback: { status: 'not-needed' }, continuity: { status: 'applied' },
        sourceDocuments: [{ kind: 'companyfacts', cik: '0000034088', url: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000034088.json',
          contentHash: createHash('sha256').update(input.version).digest('hex') }] } };
    },
  };
  await prepareFinancialCompany('AAPL', options);
  const first = run.writes[0];
  assert.equal(downloads, 1); assert.equal(enrichments, 2);
  await prepareFinancialCompany('AAPL', options);
  assert.equal(downloads, 2); assert.equal(run.writes.length, 4); assert.equal(run.validations.length, 4);
  sourceVersion = 'revised-predecessor-feed';
  await prepareFinancialCompany('AAPL', options);
  const revised = run.writes[4];
  assert.equal(downloads, 3); assert.equal(run.writes.length, 8);
  assert.equal(first.metadata.financialCompanyHash, revised.metadata.financialCompanyHash);
  assert.notEqual(first.metadata.financialInputHash, revised.metadata.financialInputHash);
  assert.notEqual(first.identityInputs.supplementalDocuments[0].contentHash, revised.identityInputs.supplementalDocuments[0].contentHash);
});
