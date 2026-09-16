import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicFundReaders } from '../src/utils/fundPublicResearch.js';
import { disposableCachePolicy } from '../src/utils/disposableCache.js';

const NOW = Date.parse('2026-09-16T10:00:00Z');
const observed = new Date(NOW - 1000).toISOString();
const accession = '0000000001-26-000001';
const root = `https://www.sec.gov/Archives/edgar/data/1/${accession.replaceAll('-', '')}`;
function fund() {
  return { status: 'ready', ticker: 'VOO', name: 'Test portfolio', cik: '0000000001', seriesId: 'S000000001', classId: 'C000000001',
    accession, asOf: '2026-06-30', filingDate: '2026-08-15', retrievedAt: observed, form: 'NPORT-P',
    fundInfo: { netAssets: 1000, netAssetsSource: 'reported' },
    summary: { valuedCount: 2, weightCount: 2, top10Weight: 0 },
    holdings: [{ name: 'Zero', value: 0, pctOfNav: 0, weightSource: 'reported' },
      { name: 'Negative', value: -20, pctOfNav: -2, weightSource: 'calculated' },
      { name: 'Missing', value: null, pctOfNav: null }],
    sourceUrl: `${root}/primary_doc.xml`, filingUrl: `${root}/${accession}-index.html`,
    secUrl: 'https://www.sec.gov/edgar/browse/?CIK=S000000001' };
}
function manager() {
  return { checkedAt: observed, data: { status: 'ready', observedAt: observed,
    manager: { cik: '0000000001', name: 'Fixture manager' }, coverage: { selectedPeriodComplete: true }, summary: { top10Pct: 10 / 997 * 100 },
    portfolio: { complete: true, positionCount: 997, totalValueUsd: 997000, period: '2026-06-30', confidentialOmitted: true, comparable: false,
      holdings: Array.from({ length: 997 }, (_, index) => ({ issuer: `Security ${index}`, classTitle: 'COM', cusip: String(index).padStart(9, '0'), valueUsd: 1000,
        weightPct: 100 / 997, putCall: index === 0 ? 'PUT' : null, quantityType: index === 1 ? 'PRN' : 'SH' })),
      filings: [{ form: '13F-HR', filingDate: '2026-08-14', accession, indexUrl: `${root}/${accession}-index.html`, primaryUrl: `${root}/cover.xml` }] } } };
}

test('N-PORT public projection preserves negative, zero and missing values and exact accession identity', async () => {
  const data = fund(), original = structuredClone(data);
  const { readPublicFundSummary } = createPublicFundReaders({ now: () => NOW, readFund: async (ticker, selected, options) => {
    assert.equal(ticker, 'VOO'); assert.equal(selected, accession); assert.ok(options.signal); assert.equal(options.allowStale, true); return data;
  } });
  const result = await readPublicFundSummary('voo', accession);
  assert.equal(result.status, 'ready'); assert.equal(result.stale, false);
  assert.equal(result.totalValueUsd, 1000); assert.equal(result.valueLabel, 'Net assets');
  assert.equal(result.positionCount, 3); assert.equal(result.reportDate, '2026-06-30');
  assert.deepEqual(result.topHoldings.map(row => row.valueUsd), [0, -20, null]);
  assert.deepEqual(result.topHoldings.map(row => row.weightPct), [0, -2, null]);
  assert.equal(result.topHoldings[1].weightSource, 'calculated');
  assert.match(result.interactiveUrl, new RegExp(`accession=${accession}`));
  assert.equal(result.sources.length, 3); assert.deepEqual(data, original);
});

test('Compact 13F summary retains the full 997-position denominator and distinguishes options and confidential omissions', async () => {
  const data = manager();
  const { readPublicManagerSummary } = createPublicFundReaders({ now: () => NOW, readManager: async () => data });
  const result = await readPublicManagerSummary('1');
  assert.equal(result.positionCount, 997); assert.equal(result.topHoldings.length, 10);
  assert.equal(result.totalValueUsd, 997000); assert.equal(result.topHoldings[0].weightPct, 100 / 997);
  assert.equal(result.topHoldings[0].putCall, 'PUT'); assert.equal(result.topHoldings[1].quantityType, 'PRN');
  assert.equal(result.confidentialOmitted, true); assert.equal(result.comparable, false);
  assert.ok(result.limitations.some(row => row.includes('omits confidential')));
  assert.equal(result.filingDate, '2026-08-14');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10000);
  assert.equal(data.data.portfolio.holdings.length, 997);
});

test('Prepared reads retain source times and explicitly mark stale or invalidated evidence', async () => {
  const nport = fund(), thirteenF = manager();
  nport.cache = { checkedAt: new Date(NOW - 3600001).toISOString() };
  thirteenF.invalidatedAt = new Date(NOW).toISOString();
  const readers = createPublicFundReaders({ now: () => NOW, readFund: async () => nport, readManager: async () => thirteenF });
  const a = await readers.readPublicFundSummary('VOO'), b = await readers.readPublicManagerSummary('1');
  assert.equal(a.stale, true); assert.equal(a.checkedAt, nport.cache.checkedAt); assert.equal(a.retrievedAt, observed);
  assert.equal(b.stale, true); assert.equal(b.checkedAt, observed);
  assert.ok(b.limitations.some(row => row.includes('Newer incomplete evidence')));
});

test('Cache misses, failures, mismatched selections and incomplete portfolios never become public findings', async () => {
  for (const readFund of [async () => null, async () => { throw new Error('private gateway detail'); },
    async () => ({ ...fund(), ticker: 'VTI' }), async () => ({ ...fund(), accession: '0000000001-26-000002' })]) {
    const result = await createPublicFundReaders({ readFund }).readPublicFundSummary('VOO', accession);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.topHoldings, []);
    assert.doesNotMatch(JSON.stringify(result), /private gateway/);
  }
  for (const mutate of [value => { value.data.manager.cik = '0000000002'; }, value => { value.data.portfolio.complete = false; },
    value => { value.data.coverage.selectedPeriodComplete = false; }, value => { value.data.portfolio.period = '2026-03-31'; }]) {
    const data = manager(); mutate(data);
    const result = await createPublicFundReaders({ readManager: async () => data }).readPublicManagerSummary('1', '2026-06-30');
    assert.equal(result.status, 'unavailable');
  }
});

test('N-PORT storage policy caps compact references and accession bodies without admitting query variants', () => {
  const type = 'edgar.nport-prepared.v1:production';
  assert.deepEqual(disposableCachePolicy(type, 'VOO:latest'), { family: 'document', type, id: 'VOO:LATEST', maxTtlSeconds: 30 * 86400, maxRawBytes: 4096 });
  assert.equal(disposableCachePolicy(type, `VOO:${accession}`).maxRawBytes, 24 * 1024 * 1024);
  for (const id of ['VOO:latest:filter', 'VOO:latest?page=2', '../VOO:LATEST', 'VOO:2026-06-30', 'A'.repeat(16) + ':LATEST']) assert.equal(disposableCachePolicy(type, id), null);
  assert.equal(disposableCachePolicy(type.replace('production', 'preview'), 'VOO:LATEST'), null);
});
