import { normalizeChatContext } from './chatContext.js';

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 5000;
const CANONICAL_ORIGIN = 'https://secedgarterminal.com';

export class ChatRequestError extends Error {
  constructor(status, code, safeMessage) {
    super(safeMessage);
    this.name = 'ChatRequestError';
    this.status = status;
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

function fail(status, code, message) {
  throw new ChatRequestError(status, code, message);
}

function exactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function verifyOrigin(request, env) {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (!origin || origin === 'null' || (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite))) {
    fail(403, 'CHAT_ORIGIN_REJECTED', 'Open chat from EDGAR Terminal to send a message.');
  }
  let ownOrigin;
  try { ownOrigin = new URL(request.url).origin; } catch {
    fail(403, 'CHAT_ORIGIN_REJECTED', 'Open chat from EDGAR Terminal to send a message.');
  }
  // A custom-domain request may have an internal Vercel deployment URL. Only
  // the trusted platform may establish that forwarded canonical origin. Never
  // accept an arbitrary forwarded host, Referer, or a domain suffix match.
  const canonicalForward = env.VERCEL === '1'
    && request.headers.get('x-forwarded-host') === 'secedgarterminal.com'
    && request.headers.get('x-forwarded-proto') === 'https';
  if (origin !== ownOrigin && !(origin === CANONICAL_ORIGIN && canonicalForward)) {
    fail(403, 'CHAT_ORIGIN_REJECTED', 'Open chat from EDGAR Terminal to send a message.');
  }
}

async function readBoundedJson(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^[0-9]{1,10}$/.test(declared)) fail(400, 'CHAT_INVALID_REQUEST', 'The chat request is invalid. Please try again.');
    if (Number(declared) > MAX_BODY_BYTES) fail(413, 'CHAT_REQUEST_TOO_LARGE', 'This conversation is too long. Start a new chat or shorten your question.');
  }
  if (request.signal?.aborted) fail(408, 'CHAT_REQUEST_INTERRUPTED', 'The chat request was interrupted. Please try again.');
  if (!request.body) fail(400, 'CHAT_INVALID_REQUEST', 'The chat request is empty. Please enter a question.');

  let reader;
  try { reader = request.body.getReader(); } catch {
    fail(400, 'CHAT_INVALID_REQUEST', 'The chat request could not be read. Please try again.');
  }
  let timer;
  let onAbort;
  const stopped = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new ChatRequestError(408, 'CHAT_REQUEST_TIMEOUT', 'The chat request took too long to upload. Please try again.')), BODY_TIMEOUT_MS);
    onAbort = () => reject(new ChatRequestError(408, 'CHAT_REQUEST_INTERRUPTED', 'The chat request was interrupted. Please try again.'));
    request.signal?.addEventListener('abort', onAbort, { once: true });
  });
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let total = 0;
  let reads = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      if (!(value instanceof Uint8Array)) fail(400, 'CHAT_INVALID_REQUEST', 'The chat request is invalid. Please try again.');
      reads++;
      // Bound empty/tiny chunks as well as bytes. This prevents an in-process
      // source from creating an endless stream of immediately resolved reads.
      if (reads > MAX_BODY_BYTES) fail(413, 'CHAT_REQUEST_TOO_LARGE', 'This conversation is too long. Start a new chat or shorten your question.');
      const offset = total;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) fail(413, 'CHAT_REQUEST_TOO_LARGE', 'This conversation is too long. Start a new chat or shorten your question.');
      bytes.set(value, offset);
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)));
    } catch {
      fail(400, 'CHAT_INVALID_JSON', 'The chat request could not be read. Please try again.');
    }
  } catch (error) {
    if (error instanceof ChatRequestError) throw error;
    fail(400, 'CHAT_INVALID_REQUEST', 'The chat request could not be read. Please try again.');
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
    // Do not await cancellation: a stalled underlying source must not extend
    // the upload deadline. Cancelling also resolves the pending read on abort.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Strict browser request boundary; returns only text history and server-derived
 * page metadata. Content is transient and must not be logged or persisted. */
export async function readChatRequest(request, { env = process.env } = {}) {
  if (request.method !== 'POST') fail(405, 'CHAT_METHOD_NOT_ALLOWED', 'Send chat messages using POST.');
  verifyOrigin(request, env);
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') fail(415, 'CHAT_UNSUPPORTED_CONTENT_TYPE', 'Chat messages must use JSON.');
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') fail(415, 'CHAT_UNSUPPORTED_CONTENT_TYPE', 'Compressed chat requests are not supported.');
  const input = await readBoundedJson(request);
  if (!exactKeys(input, ['messages', 'context'])) fail(400, 'CHAT_INVALID_REQUEST', 'The chat request is invalid. Please try again.');

  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 10) {
    fail(400, 'CHAT_INVALID_MESSAGES', 'Send a question with a short recent conversation.');
  }
  let total = 0;
  const messages = input.messages.map((message, index) => {
    const expectedRole = index % 2 === 0 ? 'user' : 'assistant';
    if (!exactKeys(message, ['role', 'content']) || message.role !== expectedRole || typeof message.content !== 'string') {
      fail(400, 'CHAT_INVALID_MESSAGES', 'Chat history must alternate questions and answers. Start a new chat if needed.');
    }
    const limit = message.role === 'user' ? 2000 : 8000;
    total += message.content.length;
    if (message.content.length > limit || total > 12000) {
      fail(413, 'CHAT_REQUEST_TOO_LARGE', 'This conversation is too long. Start a new chat or shorten your question.');
    }
    const content = message.content.trim();
    if (!content) fail(400, 'CHAT_INVALID_MESSAGES', 'Please enter a nonempty question.');
    return { role: message.role, content };
  });
  if (messages.at(-1).role !== 'user') fail(400, 'CHAT_INVALID_MESSAGES', 'The conversation must end with your question.');

  if (!exactKeys(input.context, ['path', 'query']) || typeof input.context.path !== 'string'
    || input.context.path.length < 1 || input.context.path.length > 180
    || typeof input.context.query !== 'string' || input.context.query.length > 2000) {
    fail(400, 'CHAT_INVALID_CONTEXT', 'The current page could not be identified. Reopen chat and try again.');
  }
  return { messages, context: normalizeChatContext(input.context) };
}
