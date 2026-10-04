import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { X402_DEPLOYMENT_PAY_TO, X402_DEPLOYMENT_NETWORK } from './x402Deployment.js';
import { x402RecoveryToken } from './x402RecoveryToken.js';

export const X402_PRICE = '0.01';
export const X402_AMOUNT = '10000';
export const X402_SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const X402_SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TEST_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const TEST_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PAYMENT_HEADER_BYTES = 16384;
const BASE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type, PAYMENT-SIGNATURE, X-X402-Recovery-Token',
  'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, EXTENSION-RESPONSES, X-Content-SHA256, X-X402-Price, X-Data-Stale, X-X402-Recovery-Until, X-X402-Recovered, Link, Retry-After',
  'X-Content-Type-Options': 'nosniff',
};

function validBase58Bytes(value, size) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value) || value.length > 90) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(alphabet.indexOf(character));
  let bytes = 0;
  while (number) { number >>= 8n; bytes++; }
  return bytes + (value.match(/^1*/)?.[0].length || 0) === size;
}

/** Public receiving address only. This server never needs the receiving wallet's key. */
export function getX402Config(env = process.env) {
  const productionFallback = env.VERCEL_ENV === 'production';
  const payTo = String(env.X402_PAY_TO || (productionFallback ? X402_DEPLOYMENT_PAY_TO : '')).trim();
  const network = String(env.X402_NETWORK || (productionFallback ? X402_DEPLOYMENT_NETWORK : X402_SOLANA_NETWORK)).trim();
  const disabled = /^(0|false|off)$/i.test(String(env.X402_ENABLED || ''));
  let errorCode = disabled ? 'payments_disabled' : '';
  if (env.VERCEL_ENV === 'preview') errorCode ||= 'preview_payments_disabled';
  if (!validBase58Bytes(payTo, 32) || /^1+$/.test(payTo)) errorCode ||= 'receiving_wallet_required';
  if (network !== X402_SOLANA_NETWORK && network !== TEST_NETWORK) errorCode ||= 'unsupported_network';
  if ((env.NODE_ENV === 'production' || productionFallback) && network !== X402_SOLANA_NETWORK) errorCode ||= 'production_requires_solana_mainnet';
  const facilitatorUrl = String(env.X402_FACILITATOR_URL || 'https://facilitator.payai.network').replace(/\/+$/, '');
  let facilitatorHostname = '';
  try {
    const url = new URL(facilitatorUrl);
    facilitatorHostname = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) errorCode ||= 'invalid_facilitator_url';
  } catch { errorCode ||= 'invalid_facilitator_url'; }
  const authKeyId = String(env.PAYAI_API_KEY_ID || env.X402_PAYAI_API_KEY_ID || '').trim();
  const authKeySecret = String(env.PAYAI_API_KEY_SECRET || env.X402_PAYAI_API_KEY_SECRET || '').trim();
  if (Boolean(authKeyId) !== Boolean(authKeySecret)) errorCode ||= 'incomplete_facilitator_credentials';
  if (authKeyId && facilitatorHostname !== 'facilitator.payai.network') errorCode ||= 'unsupported_facilitator_credentials';
  if (authKeySecret) {
    try {
      const key = createPrivateKey({ key: Buffer.from(authKeySecret.replace(/^payai_sk_/, ''), 'base64'), format: 'der', type: 'pkcs8' });
      if (key.asymmetricKeyType !== 'ed25519') errorCode ||= 'invalid_facilitator_credentials';
    } catch { errorCode ||= 'invalid_facilitator_credentials'; }
  }
  return {
    ready: !errorCode,
    requireRecipientReady: productionFallback,
    errorCode,
    payTo,
    network,
    asset: network === TEST_NETWORK ? TEST_USDC : X402_SOLANA_USDC,
    price: X402_PRICE,
    amount: X402_AMOUNT,
    facilitatorUrl,
    timeoutMs: 20000,
    authKeyId,
    authKeySecret,
  };
}

export function getX402PublicConfiguration(env = process.env) {
  const config = getX402Config(env);
  return {
    status: config.ready ? 'active' : 'configuration-required',
    price: X402_PRICE,
    currency: 'USDC',
    network: config.network,
    ...(config.ready ? { payTo: config.payTo } : {}),
    protocol: 'x402',
    version: 2,
  };
}

