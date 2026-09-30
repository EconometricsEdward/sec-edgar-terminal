import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskPeers, parseRiskPeerRequest, preparedRevenueCompatibility, RISK_PEER_METRICS } from '../src/utils/riskPeers.js';
import { createRiskPeersRoute } from '../src/utils/riskPeersServer.js';
import { MARKET_SECTOR_COMPANY_METRICS } from '../src/utils/marketSectorCompanies.js';

function issuer(index, overrides = {}) {
  const cik = String(index + 1).padStart(10, '0');
  return { ticker: index ? `P${index}` : 'AAPL', cik, name: `Issuer ${index}`, sic: '3571', sectorId: 'sector-technology',
    revenueBasis: 'Reported total revenue',
    reports: Object.fromEntries(['ttm', 'annual'].map(basis => [basis, {
      end: basis === 'annual' ? '2025-12-31' : '2026-06-30', filed: '2026-08-01', form: basis === 'annual' ? '10-K' : '10-Q',
      accession: `${cik}-26-000001` }])),
    metrics: Object.fromEntries(['ttm', 'annual'].map(basis => [basis, Object.fromEntries(MARKET_SECTOR_COMPANY_METRICS.map(id => [id, index]))])),
    ...overrides };
}
const fixture = (count = 9) => ({ version: 'market-sector-companies-v1', generatedAt: '2026-09-30T12:00:00Z',
  periodIntegrityVersion: 1, companies: Array.from({ length: count }, (_, index) => issuer(index)) });
const choice = overrides => ({ ticker: 'AAPL', basis: 'ttm', group: 'industry', ...overrides });
const build = (snapshot, overrides) => buildRiskPeers(snapshot, choice(overrides), Date.parse(snapshot.generatedAt));

test('peer distributions exclude the subject, interpolate quartiles and rank ties neutrally', () => {
  const source = fixture(), before = structuredClone(source);
  source.companies[0].metrics.ttm.equityToAssets = 4;
  const result = build(source), metric = result.metrics.find(row => row.id === 'equityToAssets');
  assert.equal(result.status, 'ready'); assert.equal(metric.count, 8);
  assert.equal(metric.median, 4.5); assert.equal(metric.q1, 2.75); assert.equal(metric.q3, 6.25);
  assert.equal(metric.percentile, 43.75); assert.equal(metric.value, 4);
  assert.ok(metric.peers.every(row => row.ticker !== 'AAPL'));
  assert.deepEqual(source.companies.slice(1), before.companies.slice(1));
});

test('missing values are excluded per measure, zeros and negative observations remain numeric', () => {
  const source = fixture(10);
  source.companies[1].metrics.ttm.netMargin = null;
  source.companies[2].metrics.ttm.netMargin = -20;
  source.companies[3].metrics.ttm.netMargin = 0;
  const metric = build(source).metrics.find(row => row.id === 'netMargin');
  assert.equal(metric.count, 8); assert.equal(metric.min, -20);
  assert.ok(metric.peers.some(row => row.value === 0));
  source.companies[4].metrics.ttm.netMargin = null;
  const small = build(source).metrics.find(row => row.id === 'netMargin');
  assert.equal(small.available, false); assert.equal(small.percentile, null); assert.equal(small.median, null);
  assert.equal(small.count, 7);
  source.companies[0].metrics.ttm.netMargin = null;
  assert.equal(build(source).metrics.find(row => row.id === 'netMargin').reason, 'Company input unavailable');
});

test('same-value cohorts still show a valid band and midpoint percentile', () => {
  const source = fixture();
  source.companies.forEach(row => { row.metrics.ttm.currentRatio = 2; });
  const metric = build(source).metrics.find(row => row.id === 'currentRatio');
  assert.equal(metric.available, true); assert.equal(metric.q1, 2); assert.equal(metric.q3, 2);
  assert.equal(metric.percentile, 50);
});

test('three-digit SIC industry matching is narrower than explicit business-model matching', () => {
  const source = fixture(); source.companies[1].sic = '7372';
  const industry = build(source), model = build(source, { group: 'model' });
  assert.equal(industry.group.eligible, 7); assert.equal(industry.status, 'insufficient');
  assert.equal(model.group.eligible, 8); assert.equal(model.status, 'ready');
  assert.notEqual(model.group.method, industry.group.method);
  source.companies[2].sic = '6022';
  assert.equal(build(source, { group: 'model' }).group.eligible, 7);
});

