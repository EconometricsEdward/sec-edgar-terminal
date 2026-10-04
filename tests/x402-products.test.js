import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { createPaidProductReaders, paidProductSelection, paidCsvCell, X402_PRODUCT_RESPONSE_SCHEMAS } from '../src/utils/x402Products.js';
import { buildAnalysisCompany, packAnalysisCompany } from '../src/utils/analysisResearch.js';
import { buildUniverseSnapshot, UNIVERSE_METRICS } from '../src/utils/marketUniverse.js';
import { buildRefinancingWall } from '../src/utils/refinancing/projection.js';
import { extractRefinancingProfile, MATURITY_BUCKETS } from '../src/utils/refinancing/maturities.js';

const at = Date.parse('2026-10-04T15:00:00Z');
const selected = (kind, query = '') => paidProductSelection(new Request(`https://secedgarterminal.com/api/x402/v1/${kind}${query}`), kind);
function financialFixture(ticker = 'GS', basis = 'quarter') {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/analysis-gs-sec-facts.json', import.meta.url), 'utf8'));
  const payload = packAnalysisCompany(buildAnalysisCompany({ ...fixture, ticker, cik: String(fixture.cik).padStart(10, '0') }, { basis }));
  payload.secret = 'private-storage';
  return { payload, metadata: { fetchedAt: new Date(at - 60000).toISOString(), expiresAt: new Date(at + 60000).toISOString(), objectPath: 'private-storage' } };
}
function universeFixture() {
  const companies = Array.from({ length: 5 }, (_, index) => {
    const prior = Object.fromEntries(UNIVERSE_METRICS.map(metric => [metric.key, 10]));
    const current = Object.fromEntries(UNIVERSE_METRICS.map(metric => [metric.key, index === 4 ? null : 10 + (index < 2 ? 2 : index)]));
    const accession = `0000000100-26-${String(index).padStart(6, '0')}`;
    const comparison = { pointInTime: true, gapDays: 365,
      current: { metrics: current, filed: '2026-07-30', end: '2026-06-30', accession, factorSourceAccessions: [accession] },
      prior: { metrics: prior, end: '2025-06-30', factorSourceAccessions: ['0000000100-25-000001'] } };
    return { ticker: `T${index}`, name: index === 0 ? '=MALICIOUS(), Inc.' : `Issuer ${index}`, cik: String(100 + index), sic: '3674',
      cohorts: ['sector-technology'], researchGroup: { id: 'sector-technology' }, checkedAt: '2026-10-04T14:00:00Z', factsRetrievedAt: '2026-10-04T13:00:00Z',
      filingComparisons: { ttm: comparison, annual: comparison } };
  });
  return { ...buildUniverseSnapshot({ generatedAt: '2026-10-04T14:00:00Z', requested: 5, companies,
    groups: [{ id: 'sector-technology', label: 'Technology' }] }, {}, { now: new Date(at) }), cache_status: 'prepared' };
}
function creditFixture() {
  const companies = Array.from({ length: 3 }, (_, index) => {
    const accession = `000000000${index + 1}-26-000001`, facts = { 'us-gaap': {} };
    const observation = (val, start) => ({ val, end: '2025-12-31', filed: '2026-02-01', accn: accession, form: '10-K', ...(start ? { start } : {}) });
    MATURITY_BUCKETS.forEach((bucket, bucketIndex) => {
      if (index === 2 && bucketIndex > 0) return;
      facts['us-gaap'][`LongTermDebtMaturitiesRepaymentsOfPrincipal${bucket.suffix}`] = { units: { USD: [observation(100 * (index + 1))] } };
    });
    for (const [tag, val, start] of [['CashAndCashEquivalentsAtCarryingValue', 150], ['OperatingIncomeLoss', 90, '2025-01-01'], ['InterestExpense', 30, '2025-01-01']]) {
      facts['us-gaap'][tag] = { units: { USD: [observation(val, start)] } };
    }
    return { cik: String(index + 1).padStart(10, '0'), ticker: `D${index}`, name: `Debt issuer ${index}`, sic: '3571',
      observedAt: '2026-10-04T14:00:00Z', refinancing: extractRefinancingProfile({ cik: index + 1, facts }, { asOf: '2026-10-04' }) };
  });
  return buildRefinancingWall({ generatedAt: '2026-10-04T14:00:00Z', requested: companies.length, companies });
}

test('product selectors reject excessive, duplicate, unsupported and malformed selections', () => {
  assert.deepEqual(selected('financial-batch', '?tickers=gs,aapl'), { tickers: ['GS', 'AAPL'], basis: 'annual', format: 'json' });
  for (const query of ['', '?tickers=GS,GS', '?tickers=GS,', '?tickers=1', '?tickers=GS&tickers=AAPL', '?tickers=GS&asOf=2020-01-01',
    `?tickers=${Array.from({ length: 11 }, (_, i) => `A${i}`).join(',')}`, '?tickers=GS&format=parquet']) assert.equal(selected('financial-batch', query), null, query);
  for (const query of ['?min=NaN', '?min=1e9', '?min=10&max=2', '?metric=beta', '?basis=quarter', '?limit=101', '?offset=10000',
    '?snapshot=no', '?missing=zero', '?field=latest', '?sector=../x', '?min=1&min=2', '?max=']) assert.equal(selected('fundamental-screen', query), null, query);
  for (const query of ['?minDebt=-1', '?maxCashCoverage=-1', '?minInterestCoverage=Infinity', '?coverage=estimated', '?sort=rating', '?fresh=1']) assert.equal(selected('credit-screen', query), null, query);
  assert.equal(selected('unknown'), null);
});

