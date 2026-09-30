import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { buildAnalysisCompany, packAnalysisCompany, unpackAnalysisCompany } from '../src/utils/analysisResearch.js';
import { adaptPreparedAnalysisEnvelope } from '../src/utils/analysisMappingCompatibility.js';
import { analysisCashScopeNote, analysisDebtScopeNote, ANALYSIS_INSURANCE_LENS_NOTE } from '../src/utils/analysisMappingPresentation.js';
import { readPreparedAnalysis, createFinancialPayloadCache } from '../src/utils/preparedFinancialData.js';
import { ANALYSIS_MAPPING_VERSION } from '../src/utils/analysisVersion.js';

const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const entry = (value, year, instant = false) => ({ val: value, ...(instant ? {} : { start: `${year}-01-01` }),
  end: `${year}-12-31`, fy: year, fp: 'FY', form: '10-K', filed: `${year + 1}-02-01`, accn: `0000320193-${String(year + 1).slice(-2)}-000001` });
function company({ sic = 3571, cash = 'CashAndCashEquivalentsAtCarryingValue' } = {}) {
  const tags = { Assets: [1000, true], StockholdersEquity: [200, true], NetIncomeLoss: [20], Revenues: [100],
    [cash]: [0, true], DebtCurrent: [12, true], LongTermDebtCurrent: [10, true], LongTermDebtNoncurrent: [30, true],
    OperatingIncomeLoss: [25], InsurancePremiumsRevenue: [80] };
  return { ticker: 'AAPL', cik: '0000320193', companyName: 'Compatibility fixture', sic, filings: [],
    facts: { 'us-gaap': Object.fromEntries(Object.entries(tags).map(([tag, [value, instant]]) => [tag,
      { units: { USD: [entry(value, 2025, instant), entry(value, 2024, instant)] } }])) } };
}
// Construct the known v2 presentation shape around unchanged source-backed
// values. Real v2 captures are replayed separately below; no fixture is served.
function legacyFrom(fresh) {
  const old = clone(fresh);
  old.mappingVersion = 'analysis-mappings-v2';
  for (const source of old.sourceCatalog) {
    if (source.scopeNote === analysisCashScopeNote(source.tag)) delete source.scopeNote;
    const prefix = analysisDebtScopeNote();
    if (source.scopeNote?.startsWith(prefix)) source.scopeNote = source.scopeNote.slice(prefix.length);
  }
  for (const [key, points] of Object.entries(old.metrics)) for (const point of points) {
    if (key === 'cash') delete point.note;
    if (key === 'totalDebt' && point.note?.startsWith(analysisDebtScopeNote())) point.note = point.note.slice(analysisDebtScopeNote().length);
  }
  for (const definition of old.definitions) {
    if (definition.key === 'cash') definition.label = 'Cash and equivalents';
    if (definition.key === 'totalDebt') definition.label = 'Total reported debt';
  }
  return old;
}
const freshFixture = options => clone(packAnalysisCompany(buildAnalysisCompany(company(options), { basis: 'annual', asOf: '' })));
const oldFixture = options => legacyFrom(freshFixture(options));
const metadata = () => ({ fetchedAt: new Date(Date.now() - 120000).toISOString(), revalidatedAt: new Date(Date.now() - 60000).toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(), generation: '9007199254740993', versionId: 'original-v2-snapshot', entityId: '0000320193' });
const adapt = payload => adaptPreparedAnalysisEnvelope({ payload, metadata: metadata() });
const sources = (data, point) => point.sourceIds.map(id => data.sourceCatalog[id]);

test('v3 passes through by identity and unknown schema/mapping revisions fail closed', () => {
  const payload = freshFixture(), envelope = { payload, metadata: metadata(), serializedPayload: 'unchanged current bytes' };
  assert.equal(adaptPreparedAnalysisEnvelope(envelope), envelope);
  for (const change of [{ mappingVersion: 'analysis-mappings-v1' }, { mappingVersion: 'analysis-mappings-v4' },
    { mappingVersion: 'unknown' }, { version: 'analysis-v1.5:context-v3' }, { asOf: '2025-12-31' }, { extraFutureField: true }]) {
    assert.equal(adapt({ ...oldFixture(), ...change }), null);
  }
});

