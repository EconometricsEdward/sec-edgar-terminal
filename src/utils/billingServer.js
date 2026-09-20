import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { BILLING_PACK, BILLING_TERMS_VERSION, getBillingConfig } from './billingConfig.js';
import { createBillingStore } from './billingStore.js';

const HEADERS = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', Vary: 'Authorization, Origin' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^cs_(?:live|test)_[A-Za-z0-9]{8,220}$/;
const ID = value => typeof value === 'string' ? value : value?.id;
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const syntheticEvent = value => `evt_edgar_${createHash('sha256').update(value).digest('hex')}`;

class BillingError extends Error {
  constructor(status, code, message) { super(message); this.name = 'BillingError'; this.status = status; this.code = code; this.safeMessage = message; }
}
const fail = (status, code, message) => { throw new BillingError(status, code, message); };
const json = (value, status = 200) => Response.json(value, { status, headers: HEADERS });
function errorResponse(error) {
  if (!(error instanceof BillingError)) console.warn('edgar_billing_operation_failed');
  return json({ error: error?.safeMessage || 'Billing is temporarily unavailable. Please try again later.',
    code: error instanceof BillingError ? error.code : 'BILLING_UNAVAILABLE' }, error instanceof BillingError ? error.status : 503);
}
const depsFor = dependencies => {
  const env = dependencies?.env || process.env;
  const config = getBillingConfig(env);
  return { env, config, store: createBillingStore({ env }), createAuth: createClient,
    stripe: config.paymentsReady ? new Stripe(config.stripeSecret, { timeout: 12000, maxNetworkRetries: 1 }) : null,
    ...dependencies };
};

function assertOrigin(request, { config, env }) {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  const ownOrigin = new URL(request.url).origin;
  const forwarded = env.VERCEL === '1' && request.headers.get('x-forwarded-host') === new URL(config.origin).host
    && request.headers.get('x-forwarded-proto') === 'https';
  if (!origin || origin !== config.origin || (ownOrigin !== origin && !forwarded)
    || site && !['same-origin', 'same-site', 'none'].includes(site)) {
    fail(403, 'BILLING_ORIGIN_REJECTED', 'Open billing from EDGAR Terminal to continue.');
  }
}

async function readText(request, maxBytes) {
  if (Number(request.headers.get('content-length')) > maxBytes) fail(413, 'BILLING_REQUEST_TOO_LARGE', 'The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'BILLING_INVALID_REQUEST', 'The request is empty.');
  let timer, abort;
  const deadline = new Promise((_, reject) => {
    const stop = () => reject(new BillingError(408, 'BILLING_TIMEOUT', 'The request was interrupted. Please try again.'));
    timer = setTimeout(stop, 5000); abort = stop;
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) stop();
  });
  const chunks = []; let bytes = 0, reads = 0;
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength; reads++;
      if (bytes > maxBytes || reads > maxBytes) fail(413, 'BILLING_REQUEST_TOO_LARGE', 'The request is too large.');
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer); request.signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}

async function readBody(request, keys) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) fail(415, 'BILLING_INVALID_REQUEST', 'Use a JSON request.');
  let data;
  try { data = JSON.parse(await readText(request, 2048)); }
  catch (error) { if (error instanceof BillingError) throw error; fail(400, 'BILLING_INVALID_REQUEST', 'The request is invalid.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key)))
    fail(400, 'BILLING_INVALID_REQUEST', 'The request is invalid.');
  return data;
}

/** Verify the access token with Auth on every sensitive request. Never decode
 * user-controlled metadata as an account identity or payment entitlement. */
export async function verifiedBillingUser(request, deps, { optional = false } = {}) {
  const authorization = request.headers.get('authorization');
  if (!authorization && optional) return null;
  if (!deps.config.authReady) fail(503, 'BILLING_AUTH_UNAVAILABLE', 'Hosted AI account access is being prepared. Free research remains available.');
  const match = /^Bearer ([A-Za-z0-9._~-]{16,16384})$/.exec(authorization || '');
  if (!match) fail(401, 'BILLING_AUTH_REQUIRED', 'Sign in to use your hosted AI credits.');
  const auth = deps.createAuth(deps.config.auth.url, deps.config.auth.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(8000), cache: 'no-store', redirect: 'error' }) },
  });
  let result;
  try { result = await auth.auth.getUser(match[1]); }
  catch { fail(503, 'BILLING_AUTH_UNAVAILABLE', 'Account verification is temporarily unavailable. Please try again.'); }
  const user = result?.data?.user;
  if (result?.error || !user || !UUID.test(user.id) || !user.email || user.is_anonymous || !user.email_confirmed_at)
    fail(401, 'BILLING_AUTH_REQUIRED', 'Sign in with a verified email address to use hosted AI.');
  return { id: user.id, email: user.email };
}

