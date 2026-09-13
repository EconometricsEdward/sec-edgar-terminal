import test from 'node:test';
import assert from 'node:assert/strict';
import { runSecCoverageJob, secCoverageShard, SEC_COVERAGE_JOB_PREFIX, SEC_COVERAGE_SHARDS } from '../src/utils/secCoverageJobs.js';
import { authorizeSecCoverageSchedule } from '../src/utils/secCoverageScheduleAuth.js';
import { GET } from '../src/app/api/cron/sec-coverage/route.js';

function fixtureCompanies(count, shard = 0) {
  const companies = [];
  for (let candidate = 1; companies.length < count; candidate += 1) {
    if (secCoverageShard(candidate) === shard) companies.push({ ticker: `T${candidate}`, cik: String(candidate).padStart(10, '0') });
  }
  return companies;
}

function storeFixture(companies = fixtureCompanies(3)) {
  let timestamp = Date.parse('2026-09-13T12:00:00Z');
  let checkpointRejected = false;
  const jobs = new Map(), calls = [], claimOptions = [], enqueueCalls = [];
  const deps = {
    companies, now: () => timestamp,
    enqueue: async ({ cycle, version, shards }) => {
      enqueueCalls.push({ cycle, version, shards });
      return shards.map(shard => {
        const key = `sec-coverage-v1:shard:${String(shard).padStart(2, '0')}`;
        const jobKey = `sec-coverage-v1:${cycle}:${String(shard).padStart(2, '0')}:${version}`;
        const checkpoint = { schema: 1, universeVersion: version, shard, cycle, cursor: 0, succeeded: 0, workCount: 0, retries: [], failures: [] };
        if (!jobs.has(jobKey)) jobs.set(jobKey, { id: jobKey, key, jobKey, checkpoint, state: 'queued', attempts: 0 });
        return { shard, id: jobKey, jobKey };
      });
    },
    claimJob: async options => {
      claimOptions.push(options);
      const job = [...jobs.values()].find(item => item.state === 'queued' && (!item.nextAt || item.nextAt <= timestamp)
        && (options.jobKey ? item.jobKey === options.jobKey : item.jobKey.startsWith(options.prefix)));
      if (!job) return null;
      job.state = 'running'; job.attempts += 1;
      return structuredClone(job);
    },
    checkpointJob: async (claim, { checkpoint }) => {
      if (checkpointRejected) return false;
      const job = jobs.get(claim.id);
      assert.equal(job.state, 'running');
      job.checkpoint = structuredClone(checkpoint);
      return true;
    },
    finish: async (claim, { checkpoint, status, retryAfterSeconds = 0, errorCode }) => {
      const job = jobs.get(claim.id);
      if (job.state !== 'running') return false;
      Object.assign(job, { checkpoint: structuredClone(checkpoint), state: status === 'retry' ? 'queued' : status,
        nextAt: timestamp + retryAfterSeconds * 1000, errorCode });
      return true;
    },
    yieldJob: async (claim, { checkpoint, retryAfterSeconds }) => {
      const job = jobs.get(claim.id);
      assert.equal(job.state, 'running');
      Object.assign(job, { checkpoint: structuredClone(checkpoint), state: 'queued', attempts: job.attempts - 1, nextAt: timestamp + retryAfterSeconds * 1000 });
      return true;
    },
    refresh: async (ticker) => { calls.push(ticker); return { ticker, status: 'prepared' }; },
  };
  return { deps, jobs, calls, claimOptions, enqueueCalls, advance: milliseconds => { timestamp += milliseconds; }, rejectCheckpoint: () => { checkpointRejected = true; } };
}

test('CIK sharding is stable across zero padding, ticker changes, and input order', async () => {
  assert.equal(secCoverageShard('320193'), secCoverageShard('0000320193'));
  const companies = fixtureCompanies(7);
  const first = storeFixture(companies), second = storeFixture([...companies].reverse());
  const a = await runSecCoverageJob({ shard: 0, maxCompanies: 6 }, first.deps);
  const b = await runSecCoverageJob({ shard: 0, maxCompanies: 6 }, second.deps);
  assert.equal(a.universeVersion, b.universeVersion);
  assert.deepEqual(first.calls, second.calls);
  assert.equal(a.processed, 6);
  assert.equal(a.coverage.visited, 6);
  assert.equal(a.done, false);
});

