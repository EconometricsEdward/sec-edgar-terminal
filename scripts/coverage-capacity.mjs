#!/usr/bin/env node
/** Bounded public prepared-data measurement. No credentials, retries or cache bypass. */
import { request as httpsRequest, Agent } from 'node:https';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const CAPACITY_LIMITS = Object.freeze({
  origin: 'https://secedgarterminal.com', requests: 108, milliseconds: 300_000,
  requestsPerSecond: 5, routeRequestsPerMinute: 40, requestTimeoutMs: 20_000,
  wireBytes: 100 * 1024 * 1024, decodedBytes: 100 * 1024 * 1024,
  responseWireBytes: 1024 * 1024, responseDecodedBytes: 4 * 1024 * 1024,
});
export const CAPACITY_STAGES = Object.freeze([
  Object.freeze({ concurrency: 1, requests: 18 }),
  Object.freeze({ concurrency: 3, requests: 36 }),
  Object.freeze({ concurrency: 6, requests: 54 }),
]);
const company = (ticker, cik) => Object.freeze({ ticker, cik });
const aapl = company('AAPL', '0000320193'), amzn = company('AMZN', '0001018724');
const msft = company('MSFT', '0000789019'), jpm = company('JPM', '0000019617');
function scenario(id, route, basis, companies) {
  const path = route === 'portfolio' ? '/api/v1/portfolio-research'
    : `/api/${route}-research?ticker=${companies[0].ticker}&basis=${basis}${route === 'compare' ? '&format=packed' : ''}`;
  const body = route === 'portfolio' ? JSON.stringify({
    schema_version: 'edgar.portfolio.v1', action: 'research',
    holdings: companies.map(({ ticker }) => ({ ticker })),
    allocation: { basis: 'none', normalize: false }, research: { basis },
  }) : null;
  return Object.freeze({ id, route, basis, companies: Object.freeze(companies), path, body, method: body ? 'POST' : 'GET' });
}
export const CAPACITY_SCENARIOS = Object.freeze([
  scenario('analysis-amzn-quarter', 'analysis', 'quarter', [amzn]),
  scenario('compare-aapl-annual', 'compare', 'annual', [aapl]),
  scenario('portfolio-aapl-msft-jpm-annual', 'portfolio', 'annual', [aapl, msft, jpm]),
  scenario('analysis-aapl-annual', 'analysis', 'annual', [aapl]),
  scenario('compare-amzn-quarter', 'compare', 'quarter', [amzn]),
  scenario('portfolio-amzn-msft-jpm-quarter', 'portfolio', 'quarter', [amzn, msft, jpm]),
]);
const HEADER_NAMES = ['age', 'cache-control', 'content-encoding', 'content-type', 'server-timing',
  'x-cache-source', 'x-vercel-cache', 'x-vercel-id', 'x-data-fetched-at', 'x-data-revalidated-at',
  'x-data-stale', 'x-ratelimit-remaining', 'retry-after'];
