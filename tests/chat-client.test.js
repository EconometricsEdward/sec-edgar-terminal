import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatMessages, safeChatUrl, cleanChatSources, chatRetrySeconds, readChatStream } from '../src/components/chat/chatClient.js';

function stream(parts) {
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } });
}

test('chat request history remains bounded and ends with the latest question', () => {
  const messages = Array.from({ length: 26 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${index}: ${'x'.repeat(1700)}` }));
  messages.push({ role: 'user', content: 'Latest question' });
  const bounded = buildChatMessages(messages);
  assert.ok(bounded.length <= 10);
  assert.ok(bounded.reduce((total, item) => total + item.content.length, 0) <= 12000);
  assert.equal(bounded[0].role, 'user');
  assert.equal(bounded.at(-1).content, 'Latest question');
  assert.equal(buildChatMessages([{ role: 'user', content: 'x'.repeat(3000) }])[0].content.length, 2000);
});

test('failed or still-generating answers do not become model conversation evidence', () => {
  const messages = [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'Unfinished', state: 'error' }, { role: 'user', content: 'B' }, { role: 'assistant', content: 'Partial', state: 'streaming' }, { role: 'user', content: 'C' }];
  assert.deepEqual(buildChatMessages(messages).map(item => item.content), ['C']);
  const recovered = buildChatMessages([{ role: 'user', content: 'Complete question' }, { role: 'assistant', content: 'Complete answer' }, ...messages]);
  assert.deepEqual(recovered.map(item => item.role), ['user', 'assistant', 'user']);
  assert.equal(recovered.at(-1).content, 'C');
});

test('source links reject executable schemes, credentials and protocol-relative escapes', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,x', '//example.com', '/\\example.com', 'https://user:pass@example.com', 'https://example.com/\npath', 'https://example.com/<script> x']) assert.equal(safeChatUrl(value), null);
  assert.equal(safeChatUrl('/analysis?ticker=AAPL'), '/analysis?ticker=AAPL');
  assert.equal(safeChatUrl('https://www.sec.gov/Archives/a'), 'https://www.sec.gov/Archives/a');
  assert.deepEqual(cleanChatSources([{ id: 'S1', title: 'SEC data', url: 'https://www.sec.gov' }, { title: 'Duplicate', url: 'https://www.sec.gov/' }, { title: 'Bad', url: 'javascript:alert(1)' }]), [{ id: 'S1', title: 'SEC data', url: 'https://www.sec.gov/' }]);
});

test('stream parser survives split records and split multibyte text', async () => {
  const bytes = new TextEncoder().encode(' {"type":"status","message":"Reading…"}\n{"type":"text","text":"€ revenue"}\n{"type":"done"}');
  const frames = [];
  await readChatStream(stream([...bytes].map(value => new Uint8Array([value]))), frame => frames.push(frame));
  assert.deepEqual(frames.map(frame => frame.type), ['status', 'text', 'done']);
  assert.equal(frames[1].text, '€ revenue');
});

test('stream parser reports premature disconnects instead of claiming a finished answer', async () => {
  await assert.rejects(readChatStream(stream([new TextEncoder().encode('{"type":"text","text":"Partial"}\n')]), () => {}), /before the answer finished/);
  await assert.rejects(readChatStream(stream([new TextEncoder().encode('not json\n')]), () => {}), /interrupted/);
});

test('stream cancellation releases the reader when the consumer receives an error', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"error","message":"Rate limited"}\n')); }, cancel() { cancelled = true; } });
  await assert.rejects(readChatStream(body, frame => { throw new Error(frame.message); }), /Rate limited/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('retry delays understand both Retry-After forms without automatic retries', () => {
  assert.equal(chatRetrySeconds('25'), 25);
  assert.equal(chatRetrySeconds('Sun, 20 Sep 2026 10:00:30 GMT', Date.parse('2026-09-20T10:00:00Z')), 30);
  assert.equal(chatRetrySeconds('-10'), 0);
  assert.equal(chatRetrySeconds('bad date'), 0);
});
