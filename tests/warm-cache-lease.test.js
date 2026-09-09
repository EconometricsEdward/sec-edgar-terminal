import test from 'node:test';
import assert from 'node:assert/strict';

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('warm-cache leases use atomic SET NX PX command arguments', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.KV_REST_API_URL;
  const originalToken = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_URL = 'https://redis.example.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  let captured;

  try {
    globalThis.fetch = async (url, options) => {
      captured = { url: String(url), options };
      return Response.json({ result: 'OK' });
    };

    const { warmAcquireLease } = await import(`../src/utils/warmCache.js?lease=${Date.now()}`);
    const token = await warmAcquireLease('market-v2', 'atlas-rebuild', 15_500.2);
    const command = JSON.parse(captured.options.body);

    assert.match(token, /^[0-9a-f-]{36}$/i);
    assert.equal(captured.url, 'https://redis.example.test');
    assert.equal(captured.options.method, 'POST');
    assert.deepEqual(command, [
      'SET',
      'warm:lease:market-v2:ATLAS-REBUILD',
      token,
      'NX',
      'PX',
      15_501,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('KV_REST_API_URL', originalUrl);
    restoreEnv('KV_REST_API_TOKEN', originalToken);
  }
});
