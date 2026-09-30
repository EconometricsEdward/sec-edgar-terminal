import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { normalizePeerRecord } from '../src/utils/bank/peerSource.js';

const directory = new URL('../supabase/migrations/', import.meta.url);
const preparedName = '20260928143317_bankscope_prepared_peer_payloads.sql';
const chunkName = '20260928145303_bankscope_peer_payload_chunks.sql';
const period = '2026-06-30', count = 4296, owner = randomUUID();
// Real production normalization gives all 24 metrics, zeroes, missing values,
// business-mix arrays and source identities rather than a toy tiny JSON row.
const rows = Array.from({ length: count }, (_, i) => {
  const raw = { RSSDID: 100001 + i, CERT: 1 + i, REPDTE: '20260630', ASSET: 100000 + i,
    LNLSGR: 60000, LNRE: 30000, LNCI: 15000, LNCON: 9000, DEP: 80000, DEPDOM: 80000,
    DEPNIDOM: 20000, BRO: 4000, ROA: 1.2, ROE: 12, NIMY: 3.5, RBC1AAJ: 10, NCLNLSR: 0,
    NTLNLSR: -0.1, CBLRIND: 0, RBCT1CER: 11.23, RBC1RWAJ: 12.4, RBCRWAJ: 14.5,
    EQV: 8.1, LNATRESR: 1.5, LNATRES: 1000, NCLNLS: 0, EEFFR: 62.1, NONIXR: 4.1,
    NONIIR: 0.95, CHBALR: 15.2, ASSTLTR: 31.2, SCMTGBKR: null, SC: 20000 };
  return { profile: normalizePeerRecord(raw, period), raw };
});
async function service(db, sql, args = []) {
  await db.exec('set role service_role');
  try { return (await db.query(sql, args)).rows; }
  finally { await db.exec('reset role'); }
}
const bank = async (db, operation, payload = {}) => (await service(db,
  'select public.bank_scope_operation($1,$2::jsonb) value', [operation, payload]))[0].value;
const helper = async (db, name, id) => (await service(db,
  `select edgar_private.${name}($1::uuid) value`, [id]))[0].value;
const sameRows = response => ({ ...response, profiles: response.profiles.toSorted((a, b) => a.rssd - b.rssd) });
async function seed(db, { complete = false, size = count } = {}) {
  const id = randomUUID();
  await db.query(`insert into edgar_private.bank_peer_snapshots(id,report_date,owner,expected_count,
    received_count,matched_count,source_url,source_sha256,source_index,model_version)
    values($1,$2,$3,$4,$4,$4,'https://api.fdic.gov/banks/financials?fixture=1',$5,'fixture','bankscope-peers-2')`,
  [id, period, owner, count, 'a'.repeat(64)]);
  // Intentionally different from RSSD ordering, as production source ordering
  // follows FDIC certificates and batches need not have disjoint RSSD ranges.
  const batchRows = rows.slice(0, size).toReversed();
  for (let i = 0; i < batchRows.length; i += 500) {
    await service(db, `insert into edgar_private.bank_peer_profiles(snapshot_id,id_rssd,profile,raw_source)
      select $1::uuid,(x->'profile'->>'rssd')::bigint,x->'profile',x->'raw'
      from jsonb_array_elements($2::jsonb) x`, [id, batchRows.slice(i, i + 500)]);
  }
  if (complete) await db.query('update edgar_private.bank_peer_snapshots set completed_at=clock_timestamp() where id=$1', [id]);
  return id;
}

