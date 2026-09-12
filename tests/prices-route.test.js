import test from 'node:test';
import assert from 'node:assert/strict';
import { GET, OPTIONS } from '../src/app/api/prices/route.js';

test('the retired price route is an unconditional non-cacheable 410 with no replacement feed', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('retired route contacted a network'); };
  try {
    for (const url of ['https://example.test/api/prices', 'https://example.test/api/prices?ticker=AAPL', 'https://example.test/api/prices?anything=1']) {
      const response = await GET(new Request(url));
      const body = await response.json();
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(body.schema_version, 'edgar.api-retirement.v1');
      assert.equal(body.retired, true);
      assert.equal(body.replacement, null);
      assert.equal(body.documentation, '/help#sources');
      assert.match(body.note, /not a replacement price feed/);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('the retired price route keeps a bounded CORS preflight', async () => {
  const response = await OPTIONS();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});
