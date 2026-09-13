import test from 'node:test';
import assert from 'node:assert/strict';
import { GET, OPTIONS } from '../src/app/api/v1/market-signals/route.js';

test('market-signals v1 is permanently retired without validating, fetching, or caching inputs', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('retired route contacted a network'); };
  try {
    for (const url of ['https://example.test/api/v1/market-signals', 'https://example.test/api/v1/market-signals?ticker=NVDA', 'https://example.test/api/v1/market-signals?unknown=1']) {
      const response = await GET(new Request(url));
      const body = await response.json();
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(body.schema_version, 'edgar.api-retirement.v1');
      assert.equal(body.retired, true);
      assert.equal(body.replacement, null);
      assert.match(body.note, /separate aggregate contract/);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('market-signals v1 retains only a read-only CORS preflight', async () => {
  const response = await OPTIONS();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
});
