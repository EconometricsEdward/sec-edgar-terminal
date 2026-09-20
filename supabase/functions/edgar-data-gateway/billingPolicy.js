/** Billing is reachable only through the existing production OIDC workload gate.
 * End-user identity and Stripe signatures are verified by the Next.js server. */
export const BILLING_RPC_PARAMETERS = Object.freeze({ edgar_billing_operation: ['p_action', 'p_payload'] });
const UUID = /^(?!00000000-0000-0000-0000-000000000000$)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const stripeId = (value, prefix) => typeof value === 'string' && value.length <= 255 && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value);
const fields = Object.freeze({
  status: ['user_id'],
  fulfill: ['user_id', 'checkout_id', 'payment_intent_id', 'event_id', 'amount_total', 'amount_subtotal', 'currency', 'credits', 'consent_version', 'livemode', 'created_at'],
  adjust_payment: ['payment_intent_id', 'event_id', 'refunded_amount', 'dispute_id', 'dispute_status'],
  reserve: ['user_id', 'request_id', 'cost_microdollars'],
  finalize: ['user_id', 'request_id', 'success'],
});
export function validBillingRpc(params, nowMs = Date.now()) {
  const action = params?.p_action, value = params?.p_payload;
  if (!Object.hasOwn(fields, action) || !object(value)
    || Object.keys(value).some(key => !fields[action].includes(key))
    || fields[action].some(key => key !== 'cost_microdollars' && !Object.hasOwn(value, key))) return false;
  if (Object.hasOwn(value, 'user_id') && (typeof value.user_id !== 'string' || !UUID.test(value.user_id))) return false;
  if (Object.hasOwn(value, 'request_id') && (typeof value.request_id !== 'string' || !UUID.test(value.request_id))) return false;
  if (action === 'fulfill') return stripeId(value.checkout_id, 'cs') && stripeId(value.payment_intent_id, 'pi') && stripeId(value.event_id, 'evt')
    && value.amount_subtotal === 1000 && integer(value.amount_total, 1000, 100000) && value.currency === 'usd' && value.credits === 100
    && value.consent_version === '2026-09-20' && value.livemode === true
    && typeof value.created_at === 'string' && value.created_at.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value.created_at)
    && Number.isFinite(Date.parse(value.created_at)) && Date.parse(value.created_at) <= nowMs + 60000;
  if (action === 'adjust_payment') return stripeId(value.payment_intent_id, 'pi') && stripeId(value.event_id, 'evt')
    && integer(value.refunded_amount, 0, 100000000)
    && (value.dispute_status === 'none' && value.dispute_id === null
      || ['pending', 'won', 'lost'].includes(value.dispute_status) && stripeId(value.dispute_id, 'd[pu]'));
  if (action === 'reserve') return !Object.hasOwn(value, 'cost_microdollars') || value.cost_microdollars === 40000;
  if (action === 'finalize') return typeof value.success === 'boolean';
  return true;
}
