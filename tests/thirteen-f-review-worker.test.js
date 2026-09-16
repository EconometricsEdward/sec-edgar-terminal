import test from 'node:test';
import assert from 'node:assert/strict';
import { createThirteenFReviewWorker, THIRTEEN_F_REVIEW_WORKER_LIMITS } from '../src/utils/thirteenFReviewWorker.js';
import { prepareThirteenFReviewReport, hashThirteenFReviewReport } from '../src/utils/thirteenFSharedReview.js';
import { takeSecRequestBudget, runWithSecRequestBudget } from '../src/utils/secRequestBudget.js';
import { createThirteenFMarketConnectionsLoader } from '../src/utils/thirteenFMarketConnectionsServer.js';
import { extractCompanyExposureMap } from '../src/utils/companyExposure.js';

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
function checked(report, key) {
  const value = unresolved(report, key), cik = '0000001234', checkedAt = new Date(NOW).toISOString();
  const filing = { accession: '0000001234-26-000001', form: '10-K', filed: '2026-02-20', reportDate: '2025-12-31',
    url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000001/report.htm' };
  const extracted = extractCompanyExposureMap([{ text: 'Our borrowings accrue interest based on SOFR and expose us to changing funding costs.', filing, role: 'annual' }], { companyName: value.holding.issuer });
  return { ...value, status: 'ready', identity: { status: 'resolved', cusip: value.holding.cusip,
    issuer: { cik, name: value.holding.issuer, kind: 'company', tickers: [] },
    evidence: [{ cik, cusips: [value.holding.cusip], form: 'SCHEDULE 13G', filingDate: '2026-03-01',
      url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000002/primary_doc.xml' }] },
    discovery: { schemaVersion: 'edgar.company-exposure-map.v1', cik, ticker: null, asOf: null, status: 'ready',
      checkedAt, generatedAt: checkedAt, sources: [{ ...filing, role: 'annual', status: 'ready', retrievedAt: checkedAt }],
      rows: extracted.rows, coverage: { ...extracted.coverage, searchComplete: true } } };
}
function fixture(count = 4, overrides = {}) {
  const frozen = prepareThirteenFReviewReport(report(count)), events = [], saved = new Map();
  let current = frozen, calls = 0;
  const claim = { id: 'fixture-job', cik: CIK, period: PERIOD, reportHash: hashThirteenFReviewReport(frozen),
    generation: '1', owner: 'fixture-owner', leaseUntil: new Date(NOW + 90000).toISOString(), cycle: 1, report: frozen };
  const store = {
    async claim(input, options) { events.push(['claim', input, options]); return structuredClone(claim); },
    async work(_claim, { limit, afterOrdinal = 0 }) {
      events.push(['work', limit]);
      return frozen.portfolio.holdings.map((holding, index) => ({ ordinal: index + 1, holding, attempts: saved.get(index + 1)?.attempts || 0 }))
        .filter(row => row.ordinal > afterOrdinal && (!saved.has(row.ordinal) || saved.get(row.ordinal).retrySeconds)).slice(0, limit);
    },
    async save(_claim, entry) {
      events.push(['save', entry.ordinal, entry.signal.aborted]);
      saved.set(entry.ordinal, { ...entry, attempts: (saved.get(entry.ordinal)?.attempts || 0) + 1 });
      return true;
    },
    async saveBatch(_claim, { results, signal }) {
      events.push(['saveBatch', results.length, signal.aborted]);
      for (const entry of results) saved.set(entry.ordinal, { ...entry, attempts: (saved.get(entry.ordinal)?.attempts || 0) + 1 });
      return true;
    },
    async release(_claim, options) { events.push(['release', options.signal.aborted]); return true; },
    async enqueue(value, hash) { events.push(['enqueue', value, hash]); return { reportHash: hash }; },
    ...overrides.store,
  };
  const options = { preparedLoader: async (_report, keys) => keys.map(() => null), store, enabled: () => true, owner: () => 'fixture-owner', now: () => NOW,
    portfolioLoader: async (cik, args) => { calls++; events.push(['portfolio', cik, args.period]); return current; },
    connectionLoader: async (value, key) => { events.push(['connection', key]); return unresolved(value, key); },
    ...overrides, store };
  return { events, saved, frozen, claim, options, create: () => createThirteenFReviewWorker(options),
    setCurrent: value => { current = value; }, portfolioCalls: () => calls };
}

test('full review resumes across independent invocations, checkpoints every holding and loads a report once per batch', async () => {
  const f = fixture(24);
  assert.equal((await f.create()({ maxHoldings: 12 })).processed, 12);
  assert.equal((await f.create()({ maxHoldings: 12 })).processed, 12);
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
  assert.equal(result.reason, 'request-budget');
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
  const result = await f.create()();
  assert.equal(result.code, 'REVIEW_WORK_INVALID');
  assert.equal(result.cik, CIK); assert.equal(result.period, PERIOD);
  assert.equal(result.owner, undefined); assert.equal(result.reportHash, undefined);
  assert.equal(f.events.some(([kind]) => kind === 'connection'), false); assert.equal(f.saved.size, 0);
});

test('disabled, exhausted request budgets and empty queues perform no source work', async () => {
  const disabled = fixture(1, { enabled: () => false });
  assert.equal((await disabled.create()()).status, 'disabled'); assert.equal(disabled.events.length, 0);
  const f = fixture(1);
  assert.equal((await f.create()({ deadline: NOW + 9999 })).reason, 'request-budget'); assert.equal(f.events.length, 0);
  const empty = fixture(1, { store: { claim: async () => null } });
  assert.equal((await empty.create()()).status, 'idle'); assert.equal(empty.portfolioCalls(), 0);
  await assert.rejects(f.create()({ maxHoldings: THIRTEEN_F_REVIEW_WORKER_LIMITS.maxHoldings + 1 }), { code: 'INVALID_REVIEW_BUDGET' });
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
  assert.equal(result.reason, 'source-cooldown');
  assert.ok([...f.saved.values()].every(entry => entry.retrySeconds === 3600));
});


test('prepared holdings drain several pages and publish in bounded batches without cold research', async () => {
  let sources = 0;
  const f = fixture(240, { preparedLoader: async (value, keys, { classificationOnly }) => classificationOnly ? keys.map(() => null) : keys.map(key => unresolved(value, key)),
    connectionLoader: async () => { sources++; throw new Error('Cached work must not become live research'); } });
  const result = await f.create()();
  assert.equal(result.processed, 240); assert.equal(result.prepared, 240); assert.equal(result.coldStarted, 0);
  assert.equal(f.portfolioCalls(), 1); assert.equal(sources, 0);
  assert.ok(f.events.filter(([kind]) => kind === 'saveBatch').every(([, count]) => count <= 50));
  assert.equal(f.saved.size, 240);
});

test('a new job publishes its first checked cached findings before cold research and resumes on the next claim', async () => {
  const f = fixture(3, { preparedLoader: async (value, keys, { classificationOnly }) =>
    keys.map(key => !classificationOnly && key === value.portfolio.holdings[0].key ? checked(value, key) : null) });
  f.claim.reviewed = 0;
  const first = await f.create()();
  assert.equal(first.status, 'progress'); assert.equal(first.reason, 'initial-publication');
  assert.equal(first.processed, 1); assert.equal(first.coldStarted, 0);
  assert.equal(first.cik, CIK); assert.equal(first.period, PERIOD);
  assert.equal(f.saved.get(1).summary.checked, true); assert.ok(f.saved.get(1).summary.markets.length > 0);
  assert.equal(f.events.some(([kind]) => kind === 'connection'), false);
  assert.deepEqual(f.events.at(-1), ['release', false], 'publication release occurs before the worker returns');
  f.claim.reviewed = 1;
  const second = await f.create()();
  assert.equal(second.processed, 2); assert.equal(second.coldStarted, 2); assert.equal(f.saved.size, 3);
});

test('existing jobs and unsupported-only initial results continue their cold research window', async () => {
  for (const [reviewed, resultFor] of [[2, checked], [0, unresolved]]) {
    const f = fixture(3, { preparedLoader: async (value, keys, { classificationOnly }) =>
      keys.map(key => !classificationOnly && key === value.portfolio.holdings[0].key ? resultFor(value, key) : null) });
    f.claim.reviewed = reviewed;
    const result = await f.create()();
    assert.equal(result.reason, undefined); assert.equal(result.processed, 3); assert.equal(result.coldStarted, 2);
  }
});

test('an exhausted parent SEC budget still publishes prepared research without cold attempts', async () => {
  const f = fixture(3, { preparedLoader: async (value, keys, { classificationOnly }) =>
    keys.map(key => !classificationOnly && key === value.portfolio.holdings[0].key ? checked(value, key) : null),
  connectionLoader: async () => { assert.fail('A zero source allowance must not start cold research.'); } });
  const result = await runWithSecRequestBudget(0, () => f.create()());
  assert.equal(result.prepared, 1); assert.equal(result.processed, 1); assert.equal(result.coldStarted, 0);
  assert.equal(result.sourceRequests, 0); assert.equal(f.saved.size, 1); assert.equal(f.saved.get(1).summary.checked, true);
  assert.equal(f.saved.get(1).attempts, 1); assert.equal(f.saved.get(1).retrySeconds, 0);
});

test('a cache batch timeout preserves completed hits and only researches the remaining holdings', async () => {
  const cold = [];
  const f = fixture(3, { preparedLoader: async (value, keys, { classificationOnly, onResult }) => {
    if (classificationOnly) return keys.map(() => null);
    onResult(0, unresolved(value, keys[0]));
    throw new DOMException('A different issuer cache lookup timed out.', 'TimeoutError');
  }, connectionLoader: async (value, key) => { cold.push(key); return unresolved(value, key); } });
  const result = await f.create()();
  assert.equal(result.prepared, 1); assert.equal(result.processed, 3); assert.equal(result.coldStarted, 2);
  assert.deepEqual(cold, f.frozen.portfolio.holdings.slice(1).map(value => value.key));
  assert.equal(f.saved.get(1).attempts, 1);
});

test('incrementally completed prepared entries retain exact holding checks after a sibling failure', async () => {
  const f = fixture(2, { preparedLoader: async (value, keys, { classificationOnly, onResult }) => {
    if (classificationOnly) return keys.map(() => null);
    onResult(0, unresolved(value, keys[1]));
    onResult(-1, unresolved(value, keys[0]));
    throw new Error('cache unavailable');
  } });
  const result = await f.create()();
  assert.equal(result.prepared, 0); assert.equal(result.coldStarted, 2);
  assert.equal(f.saved.get(1).result.holding.key, f.frozen.portfolio.holdings[0].key);
});

test('caller cancellation checkpoints completed prepared results without starting source work', async () => {
  const controller = new AbortController();
  const f = fixture(3, { preparedLoader: async (value, keys, { classificationOnly, onResult }) => {
    if (classificationOnly) return keys.map(() => null);
    onResult(0, unresolved(value, keys[0])); controller.abort();
    throw controller.signal.reason;
  }, connectionLoader: async () => { assert.fail('Cancelled prepared work must not start SEC research.'); } });
  const result = await f.create()({ signal: controller.signal });
  assert.equal(result.prepared, 1); assert.equal(result.processed, 1); assert.equal(result.coldStarted, 0);
  assert.deepEqual(f.events.at(-1), ['release', false]);
});

test('deterministic classifications publish before prepared-cache reads and skip the cold allowance', async () => {
  let classifiedPublished = false;
  const f = fixture(180, { preparedLoader: async (value, keys, { classificationOnly }) => {
    if (!classificationOnly) { classifiedPublished = f.saved.size > 0; return keys.map(() => null); }
    return keys.map(key => Number(key.slice(0, 9)) % 2 === 0 ? unresolved(value, key) : null);
  } });
  const result = await f.create()();
  assert.equal(classifiedPublished, true); assert.equal(result.prepared, 90);
  assert.equal(result.coldStarted, THIRTEEN_F_REVIEW_WORKER_LIMITS.coldHoldings);
  assert.equal(result.processed, 150);
  assert.ok([...f.saved.values()].some(entry => entry.result.holding.cusip === '000000180'), 'later prepared rows are not blocked by unattempted cold rows');
});

test('cold lookup ceiling and actual source allowance remain separate from prepared throughput', async () => {
  let actual = 0;
  const f = fixture(160, { preparedLoader: async (value, keys, { classificationOnly }) => classificationOnly ? keys.map(() => null)
    : keys.map(key => Number(key.slice(0, 9)) > 100 ? unresolved(value, key) : null),
    connectionLoader: async (value, key) => {
      for (let i = 0; i < 5; i++) {
        if (!takeSecRequestBudget()) throw Object.assign(new Error('allowance used'), { code: 'SEC_REQUEST_BUDGET_EXHAUSTED', status: 429 });
        actual++;
      }
      return unresolved(value, key);
    } });
  const result = await f.create()();
  assert.equal(actual, THIRTEEN_F_REVIEW_WORKER_LIMITS.sourceRequests);
  assert.equal(result.sourceRequests, actual); assert.equal(result.prepared, 60);
  assert.ok(result.coldStarted < THIRTEEN_F_REVIEW_WORKER_LIMITS.coldHoldings);
  assert.ok([...f.saved.values()].some(entry => entry.result.holding.cusip === '000000160'), 'later saved evidence still publishes when the SEC allowance is exhausted');
});

test('source-free prepared helper cannot consume an SEC request even accidentally', async () => {
  let allowed;
  const f = fixture(1, { preparedLoader: async (_value, keys) => {
    allowed = takeSecRequestBudget(); return keys.map(() => null);
  } });
  const result = await f.create()();
  assert.equal(allowed, false); assert.equal(result.sourceRequests, 0);
});

test('adaptive work stops at its time budget and does not start another report load', async () => {
  let time = NOW;
  const f = fixture(300, { now: () => time, preparedLoader: async (value, keys, { classificationOnly }) => {
    if (classificationOnly) return keys.map(() => null);
    time += 30_000;
    return keys.map(key => unresolved(value, key));
  } });
  const result = await f.create()();
  assert.ok(result.processed > 12 && result.processed < 300); assert.equal(f.portfolioCalls(), 1);
  assert.ok(time - NOW <= THIRTEEN_F_REVIEW_WORKER_LIMITS.invocationMs + 30_000);
});

test('a rejected prepared batch counts no progress and stops further pages', async () => {
  const f = fixture(120, { preparedLoader: async (value, keys) => keys.map(key => unresolved(value, key)),
    store: { saveBatch: async () => false } });
  const result = await f.create()();
  assert.equal(result.status, 'lease-lost'); assert.equal(result.processed, 0);
  assert.equal(f.events.filter(([kind]) => kind === 'work').length, 1);
});


test('exhausting the invocation request allowance leaves the holding pending without spending a retry', async () => {
  const f = fixture(3, { connectionLoader: async () => {
    while (takeSecRequestBudget()) { /* Simulate many bounded source attempts. */ }
    throw Object.assign(new Error('local work allowance'), { code: 'SEC_REQUEST_BUDGET_EXHAUSTED', status: 429 });
  } });
  const result = await f.create()();
  assert.equal(result.status, 'deferred'); assert.equal(result.reason, 'source-budget');
  assert.equal(result.processed, 0); assert.equal(result.retrying, 0); assert.equal(f.saved.size, 0);
});

test('a lower source layer wrapping allowance exhaustion cannot publish a false unavailable status', async () => {
  const f = fixture(1, { connectionLoader: async (value, key) => {
    while (takeSecRequestBudget()) { /* Simulate the nested source loader. */ }
    return { ...unresolved(value, key), status: 'unavailable', retryable: true, identity: null,
      message: 'Source unavailable' };
  } });
  const result = await f.create()();
  assert.equal(result.processed, 0); assert.equal(f.saved.size, 0); assert.equal(result.reason, 'source-budget');
});

test('multiple work pages cannot exceed the remaining daily attempt allowance', async () => {
  let calls = 0;
  const f = fixture(40, { connectionLoader: async (value, key) => { calls++; return unresolved(value, key); } });
  f.claim.attemptsRemaining = 1;
  const result = await f.create()();
  assert.equal(result.processed, 1); assert.equal(calls, 1); assert.equal(f.saved.size, 1);
});
