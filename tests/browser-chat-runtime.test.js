import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserChatRuntime } from '../src/components/chat/browserChatRuntime.ts';
import {
  BROWSER_CHAT_CONTEXT_TOKENS, BROWSER_CHAT_MAX_OUTPUT_TOKENS,
  BROWSER_CHAT_MAX_PROMPT_TOKENS, BROWSER_CHAT_MODEL_URL, BROWSER_CHAT_WASM_URL,
  buildBrowserChatMessages, browserChatVisibleText, isOwnedBrowserChatAsset,
} from '../src/components/chat/browserChatConfig.js';

class FakeWorker {
  onmessage = null;
  onerror = null;
  terminated = false;
  messages = [];
  autoLoad;
  constructor(autoLoad = true) { this.autoLoad = autoLoad; }
  postMessage(message) {
    this.messages.push(message);
    if (message.type === 'load' && this.autoLoad) queueMicrotask(() => this.emit({ id: message.id, type: 'result', result: { ready: true } }));
    if (message.type === 'interrupt') {
      const request = this.messages.findLast(item => item.type === 'generate');
      if (request) queueMicrotask(() => this.emit({ id: request.id, type: 'error', aborted: true }));
    }
  }
  emit(data) { this.onmessage?.({ data }); }
  terminate() { this.terminated = true; }
}

function setup(options = {}) {
  const workers = [];
  const environment = {
    isSecureContext: true,
    Worker: FakeWorker,
    navigator: { gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: { maxStorageBufferBindingSize: 512 * 1024 * 1024 } }) } },
    ...options.environment,
  };
  const runtime = new BrowserChatRuntime({ environment, workerFactory: () => { const worker = new FakeWorker(options.autoLoad !== false); workers.push(worker); return worker; } });
  return { runtime, workers };
}
async function settle() { for (let index = 0; index < 15; index += 1) await Promise.resolve(); }
const input = { question: 'Explain results.', evidence: 'Company A: annual revenue $123 million; year ended 2025-12-31. [S1]', pageLabel: 'Analysis' };

test('compatibility inspection does not create a worker or download a model', async () => {
  const { runtime, workers } = setup();
  try {
    assert.equal(runtime.getSnapshot().state, 'idle');
    await runtime.checkSupport();
    assert.equal(runtime.getSnapshot().supported, true);
    assert.equal(workers.length, 0);
  } finally { runtime.dispose(); }
});

test('unsupported devices remain usable without trying model initialization', async () => {
  const { runtime, workers } = setup({ environment: { navigator: {} } });
  try {
    await runtime.checkSupport();
    assert.equal(runtime.getSnapshot().state, 'unsupported');
    await assert.rejects(runtime.load(), /Data answers/);
    assert.equal(workers.length, 0);
  } finally { runtime.dispose(); }
});

test('closing during download terminates immediately and ignores a late worker result', async () => {
  const { runtime, workers } = setup({ autoLoad: false });
  try {
    const loading = runtime.load();
    const rejection = assert.rejects(loading, { name: 'AbortError' });
    await settle();
    assert.equal(runtime.getSnapshot().state, 'loading');
    runtime.release();
    await rejection;
    assert.equal(workers[0].terminated, true);
    assert.equal(runtime.getSnapshot().state, 'idle');
    workers[0].emit({ id: 1, type: 'result', result: { ready: true } });
    assert.equal(runtime.getSnapshot().state, 'idle');
  } finally { runtime.dispose(); }
});

test('simultaneous Load actions share a single initialization', async () => {
  const { runtime, workers } = setup();
  try {
    await Promise.all([runtime.load(), runtime.load()]);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].messages.filter(message => message.type === 'load').length, 1);
    assert.equal(runtime.getSnapshot().state, 'ready');
  } finally { runtime.dispose(); }
});

test('model loading timeout releases memory and leaves a retryable error state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runtime, workers } = setup({ autoLoad: false });
  try {
    const loading = runtime.load();
    const rejection = assert.rejects(loading, /took too long/);
    await settle();
    t.mock.timers.tick(15 * 60 * 1000);
    await rejection;
    assert.equal(runtime.getSnapshot().state, 'error');
    assert.equal(workers[0].terminated, true);
  } finally { runtime.dispose(); }
});

test('generation times out without leaving the chat stuck generating', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runtime, workers } = setup();
  try {
    await runtime.load();
    const answer = runtime.generate(input, { onChunk() {} });
    const rejection = assert.rejects(answer, /too long/);
    t.mock.timers.tick(120000);
    await rejection;
    assert.equal(runtime.getSnapshot().state, 'error');
    assert.equal(workers[0].terminated, true);
  } finally { runtime.dispose(); }
});

