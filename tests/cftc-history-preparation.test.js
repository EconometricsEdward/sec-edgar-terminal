import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CFTC_REPORT_BASIS } from '../src/utils/cftc.js';
import { prepareCftcContractRawHistory } from '../src/utils/cftcServer.js';
import { frozenCftcHistoryCatalog, runCftcHistoryPreparation as worker, validCftcHistoryCheckpoint, CFTC_HISTORY_JOB_PREFIX } from '../src/utils/cftcHistoryPreparation.js';

const base = JSON.parse(readFileSync(new URL('./fixtures/cftc-tff-gpe5-46if-v1.json', import.meta.url), 'utf8'))[0];
const date = '2026-09-08', timestamp = Date.parse('2026-09-14T12:00:00Z');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const runCftcHistoryPreparation = (options, deps) => worker({ maxJobs: 1, ...options }, deps);

function source(count = 64, family = 'tff') {
  return { family, report_basis: CFTC_REPORT_BASIS, report_date: date, generation: '4', contentHash: 'a'.repeat(64),
    retrievedAt: '2026-09-14T09:00:00Z', savedAt: '2026-09-14T09:01:00Z',
    rows: Array.from({ length: count }, (_, index) => ({ ...base, id: `row-${index}`,
      cftc_contract_market_code: String(index + 1).padStart(6, '0'), report_date_as_yyyy_mm_dd: `${date}T00:00:00.000` })) };
}

function receipt({ family, code, throughDate }, overrides = {}) {
  return { family, report_basis: CFTC_REPORT_BASIS, code, report_date: throughDate, status: 'ready', rows: 600, pages: 3,
    coverage: { prior_observations: 599, required_prior_reports: 520, sufficient: true, source_exhausted: false, cap_reached: false, quarantined_rows: 0 },
    durable_receipt: { key: `raw-history-v1:futures-only:${family}:${code}:${throughDate}`, generation: '2', content_hash: 'b'.repeat(64) }, ...overrides };
}

function fixture(count = 64) {
  let clock = timestamp, enabled = true, current = source(count), rejectCheckpoint = false;
  const jobs = new Map(), calls = [], preparedCalls = [], enqueues = [];
  const currentJob = claim => [...jobs.values()].find(job => job.id === claim.id);
  const status = () => {
    const groups = new Map();
    for (const job of jobs.values()) {
      const cp = job.checkpoint;
      if (!cp?.catalogHash) continue;
      const id = `${cp.family}:${cp.reportDate}:${cp.catalogHash}`;
      const group = groups.get(id) || { family: cp.family, reportDate: cp.reportDate, catalogHash: cp.catalogHash, shardIndexes: [] };
      group.shardIndexes.push(cp.shard); group.shards = group.shardIndexes.length; groups.set(id, group);
    }
    return { enabled, jobs: [...groups.values()] };
  };
  const deps = {
    now: () => clock, mode: () => 'supabase', readStatus: async () => { calls.push('status'); return status(); },
    catalogRaw: async family => { calls.push(`catalog:${family}`); return family === 'tff' ? copy(current) : null; },
    enqueue: async options => {
      calls.push('enqueue'); enqueues.push(copy(options));
      if (!jobs.has(options.jobKey)) jobs.set(options.jobKey, { ...copy(options), id: options.jobKey, state: 'queued', attempts: 0 });
      return jobs.get(options.jobKey).id;
    },
    claimJob: async options => {
      calls.push('claim'); assert.equal(options.dataset, 'cftc'); assert.equal(options.prefix, CFTC_HISTORY_JOB_PREFIX);
      const job = [...jobs.values()].find(item => item.state === 'queued' && (!item.nextAt || item.nextAt <= clock));
      if (!job) return null;
      job.state = 'running'; job.attempts += 1; return copy(job);
    },
    prepare: async args => { preparedCalls.push(args); return receipt(args); },
    checkpointJob: async (claim, { checkpoint }) => {
      calls.push('checkpoint'); if (rejectCheckpoint) return false;
      currentJob(claim).checkpoint = copy(checkpoint); return true;
    },
    finish: async (claim, { checkpoint, status: state, errorCode, retryAfterSeconds = 0 }) => {
      calls.push(`finish:${state}`); const job = currentJob(claim);
      if (job.state !== 'running') return false;
      Object.assign(job, { checkpoint: copy(checkpoint), state: state === 'retry' ? 'queued' : state,
        errorCode, nextAt: clock + retryAfterSeconds * 1000 }); return true;
    },
    yieldJob: async (claim, { checkpoint, retryAfterSeconds }) => {
      calls.push('yield'); const job = currentJob(claim);
      Object.assign(job, { checkpoint: copy(checkpoint), state: 'queued', nextAt: clock + retryAfterSeconds * 1000, attempts: job.attempts - 1 }); return true;
    },
  };
  return { deps, jobs, calls, preparedCalls, enqueues, advance: ms => { clock += ms; },
    setEnabled: value => { enabled = value; }, setCatalog: value => { current = value; },
    getCatalog: () => copy(current), rejectCheckpoint: () => { rejectCheckpoint = true; },
    firstJob: () => [...jobs.values()][0] };
}