test('bounded peer pieces preserve real-profile results and make publication independent of source JSON reads', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema edgar_private;grant usage on schema edgar_private,public to service_role;`);
  for (const name of (await readdir(directory)).filter(name =>
    /_(?:ffiec_bank|bankscope)/.test(name) && name < preparedName).sort()) {
    await db.exec(await readFile(new URL(name, directory), 'utf8'));
  }
  await db.exec(await readFile(new URL('20260928042029_application_conflicts_no_retry.sql', directory), 'utf8'));
  await db.query(`insert into edgar_private.bank_institutions(id_rssd,legal_name,fdic_certificate,
    institution_status,last_verified_at,identity_source,city,state,form_type)
    select 100000+i,'Bank '||i,i,'active',now(),'{}','Indianapolis','IN','051' from generate_series(1,$1::integer) i`, [count]);
  await db.query(`insert into edgar_private.bank_panel_entries(id_rssd,report_date,form_type,has_filed,identity_source)
    select 100000+i,$1::date,'051',true,jsonb_build_object('FDICCertNumber',i) from generate_series(1,$2::integer) i`, [period, count]);
  await db.query(`update edgar_private.bank_pilot_control set owner=$1,lease_until=clock_timestamp()+interval '1 hour',
    catalog='{"periods":["2026-06-30"]}'::jsonb where id`, [owner]);
  const legacy = await seed(db, { complete: true });
  const original = sameRows(await bank(db, 'peer_universe', { period }));
  await db.exec(await readFile(new URL(preparedName, directory), 'utf8'));
  await db.exec(await readFile(new URL(chunkName, directory), 'utf8'));

  await t.test('legacy preparation advances by at most 250 records and never publishes incomplete pieces', async () => {
    await assert.rejects(helper(db, 'bank_prepare_peer_payload', legacy), { code: '22023', message: 'peer_payload_chunks_incomplete' });
    let remaining = count, calls = 0;
    do {
      const result = await helper(db, 'bank_prepare_peer_payload_chunk', legacy);
      assert.equal(result.added, Math.min(250, remaining));
      remaining -= result.added; assert.equal(result.remaining, remaining);
      assert.equal(result.published, false); calls++;
    } while (remaining > 0);
    assert.equal(calls, 18);
    assert.equal((await db.query('select count(*)::integer count from edgar_private.bank_peer_payloads')).rows[0].count, 0);
    assert.equal((await helper(db, 'bank_prepare_peer_payload_chunk', legacy)).added, 0);
    assert.equal((await helper(db, 'bank_prepare_peer_payload', legacy)).profiles, count);
    assert.deepEqual(sameRows(await bank(db, 'peer_universe', { period })), original);
    assert.equal((await helper(db, 'bank_prepare_peer_payload_chunk', legacy)).published, true);
  });

  await t.test('new ingestion captures bounded pieces and publication does not read profile JSON', async () => {
    const id = await seed(db);
    const bounds = (await db.query(`select count(*)::integer pieces,max(profile_count) maximum,
      sum(profile_count)::integer profiles from edgar_private.bank_peer_payload_chunks where snapshot_id=$1`, [id])).rows[0];
    assert.deepEqual(bounds, { pieces: 18, maximum: 250, profiles: count });
    await db.exec(`revoke select on edgar_private.bank_peer_profiles from service_role;
      grant select(snapshot_id,id_rssd) on edgar_private.bank_peer_profiles to service_role;`);
    try {
      assert.equal((await db.query("select has_column_privilege('service_role','edgar_private.bank_peer_profiles','profile','SELECT') allowed")).rows[0].allowed, false);
      assert.deepEqual(await bank(db, 'peer_complete', { owner, snapshotId: id }), { ok: true });
      const result = sameRows(await bank(db, 'peer_universe', { period }));
      assert.equal(result.snapshot.id, id); assert.deepEqual(result.profiles, original.profiles);
    } finally { await db.exec('grant select on edgar_private.bank_peer_profiles to service_role'); }
  });

  await t.test('missing pieces roll back publication without disturbing the last completed response', async () => {
    const previous = await bank(db, 'peer_universe', { period });
    const id = await seed(db, { size: count - 1 });
    await assert.rejects(bank(db, 'peer_complete', { owner, snapshotId: id }), { code: '22023', message: 'peer_payload_chunks_incomplete' });
    assert.equal((await db.query('select completed_at from edgar_private.bank_peer_snapshots where id=$1', [id])).rows[0].completed_at, null);
    assert.deepEqual(await bank(db, 'peer_universe', { period }), previous);
  });

  await t.test('overlapping piece identities cannot pass the publication count check', async () => {
    const id = await seed(db);
    await db.query(`update edgar_private.bank_peer_payload_chunks set profile_ids[2]=profile_ids[1]
      where snapshot_id=$1 and first_rssd=(select min(first_rssd) from edgar_private.bank_peer_payload_chunks where snapshot_id=$1)`, [id]);
    await assert.rejects(bank(db, 'peer_complete', { owner, snapshotId: id }), { code: '22023', message: 'peer_payload_count_mismatch' });
    assert.equal((await db.query('select count(*)::integer count from edgar_private.bank_peer_payloads where snapshot_id=$1', [id])).rows[0].count, 0);
  });

  await t.test('an incorrect legacy header cannot hide source profiles omitted from otherwise valid pieces', async () => {
    const id = await seed(db);
    await db.query('delete from edgar_private.bank_peer_payload_chunks where snapshot_id=$1 and profile_count=46', [id]);
    await db.query(`update edgar_private.bank_peer_snapshots set expected_count=4250,
      received_count=4250,matched_count=4250 where id=$1`, [id]);
    await assert.rejects(bank(db, 'peer_complete', { owner, snapshotId: id }), { code: '22023', message: 'peer_payload_count_mismatch' });
    assert.equal((await db.query('select completed_at from edgar_private.bank_peer_snapshots where id=$1', [id])).rows[0].completed_at, null);
  });

  await t.test('chunk storage and helpers remain private and invoker-controlled', async () => {
    const properties = (await db.query(`select c.relrowsecurity rls,
      has_table_privilege('anon',c.oid,'SELECT') anon_read,
      has_table_privilege('authenticated',c.oid,'SELECT') authenticated_read
      from pg_class c where c.oid='edgar_private.bank_peer_payload_chunks'::regclass`)).rows[0];
    assert.deepEqual(properties, { rls: true, anon_read: false, authenticated_read: false });
    for (const name of ['bank_prepare_peer_payload_chunk(uuid)', 'bank_capture_peer_payload_chunks()']) {
      const properties = (await db.query(`select p.prosecdef,
        has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
        has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
        has_function_privilege('service_role',p.oid,'EXECUTE') service_execute
        from pg_proc p where p.oid=$1::regprocedure`, [`edgar_private.${name}`])).rows[0];
      assert.deepEqual(properties, { prosecdef: false, anon_execute: false, authenticated_execute: false, service_execute: true });
    }
  });

  await t.test('snapshot retention also removes its pieces', async () => {
    await db.query('delete from edgar_private.bank_peer_profiles where snapshot_id=$1', [legacy]);
    await db.query('delete from edgar_private.bank_peer_snapshots where id=$1', [legacy]);
    assert.equal((await db.query('select count(*)::integer count from edgar_private.bank_peer_payload_chunks where snapshot_id=$1', [legacy])).rows[0].count, 0);
  });
});
