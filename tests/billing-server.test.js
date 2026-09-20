import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { getBillingConfig, BILLING_PACK } from '../src/utils/billingConfig.js';
import { createBillingStore } from '../src/utils/billingStore.js';
import { handleBillingCheckout, handleBillingStatus, handleBillingReconcile, handleBillingWebhook, reservePaidChatUsage } from '../src/utils/billingServer.js';
import { validBillingRpc } from '../supabase/functions/edgar-data-gateway/billingPolicy.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://secedgarterminal.com';
const env = { VERCEL_ENV: 'production', VERCEL: '1', BILLING_ENABLED: 'true', BILLING_AUTH_READY: 'true',
  BILLING_MERCHANT_READY: 'true', BILLING_TAX_READY: 'true', BILLING_SELLER_NAME: 'Fixture Merchant',
  BILLING_SUPPORT_EMAIL: 'support@example.com', STRIPE_SECRET_KEY: 'sk_live_fixture123', STRIPE_PRICE_ID: 'price_fixture123',
  STRIPE_WEBHOOK_SECRET: 'whsec_fixture123', BILLING_TAX_MODE: 'automatic' };
const consent = { termsAccepted: true, termsVersion: '2026-09-20', requestId: REQUEST };
function request(path, body, extras = {}) {
  return new Request(`${ORIGIN}/api/billing/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: ORIGIN, Authorization: 'Bearer fixtureaccesstoken123', 'Content-Type': 'application/json', ...extras },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function fixture() {
  const calls = [], created = [], payments = new Map(), events = new Map();
  let balance = 0;
  const price = { id: env.STRIPE_PRICE_ID, active: true, livemode: true, type: 'one_time', recurring: null,
    currency: 'usd', unit_amount: 1000, billing_scheme: 'per_unit', transform_quantity: null, custom_unit_amount: null, tax_behavior: 'exclusive' };
  const metadata = { product: BILLING_PACK.id, user_id: USER, credits: '100', price_id: env.STRIPE_PRICE_ID,
    terms_version: '2026-09-20', terms_accepted: 'true', tax_mode: 'automatic' };
  const session = { id: 'cs_live_fixture12345', mode: 'payment', livemode: true, metadata, client_reference_id: USER,
    payment_status: 'paid', status: 'complete', line_items: { has_more: false, data: [{ quantity: 1, price }] },
    currency: 'usd', amount_subtotal: 1000, amount_total: 1070, total_details: { amount_discount: 0, amount_tax: 70, amount_shipping: 0 }, automatic_tax: { enabled: true, status: 'complete' },
    consent: { terms_of_service: 'accepted' }, payment_intent: 'pi_fixture123', customer_details: { address: { country: 'US' } },
    created: Math.floor(Date.now() / 1000) - 60 };
  const charge = { id: 'ch_fixture123', payment_intent: 'pi_fixture123', livemode: true, paid: true, currency: 'usd',
    amount_refunded: 0, amount: 1070, disputed: false, metadata };
  const dispute = { id: 'du_fixture123', charge: charge.id, livemode: true, currency: 'usd', status: 'under_review' };
  const stripe = { prices: { retrieve: async () => price }, checkout: { sessions: {
    create: async (data, options) => { created.push({ data, options }); return { id: session.id, url: 'https://checkout.stripe.com/c/pay/fixture' }; },
    retrieve: async () => structuredClone(session), listLineItems: async () => structuredClone(session.line_items),
  } }, paymentIntents: { retrieve: async () => ({ id: 'pi_fixture123', livemode: true, status: 'succeeded', latest_charge: structuredClone(charge) }) },
  charges: { retrieve: async () => structuredClone(charge) }, refunds: { create: async (data, options) => { created.push({ refund: data, options }); return { status: 'succeeded' }; } },
  disputes: { retrieve: async () => structuredClone(dispute), list: async () => ({ data: [structuredClone(dispute)], has_more: false }) },
  webhooks: new Stripe('sk_test_fixture').webhooks };
  const store = { operation: async (action, payload) => {
    assert.equal(validBillingRpc({ p_action: action, p_payload: payload }), true, `gateway rejected ${action}: ${JSON.stringify(payload)}`);
    calls.push({ action, payload });
    if (action === 'status') return { balance, remaining: Math.max(0, balance), purchases: [] };
    if (action === 'reserve') return { allowed: true, remaining: 99, request_id: payload.request_id };
    if (action === 'finalize') return { ok: true, committed: payload.success, remaining: 99 };
    if (action === 'adjust_payment') {
      const existing = events.get(payload.event_id);
      if (existing) assert.deepEqual(existing, payload, 'conflicting idempotency payload');
      events.set(payload.event_id, structuredClone(payload));
      return { ok: true, duplicate: !!existing };
    }
    if (action === 'fulfill') {
      const duplicate = payments.has(payload.payment_intent_id);
      if (!duplicate) { balance += 100; payments.set(payload.payment_intent_id, payload); }
      return { ok: true, duplicate, remaining: balance };
    }
    throw new Error('unexpected action');
  } };
  const user = { id: USER, email: 'user@example.com', email_confirmed_at: new Date().toISOString(), user_metadata: { id: OTHER, credits: 100000 } };
  const deps = { env, stripe, store, createAuth: () => ({ auth: { getUser: async () => ({ data: { user } }) } }) };
  return { deps, calls, created, session, charge, dispute, price, user };
}
function webhook(f, type = 'checkout.session.completed', object = f.session, eventId = 'evt_fixture123') {
  const payload = JSON.stringify({ id: eventId, type, livemode: true, data: { object } });
  const signature = f.deps.stripe.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET });
  return new Request(`${ORIGIN}/api/billing/webhook`, { method: 'POST', headers: { 'stripe-signature': signature }, body: payload });
}

test('billing configuration fails closed and never exposes a privileged Supabase key', () => {
  assert.equal(getBillingConfig({}).configured, false);
  assert.equal(getBillingConfig(env).configured, true);
  for (const key of ['BILLING_ENABLED', 'BILLING_AUTH_READY', 'BILLING_MERCHANT_READY', 'BILLING_TAX_READY', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'BILLING_SELLER_NAME', 'BILLING_SUPPORT_EMAIL']) {
    assert.equal(getBillingConfig({ ...env, [key]: '' }).configured, false, key);
  }
  assert.equal(getBillingConfig({ ...env, VERCEL_ENV: 'preview' }).configured, false);
  assert.equal(getBillingConfig({ ...env, STRIPE_SECRET_KEY: 'sk_test_fixture123' }).configured, false);
  assert.equal(getBillingConfig({ ...env, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_sensitive' }).auth, null);
});

test('preview and local service credentials cannot write the production billing ledger', async () => {
  let called = false;
  for (const testEnv of [{ ...env, VERCEL_ENV: 'preview' }, { NODE_ENV: 'test', BILLING_LOCAL_TEST_MODE: 'true',
    SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'secret' }]) {
    const store = createBillingStore({ env: testEnv, fetchImpl: async () => { called = true; } });
    await assert.rejects(store.operation('status', { user_id: USER }));
  }
  assert.equal(called, false);
});

test('anonymous status exposes public setup without treating signup as ready', async () => {
  const response = await handleBillingStatus(new Request(`${ORIGIN}/api/billing/status`), { env: {} });
  const state = await response.json();
  assert.equal(response.status, 200); assert.equal(state.auth, null); assert.equal(state.user, null);
  assert.equal(state.checkoutAvailable, false); assert.equal(state.pack.priceCents, 1000);
  assert.equal(response.headers.get('cache-control').includes('no-store'), true);
});

test('checkout rejects cross-origin, anonymous, unconfirmed email and client-set prices', async () => {
  const f = fixture();
  assert.equal((await handleBillingCheckout(request('checkout', consent, { Origin: 'https://evil.example' }), f.deps)).status, 403);
  assert.equal((await handleBillingCheckout(request('checkout', consent, { Authorization: '' }), f.deps)).status, 401);
  assert.equal((await handleBillingCheckout(request('checkout', { ...consent, price: 1 }), f.deps)).status, 400);
  f.user.email_confirmed_at = null;
  assert.equal((await handleBillingCheckout(request('checkout', consent), f.deps)).status, 401);
  assert.equal(f.created.length, 0);
});

test('checkout fixes one-time price, quantity, terms, identity and idempotency server-side', async () => {
  const f = fixture();
  const response = await handleBillingCheckout(request('checkout', consent), f.deps);
  assert.equal(response.status, 200);
  const { data, options } = f.created[0];
  assert.equal(data.mode, 'payment'); assert.deepEqual(data.line_items, [{ price: env.STRIPE_PRICE_ID, quantity: 1 }]);
  assert.equal(data.metadata.user_id, USER); assert.equal(data.client_reference_id, USER);
  assert.equal(data.metadata.terms_accepted, 'true'); assert.equal(data.automatic_tax.enabled, true);
  assert.equal(data.adaptive_pricing.enabled, false); assert.equal(data.allow_promotion_codes, false);
  assert.equal(data.success_url, `${ORIGIN}/ai?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(options.idempotencyKey, `edgar-checkout-v1:${USER}:${REQUEST}`);
  await handleBillingCheckout(request('checkout', consent), f.deps);
  assert.deepEqual(f.created[1], f.created[0], 'retries must not add changing consent timestamps to Stripe parameters');
});

