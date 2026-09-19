import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCompanyExposureMap } from '../src/utils/companyExposure.js';
import { buildCompareMarketContext, compareMarketCompanies, compareMarketIdentity, compareMarketObservation } from '../src/utils/compareMarketContext.js';
import { CFTC_FAMILIES } from '../src/utils/cftc.js';

const now = new Date('2026-09-19T12:00:00Z');
const companies = [{ ticker: 'XOM', cik: '0000034088' }, { ticker: 'CVX', cik: '0000093410' }];
function response(company, text, { quarter = '', asOf = '' } = {}) {
  const filings = [
    { role: 'annual', form: '10-K', accession: '0000034088-26-000021', filed: '2026-02-20', reportDate: '2025-12-31' },
    ...(quarter ? [{ role: 'quarterly', form: '10-Q', accession: '0000034088-26-000047', filed: '2026-08-01', reportDate: '2026-06-30' }] : []),
  ].map(filing => ({ ...filing, url: `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${filing.accession.replaceAll('-', '')}/report.htm`, status: 'ready' }));
  const { rows } = extractCompanyExposureMap(filings.map((filing, i) => ({ filing, role: filing.role, text: i ? quarter : text })), { ticker: company.ticker });
  return { body: { schemaVersion: 'edgar.company-exposure-map.v1', ticker: company.ticker, cik: company.cik, asOf: asOf || null, status: rows.length ? 'ready' : 'no_matches', rows, sources: filings } };
}
const oilText = 'Our crude oil production revenue is priced using WTI benchmarks and changes in supply.';

test('shared market count uses unique SEC issuers, not share classes or multiple business channels', () => {
  const peers = [...companies, { ticker: 'XOM.A', cik: companies[0].cik }];
  assert.equal(compareMarketCompanies(peers).length, 2);
  const responses = Object.fromEntries(companies.map(company => [company.ticker, response(company, `${oilText} Our crude oil purchases are affected by WTI prices and procurement costs.`)]));
  const result = buildCompareMarketContext(peers, responses, { now });
  assert.equal(result.shared, 1);
  assert.equal(result.rows[0].count, 2);
  assert.equal(result.rows[0].members.length, 2);
  assert.equal(result.coverage.checked, 2);
  assert.ok(result.rows[0].members[0].named);
});

test('annual-only evidence cannot gain a named benchmark or qualification from a later quarter', () => {
  const responses = { XOM: response(companies[0], 'Our crude oil production revenue depends on realized prices and production volumes.', { quarter: oilText }) };
  const annual = buildCompareMarketContext(companies, responses, { now, basis: 'annual' });
  const quarter = buildCompareMarketContext(companies, responses, { now, basis: 'quarter' });
  assert.equal(annual.rows[0].members[0].named, false);
  assert.equal(quarter.rows[0].members[0].named, true);
  assert.ok(annual.rows[0].members[0].evidence.every(item => item.role === 'annual'));
});

test('negative or qualifying update stays reviewable and does not inflate shared connections', () => {
  const text = 'Our natural gas purchases are exposed to changes in fuel prices.';
  const responses = { XOM: response(companies[0], text, { quarter: 'We no longer purchase natural gas for our operations.' }), CVX: response(companies[1], text) };
  const result = buildCompareMarketContext(companies, responses, { now, basis: 'quarter' });
  assert.equal(result.shared, 0);
  assert.equal(result.rows[0].count, 1);
  assert.equal(result.rows[0].members.find(item => item.ticker === 'XOM').qualified, true);
  assert.ok(result.rows[0].members[0].evidence.some(item => item.disclosureDirection === 'qualifying-or-negative'));
});

test('generic rates language is not assigned a made-up Treasury tenor', () => {
  const result = buildCompareMarketContext(companies, { XOM: response(companies[0], 'Our long-term borrowings are exposed to changes in interest rates.') }, { now });
  assert.equal(result.rows.length, 0);
  assert.ok(result.coverage.unmapped > 0);
});

test('company, cutoff, future filings and SEC source URLs must match before links count', () => {
  const base = response(companies[0], oilText);
  for (const mutate of [
    body => { body.cik = companies[1].cik; },
    body => { body.asOf = '2026-02-15'; },
    body => { body.sources[0].url = 'https://example.com/filing.htm'; body.rows[0].evidence[0].url = body.sources[0].url; },
    body => { body.sources[0].filed = '2026-10-01'; body.rows[0].evidence[0].filed = body.sources[0].filed; },
  ]) {
    const changed = structuredClone(base); mutate(changed.body);
    const result = buildCompareMarketContext(companies, { XOM: changed }, { now });
    assert.equal(result.rows.length, 0);
    assert.equal(result.coverage.failed, 1);
  }
  const cutoff = buildCompareMarketContext(companies, { XOM: response(companies[0], oilText, { asOf: '2026-03-01' }) }, { now, asOf: '2026-03-01' });
  assert.equal(cutoff.rows.length, 1);
});

