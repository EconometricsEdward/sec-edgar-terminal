import { safeInternalPath } from '../../utils/siteRoutes.js';

export const CHAT_USER_LIMIT = 2000;
export const CHAT_ANSWER_LIMIT = 8000;
export const CHAT_HISTORY_LIMIT = 20;

/** Send only a small, recent conversation; browser display history is separate. */
export function buildChatMessages(messages) {
  const latestIndex = messages.findLastIndex(message => message?.role === 'user' && typeof message.content === 'string' && message.content.trim());
  if (latestIndex < 0) return [];
  const result = [{ role: 'user', content: messages[latestIndex].content.trim().slice(0, CHAT_USER_LIMIT) }];
  let length = result[0].content.length;
  for (let index = latestIndex - 1; index > 0 && result.length + 2 <= 10; index--) {
    const answer = messages[index];
    const question = messages[index - 1];
    if (answer?.role !== 'assistant' || question?.role !== 'user' || typeof answer.content !== 'string' || typeof question.content !== 'string') continue;
    if (['error', 'streaming', 'stopped'].includes(answer.state)) continue;
    const userContent = question.content.trim().slice(0, CHAT_USER_LIMIT);
    const assistantContent = answer.content.trim().slice(0, 8000);
    if (!userContent || !assistantContent) continue;
    if (length + userContent.length + assistantContent.length > 12000) break;
    result.unshift({ role: 'user', content: userContent }, { role: 'assistant', content: assistantContent });
    length += userContent.length + assistantContent.length;
    index--;
  }
  return result;
}

export function safeChatUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f]/.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Model-written links must lead to a known site route or retrieved evidence. */
export function safeChatMessageUrl(value, sources = []) {
  const url = safeChatUrl(value);
  if (!url) return null;
  if (sources.some(source => safeChatUrl(source?.url) === url)) return url;
  if (!url.startsWith('/')) return null;
  const internal = safeInternalPath(url);
  if (internal) return internal;
  const path = url.split(/[?#]/, 1)[0];
  return ['/market/positioning', '/market/factors', '/workspace/demo', '/workspace/portfolio-guide'].includes(path) ? url : null;
}

export function cleanChatSources(sources) {
  if (!Array.isArray(sources)) return [];
  const seen = new Set();
  return sources.slice(0, 24).flatMap(source => {
    const url = safeChatUrl(source?.url);
    if (!url || typeof source?.title !== 'string' || !source.title.trim() || seen.has(url)) return [];
    seen.add(url);
    return [{
      id: String(source.id || seen.size).slice(0, 32),
      title: source.title.slice(0, 180),
      url,
      ...(typeof source.asOf === 'string' ? { asOf: source.asOf.slice(0, 80) } : {}),
    }];
  });
}

export function chatRetrySeconds(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds : (Date.parse(value) - now) / 1000;
  return Number.isFinite(delay) ? Math.max(0, Math.ceil(delay)) : 0;
}

/** NDJSON may split either UTF-8 characters or records across network chunks. */
export async function readChatStream(body, onFrame) {
  if (!body) throw new Error('The response did not contain an answer. Please try again.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  let finished = false;
  const parse = line => {
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch { throw new Error('The answer was interrupted. Please try again.'); }
    if (!frame || !['meta', 'status', 'sources', 'text', 'done', 'error'].includes(frame.type)) {
      throw new Error('The answer was interrupted. Please try again.');
    }
    if (frame.type === 'text' && typeof frame.text !== 'string') throw new Error('The answer was interrupted. Please try again.');
    onFrame(frame);
    if (frame.type === 'done' || frame.type === 'error') finished = true;
  };
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) parse(buffer);
        break;
      }
      size += value.byteLength;
      if (size > 262144) throw new Error('The answer exceeded its size limit. Try a more focused question.');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 131072) throw new Error('The answer exceeded its size limit. Try a more focused question.');
      let end;
      while (!finished && (end = buffer.indexOf('\n')) !== -1) {
        parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    }
    if (!finished) throw new Error('The connection ended before the answer finished. Please try again.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