test('off and shadow modes have zero database or source side effects', async () => {
  for (const mode of ['off', 'shadow']) {
    const f = fixture(); f.deps.mode = () => mode;
    assert.equal((await runCftcHistoryPreparation({}, f.deps)).status, 'disabled');
    assert.deepEqual(f.calls, []);
  }
});

test('initial SEC verification gate blocks even enqueue and catalog reads', async () => {
  const f = fixture(); f.setEnabled(false);
  assert.equal((await runCftcHistoryPreparation({}, f.deps)).status, 'awaiting-sec-verification');
  assert.deepEqual(f.calls, ['status']);
  assert.equal(f.preparedCalls.length, 0);
});

test('invocation contract count, deadline and cancellation are bounded before work', async () => {
  const f = fixture();
  for (const options of [{ maxContracts: 13 }, { maxContracts: 0 }, { maxContracts: 1.5 }, { maxJobs: 0 }, { maxJobs: 9 }, { deadline: timestamp + 180001 }]) {
    await assert.rejects(runCftcHistoryPreparation(options, f.deps), { code: 'CFTC_HISTORY_INVALID_BUDGET' });
  }
  assert.equal((await runCftcHistoryPreparation({ deadline: timestamp + 19999 }, f.deps)).status, 'budget-exhausted');
  assert.equal((await runCftcHistoryPreparation({ signal: AbortSignal.abort() }, f.deps)).status, 'budget-exhausted');
  assert.deepEqual(f.calls, []);
});

test('catalog identity preserves source row revisions and ignores retrieval order or renewed generations', () => {
  const a = source(), b = copy(a); b.rows.reverse(); b.generation = '5'; b.contentHash = 'c'.repeat(64);
  b.retrievedAt = '2026-09-14T10:00:00Z'; b.savedAt = '2026-09-14T10:01:00Z';
  assert.equal(frozenCftcHistoryCatalog(a, 'tff', timestamp).catalogHash, frozenCftcHistoryCatalog(b, 'tff', timestamp).catalogHash);
  b.rows[0].open_interest_all = String(Number(b.rows[0].open_interest_all) + 1);
  assert.notEqual(frozenCftcHistoryCatalog(a, 'tff', timestamp).catalogHash, frozenCftcHistoryCatalog(b, 'tff', timestamp).catalogHash);
});

test('invalid, stale, future, mixed-date and combined catalogs cannot start jobs', () => {
  const a = source();
  for (const changes of [{ report_basis: 'combined' }, { family: 'legacy' }, { contentHash: 'no' }, { generation: '0' },
    { report_date: '2026-08-01' }, { report_date: '2026-09-15' }, { savedAt: '2026-08-01T00:00:00Z' },
    { retrievedAt: '2026-09-15T00:00:00Z' }, { rows: [] }]) {
    assert.equal(frozenCftcHistoryCatalog({ ...a, ...changes }, 'tff', timestamp), null);
  }
  const mixed = copy(a); mixed.rows[0].report_date_as_yyyy_mm_dd = '2026-09-01T00:00:00.000';
  assert.equal(frozenCftcHistoryCatalog(mixed, 'tff', timestamp), null);
});

