import test from 'node:test';
import assert from 'node:assert/strict';
import { isRiskBankPeerResult, riskBankPeerView, riskBankPeerMetric, riskBankPeerSourceUrl } from '../src/app/risk/riskBankPeers.js';

const period = '2026-06-30';
const bank = (rssd, value = 0) => ({ rssd, cert: rssd, name: `BANK ${rssd}`, assets: 100000, cblr: false,
  metrics: { leverage: value, cet1: value, noncurrent: value, chargeoffs: value, loansDeposits: value, brokered: value, roa: value, nim: value } });
const fixture = () => ({ period, status: 'ready', universeCount: 1000, eligibleCount: 900, assetBand: 4,
  snapshot: { id: 'snapshot-1', report_date: period, model_version: 'bankscope-peers-3', source_url: 'https://api.fdic.gov/banks/financials?test', created_at: '2026-09-30T00:00:00Z' },
  bank: bank(101), peers: [0, 1, 2, 3, 4].map((value, index) => bank(200 + index, value)), benchmarks: [] });

test('bank peers bind legal-bank identity, selected quarter, current definitions and subject exclusion', () => {
  const data = fixture();
  assert.equal(isRiskBankPeerResult(data, '101', period), true);
  assert.equal(riskBankPeerView(data, '102', period), null);
  assert.equal(riskBankPeerView(data, '101', '2026-03-31'), null);
  assert.equal(riskBankPeerView({ ...data, snapshot: { ...data.snapshot, report_date: '2026-03-31' } }, '101', period), null);
  assert.equal(riskBankPeerView({ ...data, snapshot: { ...data.snapshot, model_version: 'bankscope-peers-2' } }, '101', period), null);
  assert.equal(riskBankPeerView({ ...data, peers: [...data.peers, data.bank] }, '101', period), null);
  assert.equal(riskBankPeerView({ ...data, peers: [...data.peers, data.peers[0]] }, '101', period), null);
  assert.equal(riskBankPeerView({ ...data, peers: Array.from({ length: 31 }, (_, index) => bank(300 + index)) }, '101', period), null);
});

test('bank peer median and IQR use FDIC subject values, valid reporting peers and five-value threshold', () => {
  const data = fixture();
  // Extraneous card values must never replace the same-snapshot FDIC subject.
  data.ffiec = { leverage_ratio: 99 };
  const view = riskBankPeerView(data, '101', period), metric = riskBankPeerMetric(view.metrics, 'leverage');
  assert.equal(metric.value, 0);
  assert.equal(metric.available, true);
  assert.equal(metric.count, 5);
  assert.equal(metric.median, 2);
  assert.equal(metric.q1, 1);
  assert.equal(metric.q3, 3);
  assert.equal(metric.percentile, 10);
  data.peers[0].metrics.leverage = null;
  const sparse = riskBankPeerView(data, '101', period).metrics.find(row => row.key === 'leverage');
  assert.equal(sparse.count, 4);
  assert.equal(sparse.available, false);
  assert.equal(sparse.median, undefined);
  assert.equal(sparse.peers.length, 4);
});

test('capital dots exclude CBLR and unknown-framework placeholders independently from other metrics', () => {
  const data = fixture();
  data.bank.cblr = true;
  data.peers[0].cblr = true;
  data.peers[1].cblr = null;
  const view = riskBankPeerView(data, '101', period);
  const capital = view.metrics.find(row => row.key === 'cet1');
  assert.equal(capital.value, null);
  assert.equal(capital.notRequired, true);
  assert.equal(capital.count, 3);
  assert.equal(capital.available, false);
  assert.deepEqual(capital.peers.map(peer => peer.rssd), [202, 203, 204]);
  assert.equal(view.metrics.find(row => row.key === 'leverage').count, 5);
  data.bank.cblr = null;
  const unknown = riskBankPeerView(data, '101', period).metrics.find(row => row.key === 'cet1');
  assert.equal(unknown.value, null);
  assert.equal(unknown.notRequired, false);
  assert.equal(unknown.frameworkUnverified, true);
});

test('missing metrics remain unavailable, while zero and negative recoveries remain reported', () => {
  const data = fixture();
  data.bank.metrics.chargeoffs = -0.15;
  delete data.bank.metrics.noncurrent;
  const view = riskBankPeerView(data, '101', period);
  assert.equal(view.metrics.find(metric => metric.key === 'chargeoffs').value, -0.15);
  assert.equal(view.metrics.find(metric => metric.key === 'noncurrent').value, null);
  assert.equal(view.metrics.find(metric => metric.key === 'brokered').value, 0);
  assert.equal(view.metrics.some(metric => ['nonaccrual_share', 'allowance_share', 'fhlb_share'].includes(metric.key)), false);
  assert.equal(riskBankPeerMetric(view.metrics, 'noncurrent').key, 'noncurrent');
  assert.equal(riskBankPeerMetric(view.metrics, 'missing').key, 'leverage');
  assert.equal(riskBankPeerMetric([], 'missing'), null);
  assert.equal(riskBankPeerView({ ...data, bank: { ...data.bank, metrics: { leverage: Infinity } } }, '101', period), null);
});

test('missing quarterly publications are an empty state and stale/expanded publication context is retained', () => {
  const empty = { period, status: 'preparing', snapshot: null, bank: null, peers: [], benchmarks: [], universeCount: 0, eligibleCount: 0 };
  assert.deepEqual(riskBankPeerView(empty, '101', period).metrics, []);
  assert.equal(riskBankPeerView({ ...empty, peers: [bank(200)] }, '101', period), null);
  const data = { ...fixture(), assetBand: 8, publicPeerCache: { stale: true, checkedAt: '2026-09-30T00:00:00Z' } };
  const view = riskBankPeerView(data, '101', period);
  assert.equal(view.assetBand, 8);
  assert.equal(view.publicPeerCache.stale, true);
  assert.equal(view.snapshot.report_date, period);
});

test('peer source links only accept the official FDIC HTTPS host', () => {
  assert.equal(riskBankPeerSourceUrl(fixture().snapshot), 'https://api.fdic.gov/banks/financials?test');
  for (const url of ['http://api.fdic.gov/banks', 'https://api.fdic.gov.attacker.example/', 'javascript:alert(1)', '/relative', null]) {
    assert.equal(riskBankPeerSourceUrl({ source_url: url }), null);
  }
});