test('a batch returns every validated company and preserves evidence without storage fields', async () => {
  const calls = [];
  const readers = createPaidProductReaders({ now: () => at, financialRead: async selection => { calls.push(selection); return financialFixture(selection.ticker, selection.basis); } });
  const response = await readers.financialBatch(selected('financial-batch', '?tickers=GS,AAPL&basis=quarter'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.companyCount, 2);
  assert.deepEqual(body.companies.map(row => row.model.ticker), ['GS', 'AAPL']);
  assert.ok(body.companies.every(row => row.model.sourceCatalog.length > 0));
  assert.equal(JSON.stringify(body).includes('private-storage'), false);
  assert.deepEqual(calls, [{ ticker: 'GS', basis: 'quarter', asOf: '' }, { ticker: 'AAPL', basis: 'quarter', asOf: '' }]);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('a missing batch member or corrupt evidence fails the entire purchase', async () => {
  const readers = createPaidProductReaders({ now: () => at, financialRead: async selection => selection.ticker === 'GS' ? financialFixture() : null });
  const response = await readers.financialBatch(selected('financial-batch', '?tickers=GS,AAPL&basis=quarter'));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'DATA_NOT_PREPARED');
  const bad = financialFixture();
  bad.payload.metrics[bad.payload.definitions[0].key][0].sourceIds = [999999];
  assert.equal((await createPaidProductReaders({ now: () => at, financialRead: async () => bad }).financialBatch(selected('financial-batch', '?tickers=GS&basis=quarter'))).status, 503);
});

test('financial CSV flattens metric-period rows with original definitions and SEC sources', async () => {
  const readers = createPaidProductReaders({ now: () => at, financialRead: async () => financialFixture() });
  const response = await readers.financialBatch(selected('financial-batch', '?tickers=GS&basis=quarter&format=csv'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  const text = await response.text();
  assert.match(text, /"sourceReferences"/);
  assert.match(text, /"calculationReferences"/);
  assert.match(text, /sec\.gov/);
  assert.match(text, /edgar\.paid-financial-batch\.v1/);
});

test('bounded deliveries fail with 413 before any paid response and stale clocks remain original', async () => {
  const oversized = financialFixture();
  oversized.payload.note = 'x'.repeat(4 * 1024 * 1024);
  const response = await createPaidProductReaders({ now: () => at, financialRead: async () => oversized })
    .financialBatch(selected('financial-batch', '?tickers=GS&basis=quarter'));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'PRODUCT_TOO_LARGE');
  const old = financialFixture();
  old.metadata.expiresAt = new Date(at - 10000).toISOString();
  const stale = await createPaidProductReaders({ now: () => at, financialRead: async () => old })
    .financialBatch(selected('financial-batch', '?tickers=GS&basis=quarter'));
  assert.equal(stale.headers.get('x-data-stale'), '1');
  const body = await stale.json();
  assert.equal(body.stale, true);
  assert.equal(body.companies[0].freshUntil, old.metadata.expiresAt);
});

test('fundamental screens filter, rank ties on the full sector and leave missing values explicit', async () => {
  const value = universeFixture();
  const readers = createPaidProductReaders({ now: () => at, universeRead: async () => value });
  const result = await (await readers.fundamentalScreen(selected('fundamental-screen', '?min=2&limit=2'))).json();
  assert.deepEqual(result.rows.map(row => row.ticker), ['T3', 'T0']);
  assert.equal(result.pagination.total, 4);
  assert.equal(result.rows[0].peerPercentile, 87.5);
  assert.equal(result.rows[1].peerPercentile, 37.5);
  assert.deepEqual(result.population, { companies: 5, metricEligible: 4, metricMissing: 1 });
  const included = await (await readers.fundamentalScreen(selected('fundamental-screen', '?missing=include&order=asc'))).json();
  assert.equal(included.rows.at(-1).selectedValue, null);
  assert.equal(included.rows.at(-1).peerPercentile, null);
  const bounded = await (await readers.fundamentalScreen(selected('fundamental-screen', '?missing=include&min=0'))).json();
  assert.equal(bounded.rows.length, 4, 'numeric filters never impute null');
});

test('screen tokens prevent data or criteria changes and allow page-size or format changes', async () => {
  let value = universeFixture();
  const readers = createPaidProductReaders({ now: () => at, universeRead: async () => value });
  const first = await (await readers.fundamentalScreen(selected('fundamental-screen', '?limit=2'))).json();
  const token = first.pagination.snapshot;
  const second = await readers.fundamentalScreen(selected('fundamental-screen', `?limit=1&offset=2&snapshot=${token}&format=csv`));
  assert.equal(second.status, 200);
  assert.match(await second.text(), /T1/);
  assert.equal((await readers.fundamentalScreen(selected('fundamental-screen', `?order=asc&snapshot=${token}`))).status, 409);
  value.rows[0].metrics.revenueGrowth.current += 1;
  value.rows[0].metrics.revenueGrowth.change += 1;
  assert.equal((await readers.fundamentalScreen(selected('fundamental-screen', `?snapshot=${token}`))).status, 409);
  assert.equal((await readers.fundamentalScreen(selected('fundamental-screen', '?offset=4'))).status, 416);
  assert.equal((await readers.fundamentalScreen(selected('fundamental-screen', '?min=100'))).status, 404);
  assert.equal((await readers.fundamentalScreen(selected('fundamental-screen', '?sector=unknown'))).status, 400);
});

test('screen readers reject non-retained, expired and invalid snapshots before delivery', async () => {
  for (const patch of [{ cache_status: 'computed-from-prepared-sec' }, { generated_at: '2026-09-01T00:00:00Z' }, { rows: [] }]) {
    assert.equal((await createPaidProductReaders({ now: () => at, universeRead: async () => ({ ...universeFixture(), ...patch }) })
      .fundamentalScreen(selected('fundamental-screen'))).status, 503);
  }
  assert.equal((await createPaidProductReaders({ now: () => at, refinancingRead: async () => ({ ...creditFixture(), sourceSnapshotAt: '2026-09-01T00:00:00Z' }) })
    .creditScreen(selected('credit-screen'))).status, 503);
});

test('credit screening uses reported principal, filing liquidity and explicit schedule completeness', async () => {
  const fixture = creditFixture();
  fixture.companies[0].objectPath = 'private-storage';
  fixture.companies[0].profile.objectPath = 'private-storage';
  const readers = createPaidProductReaders({ now: () => at, refinancingRead: async () => fixture });
  const all = await (await readers.creditScreen(selected('credit-screen'))).json();
  assert.deepEqual(all.rows.map(row => row.ticker), ['D2', 'D1', 'D0']);
  assert.deepEqual(all.rows.map(row => row.cashShortfallToNext12m), [150, 50, 0]);
  assert.equal(all.rows[0].profile.totalScheduled, null);
  assert.equal(JSON.stringify(all).includes('private-storage'), false);
  const filtered = await (await readers.creditScreen(selected('credit-screen', '?coverage=complete&minDebt=150&maxCashCoverage=1&minInterestCoverage=2'))).json();
  assert.deepEqual(filtered.rows.map(row => row.ticker), ['D1']);
  const csv = await readers.creditScreen(selected('credit-screen', '?format=csv&coverage=complete'));
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /next12m\.dateBasis/);
  assert.match(text, /cashToNext12m\.formula/);
  assert.match(text, /sec\.gov/);
  assert.equal((await readers.creditScreen(selected('credit-screen', '?minDebt=1000'))).status, 404);
});

test('CSV escaping prevents formula injection without corrupting negative numeric values', async () => {
  for (const input of ['=SUM(A1)', '+cmd', '-cmd', '@formula', '  =cmd', '\tcmd', '\r=cmd', '\ncmd', '\u0000=cmd']) assert.match(paidCsvCell(input), /^"'/, JSON.stringify(input));
  assert.equal(paidCsvCell(-12), '-12');
  assert.equal(paidCsvCell(null), '');
  assert.equal(paidCsvCell('a,"b"\nc'), '"a,""b""\nc"');
  const response = await createPaidProductReaders({ now: () => at, universeRead: async () => universeFixture() })
    .fundamentalScreen(selected('fundamental-screen', '?format=csv'));
  assert.match(await response.text(), /"'=MALICIOUS\(\), Inc\."/);
});

test('discovery schemas validate the actual serialized product responses and reject missing provenance', async () => {
  const readers = createPaidProductReaders({ now: () => at, financialRead: async () => financialFixture(), universeRead: async () => universeFixture(), refinancingRead: async () => creditFixture() });
  const cases = [
    ['financial-batch', await readers.financialBatch(selected('financial-batch', '?tickers=GS&basis=quarter'))],
    ['fundamental-screen', await readers.fundamentalScreen(selected('fundamental-screen'))],
    ['credit-screen', await readers.creditScreen(selected('credit-screen'))],
  ];
  const ajv = new Ajv({ allErrors: true });
  for (const [kind, response] of cases) {
    assert.equal(response.status, 200, kind);
    const body = await response.json(), validate = ajv.compile(X402_PRODUCT_RESPONSE_SCHEMAS[kind]);
    assert.equal(validate(body), true, `${kind}: ${JSON.stringify(validate.errors)}`);
    const missing = structuredClone(body);
    if (kind === 'financial-batch') delete missing.companies[0].model.sourceCatalog;
    else if (kind === 'fundamental-screen') delete missing.rows[0].source_accessions;
    else delete missing.rows[0].profile.sourceUrl;
    assert.equal(validate(missing), false, `${kind} must retain provenance`);
  }
});
