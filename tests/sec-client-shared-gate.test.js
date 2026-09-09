import test from 'node:test';
import assert from 'node:assert/strict';

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('deployed SEC requests reserve the shared gate before contacting SEC', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.KV_REST_API_URL;
  const originalToken = process.env.KV_REST_API_TOKEN;
  const originalVercel = process.env.VERCEL_ENV;
  const originalAgent = process.env.SEC_USER_AGENT;
  process.env.KV_REST_API_URL = 'https://redis.example.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'preview';
  process.env.SEC_USER_AGENT = 'EDGAR Terminal tests@example.com';
  const calls = [];

  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/pipeline')) {
        const commands = JSON.parse(options.body);
        assert.equal(commands.length, 1);
        assert.equal(commands[0][0], 'EVAL');
        return Response.json([{
          result: commands[0][1].includes("redis.call('DEL'") ? 1 : [1, 0],
        }]);
      }
      return Response.json({ ok: true });
    };

    const { secFetch } = await import(`../src/utils/secClient.js?shared=${Date.now()}`);
    const response = await secFetch('https://data.sec.gov/example.json', { retries: 0 });

    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'https://redis.example.test/pipeline');
    assert.equal(calls[1].url, 'https://data.sec.gov/example.json');
    assert.equal(calls[2].url, 'https://redis.example.test/pipeline');
    const releaseCommand = JSON.parse(calls[2].options.body)[0];
    assert.match(releaseCommand[1], /candidate > 0 and candidate > current/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('KV_REST_API_URL', originalUrl);
    restoreEnv('KV_REST_API_TOKEN', originalToken);
    restoreEnv('VERCEL_ENV', originalVercel);
    restoreEnv('SEC_USER_AGENT', originalAgent);
  }
});

test('shared start mutex spaces concurrent outbound dispatches', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.KV_REST_API_URL;
  const originalToken = process.env.KV_REST_API_TOKEN;
  const originalVercel = process.env.VERCEL_ENV;
  const originalAgent = process.env.SEC_USER_AGENT;
  process.env.KV_REST_API_URL = 'https://redis.example.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'preview';
  process.env.SEC_USER_AGENT = 'EDGAR Terminal tests@example.com';
  let locked = false;
  const dispatches = [];

  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/pipeline')) {
        const command = JSON.parse(options.body)[0];
        if (command[1].includes("redis.call('DEL'")) {
          locked = false;
          return Response.json([{ result: 1 }]);
        }
        if (locked) return Response.json([{ result: [0, 10] }]);
        locked = true;
        return Response.json([{ result: [1, 0] }]);
      }
      dispatches.push(Date.now());
      return Response.json({ ok: true });
    };

    const { secFetch } = await import(`../src/utils/secClient.js?spacing=${Date.now()}`);
    await Promise.all([
      secFetch('https://data.sec.gov/one.json', { retries: 0 }),
      secFetch('https://data.sec.gov/two.json', { retries: 0 }),
    ]);

    assert.equal(dispatches.length, 2);
    assert.ok(dispatches[1] - dispatches[0] >= 135, `dispatch gap was ${dispatches[1] - dispatches[0]} ms`);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('KV_REST_API_URL', originalUrl);
    restoreEnv('KV_REST_API_TOKEN', originalToken);
    restoreEnv('VERCEL_ENV', originalVercel);
    restoreEnv('SEC_USER_AGENT', originalAgent);
  }
});

test('an early SEC throttle atomically blocks the next dispatch', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.KV_REST_API_URL;
  const originalToken = process.env.KV_REST_API_TOKEN;
  const originalVercel = process.env.VERCEL_ENV;
  const originalAgent = process.env.SEC_USER_AGENT;
  process.env.KV_REST_API_URL = 'https://redis.example.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'production';
  process.env.SEC_USER_AGENT = 'EDGAR Terminal tests@example.com';
  let locked = false;
  let cooldownUntil = 0;
  let secCalls = 0;

  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/pipeline')) {
        const command = JSON.parse(options.body)[0];
        const script = command[1];
        if (script.includes("redis.call('DEL'")) {
          const cooldownMs = Number(command[6]);
          if (cooldownMs > 0) cooldownUntil = Date.now() + cooldownMs;
          locked = false;
          return Response.json([{ result: 1 }]);
        }
        if (script.includes("redis.call('SET', KEYS[1], ARGV[1], 'NX'")) {
          const remaining = cooldownUntil - Date.now();
          if (remaining > 0) return Response.json([{ result: [-1, remaining] }]);
          if (locked) return Response.json([{ result: [0, 10] }]);
          locked = true;
          return Response.json([{ result: [1, 0] }]);
        }
        return Response.json([{ result: 1 }]);
      }
      secCalls += 1;
      return new Response('slow down', { status: 429, headers: { 'Retry-After': '5' } });
    };

    const { secFetch, SecRequestError } = await import(`../src/utils/secClient.js?cooldown=${Date.now()}`);
    const throttled = await secFetch('https://data.sec.gov/one.json', { retries: 0 });
    assert.equal(throttled.status, 429);
    await assert.rejects(
      secFetch('https://data.sec.gov/two.json', { retries: 0 }),
      (error) => error instanceof SecRequestError && error.code === 'SEC_UPSTREAM_COOLDOWN',
    );
    assert.equal(secCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('KV_REST_API_URL', originalUrl);
    restoreEnv('KV_REST_API_TOKEN', originalToken);
    restoreEnv('VERCEL_ENV', originalVercel);
    restoreEnv('SEC_USER_AGENT', originalAgent);
  }
});

test('deployed SEC requests fail closed when shared coordination fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.KV_REST_API_URL;
  const originalToken = process.env.KV_REST_API_TOKEN;
  const originalVercel = process.env.VERCEL_ENV;
  const originalAgent = process.env.SEC_USER_AGENT;
  process.env.KV_REST_API_URL = 'https://redis.example.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'production';
  process.env.SEC_USER_AGENT = 'EDGAR Terminal tests@example.com';
  let secCalls = 0;

  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('sec.gov')) secCalls += 1;
      return new Response('unavailable', { status: 503 });
    };

    const { secFetch, SecRequestError } = await import(`../src/utils/secClient.js?closed=${Date.now()}`);
    await assert.rejects(
      secFetch('https://data.sec.gov/example.json', { retries: 0 }),
      (error) => error instanceof SecRequestError
        && error.code === 'SEC_RATE_GATE_UNAVAILABLE'
        && error.status === 503,
    );
    assert.equal(secCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('KV_REST_API_URL', originalUrl);
    restoreEnv('KV_REST_API_TOKEN', originalToken);
    restoreEnv('VERCEL_ENV', originalVercel);
    restoreEnv('SEC_USER_AGENT', originalAgent);
  }
});
