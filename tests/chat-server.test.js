import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoopAgent, isStepCount, jsonSchema, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createChatAgent, handleChatPost, verifyChatModelPrice, CHAT_MODEL, CHAT_RESERVED_MICRODOLLARS } from '../src/utils/chatServer.js';

const request = () => new Request('https://secedgarterminal.com/api/chat', { method: 'POST', headers: { origin: 'https://secedgarterminal.com', 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Explain this page.' }], context: { path: '/market', query: '' } }) });
const chunks = values => new ReadableStream({ start(controller) { values.forEach(value => controller.enqueue(value)); controller.close(); } });
function fake(overrides = {}) {
  const state = { reservations: 0, releases: 0, agents: 0, signal: null };
  return { state, dependencies: {
    reserve: async (_request, options) => { state.reservations++; assert.equal(options.reservedMicrodollars, CHAT_RESERVED_MICRODOLLARS);
      return { allowed: true, release: async () => { state.releases++; } }; },
    verifyPrice: async () => {},
    research: ({ signal }) => { state.signal = signal; return { tools: {}, getSources: () => [] }; },
    agent: () => { state.agents++; return { stream: async () => ({ fullStream: chunks([{ type: 'reasoning-delta', text: 'private reasoning' }, { type: 'text-delta', text: 'SEC fundamentals.' }, { type: 'finish', finishReason: 'stop' }]) }) }; },
    ...overrides,
  } };
}

function heldRelease() {
  let finish, began;
  const state = { calls: 0 };
  const pending = new Promise(resolve => { finish = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  return { state, started, finish, reserve: async () => ({ allowed: true,
    release: () => { state.calls++; began(); return pending; },
  }) };
}

test('streams only public text, sources and validated current page; releases usage lease', async () => {
  const { state, dependencies } = fake();
  const response = await handleChatPost(request(), dependencies);
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  assert.match(response.headers.get('cache-control'), /no-store/);
  const frames = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(frames[0], { type: 'meta', page: { path: '/market', label: 'Market' } });
  assert.ok(frames.some(frame => frame.text === 'SEC fundamentals.'));
  assert.equal(JSON.stringify(frames).includes('private reasoning'), false);
  assert.equal(frames.at(-1).type, 'done');
  assert.equal(state.reservations, 1); assert.equal(state.releases, 1);
  assert.ok(state.signal.aborted);
});

test('neither done nor error terminal frames or EOF reach the browser before lease cleanup completes', async () => {
  for (const terminal of ['done', 'error']) {
    const held = heldRelease();
    const { dependencies } = fake({ reserve: held.reserve,
      agent: () => ({ stream: async () => ({ fullStream: chunks([
        { type: 'text-delta', text: 'Answer text.' },
        terminal === 'done' ? { type: 'finish', finishReason: 'stop' } : { type: 'error', error: new Error('provider failure') },
      ]) }) }),
    });
    const response = await handleChatPost(request(), dependencies);
    const reader = response.body.getReader(), decoder = new TextDecoder(), frames = [];
    let ended = false;
    const consume = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) { ended = true; break; }
        frames.push(JSON.parse(decoder.decode(value).trim()));
      }
    })();
    await held.started;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ended, false);
    assert.ok(frames.some(frame => frame.type === 'text'));
    assert.ok(!frames.some(frame => ['done', 'error'].includes(frame.type)));
    held.finish();
    await consume;
    assert.equal(frames.at(-1).type, terminal);
    assert.equal(ended, true);
    assert.equal(held.state.calls, 1);
  }
});

