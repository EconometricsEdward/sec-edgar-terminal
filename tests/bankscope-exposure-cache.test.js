import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCachedExposureReport, isExposureReport } from '../src/utils/bank/exposureReportStore.js';
import { createExposureService } from '../src/utils/bank/exposureService.js';
import { parseCallXbrl } from '../src/utils/bank/parser.js';
import { buildExposureReport } from '../src/utils/bank/exposureModel.js';
import { EXPOSURE_VERSION } from '../src/utils/bank/exposureDefinitions.js';
import { SCOPE_MAPPING_VERSION } from '../src/utils/bank/catalog.js';

const env = { VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' };
const period = '2026-06-30';
function fixture(suffix = '') {
  const rawXbrl = readFileSync(new URL(`./fixtures/exposures-451965-${period}.xml`, import.meta.url), 'utf8') + suffix;
  const sha256 = createHash('sha256').update(rawXbrl).digest('hex');
  return {
    metadata: { id_rssd: 451965, report_date: period, form_type: '031', source_sha256: sha256, validation: { passed: true } },
    source: { rssd: 451965, reportDate: period, rawXbrl, sha256, validation: { passed: true }, retrievedAt: '2026-09-26T00:00:00.000Z', submission: '2026-08-01' },
  };
}
function sharedCache() {
  const entries = new Map(), registrations = [];
  return { entries, registrations, cache: (load, parts, options) => {
    registrations.push({ parts, options });
    return async () => {
      const key = JSON.stringify(parts);
      if (!entries.has(key)) entries.set(key, JSON.stringify(await load()));
      return JSON.parse(entries.get(key));
    };
  } };
}
function reportFixture(metadata, source) {
  return buildExposureReport(parseCallXbrl(source.rawXbrl, { rssd: metadata.id_rssd, reportDate: metadata.report_date }),
    { form: metadata.form_type, retrievedAt: source.retrievedAt, submission: source.submission });
}

test('separate exposure service instances reuse a validated derived report while refreshing current metadata', async () => {
  const { metadata, source } = fixture(), shared = sharedCache();
  let reads = 0, sources = 0, clock = 0;
  const store = async (op, payload) => {
    if (op === 'read') { reads++; return { periods: [period], reports: [metadata] }; }
    sources++; assert.equal(op, 'source'); assert.deepEqual(payload, { rssd: 451965, period, hash: source.sha256 });
    return source;
  };
  const options = { store, cache: shared.cache, env, now: () => clock };
  const first = createExposureService(options);
  const result = await first(451965, period);
  const second = createExposureService(options);
  assert.deepEqual(await second(451965, period), result);
  clock = 300001; await first(451965, period);
  assert.equal(reads, 3); assert.equal(sources, 1);
  assert.equal(shared.registrations[0].options.revalidate, 86400);
  assert.ok(shared.registrations[0].parts.includes(EXPOSURE_VERSION));
  assert.ok(shared.registrations[0].parts.includes(SCOPE_MAPPING_VERSION));
  assert.ok(shared.registrations[0].parts.includes(source.sha256));
  const saved = [...shared.entries.values()][0];
  assert.ok(Buffer.byteLength(saved) < 512 * 1024);
  assert.ok(!saved.includes('rawXbrl') && !saved.includes('<xbrl'));
  assert.equal(result.reports[0].retrievedAt, source.retrievedAt);
});

test('one instance coalesces concurrent misses and gives each caller an independent result', async () => {
  const { metadata, source } = fixture(), shared = sharedCache(); let calls = 0;
  const get = createCachedExposureReport({ env, cache: shared.cache, store: async () => { calls++; return source; } });
  const values = await Promise.all(Array.from({ length: 20 }, () => get(metadata)));
  assert.equal(calls, 1);
  values[0].values.deposits.value = -99;
  assert.notEqual(values[1].values.deposits.value, -99);
  assert.notEqual((await get(metadata)).values.deposits.value, -99);
});

test('an amended source SHA selects a new report even while the previous one is cached', async () => {
  const original = fixture(), amended = fixture('\n'), shared = sharedCache(); let calls = 0, selected = original;
  const get = createCachedExposureReport({ env, cache: shared.cache, store: async () => { calls++; return selected.source; } });
  await get(original.metadata); selected = amended;
  assert.equal((await get(amended.metadata)).hash, amended.source.sha256);
  assert.equal(calls, 2); assert.equal(shared.entries.size, 2);
  assert.equal((await get(original.metadata)).hash, original.source.sha256);
});

test('failed source validations never write shared results or trigger an immediate duplicate load', async () => {
  const { metadata, source } = fixture();
  for (const patch of [{ validation: { passed: false } }, { rssd: 493741 }, { reportDate: '2026-03-31' }, { sha256: 'a'.repeat(64) }, { rawXbrl: source.rawXbrl + '\n' }]) {
    const shared = sharedCache(); let calls = 0;
    const get = createCachedExposureReport({ env, cache: shared.cache, store: async () => { calls++; return { ...source, ...patch }; } });
    await assert.rejects(get(metadata)); assert.equal(calls, 1);
    await assert.rejects(get(metadata)); assert.equal(calls, 2);
    assert.equal(shared.entries.size, 0);
  }
});

test('malformed shared hits are checked and replaced by one fully validated source load', async () => {
  const { metadata, source } = fixture(), valid = reportFixture(metadata, source);
  const missing = structuredClone(valid); delete missing.values.deposits;
  const nonfinite = structuredClone(valid); nonfinite.values.deposits.value = Infinity;
  for (const malformed of [null, { ...valid, rssd: 1 }, { ...valid, period: '2026-03-31' }, { ...valid, form: '041' },
    { ...valid, hash: 'f'.repeat(64) }, { ...valid, mappingVersion: 'old' }, { ...valid, rawXbrl: source.rawXbrl }, missing, nonfinite]) {
    let calls = 0;
    assert.equal(isExposureReport(malformed, metadata), false);
    const get = createCachedExposureReport({ env, cache: () => async () => malformed, store: async () => { calls++; return source; } });
    const report = await get(metadata);
    assert.equal(isExposureReport(report, metadata), true); assert.equal(calls, 1);
  }
});

test('cache infrastructure failures keep valid data available with no duplicate source request', async () => {
  const { metadata, source } = fixture();
  for (const cache of [() => async () => { throw new Error('cache read down'); }, load => async () => { await load(); throw new Error('cache write down'); }]) {
    let calls = 0;
    const get = createCachedExposureReport({ env, cache, store: async () => { calls++; return source; } });
    assert.equal((await get(metadata)).hash, source.sha256); assert.equal(calls, 1);
  }
});

test('environment gates precede hits and approved previews never use production shared data', async () => {
  const { metadata, source } = fixture(); let cacheReads = 0, sourceReads = 0;
  const options = { store: async () => { sourceReads++; return source; }, cache: load => async () => { cacheReads++; return load(); } };
  for (const unsupported of [{}, { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'other' }])
    await assert.rejects(createCachedExposureReport({ ...options, env: unsupported })(metadata), { code: 'bank_service_unavailable' });
  assert.equal(sourceReads, 0); assert.equal(cacheReads, 0);
  await createCachedExposureReport({ ...options, env: { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feat/ffiec-bank-pilot' } })(metadata);
  assert.equal(sourceReads, 1); assert.equal(cacheReads, 0);
  const mutable = { ...env }, get = createCachedExposureReport({ ...options, env: mutable });
  await get(metadata); mutable.VERCEL_ENV = 'development';
  await assert.rejects(get(metadata), { code: 'bank_service_unavailable' });
  assert.equal(sourceReads, 2); assert.equal(cacheReads, 1);
});

test('invalid source metadata cannot reach the shared cache or a source request', async () => {
  const { metadata } = fixture();
  const get = createCachedExposureReport({ env, cache: () => assert.fail('cache invoked'), store: () => assert.fail('source invoked') });
  for (const patch of [{ validation: { passed: false } }, { id_rssd: 0 }, { report_date: '2026-06-29' }, { form_type: 'bad' }, { source_sha256: 'bad' }])
    await assert.rejects(get({ ...metadata, ...patch }), { code: 'database_failure' });
});
