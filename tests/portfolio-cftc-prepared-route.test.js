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
    getClientIp: () => '192.0.2.1', rateLimitHeaders: () => ({ 'X-RateLimit-Limit': '12' }),
    rateLimitedResponse: () => Response.json({ error: 'Too many requests.' }, { status: 429 }),
  });
  dependency('src/utils/portfolioCftcChanges.js', {
    PORTFOLIO_CFTC_CHANGES_VERSION: 'test-schema', PORTFOLIO_CFTC_COMPANY_LIMIT: 24,
    buildPortfolioCftcChanges: async input => { calls.push(['live', input]); return { coverage: { checked: Math.min(24, input.companies.length) } }; },
  });
  dependency('src/utils/portfolioCftcPreparation.js', {
    readPreparedPortfolioCftcChanges: async (input, options) => {
      calls.push(['prepared', input]);
      if (options.signal.aborted) throw options.signal.reason;
      if (scenario.throw) throw new Error('Private storage failure detail');
      return scenario.prepared ? { companyChecks: input.companies, coverage: { checked: input.companies.length }, preparation: { status: 'ready' } } : null;
    },
  });
  const { POST } = await import(new URL('src/app/api/v1/cftc/portfolio-changes/route.js', root).href);
  const companies = Array.from({ length: 100 }, (_, i) => ({ ticker: `C${i}`, cik: String(i + 1).padStart(10, '0') }));
  async function run(value = {}, body = { companies, days: 60 }, signal) {
    scenario = value; calls = [];
    const response = await POST(new Request('https://secedgarterminal.com/api/v1/cftc/portfolio-changes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    }));
    return { response, body: await response.json() };
  }
  let result = await run({ prepared: true });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.coverage.checked, 100);
  assert.deepEqual(calls.map(([name]) => name), ['limit', 'prepared']);
  assert.equal(calls[0][1].max, 12);
  assert.equal(calls[0][1].windowMs, 600_000);
  assert.equal(result.response.headers.get('cache-control'), 'private, max-age=0, no-store');
  for (const value of [{}, { throw: true }]) {
    result = await run(value);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.coverage.checked, 24);
    assert.deepEqual(calls.map(([name]) => name), ['limit', 'prepared', 'live']);
    assert.equal(JSON.stringify(result.body).includes('Private'), false);
  }
  result = await run({}, { companies, unknown: true });
  assert.equal(result.response.status, 400);
  assert.deepEqual(calls.map(([name]) => name), ['limit']);
  result = await run({ allowed: false });
  assert.equal(result.response.status, 429);
  assert.deepEqual(calls.map(([name]) => name), ['limit']);
  result = await run({ enabled: false });
  assert.equal(result.response.status, 503);
  assert.deepEqual(calls, []);
  const abort = new AbortController(); abort.abort(new DOMException('Stopped', 'AbortError'));
  result = await run({}, { companies }, abort.signal);
  assert.equal(result.response.status, 503);
  assert.equal(calls.some(([name]) => name === 'live'), false);
  mock.restoreAll();
}

test('prepared POST serves 100 checks, retains the bounded fallback and rate limit, and respects aborts', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e',
    `await (${fixture.toString()})();`, new URL('../', import.meta.url).href],
  { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
});