test('conflicting source identities are quarantined and never enter preparation shards', () => {
  const a = source(4); a.rows.push({ ...a.rows[0], id: 'conflict', open_interest_all: '3' });
  const catalog = frozenCftcHistoryCatalog(a, 'tff', timestamp);
  assert.equal(catalog.contracts.length, 3);
  assert.equal(catalog.rows.has('000001'), false);
  assert.equal(catalog.quarantinedRows, 1);
});

test('all 1500 catalog markets fit deterministic bounded shards and checkpoint failure lists', async () => {
  const f = fixture(1500);
  await runCftcHistoryPreparation({ maxContracts: 1 }, f.deps);
  const catalog = frozenCftcHistoryCatalog(f.getCatalog(), 'tff', timestamp);
  assert.equal(catalog.shards.flat().length, 1500);
  assert.equal(new Set(catalog.shards.flat().map(([code]) => code)).size, 1500);
  assert.ok(catalog.shards.every(shard => shard.length <= 47));
  for (const job of f.enqueues) {
    const checkpoint = copy(job.checkpoint);
    checkpoint.cursor = checkpoint.contracts.length; checkpoint.workCount = checkpoint.cursor * 3;
    checkpoint.failures = checkpoint.contracts.map((_, index) => ({ index, code: 'F'.repeat(100) }));
    assert.equal(validCftcHistoryCheckpoint(checkpoint), true);
    assert.ok(Buffer.byteLength(JSON.stringify(checkpoint)) < 16384);
  }
});

test('enqueue is at most sixteen per tick and existing complete shard manifests are not overwritten', async () => {
  const f = fixture();
  assert.equal((await runCftcHistoryPreparation({}, f.deps)).enqueued, 16);
  f.advance(2000);
  assert.equal((await runCftcHistoryPreparation({}, f.deps)).enqueued, 16);
  const before = f.enqueues.length; f.advance(2000);
  assert.equal((await runCftcHistoryPreparation({}, f.deps)).enqueued, 0);
  assert.equal(f.enqueues.length, before);
  assert.equal(f.jobs.size, 32);
  assert.equal(f.firstJob().state, 'done');
});

test('a job freezes exact family, futures-only report date, raw row and 520-history request', async () => {
  const f = fixture(); const result = await runCftcHistoryPreparation({}, f.deps);
  assert.equal(result.processed, 2); assert.equal(result.status, 'done');
  assert.equal(result.coverage.prepared, 2);
  assert.deepEqual(f.preparedCalls.map(call => call.code), ['000001', '000002']);
  const args = f.preparedCalls[0]; assert.equal(args.family, 'tff'); assert.equal(args.throughDate, date);
  assert.equal(args.count, 520); assert.equal(args.expectedSelectedRaw.cftc_contract_market_code, args.code);
  assert.ok(args.signal instanceof AbortSignal);
  const serialized = JSON.stringify(result);
  for (const secret of ['expectedSelectedRaw', 'durable_receipt', '000001', 'content_hash', 'jobKey']) assert.equal(serialized.includes(secret), false);
});

test('prepared limited histories count as durable successes, never retry because a young contract is short', async () => {
  const f = fixture();
  f.deps.prepare = async args => receipt(args, { status: 'partial', rows: 12, pages: 1,
    coverage: { prior_observations: 11, required_prior_reports: 520, sufficient: false, source_exhausted: true, cap_reached: false, quarantined_rows: 0 } });
  const result = await runCftcHistoryPreparation({}, f.deps);
  assert.deepEqual(result.coverage, { contracts: 2, visited: 2, prepared: 2, limited: 2, pendingRetries: 0, failed: 0 });
  assert.equal(f.firstJob().state, 'done');
});

