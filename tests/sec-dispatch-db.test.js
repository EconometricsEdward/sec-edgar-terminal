/** Exact SQL permit/privilege tests. PGlite serializes one backend; this does not
 * establish hosted concurrency, round-trip latency, or throughput. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const ns='production';
const types={edgar_acquire_sec_dispatch:['text','uuid'],edgar_release_sec_dispatch:['text','uuid','integer'],edgar_publish_sec_cooldown:['text','integer']};
async function role(db,r,fn){await db.exec(`set role ${r}`);try{return await fn();}finally{await db.exec('reset role');}}
async function rpc(db,name,args){return role(db,'service_role',async()=> (await db.query(`select public.${name}(${types[name].map((t,i)=>`$${i+1}::${t}`).join(',')}) value`,args)).rows[0].value);}
const acquire=(db,owner=randomUUID(),namespace=ns)=>rpc(db,'edgar_acquire_sec_dispatch',[namespace,owner]);
const release=(db,owner,ms=0,namespace=ns)=>rpc(db,'edgar_release_sec_dispatch',[namespace,owner,ms]);
const cooldown=(db,ms,namespace=ns)=>rpc(db,'edgar_publish_sec_cooldown',[namespace,ms]);
const control=async db=>(await db.query('select * from edgar_private.sec_dispatch_control')).rows[0];
async function database(){
 const db=new PGlite();await db.exec('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to service_role;');
 const dir=new URL('../supabase/migrations/',import.meta.url);const files=(await readdir(dir)).filter(n=>n.endsWith('_edgar_sec_dispatch_gate.sql'));assert.equal(files.length,1);
 await db.exec(await readFile(new URL(files[0],dir),'utf8'));return db;
}
// Owner-only fixture advancement simulates elapsed time without sleeping.
async function handoffComplete(db){await db.exec("with stamp as(select clock_timestamp()-interval '11 minutes' t) update edgar_private.sec_dispatch_control set activated_at=stamp.t,handoff_until=stamp.t+interval '10 minutes',next_dispatch_at=stamp.t,cooldown_until=null from stamp");}
async function ready(db){await db.exec("update edgar_private.sec_dispatch_control set owner=null,lease_until=null,next_dispatch_at=clock_timestamp()-interval '1 second',cooldown_until=null");}
function denied(value,isCooldown=true){assert.equal(value.allowed,false);assert.equal(value.owner,null);assert.equal(value.acquiredAt,null);assert.equal(value.expiresAt,null);assert.equal(value.leaseMs,5000);assert.equal(value.cooldown,isCooldown);assert.ok(Number.isInteger(value.waitMs)&&value.waitMs>=1&&value.waitMs<=600000);}

test('private SEC dispatch SQL enforces explicit handoff, owner fencing, spacing and global cooldown',async t=>{
 const db=await database();t.after(()=>db.close());let first;
 await t.test('unarmed calls never auto-enable the gate and other namespaces cannot create independent budgets',async()=>{
  for(let i=0;i<3;i++){const value=await acquire(db);denied(value);assert.equal(value.waitMs,300000);}
  assert.equal((await control(db)).activated_at,null);assert.equal((await control(db)).grants,0);
  assert.equal(await cooldown(db,1000),true);assert.equal((await control(db)).activated_at,null);
  for(const namespace of [null,'','preview','other','Production','production ']){await assert.rejects(acquire(db,randomUUID(),namespace),/invalid_sec_dispatch_request/);await assert.rejects(cooldown(db,1000,namespace),/invalid_sec_dispatch_cooldown/);}
  assert.equal((await db.query('select count(*) n from edgar_private.sec_dispatch_control')).rows[0].n,1);
 });
 await t.test('invoker RPCs deny browsers; service role cannot arm, shorten, insert or delete handoff',async()=>{
  const rows=(await db.query("select p.oid,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])",[Object.keys(types)])).rows;
  assert.equal(rows.length,3);for(const row of rows){assert.equal(row.prosecdef,false);assert.ok(row.proconfig.includes('search_path=""'));for(const r of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') allowed",[r,row.oid])).rows[0].allowed,false);}
  for(const r of ['anon','authenticated']){await assert.rejects(role(db,r,()=>db.query('select * from edgar_private.sec_dispatch_control')),/permission denied/);await assert.rejects(role(db,r,()=>db.query('select public.edgar_acquire_sec_dispatch($1,$2::uuid)',[ns,randomUUID()])),/permission denied/);}
  await assert.rejects(role(db,'service_role',()=>db.exec("update edgar_private.sec_dispatch_control set activated_at=now(),handoff_until=now()+interval '10 minutes'")),/permission denied/);
  await assert.rejects(role(db,'service_role',()=>db.exec('delete from edgar_private.sec_dispatch_control')),/permission denied/);
  await assert.rejects(role(db,'service_role',()=>db.exec("insert into edgar_private.sec_dispatch_control(namespace) values('production')")),/permission denied/);
 });
 await t.test('owner arming starts ten full minutes that acquire and provider cooldown cannot shorten',async()=>{
  await db.exec("with stamp as(select clock_timestamp() t) update edgar_private.sec_dispatch_control set activated_at=stamp.t,handoff_until=stamp.t+interval '10 minutes' from stamp where activated_at is null");
  const value=await acquire(db);denied(value);assert.ok(value.waitMs>599000);const initial=(await control(db)).handoff_until;
  await cooldown(db,1);denied(await acquire(db));assert.deepEqual((await control(db)).handoff_until,initial);
  await assert.rejects(db.exec("update edgar_private.sec_dispatch_control set handoff_until=activated_at+interval '1 minute'"),/violates check constraint/);
  await handoffComplete(db);
 });
 await t.test('one owner receives five seconds; other and duplicate acquisitions wait without renewing it',async()=>{
  first=await acquire(db);assert.equal(first.allowed,true);assert.equal(first.cooldown,false);assert.equal(first.waitMs,0);assert.equal(first.leaseMs,5000);
  assert.equal(Date.parse(first.expiresAt)-Date.parse(first.acquiredAt),5000);
  const blocked=await acquire(db);denied(blocked,false);assert.ok(blocked.waitMs<=50);denied(await acquire(db,first.owner),false);assert.equal((await control(db)).grants,1);
  assert.equal(await release(db,randomUUID(),300000),false);assert.equal((await control(db)).owner,first.owner);assert.equal((await control(db)).cooldown_until,null);
 });
 await t.test('valid release stores 143 ms spacing from server receipt and duplicate release is inert',async()=>{
  assert.equal(await release(db,first.owner),true);const row=await control(db);
  assert.equal(new Date(row.next_dispatch_at).getTime()-new Date(row.last_released_at).getTime(),143);assert.equal(row.owner,null);assert.equal(row.lease_until,null);assert.equal(await release(db,first.owner),false);
  // Assert stored absolute interval; also model a hold without relying on CI speed.
  await db.exec("update edgar_private.sec_dispatch_control set next_dispatch_at=clock_timestamp()+interval '143 milliseconds'");denied(await acquire(db),false);await ready(db);
 });
 await t.test('expired owner cannot release a replacement or mutate its cooldown',async()=>{
  const old=await acquire(db);await db.exec("update edgar_private.sec_dispatch_control set lease_until=clock_timestamp()-interval '1 second'");assert.equal(await release(db,old.owner,300000),false);
  const replacement=await acquire(db);assert.equal(replacement.allowed,true);assert.notEqual(replacement.owner,old.owner);
  assert.equal(await release(db,old.owner,300000),false);assert.equal((await control(db)).owner,replacement.owner);assert.equal((await control(db)).cooldown_until,null);
  assert.equal(await release(db,replacement.owner,1234),true);const row=await control(db);assert.equal(new Date(row.cooldown_until).getTime()-new Date(row.last_released_at).getTime(),1234);denied(await acquire(db));await ready(db);
 });
 await t.test('late provider responses extend a global hold without removing another current owner',async()=>{
  const holder=await acquire(db);assert.equal(await cooldown(db,300000),true);const before=await control(db);assert.equal(before.owner,holder.owner);
  assert.equal(await cooldown(db,1),true);const after=await control(db);assert.equal(new Date(after.cooldown_until).getTime(),new Date(before.cooldown_until).getTime());assert.equal(after.owner,holder.owner);
  denied(await acquire(db));assert.equal(await release(db,holder.owner),true);denied(await acquire(db));await ready(db);
 });
 await t.test('malformed, null and excessive inputs leave permit state unchanged',async()=>{
  for(const owner of [null,'00000000-0000-0000-0000-000000000000','invalid']){await assert.rejects(acquire(db,owner));await assert.rejects(release(db,owner));}
  for(const ms of [null,-1,300001])await assert.rejects(release(db,randomUUID(),ms),/invalid_sec_dispatch_release/);
  for(const ms of [null,0,-1,300001])await assert.rejects(cooldown(db,ms),/invalid_sec_dispatch_cooldown/);
  const value=await acquire(db);assert.equal(value.allowed,true);assert.equal(await release(db,value.owner),true);
 });
 await t.test('queued requests on the isolated backend receive only one owner',async()=>{
  await ready(db);const owners=Array.from({length:10},()=>randomUUID());const rows=await role(db,'service_role',()=>Promise.all(owners.map(owner=>db.query('select public.edgar_acquire_sec_dispatch($1,$2::uuid) value',[ns,owner]))));
  const grants=rows.map(row=>row.rows[0].value).filter(value=>value.allowed);assert.equal(grants.length,1);assert.equal((await control(db)).owner,grants[0].owner);
 });
});
