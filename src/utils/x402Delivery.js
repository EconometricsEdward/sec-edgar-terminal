import { x402Ledger } from './x402Ledger.js';
import { createX402AttemptGate, x402ResponseHeaders } from './x402Payments.js';
import { x402RecoveryToken } from './x402RecoveryToken.js';

/** Recover an opted-in purchase without creating or resubmitting a payment. */
export function createX402DeliveryHandler({ ledger = x402Ledger, attemptGate = createX402AttemptGate() } = {}) {
  return async request => {
    const headers = x402ResponseHeaders({ 'X-Robots-Tag': 'noindex' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: x402ResponseHeaders({ Allow: 'GET, OPTIONS' }) });
    if (new URL(request.url).search || request.headers.has('payment-signature') || request.headers.has('x-payment'))
      return Response.json({ error: 'invalid_delivery_request' }, { status: 400, headers });
    let recoveryHash;
    try { recoveryHash = x402RecoveryToken(request, { required: true }); }
    catch { return Response.json({ error: 'invalid_recovery_token' }, { status: 400, headers }); }
    const permit = attemptGate.acquire();
    if (!permit.allowed) {
      headers.set('Retry-After', String(permit.retryAfter));
      return Response.json({ error: 'delivery_attempt_limit' }, { status: 429, headers });
    }
    try {
      const result = await ledger.recoverDelivery(recoveryHash);
      if (!result.found) return Response.json({ error: 'delivery_not_found_or_expired' }, { status: 404, headers });
      if (result.status !== 'settled') return Response.json({ status: result.status, expiresAt: result.expiresAt,
        ...(result.transaction ? { transaction: result.transaction } : {}), ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.status === 'pending' ? { retry: 'Do not authorize another payment while settlement is pending. Preserve purchase details for reconciliation.' } : {}),
      }, { status: result.status === 'pending' ? 202 : 409, headers });
      const { encodePaymentResponseHeader } = await import('@x402/core/http');
      for (const [name, value] of Object.entries(result.delivery.headers)) headers.set(name, value);
      headers.set('PAYMENT-RESPONSE', encodePaymentResponseHeader({ success: true, transaction: result.transaction,
        network: result.network, payer: result.payer }));
      headers.set('X-Content-SHA256', result.delivery.contentHash);
      headers.set('X-X402-Recovery-Until', result.expiresAt);
      headers.set('X-X402-Recovered', '1');
      return new Response(result.delivery.bytes, { status: result.delivery.status, headers });
    } catch {
      return Response.json({ error: 'delivery_lookup_unavailable' }, { status: 503, headers });
    } finally { permit.release(); }
  };
}

export const x402DeliveryGET = createX402DeliveryHandler();