export function x402ResponseHeaders(headers) {
  const result = new Headers(headers);
  for (const [key, value] of Object.entries(BASE_HEADERS)) result.set(key, value);
  // Cached validators could disclose a protected representation without another purchase.
  result.delete('ETag');
  result.delete('Last-Modified');
  return result;
}

export function x402OptionsResponse() {
  return new Response(null, { status: 204, headers: x402ResponseHeaders() });
}

export function x402HeadResponse() {
  return new Response(null, { status: 405, headers: x402ResponseHeaders({ Allow: 'GET, OPTIONS' }) });
}

function errorResponse(status, error, extra = {}) {
  return Response.json({ error, ...extra }, { status, headers: x402ResponseHeaders() });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function receiptErrorCode(value, fallback = 'settlement_failed') {
  const code = String(value ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return code || fallback;
}

function unresolvedSettlementReason(value) {
  return ['settlement_pending', 'settlement_indeterminate', 'duplicate_settlement',
    'settlement_failed', 'unknown', 'unknown_reason', 'unknown_error'].includes(receiptErrorCode(value));
}

/** Publish only the facilitator's actual Bazaar outcome; discovery never changes the payment verdict. */
function bazaarOutcomeHeader(settlement) {
  const outcome = settlement.extensionResponses?.bazaar;
  if (!outcome || !['success', 'processing', 'rejected'].includes(outcome.status)) return undefined;
  const bazaar = { status: outcome.status, ...(outcome.status === 'rejected' && typeof outcome.rejectedReason === 'string'
    ? { rejectedReason: outcome.rejectedReason.slice(0, 256) } : {}) };
  return Buffer.from(JSON.stringify({ bazaar })).toString('base64');
}

/** Keep an already-broadcast transaction when the SDK's one pending retry loses its response. */
function preserveSettlementOutcome(facilitator, SettleError) {
  const pending = new Map();
  return {
    getSupported: facilitator.getSupported.bind(facilitator),
    verify: facilitator.verify.bind(facilitator),
    async settle(payload, requirements) {
      // Retain only a hash and public transaction identifier, never the signed proof.
      const key = hash(stableJson({ payload, requirements }));
      const previous = pending.get(key);
      pending.delete(key);
      const uncertain = transaction => ({ success: false, errorReason: 'settlement_indeterminate',
        network: requirements.network, transaction: previous || (validBase58Bytes(transaction, 64) ? transaction : '') });
      let result;
      try { result = await facilitator.settle(payload, requirements); }
      catch (error) {
        if (!(error instanceof SettleError)) return uncertain();
        if (error.statusCode >= 500 || error.statusCode === 408 || !error.errorReason) return uncertain(error.transaction);
        // A structured facilitator rejection remains definitive unless an earlier
        // attempt already returned a broadcast transaction needing reconciliation.
        result = { success: false, errorReason: error.errorReason, errorMessage: error.errorMessage,
          transaction: error.transaction || '', network: error.network || requirements.network, payer: error.payer };
      }
      if (previous && (!result?.success || result.transaction !== previous)) return uncertain(result?.transaction);
      if (!result || typeof result.success !== 'boolean' || !result.success && !result.errorReason) return uncertain(result?.transaction);
      if (!result.success && result.errorReason === 'settlement_pending' && validBase58Bytes(result.transaction, 64)) {
        pending.set(key, result.transaction);
        if (pending.size > 64) pending.delete(pending.keys().next().value);
      }
      return result;
    },
  };
}

/** Extract identity from signed message bytes, never editable HTTP metadata or fee-payer signature slots. */
async function verifiedSvmPayment(paymentPayload, requirements, config) {
  const encoded = paymentPayload.payload?.transaction;
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid wire transaction');
  const wireBytes = Buffer.from(encoded, 'base64');
  if (wireBytes.length > 1232 || !wireBytes.length || wireBytes.toString('base64') !== encoded) throw new Error('Invalid wire transaction');
  const [kit, token] = await Promise.all([import('@solana/kit'), import('@solana-program/token')]);
  const transaction = kit.getTransactionDecoder().decode(wireBytes);
  const compiled = kit.getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (compiled.addressTableLookups?.length || compiled.header.numSignerAccounts > 2) throw new Error('Unsupported transaction layout');
  const message = kit.decompileTransactionMessage(compiled);
  const transfers = message.instructions.filter(instruction => instruction.programAddress === token.TOKEN_PROGRAM_ADDRESS);
  if (transfers.length !== 1 || transfers[0].data?.length !== 10 || transfers[0].data[0] !== 12) throw new Error('Invalid token instruction');
  const transfer = token.parseTransferCheckedInstruction(transfers[0]);
  const payer = transfer.accounts.authority.address;
  if (!validBase58Bytes(payer, 32) || !transaction.signatures[payer] || transaction.signatures[payer].length !== 64 ||
      transfer.accounts.mint.address !== config.asset || transfer.data.amount !== BigInt(X402_AMOUNT) || transfer.data.decimals !== 6) {
    throw new Error('Invalid USDC payment');
  }
  const [expectedDestination] = await token.findAssociatedTokenPda({ mint: config.asset, owner: config.payTo, tokenProgram: token.TOKEN_PROGRAM_ADDRESS });
  if (transfer.accounts.destination.address !== expectedDestination || message.feePayer.address !== requirements.extra?.feePayer) throw new Error('Invalid recipient or fee payer');
  const messageHash = hash(transaction.messageBytes);
  return { payer, messageHash, nonce: messageHash, validBefore: String(Math.floor(Date.now() / 1000) + 600) };
}

/**
 * Local cost guard shared by all paid routes in one server process. Vercel may
 * run several processes, so this supplements provider/WAF quotas, not a global
 * financial cap. No Redis write or database reservation is made for bad proofs.
 */
export function createX402AttemptGate({ maxConcurrent = 6, maxAttempts = 60, windowMs = 60000, now = Date.now } = {}) {
  for (const value of [maxConcurrent, maxAttempts, windowMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Invalid payment attempt limit');
  }
  let windowStarted = now();
  let attempts = 0;
  let active = 0;
  return Object.freeze({
    acquire() {
      const current = now();
      if (current - windowStarted >= windowMs || current < windowStarted) {
        windowStarted = current;
        attempts = 0;
      }
      if (attempts >= maxAttempts) return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowStarted + windowMs - current) / 1000)) };
      if (active >= maxConcurrent) return { allowed: false, retryAfter: 1 };
      attempts++;
      active++;
      let released = false;
      return {
        allowed: true,
        release() { if (!released) { active--; released = true; } },
      };
    },
  });
}
const sharedAttemptGate = createX402AttemptGate();

