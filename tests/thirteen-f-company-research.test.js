import test from 'node:test';
import assert from 'node:assert/strict';
import { createThirteenFCompanyResearchLoader, normalize13FCompanyRequest } from '../src/utils/thirteenFCompanyResearchServer.js';
import { GET } from '../src/app/api/fund-13f/company/route.js';

const CIK = '0001747057', ISSUER_CIK = '0001579091', PERIOD = '2026-06-30', KEY = '565394103|SECURITY|SH';
const NOW = Date.parse('2026-09-15T12:00:00Z');
const holding = { key: KEY, cusip: '565394103', issuer: 'MAPLEBEAR INC', classTitle: 'COM', putCall: null, quantityType: 'SH', quantity: 100, valueUsd: 5000, weightPct: 25 };
const manager = { cik: CIK, name: 'Fixture Capital', submissionsUrl: `https://data.sec.gov/submissions/CIK${CIK}.json` };
const report = () => ({ manager, selectedPeriod: PERIOD, portfolio: { cik: CIK, period: PERIOD, holdings: [holding], complete: true }, coverage: { selectedPeriodComplete: true } });
const identity = () => ({ status: 'resolved', cusip: holding.cusip, securityType: 'equity',
  issuer: { cik: ISSUER_CIK, name: 'Maplebear Inc.', tickers: ['CART'], kind: 'company', sic: '7389', submissionsUrl: `https://data.sec.gov/submissions/CIK${ISSUER_CIK}.json` },
  evidence: [{ cik: ISSUER_CIK, cusips: [holding.cusip], form: 'SCHEDULE 13G', filingDate: '2026-02-01', url: 'https://www.sec.gov/Archives/edgar/data/1579091/000157909126000001/primary_doc.xml' }], reason: null });
const accession = year => `0001579091-${String(year + 1).slice(2)}-000001`;
const filing = (year = 2025) => ({ form: '10-K', filingDate: `${year + 1}-02-01`, reportDate: `${year}-12-31`, accession: accession(year), documentUrl: `https://www.sec.gov/Archives/edgar/data/1579091/${accession(year).replaceAll('-', '')}/annual.htm` });
const annual = (val, year = 2025, instant = false) => ({ val, end: `${year}-12-31`, ...(instant ? {} : { start: `${year}-01-01` }), fy: year, fp: 'FY', form: '10-K', filed: `${year + 1}-02-01`, accn: accession(year) });
const facts = () => ({ cik: Number(ISSUER_CIK), facts: { 'us-gaap': Object.fromEntries(Object.entries({
  Revenues: Array.from({ length: 6 }, (_, i) => annual(1000 + i * 100, 2020 + i)),
  NetIncomeLoss: [annual(60)],
  OperatingIncomeLoss: [annual(90)],
  NetCashProvidedByUsedInOperatingActivities: [annual(80)],
  PaymentsToAcquirePropertyPlantAndEquipment: [annual(20)],
  Assets: [annual(600, 2025, true)],
  CashAndCashEquivalentsAtCarryingValue: [annual(120, 2025, true)],
  LongTermDebtNoncurrent: [annual(200, 2025, true)],
}).map(([tag, values]) => [tag, { units: { USD: values } }])) } });
const company = () => ({ cik: ISSUER_CIK, name: 'Maplebear Inc.', sic: '7389', filings: [filing()], omittedRecords: 0 });
const loader = (options = {}) => createThirteenFCompanyResearchLoader({ portfolioLoader: async () => report(), identityLoader: async () => identity(), companyLoader: async () => company(), researchJson: async () => facts(), now: () => NOW, ...options });
const load = (options = {}) => loader(options)(CIK, { period: PERIOD, key: KEY });

test('Company research accepts one exact 13F security key and requires a calendar report quarter', () => {
  assert.deepEqual(normalize13FCompanyRequest('1747057', PERIOD, KEY), { cik: CIK, period: PERIOD, key: KEY });
  for (const key of ['', 'MAPLEBEAR', '565394103', '565394103|SECURITY|SH|extra', '565394103|PUT|USD', '565394103|security|SH', '../565394103|SECURITY|SH'])
    assert.throws(() => normalize13FCompanyRequest(CIK, PERIOD, key), { code: 'INVALID_HOLDING' });
  for (const period of ['', '2026-06-29', '2026-02-30']) assert.throws(() => normalize13FCompanyRequest(CIK, period, KEY), { code: 'INVALID_PERIOD' });
});

