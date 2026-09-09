import test from 'node:test';
import assert from 'node:assert/strict';
import { GET, HEAD, OPTIONS } from '../src/app/api/v1/market-signals/route.js';

test('Market signals route rejects missing, unknown, and duplicate inputs without cacheable errors', async () => {
  for (const [url, code] of [
    ['https://secedgarterminal.com/api/v1/market-signals', 'INVALID_TICKER'],
    ['https://secedgarterminal.com/api/v1/market-signals?ticker=NVDA&extra=1', 'UNKNOWN_QUERY_PARAMETER'],
    ['https://secedgarterminal.com/api/v1/market-signals?ticker=NVDA&ticker=JPM', 'DUPLICATE_QUERY_PARAMETER'],
  ]) {
    const response = await GET(new Request(url, { headers: { 'x-forwarded-for': `192.0.2.${code.length}` } }));
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.schema_version, 'edgar.market-signals.v1');
    assert.equal(body.code, code);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.has('ratelimit-limit'), true);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  }
});

test('Market signals route accepts the documented default auto sector proxy', async () => {
  const response = await GET(new Request(
    'https://secedgarterminal.com/api/v1/market-signals?ticker=NVDA&sector_proxy=auto',
    { headers: { 'x-forwarded-for': '192.0.2.44' } },
  ));
  const body = await response.json();
  assert.notEqual(body.code, 'INVALID_SECTOR_PROXY');
  // Unit tests have no warm-cache snapshot, so validation succeeds before the
  // route reaches the expected cache-only availability boundary.
  assert.equal(response.status, 503);
  assert.equal(body.code, 'MARKET_SNAPSHOT_NOT_READY');
});

test('Market signals exposes a cacheable public read-only CORS contract', async () => {
  const response = await OPTIONS();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.match(response.headers.get('access-control-allow-headers'), /If-None-Match/);
  assert.match(response.headers.get('access-control-expose-headers'), /RateLimit-Reset/);
  assert.match(response.headers.get('access-control-expose-headers'), /Link/);
});

test('Market signals returns a versioned 429 envelope and HEAD never returns a body', async () => {
  const request = () => new Request(
    'https://secedgarterminal.com/api/v1/market-signals?ticker=INVALID!',
    { headers: { 'x-forwarded-for': '192.0.2.199' } },
  );
  for (let index = 0; index < 10; index += 1) assert.equal((await GET(request())).status, 400);
  const limited = await GET(request());
  const body = await limited.json();
  assert.equal(limited.status, 429);
  assert.equal(body.schema_version, 'edgar.market-signals.v1');
  assert.equal(body.code, 'RATE_LIMITED');
  assert.equal(body.retryable, true);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  const head = await HEAD(new Request(
    'https://secedgarterminal.com/api/v1/market-signals?ticker=INVALID!',
    { headers: { 'x-forwarded-for': '192.0.2.200' } },
  ));
  assert.equal(head.status, 405);
  assert.equal(head.headers.get('allow'), 'GET, OPTIONS');
  assert.equal(await head.text(), '');
});
