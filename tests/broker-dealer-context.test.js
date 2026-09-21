import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerSourceUrl, validateBrokerPeer, brokerPeerRow, compareBrokerPeriods, brokerCftcSeries, createBrokerPeerClient } from '../src/utils/brokerDealerContext.js';

const cik = '0001690976', accession = '0001690976-26-000005';
const source = { url: 'https://www.sec.gov/Archives/edgar/data/1690976/000169097626000005/ASLCMIPUBLICFSJUNE2026.pdf', page: 6 };
const peer = () => ({ schemaVersion: 'edgar.broker-dealer-analysis.v1', basis: 'annual', status: 'partial', cik, name: 'Example Broker', accession, periodEnd: '2026-06-30', metrics: [{ id: 'totalAssets', label: 'Assets', value: 1000, unit: 'USD', periodEnd: '2026-06-30', source }], ratios: [{ id: 'assetsToEquity', value: 10, periodEnd: '2026-06-30', sources: [source] }] });
const history = (group = 'dealer') => ({ report_family: 'tff', report_basis: 'futures_only', selection: { contract: '043602', group, report_date: '2026-09-15', history_window: '1y', required_prior_reports: 52 }, selected: { code: '043602', reportDate: '2026-09-15', selectedGroup: { id: group } }, percentile: { required: 52 }, history: [{ reportDate: '2026-09-01', netPctOi: -5 }, { reportDate: '2026-09-08', netPctOi: null }, { reportDate: '2026-09-15', netPctOi: 0 }] });

test('peer identity rejects parent-company, wrong schema, basis, date and missing accession', () => {
  assert.equal(validateBrokerPeer(peer(), cik).cik, cik);
  for (const updates of [{ cik: '0000320193' }, { basis: 'quarter' }, { periodEnd: '2026-02-30' }, { accession: '' }, { schemaVersion: 'corporate' }, { status: 'unavailable' }]) {
    assert.throws(() => validateBrokerPeer({ ...peer(), ...updates }, cik));
  }
});

test('peer evidence binds SEC host, exact legal-entity CIK and selected accession', () => {
  assert.equal(brokerSourceUrl(source, cik, accession), `${source.url}#page=6`);
  for (const url of [source.url.replace('/1690976/', '/320193/'), source.url.replace('000169097626000005', '000169097625000004'), source.url.replace('www.sec.gov', 'sec.gov.attacker.example'), source.url.replace('https:', 'http:'), source.url.replace('www.sec.gov', 'username@www.sec.gov')]) {
    assert.equal(brokerSourceUrl({ ...source, url }, cik, accession), null);
  }
});

test('comparison preserves zero and negative values, omits unsupported source and period values', () => {
  const value = peer();
  value.metrics.push({ id: 'totalEquity', value: -20, unit: 'USD', periodEnd: value.periodEnd, source });
  value.metrics.push({ id: 'netCapital', value: 0, unit: 'USD', periodEnd: value.periodEnd, source });
  const row = brokerPeerRow(value, cik);
  assert.equal(row.measures.totalEquity.value, -20);
  assert.equal(row.measures.netCapital.value, 0);
  assert.equal(row.measures.assetsToEquity.value, 10);
  assert.equal(row.measures.netCapitalToRequired, undefined);
  assert.equal(brokerPeerRow(value, '0000320193'), null);
  value.metrics[0].periodEnd = '2025-06-30';
  value.ratios[0].sources = [{ ...source, url: source.url.replace('/1690976/', '/320193/') }];
  const filtered = brokerPeerRow(value, cik);
  assert.equal(filtered.measures.totalAssets, undefined);
  assert.equal(filtered.measures.assetsToEquity, undefined);
});

test('comparison exposes actual date mismatch instead of implicitly aligning periods', () => {
  assert.deepEqual(compareBrokerPeriods('2026-06-30', '2026-06-30'), { aligned: true, days: 0, label: 'Same reporting date' });
  assert.deepEqual(compareBrokerPeriods('2026-06-30', '2025-12-31'), { aligned: false, days: 181, label: '181 days earlier' });
  assert.equal(compareBrokerPeriods('2025-12-31', '2026-06-30').label, '181 days later');
  assert.equal(compareBrokerPeriods('2026-02-30', '2026-06-30').aligned, false);
});

test('CFTC trader series preserve missing and zero observations independently', () => {
  const dealers = history(), funds = history('leveraged-funds');
  funds.history = [{ reportDate: '2026-09-15', netPctOi: 4 }];
  const series = brokerCftcSeries({ dealer: dealers, 'leveraged-funds': funds }, { contract: '043602', window: '1y' });
  assert.deepEqual(series.rows, [{ date: '2026-09-01', dealer: -5, 'leveraged-funds': null }, { date: '2026-09-08', dealer: null, 'leveraged-funds': null }, { date: '2026-09-15', dealer: 0, 'leveraged-funds': 4 }]);
  assert.deepEqual(brokerCftcSeries({}, { contract: '043602' }).rows, []);
});

test('CFTC series reject contract, family and trader-group substitution', () => {
  assert.throws(() => brokerCftcSeries({ dealer: history() }, { contract: '042601' }));
  assert.throws(() => brokerCftcSeries({ dealer: history('leveraged-funds') }, { contract: '043602' }));
  assert.throws(() => brokerCftcSeries({ dealer: { ...history(), report_basis: 'combined' } }, { contract: '043602' }));
  assert.throws(() => brokerCftcSeries({ dealer: history() }, { contract: '043602', window: '5y' }));
});

test('CFTC chart breaks across absent weeks and preserves calendar spacing without inventing observations', () => {
  const value = history();
  value.history = [value.history[0], value.history[2]];
  const series = brokerCftcSeries({ dealer: value }, { contract: '043602' });
  assert.equal(series.rows.length, 2);
  assert.equal(series.chartRows.length, 3);
  assert.equal(series.chartRows[1].gap, true);
  assert.equal(series.chartRows[1].dealer, null);
  assert.equal(series.chartRows[2].time - series.chartRows[0].time, 14 * 86400000);
});

test('peer client reuses verified public results and does not cache private transient extracts', async () => {
  let calls = 0, timestamp = 0;
  const client = createBrokerPeerClient({ now: () => timestamp, fetchImpl: async path => {
    calls++; assert.equal(path, `/api/v1/analysis/${cik}?basis=annual`);
    return new Response(JSON.stringify(peer()), { headers: { 'cache-control': 'public, s-maxage=3600' } });
  } });
  await client(cik); await client(cik); assert.equal(calls, 1);
  timestamp = 300001; await client(cik); assert.equal(calls, 2);
  let privateCalls = 0;
  const transient = createBrokerPeerClient({ fetchImpl: async () => { privateCalls++; return new Response(JSON.stringify(peer()), { headers: { 'cache-control': 'private, no-store' } }); } });
  await transient(cik); await transient(cik); assert.equal(privateCalls, 2);
});

test('failed or substituted peer responses remain retryable and pre-aborted requests do not fetch', async () => {
  let calls = 0;
  const client = createBrokerPeerClient({ fetchImpl: async () => { calls++; return new Response(JSON.stringify(calls === 1 ? { ...peer(), cik: '0000320193' } : peer())); } });
  await assert.rejects(() => client(cik), /does not match/);
  await client(cik); assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => client(cik, { signal: controller.signal }));
  assert.equal(calls, 2);
});