function publicPurchase(purchase) {
  return { id: purchase.checkout_id, createdAt: purchase.created_at, amountCents: purchase.amount_total,
    subtotalCents: purchase.amount_subtotal, currency: purchase.currency, credits: purchase.credits,
    revokedCredits: purchase.revoked_credits, refundedAmountCents: purchase.refunded_amount,
    status: purchase.disputed ? 'disputed' : purchase.refunded_amount >= purchase.amount_total ? 'refunded'
      : purchase.refunded_amount > 0 ? 'partially_refunded' : 'paid' };
}

export async function handleBillingStatus(request, dependencies = {}) {
  const deps = depsFor(dependencies);
  try {
    const user = await verifiedBillingUser(request, deps, { optional: true });
    const state = user ? await deps.store.operation('status', { user_id: user.id }, { signal: request.signal }) : null;
    if (state && (!Number.isSafeInteger(state.balance) || !Array.isArray(state.purchases))) throw new Error('invalid_billing_status');
    return json({ configured: deps.config.configured, checkoutAvailable: deps.config.configured,
      authReady: deps.config.authReady, auth: deps.config.auth, user, balance: Math.max(0, state?.balance || 0),
      purchases: state?.purchases.map(publicPurchase) || [], pack: BILLING_PACK, termsVersion: BILLING_TERMS_VERSION,
      supportEmail: deps.config.supportEmail || null, sellerName: deps.config.sellerName || null });
  } catch (error) { return errorResponse(error); }
}

function assertPrice(price, config) {
  if (!price || price.id !== config.stripePrice || price.active !== true || price.livemode !== true || price.type !== 'one_time'
    || price.recurring || price.currency !== BILLING_PACK.currency || price.unit_amount !== BILLING_PACK.priceCents
    || price.billing_scheme !== 'per_unit' || price.transform_quantity || price.custom_unit_amount
    || (config.taxMode === 'automatic' && price.tax_behavior !== 'exclusive'))
    fail(503, 'BILLING_PRICE_UNAVAILABLE', 'Purchases are temporarily unavailable. No payment has been taken.');
}