test('life, property insurers, banks and brokers never share a model and withhold corporate measures', () => {
  for (const [targetSic, excludedSic] of [['6311', '6331'], ['6022', '6211'], ['6211', '6022']]) {
    const source = fixture(10); source.companies.forEach(row => { row.sic = targetSic; }); source.companies[9].sic = excludedSic;
    const result = build(source, { group: 'model' });
    assert.equal(result.group.eligible, 8);
    assert.deepEqual(result.metrics.map(row => row.id), ['equityToAssets', 'netMargin']);
    assert.equal(result.metrics.length, 2);
  }
});

test('share classes deduplicate by CIK and ticker aliases preserve issuer identity', () => {
  const source = fixture(); source.companies.push({ ...source.companies[1], ticker: 'ZZZ' });
  source.companies[0].ticker = 'BRK-B';
  const result = build(source, { ticker: 'BRK.B' });
  assert.equal(result.subject.cik, '0000000001'); assert.equal(result.group.eligible, 8);
  assert.equal(result.metrics[0].count, 8);
});

test('requested non-first share class survives issuer deduplication in either input order', () => {
  const source = fixture();
  source.companies[0].ticker = 'BRK-A';
  const requested = structuredClone(source.companies[0]);
  requested.ticker = 'BRK-B'; requested.metrics.ttm.currentRatio = 20;
  source.companies.push(requested);
  source.companies.push({ ...source.companies[1], ticker: 'ZZZ' });
  for (const companies of [source.companies, [...source.companies].reverse()]) {
    for (const ticker of ['BRK-B', 'BRK.B']) {
      const result = build({ ...source, companies }, { ticker });
      assert.equal(result.status, 'ready');
      assert.equal(result.subject.ticker, 'BRK-B'); assert.equal(result.subject.cik, '0000000001');
      assert.equal(result.metrics.find(row => row.id === 'currentRatio').value, 20);
      assert.equal(result.group.eligible, 8);
      for (const metric of result.metrics) {
        assert.equal(metric.count, 8);
        assert.ok(metric.peers.every(row => row.cik !== result.subject.cik));
        assert.equal(new Set(metric.peers.map(row => row.cik)).size, 8);
      }
    }
  }
});

test('report ends, source dates, forms, basis and revenue definitions gate compatible values', () => {
  const source = fixture(13);
  source.companies[1].reports.ttm.end = '2025-12-31'; // outside subject window
  source.companies[2].reports.ttm.filed = '2026-10-01'; // beyond snapshot date
  source.companies[3].reports.ttm.filed = '2026-05-01'; // ends after filing
  source.companies[4].reports.ttm.form = '6-K';
  const result = build(source);
  assert.equal(result.group.eligible, 8); assert.equal(result.exclusions.date, 1); assert.equal(result.exclusions.report, 3);
  source.companies[5].revenueBasis = 'Financial net revenue after interest expense';
  assert.equal(build(source).metrics.find(row => row.id === 'netMargin').count, 7);
  assert.equal(build(source).metrics.find(row => row.id === 'equityToAssets').count, 8);
  assert.equal(build(source, { basis: 'annual' }).group.eligible, 12);
  source.companies[0].reports.ttm.form = '6-K';
  assert.equal(build(source).status, 'uncovered'); assert.deepEqual(build(source).metrics, []);
});

test('uncovered companies do not acquire a surrogate subject and stale snapshots remain dated', () => {
  const source = fixture(); const result = build(source, { ticker: 'NOTHERE' });
  assert.equal(result.status, 'uncovered'); assert.equal(result.subject, null); assert.equal(result.metrics.length, 0);
  assert.equal(buildRiskPeers(source, choice(), Date.parse(source.generatedAt) + 26 * 3600000).stale, true);
});