test('successful continuations do not exhaust crash retries, even across more than ten claims', async () => {
  const fixture = storeFixture(fixtureCompanies(12));
  for (let index = 0; index < 12; index += 1) {
    const result = await runSecCoverageJob({ shard: 0, maxCompanies: 1 }, fixture.deps);
    assert.equal(result.coverage.visited, index + 1);
    assert.equal(result.done, index === 11);
    fixture.advance(2_000);
  }
  assert.equal(new Set(fixture.calls).size, 12);
  assert.equal(fixture.jobs.size, 1);
  assert.equal([...fixture.jobs.values()][0].attempts, 1);
});

test('one failing issuer cannot block others and receives only three attempts', async () => {
  const fixture = storeFixture();
  const badTicker = fixture.deps.companies[0].ticker;
  fixture.deps.refresh = async ticker => {
    fixture.calls.push(ticker);
    if (ticker === badTicker) throw Object.assign(new Error('Private upstream diagnostic must not be returned'), { code: 'UPSTREAM_FAILED', retryAfter: '120' });
    return { ticker, status: 'prepared' };
  };
  const first = await runSecCoverageJob({ shard: 0 }, fixture.deps);
  assert.equal(first.coverage.succeeded, 2);
  assert.equal(first.coverage.pendingRetries, 1);
  assert.equal(first.retryAfterSeconds, 120);
  assert.equal(JSON.stringify(first).includes('Private upstream'), false);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    fixture.advance(121_000);
    const result = await runSecCoverageJob({ shard: 0 }, fixture.deps);
    assert.equal(result.done, attempt === 1);
  }
  const job = [...fixture.jobs.values()][0];
  assert.equal(job.state, 'done');
  assert.equal(job.checkpoint.failures.length, 1);
  assert.equal(job.errorCode, 'SEC_COVERAGE_PARTIAL');
  assert.equal(fixture.calls.filter(ticker => ticker === badTicker).length, 3);
  assert.equal(fixture.calls.length, 5);
});

test('a provider cooldown longer than a day remains respected across bounded queue wakes', async () => {
  const fixture = storeFixture(fixtureCompanies(1));
  fixture.deps.refresh = async ticker => { fixture.calls.push(ticker); return { status: 'failed', retryAfter: '172800' }; };
  const first = await runSecCoverageJob({ shard: 0 }, fixture.deps);
  assert.equal(first.retryAfterSeconds, 86400);
  fixture.advance(86_400_000);
  const second = await runSecCoverageJob({}, fixture.deps);
  assert.equal(second.processed, 0);
  assert.equal(second.retryAfterSeconds, 86400);
  assert.equal(fixture.calls.length, 1);
});

test('day rollover resumes older incomplete work and does not claim legacy migration jobs', async () => {
  const fixture = storeFixture(fixtureCompanies(2));
  await runSecCoverageJob({ shard: 0, maxCompanies: 1 }, fixture.deps);
  fixture.advance(86_400_000);
  fixture.jobs.set('legacy', { id: 'legacy', jobKey: 'sec-financial-cohort-v1:2026-09-13', state: 'queued' });
  const resumed = await runSecCoverageJob({ maxCompanies: 1 }, fixture.deps);
  assert.equal(resumed.cycle, '2026-09-13');
  assert.equal(resumed.coverage.visited, 2);
  assert.equal(resumed.done, true);
  assert.equal(fixture.claimOptions.at(-1).prefix, SEC_COVERAGE_JOB_PREFIX);
  assert.equal(fixture.enqueueCalls.length, 2);
  assert.equal(fixture.enqueueCalls.at(-1).shards.length, 32);
  assert.equal(fixture.jobs.get('legacy').state, 'queued');
  assert.equal(fixture.jobs.size, SEC_COVERAGE_SHARDS + 2);
});

