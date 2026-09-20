import assert from 'node:assert/strict';
import test from 'node:test';
import { createGateway, TRUST } from '../supabase/functions/edgar-data-gateway/handler.js';
import { validBillingRpc } from '../supabase/functions/edgar-data-gateway/billingPolicy.js';
const URL_BASE = 'https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway';
const NOW = Date.parse('2026-09-20T18:00:00Z');
const USER = '2dd38600-28e1-4b8c-8387-8a350226bdab';
const REQUEST = 'ac9b8aaa-51ab-4aa1-bf5c-c12552b79d53';
const purchase = { user_id: USER, checkout_id: 'cs_live_abc', payment_intent_id: 'pi_abc', event_id: 'evt_abc',
  amount_total: 1080, amount_subtotal: 1000, currency: 'usd', credits: 100, consent_version: '2026-09-20', livemode: true,
  created_at: '2026-09-20T17:59:00Z' };
const reversal = { payment_intent_id: 'pi_abc', event_id: 'evt_refund', refunded_amount: 540, dispute_id: null, dispute_status: 'none' };
const claims = patch => ({ iss: TRUST.issuer, aud: TRUST.audience, sub: TRUST.subject, owner: TRUST.owner, owner_id: TRUST.ownerId,
  project: TRUST.project, project_id: TRUST.projectId, environment: 'production', iat: NOW / 1000 - 10, exp: NOW / 1000 + 7190, ...patch });
const request = (action, payload, params = {}, headers = {}) => new Request(`${URL_BASE}/rest/v1/rpc/edgar_billing_operation`, {
  method: 'POST', headers: { authorization: 'Bearer fixture.identity.token', 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ p_action: action, p_payload: payload, ...params }),
});
function setup(options = {}) {
  const calls = []; const config = { SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server_only_fixture_secret_value' };
  return { calls, gateway: createGateway({ now: () => NOW, verifyToken: async () => claims(), env: name => config[name],
    fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return Response.json({ ok: true }); }, ...options }) };
}
test('production gateway admits only bounded billing operations and strips namespace from the exact SQL signature', async () => {
  const { calls, gateway } = setup();
  for (const [action, payload] of [['status', { user_id: USER }], ['fulfill', purchase], ['adjust_payment', reversal],
    ['adjust_payment', { ...reversal, dispute_id: 'du_funds', dispute_status: 'won' }],
    ['adjust_payment', { ...reversal, dispute_id: 'dp_funds', dispute_status: 'pending' }],
    ['reserve', { user_id: USER, request_id: REQUEST, cost_microdollars: 40000 }],
    ['finalize', { user_id: USER, request_id: REQUEST, success: true }]]) {
    assert.equal((await gateway(request(action, payload, { p_namespace: 'production' }))).status, 200);
    assert.deepEqual(calls.at(-1).body, { p_action: action, p_payload: payload });
    assert.match(calls.at(-1).url, /\/rest\/v1\/rpc\/edgar_billing_operation$/);
  }
});
test('billing gate rejects browser JWTs and preview workloads before config or body access', async () => {
  for (const patch of [{ environment: 'preview' }, { sub: USER }, { project_id: 'some-other-project' }]) {
    const { calls, gateway } = setup({ verifyToken: async () => claims(patch), env: () => { throw new Error('Must not read credentials'); } });
    assert.equal((await gateway(request('status', { user_id: USER }))).status, 401); assert.equal(calls.length, 0);
  }
  const { calls, gateway } = setup();
  assert.equal((await gateway(request('status', { user_id: USER }, {}, { authorization: '' }))).status, 401); assert.equal(calls.length, 0);
});
test('billing policy rejects privilege expansion, arbitrary product grants, currencies, malformed identifiers and provider-budget bypass', async () => {
  const { calls, gateway } = setup();
  const cases = [
    ['grant', { user_id: USER }], ['status', { user_id: USER, user_metadata: { admin: true } }], ['status', { user_id: null }],
    ['status', { user_id: '00000000-0000-0000-0000-000000000000' }], ['status', { user_id: USER }, { p_namespace: 'preview' }],
    ['status', { user_id: USER }, { p_admin: true }], ['fulfill', { ...purchase, credits: 101 }],
    ['fulfill', { ...purchase, amount_subtotal: 500 }], ['fulfill', { ...purchase, amount_total: 999 }],
    ['fulfill', { ...purchase, amount_total: '1000' }], ['fulfill', { ...purchase, currency: 'eur' }],
    ['fulfill', { ...purchase, livemode: false }], ['fulfill', { ...purchase, consent_version: 'old' }],
    ['fulfill', { ...purchase, created_at: '2099-01-01T00:00:00Z' }], ['fulfill', { ...purchase, created_at: 'not-date' }],
    ['adjust_payment', { ...reversal, refunded_amount: -1 }], ['adjust_payment', { ...reversal, refunded_amount: 0.1 }],
    ['adjust_payment', { ...reversal, disputed: false }], ['adjust_payment', { ...reversal, dispute_status: 'won' }],
    ['adjust_payment', { ...reversal, dispute_id: 'du_funds' }], ['adjust_payment', { ...reversal, dispute_id: 'other', dispute_status: 'pending' }],
    ['reserve', { user_id: USER, request_id: REQUEST, cost_microdollars: 1 }],
    ['reserve', { user_id: USER, request_id: REQUEST, cost_microdollars: null }],
    ['reserve', { user_id: USER, request_id: REQUEST, cost_microdollars: 40001 }],
    ['finalize', { user_id: USER, request_id: REQUEST, success: 'true' }], ['finalize', { user_id: USER, request_id: 'other', success: false }],
  ];
  for (const [action, payload, params] of cases) assert.ok((await gateway(request(action, payload, params))).status >= 400, `${action} ${JSON.stringify(payload)}`);
  assert.equal(calls.length, 0);
  assert.equal(validBillingRpc({ p_action: 'toString', p_payload: {} }), false);
});
test('billing upstream errors are sanitized without leaking payment or credential details', async () => {
  const { gateway } = setup({ fetchImpl: async () => Response.json({ code: '23505', message: 'private Stripe payload and secret' }, { status: 409 }) });
  const response = await gateway(request('fulfill', purchase)); assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: 'upstream_failure' });
});
