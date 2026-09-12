const values = new Map();
const pending = new Map();
const CLIENT_TTL = 5 * 60_000;

function waitForCaller(task, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs), callerSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (callerSignal.aborted) return Promise.reject(new Error(signal?.aborted ? 'CFTC request cancelled.' : 'The prepared CFTC request timed out.'));
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new Error(signal?.aborted ? 'CFTC request cancelled.' : 'The prepared CFTC request timed out.'));
    callerSignal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([task, cancelled]).finally(() => callerSignal.removeEventListener('abort', onAbort));
}

/**
 * @param {string} path
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function fetchPreparedCftc(path, { signal, timeoutMs = 45_000 } = {}) {
  const cached = values.get(path);
  if (cached && Date.now() - cached.at < CLIENT_TTL) return cached.value;
  let task = pending.get(path);
  if (!task) {
    task = (async () => {
    const requestSignal = AbortSignal.timeout(45_000);
    let response;
    try { response = await fetch(path, { headers: { Accept: 'application/json' }, signal: requestSignal }); }
    catch (error) {
      if (requestSignal.aborted) throw new Error('The prepared CFTC request timed out.');
      throw error;
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(result?.error || 'CFTC positioning is temporarily unavailable.');
      error.code = result?.code || 'CFTC_UNAVAILABLE';
      error.status = response.status;
      throw error;
    }
    values.set(path, { at: Date.now(), value: result });
    return result;
    })();
    pending.set(path, task);
    task.finally(() => { if (pending.get(path) === task) pending.delete(path); }).catch(() => {});
  }
  return waitForCaller(task, signal, timeoutMs);
}

export function clearPreparedCftc(path = null) {
  if (path) values.delete(path); else values.clear();
}
