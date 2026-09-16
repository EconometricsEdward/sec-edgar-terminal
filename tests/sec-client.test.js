import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRetryableSecStatus,
  isSecUrl,
  parseRetryAfter,
  secFetch,
  SecRequestError,
} from '../src/utils/secClient.js';

test('SEC client accepts only exact HTTPS SEC hosts', () => {
  for (const url of [
    'https://data.sec.gov/submissions/CIK0000320193.json',
    'https://www.sec.gov/Archives/edgar/data/1/index.json',
    'https://efts.sec.gov/LATEST/search-index?q=bank',
  ]) assert.equal(isSecUrl(url), true);

  for (const url of [
    'http://data.sec.gov/example',
    'https://sec.gov.example.com/',
    'https://example.com/?next=https://data.sec.gov',
    'not a url',
  ]) assert.equal(isSecUrl(url), false);
});

test('Retry-After supports seconds and HTTP dates with a bounded cooldown', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter('Wed, 09 Sep 2026 12:00:03 GMT', now), 3000);
  assert.equal(parseRetryAfter('999', now), 300000);
  assert.equal(parseRetryAfter('invalid', now), null);
  assert.equal(isRetryableSecStatus(429), true);
  assert.equal(isRetryableSecStatus(503), true);
  assert.equal(isRetryableSecStatus(404), false);
});

test('SEC client retries a throttle response and supplies the canonical identity', async () => {
  const originalFetch = globalThis.fetch;
  const originalAgent = process.env.SEC_USER_AGENT;
  process.env.SEC_USER_AGENT = 'EDGAR Terminal tests@example.com';
  let calls = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      calls += 1;
      assert.equal(new Headers(options.headers).get('user-agent'), 'EDGAR Terminal tests@example.com');
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json({ ok: true });
    };
    const response = await secFetch('https://data.sec.gov/example.json', {
      retries: 1,
      timeoutMs: 1000,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAgent === undefined) delete process.env.SEC_USER_AGENT;
    else process.env.SEC_USER_AGENT = originalAgent;
  }
});

test('SEC client rejects non-SEC URLs before transport', async () => {
  await assert.rejects(
    secFetch('https://example.com/private'),
    (error) => error instanceof SecRequestError && error.code === 'SEC_URL_INVALID',
  );
});

test('SEC redirects are followed only through revalidated and separately paced hosts', async () => {
  const originalFetch = globalThis.fetch;
  const originalAgent = process.env.SEC_USER_AGENT;
  process.env.SEC_USER_AGENT = 'EDGAR Terminal tests@example.com';
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), redirect: options.redirect });
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { Location: 'https://www.sec.gov/files/company_tickers.json' } })
        : Response.json({ ok: true });
    };
    const response = await secFetch('https://data.sec.gov/example.json', { retries: 0 });
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(calls, [
      { url: 'https://data.sec.gov/example.json', redirect: 'manual' },
      { url: 'https://www.sec.gov/files/company_tickers.json', redirect: 'manual' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAgent === undefined) delete process.env.SEC_USER_AGENT;
    else process.env.SEC_USER_AGENT = originalAgent;
  }
});

test('SEC redirects cannot forward identity headers outside approved hosts', async () => {
  const originalFetch = globalThis.fetch;
  const originalAgent = process.env.SEC_USER_AGENT;
  process.env.SEC_USER_AGENT = 'EDGAR Terminal tests@example.com';
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { Location: 'https://example.com/collect' } });
    };
    await assert.rejects(
      secFetch('https://data.sec.gov/example.json', { retries: 0 }),
      (error) => error instanceof SecRequestError && error.code === 'SEC_REDIRECT_INVALID',
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAgent === undefined) delete process.env.SEC_USER_AGENT;
    else process.env.SEC_USER_AGENT = originalAgent;
  }
});

test('SEC response limits also bound chunked bodies without Content-Length', async () => {
  const originalFetch = globalThis.fetch;
  const originalAgent = process.env.SEC_USER_AGENT;
  process.env.SEC_USER_AGENT = 'EDGAR Terminal tests@example.com';
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    }));
    const response = await secFetch('https://data.sec.gov/example.json', {
      retries: 0,
      maxBytes: 10,
    });
    await assert.rejects(
      response.arrayBuffer(),
      (error) => error instanceof SecRequestError && error.code === 'SEC_RESPONSE_TOO_LARGE',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAgent === undefined) delete process.env.SEC_USER_AGENT;
    else process.env.SEC_USER_AGENT = originalAgent;
  }
});

