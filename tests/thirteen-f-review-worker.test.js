import test from 'node:test';
import assert from 'node:assert/strict';
import { createThirteenFReviewWorker, THIRTEEN_F_REVIEW_WORKER_LIMITS } from '../src/utils/thirteenFReviewWorker.js';
import { prepareThirteenFReviewReport, hashThirteenFReviewReport } from '../src/utils/thirteenFSharedReview.js';
import { createThirteenFMarketConnectionsLoader } from '../src/utils/thirteenFMarketConnectionsServer.js';

const CIK = '0001747057', PERIOD = '2026-06-30', NOW = Date.parse('2026-09-15T12:00:00Z');
function report(count = 4) {
  return { manager: { cik: CIK, name: 'Fixture Capital' }, selectedPeriod: PERIOD, observedAt: new Date(NOW).toISOString(),
    coverage: { selectedPeriodComplete: true }, portfolio: { cik: CIK, period: PERIOD, complete: true, positionCount: count,
      totalValueUsd: count * 100, holdings: Array.from({ length: count }, (_, index) => {
        const cusip = String(index + 1).padStart(9, '0');
        return { key: `${cusip}|SECURITY|SH`, cusip, issuer: `Issuer ${index + 1}`, classTitle: 'COM', putCall: null,
          quantity: 10, quantityType: 'SH', valueUsd: 100, weightPct: 100 / count };
      }) } };
}
function unresolved(report, key) {
  const holding = report.portfolio.holdings.find(holding => holding.key === key);
  return { schemaVersion: 'edgar.13f-market-connections.v1', status: 'unresolved', manager: report.manager,
    selectedPeriod: report.selectedPeriod, holding, observedAt: new Date(NOW).toISOString(), retryable: false,
    identity: { status: 'unresolved', cusip: holding.cusip, observedAt: new Date(NOW).toISOString(), reason: 'No verified issuer proof was found.' }, discovery: null };
}
function fixture(count = 4, overrides = {}) {
  const frozen = prepareThirteenFReviewReport(report(count)), events = [], saved = new Map();
  let current = frozen, calls = 0;
  const claim = { id: 'fixture-job', cik: CIK, period: PERIOD, reportHash: hashThirteenFReviewReport(frozen),
    generation: '1', owner: 'fixture-owner', leaseUntil: new Date(NOW + 90000).toISOString(), cycle: 1, report: frozen };
  const store = {
    async claim(input, options) { events.push(['claim', input, options]); return structuredClone(claim); },
    async work(_claim, { limit }) {
      events.push(['work', limit]);
      return frozen.portfolio.holdings.map((holding, index) => ({ ordinal: index + 1, holding, attempts: saved.get(index + 1)?.attempts || 0 }))
        .filter(row => !saved.has(row.ordinal) || saved.get(row.ordinal).retrySeconds).slice(0, limit);
    },
    async save(_claim, entry) {
      events.push(['save', entry.ordinal, entry.signal.aborted]);
      saved.set(entry.ordinal, { ...entry, attempts: (saved.get(entry.ordinal)?.attempts || 0) + 1 });
      return true;
    },
    async release(_claim, options) { events.push(['release', options.signal.aborted]); return true; },
    async enqueue(value, hash) { events.push(['enqueue', value, hash]); return { reportHash: hash }; },
    ...overrides.store,
  };
  const options = { store, enabled: () => true, owner: () => 'fixture-owner', now: () => NOW,
    portfolioLoader: async (cik, args) => { calls++; events.push(['portfolio', cik, args.period]); return current; },
    connectionLoader: async (value, key) => { events.push(['connection', key]); return unresolved(value, key); },
    ...overrides, store };
  return { events, saved, frozen, claim, options, create: () => createThirteenFReviewWorker(options),
    setCurrent: value => { current = value; }, portfolioCalls: () => calls };
}

