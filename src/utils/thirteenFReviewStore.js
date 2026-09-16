/** Server-only durable shared 13F review storage through production Vercel OIDC. */
import { getDataStoreIdentityToken } from './dataStoreIdentity.js';
import { FUND_REVIEW_LIMITS, validFundReviewRpc } from '../../supabase/functions/edgar-data-gateway/fundReviewPolicy.js';
const BASE = 'https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway/rest/v1/rpc/';
export class ThirteenFReviewStoreError extends Error {
  constructor(code, status = 503) { super(`Shared fund review: ${code}`); this.name = 'ThirteenFReviewStoreError'; this.code = code; this.status = status; }
}
export function thirteenFReviewStoreEnabled(env = process.env) {
  return typeof window === 'undefined' && env.VERCEL_ENV === 'production' && env.EDGAR_FUND_REVIEW_MODE !== 'off';
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function boundedJson(response, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > FUND_REVIEW_LIMITS.rpcBytes)) {
    await response.body?.cancel().catch(() => {}); throw new ThirteenFReviewStoreError('response_too_large', 502);
  }
  if (!response.body) throw new ThirteenFReviewStoreError('invalid_response', 502);
  const reader = response.body.getReader(), chunks = []; let count = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      count += value.byteLength;
      if (count > FUND_REVIEW_LIMITS.rpcBytes) throw new ThirteenFReviewStoreError('response_too_large', 502);
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, count))); }
    catch { throw new ThirteenFReviewStoreError('invalid_response', 502); }
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); }
}
function token(claim) {
  return { id: claim?.id, reportHash: claim?.reportHash, generation: claim?.generation, owner: claim?.owner, cycle: claim?.cycle };
}
/** Injected transport is fixture-only; production destination and namespace are fixed. */
export function createThirteenFReviewStore({ env = process.env, fetchImpl = (...args) => fetch(...args),
  identityTokenImpl = getDataStoreIdentityToken, now = Date.now, rpc: injectedRpc } = {}) {
  const enabled = () => thirteenFReviewStoreEnabled(env);
  async function rpc(name, parameters, { signal, deadline = Infinity, timeoutMs = 12000 } = {}) {
    if (!enabled()) throw new ThirteenFReviewStoreError('disabled');
    signal?.throwIfAborted();
    const params = { ...parameters, p_namespace: 'production' };
    if (!validFundReviewRpc(name, params, now())) throw new ThirteenFReviewStoreError('invalid_request', 422);
    const body = JSON.stringify(params);
    if (Buffer.byteLength(body) > FUND_REVIEW_LIMITS.rpcBytes) throw new ThirteenFReviewStoreError('request_too_large', 413);
    const remaining = Math.min(timeoutMs, deadline - now());
    if (!(remaining > 0)) throw new ThirteenFReviewStoreError('deadline');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      if (injectedRpc) return await injectedRpc(name, params, { signal: requestSignal, deadline });
      let onAbort;
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(new ThirteenFReviewStoreError('timeout'));
        requestSignal.addEventListener('abort', onAbort, { once: true });
      });
      let identity;
      try { identity = await Promise.race([identityTokenImpl(), interrupted]); }
      finally { requestSignal.removeEventListener('abort', onAbort); }
      requestSignal.throwIfAborted();
      if (typeof identity !== 'string' || !identity.length || identity.length > 12288 || /[\r\n]/.test(identity)) throw new ThirteenFReviewStoreError('identity_unavailable');
      const response = await fetchImpl(`${BASE}${name}`, { method: 'POST', headers: { Authorization: `Bearer ${identity}`,
        'Content-Type': 'application/json', 'x-region': 'us-east-1' }, body, signal: requestSignal, redirect: 'error', cache: 'no-store' });
      const value = await boundedJson(response, requestSignal);
      if (!response.ok) {
        const code = value?.code === '40001' ? 'stale_generation' : value?.code === 'fund_review_capacity' ? 'fund_review_capacity' : `http_${response.status}`;
        throw new ThirteenFReviewStoreError(code, code === 'fund_review_capacity' ? 429 : code === 'stale_generation' ? 409 : response.status);
      }
      return value;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (error instanceof ThirteenFReviewStoreError) throw error;
      throw new ThirteenFReviewStoreError(controller.signal.aborted || error?.name === 'AbortError' ? 'timeout' : 'transport_failure');
    } finally { clearTimeout(timer); }
  }
  async function enqueue(report, reportHash, options) {
    const value = await rpc('edgar_fund_review_enqueue', { p_report: report, p_report_hash: reportHash }, options);
    if (!object(value) || value.cik !== report.manager.cik || value.period !== report.selectedPeriod || value.reportHash !== reportHash)
      throw new ThirteenFReviewStoreError('invalid_acknowledgement', 502);
    return value;
  }
  async function claim({ owner, leaseSeconds = 90 }, options) {
    const value = await rpc('edgar_fund_review_claim', { p_owner: owner, p_lease_seconds: leaseSeconds }, options);
    if (value === null) return null;
    if (!object(value) || value.owner !== owner || !validFundReviewRpc('edgar_fund_review_work', { p_claim: token(value), p_limit: 1 }, now())
      || !object(value.report) || value.report.manager?.cik !== value.cik || value.report.selectedPeriod !== value.period
      || !Number.isFinite(Date.parse(value.leaseUntil)) || Date.parse(value.leaseUntil) <= now() || Date.parse(value.leaseUntil) > now() + 91000)
      throw new ThirteenFReviewStoreError('invalid_claim', 502);
    return value;
  }
  async function work(claim, { limit = 12, ...options } = {}) {
    const value = await rpc('edgar_fund_review_work', { p_claim: token(claim), p_limit: limit }, options);
    if (!Array.isArray(value) || value.length > limit || value.some(row => !Number.isSafeInteger(row?.ordinal) || row.ordinal < 1
      || row.ordinal > FUND_REVIEW_LIMITS.holdings || !object(row.holding) || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 3)
      || new Set(value.map(row => row.ordinal)).size !== value.length) throw new ThirteenFReviewStoreError('invalid_work', 502);
    return value;
  }
  async function save(claim, { ordinal, result, summary, retrySeconds = 0, ...options }) {
    const value = await rpc('edgar_fund_review_save', { p_claim: token(claim), p_ordinal: ordinal, p_result: result,
      p_summary: summary, p_retry_seconds: retrySeconds }, options);
    if (typeof value !== 'boolean') throw new ThirteenFReviewStoreError('invalid_acknowledgement', 502);
    return value;
  }
  async function release(claim, options) {
    const value = await rpc('edgar_fund_review_release', { p_claim: token(claim) }, options);
    if (typeof value !== 'boolean') throw new ThirteenFReviewStoreError('invalid_acknowledgement', 502);
    return value;
  }
  async function read({ cik, period, reportHash = null, market = null, status = null, query = null, offset = 0, limit = 25 }, options) {
    const value = await rpc('edgar_fund_review_read', { p_cik: cik, p_period: period, p_report_hash: reportHash, p_market: market,
      p_status: status, p_query: query, p_offset: offset, p_limit: limit }, options);
    if (value !== null && (!object(value) || value.job?.cik !== cik || value.job?.period !== period
      || reportHash !== null && value.job?.reportHash !== reportHash || !Array.isArray(value.rows) || value.rows.length > limit
      || !Array.isArray(value.markets) || !object(value.coverage) || !object(value.page))) throw new ThirteenFReviewStoreError('invalid_read', 502);
    return value;
  }
  async function result({ cik, period, reportHash, key }, options) {
    const value = await rpc('edgar_fund_review_result', { p_cik: cik, p_period: period, p_report_hash: reportHash, p_key: key }, options);
    if (value !== null && (!object(value) || value.manager?.cik !== cik || value.selectedPeriod !== period || value.holding?.key !== key))
      throw new ThirteenFReviewStoreError('invalid_result', 502);
    return value;
  }
  return { enabled, enqueue, claim, work, save, release, read, result };
}
export const thirteenFReviewStore = createThirteenFReviewStore();