export async function handleBillingCheckout(request, dependencies = {}) {
  const deps = depsFor(dependencies);
  try {
    assertOrigin(request, deps);
    if (!deps.config.configured) fail(503, 'BILLING_NOT_CONFIGURED', 'Hosted AI purchases are being prepared. Free research remains available.');
    const body = await readBody(request, ['termsAccepted', 'termsVersion', 'requestId']);
    if (body.termsAccepted !== true || body.termsVersion !== BILLING_TERMS_VERSION || !UUID.test(body.requestId))
      fail(400, 'BILLING_CONSENT_REQUIRED', 'Review and accept the current Hosted AI Terms before continuing.');
    const user = await verifiedBillingUser(request, deps);
    // Verify that the durable ledger is available BEFORE directing a customer
    // to payment. The balance itself never controls the amount charged.
    await deps.store.operation('status', { user_id: user.id }, { signal: request.signal });
    assertPrice(await deps.stripe.prices.retrieve(deps.config.stripePrice), deps.config);
    const metadata = { product: BILLING_PACK.id, user_id: user.id, credits: String(BILLING_PACK.credits),
      price_id: deps.config.stripePrice, terms_version: BILLING_TERMS_VERSION, terms_accepted: 'true', tax_mode: deps.config.taxMode };
    const session = await deps.stripe.checkout.sessions.create({
      mode: 'payment', line_items: [{ price: deps.config.stripePrice, quantity: 1 }],
      payment_method_types: ['card'], customer_email: user.email, client_reference_id: user.id,
      billing_address_collection: 'required', automatic_tax: { enabled: deps.config.taxMode === 'automatic' },
      adaptive_pricing: { enabled: false }, allow_promotion_codes: false,
      consent_collection: { terms_of_service: 'required' },
      custom_text: { terms_of_service_acceptance: { message: `I agree to the [Hosted AI Terms](${deps.config.origin}/terms). US customers only. $10 USD for 100 responses, plus applicable tax. No subscription or automatic refill.` } },
      metadata, payment_intent_data: { metadata, receipt_email: user.email },
      success_url: `${deps.config.origin}/ai?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${deps.config.origin}/ai?checkout=cancelled`,
    }, { idempotencyKey: `edgar-checkout-v1:${user.id}:${body.requestId}` });
    const destination = new URL(session.url);
    if (destination.origin !== 'https://checkout.stripe.com') throw new Error('invalid_checkout_destination');
    return json({ url: destination.href, sessionId: session.id });
  } catch (error) { return errorResponse(error); }
}

function sessionMetadataValid(session, config) {
  const metadata = session.metadata;
  return session.mode === 'payment' && session.livemode === true && metadata?.product === BILLING_PACK.id
    && UUID.test(metadata.user_id || '') && session.client_reference_id === metadata.user_id
    && metadata.credits === String(BILLING_PACK.credits) && metadata.price_id === config.stripePrice
    && metadata.terms_version === BILLING_TERMS_VERSION && metadata.terms_accepted === 'true'
    && ['automatic', 'reviewed_exempt'].includes(metadata.tax_mode);
}

async function currentCharge(paymentIntent, deps) {
  const intent = await deps.stripe.paymentIntents.retrieve(paymentIntent, { expand: ['latest_charge'] });
  const charge = intent.latest_charge;
  if (intent.livemode !== true || intent.status !== 'succeeded' || !charge || typeof charge !== 'object'
    || charge.livemode !== true || charge.paid !== true || charge.currency !== BILLING_PACK.currency
    || !safeInteger(charge.amount_refunded) || !safeInteger(charge.amount)) throw new Error('invalid_payment_charge');
  return charge;
}

function normalizeDispute(dispute, charge) {
  if (!/^d[pu]_[A-Za-z0-9]+$/.test(dispute?.id || '') || dispute.livemode !== true
    || ID(dispute.charge) !== charge.id || dispute.currency !== BILLING_PACK.currency) throw new Error('invalid_dispute');
  const status = ['won', 'warning_closed', 'prevented'].includes(dispute.status) ? 'won' : dispute.status === 'lost' ? 'lost'
    : ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review'].includes(dispute.status) ? 'pending' : null;
  if (!status) throw new Error('unknown_dispute_status');
  return { dispute_id: dispute.id, dispute_status: status };
}

async function applyAdjustment(charge, eventId, deps, disputeId = null) {
  const paymentIntent = ID(charge.payment_intent);
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntent || '') || !safeInteger(charge.amount_refunded)) throw new Error('invalid_charge');
  let disputes = [];
  if (disputeId) disputes = [normalizeDispute(await deps.stripe.disputes.retrieve(disputeId), charge)];
  else if (charge.disputed) {
    const current = await deps.stripe.disputes.list({ charge: charge.id, limit: 100 });
    if (current.has_more || !current.data?.length) throw new Error('incomplete_dispute_history');
    disputes = current.data.map(dispute => normalizeDispute(dispute, charge));
  }
  if (!disputes.length) disputes = [{ dispute_id: null, dispute_status: 'none' }];
  for (const dispute of disputes) {
    const result = await deps.store.operation('adjust_payment', { payment_intent_id: paymentIntent,
      event_id: syntheticEvent(`adjust:${eventId}:${paymentIntent}:${charge.amount_refunded}:${dispute.dispute_id}:${dispute.dispute_status}`),
      refunded_amount: charge.amount_refunded, ...dispute });
    if (result?.ok !== true) throw new Error('invalid_adjustment_ack');
  }
}