test('full review resumes across independent invocations, checkpoints every holding and loads a report once per batch', async () => {
  const f = fixture(24);
  assert.equal((await f.create()()).processed, 12);
  assert.equal((await f.create()()).processed, 12);
  assert.equal(f.saved.size, 24);
  assert.equal(f.portfolioCalls(), 2);
  assert.equal(f.events.filter(([kind]) => kind === 'release').length, 2);
  assert.ok([...f.saved.values()].every(entry => entry.summary.status === 'unresolved' && entry.attempts === 1));
});

test('source concurrency is bounded to two without losing completed results', async () => {
  let active = 0, maxActive = 0;
  const f = fixture(12, { connectionLoader: async (value, key) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--; return unresolved(value, key);
  } });
  const result = await f.create()();
  assert.equal(result.processed, 12); assert.equal(maxActive, 2); assert.equal(active, 0);
  assert.equal(f.events.at(-1)[0], 'release');
});

test('temporary source failures have durable bounded retries and a final unavailable status', async () => {
  const f = fixture(1, { connectionLoader: async () => { throw Object.assign(new Error('private detail'), { code: 'SEC_SOURCE_FAILED' }); } });
  for (const [attempt, retrySeconds] of [[1, 60], [2, 120], [3, 0]]) {
    const result = await f.create()();
    assert.equal(result.processed, 1);
    assert.equal(f.saved.get(1).attempts, attempt);
    assert.equal(f.saved.get(1).retrySeconds, retrySeconds);
    assert.equal(f.saved.get(1).summary.status, 'unavailable');
    assert.equal(JSON.stringify(f.saved.get(1)).includes('private detail'), false);
  }
  assert.match(f.saved.get(1).summary.message, /bounded retry attempts/);
});

test('caller cancellation still checkpoints the attempt and releases with an independent live signal', async () => {
  const controller = new AbortController();
  const f = fixture(4, { connectionLoader: async () => {
    controller.abort(); throw new DOMException('stopped', 'AbortError');
  } });
  const result = await f.create()({ signal: controller.signal });
  assert.equal(result.status, 'deferred'); assert.equal(result.processed, 1);
  assert.equal(f.saved.get(1).summary.status, 'unavailable');
  assert.deepEqual(f.events.find(([kind]) => kind === 'save').slice(1), [1, false]);
  assert.deepEqual(f.events.at(-1), ['release', false]);
});

test('a lost publication fence stops new work and does not count unacknowledged progress', async () => {
  let connectionCalls = 0;
  const f = fixture(12, { store: { save: async () => false }, connectionLoader: async (value, key) => {
    connectionCalls++; await new Promise(resolve => setTimeout(resolve, 2)); return unresolved(value, key);
  } });
  const result = await f.create()();
  assert.equal(result.status, 'lease-lost'); assert.equal(result.processed, 0);
  assert.equal(connectionCalls, 2); assert.equal(f.events.at(-1)[0], 'release');
});

test('a storage exception waits for the active sibling before releasing and stops starting work', async () => {
  let connectionCalls = 0, inFlight = 0;
  const f = fixture(12, { store: { save: async () => { throw new Error('database unavailable'); },
    release: async () => { assert.equal(inFlight, 0); return true; } }, connectionLoader: async (value, key) => {
    connectionCalls++; inFlight++; await new Promise(resolve => setTimeout(resolve, 2));
    inFlight--; return unresolved(value, key);
  } });
  const result = await f.create()();
  assert.equal(result.status, 'deferred'); assert.equal(result.processed, 0); assert.equal(connectionCalls, 2);
});

test('amendments replace the report binding before any holding is reviewed', async () => {
  const f = fixture();
  const changed = structuredClone(f.frozen); changed.portfolio.totalValueUsd++;
  f.setCurrent(changed);
  const result = await f.create()();
  assert.equal(result.status, 'report-updated'); assert.equal(result.processed, 0);
  assert.equal(f.events.some(([kind]) => kind === 'connection' || kind === 'work'), false);
  assert.equal(f.events.find(([kind]) => kind === 'enqueue')[2], hashThirteenFReviewReport(changed));
  assert.equal(f.events.at(-1)[0], 'release');
});

