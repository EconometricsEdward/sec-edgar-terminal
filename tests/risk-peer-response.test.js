import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRiskPeerResponse } from '../src/utils/riskPeerResponse.js';
import { buildRiskPeers } from '../src/utils/riskPeers.js';

function snapshot(count = 9) {
  return { generatedAt: '2026-09-30T12:00:00Z', companies: Array.from({ length: count }, (_, index) => {
    const cik = String(index + 1).padStart(10, '0');
    return { ticker: index ? `P${index}` : 'AAPL', cik, name: `Company ${index}`, sic: '3571', sectorId: 'technology',
      revenueBasis: 'Reported total revenue', reports: Object.fromEntries(['ttm', 'annual'].map(basis => [basis,
        { end: basis === 'annual' ? '2025-12-31' : '2026-06-30', filed: '2026-08-01', form: basis === 'annual' ? '10-K' : '10-Q', accession: `${cik}-26-000001` }])),
      metrics: Object.fromEntries(['ttm', 'annual'].map(basis => [basis, { currentRatio: index, interestCoverage: index,
        debtToAssets: index, cashToAssets: index, equityToAssets: index, cashFlowMargin: index, freeCashFlowMargin: index, netMargin: index }])) };
  }) };
}
const build = (source = snapshot(), choice = {}) => buildRiskPeers(source, { ticker: 'AAPL', basis: 'ttm', group: 'industry', ...choice }, Date.parse(source.generatedAt));
const match = body => matchesRiskPeerResponse(body, 'AAPL', 'ttm', 'industry', '0000000001');

test('client accepts real ready, sampled and insufficient peer contracts with zero values', () => {
  for (const count of [9, 101, 4]) assert.equal(match(build(snapshot(count))), true);
  assert.equal(build().metrics[0].value, 0);
});

test('uncovered company and a prepared company without its requested report are safe states', () => {
  const missing = build(snapshot(), { ticker: 'MISSING' });
  assert.equal(matchesRiskPeerResponse(missing, 'MISSING', 'ttm', 'industry'), true);
  assert.equal(missing.subject, null);
  const source = snapshot(); source.companies[0].reports.ttm = null;
  const noReport = build(source);
  assert.equal(noReport.subject.report, null);
  assert.equal(match(noReport), true);
  noReport.subject.report = { end: '2026-06-30', filed: null, form: null, accession: null };
  assert.equal(match(noReport), true);
});

test('responses bind to issuer, requested basis and explicit peer-group selection', () => {
  const body = build();
  assert.equal(matchesRiskPeerResponse(body, 'JPM', 'ttm', 'industry'), false);
  assert.equal(matchesRiskPeerResponse(body, 'AAPL', 'annual', 'industry'), false);
  assert.equal(matchesRiskPeerResponse(body, 'AAPL', 'ttm', 'model'), false);
  assert.equal(matchesRiskPeerResponse(body, 'AAPL', 'ttm', 'industry', '0000000099'), false);
  body.subject.ticker = 'JPM'; assert.equal(match(body), false);
});

test('share-class punctuation aliases retain the same verified issuer', () => {
  const source = snapshot(); source.companies[0].ticker = 'BRK-B';
  const body = build(source, { ticker: 'BRK.B' });
  assert.equal(matchesRiskPeerResponse(body, 'BRK.B', 'ttm', 'industry', '0000000001'), true);
});

test('malformed dates, missing peers, statistics and unsafe filing links never enter a plot', () => {
  const mutations = [
    body => { body.subject.report = null; },
    body => { body.metrics[0].median = Infinity; },
    body => { body.metrics[0].percentile = 101; },
    body => { body.metrics[0].q1 = 999; },
    body => { body.metrics[0].peers = null; },
    body => { body.metrics[0].peers[0].report.end = '2026-02-30'; },
    body => { body.metrics[0].peers[0].report.end = '2025-01-01'; },
    body => { body.metrics[0].peers[0].report.filed = null; },
    body => { body.metrics[0].peers[0].sourceUrl = 'javascript:alert(1)'; },
    body => { body.metrics[0].peers[0].cik = body.subject.cik; },
    body => { body.metrics[0].peers.push(body.metrics[0].peers[0]); },
    body => { body.metrics[0].plottedCount = 99; },
  ];
  for (const mutate of mutations) { const body = build(); mutate(body); assert.equal(match(body), false); }
  assert.equal(match(null), false);
});