test('adaptation changes only presentation, keeps real zero/missing, and matches fresh source annotations', () => {
  for (const options of [{}, { sic: 6021, cash: 'CashAndDueFromBanks' }, { cash: 'Cash' }, { sic: 6311 }]) {
    const fresh = freshFixture(options), old = legacyFrom(fresh), original = clone(old);
    const data = adapt(freeze(old)).payload;
    assert.deepEqual(old, original);
    assert.equal(data.mappingVersion, ANALYSIS_MAPPING_VERSION);
    assert.equal(data.mappingCompatibility.fromMappingVersion, 'analysis-mappings-v2');
    assert.equal(data.mappingCompatibility.financialValuesRecomputed, false);
    assert.deepEqual(data.periods, old.periods);
    assert.equal(data.observedAt, old.observedAt);
    assert.deepEqual(data.calculationCatalog, old.calculationCatalog);
    assert.equal(data.metrics.cash[0].value, 0);
    assert.equal(data.metrics.capex[0].value, null);
    assert.deepEqual(data.sourceCatalog.slice(0, old.sourceCatalog.length), old.sourceCatalog);
    const actual = unpackAnalysisCompany(data), expected = unpackAnalysisCompany(fresh);
    assert.deepEqual(actual.metrics, expected.metrics);
    assert.deepEqual(actual.definitions, expected.definitions);
    for (const key of Object.keys(data.metrics)) assert.deepEqual(data.metrics[key].map(p => p.value), old.metrics[key].map(p => p.value));
  }
});

test('insurer operating earnings row and references are removed, with raw evidence retained', () => {
  const old = oldFixture({ sic: 6311 });
  old.metrics.operatingIncome = clone(old.metrics.netIncome);
  old.definitions.push({ key: 'operatingIncome', label: 'Operating income', format: 'currency', category: 'income' });
  old.highlights.push('operatingIncome');
  const catalog = clone(old.sourceCatalog), data = adapt(old).payload;
  assert.equal(data.metrics.operatingIncome, undefined);
  assert.ok(!data.definitions.some(d => d.key === 'operatingIncome'));
  assert.ok(!data.highlights.includes('operatingIncome'));
  assert.equal(data.lensNote, ANALYSIS_INSURANCE_LENS_NOTE);
  assert.deepEqual(data.sourceCatalog.slice(0, catalog.length), catalog);
  assert.equal(data.metrics.netIncome[0].value, old.metrics.netIncome[0].value);
});

test('compatibility requires the full retained fiscal history and actual direct YTD duration', () => {
  for (const change of [p => { p.periods[1].fiscalStart = '2024-10-01'; }, p => { p.periods[1].fiscalStart = null; },
    p => { p.periods[1].end = '2024-02-30'; }, p => { p.periods[1].start = '2025-01-01'; },
    p => { p.periods[1].asOf = '2025-01-01'; }, p => { p.periods[0].fp = 'Q2'; }, p => { p.periods[1].ttmStart = '2024-02-30'; },
    p => { p.periods[1].ttmStart = '2099-01-01'; }]) {
    const old = oldFixture(); change(old); assert.equal(adapt(old), null);
  }
  const old = oldFixture(); old.basis = 'ytd';
  old.periods.forEach(p => { p.kind = 'ytd'; p.fp = 'Q4'; });
  assert.ok(adapt(old));
  const id = old.metrics.netIncome[1].sourceIds[0], source = old.sourceCatalog[id];
  source.start = '2024-04-01'; source.durationDays = 275;
  assert.equal(adapt(old), null);
});

test('reduced actual Amazon fixture rejects every unsafe old interim fiscal start without dollar inference', () => {
  const amzn = JSON.parse(fs.readFileSync(new URL('./fixtures/analysis-amzn-sec-facts.json', import.meta.url)));
  for (const basis of ['quarter', 'ytd', 'ttm']) {
    const fresh = clone(packAnalysisCompany(buildAnalysisCompany(amzn, { basis, asOf: '' })));
    const old = legacyFrom(fresh);
    old.periods[0].fiscalStart = '2025-07-01';
    if (basis === 'ytd') old.periods[0].start = old.periods[0].fiscalStart;
    const original = clone(old);
    assert.equal(adapt(freeze(old)), null, basis);
    assert.deepEqual(old, original);
  }
});

