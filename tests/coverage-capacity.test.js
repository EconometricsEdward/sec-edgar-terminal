import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  CAPACITY_LIMITS, CAPACITY_SCENARIOS, capacityRateWait, decodeCapacityBody,
  validateCapacityResponse, runCoverageCapacity, summarizeCapacity,
} from '../scripts/coverage-capacity.mjs';

const clock = Date.parse('2026-09-13T10:00:00Z');
function response(scenario, now = clock) {
  const checkedAt = new Date(now - 60_000).toISOString();
  const headers = { 'content-type': 'application/json', 'x-cache-source': 'supabase-prepared',
    'x-data-stale': 'false', 'x-data-revalidated-at': checkedAt };
  const payload = scenario.route === 'portfolio' ? {
    schema_version: 'edgar.portfolio.v1', basis: scenario.basis,
    coverage: { failed: 0, unsupported: 0, unresolvedRows: 0, staleCached: 0, researchedIssuers: 3 },
    companies: scenario.companies.map(company => ({ ...company, basis: scenario.basis, status: 'partial',
      period: { end: '2026-06-30' }, metrics: { cash: { value: 123 } },
      cache: { status: 'cached', source: 'supabase-prepared', checkedAt } })),
  } : { ...scenario.companies[0], basis: scenario.basis, packed: true,
    periods: [{ end: '2026-06-30' }], metrics: { cash: [] }, sourceCatalog: [{ value: 123 }] };
  return { status: 200, headers, payload, elapsedMs: 100, ttfbMs: 80, wireBytes: 1000, decodedBytes: 5000 };
}

test('measurement accepts only fixed prepared issuer/basis identities and fresh evidence', () => {
  for (const scenario of CAPACITY_SCENARIOS) {
    const result = response(scenario);
    assert.equal(validateCapacityResponse(scenario, result.payload, result.headers, clock).identities.length, scenario.companies.length);
    result.payload.basis = 'invented';
    assert.throws(() => validateCapacityResponse(scenario, result.payload, result.headers, clock), /CONTENT_BASIS/);
  }
  const scenario = CAPACITY_SCENARIOS[0], result = response(scenario);
  assert.throws(() => validateCapacityResponse({ ...scenario, path: 'https://data.sec.gov/' }, result.payload, result.headers, clock), /UNKNOWN_SCENARIO/);
  result.headers['x-cache-source'] = 'upstream';
  assert.throws(() => validateCapacityResponse(scenario, result.payload, result.headers, clock), /NOT_PREPARED/);
  result.headers['x-cache-source'] = 'supabase-prepared';
  result.payload.cik = '0000000001';
  assert.throws(() => validateCapacityResponse(scenario, result.payload, result.headers, clock), /CONTENT_IDENTITY/);
});

test('a stale label or stale age stops measurement even when the HTTP status is successful', () => {
  const scenario = CAPACITY_SCENARIOS[0], result = response(scenario);
  result.headers['x-data-stale'] = 'true';
  assert.throws(() => validateCapacityResponse(scenario, result.payload, result.headers, clock), /STALE_DATA/);
  result.headers['x-data-stale'] = 'false';
  result.headers['x-data-revalidated-at'] = new Date(clock - 26 * 3600_000).toISOString();
  assert.throws(() => validateCapacityResponse(scenario, result.payload, result.headers, clock), /STALE_DATA/);
  const portfolio = CAPACITY_SCENARIOS[2], bad = response(portfolio);
  bad.payload.companies[0].cache.status = 'stale';
  assert.throws(() => validateCapacityResponse(portfolio, bad.payload, bad.headers, clock), /STALE_DATA/);
  bad.payload.coverage.failed = 1;
  assert.throws(() => validateCapacityResponse(portfolio, bad.payload, bad.headers, clock), /PORTFOLIO_COVERAGE/);
});

