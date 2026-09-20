import { ChatRequestError, readChatRequest } from './chatRequest.js';
import { reserveBrowserResearchUsage } from './chatBrowserLimits.js';
import { prepareBrowserResearch } from './chatBrowserResearch.js';

const TIME_BUDGET_MS = 22_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Origin',
};
const CATEGORIES = new Set(['company', 'compare', 'fund', 'market', 'cftc', 'help', 'definition', 'shared']);
const STATUSES = new Set(['ready', 'needs_selection', 'not_found', 'unavailable']);

function jsonError(status, code, message, retryAfter = 0) {
  return Response.json({ error: message, code, ...(retryAfter ? { retryAfter } : {}) }, {
    status, headers: { ...HEADERS, ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) },
  });
}

function limitError(limit) {
  const known = ['CHAT_BROWSER_RATE_LIMITED', 'CHAT_BROWSER_BUSY', 'CHAT_BROWSER_LIMITS_UNAVAILABLE'].includes(limit?.code);
  const code = known ? limit.code : 'CHAT_BROWSER_LIMITS_UNAVAILABLE';
  const retryAfter = Number.isSafeInteger(limit?.retryAfter) && limit.retryAfter >= 1 && limit.retryAfter <= 60 ? limit.retryAfter : 30;
  const message = code === 'CHAT_BROWSER_BUSY' ? 'Another research request is still running. Please wait a moment.'
    : code === 'CHAT_BROWSER_RATE_LIMITED' ? 'Please wait briefly before requesting more data. You can continue when this short limit resets.'
      : 'Research is temporarily unavailable because its usage controls could not be reached. Please try again shortly.';
  return jsonError(code === 'CHAT_BROWSER_LIMITS_UNAVAILABLE' ? 503 : 429, code, message, retryAfter);
}

function publicSource(source) {
  if (!source || typeof source.id !== 'string' || !/^S(?:[1-9]|1[0-9]|2[0-4])$/.test(source.id)
    || typeof source.title !== 'string' || !source.title.trim() || source.title.length > 180
    || typeof source.url !== 'string' || source.url.length > 2000) throw new Error('invalid_browser_research_source');
  const url = new URL(source.url);
  // Match the existing research catalog's exact public citation allowlist. The
  // final response does not carry arbitrary URLs or nested reader properties.
  const allowed = url.hostname === 'secedgarterminal.com' && /^\/(?:analysis|market|fund|disclosures|filings|reports|risk|compare|workspace)(?:\/|$)/.test(url.pathname)
    || ['www.sec.gov', 'sec.gov'].includes(url.hostname) && /^\/(?:Archives\/edgar\/data\/|search-filings|files\/)/.test(url.pathname)
    || url.hostname === 'data.sec.gov' && /^\/(?:submissions\/CIK|api\/xbrl\/companyfacts\/CIK)/.test(url.pathname)
    || ['www.cftc.gov', 'cftc.gov', 'publicreporting.cftc.gov'].includes(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed) throw new Error('invalid_browser_research_source');
  return { id: source.id, title: source.title, url: url.href,
    ...(typeof source.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.asOf) ? { asOf: source.asOf } : {}),
  };
}

function publicResult(result) {
  if (!result || typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 8000
    || typeof result.evidence !== 'string' || result.evidence.length > 8000
    || !Array.isArray(result.sources) || result.sources.length > 24
    || !CATEGORIES.has(result.category) || !STATUSES.has(result.status)
    || !Object.hasOwn(result, 'evidence')) throw new Error('invalid_browser_research_result');
  // Project only the browser contract: internal diagnostics, credentials and raw
  // reader responses must never escape through an accidental extra property.
  const sources = result.sources.map(publicSource);
  if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('duplicate_browser_research_source');
  const output = {
    answer: result.answer, evidence: result.evidence, sources,
    category: result.category, status: result.status,
    ...(Array.isArray(result.suggestions) ? { suggestions: result.suggestions.filter(value => typeof value === 'string').slice(0, 6).map(value => value.slice(0, 250)) } : {}),
  };
  const body = JSON.stringify(output);
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('browser_research_response_too_large');
  return new Response(body, { headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
}

/** This endpoint performs bounded source retrieval only. It never imports an AI
 * SDK, requests inference, stores a transcript or touches paid-chat allowances.
 * Local inference and the deterministic fallback consume the same evidence.
 */
export async function handleBrowserResearchPost(request, dependencies = {}) {
  const deps = { readRequest: readChatRequest, reserve: reserveBrowserResearchUsage, research: prepareBrowserResearch,
    env: process.env, ...dependencies };
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(TIME_BUDGET_MS);
  const signal = AbortSignal.any([request.signal, controller.signal, deadline]);
  let lease, releasePromise, onAbort;
  const stopped = new Promise((_resolve, reject) => {
    onAbort = () => reject(new Error('browser_research_interrupted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const releaseLease = () => releasePromise ||= Promise.resolve().then(() => lease?.release()).catch(() => {});
  try {
    const { messages, context, sharedContext = null } = await Promise.race([deps.readRequest(request, { env: deps.env }), stopped]);
    if (deps.env.CHAT_BROWSER_ENABLED === 'false') {
      return jsonError(503, 'CHAT_BROWSER_DISABLED', 'Browser research is temporarily unavailable. Please try again later.', 60);
    }
    signal.throwIfAborted();
    const reservation = Promise.resolve().then(() => deps.reserve(request, { signal, env: deps.env })).then(result => {
      lease = result;
      if (signal.aborted) {
        // A transport can have accepted a lease just as cancellation wins the
        // race. Try late cleanup as well; its 30-second TTL is the final bound
        // if the platform freezes a disconnected invocation before completion.
        void Promise.resolve().then(() => result?.release()).catch(() => {});
      }
      return result;
    });
    lease = await Promise.race([reservation, stopped]);
    if (!lease?.allowed) return limitError(lease);
    const result = await Promise.race([deps.research({ messages, context, sharedContext, signal }), stopped]);
    signal.throwIfAborted();
    return publicResult(result);
  } catch (error) {
    if (error instanceof ChatRequestError) return jsonError(error.status, error.code, error.safeMessage);
    if (signal.aborted) return jsonError(deadline.aborted ? 504 : 408, 'CHAT_BROWSER_INTERRUPTED',
      deadline.aborted ? 'Research took too long. Try a narrower question or request the data again.' : 'Research was stopped. You can try again.', 5);
    // Raw reader errors can contain request text or upstream credentials. Only
    // fixed copy leaves this boundary, and no conversation content is logged.
    return jsonError(503, 'CHAT_BROWSER_UNAVAILABLE', 'Research could not finish. Please try again shortly.', 15);
  } finally {
    signal.removeEventListener('abort', onAbort);
    controller.abort();
    // Await cleanup before responding; Vercel may freeze work after the response
    // completes. Transport cleanup has its own 2.5-second timeout.
    await releaseLease();
  }
}
