/**
 * Shared server-side SEC transport.
 *
 * Every direct request to an SEC host should pass through this module. It
 * enforces one application-wide request-start budget with Supabase in
 * production, retains a conservative per-instance fallback for local work,
 * honors Retry-After, and applies bounded retries/timeouts.
 */

import { takeSecRequestBudget } from './secRequestBudget.js';
import { acquireSecDispatchPermit, releaseSecDispatchPermit, publishSecDispatchCooldown } from './dataStore.js';

const SEC_HOSTS = new Set(['data.sec.gov', 'www.sec.gov', 'efts.sec.gov']);
const DEPLOYED_RUNTIME = Boolean(process.env.VERCEL_ENV || process.env.VERCEL)
  || process.env.NODE_ENV === 'production';
const STARTS_PER_SECOND = 7;
const LOCAL_INTERVAL_MS = Math.ceil(1000 / STARTS_PER_SECOND);
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const MAX_GATE_WAIT_MS = 2_000;
const START_LOCK_TTL_MS = 5_000;
const START_LOCK_POLL_MS = 50;
const START_LOCK_SAFETY_MS = 500;
const MAX_HANDOFF_COOLDOWN_MS = 600000;
const DEFAULT_USER_AGENT = 'EDGAR Terminal research@secedgarterminal.com';
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

let localNextStartAt = 0;
let warnedAboutLocalGate = false;
const cooldownPublished = new WeakSet();

