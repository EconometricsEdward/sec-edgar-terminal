/** Server-only durable payment claim and receipt adapter. Never retains signed payment headers. */
import { createHash, randomUUID } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { getDataStoreIdentityToken } from './dataStoreIdentity.js';
import { X402_LIMITS, X402_SOLANA_NETWORK, validX402Payment, validX402Rpc, validX402Delivery, x402RpcBytes } from '../../supabase/functions/edgar-data-gateway/x402Policy.js';

const gzipAsync = promisify(gzip), gunzipAsync = promisify(gunzip);

const PROJECT = 'vvkihuduqqnxqahhbphs';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
export class X402LedgerError extends Error {
  constructor(code, status = 503) { super(code); this.name = 'X402LedgerError'; this.code = code; this.status = status; }
}
function configuration(env) {
  if (typeof window !== 'undefined') throw new X402LedgerError('server_only', 403);
  if (env.VERCEL_ENV === 'preview') throw new X402LedgerError('preview_payment_ledger_denied', 403);
  const secret = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  const oidc = env.VERCEL_ENV === 'production' && !secret;
  const raw = env.SUPABASE_URL || (oidc ? `https://${PROJECT}.supabase.co` : undefined);
  if (!raw || !secret && !oidc) throw new X402LedgerError('payment_ledger_unavailable');
  let url; try { url = new URL(raw); } catch { throw new X402LedgerError('invalid_payment_ledger_endpoint'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !local && (url.hostname !== `${PROJECT}.supabase.co` || url.protocol !== 'https:')
    || oidc && local) throw new X402LedgerError('unapproved_payment_ledger_endpoint', 403);
  if (env.VERCEL_ENV !== 'production' && env.EDGAR_X402_TRUSTED_REHEARSAL !== '1') throw new X402LedgerError('untrusted_payment_runtime', 403);
  const namespace = env.VERCEL_ENV === 'production' ? 'production' : env.EDGAR_X402_NAMESPACE || 'rehearsal';
  if (!/^[a-z0-9_-]{1,48}$/.test(namespace)) throw new X402LedgerError('invalid_payment_namespace', 422);
  return { url: url.origin, secret, oidc, namespace };
}
async function responseJson(response, limit = X402_LIMITS.rpcBytes) {
  const announced = Number(response.headers.get('content-length'));
  if (announced > limit) { await response.body?.cancel(); throw new X402LedgerError('payment_ledger_response_too_large'); }
  let bytes = 0; const chunks = [];
  const reader = response.body?.getReader();
  if (reader) try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new X402LedgerError('payment_ledger_response_too_large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!response.ok) throw new X402LedgerError(`payment_ledger_http_${response.status}`);
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
  catch { throw new X402LedgerError('invalid_payment_ledger_response'); }
}

/** Call only after SDK cryptographically verifies an authorization for the exact paid resource. */
export function createX402Ledger({ env = process.env, fetchImpl = (...args) => fetch(...args),
  identityTokenImpl = getDataStoreIdentityToken, now = Date.now, timeoutMs = 5000 } = {}) {
  async function rpc(name, params) {
    const config = configuration(env);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (config.oidc) {
        headers.Authorization = `Bearer ${await identityTokenImpl()}`;
        headers['x-region'] = 'us-east-1';
      } else {
        headers.apikey = config.secret;
        if (!config.secret.startsWith('sb_secret_')) headers.Authorization = `Bearer ${config.secret}`;
      }
      const prefix = config.oidc ? '/functions/v1/edgar-data-gateway' : '';
      const response = await fetchImpl(`${config.url}${prefix}/rest/v1/rpc/${name}`, { method: 'POST', headers,
        body: JSON.stringify({ p_namespace: config.namespace, ...params }), signal: controller.signal,
        cache: 'no-store', redirect: 'error' });
      return await responseJson(response, x402RpcBytes(name));
    } catch (error) {
      if (error instanceof X402LedgerError) throw error;
      throw new X402LedgerError(controller.signal.aborted ? 'payment_ledger_timeout' : 'payment_ledger_transport_failure');
    } finally { clearTimeout(timer); }
  }
  function ready() { try { configuration(env); return true; } catch { return false; } }
  async function claim({ paymentHash, resourceUrl, payer, network, asset, amount, payTo, nonce, validBefore, requestId = randomUUID() }) {
    // Solana's nonce is the SHA256 of decoded, verified message bytes. It excludes
    // signature slots, so altered wire signatures cannot create a second claim.
    if (!HASH.test(paymentHash || '') || !HASH.test(nonce || '') || !UUID.test(requestId)) throw new X402LedgerError('invalid_payment_claim', 422);
    const payment = { paymentHash, resourceUrl, resourceHash: hash(resourceUrl), payer,
      network, asset, amount: String(amount), payTo,
      nonceHash: nonce, validBefore: String(validBefore) };
    if (!validX402Payment(payment, now())) throw new X402LedgerError('invalid_payment_claim', 422);
    const result = await rpc('edgar_x402_claim', { p_payment: payment, p_owner: requestId });
    if (result?.claimed === true && result.token?.paymentHash === paymentHash && result.token?.owner === requestId) return result;
    if (result?.claimed === false && ['pending', 'settled', 'failed', 'handler_failed'].includes(result.status)
      && result.token === undefined) return result;
    throw new X402LedgerError('invalid_payment_claim_response');
  }
  async function finish({ paymentHash, requestId, token, status, transaction, payer, network, errorCode }) {
    const claim = token || { paymentHash, owner: requestId };
    if (paymentHash !== undefined && claim.paymentHash !== paymentHash || requestId !== undefined && claim.owner !== requestId)
      throw new X402LedgerError('invalid_payment_receipt_owner', 422);
    const normalize = value => network === X402_SOLANA_NETWORK ? value : value.toLowerCase();
    const receipt = { status, ...(transaction === undefined ? {} : { transaction: normalize(transaction) }),
      ...(payer === undefined ? {} : { payer: normalize(payer) }), ...(network === undefined ? {} : { network }),
      ...(errorCode === undefined ? {} : { errorCode }) };
    if (!validX402Rpc('edgar_x402_finish', { p_claim: claim, p_receipt: receipt }, now())) throw new X402LedgerError('invalid_payment_receipt', 422);
    const result = await rpc('edgar_x402_finish', { p_claim: claim, p_receipt: receipt });
    if (result?.finished !== true || result.status !== status) throw new X402LedgerError('payment_receipt_not_recorded');
    return result;
  }
  async function stageDelivery({ token, recoveryHash, bytes, status, headers }) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > X402_LIMITS.deliveryBytes) throw new X402LedgerError('invalid_delivery', 422);
    const safeHeaders = {};
    const responseHeaders = new Headers(headers);
    for (const name of ['content-type', 'content-disposition', 'x-data-stale', 'x-schema-version', 'link']) {
      if (responseHeaders.has(name)) safeHeaders[name] = responseHeaders.get(name);
    }
    const compressed = await gzipAsync(bytes);
    const delivery = { recoveryHash, gzipBase64: compressed.toString('base64'), gzipHash: hash(compressed),
      contentHash: hash(bytes), rawBytes: bytes.length, status, headers: safeHeaders };
    if (!validX402Rpc('edgar_x402_stage_delivery', { p_claim: token, p_delivery: delivery })) throw new X402LedgerError('invalid_delivery', 422);
    const result = await rpc('edgar_x402_stage_delivery', { p_claim: token, p_delivery: delivery });
    if (result?.staged !== true || !Number.isFinite(Date.parse(result.expiresAt))) throw new X402LedgerError('delivery_not_stored');
    return { expiresAt: result.expiresAt };
  }
  async function recoverDelivery(recoveryHash) {
    if (!HASH.test(recoveryHash || '')) throw new X402LedgerError('invalid_recovery_token', 422);
    const result = await rpc('edgar_x402_recover_delivery', { p_recovery_hash: recoveryHash });
    if (result?.found === false) return result;
    if (result?.found !== true || !['pending', 'settled', 'failed', 'handler_failed'].includes(result.status)
      || !Number.isFinite(Date.parse(result.expiresAt))) throw new X402LedgerError('invalid_delivery_response');
    if (result.status !== 'settled') {
      if (result.delivery !== undefined) throw new X402LedgerError('unsettled_delivery_disclosed');
      return result;
    }
    const delivery = result.delivery;
    if (!validX402Delivery({ ...delivery, recoveryHash }) || !HASH.test(result.paymentHash || '')
      || !validX402Rpc('edgar_x402_finish', { p_claim: { paymentHash: result.paymentHash, owner: randomUUID() },
        p_receipt: { status: 'settled', transaction: result.transaction, payer: result.payer, network: result.network } })) throw new X402LedgerError('invalid_delivery_response');
    const compressed = Buffer.from(delivery.gzipBase64, 'base64');
    if (hash(compressed) !== delivery.gzipHash) throw new X402LedgerError('delivery_integrity_failure');
    let bytes;
    try { bytes = await gunzipAsync(compressed, { maxOutputLength: X402_LIMITS.deliveryBytes }); }
    catch { throw new X402LedgerError('delivery_integrity_failure'); }
    if (bytes.length !== delivery.rawBytes || hash(bytes) !== delivery.contentHash) throw new X402LedgerError('delivery_integrity_failure');
    return { ...result, delivery: { ...delivery, bytes } };
  }
  return Object.freeze({ claim, finish, ready, stageDelivery, recoverDelivery });
}
export const x402Ledger = createX402Ledger();
