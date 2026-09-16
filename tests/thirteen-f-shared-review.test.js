import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareThirteenFReviewReport, hashThirteenFReviewReport, summarizeThirteenFReviewResult, THIRTEEN_F_REVIEW_SCHEMA } from '../src/utils/thirteenFSharedReview.js';
import { extractCompanyExposureMap } from '../src/utils/companyExposure.js';
import { THIRTEEN_F_MARKET_SCHEMA } from '../src/utils/thirteenFMarketConnections.js';

const CIK = '0001747057', ISSUER = '0000001234', PERIOD = '2026-06-30', CHECKED = '2026-09-15T12:00:00.000Z';
function report(count = 25) {
  const totalValueUsd = count * (count + 1) / 2 * 100;
  const holdings = Array.from({ length: count }, (_, i) => {
    const cusip = String(i + 1).padStart(9, '0'), valueUsd = (count - i) * 100;
    return { key: `${cusip}|SECURITY|SH`, cusip, issuer: `Company ${i + 1}`, classTitle: 'COM', putCall: null,
      quantity: i + 10, quantityType: 'SH', valueUsd, weightPct: valueUsd / totalValueUsd * 100 };
  });
  return { manager: { cik: CIK, name: 'Fixture Capital', submissionsUrl: `https://data.sec.gov/submissions/CIK${CIK}.json` },
    selectedPeriod: PERIOD, observedAt: CHECKED, cache: { checkedAt: CHECKED }, coverage: { selectedPeriodComplete: true },
    portfolio: { cik: CIK, managerName: 'Fixture Capital', period: PERIOD, reportType: '13F HOLDINGS REPORT',
      holdings, positionCount: count, entryCount: count, totalValueUsd, complete: true, comparable: true,
      confidentialOmitted: false, issues: [], amendmentCount: 0, otherManagers: [],
      filings: [{ accession: '0001747057-26-000100', form: '13F-HR', filingDate: '2026-08-14', reportDate: PERIOD,
        primaryUrl: 'https://www.sec.gov/Archives/edgar/data/1747057/000174705726000100/cover.xml',
        indexUrl: 'https://www.sec.gov/Archives/edgar/data/1747057/000174705726000100/0001747057-26-000100-index.htm',
        tableUrls: ['https://www.sec.gov/Archives/edgar/data/1747057/000174705726000100/table.xml'], isAmendment: false,
        amendmentType: null, amendmentNumber: null, superseded: false }] } };
}
function result(holding, text = 'Our borrowings accrue interest based on SOFR and expose us to changing funding costs.') {
  const filing = { accession: '0000001234-26-000001', form: '10-K', filed: '2026-02-20', reportDate: '2025-12-31',
    url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000001/report.htm' };
  const extracted = extractCompanyExposureMap([{ text, filing, role: 'annual' }], { companyName: holding.issuer });
  return { schemaVersion: THIRTEEN_F_MARKET_SCHEMA, status: 'ready', manager: { cik: CIK }, selectedPeriod: PERIOD,
    holding: structuredClone(holding), observedAt: CHECKED, retryable: false,
    identity: { status: 'resolved', cusip: holding.cusip, issuer: { cik: ISSUER, name: holding.issuer, kind: 'company', tickers: [] },
      evidence: [{ cik: ISSUER, cusips: [holding.cusip], form: 'SCHEDULE 13G', filingDate: '2026-03-01',
        url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000002/primary_doc.xml' }] },
    discovery: { schemaVersion: 'edgar.company-exposure-map.v1', cik: ISSUER, ticker: null, asOf: null,
      status: extracted.rows.length ? 'ready' : 'no_matches', checkedAt: CHECKED, generatedAt: CHECKED,
      sources: [{ ...filing, role: 'annual', status: 'ready', retrievedAt: CHECKED }], rows: extracted.rows,
      coverage: { ...extracted.coverage, searchComplete: true } } };
}

test('shared review freezes every holding in a large report, rather than the initial twenty', () => {
  const source = report(5696), frozen = prepareThirteenFReviewReport(source);
  assert.equal(frozen.schemaVersion, THIRTEEN_F_REVIEW_SCHEMA);
  assert.equal(frozen.portfolio.holdings.length, 5696);
  assert.equal(frozen.portfolio.positionCount, 5696);
  assert.equal(frozen.portfolio.totalValueUsd, source.portfolio.totalValueUsd);
  assert.deepEqual(frozen.portfolio.holdings.at(-1), source.portfolio.holdings.at(-1));
  source.portfolio.holdings[0].valueUsd = 1;
  assert.notEqual(frozen.portfolio.holdings[0].valueUsd, 1);
});

test('an unchanged report keeps its hash despite holdings order and later source check times', () => {
  const original = report(), changed = structuredClone(original);
  changed.portfolio.holdings.reverse();
  changed.observedAt = '2026-09-15T13:00:00.000Z'; changed.cache.checkedAt = changed.observedAt;
  const hash = hashThirteenFReviewReport(original);
  assert.match(hash, /^[A-F0-9]{64}$/);
  assert.equal(hashThirteenFReviewReport(changed), hash);
  assert.equal(hashThirteenFReviewReport(prepareThirteenFReviewReport(original)), hash);
});

test('JSONB object-key ordering does not change a saved report revision or break worker validation', () => {
  const original = report();
  original.portfolio.issues = [{ code: 'PUBLIC_REPORT_NOTE', message: 'Read the filed coverage note.' }];
  original.portfolio.otherManagers = [{ cik: '0000001234', name: 'Included Manager' }];
  const reorder = value => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
  const roundTrip = reorder(JSON.parse(JSON.stringify(prepareThirteenFReviewReport(original))));
  assert.notDeepEqual(Object.keys(roundTrip.portfolio.issues[0]), Object.keys(original.portfolio.issues[0]));
  assert.notDeepEqual(Object.keys(roundTrip.portfolio.otherManagers[0]), Object.keys(original.portfolio.otherManagers[0]));
  assert.equal(hashThirteenFReviewReport(roundTrip), hashThirteenFReviewReport(original));
});

test('changed values, denominators, completeness and amended source chains create a different review revision', () => {
  const original = report(), hash = hashThirteenFReviewReport(original);
  for (const mutate of [
    value => { value.portfolio.holdings[0].valueUsd++; },
    value => { value.portfolio.holdings[0].quantity++; },
    value => { value.portfolio.holdings[0].weightPct++; },
    value => { value.portfolio.totalValueUsd++; },
    value => { value.portfolio.entryCount++; },
    value => { value.portfolio.complete = false; },
    value => { value.coverage.selectedPeriodComplete = false; },
    value => { value.portfolio.confidentialOmitted = true; },
    value => { value.portfolio.filings[0].accession = '0001747057-26-000101'; value.portfolio.filings[0].isAmendment = true; },
    value => { value.portfolio.filings[0].amendmentNumber = 2; },
    value => { value.portfolio.filings[0].tableUrls = ['https://www.sec.gov/Archives/edgar/data/1747057/000174705726000100/changed.xml']; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    assert.notEqual(hashThirteenFReviewReport(changed), hash, mutate.toString());
  }
});

test('partial previews, duplicate holdings and mismatched report identities cannot become a full shared review', () => {
  for (const mutate of [
    value => { value.portfolio.holdings = value.portfolio.holdings.slice(0, 20); },
    value => { value.delivery = { mode: 'summary', holdingsComplete: false, total: 5696 }; delete value.portfolio.positionCount; },
    value => { value.portfolio.holdings[1] = value.portfolio.holdings[0]; },
    value => { value.portfolio.holdings[0].cusip = '999999999'; },
    value => { value.portfolio.holdings[0].valueUsd = Infinity; },
    value => { value.portfolio.cik = '0000000001'; },
    value => { value.portfolio.period = '2026-03-31'; },
    value => { value.manager.cik = '0000000001'; },
    value => { value.portfolio.holdings = []; value.portfolio.positionCount = 0; },
    value => { delete value.observedAt; delete value.cache; },
  ]) {
    const source = report(); mutate(source);
    assert.throws(() => prepareThirteenFReviewReport(source), { code: 'INVALID_REVIEW_REPORT' }, mutate.toString());
  }
});

test('bounded result summaries retain only verified holding identities and supported market connections', () => {
  const frozen = prepareThirteenFReviewReport(report()), holding = frozen.portfolio.holdings[0];
  const source = result(holding), summary = summarizeThirteenFReviewResult(frozen, source);
  assert.deepEqual(summary.holding, holding); assert.equal(summary.status, 'linked');
  assert.equal(summary.issuer.cik, ISSUER); assert.equal(summary.checkedAt, CHECKED);
  assert.equal(summary.checked, true); assert.equal(summary.partial, false); assert.equal(summary.retryable, false);
  assert.deepEqual(summary.markets.map(market => market.key), ['tff:134741:leveraged-funds']);
  assert.equal(summary.markets[0].members, undefined);
  assert.equal(summary.discovery, undefined); assert.equal(summary.identityEvidence, undefined);
  assert.deepEqual(summary.sources, [{ url: source.discovery.sources[0].url, accession: '0000001234-26-000001',
    form: '10-K', filed: '2026-02-20', reportDate: '2025-12-31' }]);
});

test('result summaries reject changed holdings, issuer proof, SEC passages and future checks', () => {
  const frozen = prepareThirteenFReviewReport(report()), holding = frozen.portfolio.holdings[0];
  for (const mutate of [
    value => { value.holding.key = frozen.portfolio.holdings[1].key; },
    value => { value.holding.valueUsd++; },
    value => { value.holding.weightPct++; },
    value => { value.holding.quantity++; },
    value => { value.manager.cik = '0000000001'; },
    value => { value.selectedPeriod = '2026-03-31'; },
    value => { value.identity.evidence[0].cik = '0000009999'; },
    value => { value.discovery.cik = '0000009999'; },
    value => { value.discovery.rows[0].evidence[0].url = 'https://example.com/invented.htm'; },
    value => { value.discovery.checkedAt = '2099-01-01T00:00:00.000Z'; },
  ]) {
    const changed = result(holding); mutate(changed);
    assert.throws(() => summarizeThirteenFReviewResult(frozen, changed), { code: 'INVALID_REVIEW_REPORT' }, mutate.toString());
  }
});

test('every completed status stays distinguishable from a retryable synthetic source failure', () => {
  const frozen = prepareThirteenFReviewReport(report()), holding = frozen.portfolio.holdings[0];
  const unresolved = result(holding);
  Object.assign(unresolved, { status: 'unresolved', identity: { status: 'unresolved', cusip: holding.cusip,
    reason: 'The issuer could not be verified.' }, discovery: null });
  const noFiling = result(holding); noFiling.discovery.status = 'no_filing'; noFiling.discovery.rows = [];
  const noMatch = result(holding, 'Our business includes services to companies in many industries throughout the year.');
  const disclosure = result(holding, 'Our variable-rate debt creates interest rate risk through changes in borrowing costs.');
  const partial = result(holding); partial.discovery.status = 'partial'; partial.discovery.coverage.searchComplete = false;
  const failed = { manager: { cik: CIK }, selectedPeriod: PERIOD, holding: structuredClone(holding),
    observedAt: CHECKED, status: 'unavailable', retryable: true, discovery: null, message: 'SEC request timed out.' };
  for (const [source, status] of [[unresolved, 'unresolved'], [noFiling, 'no_filing'], [noMatch, 'no_matches'],
    [disclosure, 'disclosure_only'], [partial, 'partial'], [failed, 'unavailable']]) {
    const summary = summarizeThirteenFReviewResult(frozen, source);
    assert.equal(summary.status, status);
    if (status === 'partial' || status === 'unavailable') assert.equal(summary.retryable, true);
  }
  const summary = summarizeThirteenFReviewResult(frozen, failed);
  assert.equal(summary.checked, false); assert.equal(summary.issuer, null); assert.deepEqual(summary.markets, []);
  assert.deepEqual(summary.sources, []);
  assert.throws(() => summarizeThirteenFReviewResult(frozen, { ...failed, retryable: false }), { code: 'INVALID_REVIEW_REPORT' });
});

test('published summary source links bind even a no-match report to the verified issuer and original filing dates', () => {
  const frozen = prepareThirteenFReviewReport(report()), holding = frozen.portfolio.holdings[0];
  const noMatch = result(holding, 'Our business includes services to companies in many industries throughout the year.');
  const summary = summarizeThirteenFReviewResult(frozen, noMatch);
  assert.equal(summary.sources.length, 1); assert.equal(summary.sources[0].filed, '2026-02-20');
  assert.equal(summary.sources[0].reportDate, '2025-12-31');
  for (const mutate of [
    value => { value.discovery.sources[0].url = 'https://www.sec.gov/Archives/edgar/data/9999/000000123426000001/report.htm'; },
    value => { value.discovery.sources[0].url += '?redirect=other'; },
    value => { value.discovery.sources[0].filed = '2026-02-30'; },
    value => { value.discovery.sources[0].reportDate = '2026-03-31'; },
  ]) {
    const changed = structuredClone(noMatch); mutate(changed);
    assert.throws(() => summarizeThirteenFReviewResult(frozen, changed), { code: 'INVALID_REVIEW_REPORT' });
  }
  noMatch.discovery.sources[0].status = 'unavailable';
  assert.deepEqual(summarizeThirteenFReviewResult(frozen, noMatch).sources, []);
});
