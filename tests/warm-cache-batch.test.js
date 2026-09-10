import test from 'node:test';
import assert from 'node:assert/strict';

test('multi-key cache reads are ordered, bounded and abort on transport failure', async () => {
  const originalFetch = globalThis.fetch;
  const priorUrl = process.env.KV_REST_API_URL, priorToken = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_URL = 'https://cache.example.test'; process.env.KV_REST_API_TOKEN = 'test';
  try {
    const { warmGetMany } = await import(`../src/utils/warmCache.js?batch=${Date.now()}`);
    let active = 0, peak = 0, calls = 0;
    globalThis.fetch = async (_url, options) => {
      active++; peak = Math.max(peak, active); calls++;
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      const [, ...keys] = JSON.parse(options.body); assert.ok(keys.length <= 25);
      return Response.json({ result: keys.map(key => JSON.stringify({ id: Number(key.split(':').at(-1)) })) });
    };
    const ids = Array.from({ length: 151 }, (_, i) => i);
    const values = await warmGetMany('test', ids);
    assert.deepEqual(values.map(v => v.id), ids); assert.ok(peak <= 3); assert.equal(calls, 7);
    calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls++;
      if (calls === 1) return new Response('outage', { status: 503 });
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
    };
    await assert.rejects(warmGetMany('test', ids), /Incomplete cache batch/); assert.ok(calls <= 3);
    calls = 0;
    await assert.rejects(warmGetMany('test', ids, { signal: AbortSignal.abort() }), /deadline/); assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (priorUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = priorUrl;
    if (priorToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = priorToken;
  }
});
