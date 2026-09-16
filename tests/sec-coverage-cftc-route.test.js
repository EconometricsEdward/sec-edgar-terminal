import test from 'node:test';
import { execFileSync } from 'node:child_process';

async function fixture() {
  const { mock } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const root = process.argv[1], START = Date.parse('2026-09-14T12:00:00Z');
  let scenario, time, calls, abort;
  const dependency = (name, namedExports) => mock.module(new URL(name, root).href, { namedExports });
  dependency('src/utils/dataStore.js', { getDataStoreMode: dataset => dataset === 'cftc' ? scenario.mode || 'supabase' : 'supabase' });
  dependency('src/utils/dataStoreDeployment.js', { isSecCoverageScheduleEnabled: () => true });
  dependency('src/utils/secCoverageScheduleAuth.js', { authorizeSecCoverageSchedule: async () => {
    time += scenario.authMs || 0; return true;
  } });
  dependency('src/utils/cftcFeature.js', { isCftcEnabled: () => scenario.enabled !== false });
  dependency('src/utils/secCoverageMaintenance.js', { maintainSecCoverageMembership: async () => ({ status: 'current' }) });
  dependency('src/utils/secCoverageJobs.js', { runSecCoverageJob: async options => {
    calls.push(['sec', options]); time += scenario.researchMs || 0;
    if (scenario.secFail) throw new Error('private SEC detail');
    return { status: 'done', processed: 6, coverage: { succeeded: 6 } };
  } });
  dependency('src/utils/redisMaintenance.js', { maintainRedisCache: async options => {
    calls.push(['cache', options]); time += scenario.cacheMs || 0;
    if (scenario.abort) abort();
    return { version: 1, mode: 'steady', phase: 'steady', status: 'waiting' };
  } });
  dependency('src/utils/providerRetirementMaintenance.js', { maintainProviderRetirement: async () => {
    throw new Error('Retirement must not run in steady mode');
  } });
  dependency('src/utils/cftcHistoryPreparation.js', { runCftcHistoryPreparation: async options => {
    calls.push(['cftc', options]);
    if (scenario.fail) throw new Error('private provider request detail');
    return scenario.result || { status: 'progress', prepared: 3, limited: 1 };
  } });
  dependency('src/utils/portfolioCftcPreparation.js', { runPortfolioCftcPreparation: async options => {
    calls.push(['demo', options]);
    if (scenario.demoFail) throw new Error('private preparation detail');
    return { status: 'progress', completedCompanies: 6 };
  } });
  mock.method(Date, 'now', () => time);
  mock.method(globalThis, 'setTimeout', fn => { abort = fn; return 0; });
  mock.method(globalThis, 'clearTimeout', () => {});
  process.env.VERCEL_ENV = 'production';
  const { GET } = await import(new URL('src/app/api/cron/sec-coverage/route.js', root).href);
  async function run(value = {}) {
    scenario = value; time = START; calls = [];
    const response = await GET(new Request('https://secedgarterminal.com/api/cron/sec-coverage'));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(body.status, 'done');
    assert.deepEqual(body.coverage, { succeeded: 6 });
    return body;
  }
  const completed = await run();
  assert.deepEqual(calls.map(([name]) => name), ['sec', 'cache', 'cftc', 'demo']);
  assert.equal(calls[3][1].deadline, START + 45_000);
  assert.notEqual(calls[3][1].signal, calls[0][1].signal);
  assert.equal(completed.portfolioCftcPreparation.completedCompanies, 6);
  assert.equal(completed.cftcHistoryPreparation.prepared, 3);
  assert.equal(calls[2][1].maxContracts, 12);
  assert.equal(calls[2][1].deadline, START + 180_000);
  assert.equal(calls[2][1].signal, calls[0][1].signal);
  await run({ authMs: 12_000, researchMs: 230_000 });
  assert.equal(calls.find(([name]) => name === 'sec')[1].deadline, START + 12_000 + 225_000,
    'signature verification must not shorten the existing SEC research budget');
  assert.equal(calls.find(([name]) => name === 'demo')[1].deadline, START + 275_000,
    'the continuation deadline includes authorization time within the HTTP request budget');
  await run({ researchMs: 175_000, cacheMs: 5000 });
  assert.equal(calls.find(([name]) => name === 'cftc')[1].deadline, START + 225_000);
  for (const value of [{ researchMs: 175_000, cacheMs: 5001 }, { researchMs: 200_000 }, { abort: true }]) {
    const body = await run(value);
    assert.equal(calls.some(([name]) => name === 'cftc'), false);
    assert.deepEqual(body.cftcHistoryPreparation, { status: 'deferred', reason: 'research-budget' });
  }
  for (const value of [{ enabled: false }, { mode: 'off' }, { mode: 'shadow' }]) {
    const body = await run(value);
    assert.equal(calls.some(([name]) => name === 'cftc'), false);
    assert.equal(body.cftcHistoryPreparation.status, 'disabled');
  }
  const gated = await run({ result: { status: 'disabled', reason: 'operator-gate' } });
  assert.equal(gated.cftcHistoryPreparation.status, 'disabled');
  const failed = await run({ fail: true });
  assert.deepEqual(failed.cftcHistoryPreparation, { status: 'unavailable', code: 'CFTC_HISTORY_PREPARATION_UNAVAILABLE' });
  assert.equal(JSON.stringify(failed).includes('private provider'), false);
  const failedDemo = await run({ demoFail: true });
  assert.deepEqual(failedDemo.portfolioCftcPreparation, { status: 'unavailable', code: 'PORTFOLIO_CFTC_PREPARATION_UNAVAILABLE' });
  scenario = { secFail: true, researchMs: 230_000 }; time = START; calls = [];
  const secFailure = await GET(new Request('https://secedgarterminal.com/api/cron/sec-coverage'));
  assert.equal(secFailure.status, 503);
  assert.equal((await secFailure.json()).portfolioCftcPreparation.completedCompanies, 6);
  assert.deepEqual(calls.map(([name]) => name), ['sec', 'demo']);
  assert.equal(calls[1][1].deadline, START + 275_000);
  mock.restoreAll();
}

test('CFTC preparation follows SEC work, fits the remaining deadline and cannot fail completed SEC research', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e',
    `await (${fixture.toString()})();`, new URL('../', import.meta.url).href],
  { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
});
