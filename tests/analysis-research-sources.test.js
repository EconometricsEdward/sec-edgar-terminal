import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichAnalysisCompanySources, analysisSourceCachePolicy } from '../src/utils/analysisResearchSources.js';
import { buildAnalysisCompany, packAnalysisCompany } from '../src/utils/analysisResearch.js';
import { reportingPeriods, selectFinancialFact, sourceDocumentUrl } from '../src/utils/xbrlPeriods.js';

const cik = '0000021344', now = new Date('2026-09-18');
const filing = { accession: '0001628280-26-050503', filingDate: '2026-07-29', reportDate: '2026-07-03', form: '10-Q', primaryDoc: 'ko-20260703.htm' };
const annualFiling = { accession: '0001628280-26-000001', filingDate: '2026-02-20', reportDate: '2025-12-31', form: '10-K', primaryDoc: 'ko-20251231.htm' };
const record = (val, end = '2026-04-03', extra = {}) => ({ val, end, accn: '0001628280-26-028802', filed: '2026-04-30', form: '10-Q', fy: 2026, fp: 'Q1', ...extra });
const concept = rows => ({ units: { USD: rows } });
const company = (id = cik) => ({ ticker: 'KO', companyName: 'Fixture', sic: '2086', cik: id, filings: [filing, annualFiling],
  facts: { 'us-gaap': { Assets: concept([record(100)]) } } });
const context = (id, { issuer = cik, start, end = filing.reportDate, dimension } = {}) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">${issuer}</xbrli:identifier>${dimension ? '<xbrli:segment><xbrldi:explicitMember dimension="custom:Axis">custom:Member</xbrldi:explicitMember></xbrli:segment>' : ''}</xbrli:entity><xbrli:period>${start ? `<xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate>` : `<xbrli:instant>${end}</xbrli:instant>`}</xbrli:period></xbrli:context>`;
const fact = (tag, value, id, ctx = 'instant', unit = 'usd') => `<ix:nonFraction name="us-gaap:${tag}" contextRef="${ctx}" unitRef="${unit}" id="${id}">${value}</ix:nonFraction>`;
const doc = (body = fact('Assets', '120', 'assets'), { issuer = cik, end = filing.reportDate, form = '10-Q', fp = 'Q2', start = '2026-01-01' } = {}) => `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:dei="http://xbrl.sec.gov/dei/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:custom="https://example.test/2026">${context('instant', { issuer, end })}${context('duration', { issuer, start, end })}${context('segment', { issuer, start, end, dimension: true })}<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><xbrli:unit id="eur"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>${[['DocumentFiscalYearFocus', end.slice(0, 4)], ['DocumentFiscalPeriodFocus', fp], ['DocumentPeriodEndDate', end], ['DocumentType', form]].map(([tag, value]) => `<ix:nonNumeric name="dei:${tag}" contextRef="duration">${value}</ix:nonNumeric>`).join('')}${body}</html>`;
const deps = html => ({ now, loadCompanyFacts: async () => assert.fail('Unexpected predecessor lookup.'), loadFiling: async () => html });

