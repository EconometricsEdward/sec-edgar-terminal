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