test('combined revenue-scope labels never establish annual or TTM rental and net-revenue distributions', () => {
  for (const sic of ['6798', '6512', '6022', '6211']) {
    const source = fixture();
    source.companies.forEach(row => {
      row.sic = sic;
      row.revenueBasis = sic === '6798' ? 'Reported lease revenue; non-lease income excluded'
        : sic === '6512' ? 'Reported total revenue' : 'Financial net revenue after interest expense';
    });
    for (const basis of ['annual', 'ttm']) {
      assert.equal(preparedRevenueCompatibility(source.companies[0], source.companies[1], basis), false);
      const result = build(source, { basis });
      for (const metric of result.metrics.filter(row => row.revenue)) {
        assert.equal(metric.value, 0); // Raw prepared subject value remains visible.
        assert.equal(metric.available, false);
        assert.equal(metric.count, 0);
        assert.equal(metric.median, null); assert.equal(metric.percentile, null);
        assert.deepEqual(metric.peers, []);
        assert.equal(metric.reason, 'Comparable revenue scope unavailable for this reporting basis');
      }
      assert.equal(result.metrics.find(row => row.id === 'equityToAssets').available, true);
    }
  }
});

test('total-revenue scopes compare only against provably compatible total-revenue peers', () => {
  const source = fixture(10);
  source.companies[1].revenueBasis = 'Financial net revenue after interest expense';
  for (const basis of ['annual', 'ttm']) {
    assert.equal(preparedRevenueCompatibility(source.companies[0], source.companies[2], basis), true);
    assert.equal(preparedRevenueCompatibility(source.companies[0], source.companies[1], basis), false);
    const result = build(source, { basis });
    assert.equal(result.metrics.find(row => row.id === 'netMargin').count, 8);
    assert.equal(result.metrics.find(row => row.id === 'netMargin').available, true);
    assert.equal(result.metrics.find(row => row.id === 'equityToAssets').count, 9);
  }
  delete source.companies[0].revenueBasis;
  assert.equal(build(source).metrics.find(row => row.id === 'netMargin').reason,
    'Comparable revenue scope unavailable for this reporting basis');
  assert.equal(preparedRevenueCompatibility(source.companies[2], source.companies[3], 'quarter'), false);
});

test('large cohorts retain full statistics while bounding display dots and payload', () => {
  const source = fixture(1001), result = build(source), metric = result.metrics[0];
  assert.equal(metric.count, 1000); assert.equal(metric.plottedCount, 60); assert.equal(metric.median, 500.5);
  assert.equal(metric.peers[0].value, 1); assert.equal(metric.peers.at(-1).value, 1000);
  assert.ok(JSON.stringify(result).length < 200000);
  assert.equal(result.metrics.length, RISK_PEER_METRICS.length);
});

test('strict queries reject unbounded filters and duplicate or historical parameters', () => {
  assert.deepEqual(parseRiskPeerRequest('https://example.test/api/risk/peers?ticker=aapl'), choice());
  for (const query of ['ticker=AAPL&ticker=JPM', 'ticker=AAPL&basis=q', 'ticker=AAPL&group=all', 'ticker=AAPL&asOf=2024-01-01', 'ticker=AAPL&limit=5000', 'ticker=../AAPL']) {
    assert.throws(() => parseRiskPeerRequest(`https://example.test/?${query}`), { status: 400 });
  }
});

test('endpoint is cache-only and validates the snapshot before serving a bounded response', async () => {
  let reads = 0;
  const handler = createRiskPeersRoute({ read: async () => { reads++; return fixture(); }, limit: async () => ({ allowed: true }), now: () => Date.parse('2026-09-30T12:00:00Z') });
  const good = await handler(new Request('https://example.test/?ticker=AAPL'));
  assert.equal(good.status, 200); assert.equal((await good.json()).status, 'ready'); assert.equal(reads, 1);
  assert.match(good.headers.get('cache-control'), /s-maxage=300/);
  const bad = await handler(new Request('https://example.test/?ticker=AAPL&basis=quarter'));
  assert.equal(bad.status, 400); assert.equal(reads, 1);
  const failure = createRiskPeersRoute({ read: async () => ({}), limit: async () => ({ allowed: true }) });
  assert.equal((await failure(new Request('https://example.test/?ticker=AAPL'))).status, 503);
});