test('Company route rejects duplicate identities and caller supplied issuer parameters before loading SEC data', async () => {
  for (const query of [
    `cik=${CIK}&period=${PERIOD}&key=${encodeURIComponent(KEY)}&cik=99`,
    `cik=${CIK}&period=${PERIOD}&key=${encodeURIComponent(KEY)}&issuerCik=${ISSUER_CIK}`,
    `cik=${CIK}&period=${PERIOD}&key=${encodeURIComponent(KEY)}&key=${encodeURIComponent(KEY)}`,
    `cik=${CIK}&key=${encodeURIComponent(KEY)}`,
  ]) {
    const response = await GET(new Request(`https://example.test/api/fund-13f/company?${query}`));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
});

test('Company research loads only an actual holding belonging to the requested manager and quarter', async () => {
  let identityCalls = 0;
  const identityLoader = async () => { identityCalls++; return identity(); };
  for (const modify of [
    row => { row.manager.cik = '0000000099'; },
    row => { row.selectedPeriod = '2026-03-31'; },
    row => { row.portfolio.cik = '0000000099'; },
    row => { row.portfolio.period = '2026-03-31'; },
  ]) {
    await assert.rejects(load({ identityLoader, portfolioLoader: async () => { const row = structuredClone(report()); modify(row); return row; } }), { code: 'REPORT_IDENTITY_MISMATCH' });
  }
  await assert.rejects(load({ identityLoader, portfolioLoader: async () => ({ ...report(), portfolio: { ...report().portfolio, holdings: [] } }) }), { code: 'HOLDING_NOT_FOUND' });
  assert.equal(identityCalls, 0);
});

test('Unresolved holdings never trigger company facts or ticker guesses', async () => {
  const unknown = { status: 'unresolved', cusip: holding.cusip, issuer: null, securityType: 'equity', evidence: [], reason: 'No verified SEC issuer match.' };
  const noResearch = async () => { throw new Error('Unresolved security triggered company research'); };
  const result = await load({ identityLoader: async () => unknown, companyLoader: noResearch, researchJson: noResearch });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.identity.issuer, null);
  assert.deepEqual(result.financials.metrics, []);
  assert.deepEqual(result.filings, []);
  assert.equal(result.holding.key, KEY);
});

test('Verified issuer research requests the SEC CIK from evidence and keeps the current research date separate', async () => {
  const calls = [];
  const result = await load({
    identityLoader: async (actual, options) => { assert.equal(actual, holding); assert.equal(options.period, PERIOD); return identity(); },
    companyLoader: async cik => { calls.push(cik); return company(); },
    researchJson: async path => { calls.push(path); return facts(); },
  });
  assert.deepEqual(calls, [ISSUER_CIK, `/api/xbrl/companyfacts/CIK${ISSUER_CIK}.json`]);
  assert.equal(result.selectedPeriod, PERIOD);
  assert.equal(result.financials.asOf, '2026-09-15');
  assert.equal(result.observedAt, '2026-09-15T12:00:00.000Z');
  assert.equal(result.status, 'ready');
  assert.equal(result.financials.status, 'ready');
  assert.equal(result.financials.lens, 'corporate');
  assert.match(result.financials.note, /separate from the manager/);
});

test('Company fundamentals retain four chronological annual periods, six metrics, provenance and missing values', async () => {
  const result = await load();
  const financials = result.financials;
  assert.deepEqual(financials.periods.map(period => period.end), ['2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31']);
  assert.equal(financials.metrics.length, 6);
  assert.deepEqual(financials.metrics.map(metric => metric.key), ['revenue', 'netIncome', 'operatingCashFlow', 'freeCashFlow', 'operatingMargin', 'longTermDebt']);
  assert.equal(financials.metrics.find(metric => metric.key === 'operatingMargin').format, 'percent');
  assert.equal(financials.metrics.find(metric => metric.key === 'operatingMargin').points.at(-1).value, 6);
  const freeCash = financials.metrics.find(metric => metric.key === 'freeCashFlow');
  assert.equal(freeCash.points[3].value, 60);
  assert.equal(freeCash.points[3].sources.length, 2);
  assert.equal(freeCash.points[3].sources[0].url, filing().documentUrl);
  assert.equal(freeCash.points[0].value, null);
  assert.match(freeCash.points[0].reason, /input|reported|compatible/i);
  assert.equal(result.facts, undefined);
  assert.equal(result.portfolio, undefined);
  assert.ok(JSON.stringify(result).length < 30000);
});

