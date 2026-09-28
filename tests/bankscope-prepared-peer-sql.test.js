/** Run the exact migration in isolated PostgreSQL, including publication
 * rollback, private privileges and a read with source-table access revoked. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const directory = new URL('../supabase/migrations/', import.meta.url);
const migrationName = '20260928143317_bankscope_prepared_peer_payloads.sql';
const migration = await readFile(new URL(migrationName, directory), 'utf8');
const owner = randomUUID(), period = '2026-06-30';
async function asService(db, sql, args = []) {
  await db.exec('set role service_role');
  try { return (await db.query(sql, args)).rows; }
  finally { await db.exec('reset role'); }
}
const bank = async (db, operation, payload) => (await asService(db,
  'select public.bank_scope_operation($1,$2::jsonb) value', [operation, payload]))[0].value;
const prepare = async (db, id) => (await asService(db,
  'select edgar_private.bank_prepare_peer_payload($1::uuid) value', [id]))[0].value;
const metadata = async db => (await db.query(`select p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig,
  pg_get_functiondef(p.oid) definition from pg_proc p
  where p.oid='public.bank_scope_operation(text,jsonb)'::regprocedure`)).rows[0];

async function database() {
  const db = new PGlite();
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create schema edgar_private;
      grant usage on schema edgar_private,public to service_role;`);
    for (const name of (await readdir(directory)).filter(name =>
      /_(?:ffiec_bank|bankscope)/.test(name) && name < migrationName).sort()) {
      await db.exec(await readFile(new URL(name, directory), 'utf8'));
    }
    await db.exec(await readFile(new URL('20260928042029_application_conflicts_no_retry.sql', directory), 'utf8'));
    await db.exec(`insert into edgar_private.bank_institutions(id_rssd,legal_name,fdic_certificate,
      institution_status,last_verified_at,identity_source,city,state,form_type)
      select 100000+i,'Fixture bank '||i,i,'active',now(),'{}','Indianapolis','IN','051'
      from generate_series(1,1000) i;
      insert into edgar_private.bank_panel_entries(id_rssd,report_date,form_type,has_filed,identity_source)
      select 100000+i,'2026-06-30','051',true,jsonb_build_object('FDICCertNumber',i)
      from generate_series(1,1000) i;`);
    await db.query(`update edgar_private.bank_pilot_control set owner=$1,lease_until=clock_timestamp()+interval '1 hour',
      catalog='{"periods":["2026-06-30"]}'::jsonb where id`, [owner]);
    return db;
  } catch (error) { await db.close(); throw error; }
}
async function snapshot(db, { complete = false } = {}) {
  const id = randomUUID();
  await db.query(`insert into edgar_private.bank_peer_snapshots(id,report_date,owner,expected_count,received_count,
    matched_count,source_url,source_sha256,source_index,source_updated_at,model_version)
    values($1,$2,$3,1000,1000,1000,'https://api.fdic.gov/banks/financials?fixture=1',$4,'fixture',now(),'bankscope-peers-2')`,
  [id, period, owner, 'a'.repeat(64)]);
  await db.query(`insert into edgar_private.bank_peer_profiles(snapshot_id,id_rssd,profile,raw_source)
    select $1::uuid,100000+i,jsonb_build_object('rssd',100000+i,'cert',i,'assets',1000,'loanShare',0.5,
      'cblr',false,'loanMix',null,'funding',null,'metrics',jsonb_build_object('roa',1)),
      jsonb_build_object('privateSource','not published') from generate_series(1,1000) i`, [id]);
  if (complete) await db.query('update edgar_private.bank_peer_snapshots set completed_at=clock_timestamp() where id=$1', [id]);
  return id;
}

test('prepared BankScope peers publish atomically and bypass full-universe joins on subsequent reads', async t => {
  const db = await database(); t.after(() => db.close());
  const legacyId = await snapshot(db, { complete: true });
  const originalResponse = await bank(db, 'peer_universe', { period });
  const before = await metadata(db);
  await db.exec(migration);

  await t.test('only the intended read branch changes; security, function identity and terminal conflicts remain', async () => {
    const after = await metadata(db);
    const { definition: oldDefinition, ...oldMetadata } = before;
    const { definition: newDefinition, ...newMetadata } = after;
    assert.deepEqual(newMetadata, oldMetadata);
    const added = `    select p.payload into result from edgar_private.bank_peer_payloads p
      where p.snapshot_id=s.id and p.completed_at=s.completed_at;
    if found then return result; end if;
`;
    assert.equal(newDefinition.replace(added, ''), oldDefinition);
    assert.ok(newDefinition.includes("errcode='PT409'"));
    assert.ok(newDefinition.includes("p_operation='peer_history'"));
    const privileges = (await db.query(`select c.relrowsecurity as rls,
      has_table_privilege('anon',c.oid,'SELECT') anon_read,
      has_table_privilege('authenticated',c.oid,'SELECT') authenticated_read,
      has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE') service_access
      from pg_class c where c.oid='edgar_private.bank_peer_payloads'::regclass`)).rows[0];
    assert.deepEqual(privileges, { rls: true, anon_read: false, authenticated_read: false, service_access: true });
    for (const name of ['bank_prepare_peer_payload(uuid)', 'bank_publish_peer_payload()']) {
      const result = (await db.query(`select p.prosecdef,
        has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
        has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
        has_function_privilege('service_role',p.oid,'EXECUTE') service_execute
        from pg_proc p where p.oid=$1::regprocedure`, [`edgar_private.${name}`])).rows[0];
      assert.deepEqual(result, { prosecdef: false, anon_execute: false, authenticated_execute: false, service_execute: true });
    }
  });

  await t.test('legacy snapshots still read identically and can be backfilled one publication at a time', async () => {
    assert.deepEqual(await bank(db, 'peer_universe', { period }), originalResponse);
    assert.equal((await db.query('select count(*)::integer count from edgar_private.bank_peer_payloads')).rows[0].count, 0);
    const result = await prepare(db, legacyId);
    assert.equal(result.prepared, true); assert.equal(result.profiles, 1000);
    assert.ok(result.rawBytes > 0 && result.rawBytes < 12582912);
    assert.deepEqual(await bank(db, 'peer_universe', { period }), originalResponse);
    assert.deepEqual(await prepare(db, legacyId), { snapshotId: legacyId, prepared: false });
    assert.equal('owner' in originalResponse.snapshot, false);
    assert.equal(JSON.stringify(originalResponse).includes('privateSource'), false);
  });

  await t.test('prepared reads work even without permission to scan profile, panel or institution tables', async () => {
    await db.exec(`revoke select on edgar_private.bank_peer_profiles,edgar_private.bank_panel_entries,
      edgar_private.bank_institutions from service_role`);
    try { assert.deepEqual(await bank(db, 'peer_universe', { period }), originalResponse); }
    finally { await db.exec(`grant select on edgar_private.bank_peer_profiles,edgar_private.bank_panel_entries,
      edgar_private.bank_institutions to service_role`); }
  });

  await t.test('a successful fenced publication installs its own payload in the same transaction', async () => {
    const id = await snapshot(db);
    assert.equal((await db.query('select count(*)::integer count from edgar_private.bank_peer_payloads where snapshot_id=$1', [id])).rows[0].count, 0);
    assert.deepEqual(await bank(db, 'peer_complete', { owner, snapshotId: id }), { ok: true });
    const response = await bank(db, 'peer_universe', { period });
    assert.equal(response.snapshot.id, id); assert.equal(response.profiles.length, 1000);
    assert.deepEqual(response.profiles, originalResponse.profiles);
    assert.equal((await db.query('select completed_at=($1::jsonb->>\'completed_at\')::timestamptz matched from edgar_private.bank_peer_payloads where snapshot_id=$2', [response.snapshot, id])).rows[0].matched, true);
  });

  await t.test('an incomplete derived payload rolls back publication and leaves the previous snapshot readable', async () => {
    const previous = await bank(db, 'peer_universe', { period });
    const id = await snapshot(db);
    await db.exec("delete from edgar_private.bank_panel_entries where id_rssd=100001 and report_date='2026-06-30'");
    await assert.rejects(bank(db, 'peer_complete', { owner, snapshotId: id }), { code: '22023', message: 'peer_payload_count_mismatch' });
    const state = (await db.query(`select s.completed_at,
      (select count(*)::integer from edgar_private.bank_peer_payloads p where p.snapshot_id=s.id) payloads
      from edgar_private.bank_peer_snapshots s where s.id=$1`, [id])).rows[0];
    assert.deepEqual(state, { completed_at: null, payloads: 0 });
    assert.deepEqual(await bank(db, 'peer_universe', { period }), previous);
    await assert.rejects(prepare(db, id), { code: '22023', message: 'peer_snapshot_incomplete' });
    await db.exec("insert into edgar_private.bank_panel_entries values(100001,'2026-06-30','051',true,null,'{\"FDICCertNumber\":1}')");
  });

  await t.test('a different publication timestamp cannot reuse an obsolete prepared payload', async () => {
    const latest = await bank(db, 'peer_universe', { period });
    await db.query("update edgar_private.bank_peer_payloads set completed_at=completed_at-interval '1 second',payload=jsonb_set(payload,'{snapshot,model_version}','\"obsolete\"') where snapshot_id=$1", [latest.snapshot.id]);
    const fallback = await bank(db, 'peer_universe', { period });
    // The legacy aggregate has no ordering contract; compare the same rows.
    fallback.profiles.sort((a, b) => a.rssd - b.rssd);
    assert.deepEqual(fallback, latest);
    assert.equal((await prepare(db, latest.snapshot.id)).prepared, true);
    assert.deepEqual(await bank(db, 'peer_universe', { period }), latest);
  });

  await t.test('retention removes the corresponding payload through the snapshot foreign key', async () => {
    await db.query('delete from edgar_private.bank_peer_profiles where snapshot_id=$1', [legacyId]);
    await db.query('delete from edgar_private.bank_peer_snapshots where id=$1', [legacyId]);
    assert.equal((await db.query('select count(*)::integer count from edgar_private.bank_peer_payloads where snapshot_id=$1', [legacyId])).rows[0].count, 0);
    assert.deepEqual(await bank(db, 'peer_universe', { period: '2025-12-31' }), { profiles: [] });
  });
});
