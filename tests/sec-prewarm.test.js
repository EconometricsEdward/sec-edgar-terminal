import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEC_PREWARM_SEED_TICKERS,
  normalizeSecPrewarmTickers,
  prewarmSecSubmissions,
  readSecPrewarmTickers,
} from '../src/utils/secPrewarm.js';
import { GET as prewarmCron } from '../src/app/api/cron/prewarm/route.js';
import { GET as fundamentalCron } from '../src/app/api/cron/factor-universe/route.js';

test('SEC prewarm retains bounded operator-selected popular tickers as identifier inputs', async () => {
  assert.deepEqual(
    normalizeSecPrewarmTickers([' aapl ', 'AAPL', 'BRK-B', 'bad/ticker', 7]),
    ['AAPL', 'BRK-B'],
  );
  let key = '', limit = 0;
  const tickers = await readSecPrewarmTickers({
    readOverrides: async (nextKey, nextLimit) => {
      key = nextKey;
      limit = nextLimit;
      return ['ZZZ', 'AAPL', ' msft ', 'bad/ticker'];
    },
  });
  assert.equal(key, 'popular_tickers');
  assert.equal(limit, 25);
  assert.deepEqual(tickers.slice(0, SEC_PREWARM_SEED_TICKERS.length), [
    ...SEC_PREWARM_SEED_TICKERS,
  ]);
  assert.ok(tickers.includes('ZZZ'));
  assert.equal(tickers.filter((ticker) => ticker === 'AAPL').length, 1);
});

test('SEC prewarm fetches and stores only validated SEC submissions', async () => {
  const fetched = [], stored = [];
  const result = await prewarmSecSubmissions({
    tickers: ['AAPL', 'JPM', 'UNKNOWN'],
    resolveTickers: async () => ({
      AAPL: { cik: '320193' },
      JPM: { cik: '19617' },
    }),
    fetchSec: async (url, options) => {
      fetched.push({ url, options });
      const cik = url.match(/CIK(\d{10})\.json$/)?.[1];
      return {
        ok: true,
        json: async () =>
          cik === '0000320193'
            ? { cik: '320193', filings: { recent: { form: [] } } }
            : { cik: 'not-jpm', filings: { recent: { form: [] } } },
      };
    },
    store: async (...args) => {
      stored.push(args);
      return true;
    },
  });
  assert.deepEqual(
    fetched.map(({ url }) => url).sort(),
    [
      'https://data.sec.gov/submissions/CIK0000019617.json',
      'https://data.sec.gov/submissions/CIK0000320193.json',
    ],
  );
  assert.ok(
    fetched.every(
      ({ url, options }) =>
        new URL(url).hostname === 'data.sec.gov' &&
        options.cache === 'no-store' &&
        options.retries === 0,
    ),
  );
  assert.deepEqual(stored.map(([type, id]) => [type, id]), [
    ['submissions-cik', '0000320193'],
  ]);
  assert.deepEqual(
    {
      requested: result.requested,
      succeeded: result.succeeded,
      failed: result.failed,
      unresolved: result.unresolved,
      skipped: result.skipped,
    },
    { requested: 3, succeeded: 1, failed: 1, unresolved: 1, skipped: 0 },
  );
});

test('authorized preview deployments cannot mutate SEC prewarm caches', async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousEnvironment = process.env.VERCEL_ENV;
  process.env.CRON_SECRET = 'test-secret';
  process.env.VERCEL_ENV = 'preview';
  try {
    const response = await prewarmCron(
      new Request('https://example.test/api/cron/prewarm', {
        headers: { authorization: 'Bearer test-secret' },
      }),
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const fundamentalResponse = await fundamentalCron(
      new Request('https://example.test/api/cron/factor-universe', {
        headers: { authorization: 'Bearer test-secret' },
      }),
    );
    assert.equal(fundamentalResponse.status, 403);
    assert.equal(
      fundamentalResponse.headers.get('cache-control'),
      'private, no-store',
    );
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousEnvironment;
  }
});
