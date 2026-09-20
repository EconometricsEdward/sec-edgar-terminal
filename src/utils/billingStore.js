import { getDataStoreIdentityToken } from './dataStoreIdentity.js';
import { BILLING_PRODUCTION_SUPABASE } from './billingConfig.js';

export class BillingStoreError extends Error {
  constructor(code = 'BILLING_UNAVAILABLE') { super('Billing is temporarily unavailable.'); this.name = 'BillingStoreError'; this.code = code; this.status = 503; }
}

/** Production workload identity is the only path into the production ledger. */
export function createBillingStore({ env = process.env, fetchImpl = (...args) => fetch(...args),
  identityTokenImpl = getDataStoreIdentityToken } = {}) {
  async function operation(action, payload, { signal } = {}) {
    const production = env.VERCEL_ENV === 'production';
    // An explicitly isolated local test may use a service credential. Never
    // allow this path in a Vercel preview or against the production project.
    const localTest = !env.VERCEL_ENV && env.NODE_ENV === 'test' && env.BILLING_LOCAL_TEST_MODE === 'true'
      && env.SUPABASE_URL && env.SUPABASE_URL !== BILLING_PRODUCTION_SUPABASE
      && env.SUPABASE_SERVICE_ROLE_KEY;
    if (!production && !localTest) throw new BillingStoreError();
    const timeout = AbortSignal.timeout(10000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    combined.throwIfAborted();
    let token;
    try {
      token = production ? await identityTokenImpl() : env.SUPABASE_SERVICE_ROLE_KEY;
      if (typeof token !== 'string' || !token.length || token.length > 16384 || /[\r\n]/.test(token)) throw new BillingStoreError();
      const base = production ? `${BILLING_PRODUCTION_SUPABASE}/functions/v1/edgar-data-gateway` : new URL(env.SUPABASE_URL).origin;
      // Normalize before comparing, so a trailing slash cannot bypass the test fence.
      if (!production && base === BILLING_PRODUCTION_SUPABASE) throw new BillingStoreError();
      const response = await fetchImpl(`${base}/rest/v1/rpc/edgar_billing_operation`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          ...(production ? { 'x-region': 'us-east-1' } : { apikey: token }) },
        body: JSON.stringify({ p_action: action, p_payload: payload }), signal: combined, cache: 'no-store', redirect: 'error',
      });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new BillingStoreError(); }
      if (Number(response.headers.get('content-length')) > 65536) throw new BillingStoreError();
      const reader = response.body?.getReader();
      if (!reader) throw new BillingStoreError();
      const chunks = []; let size = 0;
      try {
        while (true) {
          combined.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new BillingStoreError();
          chunks.push(Buffer.from(value));
        }
      } finally { void reader.cancel().catch(() => {}); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || Array.isArray(result) || typeof result !== 'object') throw new BillingStoreError();
      return result;
    } catch { throw new BillingStoreError(); }
  }
  return { operation };
}