const market = { key: 'disaggregated:067651:managed-money', family: 'disaggregated', contract: '067651', group: 'managed-money' };
const observation = { status: 'ready', summary: { ...market, reportDate: '2026-09-15', priorDate: '2026-09-08', netPctOi: -12.5, weeklyChangePp: 2.25, sourceUrl: CFTC_FAMILIES.disaggregated.sourceUrl, stale: false, incomplete: false } };
test('CFTC summary is contract-bound, signed, dated and uses a reconstructed internal link', () => {
  const result = compareMarketObservation(observation, market, now);
  assert.equal(result.netPctOi, -12.5);
  assert.equal(result.weeklyChangePp, 2.25);
  assert.equal(result.reportDate, '2026-09-15');
  assert.ok(compareMarketObservation({ ...observation, summary: { ...observation.summary, sourceUrl: `${observation.summary.sourceUrl}?%24where=cftc_contract_market_code%3D%27067651%27` } }, market, now));
  assert.match(result.marketPath, /contract=067651/);
  for (const change of [{ contract: '023651' }, { reportDate: '2026-09-22' }, { netPctOi: 101 }, { netPctOi: null }, { sourceUrl: 'https://example.com/' }]) {
    assert.equal(compareMarketObservation({ ...observation, summary: { ...observation.summary, ...change } }, market, now), null);
  }
});
test('weekly movement requires exactly seven days, and old reports remain visibly aged', () => {
  const missingWeek = compareMarketObservation({ ...observation, summary: { ...observation.summary, priorDate: '2026-09-01' } }, market, now);
  assert.equal(missingWeek.weeklyChangePp, null);
  const aged = compareMarketObservation({ ...observation, summary: { ...observation.summary, reportDate: '2026-08-25', priorDate: '2026-08-18' } }, market, now);
  assert.equal(aged.stale, true);
});


test('dotted aliases require a verified SEC symbol and the same loaded issuer CIK', () => {
  const company = { ticker: 'BRK.B', cik: '0001067983' };
  const canonical = { ticker: 'BRK-B', cik: '1067983', isFund: false };
  assert.equal(compareMarketIdentity(company), null);
  assert.deepEqual(compareMarketIdentity(company, { 'BRK-B': canonical }), { ticker: 'BRK-B', cik: '0001067983' });
  assert.deepEqual(compareMarketIdentity({ ...company, secIdentity: canonical }), { ticker: 'BRK-B', cik: '0001067983' });
  assert.equal(compareMarketIdentity(company, { 'BRK-B': { ...canonical, cik: '123' } }), null);
  assert.equal(compareMarketIdentity(company, { 'BRK.B': { ticker: 'BRK.B', cik: '123' }, 'BRK-B': canonical }), null);
  assert.equal(compareMarketIdentity({ ...company, secIdentity: { ...canonical, ticker: 'BRK-A' } }), null);
  const exact = { ...canonical, ticker: 'BRK.B' };
  assert.equal(compareMarketIdentity(company, { 'BRK.B': exact, 'BRK-B': canonical }).ticker, 'BRK.B');
});

test('canonical alias responses retain display symbols and reject cached responses from another issuer', () => {
  const company = { ticker: 'BRK.B', cik: '0001067983' };
  const secIdentity = { ticker: 'BRK-B', cik: company.cik };
  const evidence = { ...response(secIdentity, 'Our investments in 10-year U.S. Treasury securities are exposed to changes in interest rates.'), secIdentity };
  const valid = buildCompareMarketContext([company], { 'BRK.B': evidence }, { now });
  assert.equal(valid.coverage.checked, 1);
  assert.equal(valid.rows[0].members[0].ticker, 'BRK.B');
  assert.equal(valid.companies[0].ticker, 'BRK.B');
  for (const mutate of [
    entry => { entry.secIdentity.cik = '0000000123'; },
    entry => { entry.body.cik = '0000000123'; },
    entry => { entry.body.ticker = 'BRK-A'; },
  ]) {
    const mismatch = structuredClone(evidence); mutate(mismatch);
    const invalid = buildCompareMarketContext([company], { 'BRK.B': mismatch }, { now });
    assert.equal(invalid.coverage.failed, 1);
    assert.equal(invalid.rows.length, 0);
  }
});