const sources = new Set(['supabase-prepared', 'warm-prepared']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const dateMs = value => typeof value === 'string' ? Date.parse(value) : NaN;

export function validateCapacityResponse(scenarioValue, payload, headers, now = Date.now()) {
  if (!CAPACITY_SCENARIOS.includes(scenarioValue)) throw fail('UNKNOWN_SCENARIO');
  if (!payload || payload.error || payload.basis !== scenarioValue.basis) throw fail('CONTENT_BASIS');
  let identities;
  if (scenarioValue.route === 'portfolio') {
    const coverage = payload.coverage;
    if (payload.schema_version !== 'edgar.portfolio.v1' || !Array.isArray(payload.companies)
      || payload.companies.length !== scenarioValue.companies.length
      || coverage?.failed !== 0 || coverage?.unresolvedRows !== 0 || coverage?.unsupported !== 0
      || coverage?.researchedIssuers !== scenarioValue.companies.length) throw fail('PORTFOLIO_COVERAGE');
    identities = scenarioValue.companies.map(expected => {
      const actual = payload.companies.find(value => value.cik === expected.cik && value.ticker === expected.ticker);
      if (!actual || actual.basis !== scenarioValue.basis || !['ready', 'partial'].includes(actual.status)
        || !actual.period?.end || !Object.keys(actual.metrics || {}).length) throw fail('CONTENT_IDENTITY');
      if (!sources.has(actual.cache?.source)) throw fail('NOT_PREPARED');
      const checked = dateMs(actual.cache?.checkedAt || actual.cache?.storedAt);
      if (actual.cache?.status !== 'cached' || !Number.isFinite(checked)
        || checked > now + 60_000 || now - checked > 25 * 3600_000) throw fail('STALE_DATA');
      return { ticker: actual.ticker, cik: actual.cik, period: actual.period.end,
        metrics: Object.keys(actual.metrics).length, cacheSource: actual.cache.source,
        checkedAt: new Date(checked).toISOString(), stale: false };
    });
    if (coverage.staleCached !== 0) throw fail('STALE_DATA');
  } else {
    const expected = scenarioValue.companies[0];
    if (payload.cik !== expected.cik || payload.ticker !== expected.ticker || payload.packed !== true
      || !payload.periods?.length || !Object.keys(payload.metrics || {}).length
      || !payload.sourceCatalog?.length) throw fail('CONTENT_IDENTITY');
    if (!sources.has(headers['x-cache-source'])) throw fail('NOT_PREPARED');
    const checked = dateMs(headers['x-data-revalidated-at'] || headers['x-data-fetched-at']);
    if (headers['x-data-stale'] !== 'false' || !Number.isFinite(checked)
      || checked > now + 60_000 || now - checked > 25 * 3600_000) throw fail('STALE_DATA');
    identities = [{ ticker: payload.ticker, cik: payload.cik, period: payload.periods[0].end,
      metrics: Object.keys(payload.metrics).length, cacheSource: headers['x-cache-source'],
      checkedAt: new Date(checked).toISOString(), stale: false }];
  }
  return { basis: payload.basis, identities };
}

/** A sliding-window limiter: never raises public route rate limits or changes client IP. */
export function capacityRateWait(history, route, now) {
  const recent = history.filter(value => value.at > now - 60_000);
  const global = recent.filter(value => value.at > now - 1000);
  const routed = recent.filter(value => value.route === route);
  return Math.max(0,
    global.length >= CAPACITY_LIMITS.requestsPerSecond ? global[global.length - CAPACITY_LIMITS.requestsPerSecond].at + 1000 - now : 0,
    routed.length >= CAPACITY_LIMITS.routeRequestsPerMinute ? routed[routed.length - CAPACITY_LIMITS.routeRequestsPerMinute].at + 60_000 - now : 0);
}

export function decodeCapacityBody(raw, encoding = '') {
  if (raw.length > CAPACITY_LIMITS.responseWireBytes) throw fail('RESPONSE_WIRE_BUDGET');
  if (!['', 'identity', 'gzip'].includes(encoding)) throw fail('UNEXPECTED_ENCODING');
  const decoded = encoding === 'gzip' ? gunzipSync(raw, { maxOutputLength: CAPACITY_LIMITS.responseDecodedBytes }) : raw;
  if (decoded.length > CAPACITY_LIMITS.responseDecodedBytes) throw fail('RESPONSE_DECODED_BUDGET');
  return { payload: JSON.parse(decoded.toString('utf8')), decodedBytes: decoded.length, sha256: sha256(decoded) };
}

function publicTransport(scenarioValue, { signal, agent }) {
  if (!CAPACITY_SCENARIOS.includes(scenarioValue)) throw fail('UNKNOWN_SCENARIO');
  // Node HTTPS retains compressed bytes, unlike fetch's automatic decompression.
  // Redirects are not followed, and no operator-supplied URL or header is accepted.
  return new Promise((resolveRequest, rejectRequest) => {
    const start = performance.now();
    let responseBytes = 0;
    const request = httpsRequest(`${CAPACITY_LIMITS.origin}${scenarioValue.path}`, {
      method: scenarioValue.method, agent, signal,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip',
        'User-Agent': 'EDGARTerminal-AuthorizedCapacityCheck/1.0',
        ...(scenarioValue.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(scenarioValue.body) } : {}) },
    }, response => {
      const ttfbMs = performance.now() - start;
      const headers = Object.fromEntries(HEADER_NAMES.filter(name => response.headers[name] !== undefined)
        .map(name => [name, String(response.headers[name])]));
      const base = { status: response.statusCode, headers, ttfbMs };
      if (response.statusCode !== 200) {
        response.destroy();
        resolveRequest({ ...base, elapsedMs: performance.now() - start, wireBytes: 0, decodedBytes: 0 });
        return;
      }
      if (!/^application\/json(?:;|$)/i.test(headers['content-type'] || '')) {
        response.destroy(fail('CONTENT_TYPE'));
      }
      const chunks = [];
      response.on('data', chunk => {
        responseBytes += chunk.length;
        if (responseBytes > CAPACITY_LIMITS.responseWireBytes) response.destroy(fail('RESPONSE_WIRE_BUDGET'));
        else chunks.push(chunk);
      });
      response.on('error', rejectRequest);
      response.on('end', () => {
        try {
          const decoded = decodeCapacityBody(Buffer.concat(chunks), headers['content-encoding']);
          resolveRequest({ ...base, ...decoded, elapsedMs: performance.now() - start, wireBytes: responseBytes });
        } catch (error) { rejectRequest(error); }
      });
    });
    request.on('error', rejectRequest);
    if (scenarioValue.body) request.write(scenarioValue.body);
    request.end();
  });
}