// Load a deployed client against a mocked local coordination backend. Every
// source dispatch is recorded separately from permission acquisition/release.
async function withSharedClient(acquireReply, run) {
  const originalFetch = globalThis.fetch;
  const fixtureEnv = { NODE_ENV: 'production', VERCEL_ENV: undefined,
    SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: 'sb_secret_fixture',
    EDGAR_DATASTORE_NAMESPACE: 'fixture', SEC_USER_AGENT: 'EDGAR Terminal tests@example.com' };
  const saved = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
  const events = [];
  let acquisitions = 0;
  try {
    for (const [key, value] of Object.entries(fixtureEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    globalThis.fetch = async (url, options) => {
      const target = String(url);
      if (target.startsWith('http://127.0.0.1:54321/rest/v1/rpc/')) {
        const operation = target.split('/').at(-1), params = JSON.parse(options.body);
        events.push({ operation, owner: params.p_owner });
        if (operation === 'edgar_acquire_sec_dispatch') return Response.json(await acquireReply(params.p_owner, ++acquisitions));
        assert.equal(operation, 'edgar_release_sec_dispatch');
        return Response.json(true);
      }
      assert.equal(target, 'https://data.sec.gov/example.json');
      events.push({ operation: 'source', method: options.method });
      return Response.json({ ok: true });
    };
    const client = await import('../src/utils/secClient.js?shared-retry-fixture');
    await run(client.secFetch, events);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
const granted = owner => ({ allowed: true, owner, acquiredAt: '2026-09-16T12:00:00.000Z',
  expiresAt: '2026-09-16T12:00:05.000Z', leaseMs: 5000, waitMs: 0, cooldown: false });
const denied = cooldown => ({ allowed: false, owner: null, acquiredAt: null,
  expiresAt: null, leaseMs: 5000, waitMs: 3000, cooldown });

test('transient coordination retries obtain a new grant before the sole SEC dispatch', async () => {
  for (const method of ['GET', 'HEAD']) {
    await withSharedClient((owner, attempt) => {
      if (attempt === 1) {
        if (method === 'GET') throw new TypeError('Lost coordination reply');
        return denied(false);
      }
      return granted(owner);
    }, async (fetchSec, events) => {
      assert.equal((await fetchSec('https://data.sec.gov/example.json', { method, retries: 1 })).status, 200);
      const acquisitions = events.filter(event => event.operation === 'edgar_acquire_sec_dispatch');
      assert.equal(acquisitions.length, 2);
      assert.notEqual(acquisitions[0].owner, acquisitions[1].owner);
      assert.equal(events.filter(event => event.operation === 'source').length, 1);
      const sourceIndex = events.findIndex(event => event.operation === 'source');
      assert.equal(events[sourceIndex - 1].owner, acquisitions[1].owner);
      assert.equal(events[sourceIndex + 1].operation, 'edgar_release_sec_dispatch');
      assert.equal(events[sourceIndex + 1].owner, acquisitions[1].owner);
    });
  }
});

test('coordination retry exhaustion retains the final gate error without source dispatch', async () => {
  for (const code of ['SEC_RATE_GATE_UNAVAILABLE', 'SEC_RATE_GATE_SATURATED']) {
    await withSharedClient(() => {
      if (code === 'SEC_RATE_GATE_UNAVAILABLE') throw new TypeError('Coordination unavailable');
      return denied(false);
    }, async (fetchSec, events) => {
      await assert.rejects(fetchSec('https://data.sec.gov/example.json', { retries: 1 }), { code, status: 503 });
      assert.equal(events.filter(event => event.operation === 'edgar_acquire_sec_dispatch').length, 2);
      assert.equal(events.filter(event => event.operation === 'source').length, 0);
    });
  }
});

test('provider cooldowns and mutation coordination failures are not retried', async () => {
  for (const method of ['GET', 'POST']) {
    await withSharedClient(() => {
      if (method === 'POST') throw new TypeError('Coordination unavailable');
      return denied(true);
    }, async (fetchSec, events) => {
      await assert.rejects(fetchSec('https://data.sec.gov/example.json', { method, retries: 2 }),
        { code: method === 'GET' ? 'SEC_UPSTREAM_COOLDOWN' : 'SEC_RATE_GATE_UNAVAILABLE' });
      assert.equal(events.filter(event => event.operation === 'edgar_acquire_sec_dispatch').length, 1);
      assert.equal(events.filter(event => event.operation === 'source').length, 0);
    });
  }
});

test('coordination backoff respects caller cancellation before another acquisition', async () => {
  const controller = new AbortController();
  await withSharedClient(() => {
    setTimeout(() => controller.abort(), 20);
    return denied(false);
  }, async (fetchSec, events) => {
    await assert.rejects(fetchSec('https://data.sec.gov/example.json', { retries: 2, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(events.filter(event => event.operation === 'edgar_acquire_sec_dispatch').length, 1);
    assert.equal(events.filter(event => event.operation === 'source').length, 0);
  });
});

test('typed validation and source-size failures do not use coordination retries', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const code of ['SEC_URL_INVALID', 'SEC_REDIRECT_INVALID', 'SEC_RESPONSE_TOO_LARGE', 'SEC_USER_AGENT_INVALID']) {
      let calls = 0;
      const error = new SecRequestError('Fixture terminal failure', { code });
      globalThis.fetch = async () => { calls++; throw error; };
      await assert.rejects(secFetch('https://data.sec.gov/example.json', { retries: 2 }), actual => actual === error);
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});
