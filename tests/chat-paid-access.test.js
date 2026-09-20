import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChatPost } from '../src/utils/chatServer.js';

function request(question = 'Explain this page.') {
  return new Request('https://secedgarterminal.com/api/chat', { method: 'POST', headers: {
    origin: 'https://secedgarterminal.com', 'content-type': 'application/json',
  }, body: JSON.stringify({ messages: [{ role: 'user', content: question }], context: { path: '/market', query: '' } }) });
}
function fixture(parts, overrides = {}) {
  const finalized = [];
  let after;
  return { finalized, getAfter: () => after, deps: {
    reserve: async () => ({ allowed: true, finalize: async success => { finalized.push(success); return { ok: true, committed: success }; } }),
    verifyPrice: async () => {},
    after: callback => { after = callback; },
    research: () => ({ tools: {}, getSources: () => [] }),
    agent: () => ({ stream: async () => ({ fullStream: (async function* () { yield* parts; })() }) }),
    ...overrides,
  } };
}

test('production hosted entry rejects anonymous requests before price lookup or model access', async () => {
  let invoked = false;
  const response = await handleChatPost(request(), { verifyPrice: async () => { invoked = true; }, agent: () => { invoked = true; } });
  assert.ok([401, 503].includes(response.status));
  assert.equal(invoked, false);
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('completed paid answer debits once, including after-response cleanup', async () => {
  const f = fixture([{ type: 'text-delta', text: 'Public filings support research.' }, { type: 'finish', finishReason: 'stop' }]);
  const body = await (await handleChatPost(request(), f.deps)).text();
  assert.match(body, /"type":"done"/);
  await f.getAfter()();
  assert.deepEqual(f.finalized, [true]);
});

test('failed, empty and truncated answers restore the held response credit', async () => {
  for (const parts of [
    [{ type: 'error', error: new Error('provider private detail') }],
    [{ type: 'finish', finishReason: 'stop' }],
    [{ type: 'text-delta', text: 'Partial' }, { type: 'finish', finishReason: 'length' }],
  ]) {
    const f = fixture(parts);
    const body = await (await handleChatPost(request(), f.deps)).text();
    assert.match(body, /"type":"error"/);
    assert.doesNotMatch(body, /provider private detail/);
    assert.deepEqual(f.finalized, [false]);
  }
});

test('source-unavailable limitation restores credit even when rendered as a completed message', async () => {
  const error = Object.assign(new Error('No evidence'), { code: 'CHAT_EVIDENCE_MISSING' });
  const f = fixture([{ type: 'error', error }]);
  const body = await (await handleChatPost(request('What was Apple revenue?'), f.deps)).text();
  assert.match(body, /"type":"done"/);
  assert.deepEqual(f.finalized, [false]);
});

test('failed durable debit cannot be represented as completed paid response', async () => {
  const f = fixture([{ type: 'text-delta', text: 'Answer.' }, { type: 'finish', finishReason: 'stop' }], {
    reserve: async () => ({ allowed: true, finalize: async () => { throw new Error('database secret'); } }),
  });
  const body = await (await handleChatPost(request(), f.deps)).text();
  assert.match(body, /BILLING_FINALIZE_UNAVAILABLE/);
  assert.doesNotMatch(body, /"type":"done"|database secret/);
});

test('model price check failure restores the paid credit before inference', async () => {
  const f = fixture([], { verifyPrice: async () => { throw new Error('unavailable'); } });
  assert.equal((await handleChatPost(request(), f.deps)).status, 503);
  assert.deepEqual(f.finalized, [false]);
});

test('browser cancellation restores the credit and aborts provider work', async () => {
  let stopped = false;
  const f = fixture([], { agent: () => ({ stream: async ({ abortSignal }) => ({ fullStream: (async function* () {
    await new Promise(resolve => abortSignal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
    yield { type: 'abort' };
  })() }) }) });
  const response = await handleChatPost(request(), f.deps);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await f.getAfter()();
  assert.equal(stopped, true);
  assert.deepEqual(f.finalized, [false]);
});
