import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisCompany, packAnalysisCompany } from '../src/utils/analysisResearch.js';
import { createPublicAnalysisReader, publicAnalysisSelection, PUBLIC_ANALYSIS_MAX_BYTES } from '../src/utils/analysisPublicResearch.js';

const now = Date.parse('2026-09-16T12:00:00Z');
const iso = value => new Date(value).toISOString();
const metadata = { fetchedAt: iso(now - 3600000), revalidatedAt: iso(now - 60000), expiresAt: iso(now + 3600000) };
const annual = (val, year = 2025, instant = false, extra = {}) => ({ val,
  ...(instant ? {} : { start: `${year}-01-01` }), end: `${year}-12-31`, fy: year, fp: 'FY',
  form: '10-K', filed: `${year + 1}-02-01`, accn: `0000320193-${String(year + 1).slice(-2)}-000001`, ...extra });
function model(sic = 3571, basis = 'annual') {
  const tags = {
    Revenues: [annual(100, 2024), annual(110, 2024, false, { filed: '2026-02-01', accn: '0000320193-26-000001' }), annual(200.12345)],
    NetIncomeLoss: [annual(10, 2024), annual(30)],
    OperatingIncomeLoss: [annual(20, 2024), annual(50)],
    NetCashProvidedByUsedInOperatingActivities: [annual(20, 2024), annual(40)],
    PaymentsToAcquirePropertyPlantAndEquipment: [annual(0, 2024), annual(0)],
    Assets: [annual(800, 2023, true), annual(1000, 2024, true), annual(1200, 2025, true)],
    StockholdersEquity: [annual(80, 2023, true), annual(100, 2024, true), annual(140, 2025, true)],
    InterestIncomeExpenseNet: [annual(100)], NoninterestIncome: [annual(50)],
    Deposits: [annual(800, 2025, true)], LoansAndLeasesReceivableNetReportedAmount: [annual(600, 2025, true)],
    PremiumsEarnedNet: [annual(70)], InvestmentIncomeInterest: [annual(15)],
  };
  const facts = { 'us-gaap': Object.fromEntries(Object.entries(tags).map(([tag, values]) => [tag, { units: { USD: values } }])) };
  const payload = packAnalysisCompany(buildAnalysisCompany({ ticker: 'AAPL', cik: '0000320193', companyName: 'Fixture issuer', sic, facts, filings: [] }, { basis }));
  payload.observedAt = '2026-09-01T10:00:00Z';
  return payload;
}
const reader = (payload = model(), extra = {}) => createPublicAnalysisReader({ now: () => now,
  read: async () => ({ payload, metadata, ...extra }) });

test('public financial selectors accept four bases and bound dates without admitting workspace state', () => {
  assert.deepEqual(publicAnalysisSelection({ ticker: ' aapl ', end: 'latest' }, now), { ticker: 'AAPL', basis: 'annual', end: '', asOf: '' });
  for (const basis of ['annual', 'quarter', 'ytd', 'ttm']) assert.equal(publicAnalysisSelection({ ticker: 'BRK.B', basis }, now).basis, basis);
  for (const input of [null, [], { ticker: 'AAPL', basis: 'monthly' }, { ticker: '../AAPL' }, { ticker: ['AAPL'] },
    { ticker: 'AAPL', end: '2025-02-30' }, { ticker: 'AAPL', asOf: '2027-01-01' }, { ticker: 'AAPL', end: '2027-01-01' },
    { ticker: 'AAPL', end: ['2025-12-31'] }, { ticker: 'AAPL', view: 'scenarios' }, { ticker: 'AAPL', units: 'millions' }]) {
    assert.equal(publicAnalysisSelection(input, now), null);
  }
});

