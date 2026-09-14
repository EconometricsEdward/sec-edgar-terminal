/** Exact production SQL in isolated PostgreSQL/PGlite. No hosted changes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';

const ns = 'production', type = 'edgar.cftc-positioning.v1:production';
const key = 'raw-history-v1:futures-only:tff:12460+:2026-09-08', id = 'RAW-HISTORY:TFF:12460+:2026-09-08';
const hash = value => createHash('sha256').update(value).digest('hex');
const signatures = {
  edgar_begin_write: ['text','text','text','uuid','integer'], edgar_publish: ['text','text','text','jsonb','jsonb','boolean'],
  edgar_release_write: ['text','text','text','jsonb'], edgar_reserve_cache_generation: ['text','text','text','jsonb'],
  edgar_cache_put_fenced: ['text','text','text','jsonb','text','text','text','text','text','text','integer','integer','text','timestamptz'],
  edgar_cache_put: ['text','text','text','text','text','text','text','integer','integer','text','timestamptz'],
  edgar_enqueue_job: ['text','text','text','text','jsonb','integer'], edgar_claim_job_prefix: ['text','text','uuid','text','integer'],
  edgar_claim_job: ['text','text','uuid','integer','text'], edgar_yield_job: ['text','jsonb','jsonb','integer'], edgar_cftc_history_status: ['text'],
};
async function asRole(db, role, action) { await db.exec(`set role ${role}`); try { return await action(); } finally { await db.exec('reset role'); } }
async function rpc(db, name, args) { return asRole(db, 'service_role', async () => (await db.query(`select public.${name}(${signatures[name].map((t,i) => `$${i+1}::${t}`).join(',')}) value`, args)).rows[0].value); }
const token = x => ({ generation: x.generation, owner: x.owner });
const begin = (db, k = key) => rpc(db,'edgar_begin_write',[ns,'cftc',k,randomUUID(),120]);
const reserve = (db, c) => rpc(db,'edgar_reserve_cache_generation',[ns,'cftc',c.key,token(c)]);
function packed(value = { revision:1 }) { const raw = Buffer.from(JSON.stringify(value)), gzip = gzipSync(raw); return { raw, gzip, rawHash:hash(raw), gzipHash:hash(gzip), value }; }
function cacheArgs(data, cacheId = id, family = 'cftc-history') { return [family,type,cacheId,data.gzip.toString('base64'),data.rawHash,data.gzipHash,data.raw.length,300,null,null]; }
const put = (db,c,data,cacheId=id,family='cftc-history') => rpc(db,'edgar_cache_put_fenced',[ns,'cftc',c.key,token(c),...cacheArgs(data,cacheId,family)]);
const ready = (db,j) => db.query("update public.edgar_ingestion_jobs set available_at=clock_timestamp()-interval '1 second' where id=$1",[j]);
const cftcJobKey = `cftc-history-v1:2026-09-08:tff:00:${'a'.repeat(16)}`;
const checkpoint = { family:'tff', reportDate:'2026-09-08', catalogHash:'a'.repeat(64), shard:0, contracts:[{code:'12460+'},{code:'13874A'}],cursor:1,prepared:1,limited:0,failures:[] };
async function database() {
  const db = new PGlite();
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,created_at timestamptz default now(),unique(bucket_id,name));
    grant usage on schema storage,public to service_role;grant select on storage.objects to service_role;
    create schema cron;create table cron.job(jobname text primary key,schedule text,command text,active boolean default true);
    create function cron.schedule(job_name text,job_schedule text,job_command text) returns bigint language plpgsql as $$
      begin insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command)
      on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command;return 1;end $$;`);
  for (const name of ['20260913031639_edgar_staged_data_store.sql','20260913073012_edgar_coverage_batch_reads_jobs.sql','20260913085035_edgar_coverage_stable_order.sql','20260913171926_edgar_disposable_cache.sql','20260913181102_edgar_fenced_disposable_cache.sql'])
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
  const legacy=packed({legacy:true});
  await rpc(db,'edgar_cache_put',[ns,...cacheArgs(legacy,id,'history')]);
  await db.exec(await readFile(new URL('../supabase/migrations/20260914073310_edgar_cftc_history_preparation.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20260914074030_edgar_cftc_preserve_sec_shard_order.sql',import.meta.url),'utf8'));
  return db;
}

test('CFTC history migration enforces cache budgets, owner-only startup and fenced resumable work',async t => {
  const db=await database();t.after(()=>db.close());
  await t.test('total budget remains 512 MiB and existing bytes, hashes, expiry and counters survive',async()=>{
    const families=(await db.query('select * from edgar_private.cache_families order by family')).rows;
    assert.equal(families.reduce((n,r)=>n+Number(r.max_bytes),0),512*1024*1024);
    const history=families.find(r=>r.family==='cftc-history');
    assert.equal(Number(history.max_bytes),96*1024*1024);assert.equal(history.max_rows,10000);assert.equal(history.max_ttl_seconds,16*86400);assert.equal(history.evict_live,true);
    assert.equal(Number(families.find(r=>r.family==='research').max_bytes),160*1024*1024);
    const rows=(await db.query('select family,raw_sha256,expires_at>written_at valid from edgar_private.cache_entries')).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].family,'history');assert.equal(rows[0].raw_sha256,packed({legacy:true}).rawHash);assert.equal(rows[0].valid,true);
    assert.equal(Number(families.find(r=>r.family==='history').used_rows),1);
  });
  await t.test('browser roles cannot read control or invoke status and service cannot enable',async()=>{
    for(const role of ['anon','authenticated']){
      await assert.rejects(asRole(db,role,()=>db.query('select * from edgar_private.cftc_history_control')),{code:'42501'});
      await assert.rejects(asRole(db,role,()=>db.query("select public.edgar_cftc_history_status('production')")),{code:'42501'});
    }
    await assert.rejects(asRole(db,'service_role',()=>db.query('update edgar_private.cftc_history_control set enabled=true')),{code:'42501'});
    const functions=(await db.query("select prosecdef,proconfig from pg_proc where proname in ('edgar_cftc_history_status','edgar_claim_job_prefix','edgar_claim_job','edgar_yield_job')")).rows;
    assert.equal(functions.length,4);assert.ok(functions.every(r=>r.prosecdef===false&&r.proconfig.includes('search_path=""')));
    assert.equal((await rpc(db,'edgar_cftc_history_status',[ns])).enabled,false);
  });
  let j,first,second;
  await t.test('disabled preparation blocks prefix, exact job and broad CFTC claims',async()=>{
    j=await rpc(db,'edgar_enqueue_job',[ns,'cftc','history-refresh:futures-only:tff:shard:00',cftcJobKey,checkpoint,4]);
    assert.equal(await rpc(db,'edgar_claim_job_prefix',[ns,'cftc',randomUUID(),'cftc-history-v1:',120]),null);
    assert.equal(await rpc(db,'edgar_claim_job',[ns,'cftc',randomUUID(),120,cftcJobKey]),null);
    assert.equal(await rpc(db,'edgar_claim_job',[ns,'cftc',randomUUID(),120,null]),null);
    assert.equal((await db.query('select attempts,state from public.edgar_ingestion_jobs where id=$1',[j])).rows[0].attempts,0);
    await db.exec("update edgar_private.cftc_history_control set enabled=true,enabled_at=clock_timestamp(),initial_sec_cycle='2026-09-14'");
    first=await rpc(db,'edgar_claim_job_prefix',[ns,'cftc',randomUUID(),'cftc-history-v1:',120]);assert.equal(first.id,j);assert.equal(first.attempts,1);
  });
  await t.test('successful partial yield preserves counters and failure budget; stale worker cannot yield',async()=>{
    assert.equal(await rpc(db,'edgar_yield_job',[ns,{...token(first),id:j},checkpoint,1]),true);
    const yielded=(await db.query('select attempts,state,owner,checkpoint from public.edgar_ingestion_jobs where id=$1',[j])).rows[0];
    assert.equal(yielded.state,'queued');assert.equal(yielded.attempts,0);assert.equal(yielded.owner,null);assert.deepEqual(yielded.checkpoint,checkpoint);
    await ready(db,j);second=await rpc(db,'edgar_claim_job_prefix',[ns,'cftc',randomUUID(),'cftc-history-v1:',120]);
    assert.ok(second.generation>first.generation);assert.equal(second.attempts,1);
    assert.equal(await rpc(db,'edgar_yield_job',[ns,{...token(first),id:j},{cursor:999},1]),false);
  });
  await t.test('old CFTC refresh cannot use new continuation and existing SEC jobs remain supported',async()=>{
    await rpc(db,'edgar_enqueue_job',[ns,'cftc','refresh:tff-disaggregated','cftc-refresh:2026-09-14',{},4]);
    const old=await rpc(db,'edgar_claim_job',[ns,'cftc',randomUUID(),120,'cftc-refresh:2026-09-14']);
    assert.equal(await rpc(db,'edgar_yield_job',[ns,{...token(old),id:old.id},{},1]),false);
    await rpc(db,'edgar_enqueue_job',[ns,'sec','financial-cohort-v1','sec-financial-cohort-v1:2026-09-14',{},4]);
    const sec=await rpc(db,'edgar_claim_job_prefix',[ns,'sec',randomUUID(),'sec-financial-cohort-v1:',120]);
    assert.equal(await rpc(db,'edgar_yield_job',[ns,{...token(sec),id:sec.id},{cursor:1},1]),true);
    for(const [dataset,prefix] of [['cftc','sec-coverage-v1:'],['sec','cftc-history-v1:'],['cftc','cftc-']])
      await assert.rejects(rpc(db,'edgar_claim_job_prefix',[ns,dataset,randomUUID(),prefix,120]),/invalid_job_prefix/);
  });
  await t.test('status exposes bounded cohort progress without contracts, raw keys or claim owners',async()=>{
    const status=await rpc(db,'edgar_cftc_history_status',[ns]);assert.equal(status.enabled,true);assert.equal(status.initialSecCycle,'2026-09-14');
    assert.equal(status.jobs.length,1);const row=status.jobs[0];assert.equal(row.family,'tff');assert.equal(row.reportDate,'2026-09-08');assert.equal(row.catalogHash,'a'.repeat(64));
    assert.deepEqual(row.shardIndexes,[0]);assert.equal(row.shards,1);assert.equal(row.running,1);assert.deepEqual(row.counters,{contracts:2,visited:1,prepared:1,limited:0,failed:0});
    assert.doesNotMatch(JSON.stringify(status),/12460|13874|cftc-history-v1:|owner|generation/);
  });
  await t.test('dead shards mark untouched contracts unavailable without counting failures twice',async()=>{
    await db.query("update public.edgar_ingestion_jobs set state='dead',owner=null,lease_until=null,checkpoint=$2 where id=$1",[j,{...checkpoint,cursor:0,prepared:0,failures:[]}]);
    let status=await rpc(db,'edgar_cftc_history_status',[ns]);
    assert.equal(status.jobs[0].dead,1);assert.deepEqual(status.jobs[0].counters,{contracts:2,visited:2,prepared:0,limited:0,failed:2});
    await db.query('update public.edgar_ingestion_jobs set checkpoint=$2 where id=$1',[j,{...checkpoint,cursor:2,prepared:1,limited:1,failures:[{code:'13874A'}]}]);
    status=await rpc(db,'edgar_cftc_history_status',[ns]);
    assert.deepEqual(status.jobs[0].counters,{contracts:2,visited:2,prepared:1,limited:1,failed:1});
  });
  await t.test('eligible SEC coverage resumes earlier shard before older-available later shard; cooldown still excludes it',async()=>{
    const earlierKey='sec-coverage-v1:2026-09-14:28:fixture',laterKey='sec-coverage-v1:2026-09-14:29:fixture';
    const earlier=await rpc(db,'edgar_enqueue_job',[ns,'sec','sec-coverage-v1:shard:28',earlierKey,{cursor:15},4]);
    const later=await rpc(db,'edgar_enqueue_job',[ns,'sec','sec-coverage-v1:shard:29',laterKey,{cursor:0},4]);
    await db.query("update public.edgar_ingestion_jobs set available_at=clock_timestamp()-interval '1 second' where id=$1",[earlier]);
    await db.query("update public.edgar_ingestion_jobs set available_at=clock_timestamp()-interval '1 hour' where id=$1",[later]);
    const selected=await rpc(db,'edgar_claim_job_prefix',[ns,'sec',randomUUID(),'sec-coverage-v1:',120]);
    assert.equal(selected.id,earlier);assert.equal(selected.checkpoint.cursor,15);
    assert.equal(await rpc(db,'edgar_yield_job',[ns,{...token(selected),id:earlier},{cursor:15},60]),true);
    const duringCooldown=await rpc(db,'edgar_claim_job_prefix',[ns,'sec',randomUUID(),'sec-coverage-v1:',120]);
    assert.equal(duringCooldown.id,later);
  });
  await t.test('CFTC prefix retains availability FIFO even when lexical shard order differs',async()=>{
    const lexicallyEarlier=await rpc(db,'edgar_enqueue_job',[ns,'cftc','history-refresh:futures-only:disaggregated:shard:00',`cftc-history-v1:2026-09-08:disaggregated:00:${'b'.repeat(16)}`,{},4]);
    const olderAvailable=await rpc(db,'edgar_enqueue_job',[ns,'cftc','history-refresh:futures-only:disaggregated:shard:31',`cftc-history-v1:2026-09-08:disaggregated:31:${'b'.repeat(16)}`,{},4]);
    await db.query("update public.edgar_ingestion_jobs set available_at=clock_timestamp()-interval '1 second' where id=$1",[lexicallyEarlier]);
    await db.query("update public.edgar_ingestion_jobs set available_at=clock_timestamp()-interval '1 hour' where id=$1",[olderAvailable]);
    const selected=await rpc(db,'edgar_claim_job_prefix',[ns,'cftc',randomUUID(),'cftc-history-v1:',120]);
    assert.equal(selected.id,olderAvailable);
  });
  await t.test('raw canonical claims bind one exact destination and preserve generation fencing',async()=>{
    const old=await begin(db);assert.equal(await reserve(db,old),true);assert.equal((await put(db,old,packed())).stored,true);
    for(const [wrongId,family] of [[id,'history'],['RAW-HISTORY:DISAGGREGATED:12460+:2026-09-08','cftc-history'],['RAW-HISTORY:TFF:13874A:2026-09-08','cftc-history'],['RAW-HISTORY:TFF:12460+:2026-09-01','cftc-history'],['MARKETS:TFF:LATEST','history']])
      await assert.rejects(put(db,old,packed(),wrongId,family),/invalid_cache_fence_target/);
    await assert.rejects(reserve(db,{...old,key:key.replace('futures-only','combined')}),/invalid_cache_claim/);
    assert.equal(await rpc(db,'edgar_release_write',[ns,'cftc',key,token(old)]),true);
    const newer=await begin(db);assert.equal(await reserve(db,newer),true);
    await assert.rejects(put(db,old,packed({revision:2})),{code:'40001'});
    assert.equal((await put(db,newer,packed({revision:3}))).stored,true);
    assert.equal((await rpc(db,'edgar_cache_put',[ns,...cacheArgs(packed({revision:4}))])).reason,'fenced');
  });
  await t.test('market claim serves protected snapshot and both deployment generations of raw cache family',async()=>{
    const market=await begin(db,'markets:tff:latest');assert.equal(await reserve(db,market),true);
    assert.equal((await put(db,market,packed(),'MARKETS:TFF:LATEST','history')).stored,true);
    await assert.rejects(put(db,market,packed(),'MARKETS:TFF:LATEST','cftc-history'),/invalid_cache_fence_target/);
    assert.equal((await put(db,market,packed(),'RAW-HISTORY:TFF:ABC+:2026-09-08','cftc-history')).stored,true);
    assert.equal((await put(db,market,packed(),'RAW-HISTORY:TFF:ABC+:2026-09-08','history')).stored,true);
    const rows=(await db.query(`select f.family,f.used_rows=(select count(*) from edgar_private.cache_entries e where e.namespace=f.namespace and e.family=f.family) row_ok,
      f.used_bytes=coalesce((select sum(e.stored_bytes) from edgar_private.cache_entries e where e.namespace=f.namespace and e.family=f.family),0) bytes_ok from edgar_private.cache_families f`)).rows;
    assert.ok(rows.every(r=>r.row_ok&&r.bytes_ok));
  });
});