test('an unchanged source check does not restart review, but a mismatched quarter cannot be substituted', async () => {
  const f = fixture(1);
  const newer = structuredClone(f.frozen); newer.cache.checkedAt = new Date(NOW + 1000).toISOString();
  f.setCurrent(newer);
  assert.equal((await f.create()()).processed, 1);
  assert.equal(f.events.some(([kind]) => kind === 'enqueue'), false);
  const wrong = fixture(1), replacement = structuredClone(wrong.frozen);
  replacement.selectedPeriod = replacement.portfolio.period = '2026-03-31'; wrong.setCurrent(replacement);
  assert.equal((await wrong.create()()).code, 'REVIEW_REPORT_IDENTITY_MISMATCH');
  assert.equal(wrong.saved.size, 0);
});

test('corrupt work identity cannot attach a result to another ordinal', async () => {
  const f = fixture(2, { store: { work: async () => [{ ordinal: 1, attempts: 0, holding: report(2).portfolio.holdings[1] }] } });
  assert.equal((await f.create()()).code, 'REVIEW_WORK_INVALID');
  assert.equal(f.events.some(([kind]) => kind === 'connection'), false); assert.equal(f.saved.size, 0);
});

test('disabled, exhausted request budgets and empty queues perform no source work', async () => {
  const disabled = fixture(1, { enabled: () => false });
  assert.equal((await disabled.create()()).status, 'disabled'); assert.equal(disabled.events.length, 0);
  const f = fixture(1);
  assert.equal((await f.create()({ deadline: NOW + 9999 })).reason, 'request-budget'); assert.equal(f.events.length, 0);
  const empty = fixture(1, { store: { claim: async () => null } });
  assert.equal((await empty.create()()).status, 'idle'); assert.equal(empty.portfolioCalls(), 0);
  await assert.rejects(f.create()({ maxHoldings: THIRTEEN_F_REVIEW_WORKER_LIMITS.batch + 1 }), { code: 'INVALID_REVIEW_BUDGET' });
});

test('frozen-report connection helper preserves holding checks without fetching a portfolio per holding', async () => {
  let portfolioCalls = 0;
  const instance = createThirteenFMarketConnectionsLoader({ enabled: () => true,
    portfolioLoader: async () => { portfolioCalls++; throw new Error('unexpected portfolio load'); },
    identityLoader: async holding => ({ status: 'unresolved', cusip: holding.cusip, observedAt: new Date(NOW).toISOString(), reason: 'unresolved' }),
    preparedCache: { getMany: async () => [null], put: async () => false }, now: () => NOW });
  const frozen = prepareThirteenFReviewReport(report(1));
  const value = await instance.fromReport(frozen, frozen.portfolio.holdings[0].key);
  assert.equal(value.status, 'unresolved'); assert.equal(portfolioCalls, 0);
  await assert.rejects(instance.fromReport(frozen, '999999999|SECURITY|SH'), { code: 'HOLDING_NOT_FOUND' });
  frozen.portfolio.cik = '0000000001';
  await assert.rejects(instance.fromReport(frozen, frozen.portfolio.holdings[0].key), { code: 'REPORT_IDENTITY_MISMATCH' });
});


test('SEC rate cooldown stops new sources and preserves the advertised retry delay', async () => {
  let calls = 0;
  const f = fixture(12, { connectionLoader: async () => {
    calls++;
    throw Object.assign(new Error('slow down'), { code: 'SEC_RATE_GATE_SATURATED', status: 429, retryAfter: 3600 });
  } });
  const result = await f.create()();
  assert.equal(result.status, 'deferred'); assert.ok(calls <= 2); assert.equal(result.processed, calls);
  assert.ok([...f.saved.values()].every(entry => entry.retrySeconds === 3600));
});
