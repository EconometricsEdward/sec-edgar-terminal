/** Exact private registry migration in isolated PGlite; no hosted mutations. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { secCoverageFingerprint } from '../src/utils/secCoverageMembership.js';

const ns='production';
const sha=value=>createHash('sha256').update(value).digest('hex');
const seed=JSON.parse(await readFile(new URL('../src/data/sec-coverage-2026-09-08.json',import.meta.url),'utf8'));
const functions={
  edgar_coverage_registry:['text'], edgar_begin_membership_check:['text','uuid'],
  edgar_stage_membership:['text','jsonb','jsonb','jsonb'], edgar_activate_membership:['text','jsonb','text'],
  edgar_finish_membership_check:['text','jsonb','text'], edgar_membership_admission:['text','text[]'],
  edgar_enqueue_current_coverage_jobs:['text','text','integer[]'],
};
async function role(db,name,fn){ await db.exec(`set role ${name}`);try{return await fn();}finally{await db.exec('reset role');} }
async function rpc(db,name,args){return role(db,'service_role',async()=> (await db.query(`select public.${name}(${functions[name].map((type,i)=>`$${i+1}::${type}`).join(',')}) value`,args)).rows[0].value);}
async function database({legacy=false}={}){
 const db=new PGlite({extensions:{pgcrypto}});
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 create schema extensions;create extension pgcrypto with schema extensions;
 create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,created_at timestamptz default now(),unique(bucket_id,name));
 grant usage on schema extensions,storage,public to service_role;grant select on storage.objects to service_role;`);
 const dir=new URL('../supabase/migrations/',import.meta.url); const files=await readdir(dir);
 for(const suffix of ['20260913031639_edgar_staged_data_store.sql','_edgar_coverage_batch_reads_jobs.sql','_edgar_membership_registry.sql']){
  const matches=files.filter(name=>name.endsWith(suffix));assert.equal(matches.length,1);
  if(legacy && suffix==='_edgar_membership_registry.sql'){
   await db.query('select public.edgar_enqueue_coverage_jobs($1,$2,$3,null)',[ns,new Date().toISOString().slice(0,10),'8907093474889e5e']);
  }
  await db.exec(await readFile(new URL(matches[0],dir),'utf8'));
 }
 return db;
}
async function due(db){await db.exec("update edgar_private.membership_control set next_check_at=clock_timestamp()-interval '1 second'");}
const begin=async db=>{await due(db);return rpc(db,'edgar_begin_membership_check',[ns,randomUUID()]);};
const registry=db=>rpc(db,'edgar_coverage_registry',[ns]);
function candidate(issuers=seed.issuers){
 const snapshot=structuredClone(seed);snapshot.issuers=structuredClone(issuers);
 snapshot.issuers.sort((a,b)=>a.ticker.localeCompare(b.ticker));
 snapshot.securities=snapshot.issuers.flatMap(row=>row.aliases.map(ticker=>({ticker,cik:row.cik}))).sort((a,b)=>a.ticker.localeCompare(b.ticker));
 snapshot.reference.asOf=new Date().toISOString().slice(0,10);snapshot.reference.checkedAt=new Date().toISOString();
 snapshot.mapping.sourceSha256=sha('SEC mapping fixture');snapshot.mapping.checkedAt=new Date().toISOString();
 snapshot.membershipFingerprint=secCoverageFingerprint(snapshot.issuers);
 snapshot.id=`sec-coverage-v1:ivv:${snapshot.reference.asOf}:${snapshot.membershipFingerprint.slice(0,16)}`;
 snapshot.issuerCount=snapshot.issuers.length;snapshot.securityCount=snapshot.securities.length;
 const raw=Buffer.from(`Dated public source fixture ${snapshot.id}`);const gzip=gzipSync(raw);
 snapshot.sourceSnapshot={path:'membership/ivv.csv.gz',sha256:sha(raw)};
 return {snapshot,evidence:{rawSha256:sha(raw),rawBytes:raw.length,gzipSha256:sha(gzip),gzipBase64:gzip.toString('base64')}};
}
const stage=(db,claim,c)=>rpc(db,'edgar_stage_membership',[ns,claim,c.snapshot,c.evidence]);
async function prepared(db,ciks){
 // Deterministic source and financial fixtures mirror the publication metadata contract.
 await db.query(`with issuers as(select unnest($1::text[]) cik), sources as(
 select cik,resource,'sec-documents-v1:CIK'||cik||':'||resource key,
 encode(extensions.digest(cik||':'||resource,'sha256'),'hex') hash,
 case when resource='submissions' then 'https://data.sec.gov/submissions/CIK'||cik||'.json' else 'https://data.sec.gov/api/xbrl/companyfacts/CIK'||cik||'.json' end url
 from issuers cross join unnest(array['submissions','companyfacts']) resource),
 objects as(insert into storage.objects(bucket_id,name,metadata) select 'edgar-durable-private','production/sec/source/'||hash||'.json.gz','{"size":30}'::jsonb from sources returning name),
 assets as(insert into public.edgar_source_assets(namespace,dataset,content_hash,bucket,object_path,raw_bytes,stored_bytes,source_url,source_id,entity_id,fetched_at,content_type,encoding)
 select 'production','sec',hash,'edgar-durable-private','production/sec/source/'||hash||'.json.gz',50,30,url,'sec-edgar',cik,now(),'application/json','gzip' from sources
 returning id,content_hash),
 versions as(insert into public.edgar_dataset_versions(namespace,dataset,resource_key,identity_hash,content_hash,schema_version,parser_version,publication_generation,payload,raw_bytes,stored_bytes,source_asset_id,metadata,fetched_at)
 select 'production','sec',s.key,s.hash,s.hash,'1','sec-documents-v1',1,jsonb_build_object('cik',s.cik),50,30,a.id,
 jsonb_build_object('entityId',s.cik,'resource',s.resource,'documentContentHash',s.hash),now() from sources s join assets a on a.content_hash=s.hash returning id,resource_key)
 insert into public.edgar_dataset_heads(namespace,dataset,resource_key,current_version,revalidated_at,expires_at)
 select 'production','sec',resource_key,id,now(),now()+interval '25 hours' from versions`,[ciks]);
 await db.query(`with issuers as(select unnest($1::text[]) cik), views as(
 select cik,'financial-analysis-v1:analysis-v1.4:context-v3:CIK'||cik||':'||basis||':latest' key,basis,'analysis' family from issuers cross join unnest(array['annual','quarter','ytd','ttm']) basis
 union all select cik,'research-compare-v1:compare-v2:context-v3:CIK'||cik||':'||basis||':latest',basis,'compare' from issuers cross join unnest(array['annual','quarter','ttm']) basis
 union all select cik,'research-portfolio-v1:analysis-v1.4:context-v3:CIK'||cik||':'||basis||':latest',basis,'portfolio' from issuers cross join unnest(array['annual','quarter','ytd','ttm']) basis),
 versions as(insert into public.edgar_dataset_versions(namespace,dataset,resource_key,identity_hash,content_hash,schema_version,publication_generation,payload,raw_bytes,stored_bytes,metadata,fetched_at)
 select 'production','financial',key,encode(extensions.digest(key,'sha256'),'hex'),encode(extensions.digest(key,'sha256'),'hex'),'1',1,'{}'::jsonb,50,30,
 jsonb_build_object('entityId',cik,'basis',basis,'calculationVersion',case when family='compare' then 'compare-v2:context-v3' else 'analysis-v1.4:context-v3' end,'parserVersion',case when family='analysis' then 'financial-analysis-v1' else 'research-serving-v1' end,'financialInputHash',repeat('a',64),'metricProjectionVersion','latest-all-v1',
 'inputDocuments',(select jsonb_agg(jsonb_build_object('key',h.resource_key,'contentHash',v.metadata->>'documentContentHash','versionId',v.id,'generation',v.publication_generation))
 from public.edgar_dataset_heads h join public.edgar_dataset_versions v on v.id=h.current_version where h.namespace='production' and h.dataset='sec' and h.resource_key in('sec-documents-v1:CIK'||cik||':submissions','sec-documents-v1:CIK'||cik||':companyfacts'))),now() from views returning id,resource_key)
 insert into public.edgar_dataset_heads(namespace,dataset,resource_key,current_version,revalidated_at,expires_at)
 select 'production','financial',resource_key,id,now(),now()+interval '25 hours' from versions`,[ciks]);
}

test('private membership SQL validates, fences, prepares before activation, and freezes daily work',async t=>{
 const db=await database();t.after(()=>db.close());
 let claim, currentCandidate;
 await t.test('seed is exact and does not fabricate original CSV evidence',async()=>{
  assert.deepEqual((await registry(db)).active,seed);
  const row=(await db.query('select evidence_kind,gzip_bytes,raw_bytes from edgar_private.membership_snapshots')).rows[0];
  assert.equal(row.evidence_kind,'reviewed-repository-seed');assert.equal(row.gzip_bytes,null);assert.equal(row.raw_bytes,null);
  assert.equal((await db.query('select edgar_private.membership_fingerprint($1::jsonb) f',[seed.issuers])).rows[0].f,seed.membershipFingerprint);
 });
 await t.test('all RPCs are invoker-only and browser roles cannot execute or read registry tables',async()=>{
  const rows=(await db.query("select p.oid,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])",[Object.keys(functions)])).rows;
  assert.equal(rows.length,7);for(const row of rows){assert.equal(row.prosecdef,false);assert.ok(row.proconfig.includes('search_path=""'));for(const r of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') allowed",[r,row.oid])).rows[0].allowed,false);}
  for(const r of ['anon','authenticated']) await assert.rejects(role(db,r,()=>db.query('select * from edgar_private.membership_snapshots')),/permission denied/);
  await assert.rejects(role(db,'service_role',()=>db.exec("delete from edgar_private.membership_snapshots")),/permission denied/);
  await assert.rejects(rpc(db,'edgar_coverage_registry',['other']),/invalid_membership_namespace/);
 });
 await t.test('one owner leases due work; active lease and future due time suppress duplicate checks',async()=>{
  claim=await begin(db);assert.ok(claim.owner);assert.equal(claim.generation,1);
  assert.equal(await rpc(db,'edgar_begin_membership_check',[ns,randomUUID()]),null);
  assert.equal(await rpc(db,'edgar_finish_membership_check',[ns,{...claim,owner:randomUUID()},null]),false);
 });
 await t.test('malformed dates, mappings, aliases, identities, evidence and turnover fail without staging',async()=>{
  const mutations=[
   c=>{c.snapshot.reference.url='https://example.org/holdings.csv';},
   c=>{c.snapshot.reference.asOf='2020-01-01';},
   c=>{c.snapshot.reference.checkedAt='2001-01-01T00:00:00Z';},
   c=>{c.snapshot.issuerCount=499;},
   c=>{c.snapshot.issuers[1].cik=c.snapshot.issuers[0].cik;},
   c=>{c.snapshot.issuers[1].aliases.push(c.snapshot.issuers[0].ticker);},
   c=>{c.snapshot.issuers[0].sector='Invented';},
   c=>{c.snapshot.membershipFingerprint='f'.repeat(64);},
   c=>{c.evidence.gzipSha256='a'.repeat(64);},
   c=>{c.evidence.rawBytes=750001;},
   c=>{c.snapshot.mapping.sourceSha256='no';},
   c=>{c.snapshot.sourceExclusions=[{ticker:'RESIDUAL',name:'Residual',exchange:'NASDAQ',currency:'USD',marketValueUsd:1,weightPercent:0,reason:'Unlisted residual holding, excluded from listed-security research coverage.'}];},
  ];
  for(const mutate of mutations){const c=candidate();mutate(c);await assert.rejects(stage(db,claim,c));assert.equal((await registry(db)).candidate,null);}
  const turnover=candidate([...seed.issuers.slice(26),...Array.from({length:26},(_,i)=>({ticker:`ZZ${i}`,cik:String(9900000+i).padStart(10,'0'),name:'Turnover test',sector:'Industrials',fund:'IVV',aliases:[`ZZ${i}`]}))]);await assert.rejects(stage(db,claim,turnover),/membership_turnover_review_required/);
  const reused=candidate(seed.issuers.map((r,i)=>i===0?{...r,cik:'0009999999'}:r));await assert.rejects(stage(db,claim,reused),/membership_ticker_reuse_review_required/);
 });
 await t.test('candidate source evidence is preserved while old active membership still serves',async()=>{
  const next=structuredClone(seed.issuers);next.shift();next.push({ticker:'ZZTEST',cik:'0009999999',name:'SQL test new issuer',sector:'Industrials',fund:'IVV',aliases:['ZZTEST']});
  currentCandidate=candidate(next);
  const staged=await stage(db,claim,currentCandidate);assert.equal(staged.staged,true);assert.equal(staged.activeId,seed.id);
  assert.equal((await registry(db)).candidate.id,currentCandidate.snapshot.id);
  const adm=await rpc(db,'edgar_membership_admission',[ns,['0009999999','0000002098','0000034088','0008888888']]);
  assert.deepEqual(adm.allowedCiks,['0000002098','0009999999']);assert.deepEqual(adm.sourceOnlyCiks,['0000034088']);
  const row=(await db.query('select raw_sha256,gzip_sha256,raw_bytes from edgar_private.membership_snapshots where id=$1',[currentCandidate.snapshot.id])).rows[0];assert.equal(row.raw_sha256,currentCandidate.evidence.rawSha256);assert.equal(row.gzip_sha256,currentCandidate.evidence.gzipSha256);
 });
 await t.test('failed readiness check is atomic and identifies missing issuer preparations',async()=>{
  const result=await rpc(db,'edgar_activate_membership',[ns,claim,currentCandidate.snapshot.id]);assert.equal(result.activated,false);assert.equal(result.neededCiks.length,501);
  const rotated=await rpc(db,'edgar_activate_membership',[ns,claim,currentCandidate.snapshot.id]);assert.equal(rotated.neededCiks[0],result.neededCiks[1]);assert.equal(rotated.neededCiks.at(-1),result.neededCiks[0]);
  assert.equal((await registry(db)).active.id,seed.id);assert.equal((await db.query('select count(*) n from edgar_private.membership_activations')).rows[0].n,1);
 });
 await t.test('daily jobs freeze the original active cohort exactly once before membership changes',async()=>{
  const today=new Date().toISOString().slice(0,10);const jobs=await rpc(db,'edgar_enqueue_current_coverage_jobs',[ns,today,null]);assert.equal(jobs.length,32);
  assert.equal((await db.query("select sum(jsonb_array_length(checkpoint->'companies')) n from public.edgar_ingestion_jobs")).rows[0].n,501);
  const rows=(await db.query('select checkpoint from public.edgar_ingestion_jobs')).rows;
  for(const {checkpoint:p} of rows){assert.equal(p.schema,2);assert.equal(p.universeCompanies,501);assert.equal(p.membershipId,seed.id);for(const c of p.companies){assert.equal(createHash('sha256').update(c.cik).digest().readUInt32BE(0)%32,p.shard);assert.equal(c.cik==='0009999999',false);}}
  assert.deepEqual(await rpc(db,'edgar_enqueue_current_coverage_jobs',[ns,today,null]),jobs);
  await assert.rejects(rpc(db,'edgar_enqueue_current_coverage_jobs',[ns,'2030-01-01',null]),/invalid_current_coverage_cycle/);
 });
 await t.test('fresh complete source lineage is required; corrupt projection and input hash stay pending',async()=>{
  await prepared(db,[...currentCandidate.snapshot.issuers.map(r=>r.cik),'0000002098']);
  const key='financial-analysis-v1:analysis-v1.4:context-v3:CIK0009999999:annual:latest';
  await db.query("update public.edgar_dataset_versions set metadata=jsonb_set(metadata,'{metricProjectionVersion}','\"old\"') where resource_key=$1",[key]);
  let result=await rpc(db,'edgar_activate_membership',[ns,claim,currentCandidate.snapshot.id]);assert.deepEqual(result.neededCiks,['0009999999']);
  await db.query("update public.edgar_dataset_versions set metadata=jsonb_set(metadata,'{metricProjectionVersion}','\"latest-all-v1\"') where resource_key=$1",[key]);
  await db.query("update public.edgar_dataset_versions set metadata=jsonb_set(metadata,'{inputDocuments,0,contentHash}',to_jsonb(repeat('b',64))) where resource_key=$1",[key]);
  result=await rpc(db,'edgar_activate_membership',[ns,claim,currentCandidate.snapshot.id]);assert.deepEqual(result.neededCiks,['0009999999']);
  await db.query("update public.edgar_dataset_versions v set metadata=jsonb_set(metadata,'{inputDocuments,0,contentHash}',(select sv.metadata->'documentContentHash' from public.edgar_dataset_heads h join public.edgar_dataset_versions sv on sv.id=h.current_version where h.namespace='production' and h.resource_key=v.metadata#>>'{inputDocuments,0,key}')) where v.resource_key=$1",[key]);
  await db.query("update public.edgar_dataset_heads set expires_at=now()-interval '1 second' where resource_key=$1",[key]);
  result=await rpc(db,'edgar_activate_membership',[ns,claim,currentCandidate.snapshot.id]);assert.deepEqual(result.neededCiks,['0009999999']);
  await db.query("update public.edgar_dataset_heads set expires_at=now()+interval '25 hours' where resource_key=$1",[key]);
 });
 await t.test('activation swaps only after every issuer is ready, retains departed data and frozen jobs',async()=>{
  const result=await rpc(db,'edgar_activate_membership',[ns,claim,currentCandidate.snapshot.id]);assert.equal(result.activated,true);assert.deepEqual(result.neededCiks,[]);
  const reg=await registry(db);assert.equal(reg.active.id,currentCandidate.snapshot.id);assert.equal(reg.candidate,null);assert.deepEqual(reg.retained,[seed.issuers[0]]);
  const adm=await rpc(db,'edgar_membership_admission',[ns,[seed.issuers[0].cik,'0009999999']]);assert.equal(adm.allowedCiks.length,2);
  assert.equal((await db.query('select count(*) n from edgar_private.membership_snapshots')).rows[0].n,2);
  assert.equal((await db.query('select count(*) n from edgar_private.membership_activations')).rows[0].n,2);
  await rpc(db,'edgar_enqueue_current_coverage_jobs',[ns,new Date().toISOString().slice(0,10),null]);
  assert.equal((await db.query('select count(*) n from public.edgar_ingestion_jobs')).rows[0].n,32);
  assert.equal((await db.query('select membership_id from edgar_private.coverage_cycles')).rows[0].membership_id,seed.id);
 });
 await t.test('finish releases leases, uses bounded error cooldown, and rejects expired generation',async()=>{
  assert.equal(await rpc(db,'edgar_finish_membership_check',[ns,claim,null]),true);
  assert.equal(await rpc(db,'edgar_begin_membership_check',[ns,randomUUID()]),null);
  const stale=claim;claim=await begin(db);assert.equal(claim.generation,2);
  await assert.rejects(stage(db,stale,currentCandidate),/membership_claim_lost/);
  assert.equal(await rpc(db,'edgar_finish_membership_check',[ns,stale,null]),false);
  for(let i=0;i<3;i++){if(i)claim=await begin(db);assert.equal(await rpc(db,'edgar_finish_membership_check',[ns,claim,'MEMBERSHIP_SOURCE_UNAVAILABLE']),true);}
  const reg=await registry(db);assert.equal(reg.control.errorCount,3);assert.ok(Date.parse(reg.control.nextCheckAt)>Date.now()+5*3600000);
  assert.equal(await rpc(db,'edgar_begin_membership_check',[ns,randomUUID()]),null);
 });
});


test('migration preserves the rollout day legacy cohort without enqueuing a duplicate refresh',async t=>{
 const db=await database({legacy:true});t.after(()=>db.close());
 const rows=(await db.query('select job_key,id,checkpoint from public.edgar_ingestion_jobs order by job_key')).rows;
 assert.equal(rows.length,32);assert.ok(rows.every(row=>row.checkpoint.schema===1));
 const jobs=await rpc(db,'edgar_enqueue_current_coverage_jobs',[ns,new Date().toISOString().slice(0,10),null]);
 assert.equal(jobs.length,32);assert.deepEqual(jobs.map(j=>j.id).sort(),rows.map(j=>j.id).sort());
 assert.ok(jobs.every(j=>j.universeVersion==='8907093474889e5e'));
 assert.equal((await db.query('select count(*) n from public.edgar_ingestion_jobs')).rows[0].n,32);
 assert.equal((await db.query('select membership_id from edgar_private.coverage_cycles')).rows[0].membership_id,seed.id);
});

test('expired candidate is held and can be replaced without deleting its archived evidence',async t=>{
 const db=await database();t.after(()=>db.close());const claim=await begin(db);
 // Simulate a snapshot admitted weeks earlier. Only fixture setup runs as owner;
 // production service_role has no UPDATE/DELETE grant on immutable snapshots.
 const archived=candidate();const oldDay=new Date(Date.now()-20*86400000).toISOString().slice(0,10);
 archived.snapshot.reference.asOf=oldDay;archived.snapshot.reference.checkedAt=`${oldDay}T12:00:00.000Z`;
 archived.snapshot.id=`sec-coverage-v1:ivv:${oldDay}:${archived.snapshot.membershipFingerprint.slice(0,16)}`;
 await db.query(`insert into edgar_private.membership_snapshots(namespace,id,source_as_of,fingerprint,snapshot,evidence_kind,raw_sha256,raw_bytes,gzip_sha256,gzip_bytes)
 values($1,$2,$3::date,$4,$5::jsonb,'gzip-csv',$6,$7,$8,decode($9,'base64'))`,[ns,archived.snapshot.id,oldDay,archived.snapshot.membershipFingerprint,archived.snapshot,archived.evidence.rawSha256,archived.evidence.rawBytes,archived.evidence.gzipSha256,archived.evidence.gzipBase64]);
 await db.query('update edgar_private.membership_control set candidate_id=$1 where namespace=$2',[archived.snapshot.id,ns]);
 await assert.rejects(rpc(db,'edgar_activate_membership',[ns,claim,archived.snapshot.id]),/membership_candidate_stale/);
 const fresh=candidate();const result=await stage(db,claim,fresh);assert.equal(result.staged,true);assert.equal(result.candidateId,fresh.snapshot.id);
 assert.equal((await registry(db)).active.id,seed.id);
 assert.equal((await db.query('select count(*) n from edgar_private.membership_snapshots where id=$1',[archived.snapshot.id])).rows[0].n,1);
 const before=(await db.query('select snapshot from edgar_private.membership_snapshots where id=$1',[fresh.snapshot.id])).rows[0].snapshot;
 fresh.snapshot.reference.checkedAt=new Date(Date.now()+1000).toISOString();
 await stage(db,claim,fresh);
 assert.deepEqual((await db.query('select snapshot from edgar_private.membership_snapshots where id=$1',[fresh.snapshot.id])).rows[0].snapshot,before);
});