test('limited coverage reflects the public 260-observation window rather than the 520-report ingestion target', async () => {
  for (const [prior, limited] of [[300, 0], [260, 0], [259, 2]]) {
    const f = fixture();
    f.deps.prepare = async args => receipt(args, { rows: prior + 1, pages: Math.ceil((prior + 1) / 200),
      coverage: { prior_observations: prior, required_prior_reports: 520, sufficient: false, source_exhausted: true, cap_reached: false, quarantined_rows: 0 } });
    const result = await runCftcHistoryPreparation({}, f.deps);
    assert.equal(result.coverage.prepared, 2); assert.equal(result.coverage.limited, limited);
    assert.equal(result.coverage.failed, 0);
  }
});

test('successful partial continuations do not burn the durable crash retry allowance', async () => {
  const f = fixture(320);
  for (let index = 0; index < 10; index += 1) {
    const result = await runCftcHistoryPreparation({ maxContracts: 1 }, f.deps);
    assert.equal(result.coverage.visited, index + 1); f.advance(2000);
  }
  assert.equal(f.firstJob().state, 'done'); assert.equal(f.firstJob().attempts, 1);
  assert.equal(new Set(f.preparedCalls.map(call => call.code)).size, 10);
});

test('one poison contract cannot block untouched markets and exhausts only three actual attempts', async () => {
  const f = fixture(320), attempts = new Map();
  f.deps.prepare = async args => {
    attempts.set(args.code, (attempts.get(args.code) || 0) + 1);
    if (args.code === '000001') throw Object.assign(new Error('private request details'), { code: 'CFTC_SOURCE_HTTP_ERROR' });
    return receipt(args);
  };
  const first = await runCftcHistoryPreparation({}, f.deps);
  assert.equal(first.coverage.prepared, 9); assert.equal(first.coverage.pendingRetries, 1);
  f.advance(61000); await runCftcHistoryPreparation({}, f.deps);
  f.advance(121000); const final = await runCftcHistoryPreparation({}, f.deps);
  assert.equal(final.status, 'done'); assert.equal(final.coverage.failed, 1);
  assert.equal(attempts.get('000001'), 3); assert.equal(attempts.get('000010'), 1);
  assert.equal(JSON.stringify(f.firstJob()).includes('private request details'), false);
});

test('CFTC millisecond Retry-After becomes seconds and a delayed shard leaves other shards runnable', async () => {
  const f = fixture();
  f.deps.prepare = async () => { throw Object.assign(new Error('busy'), { code: 'CFTC_RATE_LIMITED', retryAfter: 60000 }); };
  const first = await runCftcHistoryPreparation({}, f.deps);
  assert.equal(first.retryAfterSeconds, 60); assert.equal(f.firstJob().checkpoint.retries[0].attempts, 1);
  f.advance(1000); const second = await runCftcHistoryPreparation({}, f.deps);
  assert.equal(second.shard, 1); assert.equal(f.firstJob().checkpoint.workCount, 2);
});

test('lease contention is deferred without consuming an actual contract failure attempt', async () => {
  const f = fixture();
  f.deps.prepare = async () => { throw Object.assign(new Error('busy'), { code: 'CFTC_DURABLE_REFRESH_IN_PROGRESS' }); };
  const result = await runCftcHistoryPreparation({}, f.deps);
  assert.equal(result.coverage.pendingRetries, 2);
  assert.equal(f.firstJob().checkpoint.retries.every(item => item.attempts === 0), true);
  assert.equal(f.firstJob().attempts, 0);
});

test('same raw catalog revalidation resumes the exact frozen cursor despite a renewed head generation', async () => {
  const f = fixture(320); await runCftcHistoryPreparation({ maxContracts: 1 }, f.deps);
  const next = f.getCatalog(); next.generation = '5'; next.contentHash = 'd'.repeat(64); f.setCatalog(next); f.advance(2000);
  const result = await runCftcHistoryPreparation({ maxContracts: 1 }, f.deps);
  assert.equal(result.coverage.visited, 2); assert.equal(f.preparedCalls[1].code, '000002');
});