test('platform response-finished cleanup and browser cancellation await one shared release', async () => {
  const held = heldRelease();
  let afterCallback, stopped = false;
  const { dependencies } = fake({ reserve: held.reserve, after: callback => { afterCallback = callback; },
    agent: () => ({ stream: async ({ abortSignal }) => ({ fullStream: (async function* () {
      await new Promise(resolve => abortSignal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
      yield { type: 'abort' };
    })() }) }),
  });
  const response = await handleChatPost(request(), dependencies);
  const reader = response.body.getReader();
  await reader.read();
  const cancellation = reader.cancel();
  await held.started;
  assert.ok(stopped);
  assert.equal(typeof afterCallback, 'function');
  let platformFinished = false;
  const platformCleanup = afterCallback().then(() => { platformFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(platformFinished, false);
  assert.equal(held.state.calls, 1);
  held.finish();
  await Promise.all([cancellation, platformCleanup]);
  assert.equal(platformFinished, true);
  assert.equal(held.state.calls, 1);
});

test('pre-stream errors finish cleanup before returning an HTTP error or its after callback', async () => {
  const held = heldRelease();
  let afterCallback, replied = false;
  const { dependencies } = fake({ reserve: held.reserve, after: callback => { afterCallback = callback; },
    verifyPrice: async () => { throw new Error('provider unavailable'); },
  });
  const response = handleChatPost(request(), dependencies).then(value => { replied = true; return value; });
  await held.started;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replied, false);
  held.finish();
  assert.equal((await response).status, 503);
  await afterCallback();
  assert.equal(held.state.calls, 1);
});

test('invalid requests and unavailable spend controls never reach a model', async () => {
  const first = fake();
  const invalid = new Request('https://secedgarterminal.com/api/chat', { method: 'POST', body: '{}' });
  assert.equal((await handleChatPost(invalid, first.dependencies)).status, 403);
  assert.equal(first.state.reservations, 0);
  const second = fake({ reserve: async () => ({ allowed: false, code: 'CHAT_LIMITS_UNAVAILABLE', status: 503, retryAfter: 30, release: async () => {} }) });
  const response = await handleChatPost(request(), second.dependencies);
  assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '30'); assert.equal(second.state.agents, 0);
});

test('provider failures preserve partial answer and hide sensitive SDK error bodies', async () => {
  const { state, dependencies } = fake({ agent: () => ({ stream: async () => ({ fullStream: chunks([
    { type: 'text-delta', text: 'Partial.' }, { type: 'error', error: new Error('SECRET_TOKEN full prompt body') },
  ]) }) }) });
  const text = await (await handleChatPost(request(), dependencies)).text();
  assert.match(text, /Partial\./); assert.match(text, /"type":"error"/);
  assert.doesNotMatch(text, /SECRET_TOKEN|full prompt|"type":"done"/); assert.equal(state.releases, 1);
});

test('empty or disconnected model stream is not reported as a completed answer', async () => {
  const { dependencies } = fake({ agent: () => ({ stream: async () => ({ fullStream: chunks([{ type: 'text-delta', text: 'Interrupted' }]) }) }) });
  const text = await (await handleChatPost(request(), dependencies)).text();
  assert.match(text, /CHAT_INCOMPLETE/); assert.doesNotMatch(text, /"type":"done"/);
});

test('model steps remain readable without emitting beyond the answer bound', async () => {
  for (const first of ['Initial thought.', 'A'.repeat(7999)]) {
    const { dependencies } = fake({ agent: () => ({ stream: async () => ({ fullStream: chunks([
      { type: 'start-step' }, { type: 'text-delta', text: first }, { type: 'start-step' },
      { type: 'text-delta', text: 'Verified answer.' }, { type: 'finish', finishReason: 'stop' },
    ]) }) }) });
    const frames = (await (await handleChatPost(request(), dependencies)).text()).trim().split('\n').map(JSON.parse);
    const emitted = frames.filter(frame => frame.type === 'text').map(frame => frame.text).join('');
    if (first.length < 100) { assert.equal(emitted, `${first}\n\nVerified answer.`); assert.equal(frames.at(-1).type, 'done'); }
    else { assert.equal(emitted, first); assert.equal(frames.at(-1).code, 'CHAT_ANSWER_LIMIT'); }
  }
});

test('token exhaustion and filtered finishes never mark a truncated answer complete', async () => {
  for (const finishReason of ['length', 'content-filter', 'tool-calls', 'error']) {
    const { dependencies } = fake({ agent: () => ({ stream: async () => ({ fullStream: chunks([{ type: 'text-delta', text: 'Partial' }, { type: 'finish', finishReason }]) }) }) });
    const text = await (await handleChatPost(request(), dependencies)).text();
    assert.match(text, /"type":"error"/); assert.doesNotMatch(text, /"type":"done"/);
  }
});

test('browser cancellation aborts model and data work and releases its lease', async () => {
  let stopped = false;
  const { state, dependencies } = fake({ agent: () => ({ stream: async ({ abortSignal }) => ({ fullStream: (async function* () {
    await new Promise(resolve => abortSignal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
    yield { type: 'abort' };
  })() }) }) });
  const response = await handleChatPost(request(), dependencies);
  const reader = response.body.getReader(); await reader.read(); await reader.cancel();
  assert.ok(stopped); assert.ok(state.signal.aborted); assert.ok(state.releases >= 1);
});

const endpoint = () => ({ data: { id: CHAT_MODEL, endpoints: [{ provider_name: 'mistral', status: 0, has_zdr: true, has_no_training: true,
  pricing: { prompt: '0.00000015', completion: '0.0000006', request: '0', image: '0', image_output: '0', web_search: '0', internal_reasoning: '0', input_cache_read: '0.000000015', discount: 0 } }] } });
test('price guard accepts audited provider and rejects changed pricing, hidden extras and missing privacy terms', async () => {
  await verifyChatModelPrice({ fresh: true, fetchImpl: async url => { assert.match(url, /mistral\/mistral-small\/endpoints$/); return Response.json(endpoint()); } });
  for (const alter of [p => { p.pricing.prompt = '0.00000016'; }, p => { p.pricing.request = '0.001'; }, p => { p.pricing.tiers = []; }, p => { delete p.pricing.completion; }, p => { p.has_zdr = false; }]) {
    const data = endpoint(); alter(data.data.endpoints[0]);
    await assert.rejects(verifyChatModelPrice({ fresh: true, fetchImpl: async () => Response.json(data) }), { code: 'CHAT_MODEL_UNAVAILABLE' });
  }
});

test('real installed SDK executes a research tool before streaming a cited answer with bounded settings', async () => {
  let lookups = 0;
  const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };
  const model = new MockLanguageModelV4({ doStream: [
    { stream: chunks([{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'lookup1', toolName: 'lookup', input: '{"query":"AAPL"}' }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }]) },
    { stream: chunks([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Verified result [S1].' }, { type: 'text-end', id: 'answer' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]) },
  ] });
  const research = { tools: { lookup: { description: 'Verified research', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    execute: async input => { assert.equal(input.query, 'AAPL'); lookups++; return { result: 42, sourceIds: ['S1'] }; } } } };
  const agent = createChatAgent({ context: { path: '/analysis/AAPL', company: 'AAPL' }, research,
    sdk: { ToolLoopAgent, gateway: () => model, isStepCount, jsonSchema, tool } });
  const result = await agent.stream({ messages: [{ role: 'user', content: 'Summarize this company.' }] });
  const parts = []; for await (const part of result.fullStream) parts.push(part);
  assert.equal(lookups, 1); assert.equal(model.doStreamCalls.length, 2);
  assert.equal(parts.filter(part => part.type === 'text-delta').map(part => part.text).join(''), 'Verified result [S1].');
  assert.equal(model.doStreamCalls[0].maxOutputTokens, 1800);
  assert.deepEqual(model.doStreamCalls[0].providerOptions.gateway.only, ['mistral']);
  assert.ok(JSON.stringify(model.doStreamCalls[1].prompt).includes('42'));
});

test('installed agent forwards the error handler without logging provider prompt bodies', async t => {
  const errorLog = t.mock.method(console, 'error', () => {});
  const model = new MockLanguageModelV4({ doStream: async () => { throw new Error('PRIVATE_PROMPT_BODY'); } });
  const agent = createChatAgent({ context: {}, research: { tools: {} }, sdk: { ToolLoopAgent, gateway: () => model, isStepCount, jsonSchema, tool } });
  const response = await agent.stream({ messages: [{ role: 'user', content: 'A public test question' }] });
  const parts = []; for await (const part of response.fullStream) parts.push(part);
  assert.ok(parts.some(part => part.type === 'error'));
  assert.equal(errorLog.mock.callCount(), 0);
});