export function percentile(values, fraction) {
  return values.length ? Math.round([...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] * 10) / 10 : null;
}
function counts(values) {
  return values.reduce((out, value) => { out[value ?? 'absent'] = (out[value ?? 'absent'] || 0) + 1; return out; }, {});
}
export function summarizeCapacity(samples) {
  const completed = samples.filter(value => !value.error);
  return { requests: samples.length, successful: completed.length, errors: samples.length - completed.length,
    latencyMs: { p50: percentile(completed.map(value => value.elapsedMs), .5),
      p95: percentile(completed.map(value => value.elapsedMs), .95), p99: percentile(completed.map(value => value.elapsedMs), .99) },
    wireBytes: samples.reduce((sum, value) => sum + (value.wireBytes || 0), 0),
    decodedBytes: samples.reduce((sum, value) => sum + (value.decodedBytes || 0), 0),
    httpStatuses: counts(samples.map(value => value.status || 0)),
    vercelCache: counts(samples.map(value => value.headers?.['x-vercel-cache'])),
    preparedSources: counts(samples.flatMap(value => value.content?.identities.map(identity => identity.cacheSource) || [])),
  };
}

export async function runCoverageCapacity({ transport = publicTransport, now = Date.now, wait = delay,
  emit = () => {}, signal } = {}) {
  const startedAt = new Date(now()).toISOString(), started = now();
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(CAPACITY_LIMITS.milliseconds);
  const runSignal = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])]);
  // Custom agents do not inherit NODE_USE_ENV_PROXY automatically. Honor the
  // runtime's existing proxy configuration (Node >=24.5), without logging it.
  const agent = new Agent({ keepAlive: true, maxSockets: 6, proxyEnv: process.env });
  const history = [], samples = [], stages = [];
  let stopReason = null, inFlight = 0, wireBytes = 0, decodedBytes = 0;
  const stop = reason => { stopReason ||= reason; controller.abort(fail(reason)); };
  try {
    for (const stage of CAPACITY_STAGES) {
      if (stopReason || runSignal.aborted) break;
      const stageStart = now(), first = samples.length;
      let assigned = 0, peakInFlight = 0;
      await Promise.all(Array.from({ length: stage.concurrency }, async () => {
        while (assigned < stage.requests && !stopReason && !runSignal.aborted) {
          // No await between the final rate/budget check and reservation: all
          // workers share one atomic event-loop decision, including the counters.
          const chosen = CAPACITY_SCENARIOS[(first + assigned) % CAPACITY_SCENARIOS.length];
          const hold = capacityRateWait(history, chosen.route, now());
          if (hold) { try { await wait(hold, undefined, { signal: runSignal }); } catch { break; } continue; }
          if (now() - started >= CAPACITY_LIMITS.milliseconds) { stop('TIME_BUDGET'); break; }
          if (history.length >= CAPACITY_LIMITS.requests) { stop('REQUEST_BUDGET'); break; }
          if (wireBytes + (inFlight + 1) * CAPACITY_LIMITS.responseWireBytes > CAPACITY_LIMITS.wireBytes
            || decodedBytes + (inFlight + 1) * CAPACITY_LIMITS.responseDecodedBytes > CAPACITY_LIMITS.decodedBytes) {
            stop('BYTE_BUDGET'); break;
          }
          assigned++; inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
          const requestedAt = now();
          history.push({ at: requestedAt, route: chosen.route });
          const receipt = { scenario: chosen.id, route: chosen.route, concurrencyLimit: stage.concurrency,
            startedAt: new Date(requestedAt).toISOString(), method: chosen.method, path: chosen.path };
          try {
            const result = await transport(chosen, { agent, signal: AbortSignal.any([
              runSignal, AbortSignal.timeout(CAPACITY_LIMITS.requestTimeoutMs),
            ]) });
            const { payload, ...metadata } = result;
            Object.assign(receipt, metadata);
            wireBytes += result.wireBytes || 0; decodedBytes += result.decodedBytes || 0;
            if (result.status !== 200) throw fail(`HTTP_${result.status}`);
            receipt.content = validateCapacityResponse(chosen, payload, result.headers, now());
          } catch (error) {
            receipt.error = stopReason ? 'CANCELLED_AFTER_STOP' : String(error.code || error.name || 'REQUEST_FAILED').slice(0, 80);
            receipt.elapsedMs ??= now() - requestedAt;
            stop(stopReason || receipt.error);
          } finally { inFlight--; samples.push(receipt); }
        }
      }));
      const subset = samples.slice(first);
      const result = { concurrencyLimit: stage.concurrency, peakInFlight, plannedRequests: stage.requests,
        elapsedMs: now() - stageStart, ...summarizeCapacity(subset),
        byRoute: Object.fromEntries(['analysis', 'compare', 'portfolio'].map(route => [route,
          summarizeCapacity(subset.filter(value => value.route === route))])) };
      stages.push(result); emit(result);
    }
  } finally { agent.destroy(); }
  if (runSignal.aborted && !stopReason) stopReason = 'CANCELLED_OR_TIME_BUDGET';
  return { kind: 'bounded-public-prepared-capacity-v1', startedAt, finishedAt: new Date(now()).toISOString(),
    runtime: { node: process.version, environmentProxyConfigured: Boolean(process.env.https_proxy || process.env.HTTPS_PROXY) },
    origin: CAPACITY_LIMITS.origin, limits: CAPACITY_LIMITS, stages, ...summarizeCapacity(samples),
    completed: samples.length === CAPACITY_LIMITS.requests && !stopReason, stopReason, samples,
    limitations: [
      'Configured concurrency caps simultaneous API requests; peakInFlight records the level actually reached. Neither is a count of visitors.',
      'One external test location and short sample; no browser rendering, geographic distribution, long soak, or 1,000-daily-user capacity guarantee.',
      'Normal cache behavior is preserved. CDN hits do not measure Supabase origin capacity, and no cache is flushed or bypassed.',
      'Response wire bytes are compressed HTTP body bytes, excluding headers and TLS. They are site traffic, not measured Supabase billable egress.',
      'Latency includes network, TLS/connection reuse, server response and local decompression/JSON parsing. Percentiles have small-sample uncertainty.',
      'Request errors, stale data, unexpected identities or unprepared responses abort the remaining ramp; no automatic retries.',
    ] };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('node scripts/coverage-capacity.mjs --execute --out=/absolute/new-receipt.json\nWithout --execute, no network requests run. Fixed public site, six prepared scenarios, concurrency caps 1/3/6, 108 requests, <=5 requests/second, <=5 minutes, <=100 MiB body budget, no retries.');
    return;
  }
  if (args.length !== 2 || !args.includes('--execute') || args.filter(value => value.startsWith('--out=')).length !== 1)
    throw fail('Use only --execute and --out=/absolute/new-receipt.json.');
  const out = args.find(value => value.startsWith('--out=')).slice(6);
  if (!isAbsolute(out)) throw fail('Output must use an absolute path.');
  // Reserve a new receipt before sending any request; accidental repeat runs fail.
  const output = await open(out, 'wx', 0o600);
  try {
    const report = await runCoverageCapacity({ emit: stage => console.log(JSON.stringify(stage)) });
    await output.writeFile(JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output: out, completed: report.completed, requests: report.requests, stopReason: report.stopReason }));
    if (!report.completed) process.exitCode = 1;
  } finally { await output.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(String(error.message || error)); process.exitCode = 1;
});