function requestContext(request) {
  const url = new URL(request.url);
  const adapter = {
    getHeader: name => request.headers.get(name) || undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => request.url,
    // These endpoints always return JSON payment requirements, including browser clients.
    getAcceptHeader: () => 'application/json',
    getUserAgent: () => request.headers.get('user-agent') || '',
    getQueryParams: () => Object.fromEntries(url.searchParams),
    getQueryParam: name => url.searchParams.get(name) || undefined,
  };
  return { adapter, path: url.pathname, method: request.method };
}

function instructionsResponse(instructions) {
  const body = instructions.isHtml ? instructions.body : JSON.stringify(instructions.body ?? {});
  return new Response(body, { status: instructions.status, headers: x402ResponseHeaders(instructions.headers) });
}

/** PayAI requires short-lived Ed25519 JWTs, not an API-key secret sent as a bearer token. */
function payaiAuth(config) {
  if (!config.authKeyId) return undefined;
  let cached;
  return async () => {
    const now = Math.floor(Date.now() / 1000);
    if (!cached || cached.expires <= now + 30) {
      const keyBytes = Buffer.from(config.authKeySecret.replace(/^payai_sk_/, ''), 'base64');
      const key = createPrivateKey({ key: keyBytes, format: 'der', type: 'pkcs8' });
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: config.authKeyId })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: config.authKeyId, iss: 'payai-merchant', iat: now, exp: now + 120, jti: randomUUID() })).toString('base64url');
      const message = `${header}.${payload}`;
      const token = `${message}.${sign(null, Buffer.from(message), key).toString('base64url')}`;
      cached = { token, expires: now + 120 };
    }
    const headers = { Authorization: `Bearer ${cached.token}` };
    return { verify: headers, settle: headers, supported: headers };
  };
}