test('stream consumer exceptions reject the request and release the model', async () => {
  const { runtime, workers } = setup();
  try {
    await runtime.load();
    const answer = runtime.generate(input, { onChunk() { throw new Error('Output exceeds the display bound.'); } });
    const rejection = assert.rejects(answer, /display bound/);
    const request = workers[0].messages.at(-1);
    workers[0].emit({ id: request.id, type: 'chunk', text: 'An answer' });
    await rejection;
    assert.equal(runtime.getSnapshot().state, 'error');
    assert.equal(workers[0].terminated, true);
  } finally { runtime.dispose(); }
});

test('closing while generating stops the answer and preserves the short release grace', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runtime, workers } = setup();
  try {
    await runtime.load();
    const answer = runtime.generate(input, { onChunk() {} });
    const rejection = assert.rejects(answer, { name: 'AbortError' });
    runtime.release({ delayMs: 30000 });
    await rejection;
    assert.equal(runtime.getSnapshot().state, 'ready');
    t.mock.timers.tick(30000);
    assert.equal(workers[0].terminated, true);
    assert.equal(runtime.getSnapshot().state, 'idle');
  } finally { runtime.dispose(); }
});

test('reopening before the close grace retains the model and resets its idle timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runtime, workers } = setup();
  try {
    await runtime.load();
    runtime.release({ delayMs: 30000 });
    t.mock.timers.tick(10000);
    runtime.retain();
    t.mock.timers.tick(20000);
    assert.equal(workers[0].terminated, false);
    t.mock.timers.tick(5 * 60 * 1000);
    assert.equal(workers[0].terminated, true);
  } finally { runtime.dispose(); }
});

test('cache removal deletes only this pinned model and preserves unrelated site data', async () => {
  const owned = `${BROWSER_CHAT_MODEL_URL}params_shard_0.bin`;
  const foreign = 'https://huggingface.co/other/model/resolve/main/params.bin';
  const deleted = [];
  const caches = {
    keys: async () => ['webllm/model', 'webllm/wasm', 'portfolio'],
    open: async name => ({
      keys: async () => (name === 'webllm/model' ? [owned, foreign] : name === 'webllm/wasm' ? [BROWSER_CHAT_WASM_URL] : ['https://secedgarterminal.com/saved']).map(url => ({ url })),
      delete: async request => { deleted.push(request.url); return true; },
    }),
  };
  const { runtime } = setup({ environment: { caches } });
  try {
    await runtime.clearCache();
    assert.deepEqual(deleted, [owned, BROWSER_CHAT_WASM_URL]);
    assert.equal(runtime.getSnapshot().cached, false);
  } finally { runtime.dispose(); }
});

test('failed cache deletion does not leave a false ready state', async () => {
  const { runtime } = setup({ environment: { caches: { keys: async () => { throw new Error('Storage blocked'); } } } });
  try {
    await runtime.load();
    await assert.rejects(runtime.clearCache(), /could not remove/);
    assert.equal(runtime.getSnapshot().state, 'error');
  } finally { runtime.dispose(); }
});

test('bounded prompt keeps complete evidence, never promotes prior assistant claims, and leaves room for the answer', () => {
  const packet = buildBrowserChatMessages({ ...input, history: [{ role: 'user', content: 'What company is this?' }, { role: 'assistant', content: 'Its revenue is an invented $999 billion.' }] });
  const prompt = packet.messages.map(message => message.content).join('\n');
  assert.ok(prompt.includes(input.evidence));
  assert.ok(prompt.includes('What company is this?'));
  assert.ok(!prompt.includes('$999 billion'));
  assert.ok(packet.promptTokenUpperBound <= BROWSER_CHAT_MAX_PROMPT_TOKENS);
  assert.ok(packet.promptTokenUpperBound + BROWSER_CHAT_MAX_OUTPUT_TOKENS < BROWSER_CHAT_CONTEXT_TOKENS);
  assert.throws(() => buildBrowserChatMessages({ ...input, evidence: '完整财务证据'.repeat(1000) }), /complete evidence exceeds/);
});

test('owned URLs require the exact immutable revision and thinking prefixes never stream', () => {
  assert.equal(isOwnedBrowserChatAsset(`${BROWSER_CHAT_MODEL_URL}tokenizer.json`), true);
  assert.equal(isOwnedBrowserChatAsset(BROWSER_CHAT_MODEL_URL.replace('/resolve/', '/resolve/main/')), false);
  assert.equal(browserChatVisibleText('<thi'), '');
  assert.equal(browserChatVisibleText('<think>private steps'), '');
  assert.equal(browserChatVisibleText('<think>private steps</think>\nRevenue increased.'), 'Revenue increased.');
});