test('malformed catalogs, rows, source values and unknown financial payload shapes fail closed', () => {
  const corruptions = [
    p => { p.metrics.cash[0].sourceIds = [-1]; }, p => { p.metrics.cash[0].sourceIds = [0.5]; },
    p => { p.metrics.cash[0].sourceIds = ['0']; }, p => { p.metrics.cash[0].sourceIds = [p.sourceCatalog.length]; },
    p => { p.metrics.cash[0].calculationIds = [p.calculationCatalog.length]; },
    p => { p.metrics.cash[0].sourceIds = []; }, p => { p.metrics.cash.pop(); },
    p => { p.metrics.cash[0].value = 1; }, p => { p.metrics.cash[0].value = NaN; },
    p => { p.sourceCatalog[0].value = Infinity; }, p => { p.sourceCatalog[0].start = '2025-02-30'; },
    p => { p.definitions.push(p.definitions[0]); }, p => { p.sourceCatalog[0].unexpected = true; },
    p => { p.calculationCatalog.push({ value: null, formula: 'unknown' }); },
    p => { const s = p.sourceCatalog[p.metrics.cash[1].sourceIds[0]]; s.end = '2025-01-01'; },
    p => { const s = p.sourceCatalog[p.metrics.totalDebt[1].sourceIds[0]]; s.end = '2025-01-01'; },
  ];
  for (const corrupt of corruptions) { const old = oldFixture(); corrupt(old); assert.equal(adapt(old), null); }
});

test('immutable adaptation reuses content but never memoizes mutable input or envelope source clocks', () => {
  const old = freeze(oldFixture()), firstEnvelope = { payload: old, metadata: metadata(), serializedPayload: JSON.stringify(old) };
  const first = adaptPreparedAnalysisEnvelope(firstEnvelope);
  const secondEnvelope = { ...firstEnvelope, metadata: { ...metadata(), generation: 'new-fence' } };
  const second = adaptPreparedAnalysisEnvelope(secondEnvelope);
  assert.equal(first.payload, second.payload);
  assert.equal(first.serializedPayload, second.serializedPayload);
  assert.equal(second.metadata, secondEnvelope.metadata);
  assert.notEqual(second.metadata, first.metadata);
  assert.deepEqual(JSON.parse(first.serializedPayload), first.payload);
  assert.equal(firstEnvelope.serializedPayload, JSON.stringify(old));
  assert.throws(() => { first.payload.metrics.cash[0].value = 9; }, TypeError);
  const mutable = oldFixture(); assert.ok(adapt(mutable));
  mutable.periods[1].fiscalStart = null; assert.equal(adapt(mutable), null);
});

test('warm and durable prepared reads serialize adapted bytes while preserving metadata and no source reads', async () => {
  const old = oldFixture(), storedBytes = JSON.stringify(old), meta = metadata();
  const gzip = gzipSync(storedBytes).toString('base64');
  let hotReads = 0;
  const dependencies = { mode: 'supabase', loadRegistry: async () => null, readEnabled: () => true, payloadCache: createFinancialPayloadCache(),
    hotRead: async () => { hotReads++; return { gzip, metadata: { ...meta, generation: String(hotReads) } }; },
    read: async () => { throw new Error('No additional source or durable read for a usable warm payload.'); } };
  const results = await Promise.all(Array.from({ length: 12 }, () => readPreparedAnalysis({ ticker: 'AAPL' }, dependencies)));
  assert.equal(hotReads, 12); assert.equal(new Set(results.map(r => r.payload)).size, 1);
  assert.equal(new Set(results.map(r => r.metadata.generation)).size, 12);
  for (const result of results) {
    assert.equal(result.cacheSource, 'warm-prepared');
    assert.equal(result.metadata.fetchedAt, meta.fetchedAt);
    assert.equal(result.metadata.revalidatedAt, meta.revalidatedAt);
    assert.equal(result.metadata.expiresAt, meta.expiresAt);
    assert.deepEqual(JSON.parse(result.serializedPayload), result.payload);
    assert.notEqual(result.serializedPayload, storedBytes);
  }
  let durableReads = 0;
  const durable = await readPreparedAnalysis({ ticker: 'AAPL' }, { ...dependencies, hotRead: async () => null,
    read: async dataset => { assert.equal(dataset, 'financial'); durableReads++; return { payload: old, metadata: meta, serializedPayload: storedBytes }; } });
  assert.equal(durableReads, 1); assert.equal(durable.cacheSource, 'supabase-prepared');
  assert.deepEqual(JSON.parse(durable.serializedPayload), durable.payload);
  assert.equal(old.mappingVersion, 'analysis-mappings-v2');
});