test('sliding limits bound global bursts and each public route without bypassing rate controls', () => {
  const history = Array.from({ length: 5 }, (_, index) => ({ at: index * 100, route: 'analysis' }));
  assert.equal(capacityRateWait(history, 'compare', 500), 500);
  assert.equal(capacityRateWait(history, 'compare', 1000), 0);
  const routed = Array.from({ length: 40 }, (_, index) => ({ at: index * 1000, route: 'analysis' }));
  assert.equal(capacityRateWait(routed, 'analysis', 40_000), 20_000);
  assert.equal(capacityRateWait(routed, 'compare', 40_000), 0);
});

test('compressed body limits stop unexpectedly large and unsupported response bodies', () => {
  const bytes = Buffer.from(JSON.stringify({ public: 'fixture' }));
  assert.deepEqual(decodeCapacityBody(gzipSync(bytes), 'gzip').payload, { public: 'fixture' });
  assert.throws(() => decodeCapacityBody(bytes, 'br'), /UNEXPECTED_ENCODING/);
  assert.throws(() => decodeCapacityBody(Buffer.alloc(CAPACITY_LIMITS.responseWireBytes + 1)), /RESPONSE_WIRE_BUDGET/);
  const bomb = gzipSync(Buffer.alloc(CAPACITY_LIMITS.responseDecodedBytes + 1, 32));
  assert.throws(() => decodeCapacityBody(bomb, 'gzip'));
});

test('the full rehearsal caps requests, reports achieved concurrency and retains no response payloads', async () => {
  let now = clock;
  const starts = [];
  const report = await runCoverageCapacity({ now: () => now,
    wait: async ms => { now += ms; },
    transport: async scenario => {
      starts.push({ at: now, route: scenario.route });
      await Promise.resolve();
      return response(scenario, now);
    } });
  assert.equal(report.completed, true);
  assert.equal(report.requests, 108);
  assert.equal(report.errors, 0);
  assert.deepEqual(report.stages.map(stage => stage.concurrencyLimit), [1, 3, 6]);
  assert.ok(report.stages.every(stage => stage.peakInFlight <= stage.concurrencyLimit));
  assert.ok(report.stages.some(stage => stage.peakInFlight > 1));
  for (let i = 0; i < starts.length; i++) assert.equal(capacityRateWait(starts.slice(0, i), starts[i].route, starts[i].at), 0);
  assert.ok(report.samples.every(sample => !Object.hasOwn(sample, 'payload')));
  assert.equal(report.wireBytes, 108_000);
});

test('an HTTP failure aborts the first stage and is never retried', async () => {
  let calls = 0;
  const report = await runCoverageCapacity({ transport: async () => {
    calls++; return { status: 429, elapsedMs: 100, wireBytes: 0, decodedBytes: 0, headers: {} };
  } });
  assert.equal(calls, 1);
  assert.equal(report.completed, false);
  assert.equal(report.stopReason, 'HTTP_429');
  assert.equal(report.stages.length, 1);
  assert.equal(report.errors, 1);
});

test('the aggregate decoded-body reservation ends a large-response run within its budget', async () => {
  let now = clock;
  const report = await runCoverageCapacity({ now: () => now, wait: async ms => { now += ms; },
    transport: async scenario => ({ ...response(scenario, now), decodedBytes: CAPACITY_LIMITS.responseDecodedBytes }),
  });
  assert.equal(report.completed, false);
  assert.equal(report.stopReason, 'BYTE_BUDGET');
  assert.ok(report.decodedBytes <= CAPACITY_LIMITS.decodedBytes);
  assert.ok(report.requests < CAPACITY_LIMITS.requests);
});

test('error responses are counted separately from successful latency percentiles', () => {
  const summary = summarizeCapacity([{ status: 200, elapsedMs: 12, headers: {}, wireBytes: 10 },
    { status: 503, elapsedMs: 10000, error: 'HTTP_503', headers: {}, wireBytes: 1 }]);
  assert.equal(summary.errors, 1);
  assert.equal(summary.latencyMs.p95, 12);
  assert.equal(summary.wireBytes, 11);
});