/** Called only after authenticated ownership or a valid Stripe signature.
 * Re-fetch Stripe's current state: a return URL or an old event is never proof
 * of payment, amount, customer identity, or remaining refundable value. */
async function fulfillSession(sessionId, eventId, deps, owner = null) {
  const session = await deps.stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
  if (owner && session.metadata?.user_id !== owner) fail(404, 'BILLING_ORDER_NOT_FOUND', 'This payment is not available for your account.');
  if (!sessionMetadataValid(session, deps.config)) fail(400, 'BILLING_INVALID_PAYMENT', 'This payment could not be matched to a hosted AI purchase.');
  if (session.payment_status !== 'paid' || session.status !== 'complete') return { fulfilled: false, pending: true };
  const lineItems = session.line_items || await deps.stripe.checkout.sessions.listLineItems(sessionId, { limit: 2 });
  const line = lineItems.data?.[0];
  if (lineItems.has_more || lineItems.data?.length !== 1 || line.quantity !== 1 || ID(line.price) !== deps.config.stripePrice
    || line.price?.unit_amount !== BILLING_PACK.priceCents || line.price?.currency !== BILLING_PACK.currency
    || line.price?.type !== 'one_time' || session.currency !== BILLING_PACK.currency
    || session.amount_subtotal !== BILLING_PACK.priceCents || !safeInteger(session.amount_total)
    || session.amount_total < BILLING_PACK.priceCents || session.amount_total > 100000 || session.total_details?.amount_discount !== 0
    || session.total_details?.amount_shipping !== 0 || !safeInteger(session.total_details?.amount_tax)
    || session.amount_total !== BILLING_PACK.priceCents + session.total_details.amount_tax
    || session.automatic_tax?.enabled !== (session.metadata.tax_mode === 'automatic')
    || session.metadata.tax_mode === 'automatic' && (session.automatic_tax.status !== 'complete' || line.price.tax_behavior !== 'exclusive')
    || session.metadata.tax_mode === 'reviewed_exempt' && session.total_details.amount_tax !== 0
    || session.consent?.terms_of_service !== 'accepted')
    fail(400, 'BILLING_INVALID_PAYMENT', 'This payment does not match the hosted AI credit pack.');
  const paymentIntent = ID(session.payment_intent);
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntent || '')) throw new Error('payment_intent_missing');
  const charge = await currentCharge(paymentIntent, deps);
  if (charge.amount !== session.amount_total || ID(charge.payment_intent) !== paymentIntent) throw new Error('payment_amount_mismatch');
  // Stripe Checkout collects a billing country but cannot restrict its allowed
  // values. Unsupported countries are refunded before granting any credits.
  if (session.customer_details?.address?.country !== 'US') {
    let refundStatus;
    if (charge.amount_refunded < charge.amount) {
      const refund = await deps.stripe.refunds.create({ payment_intent: paymentIntent,
        metadata: { edgar_reason: 'unsupported_billing_country' } }, { idempotencyKey: `edgar-country-refund-v1:${paymentIntent}` });
      if (!['succeeded', 'pending'].includes(refund.status)) {
        console.warn('edgar_billing_refund_requires_review', { refundId: refund.id });
        fail(503, 'BILLING_REFUND_REVIEW_REQUIRED', 'The payment refund needs support review. Contact the support address on this page.');
      }
      refundStatus = refund.status;
    } else {
      // amount_refunded can include an initiated refund. Confirm its actual
      // status rather than telling the customer that pending funds arrived.
      const refunds = await deps.stripe.refunds.list({ payment_intent: paymentIntent, limit: 100 });
      if (refunds.has_more || !refunds.data?.length) throw new Error('incomplete_refund_history');
      const succeeded = refunds.data.filter(refund => refund.status === 'succeeded').reduce((sum, refund) => sum + refund.amount, 0);
      const pending = refunds.data.filter(refund => refund.status === 'pending').reduce((sum, refund) => sum + refund.amount, 0);
      if (succeeded >= charge.amount) refundStatus = 'succeeded';
      else if (succeeded + pending >= charge.amount) refundStatus = 'pending';
      else {
        console.warn('edgar_billing_refund_requires_review', { paymentIntentId: paymentIntent });
        fail(503, 'BILLING_REFUND_REVIEW_REQUIRED', 'The payment refund needs support review. Contact the support address on this page.');
      }
    }
    return { fulfilled: false, refundInitiated: true, refundStatus, refunded: refundStatus === 'succeeded', code: 'BILLING_COUNTRY_UNAVAILABLE' };
  }
  // Record current cumulative reversals first. The SQL ledger retains these
  // even when a refund arrives before the corresponding fulfillment webhook.
  if (charge.amount_refunded > 0 || charge.disputed) await applyAdjustment(charge, eventId, deps);
  const result = await deps.store.operation('fulfill', {
    user_id: session.metadata.user_id, checkout_id: session.id, payment_intent_id: paymentIntent,
    event_id: eventId, amount_total: session.amount_total, amount_subtotal: session.amount_subtotal,
    currency: session.currency, credits: BILLING_PACK.credits, consent_version: session.metadata.terms_version,
    livemode: session.livemode, created_at: new Date(session.created * 1000).toISOString(),
  });
  if (result?.ok !== true || !safeInteger(result.remaining)) throw new Error('invalid_fulfillment_ack');
  return { fulfilled: true, remaining: result.remaining, duplicate: !!result.duplicate };
}

