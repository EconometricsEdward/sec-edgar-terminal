import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { runBankWorker } from '../src/utils/bank/worker.js';
import { SCOPE_MAPPING_VERSION } from '../src/utils/bank/catalog.js';

const period='2026-06-30';
const template=await readFile(new URL('./fixtures/bank-451965-2026-06-30.xml',import.meta.url),'utf8');
function syntheticCblr(id,date=period){
  // Synthetic election/identities for a migration rehearsal, not an assertion
  // that the real bank represented by the numerical template elects CBLR.
  let xml=template.replace(/<!--[\s\S]*?-->/g,'').replaceAll('451965',String(id)).replaceAll(period,date);
  for(const code of ['RCFA3792','RCFAA223','RCFAP793','RCFA7206','RCFA7205'])xml=xml.replace(new RegExp(`<cc:${code}[^>]*>[\\s\\S]*?</cc:${code}>`,'g'),'');
  return xml.replace('</xbrl>',`<cc:RCOALE74 contextRef="CI_${id}_${date}" unitRef="NON-MONETARY">1</cc:RCOALE74></xbrl>`);
}

test('version-gated retained-source repair is bounded, fenced and cannot downgrade amendment jobs',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema edgar_private;grant usage on schema edgar_private,public to service_role;');
  const dir=new URL('../supabase/migrations/',import.meta.url);
  for(const file of(await readdir(dir)).filter(f=>/ffiec_bank|bankscope/.test(f)).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  const op=async(name,p={})=>(await db.query('select public.bank_scope_operation($1,$2::jsonb) x',[name,JSON.stringify(p)])).rows[0].x;
  await db.query("update edgar_private.bank_pilot_control set catalog=jsonb_build_object('periods',jsonb_build_array($1::text))",[period]);
  async function seed(id,{status='ready',form='031',date=period,version='ffiec-bankscope-v2',desired='original',submission='original',owner=null,normalized=true}={}){
    const raw=syntheticCblr(id,date),hash=createHash('sha256').update(raw).digest('hex');
    await db.query(`insert into edgar_private.bank_institutions(id_rssd,legal_name,fdic_certificate,institution_status,identity_source,last_verified_at)
      values($1,$2,$1,'active','{}',now())`,[id,`SYNTHETIC BANK ${id}`]);
    await db.query(`insert into edgar_private.bank_panel_entries values($1,$2,$3,true,$4,'{}')`,[id,date,form,desired]);
    await db.query(`insert into edgar_private.bank_call_reports(institution_id,id_rssd,report_date,submission_date_raw,retrieved_at,source_sha256,form_type,raw_xbrl,parser_version,validation,source_metadata)
      select id,$1,$2,$3,now(),$4,$5,$6,$7,'{"passed":false}','{}' from edgar_private.bank_institutions where id_rssd=$1`,[id,date,submission,hash,form,raw,version]);
    await db.query(`insert into edgar_private.bank_preparation_jobs(id_rssd,report_date,desired_submission,status,owner,attempts)
      values($1,$2,$3,$4,$5,2)`,[id,date,desired,status,owner]);
    if(normalized)await db.query(`insert into edgar_private.bank_call_report_metrics
      select id,'assets','RC',array['RCFD2170'],'[]',1907928000000,'USD',report_date,id_rssd,'{}'
      from edgar_private.bank_call_reports where id_rssd=$1`,[id]);
  }
  const activeOwner=randomUUID();
  await seed(1001);await seed(1002,{status:'review'});
  await seed(1003,{form:'041'});await seed(1004,{form:'051'});
  await seed(1005,{date:'2025-06-30'});
  await seed(1006,{status:'review',desired:'newer amendment'});
  await seed(1007,{status:'queued',desired:'newer amendment'});
  await seed(1008,{status:'running',owner:activeOwner,desired:'newer amendment'});
  await seed(1009,{version:SCOPE_MAPPING_VERSION});
  await seed(1010,{status:'review',normalized:false}); // Source retained, parser failed: mapping cannot fix it.
  await seed(1011,{version:'ffiec-bankscope-v99'}); // An older worker must not downgrade a future mapping.
  for(let id=1100;id<1117;id++)await seed(id);
  const jobs=async()=>Object.fromEntries((await db.query('select id_rssd,status,owner,attempts,desired_submission,last_error from edgar_private.bank_preparation_jobs')).rows.map(j=>[j.id_rssd,j]));

  await db.query("update edgar_private.bank_pilot_control set owner=$1,lease_until=now()+interval '1 hour'",[activeOwner]);
  assert.equal((await op('begin',{owner:randomUUID(),mappingVersion:SCOPE_MAPPING_VERSION})).allowed,false);
  assert.equal((await jobs())[1008].owner,activeOwner);
  assert.equal((await jobs())[1008].status,'running');
  await op('finish',{owner:activeOwner});
  const oldOwner=randomUUID();assert.equal((await op('begin',{owner:oldOwner})).allowed,true);
  assert.equal((await jobs())[1001].status,'ready');assert.equal((await jobs())[1002].status,'review');
  await op('finish',{owner:oldOwner});

  const owner=randomUUID();assert.equal((await op('begin',{owner,mappingVersion:SCOPE_MAPPING_VERSION})).allowed,true);
  let state=await jobs();
  assert.equal(Object.values(state).filter(j=>j.last_error==='mapping_version_refresh').length,16);
  for(const id of[1001,1002]){assert.equal(state[id].status,'queued');assert.equal(state[id].attempts,0);assert.equal(state[id].desired_submission,'original');}
  for(const id of[1003,1004,1005,1009,1011])assert.equal(state[id].status,'ready');
  assert.equal(state[1010].status,'review');assert.equal(state[1010].last_error,null);
  assert.equal(state[1006].status,'review');assert.equal(state[1006].desired_submission,'newer amendment');
  assert.equal(state[1007].status,'queued');assert.equal(state[1007].desired_submission,'newer amendment');
  assert.equal(state[1008].desired_submission,'newer amendment');
  assert.equal(state[1008].last_error,null);
  await op('finish',{owner});

  // The first source is republished in place using retained bytes. Any accidental
  // FFIEC request fails the test, and correction does not reset source clocks.
  const before=(await db.query('select source_sha256,retrieved_at from edgar_private.bank_call_reports where id_rssd=1001')).rows[0];
  let sourceCalls=0;
  const result=await runBankWorker({store:async(name,p)=>{if(name==='source')sourceCalls++;return op(name,p);},peers:false,maxFilings:1,
    clientFactory:()=>assert.fail('Mapping repair must reuse the retained XML'),invalidateRead:async()=>{}});
  assert.equal(result.stored,1);assert.equal(result.reused,1);assert.equal(sourceCalls,1);
  const after=(await db.query('select parser_version,source_sha256,retrieved_at,validation from edgar_private.bank_call_reports where id_rssd=1001')).rows[0];
  assert.equal(after.parser_version,SCOPE_MAPPING_VERSION);assert.equal(after.validation.passed,true);
  assert.equal(after.source_sha256,before.source_sha256);assert.equal(String(after.retrieved_at),String(before.retrieved_at));
  state=await jobs();assert.equal(state[1001].status,'ready');
  const finalOwner=randomUUID();await op('begin',{owner:finalOwner,mappingVersion:SCOPE_MAPPING_VERSION});
  assert.equal((await jobs())[1001].status,'ready','Already-corrected sources are not queued repeatedly');
  await op('finish',{owner:finalOwner});
  for(const role of['anon','authenticated'])assert.equal((await db.query(`select has_function_privilege('${role}','public.bank_scope_call_operation(text,jsonb)','execute') allowed`)).rows[0].allowed,false);
});
