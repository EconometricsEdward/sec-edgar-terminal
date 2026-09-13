import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecResearchJson } from '../src/utils/secResearchData.js';

const cik = '0001234567', path = `/api/xbrl/companyfacts/CIK${cik}.json`;
const dependencies = { readPrepared: async () => null, read: async () => null, write: async () => true, sample: async () => null };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('large outside-500 raw facts retain five-minute freshness and are reusable across research requests', async () => {
  let cached, calls = 0;
  const source = { cik: 1234567, facts: { 'us-gaap': { description: 'x'.repeat(1100000) } } };
  const load = createSecResearchJson({ ...dependencies, read: async () => cached,
    fetchSec: async (_url, options) => { calls++; assert.equal(options.maxBytes, 32 * 1024 * 1024); return Response.json(source); },
    write: async (type, key, payload, ttl) => { assert.equal(type, 'research-sec-v1'); assert.equal(key, path); assert.equal(ttl, 300); cached = payload; } });
  assert.deepEqual(await load(path), source); assert.deepEqual(await load(path), source); assert.equal(calls, 1);
});

test('wrong-CIK cached sources are ignored and wrong-CIK upstream responses cannot be persisted', async () => {
  let writes = 0;
  const load = createSecResearchJson({ ...dependencies, read: async () => ({ cik: 99, facts: {} }),
    fetchSec: async () => Response.json({ cik: 98, facts: {} }), write: async () => { writes++; } });
  await assert.rejects(load(path), /identity/); assert.equal(writes, 0);
  await assert.rejects(load('/api/xbrl/companyfacts/CIK0000000000.json'), /Invalid/);
});

test('coalesced readers share a single fetch and one cancellation does not abort the other', async () => {
  let resolveSource, transportSignal, calls = 0;
  const load = createSecResearchJson({ ...dependencies,
    fetchSec: async (_url, options) => { calls++; transportSignal = options.signal; return new Promise(resolve => { resolveSource = resolve; }); } });
  const canceled = new AbortController();
  const first = load(path, canceled.signal), second = load(path);
  await tick(); canceled.abort(new Error('reader left'));
  await assert.rejects(first, /reader left/); assert.equal(transportSignal.aborted, false);
  resolveSource(Response.json({ cik: 1234567, facts: {} }));
  assert.equal((await second).cik, 1234567); assert.equal(calls, 1);
});

test('all-reader cancellation aborts transport, and unrelated source work has a bounded pending count', async () => {
  let transportSignal;
  const load = createSecResearchJson({ ...dependencies,
    fetchSec: async (_url, options) => { transportSignal = options.signal; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); } });
  const controller = new AbortController(); const request = load(path, controller.signal);
  await tick(); controller.abort(new Error('closed')); await assert.rejects(request, /closed/); await tick();
  assert.equal(transportSignal.aborted, true);
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const requests = controllers.map((item, i) => load(`/api/xbrl/companyfacts/CIK${String(10 + i).padStart(10, '0')}.json`, item.signal));
  await assert.rejects(load('/api/xbrl/companyfacts/CIK0000000099.json'), /busy/);
  controllers.forEach(item => item.abort(new Error('done'))); await Promise.allSettled(requests); await tick();
});

test('a stale prepared source error remains fail-closed instead of fetching an unfenced replacement', async () => {
  const load = createSecResearchJson({ ...dependencies, readPrepared: async (_path, options) => { assert.equal(options.allowStale, false); throw new Error('scheduled revalidation required'); },
    fetchSec: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(load(path), /scheduled revalidation/);
});
