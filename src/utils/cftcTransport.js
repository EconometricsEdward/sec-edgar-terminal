import {
  warmAcquireLease,
  warmCacheEnabled,
  warmCooldownRemaining,
  warmExtendCooldown,
  warmReleaseLease,
} from './warmCache.js';

const deploymentScope = process.env.VERCEL_ENV === 'production'
  ? 'production'
  : process.env.VERCEL_ENV === 'preview'
    ? `preview-${String(process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 12)}`
    : 'local';

/** Coordination for CFTC requests is deliberately separate from SEC pacing. */
export const CFTC_TRANSPORT_NAMESPACE = `edgar.cftc-transport.v1:${deploymentScope}`;
export const CFTC_TRANSPORT_ACQUIRE_MS = 12_000;
export const CFTC_TRANSPORT_LEASE_MS = 15_000;

const localState = {
  active: false,
  cooldownUntil: 0,
};

export class CftcTransportError extends Error {
  constructor(message, { code = 'CFTC_TRANSPORT_UNAVAILABLE', status = 503, retryAfter = null } = {}) {
    super(message);
    this.name = 'CftcTransportError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function abortTransportError(signal) {
  const timedOut = signal?.reason?.name === 'TimeoutError';
  return new CftcTransportError(
    timedOut ? 'The bounded CFTC source request timed out.' : 'The CFTC request was cancelled.',
    { code: timedOut ? 'CFTC_TIMEOUT' : 'CFTC_REQUEST_CANCELLED', status: timedOut ? 504 : 499 },
  );
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortTransportError(signal));
      return;
    }
    let onAbort;
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    onAbort = () => {
      clearTimeout(timer);
      reject(abortTransportError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create the single-slot outbound gate. Production uses a distributed lease;
 * local/test environments retain the same concurrency bound in-process.
 */
export function createCftcOutboundGate({
  sharedEnabled = warmCacheEnabled,
  acquireLease = warmAcquireLease,
  releaseLease = warmReleaseLease,
  cooldownRemaining = warmCooldownRemaining,
  extendCooldown = warmExtendCooldown,
  now = () => Date.now(),
  pollMs = 50,
  acquireBudgetMs = CFTC_TRANSPORT_ACQUIRE_MS,
  leaseMs = CFTC_TRANSPORT_LEASE_MS,
  state = localState,
} = {}) {
  async function currentCooldown() {
    if (!sharedEnabled()) return Math.max(0, state.cooldownUntil - now());
    const remaining = await cooldownRemaining(CFTC_TRANSPORT_NAMESPACE, 'retry-after');
    if (remaining == null) {
      throw new CftcTransportError('Shared CFTC source coordination is unavailable.', {
        code: 'CFTC_COORDINATION_UNAVAILABLE',
      });
    }
    return remaining;
  }

  async function publishCooldown(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return true;
    const bounded = Math.min(60_000, Math.ceil(milliseconds));
    if (!sharedEnabled()) {
      state.cooldownUntil = Math.max(state.cooldownUntil, now() + bounded);
      return true;
    }
    const published = await extendCooldown(CFTC_TRANSPORT_NAMESPACE, 'retry-after', bounded);
    if (!published) {
      throw new CftcTransportError('The shared CFTC cooldown could not be published.', {
        code: 'CFTC_COORDINATION_UNAVAILABLE',
      });
    }
    return true;
  }

  async function acquire(signal) {
    const deadline = now() + acquireBudgetMs;
    while (true) {
      if (signal?.aborted) throw abortTransportError(signal);
      const cooldown = await currentCooldown();
      if (cooldown > 0) {
        throw new CftcTransportError('The official CFTC source requested a bounded cooldown.', {
          code: 'CFTC_RATE_LIMITED', status: 503, retryAfter: cooldown,
        });
      }

      if (!sharedEnabled()) {
        if (!state.active) {
          state.active = true;
          return () => { state.active = false; };
        }
      } else {
        const token = await acquireLease(CFTC_TRANSPORT_NAMESPACE, 'outbound', leaseMs);
        if (token) {
          return async () => {
            await releaseLease(CFTC_TRANSPORT_NAMESPACE, 'outbound', token).catch(() => false);
          };
        }
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new CftcTransportError('The bounded CFTC source concurrency gate is busy.', {
          code: 'CFTC_SOURCE_BUSY', status: 503, retryAfter: 1000,
        });
      }
      await wait(Math.min(pollMs, remaining), signal);
    }
  }

  async function run(task, { signal } = {}) {
    const release = await acquire(signal);
    try {
      return await task();
    } finally {
      await release();
    }
  }

  return { run, publishCooldown };
}

export const cftcOutboundGate = createCftcOutboundGate();
