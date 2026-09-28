/** Exact production migration in isolated PostgreSQL/PGlite. This verifies SQL
 * guards and rollback, not hosted PostgREST retry behavior or concurrency. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const directory = new URL('../supabase/migrations/', import.meta.url);
const migration = await readFile(new URL('20260928042029_application_conflicts_no_retry.sql', directory), 'utf8');
const changedNames = [
  'bank_scope_call_operation', 'bank_scope_operation', 'edgar_activate_membership',
  'edgar_cache_put_fenced', 'edgar_fund_review_save', 'edgar_publish', 'edgar_stage_membership',
].sort();
const ns = 'production';
const rpc = async (db, name, types, args) => {
  await db.exec('set role service_role');
  try {
    return (await db.query(`select public.${name}(${types.map((type, i) => `$${i + 1}::${type}`).join(',')}) value`, args)).rows[0].value;
  } finally { await db.exec('reset role'); }
};
const bank = (db, operation, payload, name = 'bank_scope_operation') => rpc(db, name, ['text', 'jsonb'], [operation, payload]);
const definitions = async db => (await db.query(`
  select p.oid, p.proname, p.proowner, p.proacl, p.prosecdef, p.proconfig,
    p.provolatile, p.proparallel, p.proleakproof, p.proisstrict, p.prolang,
    pg_get_function_identity_arguments(p.oid) arguments, pg_get_functiondef(p.oid) definition
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind='f'
  order by p.oid`)).rows;

async function database() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema extensions; create extension pgcrypto with schema extensions;
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,created_at timestamptz default now(),unique(bucket_id,name));
      grant usage on schema extensions,storage,public to service_role;
      grant select on storage.objects to service_role;
      -- Inert metadata fixture only: no cron extension, background job or network.
      create schema cron;
      create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
    `);
    const prerequisites = [
      '20260913031639_edgar_staged_data_store.sql',
      '20260913073012_edgar_coverage_batch_reads_jobs.sql',
      '20260913154521_edgar_membership_registry.sql',
      '20260913171926_edgar_disposable_cache.sql',
      '20260913181102_edgar_fenced_disposable_cache.sql',
      '20260916175154_shared_fund_market_reviews.sql',
      '20260916181554_fund_review_revision_conflicts.sql',
      '20260916183951_fund_review_prepared_snapshots.sql',
      ...(await readdir(directory)).filter(name => /_(?:ffiec_bank|bankscope)/.test(name)).sort(),
    ];
    for (const name of prerequisites) await db.exec(await readFile(new URL(name, directory), 'utf8'));
    return db;
  } catch (error) { await db.close(); throw error; }
}

test('application conflicts use terminal HTTP 409 codes without changing privileges, fencing or rollback', async t => {
  const db = await database(); t.after(() => db.close());
  const before = await definitions(db);
  assert.deepEqual(before.filter(fn => fn.definition.includes("errcode='40001'")).map(fn => fn.proname).sort(), changedNames);
  await db.exec(migration);
  const after = await definitions(db);

  await t.test('only audited error-code literals change; identity, owners, ACLs and security settings are preserved', async () => {
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      const expected = { ...before[i], definition: before[i].definition.replaceAll("errcode='40001'", "errcode='PT409'") };
      assert.deepEqual(after[i], expected, before[i].proname);
    }
    assert.equal(after.some(fn => fn.definition.includes("errcode='40001'")), false);
    for (const fn of after.filter(row => changedNames.includes(row.proname))) {
      assert.equal(fn.prosecdef, false);
      assert.ok(fn.proconfig.some(setting => setting.startsWith('search_path=')));
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') allowed", [role, fn.oid])).rows[0].allowed, false);
      }
      assert.equal((await db.query("select has_function_privilege('service_role',$1::oid,'EXECUTE') allowed", [fn.oid])).rows[0].allowed, true);
    }
    await db.exec(migration);
    assert.deepEqual(await definitions(db), after, 'the exact migration is idempotent');
  });

  await t.test('stale canonical publications fail before changing heads, versions or source assets', async () => {
    const key = 'markets:tff:latest';
    const claim = await rpc(db, 'edgar_begin_write', ['text', 'text', 'text', 'uuid', 'integer'], [ns, 'cftc', key, randomUUID(), 120]);
    const state = async () => (await db.query(`select
      (select jsonb_agg(to_jsonb(h)) from public.edgar_dataset_heads h) heads,
      (select count(*)::integer from public.edgar_dataset_versions) versions,
      (select count(*)::integer from public.edgar_source_assets) assets`)).rows[0];
    const unchanged = await state();
    const publish = token => rpc(db, 'edgar_publish', ['text', 'text', 'text', 'jsonb', 'jsonb', 'boolean'], [ns, 'cftc', key, token, {}, true]);
    for (const invalid of [{ generation: claim.generation + 1, owner: claim.owner }, { generation: claim.generation, owner: randomUUID() }]) {
      await assert.rejects(publish(invalid), { code: 'PT409', message: 'stale_generation' });
      assert.deepEqual(await state(), unchanged);
    }
    await db.query("update public.edgar_dataset_heads set lease_until=clock_timestamp()-interval '1 second' where namespace=$1 and dataset='cftc' and resource_key=$2", [ns, key]);
    const expired = await state();
    await assert.rejects(publish({ generation: claim.generation, owner: claim.owner }), { code: 'PT409', message: 'stale_generation' });
    assert.deepEqual(await state(), expired);
  });

  await t.test('both BankScope operation layers reject expired owners without reserving calls or publishing data', async () => {
    const owner = randomUUID(); assert.equal((await bank(db, 'begin', { owner })).allowed, true);
    await db.exec("update edgar_private.bank_pilot_control set lease_until=clock_timestamp()-interval '1 second'");
    const state = async () => (await db.query(`select
      (select to_jsonb(c) from edgar_private.bank_pilot_control c) control,
      (select count(*)::integer from edgar_private.bank_peer_snapshots) snapshots,
      (select count(*)::integer from edgar_private.bank_call_reports) reports`)).rows[0];
    const unchanged = await state();
    for (const [name, method] of [['bank_scope_call_operation', 'RetrieveFacsimile'], ['bank_scope_operation', 'RetrieveUBPRXBRLFacsimile']]) {
      await assert.rejects(bank(db, 'reserve', { owner, method }, name), { code: 'PT409', message: 'lease_expired' });
      assert.deepEqual(await state(), unchanged);
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try { await assert.rejects(db.query("select public.bank_scope_operation('read','{}'::jsonb)"), { code: '42501' }); }
      finally { await db.exec('reset role'); }
    }
  });

  await t.test('membership claim loss cannot stage a candidate or switch the active registry', async () => {
    await db.exec("update edgar_private.membership_control set next_check_at=clock_timestamp()-interval '1 second'");
    const claim = await rpc(db, 'edgar_begin_membership_check', ['text', 'uuid'], [ns, randomUUID()]);
    assert.ok(claim.owner);
    await db.exec("update edgar_private.membership_control set lease_until=clock_timestamp()-interval '1 second'");
    const state = async () => (await db.query(`select
      (select to_jsonb(c) from edgar_private.membership_control c) control,
      (select count(*)::integer from edgar_private.membership_snapshots) snapshots`)).rows[0];
    const unchanged = await state();
    await assert.rejects(rpc(db, 'edgar_stage_membership', ['text', 'jsonb', 'jsonb', 'jsonb'], [ns, claim, {}, {}]), { code: 'PT409', message: 'membership_claim_lost' });
    await assert.rejects(rpc(db, 'edgar_activate_membership', ['text', 'jsonb', 'text'], [ns, claim, unchanged.control.active_id]), { code: 'PT409', message: 'membership_claim_lost' });
    assert.deepEqual(await state(), unchanged);
  });

  await t.test('a fund-review lease expiring during publication rolls back evidence, progress and budget', async () => {
    const cik = '0002012383', period = '2025-12-31', observed = new Date().toISOString();
    const holding = { key: '000000001|SECURITY|SH', cusip: '000000001', issuer: 'Fixture company', classTitle: 'COM', putCall: null, quantity: 10, quantityType: 'SH', valueUsd: 100, weightPct: 100 };
    const report = { manager: { cik, name: 'Fixture manager' }, selectedPeriod: period, observedAt: observed,
      cache: { checkedAt: observed }, coverage: { selectedPeriodComplete: true },
      portfolio: { cik, period, positionCount: 1, totalValueUsd: 100, complete: true, holdings: [holding], filings: [] } };
    const result = { schemaVersion: 'edgar.13f-market-connections.v1', manager: { cik }, selectedPeriod: period,
      holding, status: 'unresolved', observedAt: observed, identity: { status: 'unresolved', cusip: holding.cusip }, discovery: null };
    const summary = { holding, status: 'unresolved', issuer: null, message: 'Fixture research status', checkedAt: observed,
      markets: [], checked: false, partial: false, disclosureOnly: false, retryable: false };
    await rpc(db, 'edgar_fund_review_enqueue', ['text', 'jsonb', 'text'], [ns, report, 'A'.repeat(64)]);
    const claim = await rpc(db, 'edgar_fund_review_claim', ['text', 'uuid', 'integer'], [ns, randomUUID(), 90]);
    const token = { id: claim.id, reportHash: claim.reportHash, generation: claim.generation, owner: claim.owner, cycle: claim.cycle };
    // A local-only trigger deterministically crosses the original deadline after
    // the function has read its claim; it never contacts any external provider.
    await db.exec(`create sequence edgar_private.conflict_test_write;
      grant usage,select on sequence edgar_private.conflict_test_write to service_role;
      create function edgar_private.conflict_test_delay() returns trigger language plpgsql as $$
      begin perform nextval('edgar_private.conflict_test_write'); perform pg_sleep(0.6); return new; end $$;
      create trigger conflict_test_delay before insert on edgar_private.fund_review_results
      for each row execute function edgar_private.conflict_test_delay();
      update edgar_private.fund_review_jobs set lease_until=clock_timestamp()+interval '400 milliseconds';`);
    const state = async () => (await db.query(`select
      (select jsonb_agg(to_jsonb(j)) from edgar_private.fund_review_jobs j) jobs,
      (select jsonb_agg(to_jsonb(b)) from edgar_private.fund_review_daily_budget b) budget,
      (select count(*)::integer from edgar_private.fund_review_results) results`)).rows[0];
    const unchanged = await state();
    await assert.rejects(rpc(db, 'edgar_fund_review_save', ['text', 'jsonb', 'integer', 'jsonb', 'jsonb', 'integer'], [ns, token, 1, result, summary, 0]), { code: 'PT409', message: 'fund_review_lease_expired' });
    assert.equal((await db.query('select is_called from edgar_private.conflict_test_write')).rows[0].is_called, true);
    assert.deepEqual(await state(), unchanged);
  });
});