test('a revised latest catalog retires the old manifest without applying its cursor to new data', async () => {
  const f = fixture(320); await runCftcHistoryPreparation({ maxContracts: 1 }, f.deps);
  const next = f.getCatalog(); next.rows[0].open_interest_all = '123'; f.setCatalog(next); f.advance(2000);
  const result = await runCftcHistoryPreparation({ maxContracts: 1 }, f.deps);
  assert.equal(result.status, 'superseded'); assert.equal(f.preparedCalls.length, 1);
  assert.equal(f.firstJob().errorCode, 'CFTC_HISTORY_SUPERSEDED');
});

test('unavailable durable catalog yields previously queued jobs without upstream work or deleting progress', async () => {
  const f = fixture(320); await runCftcHistoryPreparation({ maxContracts: 1 }, f.deps);
  f.setCatalog(null); f.advance(2000); const result = await runCftcHistoryPreparation({}, f.deps);
  assert.equal(result.status, 'catalog-unavailable'); assert.equal(f.preparedCalls.length, 1);
  assert.equal(f.firstJob().checkpoint.cursor, 1); assert.equal(f.firstJob().attempts, 0);
});

test('a forged valid-looking manifest is rejected against the full current catalog before fetching', async () => {
  const f = fixture(320); await runCftcHistoryPreparation({ maxContracts: 1 }, f.deps);
  f.firstJob().checkpoint.contracts[1][1] = 'f'.repeat(64); f.advance(2000);
  await assert.rejects(runCftcHistoryPreparation({}, f.deps), { code: 'CFTC_HISTORY_MANIFEST_MISMATCH' });
  assert.equal(f.preparedCalls.length, 1); assert.equal(f.firstJob().checkpoint.cursor, 1);
});

test('foreign claim resource or job identity is terminally rejected with no contract fetch', async () => {
  const f = fixture(320); await runCftcHistoryPreparation({ maxContracts: 1 }, f.deps);
  f.firstJob().key = 'history-refresh:futures-only:disaggregated:shard:00'; f.advance(2000);
  const result = await runCftcHistoryPreparation({}, f.deps);
  assert.equal(result.status, 'invalid-checkpoint'); assert.equal(f.preparedCalls.length, 1);
  assert.equal(f.firstJob().state, 'dead');
});

test('unacknowledged checkpoint never advances stored progress even when contract publication succeeds', async () => {
  const f = fixture(); f.rejectCheckpoint();
  await assert.rejects(runCftcHistoryPreparation({}, f.deps), { code: 'CFTC_HISTORY_JOB_FENCE_LOST' });
  assert.equal(f.firstJob().checkpoint.cursor, 0); assert.equal(f.firstJob().checkpoint.prepared, 0);
  assert.equal(f.preparedCalls.length, 1);
});

test('a successful-looking response without a pinned durable receipt is retried rather than counted', async () => {
  const f = fixture(); f.deps.prepare = async args => receipt(args, { durable_receipt: { key: 'wrong', generation: '2', content_hash: hash(args.code) } });
  const result = await runCftcHistoryPreparation({}, f.deps);
  assert.equal(result.coverage.prepared, 0); assert.equal(result.coverage.pendingRetries, 2);
  assert.equal(f.firstJob().checkpoint.retries[0].code, 'CFTC_HISTORY_INVALID_RECEIPT');
});

test('wall-time budget stops between contracts and checkpoints the completed one', async () => {
  const f = fixture(320); f.deps.prepare = async args => { f.advance(15000); return receipt(args); };
  const result = await runCftcHistoryPreparation({ deadline: timestamp + 50000 }, f.deps);
  assert.equal(result.processed, 1); assert.equal(result.coverage.prepared, 1);
  assert.equal(result.status, 'resume-required'); assert.equal(f.firstJob().attempts, 0);
});

test('checkpoint validation rejects broken accounting, oversized state, duplicate identities and invalid retries', async () => {
  const f = fixture(320); await runCftcHistoryPreparation({ maxContracts: 1 }, f.deps);
  const cp = copy(f.firstJob().checkpoint);
  assert.equal(validCftcHistoryCheckpoint(cp), true);
  for (const changes of [{ prepared: 2 }, { limited: 2 }, { cursor: -1 }, { workCount: 0 }, { reportBasis: 'combined' },
    { contracts: [cp.contracts[0], cp.contracts[0]] }, { extra: 'x'.repeat(17000) },
    { prepared: 0, retries: [{ index: 0, attempts: 3, nextAt: timestamp, code: 'FAIL' }] }]) {
    assert.equal(validCftcHistoryCheckpoint({ ...cp, ...changes }), false);
  }
});