test('misconfigured Stripe prices are rejected before a Checkout Session is created', async () => {
  for (const mutation of [{ unit_amount: 1 }, { currency: 'eur' }, { type: 'recurring' }, { livemode: false }, { tax_behavior: 'inclusive' }]) {
    const f = fixture(); Object.assign(f.price, mutation);
    assert.equal((await handleBillingCheckout(request('checkout', consent), f.deps)).status, 503);
    assert.equal(f.created.length, 0);
  }
});

test('webhook signature rejects modified body and cannot mint any credits', async () => {
  const f = fixture();
  const signed = webhook(f);
  const altered = new Request(signed.url, { method: 'POST', headers: signed.headers, body: '{"modified":true}' });
  assert.equal((await handleBillingWebhook(altered, f.deps)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('valid webhook fulfillment is durable and duplicate delivery does not grant twice', async () => {
  const f = fixture();
  assert.equal((await handleBillingWebhook(webhook(f), f.deps)).status, 200);
  assert.equal((await handleBillingWebhook(webhook(f), f.deps)).status, 200);
  const status = await (await handleBillingStatus(request('status'), f.deps)).json();
  assert.equal(status.balance, 100);
  assert.equal(f.calls.find(c => c.action === 'fulfill').payload.user_id, USER);
});

test('unpaid session waits for payment and session amount tampering is rejected', async () => {
  const f = fixture(); f.session.payment_status = 'unpaid';
  assert.equal((await handleBillingWebhook(webhook(f), f.deps)).status, 200);
  assert.equal(f.calls.length, 0);
  f.session.payment_status = 'paid'; f.session.amount_subtotal = 1;
  assert.equal((await handleBillingWebhook(webhook(f), f.deps)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('payment totals must reconcile exactly to fixed pack price plus completed tax calculation', async () => {
  for (const mutate of [f => { f.session.total_details.amount_tax = 71; }, f => { f.session.total_details.amount_shipping = 1; },
    f => { f.session.automatic_tax.status = 'requires_location_inputs'; }, f => { f.session.automatic_tax.enabled = false; }]) {
    const f = fixture(); mutate(f);
    assert.equal((await handleBillingWebhook(webhook(f), f.deps)).status, 400);
    assert.equal(f.calls.length, 0);
  }
});

test('authenticated return reconciliation verifies owner and current Stripe payment before granting', async () => {
  const f = fixture(); f.session.metadata.user_id = OTHER;
  assert.equal((await handleBillingReconcile(request('reconcile', { sessionId: f.session.id }), f.deps)).status, 404);
  assert.equal(f.calls.length, 0);
  f.session.metadata.user_id = USER;
  const result = await (await handleBillingReconcile(request('reconcile', { sessionId: f.session.id }), f.deps)).json();
  assert.equal(result.fulfilled, true); assert.equal(result.remaining, 100);
  assert.match(f.calls.find(c => c.action === 'fulfill').payload.event_id, /^evt_edgar_[a-f0-9]{64}$/);
});

test('billing-country rejection refunds the full payment before any credits are granted', async () => {
  const f = fixture(); f.session.customer_details.address.country = 'CA';
  const result = await (await handleBillingReconcile(request('reconcile', { sessionId: f.session.id }), f.deps)).json();
  assert.equal(result.refunded, true); assert.equal(result.fulfilled, false); assert.equal(f.calls.length, 0);
  assert.equal(f.created[0].refund.payment_intent, f.session.payment_intent);
  assert.equal(f.created[0].options.idempotencyKey, `edgar-country-refund-v1:${f.session.payment_intent}`);
});

test('a pending country refund is described as initiated, including later reconciliation', async () => {
  const f = fixture(); f.session.customer_details.address.country = 'CA';
  f.deps.stripe.refunds.create = async () => ({ id: 're_fixture123', status: 'pending' });
  let result = await (await handleBillingReconcile(request('reconcile', { sessionId: f.session.id }), f.deps)).json();
  assert.equal(result.refundInitiated, true); assert.equal(result.refunded, false); assert.equal(result.refundStatus, 'pending');
  f.charge.amount_refunded = f.charge.amount;
  f.deps.stripe.refunds.list = async () => ({ data: [{ amount: f.charge.amount, status: 'pending' }], has_more: false });
  result = await (await handleBillingReconcile(request('reconcile', { sessionId: f.session.id }), f.deps)).json();
  assert.equal(result.refunded, false); assert.equal(result.refundStatus, 'pending');
});

test('failed refunds remain actionable and never silently acknowledge reimbursement', async () => {
  const f = fixture();
  const refund = { id: 're_fixture123', charge: f.charge.id, status: 'failed' };
  f.deps.stripe.refunds.retrieve = async () => refund;
  const response = await handleBillingWebhook(webhook(f, 'refund.failed', refund), f.deps);
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'BILLING_REFUND_REVIEW_REQUIRED');
  assert.equal(f.calls.length, 0);
});

test('refund events use current cumulative state and fresh snapshot IDs on reordered replays', async () => {
  const f = fixture(); f.charge.amount_refunded = 200;
  assert.equal((await handleBillingWebhook(webhook(f, 'charge.refunded', f.charge), f.deps)).status, 200);
  f.charge.amount_refunded = 400;
  assert.equal((await handleBillingWebhook(webhook(f, 'charge.refunded', f.charge), f.deps)).status, 200);
  const adjustments = f.calls.filter(c => c.action === 'adjust_payment');
  assert.deepEqual(adjustments.map(c => c.payload.refunded_amount), [200, 400]);
  assert.notEqual(adjustments[0].payload.event_id, adjustments[1].payload.event_id);
});

test('refund-before-fulfillment records adjustment first and repeated reconcile tolerates new refunds', async () => {
  const f = fixture(); f.charge.amount_refunded = 200;
  assert.equal((await handleBillingReconcile(request('reconcile', { sessionId: f.session.id }), f.deps)).status, 200);
  assert.deepEqual(f.calls.map(c => c.action), ['adjust_payment', 'fulfill']);
  f.charge.amount_refunded = 400;
  assert.equal((await handleBillingReconcile(request('reconcile', { sessionId: f.session.id }), f.deps)).status, 200);
});

test('old dispute events retrieve current resolved status; historical charge flag does not undo a win', async () => {
  const f = fixture(); f.charge.disputed = true; f.dispute.status = 'won';
  const historical = { ...f.dispute, status: 'needs_response' };
  assert.equal((await handleBillingWebhook(webhook(f, 'charge.dispute.created', historical), f.deps)).status, 200);
  const adjustment = f.calls.find(c => c.action === 'adjust_payment');
  assert.equal(adjustment.payload.dispute_status, 'won'); assert.equal(adjustment.payload.dispute_id, f.dispute.id);
  assert.equal((await handleBillingReconcile(request('reconcile', { sessionId: f.session.id }), f.deps)).status, 200);
  assert.equal(f.calls.filter(c => c.action === 'adjust_payment').every(c => c.payload.dispute_status === 'won'), true);
});

test('ledger outages make webhook retryable instead of acknowledging an unfulfilled payment', async () => {
  const f = fixture(); f.deps.store.operation = async () => { throw new Error('private credential must never escape'); };
  const response = await handleBillingWebhook(webhook(f), f.deps);
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /credential/);
});

test('paid chat cannot fall back to anonymous usage and maps durable ledger denials', async () => {
  const f = fixture();
  assert.equal((await reservePaidChatUsage(request('chat', {}), { env: {}, reservedMicrodollars: 40000 })).allowed, false);
  assert.equal((await reservePaidChatUsage(request('chat', {}, { Authorization: '' }), { ...f.deps, reservedMicrodollars: 40000 })).status, 401);
  f.deps.store.operation = async () => ({ allowed: false, code: 'credits_required', remaining: 0 });
  const denied = await reservePaidChatUsage(request('chat', {}), { ...f.deps, reservedMicrodollars: 40000 });
  assert.equal(denied.status, 402); assert.equal(denied.code, 'BILLING_CREDITS_REQUIRED');
});

test('paid chat finalizes once, independently of a cancelled HTTP signal', async () => {
  const f = fixture();
  const lease = await reservePaidChatUsage(request('chat', {}), { ...f.deps, reservedMicrodollars: 40000 });
  assert.equal(lease.allowed, true);
  const first = lease.finalize(true), second = lease.release();
  assert.equal(first, second); assert.equal((await first).committed, true);
  assert.equal(f.calls.filter(c => c.action === 'finalize').length, 1);
  assert.equal(f.calls.find(c => c.action === 'finalize').payload.success, true);
});

test('successful answer does not silently pass a failed credit commit', async () => {
  const f = fixture();
  const original = f.deps.store.operation;
  f.deps.store.operation = async (action, payload) => action === 'finalize' ? { ok: false, committed: false } : original(action, payload);
  const lease = await reservePaidChatUsage(request('chat', {}), { ...f.deps, reservedMicrodollars: 40000 });
  await assert.rejects(lease.finalize(true), /charged correctly/);
});
