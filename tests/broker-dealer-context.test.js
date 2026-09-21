import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerSourceUrl, validateBrokerPeer, brokerPeerRow, compareBrokerPeriods, brokerCftcSeries, createBrokerPeerClient, brokerReportIdentity, brokerComparisonFit, brokerReportPeriodKey } from '../src/utils/brokerDealerContext.js';

const cik = '0001690976', accession = '0001690976-26-000005';
const source = { url: 'https://www.sec.gov/Archives/edgar/data/1690976/000169097626000005/ASLCMIPUBLICFSJUNE2026.pdf', page: 6 };
const classification = (family = 'annual-report', parts = ['Part III'], frequency = 'annual') => ({ version: 1, family, parts, period: { frequency, end: '2026-06-30' }, audit: { status: 'auditor-report-present', scope: 'financial-condition' }, components: ['financial-condition', 'auditor-report'] });
const peer = () => ({ status: 'available', company: { cik, name: 'Example Broker' }, filing: { accession, reportDate: '2026-06-30' }, classification: classification(), analysis: { status: 'partial', cik, name: 'Example Broker', accession, periodEnd: '2026-06-30', metrics: [{ id: 'totalAssets', label: 'Assets', value: 1000, unit: 'USD', periodEnd: '2026-06-30', source }], ratios: [{ id: 'assetsToEquity', value: 10, periodEnd: '2026-06-30', sources: [source] }] } });
const history = (group = 'dealer') => ({ report_family: 'tff', report_basis: 'futures_only', selection: { contract: '043602', group, report_date: '2026-09-15', history_window: '1y', required_prior_reports: 52 }, selected: { code: '043602', reportDate: '2026-09-15', selectedGroup: { id: group } }, percentile: { required: 52 }, history: [{ reportDate: '2026-09-01', netPctOi: -5 }, { reportDate: '2026-09-08', netPctOi: null }, { reportDate: '2026-09-15', netPctOi: 0 }] });

test('peer identity rejects substituted registrants, accession, missing source periods and unavailable reports', () => {
  assert.equal(validateBrokerPeer(peer(), cik).company.cik, cik);
  for (const update of [{ company: { cik: '0000320193', name: 'Parent' } }, { filing: { accession: '' } }, { analysis: { ...peer().analysis, periodEnd: '2026-02-30' } }, { analysis: { ...peer().analysis, accession: '0001690976-25-000001' } }, { status: 'unavailable' }]) {
    assert.throws(() => validateBrokerPeer({ ...peer(), ...update }, cik));
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
  value.analysis.metrics.push({ id: 'totalEquity', value: -20, unit: 'USD', periodEnd: value.analysis.periodEnd, source });
  value.analysis.metrics.push({ id: 'netCapital', value: 0, unit: 'USD', periodEnd: value.analysis.periodEnd, source });
  const row = brokerPeerRow(value, cik);
  assert.equal(row.measures.totalEquity.value, -20);
  assert.equal(row.measures.netCapital.value, 0);
  assert.equal(row.measures.assetsToEquity.value, 10);
  assert.equal(row.measures.netCapitalToRequired, undefined);
  assert.equal(brokerPeerRow(value, '0000320193'), null);
  value.analysis.metrics[0].periodEnd = '2025-06-30';
  value.analysis.ratios[0].sources = [{ ...source, url: source.url.replace('/1690976/', '/320193/') }];
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
    calls++; assert.equal(path, `/api/broker-dealer/report?cik=${cik}`);
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
  const client = createBrokerPeerClient({ fetchImpl: async () => { calls++; return new Response(JSON.stringify(calls === 1 ? { ...peer(), company: { cik: '0000320193', name: 'Parent' } } : peer())); } });
  await assert.rejects(() => client(cik), /does not match/);
  await client(cik); assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => client(cik, { signal: controller.signal }));
  assert.equal(calls, 2);
});


