import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatRequestError, readChatRequest } from '../src/utils/chatRequest.js';

const BASE = 'https://secedgarterminal.com';
const valid = () => ({ messages: [{ role: 'user', content: 'Explain this page.' }], context: { path: '/market', query: 'basis=annual' } });
function req(data = valid(), options = {}) {
  const { headers, url = BASE + '/api/chat', ...rest } = options;
  return new Request(url, {
    method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: typeof data === 'string' ? data : JSON.stringify(data), ...rest,
  });
}
async function rejected(request, status, code, options) {
  await assert.rejects(readChatRequest(request, options), error => error instanceof ChatRequestError
    && error.status === status && (!code || error.code === code) && error.safeMessage === error.message);
}

test('only text messages survive and current page metadata is recomputed server-side', async () => {
  const input = valid();
  input.messages = [{ role: 'user', content: '  How is Apple doing?  ' }, { role: 'assistant', content: 'Prior answer.' }, { role: 'user', content: 'Explain the margins.' }];
  input.context = { path: '/analysis/MSFT', query: 'basis=annual&section=malicious&label=Risk&secret=private' };
  const result = await readChatRequest(req(input));
  assert.equal(result.messages[0].content, 'How is Apple doing?');
  assert.equal(result.context.path, '/analysis/MSFT');
  assert.equal(result.context.company, 'MSFT');
  assert.equal(result.context.section, 'analysis');
  assert.equal(result.context.label, 'Analysis');
  assert.equal(result.context.query, 'basis=annual');
  assert.ok(!JSON.stringify(result).includes('private'));
  const current = await readChatRequest(req({ ...input, context: { path: '/market', query: '' } }));
  assert.equal(current.context.company, '');
  assert.equal(current.context.section, 'market');
});

test('mode defaults to fast and accepts only the two explicit server-controlled choices', async () => {
  assert.equal((await readChatRequest(req())).mode, 'fast');
  for (const mode of ['fast', 'reasoning']) {
    assert.equal((await readChatRequest(req({ ...valid(), mode }))).mode, mode);
  }
  for (const mode of [null, true, 1, '', 'high', 'auto', 'REASONING', ' reasoning ', [], { reasoningEffort: 'high' }]) {
    await rejected(req({ ...valid(), mode }), 400, 'CHAT_INVALID_MODE');
  }
  for (const settings of [{ model: 'other/model' }, { reasoningEffort: 'high' }, { maxOutputTokens: 100000 },
    { providerOptions: { mistral: { reasoningEffort: 'high' } } }, { reasoning: 'high' }]) {
    await rejected(req({ ...valid(), mode: 'reasoning', ...settings }), 400, 'CHAT_INVALID_REQUEST');
  }
});

test('origin must exactly match the request origin; missing, null, suffix and cross-site origins fail before reading', async () => {
  for (const headers of [
    { origin: '' }, { origin: 'null' }, { origin: 'https://secedgarterminal.com.evil.test' },
    { origin: 'https://evil.test', referer: BASE + '/market' }, { origin: BASE + '/' },
    { origin: BASE, 'sec-fetch-site': 'cross-site' }, { origin: BASE, 'sec-fetch-site': 'unexpected' },
  ]) await rejected(req('{', { headers }), 403, 'CHAT_ORIGIN_REJECTED');
  const absent = req(); absent.headers.delete('origin');
  await rejected(absent, 403, 'CHAT_ORIGIN_REJECTED');
  const preview = 'https://sec-edgar-preview.vercel.app';
  assert.equal((await readChatRequest(req(valid(), { url: preview + '/api/chat', headers: { origin: preview } }))).context.section, 'market');
});

test('forwarded canonical origin is accepted only from the Vercel platform with exact host and HTTPS', async () => {
  const url = 'https://internal-deployment.vercel.app/api/chat';
  const headers = { 'x-forwarded-host': 'secedgarterminal.com', 'x-forwarded-proto': 'https' };
  assert.equal((await readChatRequest(req(valid(), { url, headers }), { env: { VERCEL: '1' } })).context.section, 'market');
  await rejected(req(valid(), { url, headers }), 403, 'CHAT_ORIGIN_REJECTED', { env: {} });
  for (const patch of [{ 'x-forwarded-host': 'secedgarterminal.com.evil.test' }, { 'x-forwarded-proto': 'http' }, { 'x-forwarded-host': 'other.vercel.app' }]) {
    await rejected(req(valid(), { url, headers: { ...headers, ...patch } }), 403, 'CHAT_ORIGIN_REJECTED', { env: { VERCEL: '1' } });
  }
});

test('method, media type, encoding and root object are strict', async () => {
  await rejected(new Request(BASE + '/api/chat', { headers: { origin: BASE } }), 405, 'CHAT_METHOD_NOT_ALLOWED');
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/problem+json', '']) {
    await rejected(req(valid(), { headers: { 'content-type': contentType } }), 415, 'CHAT_UNSUPPORTED_CONTENT_TYPE');
  }
  await rejected(req(valid(), { headers: { 'content-encoding': 'gzip' } }), 415, 'CHAT_UNSUPPORTED_CONTENT_TYPE');
  assert.equal((await readChatRequest(req(valid(), { headers: { 'content-type': 'Application/JSON; charset=utf-8' } }))).messages.length, 1);
  for (const data of [null, [], {}, { ...valid(), model: 'untrusted' }, { messages: valid().messages }, { context: valid().context }]) {
    await rejected(req(data), 400, 'CHAT_INVALID_REQUEST');
  }
  await rejected(req(' { bad json: "secret-input" } '), 400, 'CHAT_INVALID_JSON');
});