test('one invocation advances several small shards with a shared twelve-contract limit', async () => {
  const f = fixture(64);
  const result = await worker({}, f.deps);
  assert.equal(result.batches, 6); assert.equal(result.processed, 12);
  assert.equal(f.preparedCalls.length, 12);
  assert.equal([...f.jobs.values()].filter(job => job.state === 'done').length, 6);
  assert.equal(result.jobs.every(job => job.coverage.prepared === 2), true);
});

test('an invocation handles at most eight shards even when most are empty', async () => {
  const f = fixture(1);
  const result = await worker({}, f.deps);
  assert.equal(result.batches, 8); assert.equal(result.processed, 1);
  assert.equal([...f.jobs.values()].filter(job => job.state === 'done').length, 8);
});

test('a larger second shard is yielded when the global contract allowance is used', async () => {
  const f = fixture(320);
  const result = await worker({}, f.deps);
  assert.equal(result.batches, 2); assert.equal(result.processed, 12);
  assert.equal(result.jobs[0].coverage.prepared, 10);
  assert.equal(result.jobs[1].coverage.prepared, 2);
  assert.equal(result.jobs[1].status, 'resume-required');
});

test('multi-shard scheduling rechecks shared wall-time before another lease claim', async () => {
  const f = fixture(32);
  f.deps.prepare = async args => { f.advance(15000); return receipt(args); };
  const result = await worker({ deadline: timestamp + 65000 }, f.deps);
  assert.equal(result.batches, 2); assert.equal(result.processed, 2);
  assert.equal(f.calls.filter(call => call === 'claim').length, 2);
});

test('worker integrates the real bounded preparation helper and counts only its acknowledged source archive', async () => {
  const f = fixture(1), requested = [], saved = [], releases = [];
  const selected = f.getCatalog().rows[0];
  const rows = Array.from({ length: 600 }, (_, index) => ({ ...selected, id: index ? `prior-${index}` : selected.id,
    report_date_as_yyyy_mm_dd: `${new Date(Date.parse(date) - index * 7 * 86400000).toISOString().slice(0, 10)}T00:00:00.000` }));
  const persistence = {
    mode: () => 'supabase', reserveContractRaw: async () => ({ generation: '8' }),
    saveContractRaw: async ({ envelope, validate }) => {
      assert.equal(validate(envelope), true); saved.push(copy(envelope));
      return { metadata: { generation: '8', contentHash: hash(envelope.rows) } };
    },
    releaseContractRaw: async (_selection, claim) => { releases.push(claim); return true; },
  };
  f.deps.prepare = args => prepareCftcContractRawHistory({ ...args, persistence,
    outboundGate: { run: async fn => fn(), publishCooldown: async () => {} },
    fetchImpl: async input => {
      const url = new URL(input); requested.push(url);
      const offset = Number(url.searchParams.get('$offset'));
      return Response.json(rows.slice(offset, offset + 200));
    },
  });
  const result = await runCftcHistoryPreparation({}, f.deps);
  assert.equal(result.coverage.prepared, 1); assert.equal(result.coverage.failed, 0);
  assert.equal(saved.length, 1); assert.equal(saved[0].rows.length, 600); assert.equal(releases.length, 1);
  assert.deepEqual(requested.map(url => url.searchParams.get('$offset')), ['0', '200', '400']);
  assert.equal(requested.every(url => url.origin === 'https://publicreporting.cftc.gov'), true);
});