test('each current-period basis uses one eligible filing and retains exact supported facts and source provenance', async () => {
  for (const basis of ['quarter', 'ytd', 'ttm']) {
    let calls = 0;
    const result = await enrichAnalysisCompanySources(company(), { basis }, { ...deps(doc(fact('Assets', '120', 'assets') + fact('Revenues', '50', 'revenue', 'duration'))),
      loadFiling: async selected => { calls++; assert.equal(selected.accession, filing.accession); return doc(fact('Assets', '120', 'assets') + fact('Revenues', '50', 'revenue', 'duration')); } });
    assert.equal(calls, 1); assert.equal(result.sourceCoverage.filedThrough, '2026-09-18');
    assert.equal(result.sourceCoverage.companyFactsThrough, '2026-04-03');
    assert.equal(result.sourceCoverage.supplementedThrough, filing.reportDate);
    assert.equal(result.sourceCoverage.filingFallback.status, 'applied');
    const source = selectFinancialFact(result.facts, ['Assets'], reportingPeriods(result.facts, 'quarter')[0]).source;
    assert.equal(source.value, 120); assert.equal(source.sourceCik, cik);
    assert.match(sourceDocumentUrl('0000000001', source), /ko-20260703.htm#assets$/);
    assert.match(result.sourceCoverage.sourceDocuments[0].contentHash, /^[a-f0-9]{64}$/);
    assert.equal(packAnalysisCompany(buildAnalysisCompany(result, { basis })).sourceCoverage, result.sourceCoverage);
  }
});

test('annual fallback compares annual anchors even when company facts already contain a newer quarterly anchor', async () => {
  const input = company();
  input.facts['us-gaap'].Assets.units.USD.push(record(90, '2024-12-31', { form: '10-K', fp: 'FY', fy: 2024, filed: '2025-02-20', accn: '0001628280-25-000001' }));
  let selected;
  const result = await enrichAnalysisCompanySources(input, { basis: 'annual' }, { ...deps(''), loadFiling: async value => {
    selected = value; return doc(fact('Assets', '110', 'assets'), { end: annualFiling.reportDate, form: '10-K', fp: 'FY', start: '2025-01-01' });
  } });
  assert.equal(selected.accession, annualFiling.accession);
  assert.equal(result.sourceCoverage.companyFactsThrough, '2024-12-31');
  assert.equal(reportingPeriods(result.facts, 'annual')[0].end, '2025-12-31');
});

test('historical cutoff excludes future observations and never retrieves the current filing', async () => {
  const input = company();
  input.facts['us-gaap'].Assets.units.USD.push(record(999, filing.reportDate, { filed: filing.filingDate, accn: filing.accession }));
  const result = await enrichAnalysisCompanySources(input, { basis: 'quarter', asOf: '2026-06-01' }, {
    ...deps(''), loadFiling: async () => assert.fail('Neither the future quarter nor an older annual is required.'),
  });
  assert.deepEqual(result.facts['us-gaap'].Assets.units.USD.map(row => row.val), [100]);
  assert.equal(result.sourceCoverage.filedThrough, '2026-06-01');
  assert.equal(result.sourceCoverage.latestFilingReportDate, annualFiling.reportDate);
  assert.equal(result.sourceCoverage.filingFallback.status, 'not-needed');
  const earliest = await enrichAnalysisCompanySources(input, { basis: 'quarter', asOf: '2024-01-01' }, {
    ...deps(''), loadFiling: async () => assert.fail('No eligible filing exists in the bounded manifest.'),
  });
  assert.equal(earliest.sourceCoverage.historicalManifestLimited, true);
  assert.equal(earliest.facts['us-gaap'].Assets.units.USD.length, 0);
});

test('latest historical eligible filing can supplement only from that historical document', async () => {
  const input = company(); input.facts = {};
  let selected;
  const result = await enrichAnalysisCompanySources(input, { basis: 'quarter', asOf: '2026-03-01' }, {
    ...deps(''), loadFiling: async value => { selected = value; return doc(fact('Assets', '110', 'assets'), { end: annualFiling.reportDate, form: '10-K', fp: 'FY', start: '2025-01-01' }); },
  });
  assert.equal(selected.accession, annualFiling.accession);
  assert.equal(result.sourceCoverage.supplementedThrough, annualFiling.reportDate);
  assert.ok(result.facts['us-gaap'].Assets.units.USD.every(row => row.filed <= '2026-03-01'));
});

test('partial inline coverage never fabricates revenue, per-share values or missing TTM quarters', async () => {
  const html = doc(fact('Assets', '120', 'assets') + fact('Revenues', '80', 'revenue', 'duration', 'eur')
    + fact('NetIncomeLoss', '5', 'segment-net', 'segment') + fact('Cash', '10', 'custom-cash').replace('name="us-gaap:Cash"', 'name="custom:Cash"'));
  const result = await enrichAnalysisCompanySources(company(), { basis: 'ttm' }, deps(html));
  const payload = buildAnalysisCompany(result, { basis: 'ttm' });
  assert.equal(payload.periods[0].end, filing.reportDate);
  assert.equal(payload.metrics.revenue[0].value, null);
  assert.equal(result.facts['us-gaap'].NetIncomeLoss, undefined);
  assert.equal(result.facts['us-gaap'].Cash, undefined);
  assert.match(result.sourceCoverage.notices.at(-1), /remain unavailable/);
});

test('failed or wrong-issuer primary documents retain old facts and use the short recovery cache', async () => {
  for (const loadFiling of [async () => { throw new Error('SEC timeout'); }, async () => doc(undefined, { issuer: '0000000001' })]) {
    const result = await enrichAnalysisCompanySources(company(), { basis: 'quarter' }, { ...deps(''), loadFiling });
    assert.equal(result.sourceCoverage.filingFallback.status, 'unavailable');
    assert.equal(result.facts['us-gaap'].Assets.units.USD[0].val, 100);
    assert.deepEqual(analysisSourceCachePolicy(result), { ttlSeconds: 60, cacheControl: 'public, max-age=0, s-maxage=60, must-revalidate' });
  }
});

test('reviewed predecessor history retains issuer identity and requires transition evidence available by the cutoff', async () => {
  const currentCik = '0002115436', predecessorCik = '0000034088';
  const current = company(currentCik); current.filings = [];
  const predecessor = company(predecessorCik);
  predecessor.facts['us-gaap'].Assets.units.USD = [record(460, '2025-12-31', { form: '10-K', fp: 'FY', filed: '2026-02-20', accn: '0000034088-26-000001' }),
    record(999, '2026-07-01', { filed: '2026-08-03' })];
  let calls = 0;
  const dependencies = { ...deps(''), loadCompanyFacts: async id => { calls++; assert.equal(id, predecessorCik); return predecessor; } };
  const before = await enrichAnalysisCompanySources(current, { asOf: '2026-08-02' }, dependencies);
  assert.equal(calls, 0); assert.equal(before.sourceCoverage.continuity.status, 'not-applicable');
  const after = await enrichAnalysisCompanySources(current, { asOf: '2026-08-03' }, dependencies);
  assert.equal(calls, 1); assert.equal(after.cik, currentCik); assert.equal(after.sourceCoverage.continuity.status, 'applied');
  const source = selectFinancialFact(after.facts, ['Assets'], reportingPeriods(after.facts, 'annual')[0]).source;
  assert.equal(source.sourceCik, predecessorCik); assert.equal(source.value, 460);
  assert.match(sourceDocumentUrl(currentCik, source), /\/data\/34088\//);
  assert.ok(after.facts['us-gaap'].Assets.units.USD.every(row => row.val !== 999));
  assert.equal(after.sourceCoverage.sourceDocuments[0].cik, predecessorCik);
  const wrong = await enrichAnalysisCompanySources(current, {}, { ...dependencies, loadCompanyFacts: async () => company('0000000001') });
  assert.equal(wrong.sourceCoverage.continuity.status, 'partial');
  assert.equal(wrong.sourceCoverage.sourceDocuments.length, 0);
  assert.equal(analysisSourceCachePolicy(wrong).ttlSeconds, 60);
});

test('reader cancellation during optional filing or predecessor work propagates and cannot become a partial success', async () => {
  for (const predecessor of [false, true]) {
    const controller = new AbortController();
    const abortedLoad = async (_input, signal) => { controller.abort(new Error('reader left')); signal.throwIfAborted(); };
    await assert.rejects(enrichAnalysisCompanySources(company(predecessor ? '0002115436' : cik), { basis: 'quarter' }, {
      ...deps(''), signal: controller.signal, ...(predecessor ? { loadCompanyFacts: abortedLoad } : { loadFiling: abortedLoad }),
    }), /reader left/);
  }
});

test('valid source coverage gets five minutes; every retryable failure has no stale-while-revalidate extension', () => {
  for (const filingStatus of ['applied', 'not-needed']) assert.equal(analysisSourceCachePolicy({ sourceCoverage: { filingFallback: { status: filingStatus } } }).ttlSeconds, 300);
  for (const filingStatus of ['unavailable', 'no-supported-facts']) assert.equal(analysisSourceCachePolicy({ sourceCoverage: { filingFallback: { status: filingStatus } } }).ttlSeconds, 60);
});