export async function handleBillingReconcile(request, dependencies = {}) {
  const deps = depsFor(dependencies);
  try {
    assertOrigin(request, deps);
    if (!deps.config.paymentsReady) fail(503, 'BILLING_NOT_CONFIGURED', 'Payment verification is temporarily unavailable.');
    const body = await readBody(request, ['sessionId']);
    if (!SESSION_ID.test(body.sessionId || '')) fail(400, 'BILLING_INVALID_REQUEST', 'The payment reference is invalid.');
    const user = await verifiedBillingUser(request, deps);
    return json(await fulfillSession(body.sessionId, syntheticEvent(`reconcile:${body.sessionId}`), deps, user.id));
  } catch (error) { return errorResponse(error); }
}

export async function handleBillingWebhook(request, dependencies = {}) {
  const deps = depsFor(dependencies);
  try {
    if (!deps.config.paymentsReady) fail(503, 'BILLING_NOT_CONFIGURED', 'Payment verification is unavailable.');
    const raw = await readText(request, 262144);
    const signature = request.headers.get('stripe-signature');
    let event;
    try { event = deps.stripe.webhooks.constructEvent(raw, signature, deps.config.webhookSecret); }
    catch { fail(400, 'BILLING_INVALID_SIGNATURE', 'The payment signature is invalid.'); }
    if (event.livemode !== true || !/^evt_[A-Za-z0-9]+$/.test(event.id || '')) fail(400, 'BILLING_INVALID_EVENT', 'The payment event is invalid.');
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      // Ignore unrelated products in the merchant account, including normal
      // payments created outside this application.
      if (event.data.object.metadata?.product === BILLING_PACK.id) await fulfillSession(event.data.object.id, event.id, deps);
    } else if (['charge.refunded', 'refund.created', 'refund.updated', 'refund.failed', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed'].includes(event.type)) {
      const object = event.data.object;
      const chargeId = event.type === 'charge.refunded' ? object.id : ID(object.charge);
      if (chargeId) {
        const charge = await deps.stripe.charges.retrieve(chargeId);
        if (charge.metadata?.product === BILLING_PACK.id) {
          if (charge.livemode !== true || charge.currency !== BILLING_PACK.currency) throw new Error('invalid_charge_event');
          if (event.type.startsWith('refund.')) {
            const refund = await deps.stripe.refunds.retrieve(object.id);
            if (['failed', 'canceled'].includes(refund.status)) {
              // Stripe retries plus this actionable operator log keep failed
              // reimbursement visible; support must resolve it with the buyer.
              console.warn('edgar_billing_refund_requires_review', { refundId: refund.id });
              fail(503, 'BILLING_REFUND_REVIEW_REQUIRED', 'The refund requires merchant review.');
            }
          }
          await applyAdjustment(charge, event.id, deps, event.type.startsWith('charge.dispute.') ? object.id : null);
        }
      }
    }
    return json({ received: true });
  } catch (error) {
    // Signature/invalid payment errors are nonretryable. Network/database
    // failures produce 503, so Stripe retries instead of losing a paid order.
    return errorResponse(error);
  }
}