test('compact summary preserves reported precision, derived inputs, revisions and exact prepared clocks', async () => {
  const payload = model(), before = JSON.stringify(payload);
  const result = await reader(payload)({ ticker: 'AAPL' });
  assert.equal(result.status, 'ready');
  assert.equal(result.metrics.length, 6);
  const revenue = result.metrics.find(value => value.key === 'revenue');
  assert.equal(revenue.value, 200.12345); assert.equal(revenue.unit, 'USD');
  assert.equal(revenue.previous.value, 110); assert.equal(revenue.classification, 'reported');
  assert.ok(Math.abs(revenue.change.delta - 90.12345) < 1e-10);
  assert.equal(result.sourceCatalog[revenue.previous.sourceIds[0]].revised, true);
  assert.equal(result.sourceCatalog[revenue.previous.sourceIds[0]].filed, '2026-02-01');
  const fcf = result.metrics.find(value => value.key === 'freeCashFlow');
  assert.equal(fcf.value, 40); assert.equal(fcf.classification, 'calculated');
  assert.ok(fcf.formula); assert.ok(fcf.sourceIds.some(id => result.sourceCatalog[id].value === 0));
  const roe = result.metrics.find(value => value.key === 'roe');
  assert.equal(roe.unit, '%'); assert.equal(roe.value, 25);
  assert.ok(roe.sourceIds.some(id => result.sourceCatalog[id].end === '2024-12-31'));
  assert.equal(result.period.start, '2025-01-01'); assert.equal(result.period.end, '2025-12-31');
  assert.equal(result.comparisonPeriod.end, '2024-12-31');
  assert.equal(result.checkedAt, metadata.revalidatedAt); assert.equal(result.retrievedAt, metadata.fetchedAt);
  assert.equal(result.calculatedAt, iso(Date.parse(payload.observedAt))); assert.equal(result.freshUntil, metadata.expiresAt);
  assert.equal(result.stale, false); assert.equal(result.coverage.sourceInputsOmitted, 0);
  assert.ok(result.sourceCatalog.every(value => !Object.hasOwn(value, 'revisions') && value.url.startsWith('https://www.sec.gov/Archives/')));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 20 * 1024);
  assert.equal(JSON.stringify(payload), before, 'projection must not mutate the shared prepared model');
});

test('older reporting end is selected in memory and never substituted or persisted as another variant', async () => {
  const reads = [];
  const read = createPublicAnalysisReader({ now: () => now, read: async selection => {
    reads.push(selection); return { payload: model(), metadata };
  } });
  const result = await read({ ticker: 'AAPL', end: '2024-12-31' });
  assert.equal(result.period.end, '2024-12-31');
  assert.equal(result.metrics.find(value => value.key === 'revenue').value, 110);
  assert.match(result.limitations.join(' '), /does not create an as-filed historical vintage/);
  assert.match(result.summaryUrl, /end=2024-12-31/);
  const absent = await read({ ticker: 'AAPL', end: '2024-09-30' });
  assert.equal(absent.status, 'not-prepared'); assert.equal(absent.period, null);
  assert.deepEqual(reads, [{ ticker: 'AAPL', basis: 'annual', asOf: '' }, { ticker: 'AAPL', basis: 'annual', asOf: '' }]);
});

test('a filing cutoff never falls back to the current-vintage model or triggers a read', async () => {
  let reads = 0;
  const read = createPublicAnalysisReader({ now: () => now, read: async () => { reads++; throw new Error('must not read'); } });
  const result = await read({ ticker: 'AAPL', basis: 'ttm', asOf: '2025-08-01' });
  assert.equal(result.status, 'not-prepared'); assert.equal(result.asOf, '2025-08-01');
  assert.match(result.reason, /current-vintage values have not been substituted/); assert.equal(reads, 0);
});

test('cache misses, corruption and expiry fail closed without claiming that financial data does not exist', async () => {
  for (const read of [async () => null, async () => { throw new Error('outage'); }]) {
    const result = await createPublicAnalysisReader({ now: () => now, read })({ ticker: 'AAPL' });
    assert.equal(result.status, 'not-prepared'); assert.equal(result.metrics.length, 0);
    assert.match(result.limitations[0], /does not establish/);
  }
  for (const patch of [{ ticker: 'MSFT' }, { basis: 'quarter' }, { asOf: '2025-01-01' }, { version: 'old' }, { cik: '0000000000' }]) {
    assert.equal((await reader({ ...model(), ...patch })({ ticker: 'AAPL' })).status, 'not-prepared');
  }
  const expired = { fetchedAt: iso(now - 10 * 86400000), revalidatedAt: iso(now - 10 * 86400000), expiresAt: iso(now - 8 * 86400000) };
  assert.equal((await reader(model(), { metadata: expired })({ ticker: 'AAPL' })).status, 'not-prepared');
  const stale = { ...metadata, expiresAt: iso(now - 1) };
  assert.equal((await reader(model(), { metadata: stale })({ ticker: 'AAPL' })).stale, true);
  assert.equal((await reader(model(), { stale: true })({ ticker: 'AAPL' })).stale, true);
});

