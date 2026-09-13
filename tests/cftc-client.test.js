import test from 'node:test';
import assert from 'node:assert/strict';
import { CFTC_CLIENT_CACHE_MAX, clearPreparedCftc, fetchPreparedCftc } from '../src/utils/cftcClient.js';

test('prepared CFTC browser cache is bounded and evicts least-recent entries', async () => {
  const originalFetch = globalThis.fetch, calls = new Map();
  globalThis.fetch = async path => {
    calls.set(path, (calls.get(path) || 0) + 1);
    return Response.json({ path });
  };
  clearPreparedCftc();
  try {
    for (let index = 0; index <= CFTC_CLIENT_CACHE_MAX; index += 1) await fetchPreparedCftc(`/cftc/${index}`);
    await fetchPreparedCftc('/cftc/0');
    await fetchPreparedCftc(`/cftc/${CFTC_CLIENT_CACHE_MAX}`);
    assert.equal(calls.get('/cftc/0'), 2);
    assert.equal(calls.get(`/cftc/${CFTC_CLIENT_CACHE_MAX}`), 1);
  } finally {
    clearPreparedCftc();
    globalThis.fetch = originalFetch;
  }
});