/** No capability retries on a user request: one bounded read, with a short failure cooldown. */
export async function createX402FacilitatorClient(config, fetchImpl = fetch) {
  const [{ HTTPFacilitatorClient }, { z }] = await Promise.all([
    import('@x402/core/server'), import('@x402/core/schemas'),
  ]);
  const createAuthHeaders = payaiAuth(config);
  const client = new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: config.timeoutMs, createAuthHeaders });
  const supportedSchema = z.object({
    kinds: z.array(z.object({ x402Version: z.number(), scheme: z.string(), network: z.string(), extra: z.record(z.unknown()).nullish() })).max(1000),
    extensions: z.array(z.string()).default([]),
    signers: z.record(z.array(z.string())).default({}),
  });
  return {
    verify: client.verify.bind(client),
    settle: client.settle.bind(client),
    async getSupported() {
      const auth = createAuthHeaders ? await createAuthHeaders() : {};
      const response = await fetchImpl(`${config.facilitatorUrl}/supported`, {
        headers: auth.supported, cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(Math.min(config.timeoutMs, 10000)),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Facilitator capabilities unavailable'); }
      const chunks = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > 128 * 1024) throw new Error('Facilitator capabilities too large');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      return supportedSchema.parse(JSON.parse(Buffer.concat(chunks, total).toString('utf8')));
    },
  };
}

/**
 * A GET purchase is one successful, bounded JSON resource. Verification precedes
 * work; durable reservation precedes settlement; settlement precedes delivery.
 * SDK/facilitator loading is lazy, so discovery and configuration pages stay cheap.
 */