export class SecRequestError extends Error {
  constructor(message, { code = 'SEC_REQUEST_FAILED', status = 502, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SecRequestError';
    this.code = code;
    this.status = status;
  }
}

export function isSecUrl(input) {
  try {
    const url = input instanceof URL ? input : new URL(String(input));
    return (
      url.protocol === 'https:' &&
      SEC_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_COOLDOWN_MS, Math.ceil(seconds * 1000));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(MAX_COOLDOWN_MS, Math.max(0, date - now));
}

export function isRetryableSecStatus(status) {
  return RETRYABLE_STATUS.has(Number(status));
}

export function isValidSecUserAgent(value) {
  const configured = typeof value === 'string' ? value.trim() : '';
  return configured.length >= 10
    && configured.length <= 256
    && (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(configured) || /https:\/\/\S+/i.test(configured));
}

function userAgent() {
  const configured = process.env.SEC_USER_AGENT?.trim();
  if (isValidSecUserAgent(configured)) return configured;
  if (DEPLOYED_RUNTIME) {
    throw new SecRequestError(
      'SEC requests are disabled because SEC_USER_AGENT is missing or has no contact information.',
      { code: 'SEC_USER_AGENT_INVALID', status: 503 },
    );
  }
  return DEFAULT_USER_AGENT;
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The request was aborted.', 'AbortError');
}

async function delay(ms, signal) {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(abortError(signal));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function localPermit(signal) {
  if (!warnedAboutLocalGate) {
    warnedAboutLocalGate = true;
    console.warn('[secClient] shared outbound gate unavailable; using the local development pacer.');
  }
  const now = Date.now();
  const scheduledAt = Math.max(now, localNextStartAt);
  localNextStartAt = scheduledAt + LOCAL_INTERVAL_MS;
  await delay(scheduledAt - now, signal);
}

/** Production coordination has one backend. No Redis/local fallback on failure. */
export function createSecDispatchCoordinator({
  acquire = acquireSecDispatchPermit, release = releaseSecDispatchPermit,
  publish = publishSecDispatchCooldown, now = () => performance.now(),
  uuid = () => crypto.randomUUID(), wait = delay,
  transport = (...args) => fetch(...args),
} = {}) {
  async function safeRelease(permit, cooldownMs = 0) {
    if (!permit?.owner) return false;
    try { return await release(permit.owner, { cooldownMs: Math.max(0, Math.ceil(cooldownMs)) }) === true; }
    catch { return false; } // The fixed server lease remains the release fallback.
  }
  async function releaseUncertainReservation(owner) {
    let timer;
    try {
      // A lost acquisition reply may still have committed a server lease.
      // Cleanup uses only our UUID, independently of the cancelled caller, and
      // never waits for the full five-second lease or grants another permit.
      await Promise.race([safeRelease({ owner }), new Promise(resolve => {
        timer = setTimeout(resolve, MAX_GATE_WAIT_MS);
      })]);
    } finally { clearTimeout(timer); }
  }
  function validateReply(value, owner) {
    return value && typeof value.allowed === 'boolean' && typeof value.cooldown === 'boolean'
      && value.leaseMs === START_LOCK_TTL_MS && Number.isSafeInteger(value.waitMs)
      && value.waitMs >= 0 && value.waitMs <= MAX_HANDOFF_COOLDOWN_MS
      && (value.allowed ? value.owner === owner && !value.cooldown && value.waitMs === 0
        && Number.isFinite(Date.parse(value.acquiredAt)) && Number.isFinite(Date.parse(value.expiresAt)) : value.owner === null);
  }
  async function reserve(signal) {
    signal?.throwIfAborted();
    const owner = uuid(), deadline = now() + MAX_GATE_WAIT_MS;
    let uncertainReservation = false;
    try {
      while (true) {
        const requestStarted = now(), remaining = deadline - requestStarted;
        if (remaining <= 0) throw new SecRequestError('SEC request coordination is temporarily saturated.', { code: 'SEC_RATE_GATE_SATURATED', status: 503 });
        const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        uncertainReservation = true;
        const reply = await acquire(owner, { signal: requestSignal });
        if (!validateReply(reply, owner)) throw new SecRequestError('Shared SEC request coordination returned invalid lease evidence.', { code: 'SEC_RATE_GATE_UNAVAILABLE', status: 503 });
        if (reply.allowed) {
          // Server timestamps are evidence, not the client's clock. Measuring
          // from BEFORE the request conservatively includes all network delay.
          const permit = { owner, validUntil: requestStarted + START_LOCK_TTL_MS - START_LOCK_SAFETY_MS };
          if (now() >= permit.validUntil || requestSignal.aborted) {
            throw new SecRequestError('SEC dispatch permission arrived too late.', { code: 'SEC_RATE_GATE_UNAVAILABLE', status: 503 });
          }
          return permit;
        }
        uncertainReservation = false;
        const waitMs = Math.max(1, reply.waitMs), left = deadline - now();
        if (reply.cooldown || left <= 0 || waitMs > left) throw new SecRequestError('SEC request coordination is temporarily saturated.', {
          code: reply.cooldown ? 'SEC_UPSTREAM_COOLDOWN' : 'SEC_RATE_GATE_SATURATED', status: 503,
        });
        await wait(Math.min(waitMs, START_LOCK_POLL_MS, left), signal);
      }
    } catch (error) {
      if (uncertainReservation) await releaseUncertainReservation(owner);
      if (signal?.aborted) throw abortError(signal);
      if (error instanceof SecRequestError) throw error;
      throw new SecRequestError('Shared SEC request coordination failed.', { code: 'SEC_RATE_GATE_UNAVAILABLE', status: 503 });
    }
  }
  async function publishCooldown(delayMs) {
    if (delayMs <= 0) return false;
    try { return await publish(Math.min(MAX_COOLDOWN_MS, Math.ceil(delayMs))) === true; }
    catch { return false; }
  }
  async function paced(input, init, signal) {
    const permit = await reserve(signal), startedAt = now();
    let request;
    try {
      signal?.throwIfAborted(); init.signal?.throwIfAborted();
      // No asynchronous work is permitted between this check and dispatch.
      if (now() >= permit.validUntil) throw new SecRequestError('SEC dispatch permission expired before use.', { code: 'SEC_RATE_GATE_UNAVAILABLE', status: 503 });
      if (!takeSecRequestBudget()) throw new SecRequestError('The research task reached its SEC request allowance.', { code: 'SEC_REQUEST_BUDGET_EXHAUSTED', status: 429 });
      request = transport(input, init);
    } catch (error) { await safeRelease(permit); throw error; }
    const outcome = Promise.resolve(request).then(response => ({ response }), error => ({ error }));
    // Preserve early provider cooldown publication under the owned lease. The
    // database also adds 143 ms at release: intentionally conservative spacing.
    const hold = wait(Math.max(0, LOCAL_INTERVAL_MS - (now() - startedAt)));
    const early = await Promise.race([outcome.then(settled => ({ settled })), hold.then(() => null)]);
    const earlyResponse = early?.settled?.response;
    const earlyCooldown = cooldownForResponse(earlyResponse) || 0;
    await hold;
    if (await safeRelease(permit, earlyCooldown) && earlyResponse && earlyCooldown > 0) cooldownPublished.add(earlyResponse);
    const settled = await outcome;
    if (settled.error) throw settled.error;
    return settled.response;
  }
  return Object.freeze({ fetch: paced, publishCooldown });
}

const dispatchCoordinator = createSecDispatchCoordinator();
async function publishCooldown(delayMs) {
  return DEPLOYED_RUNTIME ? dispatchCoordinator.publishCooldown(delayMs) : false;
}

function cooldownForResponse(response) {
  const retryAfter = parseRetryAfter(response?.headers?.get('retry-after'));
  if (
    response?.status !== 403
    && response?.status !== 429
    && !(isRetryableSecStatus(response?.status) && retryAfter != null)
  ) return null;
  return retryAfter ?? (response.status === 403 ? 30_000 : 1_000);
}

async function publishResponseCooldown(response) {
  if (!response || cooldownPublished.has(response)) return;
  const cooldown = cooldownForResponse(response);
  if (cooldown != null && await publishCooldown(cooldown)) {
    cooldownPublished.add(response);
  }
}

async function pacedFetch(input, init, signal) {
  if (DEPLOYED_RUNTIME) return dispatchCoordinator.fetch(input, init, signal);
  await localPermit(signal);
  signal?.throwIfAborted();
  if (!takeSecRequestBudget()) throw new SecRequestError('The research task reached its SEC request allowance.', { code: 'SEC_REQUEST_BUDGET_EXHAUSTED', status: 429 });
  return fetch(input, init);
}

function retryDelay(response, attempt) {
  const explicit = parseRetryAfter(response?.headers?.get('retry-after'));
  if (explicit != null) return explicit;
  const ceiling = Math.min(MAX_RETRY_DELAY_MS, 500 * (2 ** attempt));
  return Math.max(100, Math.floor(Math.random() * ceiling));
}

function boundedResponse(response, maxBytes) {
  if (!response.body || !Number.isFinite(maxBytes)) return response;
  const reader = response.body.getReader();
  let received = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          controller.error(new SecRequestError('SEC response exceeded the configured size limit.', {
            code: 'SEC_RESPONSE_TOO_LARGE',
            status: 502,
          }));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function requestOnce(url, { fetchOptions, headers, signal, timeoutMs, maxBytes }) {
  let current = url;
  const redirectMode = fetchOptions.redirect || 'follow';
  const method = fetchOptions.method || 'GET';
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const response = await pacedFetch(current, {
      ...fetchOptions,
      method,
      headers,
      signal: combinedSignal,
      // Never let the runtime make an unpaced redirect request or forward the
      // SEC identity header to an unvalidated destination.
      redirect: redirectMode === 'error' ? 'error' : 'manual',
    }, signal);
    await publishResponseCooldown(response);
    const location = REDIRECT_STATUS.has(response.status)
      ? response.headers.get('location')
      : null;
    if (!location || redirectMode === 'manual') {
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel();
        throw new SecRequestError('SEC response exceeded the configured size limit.', {
          code: 'SEC_RESPONSE_TOO_LARGE',
          status: 502,
        });
      }
      return boundedResponse(response, maxBytes);
    }
    if (redirects === 3 || !['GET', 'HEAD'].includes(String(method).toUpperCase())) {
      await response.body?.cancel();
      throw new SecRequestError('SEC returned an unsupported redirect.', {
        code: 'SEC_REDIRECT_INVALID',
        status: 502,
      });
    }
    const target = new URL(location, current);
    if (!isSecUrl(target)) {
      await response.body?.cancel();
      throw new SecRequestError('SEC attempted to redirect outside an approved host.', {
        code: 'SEC_REDIRECT_INVALID',
        status: 502,
      });
    }
    await response.body?.cancel();
    current = target;
  }
  throw new SecRequestError('SEC returned too many redirects.', {
    code: 'SEC_REDIRECT_INVALID',
    status: 502,
  });
}

/**
 * SEC-aware replacement for fetch(). It returns the final Response so callers
 * retain control of JSON, text, or streaming parsing.
 */
export async function secFetch(input, options = {}) {
  if (!isSecUrl(input)) {
    throw new SecRequestError('Refused a non-SEC upstream URL.', {
      code: 'SEC_URL_INVALID',
      status: 400,
    });
  }
  const {
    signal,
    timeoutMs = 15_000,
    retries = 2,
    maxBytes = 40_000_000,
    headers: providedHeaders,
    ...fetchOptions
  } = options;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 4) {
    throw new TypeError('SEC retries must be an integer from 0 to 4.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError('SEC timeout must be between 1 ms and 300 seconds.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) {
    throw new TypeError('SEC response limit must be between 1 byte and 100 MiB.');
  }
  const url = input instanceof URL ? input : new URL(String(input));
  const headers = new Headers(providedHeaders || {});
  headers.set('User-Agent', userAgent());
  if (!headers.has('Accept')) headers.set('Accept', 'application/json,text/plain,*/*');

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw abortError(signal);
    try {
      const response = await requestOnce(url, {
        fetchOptions,
        headers,
        signal,
        timeoutMs,
        maxBytes,
      });
      if (isRetryableSecStatus(response.status) && attempt < retries) {
        const waitMs = retryDelay(response, attempt);
        // Preserve a long provider-requested cooldown without tying up this
        // request. The caller can serve stale data or propagate Retry-After.
        if (waitMs > MAX_RETRY_DELAY_MS) return response;
        await response.body?.cancel();
        await delay(waitMs, signal);
        continue;
      }
      return response;
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (error instanceof SecRequestError) {
        // A brief coordination outage may recover, but never dispatch without
        // a new verified grant. The next requestOnce re-enters the same gate.
        // Provider cooldowns and validation/security failures remain terminal.
        const retryCoordination = ['GET', 'HEAD'].includes(String(fetchOptions.method || 'GET').toUpperCase())
          && ['SEC_RATE_GATE_UNAVAILABLE', 'SEC_RATE_GATE_SATURATED'].includes(error.code);
        if (!retryCoordination || attempt >= retries) throw error;
        await delay(retryDelay(null, attempt), signal);
        continue;
      }
      lastError = error;
      if (attempt >= retries) break;
      await delay(retryDelay(null, attempt), signal);
    }
  }
  throw new SecRequestError('SEC request failed after bounded retries.', {
    code: 'SEC_UPSTREAM_UNAVAILABLE',
    status: 502,
    cause: lastError,
  });
}

export function secClientStatus() {
  return {
    sharedGate: process.env.VERCEL_ENV === 'production' ? 'configured' : 'disabled',
    coordinationBackend: DEPLOYED_RUNTIME ? 'supabase' : 'local',
    startsPerSecond: STARTS_PER_SECOND,
    userAgent: isValidSecUserAgent(process.env.SEC_USER_AGENT) ? 'configured' : 'invalid',
  };
}
