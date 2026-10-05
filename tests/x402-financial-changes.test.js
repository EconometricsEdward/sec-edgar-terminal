import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { createPaidFinancialChangesReader, paidFinancialChangesSelection } from '../src/utils/x402FinancialChanges.js';
import { X402_FINANCIAL_CHANGES_SCHEMA } from '../src/utils/x402FinancialChangesSchema.js';
import { ANALYSIS_VERSION, packAnalysisCompany } from '../src/utils/analysisResearch.js';
import { ANALYSIS_MAPPING_VERSION } from '../src/utils/analysisVersion.js';

const at = Date.parse('2026-10-04T15:00:00Z');
const select = query => paidFinancialChangesSelection(new Request(`https://secedgarterminal.com/api/x402/v1/financial-changes${query}`));
const quarterPeriods = [
  { kind: 'quarter', start: '2026-04-01', end: '2026-06-30', fy: 2026, fp: 'Q2' },
  { kind: 'quarter', start: '2026-01-01', end: '2026-03-31', fy: 2026, fp: 'Q1' },
  { kind: 'quarter', start: '2025-04-01', end: '2025-06-30', fy: 2025, fp: 'Q2' },
];
function input(period, value, tag, cik = '0000000100', instant = false) {
  const accession = `${cik}-${String(period.fy).slice(-2)}-000001`;
  return { taxonomy: 'us-gaap', tag, unit: 'USD', value, start: instant ? null : period.start, end: period.end,
    filed: `${period.fy}-08-01`, accession, form: '10-Q', sourceCik: cik, revised: false,
    documentUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/issuer.htm` };
}
function fixture(ticker = 'AAA', cik = '0000000100', periods = quarterPeriods) {
  const tags = { revenue: 'Revenues', netIncome: 'NetIncomeLoss', cash: 'CashAndCashEquivalentsAtCarryingValue', stockholdersEquity: 'StockholdersEquity' };
  const values = { revenue: [120, 999, 100], netIncome: [10, 999, -20], cash: [60, 999, 50], stockholdersEquity: [30, 999, 25] };
  const metrics = Object.fromEntries(Object.entries(values).map(([key, series]) => [key, periods.map((period, index) => {
    const source = input(period, series[index], tags[key], cik, ['cash', 'stockholdersEquity'].includes(key));
    return { value: series[index], classification: 'reported', reason: null, period, sources: [source], calculations: [],
      observationPeriod: { kind: source.start ? 'duration' : 'instant', start: source.start, end: source.end } };
  })]));
  metrics.operatingMargin = periods.map((period, index) => ({ value: [20, 999, 15][index], classification: 'calculated', reason: null,
    period, sources: [input(period, [24, 999, 15][index], 'OperatingIncomeLoss', cik), input(period, [120, 999, 100][index], 'Revenues', cik)],
    formula: 'Operating income / reported revenue × 100', calculations: [{ formula: 'Operating income / reported revenue × 100', value: [20, 999, 15][index], start: period.start, end: period.end, unit: '%' }] }));
  metrics.freeCashFlow = periods.map(period => ({ value: null, classification: 'unavailable', reason: 'Reported capital expenditures are missing.', period, sources: [], calculations: [] }));
  const definitions = Object.keys(metrics).map(key => ({ key, label: key === 'stockholdersEquity' ? "Stockholders' equity" : key,
    format: key === 'operatingMargin' ? 'percent' : 'currency', category: ['cash', 'stockholdersEquity'].includes(key) ? 'balance' : 'income',
    ...(key === 'operatingMargin' ? { formula: 'Operating income / reported revenue × 100' } : {}) }));
  const payload = packAnalysisCompany({ version: ANALYSIS_VERSION, mappingVersion: ANALYSIS_MAPPING_VERSION, ticker, cik,
    name: `Issuer ${ticker}`, lens: 'corporate', businessModel: 'corporate', basis: periods[0].kind, asOf: '', periods, definitions, metrics });
  return { payload, metadata: { fetchedAt: new Date(at - 60000).toISOString(), revalidatedAt: new Date(at - 30000).toISOString(),
    expiresAt: new Date(at + 60000).toISOString(), objectPath: 'private-storage-key' } };
}
const reader = financialRead => createPaidFinancialChangesReader({ financialRead, now: () => at });
const query = '?tickers=AAA&basis=quarter&metrics=revenue,netIncome,operatingMargin,cash,equity,freeCashFlow';

function parseCsv(csv) {
  const rows = [], row = []; let field = '', quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { field += '"'; index++; } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\r' && csv[index + 1] === '\n')) {
      row.push(field); field = '';
      if (char === '\r') { rows.push([...row]); row.length = 0; index++; }
    } else field += char;
  }
  assert.equal(quoted, false);
  return rows.slice(1).map(values => Object.fromEntries(rows[0].map((column, index) => [column, values[index]])));
}

test('selectors are bounded, reject duplicate/unknown parameters, and refuse overlapping sequential windows', () => {
  const defaults = select('?tickers=aaa,BBB');
  assert.deepEqual(defaults.tickers, ['AAA', 'BBB']);
  assert.equal(defaults.basis, 'annual'); assert.equal(defaults.comparison, 'year'); assert.equal(defaults.metrics.length, 11);
  for (const query of ['?tickers=', '?tickers=AAA,AAA', '?tickers=AAA&metrics=revenue,revenue', '?tickers=AAA&metrics=notReported',
    '?tickers=AAA&basis=quarter&basis=annual', '?tickers=AAA&asOf=2025-01-01', '?tickers=0000000100',
    '?tickers=AAA&metrics=', '?tickers=AAA&format=xml', '?tickers=AAA&basis=ytd&comparison=previous',
    '?tickers=AAA&basis=ttm&comparison=previous', `?tickers=${Array.from({ length: 11 }, (_, index) => `A${index}`).join(',')}`])
    assert.equal(select(query), null, query);
  assert.equal(select('?tickers=AAA&basis=quarter&comparison=previous&metrics=totalDebt').comparison, 'previous');
});

test('year comparisons align fiscal quarters and retain only requested current/prior evidence and source clocks', async () => {
  const calls = [];
  const response = await reader(async selection => { calls.push(selection); return fixture(); })(select(query));
  assert.equal(response.status, 200);
  const result = await response.json(), company = result.companies[0];
  assert.deepEqual(calls, [{ ticker: 'AAA', basis: 'quarter', asOf: '' }]);
  assert.equal(company.period.end, '2026-06-30'); assert.equal(company.comparisonPeriod.end, '2025-06-30');
  const revenue = company.metrics.find(metric => metric.key === 'revenue');
  assert.equal(revenue.current.value, 120); assert.equal(revenue.prior.value, 100);
  assert.deepEqual(revenue.change, { absoluteDelta: 20, growthPercent: 20, percentagePointDelta: null, deltaUnit: 'USD', comparable: true, reason: null });
  assert.deepEqual(revenue.current.observationPeriod, { kind: 'duration', start: '2026-04-01', end: '2026-06-30', dateBasis: 'metric-observation' });
  assert.equal(company.metrics.find(metric => metric.key === 'cash').current.observationPeriod.kind, 'instant');
  assert.equal(company.metrics.find(metric => metric.key === 'equity').modelKey, 'stockholdersEquity');
  assert.equal(company.fetchedAt, new Date(at - 60000).toISOString()); assert.equal(company.checkedAt, new Date(at - 30000).toISOString());
  assert.ok(company.sourceCatalog.every(source => source.end !== '2026-03-31'));
  assert.equal(JSON.stringify(result).includes('private-storage-key'), false); assert.equal(Object.hasOwn(company, 'model'), false);
  assert.equal(company.coverage.preparedHistoryPeriods, 3); assert.equal(company.coverage.comparableMetrics, 5);
  assert.equal(response.headers.get('x-schema-version'), 'edgar.paid-financial-changes.v1');
  const validate = new Ajv({ allErrors: true }).compile(X402_FINANCIAL_CHANGES_SCHEMA);
  assert.ok(validate(result), JSON.stringify(validate.errors));
  const altered = structuredClone(result); altered.companies[0].metrics[0].change.economicConclusion = 'invented';
  assert.equal(validate(altered), false, 'actual response schema rejects undeclared economic fields');
});

test('negative bases retain dollar changes, margins use percentage points, and missing observations remain explicit', async () => {
  const result = await (await reader(async () => fixture())(select(query))).json();
  const metrics = result.companies[0].metrics;
  const earnings = metrics.find(metric => metric.key === 'netIncome'), margin = metrics.find(metric => metric.key === 'operatingMargin');
  assert.equal(earnings.change.absoluteDelta, 30); assert.equal(earnings.change.growthPercent, null); assert.match(earnings.change.reason, /zero or negative/);
  assert.equal(margin.change.absoluteDelta, 5); assert.equal(margin.change.percentagePointDelta, 5); assert.equal(margin.change.growthPercent, null);
  assert.equal(margin.change.deltaUnit, 'percentage-points');
  const missing = metrics.find(metric => metric.key === 'freeCashFlow');
  assert.equal(missing.current.value, null); assert.equal(missing.current.observationPeriod, null);
  assert.match(missing.current.reason, /capital expenditures/); assert.deepEqual(missing.current.sourceIds, []); assert.equal(missing.change.comparable, false);
  const absent = await (await reader(async () => fixture())(select('?tickers=AAA&basis=quarter&metrics=revenue,totalDebt'))).json();
  assert.match(absent.companies[0].metrics[1].current.reason, /absent/);
});

test('actual flow duration, source unit and accounting-scope mismatches withhold change without inventing growth', async () => {
  const changes = [
    [envelope => { envelope.payload.sourceCatalog[envelope.payload.metrics.revenue[0].sourceIds[0]].start = '2026-06-01'; }, 'revenue', /actual reported flow durations/],
    [envelope => { envelope.payload.sourceCatalog[envelope.payload.metrics.revenue[0].sourceIds[0]].unit = 'EUR'; }, 'revenue', /units differ/],
    [envelope => { envelope.payload.sourceCatalog[envelope.payload.metrics.netIncome[2].sourceIds[0]].tag = 'ProfitLoss'; }, 'netIncome', /scopes differ/],
  ];
  for (const [mutate, key, reason] of changes) {
    const data = fixture(); mutate(data);
    const response = await reader(async () => data)(select(`?tickers=AAA&basis=quarter&metrics=${key},cash`));
    assert.equal(response.status, 200);
    const company = (await response.json()).companies[0], metric = company.metrics[0];
    assert.equal(metric.change.absoluteDelta, null); assert.equal(metric.change.growthPercent, null); assert.equal(metric.change.comparable, false);
    assert.match(metric.change.reason, reason); assert.equal(company.coverage.comparableMetrics, 1);
    const withoutCompatible = await reader(async () => data)(select(`?tickers=AAA&basis=quarter&metrics=${key}`));
    assert.equal(withoutCompatible.status, 404); assert.equal((await withoutCompatible.json()).code, 'NO_COMPARABLE_DATA');
  }
});

test('sequential quarters use the actual prior quarter, missing year baselines never substitute a adjacent period', async () => {
  const previous = await (await reader(async () => fixture())(select('?tickers=AAA&basis=quarter&comparison=previous&metrics=cash'))).json();
  assert.equal(previous.companies[0].comparisonPeriod.end, '2026-03-31'); assert.equal(previous.companies[0].metrics[0].prior.value, 999);
  const noYear = fixture('AAA', '0000000100', quarterPeriods.slice(0, 2));
  assert.equal((await reader(async () => noYear)(select('?tickers=AAA&basis=quarter&metrics=cash'))).status, 404);
});

test('year-to-date and derived four-quarter trailing changes retain nonoverlapping year baselines and actual calculation windows', async () => {
  for (const basis of ['ytd', 'ttm']) {
    const periods = quarterPeriods.map(period => ({ ...period, kind: basis,
      start: basis === 'ytd' ? `${period.fy}-01-01` : period.fp === 'Q1' ? `${period.fy - 1}-04-01` : `${period.fy - 1}-07-01` }));
    const data = fixture('AAA', '0000000100', periods);
    if (basis === 'ttm') for (const index of [0, 2]) {
      const period = periods[index], quarters = [['07-01', '09-30', period.fy - 1], ['10-01', '12-31', period.fy - 1], ['01-01', '03-31', period.fy], ['04-01', '06-30', period.fy]];
      const point = data.payload.metrics.revenue[index];
      point.classification = 'calculated'; point.formula = 'Sum of four compatible standalone quarters';
      point.sourceIds = quarters.map(([start, end, year]) => {
        data.payload.sourceCatalog.push(input({ ...period, fy: year, start: `${year}-${start}`, end: `${year}-${end}` }, index === 0 ? 30 : 25, 'Revenues'));
        return data.payload.sourceCatalog.length - 1;
      });
    }
    const response = await reader(async () => data)(select(`?tickers=AAA&basis=${basis}&metrics=revenue`));
    assert.equal(response.status, 200);
    const company = (await response.json()).companies[0], metric = company.metrics[0];
    assert.equal(company.comparisonPeriod.end, '2025-06-30'); assert.equal(metric.change.growthPercent, 20);
    assert.equal(metric.current.observationPeriod.start, periods[0].start);
    if (basis === 'ttm') { assert.equal(metric.current.classification, 'calculated'); assert.equal(metric.current.sourceIds.length, 4); }
  }
});

test('issuer aliases, cache misses and corrupt referenced evidence abort the entire purchase atomically', async () => {
  const selection = select('?tickers=AAA,BBB&basis=quarter&metrics=revenue');
  const aliases = await reader(async selected => fixture(selected.ticker))(selection);
  assert.equal(aliases.status, 400); assert.equal((await aliases.json()).code, 'DUPLICATE_ISSUER');
  assert.equal((await reader(async selected => selected.ticker === 'AAA' ? fixture() : null)(selection)).status, 503);
  const mutations = [
    data => { data.payload.metrics.revenue[0].sourceIds = [999999]; },
    data => { data.payload.sourceCatalog[data.payload.metrics.revenue[0].sourceIds[0]].documentUrl = 'https://untrusted.example/filing'; },
    data => { data.payload.metrics.revenue[0].value = '120'; },
    data => { data.payload.metrics.revenue[0].observationPeriod.end = '2025-06-30'; },
    data => { data.payload.metrics.revenue[0].unit = 'EUR'; },
    data => { data.payload.sourceCatalog[data.payload.metrics.revenue[0].sourceIds[0]].sourceCik = 1000000100; },
    data => { data.payload.calculationCatalog[0].formula = null; },
    data => { data.payload.sourceCatalog[data.payload.metrics.revenue[0].sourceIds[0]].filed = '2026-02-30'; },
  ];
  for (const mutate of mutations) {
    const good = fixture(), bad = fixture('BBB', '0000000200'); mutate(bad);
    const response = await reader(async selected => selected.ticker === 'AAA' ? good : bad)(select('?tickers=AAA,BBB&basis=quarter&metrics=revenue,operatingMargin'));
    assert.equal(response.status, 503);
    const body = await response.json(); assert.equal(body.code, 'DATA_NOT_PREPARED'); assert.equal(Object.hasOwn(body, 'companies'), false);
  }
});

test('CSV includes actual current/prior observations, source/calculation context and spreadsheet-safe text', async () => {
  const data = fixture(); data.payload.name = '=EXECUTE(), Inc.';
  const response = await reader(async () => data)(select(`${query}&format=csv`));
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/csv/);
  const rows = parseCsv(await response.text()), revenue = rows.find(row => row.metric === 'revenue'), margin = rows.find(row => row.metric === 'operatingMargin');
  assert.equal(rows.length, 6); assert.equal(revenue.name, "'=EXECUTE(), Inc.");
  assert.equal(JSON.parse(revenue.currentObservationPeriod).start, '2026-04-01'); assert.equal(JSON.parse(revenue.priorObservationPeriod).start, '2025-04-01');
  assert.equal(JSON.parse(revenue.currentSourceReferences)[0].unit, 'USD'); assert.match(JSON.parse(revenue.priorSourceReferences)[0].documentUrl, /^https:\/\/www\.sec\.gov\/Archives\//);
  assert.equal(JSON.parse(margin.currentCalculationReferences)[0].value, 20);
  assert.match(JSON.parse(margin.currentCalculationReferences)[0].formula, /Operating income/);
  assert.equal(margin.percentagePointDelta, '5'); assert.equal(margin.growthPercent, '');
  const earnings = rows.find(row => row.metric === 'netIncome'); assert.equal(earnings.priorValue, '-20'); assert.equal(earnings.growthPercent, '');
  assert.match(JSON.parse(revenue.limitations).join(' '), /not as-filed historical/);
});

test('stale clocks remain original and oversized compact evidence is rejected before delivery', async () => {
  const old = fixture(); old.metadata.expiresAt = new Date(at - 10000).toISOString();
  const response = await reader(async () => old)(select(query));
  assert.equal(response.headers.get('x-data-stale'), '1');
  const stale = await response.json(); assert.equal(stale.stale, true); assert.equal(stale.companies[0].freshUntil, old.metadata.expiresAt);
  const tickers = Array.from({ length: 10 }, (_, index) => `T${index}`);
  const large = reader(async selected => {
    const data = fixture(selected.ticker, String(100 + Number(selected.ticker.slice(1))).padStart(10, '0'));
    for (const index of [0, 2]) {
      const source = data.payload.sourceCatalog[data.payload.metrics.revenue[index].sourceIds[0]];
      data.payload.metrics.revenue[index].sourceIds = Array.from({ length: 128 }, (_, serial) => {
        data.payload.sourceCatalog.push({ ...source, tag: `RevenueComponent${serial}`, scopeNote: 'x'.repeat(1900) });
        return data.payload.sourceCatalog.length - 1;
      });
    }
    return data;
  });
  const result = await large(select(`?tickers=${tickers.join(',')}&basis=quarter&metrics=revenue`));
  assert.equal(result.status, 413); assert.equal((await result.json()).code, 'PRODUCT_TOO_LARGE');
});