test('adapter cannot renew source age, hide expired data, serve as-of, or accept mismatched identity', async () => {
  const old = oldFixture(), gzip = gzipSync(JSON.stringify(old)).toString('base64');
  const stale = { fetchedAt: '2020-01-01T00:00:00Z', revalidatedAt: '2020-01-02T00:00:00Z', expiresAt: '2020-01-03T00:00:00Z' };
  let reads = 0;
  const dependencies = { mode: 'supabase', loadRegistry: async () => null, readEnabled: () => true,
    hotRead: async () => ({ gzip, metadata: stale }),
    read: async () => { reads++; return { payload: old, metadata: stale }; } };
  await assert.rejects(readPreparedAnalysis({ ticker: 'AAPL' }, dependencies), e => e.status === 503);
  assert.equal(reads, 1);
  assert.equal(await readPreparedAnalysis({ ticker: 'AAPL', asOf: '2025-01-01' }, dependencies), null);
  assert.equal(reads, 1);
  for (const meta of [{ ...metadata(), fetchedAt: new Date(Date.now() + 600000).toISOString() },
    { ...metadata(), entityId: '0000000001' }]) {
    await assert.rejects(readPreparedAnalysis({ ticker: 'AAPL' }, { ...dependencies,
      hotRead: async () => ({ gzip, metadata: meta }), read: async () => ({ payload: old, metadata: meta }) }), e => e.status === 503);
  }
});

const captureDir = process.env.ANALYSIS_V2_CAPTURE_DIR;
test('all 41 saved live v2 captures: 35 safe full histories accepted, six unsafe interim histories rejected', { skip: !captureDir }, () => {
  const results = [];
  for (const file of fs.readdirSync(captureDir).filter(file => file.endsWith('-live.json'))) {
    const old = JSON.parse(fs.readFileSync(`${captureDir}/${file}`));
    if (!old.packed) continue;
    const original = clone(old), result = adapt(freeze(old));
    assert.deepEqual(old, original);
    results.push({ file, accepted: Boolean(result) });
    if (!result) continue;
    assert.deepEqual(JSON.parse(result.serializedPayload), result.payload);
    assert.deepEqual(result.payload.periods, old.periods);
    assert.equal(result.payload.observedAt, old.observedAt);
    assert.deepEqual(result.payload.calculationCatalog, old.calculationCatalog);
    assert.deepEqual(result.payload.sourceCatalog.slice(0, old.sourceCatalog.length), old.sourceCatalog);
    for (const [key, points] of Object.entries(result.payload.metrics)) points.forEach((point, i) => {
      assert.equal(point.value, old.metrics[key][i].value, `${file}:${key}:${i}`);
      assert.deepEqual(sources(result.payload, point).map(({ scopeNote: _scope, ...source }) => source),
        sources(old, old.metrics[key][i]).map(({ scopeNote: _scope, ...source }) => source), `${file}:${key}:${i}:evidence`);
    });
  }
  assert.equal(results.length, 41);
  assert.equal(results.filter(r => r.accepted).length, 35);
  assert.deepEqual(results.filter(r => !r.accepted).map(r => r.file), [
    'amzn-quarter-live.json', 'amzn-ttm-live.json', 'amzn-ytd-live.json',
    'ge-quarter-live.json', 'ge-ttm-live.json', 'ge-ytd-live.json',
  ]);
});