test('Unretrievable company facts preserve the verified company and its recent SEC filings', async () => {
  const result = await load({ researchJson: async () => { throw new Error('Internal secret transport detail'); } });
  assert.equal(result.status, 'ready');
  assert.equal(result.identity.issuer.cik, ISSUER_CIK);
  assert.equal(result.financials.status, 'unavailable');
  assert.equal(result.filings.length, 1);
  assert.equal(result.filings[0].documentUrl, filing().documentUrl);
  assert.equal(JSON.stringify(result).includes('Internal secret'), false);
});

test('Mismatched company fact identity is discarded instead of leaking another issuer’s financials', async () => {
  const result = await load({ researchJson: async () => ({ ...facts(), cik: 99 }) });
  assert.equal(result.financials.status, 'unavailable');
  assert.deepEqual(result.financials.metrics, []);
  assert.equal(result.identity.issuer.cik, ISSUER_CIK);
  assert.equal(result.filings.length, 1);
});

test('Failed issuer submissions preserve independently verified company facts and avoid misleading filing links', async () => {
  const result = await load({ companyLoader: async () => ({ ...company(), cik: '0000000099', name: 'Wrong issuer' }) });
  assert.equal(result.financials.status, 'ready');
  assert.deepEqual(result.filings, []);
  assert.equal(JSON.stringify(result).includes('Wrong issuer'), false);
  assert.match(result.issues.join(' '), /filings could not be retrieved/);
});

test('CUSIP and explicit issuer evidence must agree before any issuer research request', async () => {
  let calls = 0;
  const companyLoader = async () => { calls++; return company(); };
  for (const modify of [
    row => { row.cusip = '123456789'; },
    row => { row.issuer.cik = '0000000000'; },
    row => { row.evidence[0].cik = '0000000099'; },
    row => { row.evidence[0].cusips = ['123456789']; },
  ]) {
    await assert.rejects(load({ companyLoader, identityLoader: async () => { const row = identity(); modify(row); return row; } }), { code: 'ISSUER_IDENTITY_MISMATCH' });
  }
  assert.equal(calls, 0);
});

test('Bank research uses bank revenue and deposit/loan metrics, without an invented corporate margin', async () => {
  const bankFacts = facts();
  bankFacts.facts['us-gaap'].InterestIncomeExpenseNet = { units: { USD: [annual(70)] } };
  bankFacts.facts['us-gaap'].NoninterestIncome = { units: { USD: [annual(30)] } };
  const result = await load({ companyLoader: async () => ({ ...company(), sic: '6021' }), researchJson: async () => bankFacts });
  assert.equal(result.financials.lens, 'banking');
  assert.deepEqual(result.financials.metrics.map(metric => metric.key), ['bankRevenue', 'netIncome', 'roe', 'cash', 'deposits', 'loans']);
  assert.equal(result.financials.metrics[0].points.at(-1).value, 100);
});

test('The recent issuer filing list is bounded and excludes future, unrelated form and unsafe URL rows', async () => {
  const filings = Array.from({ length: 20 }, (_, index) => ({ ...filing(), accession: `0001579091-26-${String(index).padStart(6, '0')}` }));
  filings.push({ ...filing(), filingDate: '2027-01-01' }, { ...filing(), form: 'SCHEDULE 13G' }, { ...filing(), documentUrl: 'https://evil.example/annual.htm' });
  const result = await load({ companyLoader: async () => ({ ...company(), filings }) });
  assert.equal(result.filings.length, 12);
  assert.ok(result.filings.every(row => row.form === '10-K' && row.filingDate <= '2026-09-15' && row.documentUrl.startsWith('https://www.sec.gov/')));
});

test('Pre-aborted panel requests stop before loading the manager portfolio', async () => {
  let called = false;
  const signal = AbortSignal.abort(new DOMException('Panel closed', 'AbortError'));
  await assert.rejects(loader({ portfolioLoader: async () => { called = true; return report(); } })(CIK, { period: PERIOD, key: KEY, signal }), { name: 'AbortError' });
  assert.equal(called, false);
});