test('industry selection preserves bank denominators and point-in-time deposit observations', async () => {
  const result = await reader(model(6021))({ ticker: 'AAPL' });
  assert.equal(result.status, 'ready'); assert.equal(result.lens, 'banking');
  assert.equal(result.metrics.some(value => value.key === 'revenue'), false);
  assert.equal(result.metrics.find(value => value.key === 'bankRevenue').value, 150);
  const deposits = result.metrics.find(value => value.key === 'deposits');
  assert.equal(deposits.value, 800); assert.equal(deposits.observationPeriod.kind, 'instant');
  assert.equal(result.sourceCatalog[deposits.sourceIds[0]].start, null);
  assert.equal(result.metrics.find(value => value.key === 'equityAssets').observationPeriod.kind, 'instant');
  const insurance = await reader(model(6311))({ ticker: 'AAPL' });
  assert.equal(insurance.lens, 'insurance');
  assert.equal(insurance.metrics.some(value => value.key === 'operatingMargin'), false);
});

test('missing values stay null, negative comparison bases do not produce misleading growth', async () => {
  const data = model();
  data.metrics.netIncome[1].value = -10;
  data.metrics.revenue[0] = { value: null, classification: 'unavailable', reason: 'Custom tag unavailable', sourceIds: [], calculationIds: [] };
  const result = await reader(data)({ ticker: 'AAPL' });
  assert.equal(result.metrics.find(value => value.key === 'revenue').value, null);
  assert.equal(result.metrics.find(value => value.key === 'netIncome').change.percent, null);
  assert.match(result.metrics.find(value => value.key === 'netIncome').change.reason, /negative/);
});

test('arbitrary historical rows and revision histories are excluded while incomplete source evidence is rejected', async () => {
  const data = model();
  data.sourceCatalog.forEach(value => { value.revisions = Array.from({ length: 200 }, () => ({ ignored: 'x'.repeat(100) })); });
  const valid = await reader(data)({ ticker: 'AAPL' });
  assert.equal(valid.status, 'ready'); assert.ok(Buffer.byteLength(JSON.stringify(valid)) < 20 * 1024);
  const sourceId = data.metrics.revenue[0].sourceIds[0];
  data.sourceCatalog[sourceId].documentUrl = 'https://example.com/fake-evidence';
  const rejected = await reader(data)({ ticker: 'AAPL' });
  assert.equal(rejected.status, 'not-prepared'); assert.equal(rejected.metrics.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(rejected)) < PUBLIC_ANALYSIS_MAX_BYTES);
});

test('all four financial bases use only their exact prepared result', async () => {
  for (const basis of ['annual', 'quarter', 'ytd', 'ttm']) {
    const payload = model(3571, basis);
    const reads = [];
    const result = await createPublicAnalysisReader({ now: () => now, read: async selection => {
      reads.push(selection); return { payload, metadata };
    } })({ ticker: 'AAPL', basis });
    assert.equal(result.basis, basis); assert.deepEqual(reads, [{ ticker: 'AAPL', basis, asOf: '' }]);
    if (result.status === 'ready') assert.equal(result.period.kind, basis);
  }
});

test('source limits refuse a summary rather than silently dropping calculation inputs', async () => {
  const data = model(), original = data.sourceCatalog[data.metrics.revenue[0].sourceIds[0]];
  const ids = [];
  for (let i = 0; i < 100; i++) {
    ids.push(data.sourceCatalog.length);
    data.sourceCatalog.push({ ...original, tag: `SyntheticComponent${i}` });
  }
  data.metrics.revenue[0].sourceIds = ids.slice(0, 50);
  data.metrics.revenue[1].sourceIds = ids.slice(50);
  const result = await reader(data)({ ticker: 'AAPL' });
  assert.equal(result.status, 'not-prepared'); assert.equal(result.sourceCatalog.length, 0);
  assert.match(result.reason, /represented completely/);
});
