/**
 * Shared server-side SEC transport.
 *
 * Every direct request to an SEC host should pass through this module. It
 * enforces one application-wide request-start budget with Upstash in
 * production, retains a conservative per-instance fallback for local work,
 * honors Retry-After, and applies bounded retries/timeouts.
 */

const SEC_HOSTS = new Set(['data.sec.gov', 'www.sec.gov', 'efts.sec.gov']);
const REST_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SHARED_GATE_ENABLED = Boolean(REST_URL && REST_TOKEN);
const DEPLOYED_RUNTIME = Boolean(process.env.VERCEL_ENV || process.env.VERCEL)
  || process.env.NODE_ENV === 'production';
const STARTS_PER_SECOND = 7;
const LOCAL_INTERVAL_MS = Math.ceil(1000 / STARTS_PER_SECOND);
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const MAX_GATE_WAIT_MS = 2_000;
const START_LOCK_TTL_MS = 5_000;
const START_LOCK_POLL_MS = 50;
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

async function gatePipeline(commands, signal) {
  const response = await fetch(`${REST_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
      : AbortSignal.timeout(2000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`shared gate returned HTTP ${response.status}`);
  const results = await response.json();
  if (!Array.isArray(results) || results.length !== commands.length || results.some((item) => item?.error)) {
    throw new Error('shared gate returned an invalid pipeline response');
  }
  return results;
}

async function sharedPermit(signal) {
  if (signal?.aborted) throw abortError(signal);
  // Hold a short distributed mutex across the actual fetch() dispatch. Merely
  // reserving timestamps can bunch starts when Redis responses arrive out of
  // order; the mutex is released only after the real request has started and
  // the minimum interval has elapsed.
  const script = `
    local cooldown = redis.call('PTTL', KEYS[2])
    if cooldown > 0 then return { -1, cooldown } end
    local acquired = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
    if acquired then return { 1, 0 } end
    local lock_ttl = redis.call('PTTL', KEYS[1])
    if lock_ttl < 1 then lock_ttl = 1 end
    return { 0, math.min(lock_ttl, tonumber(ARGV[3])) }
  `;
  const token = crypto.randomUUID();
  const deadline = Date.now() + MAX_GATE_WAIT_MS;
  while (true) {
    const results = await gatePipeline([
      [
        'EVAL',
        script,
        2,
        'upstream:sec:start-lock',
        'upstream:sec:cooldown',
        token,
        START_LOCK_TTL_MS,
        START_LOCK_POLL_MS,
      ],
    ], signal);
    const reservation = results?.[0]?.result;
    const state = Number(reservation?.[0]);
    const waitMs = Number(reservation?.[1]);
    if (![-1, 0, 1].includes(state) || !Number.isFinite(waitMs) || waitMs < 0) {
      throw new Error('shared gate returned an invalid lock response');
    }
    if (state === 1) return { token };
    const remaining = deadline - Date.now();
    if (remaining <= 0 || (state === -1 && waitMs > remaining)) {
      throw new SecRequestError('SEC request coordination is temporarily saturated.', {
        code: state === -1 ? 'SEC_UPSTREAM_COOLDOWN' : 'SEC_RATE_GATE_SATURATED',
        status: 503,
      });
    }
    await delay(Math.min(Math.max(1, waitMs), remaining), signal);
  }
}

async function reservePermit(signal) {
  if (!SHARED_GATE_ENABLED) {
    if (DEPLOYED_RUNTIME) {
      throw new SecRequestError('Shared SEC request coordination is unavailable.', {
        code: 'SEC_RATE_GATE_UNAVAILABLE',
        status: 503,
      });
    }
    return localPermit(signal);
  }
  try {
    return await sharedPermit(signal);
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (DEPLOYED_RUNTIME) {
      if (error instanceof SecRequestError) throw error;
      throw new SecRequestError('Shared SEC request coordination failed.', {
        code: 'SEC_RATE_GATE_UNAVAILABLE',
        status: 503,
        cause: error,
      });
    }
    return localPermit(signal);
  }
}

async function publishCooldown(delayMs) {
  if (!SHARED_GATE_ENABLED || delayMs <= 0) return false;
  try {
    const script = `
      local current = redis.call('PTTL', KEYS[1])
      local candidate = tonumber(ARGV[1])
      if candidate > current then
        redis.call('SET', KEYS[1], '1', 'PX', candidate)
        return candidate
      end
      return current
    `;
    await gatePipeline([
      ['EVAL', script, 1, 'upstream:sec:cooldown', Math.ceil(delayMs)],
    ]);
    return true;
  } catch {
    // The current request still backs off locally; a failed advisory write
    // must not replace the more useful upstream error.
    return false;
  }
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

async function releaseSharedPermit(permit, startedAt, cooldownMs = 0) {
  if (!permit?.token) return false;
  // Do not let caller cancellation shorten the global spacing guarantee.
  await delay(Math.max(0, LOCAL_INTERVAL_MS - (Date.now() - startedAt)));
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      local candidate = tonumber(ARGV[2])
      local current = redis.call('PTTL', KEYS[2])
      if candidate > 0 and candidate > current then
        redis.call('SET', KEYS[2], '1', 'PX', candidate)
      end
      redis.call('DEL', KEYS[1])
      return 1
    end
    return 0
  `;
  try {
    const result = await gatePipeline([
      [
        'EVAL',
        script,
        2,
        'upstream:sec:start-lock',
        'upstream:sec:cooldown',
        permit.token,
        Math.max(0, Math.ceil(cooldownMs)),
      ],
    ]);
    return Number(result?.[0]?.result) === 1;
  } catch {
    // The five-second lease is the safe fallback if an explicit release fails.
    return false;
  }
}

async function pacedFetch(input, init, signal) {
  const permit = await reservePermit(signal);
  const startedAt = Date.now();
  let request;
  try {
    request = fetch(input, init);
  } catch (error) {
    await releaseSharedPermit(permit, startedAt);
    throw error;
  }
  // Attach both handlers immediately so a fast rejection cannot become an
  // unhandled promise while the start lock completes its hold interval.
  const outcome = Promise.resolve(request).then(
    (response) => ({ response }),
    (error) => ({ error }),
  );
  // If response headers arrive inside the hold interval, publish a 403/429
  // cooldown while the mutex is still owned. This prevents a delayed lock-
  // release response from opening a race before the cooldown write.
  let earlyResponse = null;
  let earlyCooldown = 0;
  if (permit?.token) {
    const hold = delay(Math.max(0, LOCAL_INTERVAL_MS - (Date.now() - startedAt)));
    const early = await Promise.race([
      outcome.then((settled) => ({ settled })),
      hold.then(() => null),
    ]);
    if (early?.settled?.response) {
      earlyResponse = early.settled.response;
      earlyCooldown = cooldownForResponse(earlyResponse) || 0;
    }
    await hold;
  }
  const released = await releaseSharedPermit(permit, startedAt, earlyCooldown);
  if (released && earlyResponse && earlyCooldown > 0) {
    cooldownPublished.add(earlyResponse);
  }
  const settled = await outcome;
  if (settled.error) throw settled.error;
  return settled.response;
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
      if (error instanceof SecRequestError) throw error;
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
    sharedGate: SHARED_GATE_ENABLED ? 'configured' : 'disabled',
    startsPerSecond: STARTS_PER_SECOND,
    userAgent: isValidSecUserAgent(process.env.SEC_USER_AGENT) ? 'configured' : 'invalid',
  };
}