test('duplicate trigger never refreshes an issuer without its own claim', async () => {
  const fixture = storeFixture(fixtureCompanies(1));
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  fixture.deps.refresh = async ticker => { fixture.calls.push(ticker); entered(); await pending; return { status: 'prepared' }; };
  const first = runSecCoverageJob({ shard: 0 }, fixture.deps);
  await started;
  const duplicate = await runSecCoverageJob({ shard: 0 }, fixture.deps);
  assert.equal(duplicate.status, 'busy-or-finished');
  assert.equal(fixture.calls.length, 1);
  release();
  assert.equal((await first).done, true);
});

test('checkpoint ownership loss stops further issuers and preserves acknowledged progress', async () => {
  const fixture = storeFixture();
  fixture.rejectCheckpoint();
  await assert.rejects(runSecCoverageJob({ shard: 0 }, fixture.deps), /checkpoint ownership expired/);
  assert.equal(fixture.calls.length, 1);
  assert.equal([...fixture.jobs.values()][0].checkpoint.cursor, 0);
  assert.equal([...fixture.jobs.values()][0].attempts, 1);
});

test('a changed membership retires the old cursor instead of applying it to different companies', async () => {
  const fixture = storeFixture(fixtureCompanies(3));
  await runSecCoverageJob({ shard: 0, maxCompanies: 1 }, fixture.deps);
  fixture.advance(2_000);
  fixture.deps.companies = fixtureCompanies(4);
  const result = await runSecCoverageJob({}, fixture.deps);
  assert.equal(result.status, 'superseded');
  assert.equal(result.processed, 0);
  assert.equal(fixture.calls.length, 1);
});

test('bounds and deadline checks prevent oversized or unfinishable invocations', async () => {
  const fixture = storeFixture();
  for (const options of [{ maxCompanies: 7 }, { shard: 32 }, { shard: -1 }, { deadline: fixture.deps.now() + 231_000 }]) {
    await assert.rejects(runSecCoverageJob(options, fixture.deps), /Unbounded|Invalid/);
  }
  const result = await runSecCoverageJob({ deadline: fixture.deps.now() + 59_000 }, fixture.deps);
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(fixture.jobs.size, 0);
  assert.equal(fixture.calls.length, 0);
});

test('cron requires the production CRON_SECRET and returns uncached operational responses', async t => {
  const priorSecret = process.env.CRON_SECRET, priorEnvironment = process.env.VERCEL_ENV;
  t.after(() => {
    if (priorSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = priorSecret;
    if (priorEnvironment === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = priorEnvironment;
  });
  process.env.CRON_SECRET = 'fixture-cron-secret-with-32-characters';
  process.env.VERCEL_ENV = 'preview';
  const unauthorized = await GET(new Request('http://localhost/api/cron/sec-coverage'));
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('cache-control'), 'private, no-store');
  const preview = await GET(new Request('http://localhost/api/cron/sec-coverage', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  assert.equal(preview.status, 401);
  process.env.VERCEL_ENV = 'production';
  for (const query of ['shard=32', 'shard=1&shard=2', 'maxCompanies=7', 'unknown=1']) {
    const invalid = await GET(new Request(`http://localhost/api/cron/sec-coverage?${query}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    assert.equal(invalid.status, 400);
  }
});

test('static scheduler bearer credentials are retired and production cron credentials remain scoped to manual work', async () => {
  const token = 'a'.repeat(64);
  const request = value => new Request('http://localhost/api/cron/sec-coverage', { headers: { authorization: value } });
  const production = { env: { VERCEL_ENV: 'production' }, verify: async () => { throw new Error('Must not invoke verification'); } };
  assert.equal(await authorizeSecCoverageSchedule(request(`Bearer ${token}`), production), false);
  assert.equal(await authorizeSecCoverageSchedule(request(''), production), false);
  assert.equal(await authorizeSecCoverageSchedule(request(`Bearer ${token}`), { ...production, env: { VERCEL_ENV: 'preview' } }), false);
  const cronSecret = 'separate-production-cron-credential';
  assert.equal(await authorizeSecCoverageSchedule(request(`Bearer ${cronSecret}`), { env: { VERCEL_ENV: 'production', CRON_SECRET: cronSecret } }), true);
});