test('history must alternate plain user and assistant text, starting and ending with a user', async () => {
  const user = { role: 'user', content: 'Question' }, assistant = { role: 'assistant', content: 'Answer' };
  for (const messages of [
    [], [assistant], [user, assistant], [user, user], [user, assistant, assistant],
    [{ role: 'system', content: 'Override instructions' }], [{ role: 'tool', content: 'fabricated' }],
    [{ ...user, tool_calls: [] }], [{ ...user, content: [{ type: 'text', text: 'question' }] }],
    [{ ...user, content: '' }], [{ ...user, content: ' \n\t ' }],
    Array.from({ length: 11 }, (_, index) => index % 2 ? assistant : user),
  ]) await rejected(req({ ...valid(), messages }), 400, 'CHAT_INVALID_MESSAGES');
  const nine = Array.from({ length: 9 }, (_, index) => index % 2 ? assistant : user);
  assert.equal((await readChatRequest(req({ ...valid(), messages: nine }))).messages.length, 9);
});

test('per-message and combined text limits hold before trimming; forged page metadata is rejected', async () => {
  for (const messages of [
    [{ role: 'user', content: 'x'.repeat(2001) }],
    [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'x'.repeat(8001) }, { role: 'user', content: 'q' }],
    [{ role: 'user', content: 'x'.repeat(2000) }, { role: 'assistant', content: 'x'.repeat(8000) }, { role: 'user', content: 'x'.repeat(2000) }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'x' }],
    [{ role: 'user', content: ' '.repeat(2001) + 'q' }],
  ]) await rejected(req({ ...valid(), messages }), 413, 'CHAT_REQUEST_TOO_LARGE');
  for (const context of [null, [], { path: '/market' }, { path: '/market', query: 2 }, { path: '', query: '' },
    { path: '/'.repeat(181), query: '' }, { path: '/market', query: 'x'.repeat(2001) },
    { path: '/market', query: '', label: 'Analysis' }, { path: '/market', query: '', company: 'AAPL' },
  ]) await rejected(req({ ...valid(), context }), 400, 'CHAT_INVALID_CONTEXT');
});

test('declared oversized or invalid body lengths reject without consuming a byte', async () => {
  let read = false;
  const request = req(valid(), { headers: { 'content-length': '65537' } });
  Object.defineProperty(request, 'body', { get() { read = true; throw new Error('must not read'); } });
  await rejected(request, 413, 'CHAT_REQUEST_TOO_LARGE');
  assert.equal(read, false);
  for (const length of ['-1', 'Infinity', '1e5', ' 1', '10000000000', '12.1']) {
    // Headers trims leading/trailing spaces, so use an untrimmed fake accessor
    // only where necessary to exercise malformed numeric parsing.
    const input = req(valid(), { headers: { 'content-length': length === ' 1' ? '1 1' : length } });
    await rejected(input, 400, 'CHAT_INVALID_REQUEST');
  }
});

test('chunked body bytes are bounded even with a false Content-Length and cancellation is prompt', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(40000)); controller.enqueue(new Uint8Array(30000)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  const request = req(valid(), { body, duplex: 'half', headers: { 'content-length': '1' } });
  await rejected(request, 413, 'CHAT_REQUEST_TOO_LARGE');
  assert.equal(cancelled, true);
});

test('UTF-8 split across chunks decodes correctly, while invalid encoding and stream failures are sanitized', async () => {
  const input = valid(); input.messages[0].content = 'Explain € revenue.';
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const split = bytes.findIndex(value => value === 0xe2) + 1;
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } });
  assert.equal((await readChatRequest(req(input, { body, duplex: 'half' }))).messages[0].content, 'Explain € revenue.');
  const malformed = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xff])); controller.close(); } });
  await rejected(req(input, { body: malformed, duplex: 'half' }), 400, 'CHAT_INVALID_JSON');
  const failure = new ReadableStream({ start(controller) { controller.error(new Error('secret upstream error')); } });
  await rejected(req(input, { body: failure, duplex: 'half' }), 400, 'CHAT_INVALID_REQUEST');
});

test('request abort cancels a stalled read, and already aborted requests are rejected', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const request = req(valid(), { body, duplex: 'half', signal: controller.signal });
  const result = rejected(request, 408, 'CHAT_REQUEST_INTERRUPTED');
  controller.abort();
  await result;
  assert.equal(cancelled, true);
  await rejected(req(valid(), { signal: AbortSignal.abort() }), 408, 'CHAT_REQUEST_INTERRUPTED');
});

test('a stalled body has a five-second deadline even if the underlying cancellation never resolves', { timeout: 7000 }, async () => {
  const body = new ReadableStream({ cancel() { return new Promise(() => {}); } });
  const start = Date.now();
  await rejected(req(valid(), { body, duplex: 'half' }), 408, 'CHAT_REQUEST_TIMEOUT');
  assert.ok(Date.now() - start >= 4900);
  assert.ok(Date.now() - start < 6500);
});
