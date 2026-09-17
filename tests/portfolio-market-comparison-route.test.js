import test from 'node:test';
import { execFileSync } from 'node:child_process';

async function fixture() {
  const { mock } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const root = process.argv[1];
  let scenario = {}, calls = [];
  const dependency = (path, namedExports) => mock.module(new URL(path, root).href, { namedExports });
  dependency('src/utils/cftcFeature.js', { isCftcEnabled: () => scenario.enabled !== false });
  dependency('src/utils/rateLimit.js', {
    checkRateLimit: async options => { calls.push(['limit', options]); return { allowed: scenario.allowed !== false }; },
    getClientIp: () => '192.0.2.1', rateLimitHeaders: () => ({ 'RateLimit-Limit': '20' }),
    rateLimitedResponse: () => Response.json({ error: 'Too many requests.' }, { status: 429, headers: { 'Cache-Control': 'private, no-store' } }),
  });
  dependency('src/utils/portfolioMarketComparisonServer.js', {
    PORTFOLIO_MARKET_COMPARISON_VERSION: 'edgar.portfolio-market-comparison.v1',
    loadPortfolioMarketComparison: async options => {
      calls.push(['load', options]);
      if (scenario.throw || options.signal.aborted) throw new Error('Private source credentials');
      return { schemaVersion: 'edgar.portfolio-market-comparison.v1', generatedAt: '2026-09-09T12:00:00.000Z', status: scenario.status || 'ready', results: [] };
    },
  });
  const { GET, OPTIONS, maxDuration } = await import(new URL('src/app/api/v1/cftc/market-comparison/route.js', root).href);
  async function run(value = {}, suffix = '', signal) {
    scenario = value; calls = [];
    const response = await GET(new Request(`https://secedgarterminal.com/api/v1/cftc/market-comparison${suffix}`, { signal }));
    return { response, body: await response.json() };
  }
  assert.equal(maxDuration, 20);
  let result = await run();
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get('cache-control'), 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600');
  assert.equal(result.response.headers.get('x-schema-version'), 'edgar.portfolio-market-comparison.v1');
  assert.match(result.response.headers.get('link'), /portfolio-market-comparison-v1\.schema\.json/);
  assert.match(result.response.headers.get('access-control-expose-headers'), /Link/);
  assert.equal(result.response.headers.get('access-control-allow-origin'), '*');
  assert.equal(result.response.headers.get('ratelimit-limit'), '20');
  assert.deepEqual(calls.map(([name]) => name), ['limit', 'load']);
  assert.equal(calls[0][1].max, 20);
  assert.equal(calls[0][1].windowMs, 600_000);
  assert.match(calls[0][1].key, /^rl:cftc-market-comparison:/);
  assert.deepEqual(Object.keys(calls[1][1]), ['signal']);
  for (const status of ['partial', 'unavailable']) {
    result = await run({ status });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, status);
    assert.equal(result.response.headers.get('cache-control'), 'public, max-age=0, s-maxage=60');
  }
  for (const suffix of ['?portfolio=private', '?contract=13874A', '?refresh=1', '?family=tff&family=tff']) {
    result = await run({}, suffix);
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, 'UNKNOWN_QUERY_PARAMETER');
    assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(calls.map(([name]) => name), ['limit']);
  }
  result = await run({ allowed: false });
  assert.equal(result.response.status, 429);
  assert.deepEqual(calls.map(([name]) => name), ['limit']);
  result = await run({ enabled: false });
  assert.equal(result.response.status, 503);
  assert.equal(result.body.code, 'CFTC_DISABLED');
  assert.deepEqual(calls, []);
  result = await run({ throw: true });
  assert.equal(result.response.status, 503);
  assert.equal(result.body.code, 'CFTC_COMPARISON_UNAVAILABLE');
  assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
  assert.doesNotMatch(JSON.stringify(result.body), /Private|credentials/);
  const abort = new AbortController(); abort.abort();
  result = await run({}, '', abort.signal);
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
  const preflight = OPTIONS();
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  mock.restoreAll();
}

test('public comparison route shares only fixed prepared data, short-caches gaps, rejects parameters and preserves controls', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e',
    `await (${fixture.toString()})();`, new URL('../', import.meta.url).href],
  { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
});
