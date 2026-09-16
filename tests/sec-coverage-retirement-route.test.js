import test from 'node:test';
import { execFileSync } from 'node:child_process';

// Run the actual route with Node's isolated module mocks. The subprocess keeps
// production environment and clock changes away from other test files and
// ensures no authenticated fixture can reach a real cache or scheduler.
async function routeFixture() {
  const { mock } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const root = process.argv[1];
  const START = Date.parse('2026-09-13T12:00:00Z');
  const ready = { version: 1, mode: 'migrate', phase: 'migration', status: 'progress', counters: { removed: 10 } };
  let scenario, time, calls, abort;
  const mockDependency = (name, namedExports) => mock.module(new URL(name, root).href, { namedExports });
  mockDependency('src/utils/dataStore.js', { getDataStoreMode: () => 'supabase' });
  mockDependency('src/utils/cftcFeature.js', { isCftcEnabled: () => false });
  mockDependency('src/utils/cftcHistoryPreparation.js', { runCftcHistoryPreparation: async () => { throw new Error('CFTC feature is disabled in this retirement fixture'); } });
  mockDependency('src/utils/portfolioCftcPreparation.js', { runPortfolioCftcPreparation: async () => { throw new Error('CFTC feature is disabled in this retirement fixture'); } });
  mockDependency('src/utils/dataStoreDeployment.js', { isSecCoverageScheduleEnabled: () => true });
  mockDependency('src/utils/secCoverageScheduleAuth.js', { authorizeSecCoverageSchedule: async () => true });
  mockDependency('src/utils/secCoverageMaintenance.js', { maintainSecCoverageMembership: async () => ({ status: 'current' }) });
  mockDependency('src/utils/secCoverageJobs.js', { runSecCoverageJob: async options => {
    calls.push(['research', options]); time += scenario.researchMs || 0;
    return { status: 'done', processed: 6, coverage: { succeeded: 6 } };
  } });
  mockDependency('src/utils/redisMaintenance.js', { maintainRedisCache: async options => {
    calls.push(['cache', options]); time += scenario.cacheMs || 0;
    if (scenario.abortAfterCache) abort();
    if (scenario.cacheError) throw new Error('private cache exception');
    return structuredClone(scenario.cache ?? ready);
  } });
  mockDependency('src/utils/providerRetirementMaintenance.js', { maintainProviderRetirement: async options => {
    calls.push(['retirement', options]);
    if (scenario.retirementError) throw new Error('private retirement exception');
    return { status: 'progress', phase: 'delete', removed: 100, complete: false };
  } });
  mock.method(Date, 'now', () => time);
  mock.method(globalThis, 'setTimeout', fn => { abort = fn; return 0; });
  mock.method(globalThis, 'clearTimeout', () => {});
  process.env.VERCEL_ENV = 'production';
  const { GET } = await import(new URL('src/app/api/cron/sec-coverage/route.js', root).href);
  async function run(value = {}) {
    scenario = value; time = START; calls = [];
    const response = await GET(new Request('https://example.test/api/cron/sec-coverage'));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(body.status, 'done'); assert.equal(body.processed, 6);
    assert.deepEqual(body.coverage, { succeeded: 6 }); assert.deepEqual(body.membership, { status: 'current' });
    return body;
  }

  for (const status of ['progress', 'partial', 'waiting', 'migration_pass_complete']) {
    const body = await run({ cache: { ...ready, status } });
    assert.deepEqual(calls.map(([kind]) => kind), ['research', 'cache', 'retirement']);
    assert.equal(body.providerRetirement.removed, 100);
    assert.equal(calls[2][1].deadline, START + 20_000);
    assert.equal(calls[2][1].signal, calls[1][1].signal);
  }
  for (const cache of [
    { ...ready, version: 2 }, { ...ready, mode: 'inventory' }, { ...ready, mode: 'steady' },
    { ...ready, phase: 'inventory' }, { ...ready, status: 'uncommitted' },
    { ...ready, status: 'unavailable' }, { ...ready, status: 'busy' },
    ...[0, -1, 1.5, '10', undefined].map(removed => ({ ...ready, counters: { removed } })),
  ]) {
    const body = await run({ cache });
    assert.equal(calls.some(([kind]) => kind === 'retirement'), false);
    assert.deepEqual(body.providerRetirement, { status: 'deferred', reason: 'cache-migration' });
  }
  // Exactly twenty seconds of route budget remains: execute with that cap.
  await run({ researchMs: 190_000, cacheMs: 15_000 });
  assert.equal(calls.find(([kind]) => kind === 'retirement')[1].deadline, START + 225_000);
  for (const value of [{ researchMs: 190_000, cacheMs: 15_001 }, { researchMs: 200_000 }, { abortAfterCache: true }]) {
    const body = await run(value);
    assert.equal(calls.some(([kind]) => kind === 'retirement'), false);
    assert.equal(body.providerRetirement.status, 'deferred');
  }
  const failedHelper = await run({ retirementError: true });
  assert.deepEqual(failedHelper.providerRetirement, { status: 'unavailable', code: 'PROVIDER_RETIREMENT_UNAVAILABLE' });
  assert.ok(!JSON.stringify(failedHelper).includes('private retirement'));
  const failedCache = await run({ cacheError: true });
  assert.equal(failedCache.cacheMaintenance.status, 'unavailable');
  assert.equal(calls.some(([kind]) => kind === 'retirement'), false);
  assert.ok(!JSON.stringify(failedCache).includes('private cache'));
  mock.restoreAll();
}

test('signed coverage housekeeping gates retirement, respects remaining time and preserves completed research on failure', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e',
    `await (${routeFixture.toString()})();`, new URL('../', import.meta.url).href],
  { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
});