const DENIALS = {
  credits_required: ['BILLING_CREDITS_REQUIRED', 402], account_busy: ['CHAT_BUSY', 429], service_busy: ['CHAT_BUSY', 429],
  daily_rate_limited: ['CHAT_DAILY_LIMIT', 429], service_budget_exhausted: ['CHAT_BUDGET_EXHAUSTED', 503],
  account_budget_exhausted: ['BILLING_ACCOUNT_REVIEW_REQUIRED', 503],
  insufficient_credits: ['BILLING_CREDITS_REQUIRED', 402], no_credits: ['BILLING_CREDITS_REQUIRED', 402],
  busy: ['CHAT_BUSY', 429], user_busy: ['CHAT_BUSY', 429], global_busy: ['CHAT_BUSY', 429],
  rate_limited: ['CHAT_RATE_LIMITED', 429], daily_limit: ['CHAT_DAILY_LIMIT', 429],
  budget_exhausted: ['CHAT_BUDGET_EXHAUSTED', 503], request_already_used: ['CHAT_BUSY', 409],
};

export async function reservePaidChatUsage(request, { reservedMicrodollars, signal, ...dependencies } = {}) {
  const deps = depsFor(dependencies);
  const unavailable = (code = 'BILLING_UNAVAILABLE', status = 503) => ({ allowed: false, code, status, retryAfter: status === 503 ? 30 : 0,
    remaining: 0, finalize: async () => ({ ok: true, committed: false }), release: async () => {} });
  try {
    // This gate is mandatory. Disabling sales or omitting configuration never
    // reverts the hosted provider endpoint to a free anonymous route.
    if (!deps.config.configured) return unavailable('BILLING_NOT_CONFIGURED');
    if (reservedMicrodollars !== 40000) return unavailable();
    const user = await verifiedBillingUser(request, deps);
    const requestId = randomUUID();
    const result = await deps.store.operation('reserve', { user_id: user.id, request_id: requestId,
      cost_microdollars: reservedMicrodollars }, { signal });
    if (result.allowed !== true) {
      const [code, status] = DENIALS[result.code] || ['BILLING_UNAVAILABLE', 503];
      return { ...unavailable(code, status), retryAfter: status === 429 ? 30 : status === 503 ? 60 : 0 };
    }
    if (result.request_id !== requestId || !safeInteger(result.remaining)) throw new Error('invalid_reservation_ack');
    let finalization;
    const finalize = success => finalization ||= (async () => {
      // Independent signal: client cancellation must still release its credit.
      const value = await deps.store.operation('finalize', { user_id: user.id, request_id: requestId, success: success === true });
      if (value?.ok !== true || success === true && value.committed !== true)
        fail(503, 'BILLING_FINALIZE_FAILED', 'The answer could not be charged correctly. Please check your balance and try again.');
      return value;
    })();
    return { allowed: true, code: 'CHAT_ALLOWED', status: 200, remaining: result.remaining, retryAfter: 0,
      finalize, release: () => finalize(false) };
  } catch (error) {
    return unavailable(error instanceof BillingError ? error.code : 'BILLING_UNAVAILABLE', error instanceof BillingError ? error.status : 503);
  }
}
