/** Exact production migration in an isolated PG engine. No hosted writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

async function role(db, name, action) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(name));
  await db.exec(`set role ${name}`);
  try { return await action(); } finally { await db.exec('reset role'); }
}
async function capture(db, namespace = 'production') {
  return role(db, 'service_role', async () => (await db.query('select public.edgar_capture_coverage_operations($1) value', [namespace])).rows[0].value);
}
async function read(db, namespace = 'production', hours = 24) {
  return role(db, 'service_role', async () => (await db.query('select public.edgar_coverage_operations($1,$2) value', [namespace, hours])).rows[0].value);
}
async function freshBucket(db) {
  await db.exec("delete from edgar_private.coverage_operations_snapshots where hour_bucket=date_trunc('hour',now(),'UTC')");
}
async function database() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema extensions; create extension pgcrypto with schema extensions;
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb,created_at timestamptz default now());
      grant usage on schema public,storage,extensions to service_role;
      grant select,insert,update on storage.objects,storage.buckets to service_role;
      create schema cron;
      create table cron.job(jobname text primary key,schedule text,command text,active boolean default true);
      create function cron.schedule(job_name text,job_schedule text,job_command text) returns bigint language plpgsql as $$
        begin insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command)
          on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command;
          return 1; end $$;
    `);
    const directory = new URL('../supabase/migrations/', import.meta.url);
    const files = await readdir(directory);
    assert.equal(files.filter(name => name.endsWith('_edgar_coverage_operations.sql')).length, 1);
    assert.equal(files.filter(name => name.endsWith('_edgar_membership_registry.sql')).length, 1);
    const names = ['20260913031639_edgar_staged_data_store.sql', '20260913073012_edgar_coverage_batch_reads_jobs.sql',
      files.find(name => name.endsWith('_edgar_membership_registry.sql')),
      files.find(name => name.endsWith('_edgar_coverage_operations.sql'))];
    assert.ok(names[2]); assert.ok(names[3]);
    for (const name of names) await db.exec(await readFile(new URL(name, directory), 'utf8'));
    return db;
  } catch (error) { await db.close(); throw error; }
}

test('operations migration captures bounded private evidence and retains only operational history', async t => {
  const db = await database();
  t.after(() => db.close());

  await t.test('both RPCs are invoker-only, production-only and denied to browser roles', async () => {
    const rows = (await db.query("select oid,proname,prosecdef,provolatile,proconfig from pg_proc where proname in ('edgar_capture_coverage_operations','edgar_coverage_operations')")).rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.prosecdef, false);
      assert.ok(row.proconfig.includes('search_path=""'));
      if (row.proname === 'edgar_coverage_operations') assert.equal(row.provolatile, 's');
      assert.equal((await db.query("select has_function_privilege('service_role',$1::oid,'EXECUTE') allowed", [row.oid])).rows[0].allowed, true);
      for (const name of ['anon', 'authenticated']) {
        assert.equal((await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') allowed", [name, row.oid])).rows[0].allowed, false);
        await role(db, name, () => assert.rejects(db.query(`select public.${row.proname}('production')`), { code: '42501' }));
      }
    }
    const table = (await db.query("select relrowsecurity from pg_class where oid='edgar_private.coverage_operations_snapshots'::regclass")).rows[0];
    assert.equal(table.relrowsecurity, true);
    for (const name of ['anon', 'authenticated']) await role(db, name, () => assert.rejects(db.query('select * from edgar_private.coverage_operations_snapshots'), { code: '42501' }));
    for (const ns of [null, '', 'preview', 'another-project']) {
      await assert.rejects(capture(db, ns), { code: '22023' });
      await assert.rejects(read(db, ns), { code: '22023' });
    }
    for (const hours of [null, 0, -1, 169]) await assert.rejects(read(db, 'production', hours), { code: '22023' });
  });

  await t.test('migration schedules SQL-only hourly collection and same-hour calls are immutable', async () => {
    const jobs = (await db.query('select * from cron.job')).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].jobname, 'edgar-coverage-operations-v1');
    assert.equal(jobs[0].schedule, '7 * * * *');
    assert.equal(jobs[0].active, true);
    assert.equal(jobs[0].command.trim(), "select public.edgar_capture_coverage_operations('production');");
    const original = await capture(db);
    assert.equal(original.schema, 1);
    assert.equal(original.policy.sourceFreshnessSeconds, 90000);
    assert.equal(original.policy.retentionDays, 90);
    assert.deepEqual(await capture(db), original);
    assert.equal(Number((await db.query('select count(*) n from edgar_private.coverage_operations_snapshots')).rows[0].n), 1);
    assert.equal(original.unmeasured.billingMonthEgressBytes, null);
    assert.equal(original.unmeasured.concurrentVisitorCapacity, null);
  });

  await t.test('current heads, availability and cycles are separated and isolated', async () => {
    await db.exec(`
      insert into edgar_private.membership_snapshots(namespace,id,source_as_of,fingerprint,snapshot,evidence_kind,raw_sha256)
        values('production','fixture-current',current_date,repeat('e',64),
          '{"id":"fixture-current","reference":{"asOf":"2026-09-13"},"issuers":[{"cik":"0000000001"},{"cik":"0002115436"}]}',
          'reviewed-repository-seed',repeat('f',64));
      update edgar_private.membership_control set active_id='fixture-current' where namespace='production';
      insert into public.edgar_dataset_versions(id,namespace,dataset,resource_key,identity_hash,content_hash,schema_version,publication_generation,payload,raw_bytes,stored_bytes,metadata,fetched_at)
        values('00000000-0000-4000-8000-000000000001','production','financial','financial-analysis-v1:analysis-v1.4:context-v3:CIK0000000001:annual:latest',repeat('a',64),repeat('b',64),'1',1,'{}',2,22,'{"basis":"annual"}',now()),
          ('00000000-0000-4000-8000-000000000002','production','sec','sec-documents-v1:CIK0000000001:companyfacts',repeat('c',64),repeat('d',64),'1',1,'{}',2,22,'{}',now());
      insert into public.edgar_dataset_heads(namespace,dataset,resource_key,current_version,revalidated_at,expires_at)
        values('production','financial','financial-analysis-v1:analysis-v1.4:context-v3:CIK0000000001:annual:latest','00000000-0000-4000-8000-000000000001',now(),now()+interval '25 hours'),
          ('production','sec','sec-documents-v1:CIK0000000001:companyfacts','00000000-0000-4000-8000-000000000002',now()-interval '26 hours',now()-interval '1 hour');
      insert into public.edgar_financial_metrics(version_id,metric,ordinal,value,context) values
        ('00000000-0000-4000-8000-000000000001','net-income',1,50,'{"classification":"reported"}'),
        ('00000000-0000-4000-8000-000000000001','unavailable-ratio',2,null,'{"classification":"unavailable"}');
      insert into storage.objects(bucket_id,name,metadata) values('edgar-durable-private','production/fixture','{"size":1234}'),('other-bucket','other','{"size":999999}');
      insert into public.edgar_ingestion_jobs(namespace,dataset,resource_key,job_key,state,max_attempts,created_at,updated_at,checkpoint)
        select 'production','sec','sec-coverage-v1:shard:'||lpad(n::text,2,'0'),
          'sec-coverage-v1:'||to_char(now() at time zone 'UTC','YYYY-MM-DD')||':'||lpad(n::text,2,'0')||':'||repeat('a',16),
          'done',10,now()-interval '8 hours',now()-interval '1 hour',
          jsonb_build_object('cursor',16,'succeeded',16,'workCount',16,'retries','[]'::jsonb,'failures','[]'::jsonb)
        from generate_series(0,31) n;
      insert into public.edgar_ingestion_jobs(namespace,dataset,resource_key,job_key,state,max_attempts)
        values('preview','sec','ignored','sec-coverage-v1:preview','dead',10),('production','cftc','ignored','sec-coverage-v1:wrong-dataset','dead',10);
    `);
    await freshBucket(db);
    const snapshot = await capture(db);
    assert.equal(snapshot.heads, 2);
    assert.deepEqual(snapshot.coverageGroups.map(g => [g.family, g.fresh, g.stale]), [['analysis', 1, 0], ['sec-document', 0, 1]]);
    assert.equal(snapshot.metricAvailability.available, 1);
    assert.equal(snapshot.metricAvailability.unavailable, 1);
    assert.equal(snapshot.privateStorage.bytes, 1234);
    assert.equal(snapshot.privateStorage.objects, 1);
    assert.equal(snapshot.work.deadJobs, 0);
    assert.equal(snapshot.work.pending, 0);
    assert.equal(snapshot.work.todayJobs, 32);
    assert.equal(snapshot.maintenance.membershipId, 'fixture-current');
    assert.equal(snapshot.membership.activeId, 'fixture-current');
    assert.equal(snapshot.membership.activeIssuers, 2);
    assert.equal(snapshot.membership.activeSourceAsOf, '2026-09-13');
    assert.equal(snapshot.membership.lastCheckedAt, null);
    assert.equal(snapshot.maintenance.issuers, 3, 'ACU is maintained in addition to the active membership');
    assert.equal(snapshot.maintenance.sourceIssuers, 4, 'the current XOM predecessor is source-only');
    assert.equal(snapshot.maintenance.expected, 41);
    assert.equal(snapshot.maintenance.prepared, 2);
    assert.equal(snapshot.maintenance.fresh, 1);
    assert.equal(snapshot.maintenance.stale, 1);
    assert.equal(snapshot.maintenance.missing, 39);
    assert.equal(snapshot.cycles.length, 1);
    assert.equal(snapshot.cycles[0].succeeded, 512);
    assert.equal(snapshot.cycles[0].elapsed_seconds, 25200);
    assert.ok(snapshot.cycles[0].completed_at);
    assert.ok(snapshot.database.databaseBytes > 0);
    assert.equal(snapshot.database.connections >= 0, true);
    assert.equal(JSON.stringify(snapshot).includes('net-income'), false, 'metric names and source payloads are not retained in ops snapshots');
  });

  await t.test('departed and pending issuers remain inventory without becoming stale maintenance incidents', async () => {
    await db.exec(`
      insert into edgar_private.membership_snapshots(namespace,id,source_as_of,fingerprint,snapshot,evidence_kind,raw_sha256)
        values('production','fixture-candidate',current_date,repeat('a',64),'{"id":"fixture-candidate","issuers":[{"cik":"0000000003"}]}','reviewed-repository-seed',repeat('b',64));
      update edgar_private.membership_control set candidate_id='fixture-candidate' where namespace='production';
      insert into edgar_private.membership_retained(namespace,cik,issuer,departed_snapshot)
        values('production','0000000002','{"cik":"0000000002"}','fixture-current');
      insert into public.edgar_dataset_versions(namespace,dataset,resource_key,identity_hash,content_hash,schema_version,publication_generation,payload,raw_bytes,stored_bytes,metadata,fetched_at)
        select 'production','financial','financial-analysis-v1:analysis-v1.4:context-v3:CIK'||cik||':annual:latest',repeat('a',64),repeat('b',64),'1',1,'{}',2,22,'{"basis":"annual"}',now()
          from unnest(array['0000000002','0000000003']) cik;
      insert into public.edgar_dataset_heads(namespace,dataset,resource_key,current_version,revalidated_at,expires_at)
        select namespace,dataset,resource_key,id,now()-interval '26 hours',now()-interval '1 hour'
          from public.edgar_dataset_versions where split_part(resource_key,':',4) in ('CIK0000000002','CIK0000000003');
    `);
    await freshBucket(db);
    const snapshot = await capture(db);
    assert.equal(snapshot.coverageGroups.reduce((n, g) => n + g.stale, 0), 3);
    assert.equal(snapshot.maintenance.stale, 1);
    assert.equal(snapshot.maintenance.prepared, 2);
    assert.equal(snapshot.maintenance.missing, 39);
    assert.equal(snapshot.maintenance.retainedIssuerCount, 1);
    assert.equal(snapshot.membership.candidateId, 'fixture-candidate');
    assert.ok(snapshot.membership.candidateSince);
    const current = await read(db);
    assert.equal(current.history.at(-1).stale, 1);
    assert.equal(current.history.at(-1).inventoryStale, 3);
  });

  await t.test('partial/superseded/queued records retain accurate failure and queue evidence', async () => {
    await db.exec(`update public.edgar_ingestion_jobs set state='queued',created_at=now()-interval '13 hours',
      checkpoint='{"cursor":1,"succeeded":0,"workCount":2,"retries":[{}],"failures":[{}]}'
      where namespace='production' and dataset='sec' and split_part(job_key,':',3)='00';
      update public.edgar_ingestion_jobs set error_code='SEC_COVERAGE_SUPERSEDED'
      where namespace='production' and dataset='sec' and split_part(job_key,':',3)='01';`);
    await freshBucket(db);
    const snapshot = await capture(db);
    assert.equal(snapshot.work.pending, 1);
    assert.ok(snapshot.work.oldestPendingAgeSeconds >= 13 * 3600);
    assert.equal(snapshot.cycles[0].completed_at, null);
    assert.equal(snapshot.cycles[0].retries, 1);
    assert.equal(snapshot.cycles[0].failures, 1);
    assert.equal(snapshot.cycles[0].superseded, 1);
  });

  await t.test('a later successful daily sweep resolves earlier failures without erasing their history', async () => {
    await db.exec(`
      update public.edgar_ingestion_jobs set state='done',error_code=null,
        checkpoint='{"cursor":16,"succeeded":16,"workCount":16,"retries":[],"failures":[]}'
        where namespace='production' and dataset='sec';
      insert into public.edgar_ingestion_jobs(namespace,dataset,resource_key,job_key,state,max_attempts,checkpoint)
        values('production','sec','old-dead','sec-coverage-v1:'||to_char((now()-interval '1 day') at time zone 'UTC','YYYY-MM-DD')||':00:'||repeat('a',16),'dead',10,
          '{"cursor":1,"succeeded":0,"workCount":3,"retries":[],"failures":[{"index":0}]}');
    `);
    await freshBucket(db);
    const snapshot = await capture(db);
    assert.equal(snapshot.work.historicalDeadJobs, 1);
    assert.equal(snapshot.work.historicalIssuerFailures, 1);
    assert.equal(snapshot.work.unresolvedDeadJobs, 0);
    assert.equal(snapshot.work.unresolvedIssuerFailures, 0);
    assert.equal(snapshot.cycles.length, 2);
    assert.equal(snapshot.cycles.find(c => c.dead === 1).failures, 1);
  });

  await t.test('90-day retention deletes only old operational rows; reads have no mutations', async () => {
    await db.exec(`insert into edgar_private.coverage_operations_snapshots(namespace,hour_bucket,observed_at,payload)
      select 'production',date_trunc('hour',now(),'UTC')-make_interval(hours=>n),now()-make_interval(hours=>n),
        '{"coverageGroups":[{"fresh":1,"stale":0}],"work":{},"database":{},"privateStorage":{}}'::jsonb
      from generate_series(1,2162) n;`);
    await freshBucket(db);
    const dataBefore = (await db.query('select (select count(*) from public.edgar_dataset_versions) versions,(select count(*) from public.edgar_ingestion_jobs) jobs,(select count(*) from storage.objects) objects')).rows[0];
    await capture(db);
    assert.equal(Number((await db.query('select count(*) n from edgar_private.coverage_operations_snapshots')).rows[0].n), 2161);
    assert.deepEqual((await db.query('select (select count(*) from public.edgar_dataset_versions) versions,(select count(*) from public.edgar_ingestion_jobs) jobs,(select count(*) from storage.objects) objects')).rows[0], dataBefore);
    const result = await read(db, 'production', 168);
    assert.equal(result.history.length, 169);
    assert.equal(result.latest.schema, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 262144);
    assert.ok(Date.parse(result.history[0].observedAt) < Date.parse(result.history.at(-1).observedAt));
    assert.equal((await read(db, 'production', 1)).history.length, 2);
    assert.equal(Number((await db.query('select count(*) n from edgar_private.coverage_operations_snapshots')).rows[0].n), 2161);
    for (const name of ['edgar_dataset_versions', 'edgar_ingestion_jobs', 'edgar_source_assets']) {
      assert.equal((await db.query("select has_table_privilege('service_role',$1,'DELETE') allowed", [`public.${name}`])).rows[0].allowed, false);
    }
  });
});