export function createPaidHandler(handler, options = {}) {
  let serverPromise;
  let previousConfig;
  let failedUntil = 0;
  const getServer = async config => {
    if (Date.now() < failedUntil) throw new Error('Facilitator initialization cooling down');
    const key = stableJson(config);
    if (!serverPromise || previousConfig !== key) {
      previousConfig = key;
      serverPromise = (async () => {
        const [{ x402ResourceServer, x402HTTPResourceServer }, { ExactSvmScheme }, { SettleError }, { bazaarResourceServerExtension }] = await Promise.all([
          import('@x402/core/server'), import('@x402/svm/exact/server'),
          import('@x402/core/types'),
          import('@x402/extensions/bazaar'),
        ]);
        const facilitator = options.facilitatorClient || await createX402FacilitatorClient(config);
        const discoveryExtension = options.omitDiscoveryRouteTemplate ? {
          ...bazaarResourceServerExtension,
          enrichDeclaration(declaration, context) {
            // Keep genuine method/path parameter enrichment while indexing the
            // concrete, probeable endpoint instead of a literal route template.
            const enriched = { ...bazaarResourceServerExtension.enrichDeclaration(declaration, context) };
            delete enriched.routeTemplate;
            return enriched;
          },
        } : bazaarResourceServerExtension;
        const resourceServer = new x402ResourceServer(preserveSettlementOutcome(facilitator, SettleError))
          .register(config.network, new ExactSvmScheme())
          .registerExtension(discoveryExtension);
        await resourceServer.initialize();
        return { resourceServer, x402HTTPResourceServer };
      })();
      serverPromise.catch(() => { serverPromise = undefined; failedUntil = Date.now() + 30000; });
    }
    return serverPromise;
  };

  return async function paidGET(request, ...handlerArgs) {
    if (request.method === 'OPTIONS') return x402OptionsResponse();
    if (request.method !== 'GET') return x402HeadResponse();
    if (request.url.length > 2048) return errorResponse(414, 'resource_url_too_long');
    if ((request.headers.get('payment-signature') || '').length > MAX_PAYMENT_HEADER_BYTES) return errorResponse(431, 'payment_header_too_large');
    let recoveryHash;
    let resourceMimeType;
    try {
      recoveryHash = x402RecoveryToken(request);
      resourceMimeType = typeof options.mimeType === 'function' ? options.mimeType(request) : options.mimeType || 'application/json';
      if (resourceMimeType !== 'application/json' && !(options.allowCsv === true && resourceMimeType === 'text/csv')) throw new Error('Invalid resource type');
    } catch { return errorResponse(400, 'invalid_resource_request'); }
    try {
      if (options.validate) {
        const validation = await options.validate(request);
        if (validation instanceof Response) return new Response(validation.body, { status: validation.status, headers: x402ResponseHeaders(validation.headers) });
      }
    } catch { return errorResponse(400, 'invalid_resource_request'); }
    const config = options.config || getX402Config();
    if (!config.ready) return errorResponse(503, 'payments_not_configured');
    const ledger = options.ledger;
    if (!ledger || typeof ledger.claim !== 'function' || typeof ledger.finish !== 'function'
      || recoveryHash && typeof ledger.stageDelivery !== 'function') return errorResponse(503, 'payment_ledger_unavailable');
    try {
      if (typeof ledger.ready === 'function' && !(await ledger.ready())) return errorResponse(503, 'payment_ledger_unavailable');
    } catch { return errorResponse(503, 'payment_ledger_unavailable'); }
    if (config.requireRecipientReady) {
      try {
        const recipientCheck = options.recipientCheck || (await import('./x402SolanaRecipient.js')).checkX402Recipient;
        const recipient = await recipientCheck(config);
        if (!recipient.ready) return errorResponse(503, recipient.status === 'recipient-setup-required'
          ? 'receiving_account_not_ready' : 'receiving_account_check_unavailable');
      } catch { return errorResponse(503, 'receiving_account_check_unavailable'); }
    }
    const permit = request.headers.get('payment-signature')
      ? (options.attemptGate || sharedAttemptGate).acquire() : undefined;
    if (permit && !permit.allowed) {
      const response = errorResponse(429, 'payment_attempt_limit');
      response.headers.set('Retry-After', String(permit.retryAfter));
      return response;
    }
    try {
      let httpServer;
      let result;
      const context = requestContext(request);
      try {
        const { resourceServer, x402HTTPResourceServer } = await getServer(config);
        // A configured route template groups discovery entries. The payment URL
        // stays exact, and a route-pattern miss can never grant access.
        httpServer = new x402HTTPResourceServer(resourceServer, {
          [`GET ${options.routePattern || context.path}`]: {
            accepts: {
              scheme: 'exact', network: config.network, payTo: config.payTo,
              price: { amount: X402_AMOUNT, asset: config.asset },
              maxTimeoutSeconds: 60,
              extra: { paymentFlow: 'authorization' },
            },
            resource: request.url,
            description: options.description || 'SEC EDGAR Terminal structured financial data',
            mimeType: resourceMimeType,
            ...(options.extensions ? { extensions: options.extensions } : {}),
            ...(options.serviceName ? { serviceName: options.serviceName } : {}),
            ...(options.tags ? { tags: options.tags } : {}),
            ...(options.iconUrl ? { iconUrl: options.iconUrl } : {}),
            unpaidResponseBody: () => ({ contentType: 'application/json', body: { error: 'payment_required', price: X402_PRICE, currency: 'USDC' } }),
          },
        });
        if (!httpServer.requiresPayment(context)) return errorResponse(503, 'payment_route_mismatch');
        result = await httpServer.processHTTPRequest(context);
      } catch {
        return errorResponse(503, 'payment_service_unavailable');
      }
      if (result.type === 'payment-error') return instructionsResponse(result.response);
      if (result.type !== 'payment-verified') return errorResponse(503, 'payment_verification_required');
      if (result.beforeHandlerSettlement) return errorResponse(503, 'unsupported_payment_flow');

      const { paymentPayload, paymentRequirements } = result;
      if (paymentPayload.resource?.url !== request.url) return errorResponse(402, 'payment_resource_mismatch');
      let proof;
      try { proof = await verifiedSvmPayment(paymentPayload, paymentRequirements, config); }
      catch { return errorResponse(402, 'invalid_payment_transaction'); }
      const paymentHash = proof.messageHash;
      const requestId = randomUUID();
      let claim;
      try {
        claim = await ledger.claim({
          paymentHash, requestId, resourceUrl: request.url,
          payer: proof.payer, network: config.network, asset: config.asset,
          amount: X402_AMOUNT, payTo: config.payTo, nonce: proof.nonce,
          validBefore: proof.validBefore,
        });
      } catch { return errorResponse(503, 'payment_ledger_unavailable'); }
      if (!claim?.claimed) return errorResponse(409, 'payment_already_used', {
        status: claim?.status || 'pending', ...(claim?.transaction ? { transaction: claim.transaction } : {}),
      });
      const finish = async (status, details = {}) => {
        try {
          await ledger.finish({ paymentHash, requestId, token: claim.token, status, ...details,
            ...(details.errorCode === undefined ? {} : { errorCode: receiptErrorCode(details.errorCode) }) });
        } catch {
          // Never discard a successfully settled resource or release a reservation
          // after an uncertain database write. Emit no signature/credential data.
          console.error('[x402] Ledger completion needs reconciliation', { paymentHash, requestId, status });
        }
      };
      const pendingDetails = (settlement, errorCode) => ({
        ...(validBase58Bytes(settlement.transaction, 64) ? {
          transaction: settlement.transaction, payer: proof.payer, network: config.network,
        } : {}),
        errorCode,
      });

      let response;
      let bytes;
      try {
        response = await handler(request, ...handlerArgs);
        if (!(response instanceof Response)) throw new Error('Invalid resource response');
        if (response.status < 200 || response.status >= 300) {
          await finish('handler_failed', { errorCode: `resource_status_${response.status}` });
          if (response.status >= 300 && response.status < 400) return errorResponse(502, 'resource_redirect_not_billable');
          return new Response(response.body, { status: response.status, headers: x402ResponseHeaders(response.headers) });
        }
        if (response.status === 204 || response.headers.get('content-type')?.split(';', 1)[0].trim() !== resourceMimeType) throw new Error('Invalid resource content type');
        const bodyReader = response.body?.getReader();
        const chunks = [];
        let total = 0;
        if (bodyReader) {
          while (true) {
            const { value, done } = await bodyReader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) {
              await bodyReader.cancel();
              throw new Error('Resource exceeds maximum paid response size');
            }
            chunks.push(value);
          }
        }
        bytes = Buffer.concat(chunks, total);
        if (!bytes.length) throw new Error('Empty resource');
        if (resourceMimeType === 'application/json') JSON.parse(bytes.toString('utf8'));
      } catch {
        await finish('handler_failed', { errorCode: 'resource_unavailable' });
        return errorResponse(502, 'resource_unavailable');
      }

      let delivery;
      if (recoveryHash) {
        try {
          delivery = await ledger.stageDelivery({ token: claim.token, recoveryHash, bytes, status: response.status, headers: response.headers });
        } catch {
          await finish('handler_failed', { errorCode: 'delivery_storage_unavailable' });
          return errorResponse(503, 'delivery_storage_unavailable', { charged: false });
        }
      }

      let settlement;
      try {
        settlement = await httpServer.processSettlement(paymentPayload, paymentRequirements, result.declaredExtensions, {
          request: context, responseBody: bytes,
          responseHeaders: Object.fromEntries(response.headers),
        });
      } catch {
        await finish('pending', { errorCode: 'settlement_indeterminate' });
        return errorResponse(503, 'settlement_indeterminate', { paymentHash, retry: 'Do not create another payment authorization; reconcile this payment.' });
      }
      if (!settlement.success) {
        const status = unresolvedSettlementReason(settlement.errorReason) || settlement.transaction ? 'pending' : 'failed';
        await finish(status, status === 'pending'
          ? pendingDetails(settlement, settlement.errorReason || 'settlement_failed')
          : { errorCode: settlement.errorReason || 'settlement_failed' });
        if (status === 'pending') return errorResponse(503, 'settlement_indeterminate', {
          paymentHash, ...(validBase58Bytes(settlement.transaction, 64) ? { transaction: settlement.transaction } : {}),
          retry: 'Do not create another payment authorization; reconcile this payment.',
        });
        return instructionsResponse(settlement.response);
      }
      if (!validBase58Bytes(settlement.transaction, 64) ||
          settlement.network !== config.network ||
          settlement.payer !== proof.payer ||
          (settlement.amount && settlement.amount !== X402_AMOUNT)) {
        await finish('pending', pendingDetails(settlement, 'invalid_settlement_receipt'));
        return errorResponse(503, 'invalid_settlement_receipt');
      }
      await finish('settled', { transaction: settlement.transaction, payer: settlement.payer, network: settlement.network });
      const headers = x402ResponseHeaders(response.headers);
      headers.delete('Content-Length');
      headers.delete('Content-Encoding');
      headers.delete('Transfer-Encoding');
      headers.delete('PAYMENT-REQUIRED');
      headers.delete('PAYMENT-RESPONSE');
      headers.delete('EXTENSION-RESPONSES');
      for (const [name, value] of Object.entries(settlement.headers || {})) headers.set(name, value);
      const bazaarOutcome = bazaarOutcomeHeader(settlement);
      if (bazaarOutcome) headers.set('EXTENSION-RESPONSES', bazaarOutcome);
      headers.set('X-Content-SHA256', hash(bytes));
      if (delivery) headers.set('X-X402-Recovery-Until', delivery.expiresAt);
      return new Response(bytes, { status: response.status, headers });
    } finally {
      permit?.release?.();
    }
  };
}