test('report identity preserves source-defined family and audit scope without assuming annual means audited', () => {
  assert.equal(brokerReportIdentity(peer()).label, 'Annual report');
  assert.equal(brokerReportIdentity(peer()).auditScope, 'Financial condition only');
  assert.equal(brokerReportIdentity({ classification: { family: 'annual-report' } }).auditLabel, 'Audit status not established');
  const identity = brokerReportIdentity({ analysis: { classification: classification('periodic-focus', ['Part IIA'], 'quarterly') }, filing: { classification: classification() } });
  assert.equal(identity.family, 'periodic-focus');
  assert.deepEqual(identity.parts, ['Part IIA']);
  assert.equal(brokerReportIdentity({ filing: { form: 'X-17A-5', reportDate: '2026-06-30' } }).family, 'unknown');
});

test('comparison separates annual, periodic, unknown parts and different frequencies', () => {
  const report = (family, parts, frequency) => ({ classification: classification(family, parts, frequency) });
  const annual = report('annual-report', ['Part III'], 'annual');
  const quarterly = report('periodic-focus', ['Part II'], 'quarterly');
  assert.equal(brokerComparisonFit(annual, annual).compatible, true);
  assert.equal(brokerComparisonFit(annual, quarterly).compatible, false);
  assert.equal(brokerComparisonFit(annual, {}).compatible, false);
  assert.equal(brokerComparisonFit({}, {}).compatible, false);
  assert.equal(brokerComparisonFit(quarterly, report('periodic-focus', ['Part IIA'], 'quarterly')).compatible, false);
  assert.equal(brokerComparisonFit(quarterly, report('periodic-focus', ['Schedule I'], 'quarterly')).compatible, false);
  assert.equal(brokerComparisonFit(quarterly, report('periodic-focus', ['Part II'], 'monthly')).compatible, false);
  assert.equal(brokerComparisonFit(quarterly, report('periodic-focus', [], 'quarterly')).compatible, false);
  assert.equal(brokerComparisonFit(quarterly, report('periodic-focus', ['Part II'], 'unknown')).compatible, false);
  assert.equal(brokerComparisonFit(quarterly, quarterly).compatible, true);
});

test('annual stub periods cannot silently enter an annual comparison', () => {
  const annual = { classification: classification() }, stub = { classification: classification() };
  annual.classification.period.start = '2025-07-01';
  stub.classification.period.start = '2026-04-01';
  assert.equal(brokerComparisonFit(annual, stub).compatible, false);
  stub.classification.period.start = '2025-07-02';
  assert.equal(brokerComparisonFit(annual, stub).compatible, true);
  stub.classification.period.frequency = 'quarterly';
  assert.equal(brokerComparisonFit(annual, stub).compatible, false);
});

test('same-date FOCUS parts and unknown reports retain distinct period keys', () => {
  const make = (parts, accessionNumber) => ({ classification: { ...classification('periodic-focus', parts, 'quarterly'), period: { frequency: 'quarterly', start: '2026-04-01', end: '2026-06-30' } }, accessionNumber, reportDate: '2026-06-30' });
  assert.notEqual(brokerReportPeriodKey(make(['Part II'], 'a')), brokerReportPeriodKey(make(['Part IIA'], 'b')));
  assert.notEqual(brokerReportPeriodKey(make(['Part II'], 'a')), brokerReportPeriodKey(make(['Schedule I'], 'c')));
  assert.equal(brokerReportPeriodKey(make(['Part II'], 'a')), brokerReportPeriodKey(make(['Part II'], 'a-amendment')));
  assert.notEqual(brokerReportPeriodKey({ accession: 'a', reportDate: '2026-06-30' }), brokerReportPeriodKey({ accession: 'b', reportDate: '2026-06-30' }));
  const noStart = make(['Part II'], 'unknown-start'); delete noStart.classification.period.start;
  assert.equal(brokerReportPeriodKey(noStart), 'accession:unknown-start');
});