test('stalled catalog reads are bounded by the earlier worker deadline and cannot block the parent route', async () => {
  const f = fixture(), workerDeadline = new AbortController(), parent = new AbortController(), deadlines = [];
  let statusSignal;
  const readStatus = f.deps.readStatus;
  f.deps.readStatus = async options => { statusSignal = options.signal; return readStatus(); };
  f.deps.timeoutSignal = milliseconds => { deadlines.push(milliseconds); return workerDeadline.signal; };
  f.deps.catalogRaw = () => new Promise(() => { setTimeout(() => workerDeadline.abort(), 5); });
  await assert.rejects(worker({ signal: parent.signal, deadline: timestamp + 60000 }, f.deps), { code: 'CFTC_HISTORY_DEADLINE' });
  assert.deepEqual(deadlines, [60000]); assert.equal(statusSignal.aborted, true); assert.equal(parent.signal.aborted, false);
  assert.equal(f.enqueues.length, 0); assert.equal(f.preparedCalls.length, 0);
});

test('contract deadline leaves eighteen seconds for both checkpoint and release acknowledgment', async () => {
  const f = fixture(1), deadlines = [], contractDeadline = new AbortController();
  let lateResult;
  f.deps.timeoutSignal = milliseconds => {
    deadlines.push(milliseconds);
    return deadlines.length === 1 ? new AbortController().signal : contractDeadline.signal;
  };
  f.deps.prepare = args => {
    setTimeout(() => contractDeadline.abort(), 5);
    lateResult = new Promise(resolve => { setTimeout(() => resolve(receipt(args)), 15); });
    return lateResult;
  };
  const result = await runCftcHistoryPreparation({ deadline: timestamp + 40000 }, f.deps);
  assert.deepEqual(deadlines, [40000, 22000]);
  assert.equal(result.coverage.prepared, 0); assert.equal(result.coverage.pendingRetries, 1);
  assert.equal(f.firstJob().checkpoint.retries[0].code, 'CFTC_HISTORY_CONTRACT_DEADLINE');
  await lateResult;
  assert.equal(f.firstJob().checkpoint.prepared, 0, 'late helper completion cannot claim acknowledged queue progress');
});

test('an aborted worker never records a success even when the helper subsequently returns a receipt', async () => {
  const f = fixture(1), deadline = new AbortController(), parent = new AbortController();
  f.deps.timeoutSignal = () => deadline.signal;
  f.deps.prepare = async args => { assert.notEqual(args.signal, parent.signal); deadline.abort(); return receipt(args); };
  await assert.rejects(worker({ signal: parent.signal }, f.deps), { code: 'CFTC_HISTORY_DEADLINE' });
  assert.equal(f.firstJob().checkpoint.cursor, 0); assert.equal(f.firstJob().checkpoint.prepared, 0);
  assert.equal(f.calls.some(call => call.startsWith('finish:')), false);
  assert.equal(f.firstJob().state, 'running', 'the bounded lease recovers unacknowledged work');
});

test('a late checkpoint after deadline is never overwritten by a compensating finish with older state', async () => {
  const f = fixture(1), deadline = new AbortController(); let completed;
  f.deps.timeoutSignal = () => deadline.signal;
  f.deps.checkpointJob = (_claim, { checkpoint }) => {
    setTimeout(() => deadline.abort(), 5);
    completed = new Promise(resolve => { setTimeout(() => { f.firstJob().checkpoint = copy(checkpoint); resolve(true); }, 15); });
    return completed;
  };
  await assert.rejects(worker({}, f.deps), { code: 'CFTC_HISTORY_DEADLINE' });
  assert.equal(f.calls.some(call => call.startsWith('finish:')), false);
  await completed;
  assert.equal(f.firstJob().checkpoint.prepared, 1); assert.equal(f.firstJob().checkpoint.cursor, 1);
  assert.equal(f.firstJob().state, 'running');
});

test('a queue transport timeout leaves its generation lease intact rather than retrying an uncertain mutation', async () => {
  const f = fixture(1);
  f.deps.checkpointJob = async () => { throw Object.assign(new Error('network details'), { code: 'timeout' }); };
  await assert.rejects(worker({}, f.deps), { code: 'timeout' });
  assert.equal(f.calls.some(call => call.startsWith('finish:')), false);
  assert.equal(f.firstJob().state, 'running'); assert.equal(f.firstJob().checkpoint.cursor, 0);
});
