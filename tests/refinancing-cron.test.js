import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRefinancingCron } from '../src/utils/refinancing/cron.js';

const secret = 'test-only-cron-secret';
const env = { CRON_SECRET: secret, VERCEL_ENV: 'production' };
const request = (token = secret, query = '') => new Request(`https://example.test/api/cron/refinancing${query}`,
  { headers: { authorization: `Bearer ${token}` } });

test('unauthorized, preview and parameterized requests cannot start refinancing source work', async () => {
  let calls = 0;
  const run = async () => { calls++; return {}; };
  for (const [req, settings, status] of [
    [request('wrong'), env, 401], [request(), { VERCEL_ENV: 'production' }, 401],
    [request(), { ...env, VERCEL_ENV: 'preview' }, 403], [request(secret, '?limit=5000'), env, 400],
  ]) {
    const response = await handleRefinancingCron(req, { run, env: settings });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(calls, 0);
});

test('authorized scheduled work receives a fixed bounded budget and fails without exposing internal errors', async () => {
  let options;
  const response = await handleRefinancingCron(request(), { env, now: () => 1000,
    run: async value => { options = value; return { status: 'published', checked: 12 }; } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'published', checked: 12 });
  assert.equal(options.limit, 160);
  assert.equal(options.deadline, 241000);
  assert.equal(options.signal.aborted, false);
  const failed = await handleRefinancingCron(request(), { env, run: async () => { throw new Error('private database detail'); } });
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('retry-after'), '600');
  assert.ok(!(await failed.text()).includes('private database detail'));
});
