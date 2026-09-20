/** Execute the actual migration, monetary transitions and privilege boundaries.
 * PGlite queues one backend: these tests do not establish hosted DB throughput. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = new URL('../supabase/migrations/20260920184816_edgar_hosted_ai_billing.sql', import.meta.url);
const user = () => randomUUID();
const purchase = (user_id, overrides = {}) => ({ user_id, checkout_id: `cs_live_${randomUUID().replaceAll('-', '')}`,
  payment_intent_id: `pi_${randomUUID().replaceAll('-', '')}`, event_id: `evt_${randomUUID().replaceAll('-', '')}`,
  amount_total: 1000, amount_subtotal: 1000, currency: 'usd', credits: 100, consent_version: '2026-09-20', livemode: true,
  created_at: new Date().toISOString(), ...overrides });
async function role(db, name, fn) { await db.exec(`set role ${name}`); try { return await fn(); } finally { await db.exec('reset role'); } }
async function rpc(db, action, payload) { return role(db, 'service_role', async () => (await db.query('select public.edgar_billing_operation($1,$2::jsonb) value', [action, JSON.stringify(payload)])).rows[0].value); }
const status = (db, user_id) => rpc(db, 'status', { user_id });
const reserve = (db, user_id, request_id = randomUUID()) => rpc(db, 'reserve', { user_id, request_id, cost_microdollars: 40000 });
const finalize = (db, user_id, request_id, success) => rpc(db, 'finalize', { user_id, request_id, success });
const adjust = (db, p, refunded_amount, disputed = false, event_id = `evt_${randomUUID().replaceAll('-', '')}`, dispute_status = disputed ? 'pending' : 'none', dispute_id = disputed ? `dp_${p.payment_intent_id}` : null) => rpc(db, 'adjust_payment', { payment_intent_id: p.payment_intent_id, event_id, refunded_amount, dispute_id, dispute_status });
const control = async db => (await db.query('select * from edgar_billing.control')).rows[0];
async function reset(db) {
  await db.exec('truncate edgar_billing.accounts,edgar_billing.payments,edgar_billing.events,edgar_billing.reservations,edgar_billing.budget_periods,edgar_billing.ledger restart identity cascade; update edgar_billing.control set funded_microdollars=0,reserved_microdollars=0,daily_limit_microdollars=100000000,monthly_limit_microdollars=2000000000;');
}
async function audit(db) {
  const mismatch = await db.query('select a.user_id from edgar_billing.accounts a left join edgar_billing.ledger l using(user_id) group by a.user_id,a.balance having a.balance<>coalesce(sum(l.credit_delta),0)');
  assert.equal(mismatch.rows.length, 0, 'every balance change must have an auditable ledger entry');
}
async function ageRequests(db, interval = '2 minutes') {
  await db.exec(`update edgar_billing.reservations set created_at=statement_timestamp()-interval '${interval}',expires_at=statement_timestamp()-interval '${interval}'+interval '120 seconds'`);
}

test('hosted billing SQL protects real money, credits, durable budgets and browser isolation', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public to service_role;');
  await db.exec(await readFile(migration, 'utf8'));
  await t.test('RPC is invoker with fixed search path; browser roles cannot call or read; server cannot raise spending ceilings', async () => {
    const fn = (await db.query("select prosecdef,proconfig from pg_proc where proname='edgar_billing_operation'")).rows[0];
    assert.equal(fn.prosecdef, false); assert.deepEqual(fn.proconfig, ['search_path=pg_catalog']);
    const tables = (await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='edgar_billing' and c.relkind='r'")).rows;
    assert.equal(tables.length, 8); assert.ok(tables.every(row => row.relrowsecurity));
    for (const r of ['anon', 'authenticated']) await role(db, r, async () => {
      await assert.rejects(db.query("select public.edgar_billing_operation('status',$1)", [JSON.stringify({ user_id: user() })]), /permission denied/);
      for (const table of tables) await assert.rejects(db.query(`select * from edgar_billing.${table.relname}`), /permission denied/);
    });
    await role(db, 'service_role', async () => {
      await assert.rejects(db.exec('update edgar_billing.control set daily_limit_microdollars=100000000'), /permission denied/);
      await assert.rejects(db.exec('delete from edgar_billing.ledger'), /permission denied/);
    });
  });
  await t.test('only exact paid live product can create credits; unknown input and test payments fail closed', async () => {
    const id = user(), good = purchase(id);
    for (const patch of [{ credits: 101 }, { credits: null }, { amount_subtotal: 900 }, { amount_total: 999 }, { amount_total: '1000' },
      { livemode: false }, { consent_version: 'old' }, { currency: 'eur' }, { user_id: null }, { user_id: '00000000-0000-0000-0000-000000000000' },
      { checkout_id: 'other' }, { created_at: 'nonsense' }, { created_at: '2099-01-01T00:00:00Z' }, { prompt: 'never store this' }]) {
      await assert.rejects(rpc(db, 'fulfill', { ...good, ...patch }));
    }
    await assert.rejects(rpc(db, 'admin_grant', { user_id: id }));
    assert.equal((await status(db, id)).balance, 0);
    assert.equal((await reserve(db, id)).allowed, false);
    assert.equal((await control(db)).funded_microdollars, 0);
  });
  await t.test('fulfillment is idempotent by Stripe event, checkout AND payment identity; user-scoped history excludes payment identifiers', async () => {
    await reset(db); const id = user(), other = user(), p = purchase(id, { amount_total: 1080 });
    assert.equal((await rpc(db, 'fulfill', p)).remaining, 100);
    assert.equal((await rpc(db, 'fulfill', p)).duplicate, true);
    assert.equal((await rpc(db, 'fulfill', { ...p, event_id: 'evt_second' })).duplicate, true);
    await assert.rejects(rpc(db, 'fulfill', { ...p, user_id: other }), /billing_event_conflict/);
    await assert.rejects(rpc(db, 'fulfill', { ...p, event_id: 'evt_third', user_id: other }), /billing_payment_conflict/);
    await assert.rejects(rpc(db, 'fulfill', { ...p, event_id: 'evt_fourth', payment_intent_id: 'pi_other' }), /unique constraint/);
    const own = await status(db, id); assert.equal(own.remaining, 100); assert.equal(own.purchases.length, 1);
    assert.equal(own.purchases[0].amount_total, 1080); assert.equal(own.purchases[0].payment_intent_id, undefined);
    assert.equal((await status(db, other)).purchases.length, 0);
    assert.equal((await control(db)).funded_microdollars, 6000000, 'tax does not fund model spending');
    await audit(db);
  });
  await t.test('reserve and finalize never double spend or double restore; duplicates cannot call the provider again', async () => {
    await reset(db); const id = user(), other = user(); await rpc(db, 'fulfill', purchase(id));
    const first = await reserve(db, id); assert.equal(first.allowed, true); assert.equal(first.remaining, 99);
    assert.equal((await reserve(db, id, first.request_id)).code, 'request_already_used');
    assert.equal((await reserve(db, id)).code, 'account_busy');
    assert.equal((await finalize(db, other, first.request_id, false)).code, 'request_not_found');
    assert.equal((await finalize(db, id, first.request_id, true)).committed, true);
    assert.equal((await finalize(db, id, first.request_id, false)).committed, true);
    assert.equal((await status(db, id)).balance, 99);
    const failed = await reserve(db, id); await finalize(db, id, failed.request_id, false); await finalize(db, id, failed.request_id, false);
    assert.equal((await finalize(db, id, failed.request_id, true)).committed, false);
    assert.equal((await status(db, id)).balance, 99);
    assert.equal((await control(db)).reserved_microdollars, 80000, 'failed response retains conservative provider spend');
    await audit(db);
  });
  await t.test('expired leases restore once with audit, and late success cannot charge restored credit', async () => {
    await reset(db); const id = user(); await rpc(db, 'fulfill', purchase(id)); const r = await reserve(db, id);
    await db.exec("update edgar_billing.reservations set created_at='2026-01-01T00:00:00Z',expires_at='2026-01-01T00:02:00Z'");
    assert.equal((await status(db, id)).balance, 100); assert.equal((await status(db, id)).balance, 100);
    const late = await finalize(db, id, r.request_id, true); assert.equal(late.code, 'expired'); assert.equal(late.committed, false);
    assert.equal((await reserve(db, id, r.request_id)).allowed, false);
    assert.equal((await control(db)).reserved_microdollars, 40000); await audit(db);
  });
  await t.test('refunds round revoked units upward, never decrease, and dispute reversal cannot mint credits', async () => {
    await reset(db); const id = user(), p = purchase(id, { amount_total: 1080 }); await rpc(db, 'fulfill', p);
    await adjust(db, p, 1); assert.equal((await status(db, id)).balance, 99); await adjust(db, p, 0);
    assert.equal((await status(db, id)).balance, 99); await adjust(db, p, 540);
    assert.equal((await status(db, id)).balance, 50); assert.equal((await control(db)).funded_microdollars, 3000000);
    const r = await reserve(db, id); await finalize(db, id, r.request_id, true);
    await adjust(db, p, 540, true); assert.equal((await status(db, id)).balance, -1);
    await adjust(db, p, 0, false); assert.equal((await status(db, id)).balance, -1);
    assert.equal((await reserve(db, id)).code, 'credits_required'); assert.equal((await control(db)).funded_microdollars, 0);
    assert.equal((await control(db)).reserved_microdollars, 40000); await audit(db);
  });
  await t.test('out-of-order full refunds and disputes persist before fulfillment and never create spendable credits', async () => {
    await reset(db);
    for (const disputed of [false, true]) {
      const id = user(), p = purchase(id); await adjust(db, p, disputed ? 0 : 1000, disputed, `evt_early_${disputed}`);
      assert.equal((await status(db, id)).balance, 0); const result = await rpc(db, 'fulfill', p);
      assert.equal(result.remaining, 0); assert.equal((await reserve(db, id)).allowed, false);
      await adjust(db, p, 0, false); assert.equal((await status(db, id)).balance, 0);
    }
    assert.equal((await control(db)).funded_microdollars, 0); await audit(db);
  });
  await t.test('won disputes restore original entitlement net of refunds and consumption; terminal states fence old pending events', async () => {
    await reset(db); const id = user(), p = purchase(id); await rpc(db, 'fulfill', p);
    const r = await reserve(db, id); await finalize(db, id, r.request_id, true);
    const pending = { payment_intent_id: p.payment_intent_id, event_id: 'evt_dispute_pending', refunded_amount: 0, dispute_id: 'du_first', dispute_status: 'pending' };
    await rpc(db, 'adjust_payment', pending); await rpc(db, 'adjust_payment', pending);
    assert.equal((await status(db, id)).balance, -1);
    await adjust(db, p, 200);
    const won = { ...pending, event_id: 'evt_dispute_won', refunded_amount: 200, dispute_status: 'won' };
    await rpc(db, 'adjust_payment', won); await rpc(db, 'adjust_payment', won);
    assert.equal((await status(db, id)).balance, 79); assert.equal((await control(db)).funded_microdollars, 4800000);
    await rpc(db, 'adjust_payment', { ...pending, event_id: 'evt_old_pending_late' });
    assert.equal((await status(db, id)).balance, 79);
    const account = (await db.query('select * from edgar_billing.accounts where user_id=$1', [id])).rows[0];
    assert.equal(account.funded_microdollars, 4800000); assert.equal(account.reserved_microdollars, 40000);
    await assert.rejects(rpc(db, 'adjust_payment', { ...won, event_id: 'evt_conflicting_terminal', dispute_status: 'lost' }), /billing_dispute_conflict/);
    await audit(db);
  });
  await t.test('multiple disputes remain revoked until each resolves; a lost dispute cannot be cleared by refund snapshots', async () => {
    await reset(db); const id = user(), p = purchase(id); await rpc(db, 'fulfill', p);
    await adjust(db, p, 0, true, 'evt_a', 'pending', 'dp_a');
    await adjust(db, p, 0, true, 'evt_b', 'pending', 'du_b');
    await adjust(db, p, 0, true, 'evt_a_won', 'won', 'dp_a'); assert.equal((await status(db, id)).balance, 0);
    await adjust(db, p, 0, true, 'evt_b_lost', 'lost', 'du_b'); await adjust(db, p, 0);
    assert.equal((await status(db, id)).balance, 0); assert.equal((await control(db)).funded_microdollars, 0);
    await adjust(db, p, 0, true, 'evt_b_late_pending', 'pending', 'du_b'); assert.equal((await status(db, id)).balance, 0);
    await audit(db);
  });
  await t.test('resolved-before-purchase dispute snapshots and replayed refund events cannot overgrant', async () => {
    await reset(db); const id = user(), p = purchase(id);
    await adjust(db, p, 10, true, 'evt_first_won', 'won', 'du_prepaid');
    await adjust(db, p, 0, true, 'evt_first_pending_delayed', 'pending', 'du_prepaid');
    assert.equal((await rpc(db, 'fulfill', p)).balance, 99);
    const refund = { payment_intent_id: p.payment_intent_id, event_id: 'evt_refund', refunded_amount: 500, dispute_id: null, dispute_status: 'none' };
    await rpc(db, 'adjust_payment', refund); await rpc(db, 'adjust_payment', refund);
    assert.equal((await status(db, id)).balance, 50);
    await assert.rejects(rpc(db, 'adjust_payment', { ...refund, refunded_amount: 0 }), /billing_event_conflict/);
    assert.equal((await status(db, id)).balance, 50); await audit(db);
  });
  await t.test('queued overlapping account/global reservations respect one per account and eight global slots', async () => {
    await reset(db); const ids = Array.from({ length: 10 }, user);
    for (const id of ids) await rpc(db, 'fulfill', purchase(id));
    // Queue queries under one role; avoid overlapping SET ROLE/RESET ROLE helpers.
    const results = await role(db, 'service_role', () => Promise.all(ids.map(user_id => db.query("select public.edgar_billing_operation('reserve',$1::jsonb) value", [JSON.stringify({ user_id, request_id: randomUUID() })]))));
    assert.equal(results.filter(r => r.rows[0].value.allowed).length, 8);
    assert.equal(results.filter(r => r.rows[0].value.code === 'service_busy').length, 2);
    assert.equal((await control(db)).reserved_microdollars, 320000); await audit(db);
  });
  await t.test('five requests/minute and 100/day are durable across new request IDs and failure restores', async () => {
    await reset(db); const id = user(); await rpc(db, 'fulfill', purchase(id));
    for (let n = 0; n < 5; n++) { const r = await reserve(db, id); assert.equal(r.allowed, true); await finalize(db, id, r.request_id, false); }
    assert.equal((await reserve(db, id)).code, 'rate_limited');
    for (let n = 5; n < 100; n++) { await ageRequests(db); const r = await reserve(db, id); assert.equal(r.allowed, true); await finalize(db, id, r.request_id, false); }
    await ageRequests(db); assert.equal((await reserve(db, id)).code, 'daily_rate_limited'); assert.equal((await status(db, id)).balance, 100); await audit(db);
  });
  await t.test('only receipts fund lifetime model spend; failures, refunds and time rollover cannot reset the budget', async () => {
    await reset(db); const id = user(); await rpc(db, 'fulfill', purchase(id));
    for (let n = 0; n < 150; n++) { await ageRequests(db, '25 hours'); const r = await reserve(db, id); assert.equal(r.allowed, true); await finalize(db, id, r.request_id, false); }
    await ageRequests(db, '25 hours'); assert.equal((await reserve(db, id)).code, 'account_budget_exhausted');
    assert.equal((await status(db, id)).balance, 100); assert.equal((await control(db)).reserved_microdollars, 6000000);
    const other = user(); await rpc(db, 'fulfill', purchase(other));
    assert.equal((await reserve(db, other)).allowed, true, 'failed retries cannot consume a different customer\'s receipts');
    assert.equal((await reserve(db, id)).code, 'account_budget_exhausted');
    await rpc(db, 'fulfill', purchase(id)); assert.equal((await reserve(db, id)).allowed, true); await audit(db);
  });
  await t.test('global day and month ceilings may be lowered but never exceeded by a reservation', async () => {
    for (const period of ['daily', 'monthly']) {
      await reset(db); const id = user(); await rpc(db, 'fulfill', purchase(id));
      await db.exec(`update edgar_billing.control set ${period}_limit_microdollars=40000`);
      const r = await reserve(db, id); assert.equal(r.allowed, true); await finalize(db, id, r.request_id, false);
      assert.equal((await reserve(db, id)).code, 'service_budget_exhausted');
      await assert.rejects(db.exec(`update edgar_billing.control set ${period}_limit_microdollars=999999999999`), /check constraint/);
      await audit(db);
    }
  });
});
