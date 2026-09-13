import test from 'node:test';
import assert from 'node:assert/strict';
import { marketCompanyCacheNamespace } from '../src/utils/marketResearchServer.js';
import { GET as legacyMarketOverview } from '../src/app/api/market-overview/route.js';

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('Market company caches isolate production, preview commits, and local work', () => {
  assert.equal(marketCompanyCacheNamespace('production', 'abcdef'), 'market-research-v3:company:production');
  assert.equal(marketCompanyCacheNamespace('preview', 'abcdef1234567890'), 'market-research-v3:company:preview-abcdef123456');
  assert.equal(marketCompanyCacheNamespace('preview', 'fedcba1234567890'), 'market-research-v3:company:preview-fedcba123456');
  assert.equal(marketCompanyCacheNamespace('preview', ''), 'market-research-v3:company:preview-unknown');
  assert.equal(marketCompanyCacheNamespace('development', 'abcdef'), 'market-research-v3:company:local');
  assert.notEqual(marketCompanyCacheNamespace('production', 'abcdef'), marketCompanyCacheNamespace('preview', 'abcdef'));
});

test('preview company writes use only the commit-scoped namespace', async () => {
  const priorEnvironment = process.env.VERCEL_ENV;
  const priorCommit = process.env.VERCEL_GIT_COMMIT_SHA;
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890';
  try {
    const { readMarketCompanyCache, writeMarketCompanyCache } = await import(`../src/utils/marketResearchServer.js?preview-write=${Date.now()}`);
    const calls = [];
    const company = {
      version: 'market-research-v3', ticker: 'AAPL', name: 'Apple Inc.', cik: '0000320193', sic: '3571',
      observedAt: '2026-09-09T12:00:00.000Z', cohorts: ['technology'],
      metrics: { annual: {}, ttm: {} }, reports: { annual: null, ttm: null },
      evidence: { annual: [], ttm: [] },
    };
    const stored = await writeMarketCompanyCache('AAPL', company, async (...args) => {
      calls.push(args);
      return true;
    });
    assert.equal(stored, true);
    assert.deepEqual(calls, [[
      'market-research-v3:company:preview-abcdef123456',
      'AAPL',
      company,
      7 * 86400,
    ]]);
    assert.ok(calls.every(([namespace]) => namespace !== 'market-research-v3:company:production' && namespace !== 'market-research-v3'));
    const reads = [];
    assert.equal(await readMarketCompanyCache('AAPL', async (namespace, ticker) => {
      reads.push([namespace, ticker]);
      return company;
    }), company);
    assert.deepEqual(reads, [['market-research-v3:company:preview-abcdef123456', 'AAPL']]);
  } finally {
    restoreEnv('VERCEL_ENV', priorEnvironment);
    restoreEnv('VERCEL_GIT_COMMIT_SHA', priorCommit);
  }
});

test('authenticated preview cannot rebuild or write the legacy Market cache', async () => {
  const priorFetch = globalThis.fetch;
  const priorSecret = process.env.CRON_SECRET;
  const priorEnvironment = process.env.VERCEL_ENV;
  let requests = 0;
  process.env.CRON_SECRET = 'test-secret';
  process.env.VERCEL_ENV = 'preview';
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('Preview refresh reached a cache or source request.');
  };
  try {
    const response = await legacyMarketOverview(new Request('https://example.test/api/market-overview?refresh=1', {
      headers: { authorization: 'Bearer test-secret' },
    }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match((await response.json()).error, /only in production/i);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = priorFetch;
    restoreEnv('CRON_SECRET', priorSecret);
    restoreEnv('VERCEL_ENV', priorEnvironment);
  }
});
