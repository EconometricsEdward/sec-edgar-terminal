const PENDING = new Set(['queued', 'running', 'retry']);
const MAX_ATTEMPTS = 24;
const MAX_FAILURES = 3;
const SESSION_MS = 15 * 60 * 1000;

function retryAfter(response, now) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now) || 0;
}

/** Do not check a waiting queue before any of its reported retries can run. */
function pendingDelay(jobs, now) {
  const pending = jobs.filter(job => PENDING.has(job.status));
  if (!pending.length || pending.some(job => job.status !== 'retry')) return 0;
  const dates = pending.map(job => Date.parse(job.next_attempt_at));
  return dates.every(Number.isFinite) ? Math.max(0, Math.min(...dates) - now) : 0;
}

export async function loadBankPreparation({ selection, signal, fetchImpl = fetch, timeoutMs = 30000 }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(`/api/banks?rssds=${selection}`, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) {
    const error = new Error('Bank preparation status is temporarily unavailable.');
    error.retryDelay = retryAfter(response, Date.now());
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw error;
  }
  const data = await response.json();
  if (!data || !['banks', 'reports', 'jobs', 'periods'].every(key => Array.isArray(data[key]))) {
    throw new Error('Bank preparation returned an invalid response.');
  }
  return data;
}

/** One visible-page polling session. Only an explicit user retry starts another. */
export function startBankPreparationPolling({
  selection, initialJobs = [], onData, onPause,
  read = loadBankPreparation, now = Date.now,
  visibility = document, schedule = setTimeout, cancel = clearTimeout,
}) {
  let jobs = initialJobs, attempts = 0, failures = 0, stopped = false, timer, request;
  let nextAt = now() + Math.max(5000, pendingDelay(jobs, now()));
  const expiresAt = now() + SESSION_MS;
  const cleanup = () => {
    stopped = true;
    cancel(timer);
    cancel(expiry);
    request?.abort();
    visibility.removeEventListener('visibilitychange', visibilityChanged);
  };
  const pause = reason => { cleanup(); onPause(reason); };
  const arm = () => {
    cancel(timer);
    if (stopped || request || visibility.visibilityState === 'hidden') return;
    if (now() >= expiresAt || attempts >= MAX_ATTEMPTS) { pause('waiting'); return; }
    timer = schedule(poll, Math.max(0, nextAt - now()));
  };
  async function poll() {
    if (stopped || request || visibility.visibilityState === 'hidden') return;
    if (now() >= expiresAt || attempts >= MAX_ATTEMPTS) { pause('waiting'); return; }
    request = new AbortController();
    attempts++;
    let minimumDelay = 0;
    try {
      const data = await read({ selection, signal: request.signal });
      if (stopped) return;
      failures = 0;
      jobs = data.jobs;
      onData(data);
      if (!jobs.some(job => PENDING.has(job.status))) { cleanup(); return; }
    } catch (error) {
      if (stopped) return;
      if (error.permanent || ++failures >= MAX_FAILURES) { pause('unavailable'); return; }
      minimumDelay = Number.isFinite(error.retryDelay) ? Math.max(0, error.retryDelay) : 0;
    } finally {
      request = undefined;
    }
    nextAt = now() + Math.max(minimumDelay, pendingDelay(jobs, now()), Math.min(60000, 15000 * 2 ** (attempts - 1)));
    arm();
  }
  function visibilityChanged() { arm(); }
  const expiry = schedule(() => pause('waiting'), SESSION_MS);
  visibility.addEventListener('visibilitychange', visibilityChanged);
  arm();
  return cleanup;
}
