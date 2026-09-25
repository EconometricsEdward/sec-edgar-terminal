import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { normalizePeerRecord,fetchPeerUniverse } from '../src/utils/bank/peerSource.js';
import { buildPeerAnalysis,peerDistribution,peerDistance } from '../src/utils/bank/peerModel.js';
import { parseUbprXbrl } from '../src/utils/bank/ubpr.js';
import { createPeerApi } from '../src/utils/bank/peerApi.js';
import { createPeerService } from '../src/utils/bank/peerService.js';
import { prepareUbpr } from '../src/utils/bank/peerWorker.js';
const period='2026-06-30';
const raw=(rssd=101)=>({RSSDID:rssd,CERT:rssd,REPDTE:'20260630',ASSET:100000,LNLSGR:60000,LNRE:30000,LNCI:15000,LNCON:9000,DEP:80000,DEPDOM:80000,DEPNI:20000,BRO:4000,ROA:1.2,ROE:12,NIMY:3.5,RBC1AAJ:10,NCLNLSR:0,NTLNLSR:-.1});
test('FDIC matching preserves units, true zero, negative recoveries and missing input coverage',()=>{
  const profile=normalizePeerRecord(raw(),period);
  assert.equal(profile.assets,100000);assert.equal(profile.metrics.noncurrent,0);assert.equal(profile.metrics.chargeoffs,-.1);
  assert.deepEqual(profile.loanMix,[.5,.25,.15,.09999999999999998]);assert.deepEqual(profile.funding,[.8,.25,.05]);
  assert.equal(normalizePeerRecord({...raw(),ROA:'',LNCON:null},period).metrics.roa,null);
  assert.equal(normalizePeerRecord({...raw(),LNCON:null},period).loanMix,null);
  assert.equal(normalizePeerRecord({...raw(),REPDTE:'20260331'},period),null);
});
test('universe loader rejects truncated, duplicate and wrong-quarter responses',async()=>{
  const rows=Array.from({length:1000},(_,i)=>({data:raw(i+1)}));
  const body={meta:{total:1000,index:{name:'official-version'}},data:rows};
  const fetchImpl=async()=>Response.json(body);
  assert.equal((await fetchPeerUniverse(period,{fetchImpl})).rows.length,1000);
  body.meta.total=1001;await assert.rejects(()=>fetchPeerUniverse(period,{fetchImpl}),{code:'peer_source_incomplete'});
  body.meta.total=1000;rows[999]=rows[0];await assert.rejects(()=>fetchPeerUniverse(period,{fetchImpl}),{code:'peer_source_duplicate'});
  rows[999]={data:{...raw(1000),REPDTE:'20260331'}};await assert.rejects(()=>fetchPeerUniverse(period,{fetchImpl}),{code:'peer_source_period_mismatch'});
});
test('peer matching excludes the subject, uses all three business dimensions, and ignores performance outcomes',()=>{
  const bank=normalizePeerRecord(raw(),period),clone={...bank,rssd:102,metrics:{roa:999}};
  assert.equal(peerDistance(bank,clone).score,0);
  assert.ok(peerDistance(bank,{...clone,assets:200000}).score>0);
  assert.ok(peerDistance(bank,{...clone,loanMix:[0,0,0,1]}).score>0);
  assert.ok(peerDistance(bank,{...clone,funding:[.1,.1,.1]}).score>0);
  const profiles=[bank,...Array.from({length:50},(_,i)=>({...clone,rssd:i+102,assets:100000+i}))];
  const analysis=buildPeerAnalysis({profiles},101);
  assert.equal(analysis.peers.length,30);assert.equal(analysis.peers[0].rssd,102);assert.equal(analysis.peers.some(p=>p.rssd===101),false);
  assert.equal(buildPeerAnalysis({profiles},999).status,'bank_not_covered');
  assert.equal(buildPeerAnalysis({profiles:[{...bank,loanMix:null}]},101).status,'insufficient_inputs');
});
test('distributions use same-cohort midranks, linear quartiles, valid counts and no zero filling',()=>{
  const peers=[0,0,1,2,3,null,undefined].map(x=>({metrics:{roa:x}}));
  const d=peerDistribution(peers,'roa',0);
  assert.equal(d.count,5);assert.equal(d.percentile,20);assert.equal(d.q1,0);assert.equal(d.median,1);assert.equal(d.q3,2);
  assert.equal(d.bins.reduce((n,b)=>n+b.count,0),5);
  assert.equal(peerDistribution(peers,'roa',-1).percentile,0);
  assert.equal(peerDistribution(peers,'roa',4).percentile,100);
  assert.equal(peerDistribution(peers,'roa',null).percentile,null);
  assert.equal(peerDistribution(peers.slice(0,4),'roa',1).available,false);
  const equal=peerDistribution(Array.from({length:5},()=>({metrics:{roa:0}})),'roa',0);
  assert.equal(equal.percentile,50);assert.ok(equal.domain[0]<equal.domain[1]);
});
test('large banks expand a disclosed asset range without inventing additional peers',()=>{
  const bank=normalizePeerRecord(raw(),period);
  const profiles=[bank,...Array.from({length:6},(_,i)=>({...bank,rssd:200+i,assets:bank.assets/5}))];
  const analysis=buildPeerAnalysis({profiles},101);
  assert.equal(analysis.assetBand,8);assert.equal(analysis.peers.length,6);assert.equal(analysis.status,'ready');
});
test('official UBPR XBRL uses published percentage scaling and strictly pins identity, quarter, unit and duplicate facts',async()=>{
  const xml=await readFile(new URL('./fixtures/ubpr-451965-2026-06-30.xml',import.meta.url),'utf8');
  const result=parseUbprXbrl(xml,{rssd:451965,period});
  assert.deepEqual(result.metrics.map(m=>m.value),[1.38,3.07,8.0181,1.04,.4]);
  assert.equal(result.peerStatisticsAvailable,false);
  assert.throws(()=>parseUbprXbrl(xml,{rssd:1,period}),{code:'source_identity_period_mismatch'});
  assert.throws(()=>parseUbprXbrl(xml,{rssd:451965,period:'2026-03-31'}),{code:'source_identity_period_mismatch'});
  const duplicate='<uc:UBPRE013 contextRef="CI_451965_2026-06-30" unitRef="PURE">99</uc:UBPRE013>';
  assert.throws(()=>parseUbprXbrl(xml.replace('</xbrl>',duplicate+'</xbrl>'),{rssd:451965,period}),{code:'ubpr_conflicting_facts'});
  assert.throws(()=>parseUbprXbrl('<!DOCTYPE x>'+xml,{rssd:451965,period}),{code:'ubpr_parsing_failure'});
});
test('UBPR worker reprocesses retained documents without another FFIEC download',async()=>{
  const xml=await readFile(new URL('./fixtures/ubpr-451965-2026-06-30.xml',import.meta.url),'utf8');let claimed=false,stored;
  const count=await prepareUbpr({deadline:Date.now()+100000,request:()=>assert.fail('must reuse source'),store:async()=>({rawXbrl:xml,retrievedAt:new Date().toISOString()}),
    owned:async(op,p)=>{if(op==='ubpr_claim'){if(claimed)return null;claimed=true;return {id_rssd:451965,report_date:period};}if(op==='ubpr_save')stored=p;}});
  assert.equal(count,1);assert.equal(stored.data.stage,'validated');assert.equal(stored.complete,true);
});
test('peer reader coalesces the quarterly universe and does not cache one bank’s official data for another',async()=>{
  const calls=[];const service=createPeerService({store:async(op,p)=>{calls.push([op,p]);return op==='peer_universe'?{snapshot:{},profiles:[]}:{status:String(p.rssd)};}});
  const [a,b]=await Promise.all([service(101,period),service(102,period)]);
  assert.equal(calls.filter(c=>c[0]==='peer_universe').length,1);assert.equal(a.ubpr.status,'101');assert.equal(b.ubpr.status,'102');
});
test('peer API validates parameters and throttles before analysis without exposing upstream errors',async()=>{
  let calls=0;const GET=createPeerApi({rateLimit:async()=>({allowed:true}),analyze:async()=>{calls++;throw Error('upstream secret');}});
  assert.equal((await GET(new Request('https://example.test/api/banks/peers?rssd=101&period=2026-07-01'))).status,400);assert.equal(calls,0);
  const response=await GET(new Request(`https://example.test/api/banks/peers?rssd=101&period=${period}`));
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/secret/);
});
test('peer SQL fences ingestion, publishes only complete identity-joined snapshots and shares FFIEC quotas',async()=>{
  const db=new PGlite();try{
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema edgar_private;grant usage on schema edgar_private,public to service_role;');
    const dir=new URL('../supabase/migrations/',import.meta.url);
    for(const file of (await readdir(dir)).filter(f=>/ffiec_bank|bankscope/.test(f)).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
    const op=async(name,p={})=>(await db.query('select public.bank_scope_operation($1,$2::jsonb) as x',[name,JSON.stringify(p)])).rows[0].x;
    const owner=randomUUID(),snapshotId=randomUUID();await op('begin',{owner});await op('periods',{owner,periods:[period]});
    const banks=Array.from({length:1000},(_,i)=>({rssd:i+1,name:`BANK ${i+1}`,form:'051',city:'TEST',state:'IN',fdic:i+1,filed:true,source:{ID_RSSD:i+1,FDICCertNumber:i+1,Name:`BANK ${i+1}`}}));
    for(let i=0;i<1000;i+=500)await op('catalog',{owner,period,banks:banks.slice(i,i+500),complete:i===500,reporterCount:1000});
    assert.equal((await op('request',{rssd:101,clientHash:'a'.repeat(64)})).queued,2);
    const start={owner,snapshotId,period,count:1000,url:'https://api.fdic.gov/banks/financials?test',sha256:'a'.repeat(64),sourceIndex:'v1',modelVersion:'bankscope-peers-2'};
    await assert.rejects(()=>op('peer_start',{...start,owner:randomUUID()}));await op('peer_start',start);
    const rows=banks.map(b=>({raw:raw(b.rssd),profile:normalizePeerRecord(raw(b.rssd),period)}));
    await op('peer_batch',{owner,snapshotId,rows:rows.slice(0,500)});
    assert.equal((await op('peer_universe',{period})).profiles.length,0);
    await assert.rejects(()=>op('peer_complete',{owner,snapshotId}));
    await assert.rejects(()=>op('peer_batch',{owner,snapshotId,rows:[{raw:raw(501),profile:{...rows[500].profile,rssd:9999}}]}));
    await op('peer_batch',{owner,snapshotId,rows:rows.slice(500)});await op('peer_complete',{owner,snapshotId});
    const universe=await op('peer_universe',{period});assert.equal(universe.profiles.length,1000);assert.equal(universe.profiles[0].name,'BANK 1');
    assert.equal((await op('peer_status')).snapshots[0].model_version,'bankscope-peers-2');
    assert.equal('raw_source' in universe.profiles[0],false);assert.equal('owner' in universe.snapshot,false);
    assert.equal((await op('reserve',{owner,method:'RetrieveUBPRXBRLFacsimile'})).allowed,true);
    assert.equal((await op('reserve',{owner,method:'RetrieveFacsimile'})).allowed,false);
    const job=await op('ubpr_claim',{owner});assert.equal(job.id_rssd,101);
    await op('ubpr_save',{owner,rssd:101,period,rawXbrl:'<xbrl/>',sha256:'b'.repeat(64),retrievedAt:new Date().toISOString(),data:{stage:'source_retained'},complete:true});
    assert.equal((await op('ubpr_read',{rssd:101,period})).status,'ready');
    assert.equal(await op('ubpr_source',{rssd:101,period,hash:'c'.repeat(64)}),null);
    await op('finish',{owner});
    // Fixtures represent completed historical, revised-current, legacy and staging versions.
    const prior='2026-03-31',priorId=randomUUID(),revisedId=randomUUID(),stagingId=randomUUID(),legacyId=randomUUID();
    await db.query("update edgar_private.bank_pilot_control set catalog=jsonb_set(catalog,'{periods}',$1::jsonb)",[JSON.stringify(['2026-09-30',period,prior,'2025-12-31','2025-09-30'])]);
    for(const [id,date,completed,version] of [[priorId,prior,true,'bankscope-peers-2'],[revisedId,period,true,'bankscope-peers-2'],[stagingId,prior,false,'bankscope-peers-2'],[legacyId,'2025-12-31',true,'bankscope-peers-1']]){
      await db.query(`insert into edgar_private.bank_peer_snapshots(id,report_date,owner,expected_count,received_count,matched_count,source_url,source_sha256,source_index,model_version,completed_at)
        select $1,$2::date,owner,expected_count,received_count,matched_count,source_url,source_sha256,source_index,$3,case when $4 then clock_timestamp() else null end from edgar_private.bank_peer_snapshots where id=$5`,[id,date,version,completed,snapshotId]);
      await db.query("insert into edgar_private.bank_peer_profiles select $1,id_rssd,jsonb_set(profile,'{metrics,roa}',$2::jsonb),raw_source from edgar_private.bank_peer_profiles where snapshot_id=$3",[id,id===priorId?'1.1':'99',snapshotId]);
    }
    const payload={rssd:101,period,snapshotId,peers:[2,3,4,5,6,7]},history=await op('peer_history',payload);
    assert.deepEqual(history.periods,['2025-09-30','2025-12-31',prior,period]);
    assert.deepEqual(history.snapshots.map(s=>s.id),[priorId,snapshotId]); // Excludes legacy, staging, and current restatement.
    assert.equal(history.profiles.length,14);assert.ok(history.profiles.every(p=>[101,...payload.peers].includes(p.rssd)));
    assert.equal(history.profiles.find(p=>p.rssd===101&&p.period===period).metrics.roa,1.2);
    assert.equal(history.profiles.find(p=>p.rssd===101&&p.period===prior).metrics.roa,1.1);
    assert.ok(history.snapshots.every(s=>!('owner' in s)));assert.ok(history.profiles.every(p=>!('raw_source' in p)));
    for(const peers of [[101],[2,2],Array.from({length:31},(_,i)=>i+2),[null],['-1']])await assert.rejects(()=>op('peer_history',{...payload,peers}));
    for(const id of [stagingId,legacyId,randomUUID()])await assert.rejects(()=>op('peer_history',{...payload,snapshotId:id}));
    const old=await op('peer_history',{...payload,period:prior,snapshotId:priorId});
    assert.ok(old.periods.every(p=>p<=prior));assert.equal(old.profiles.length,7);
    assert.equal((await op('peer_history',{...payload,peers:[]})).profiles.length,2);
    for(const role of ['anon','authenticated']){
      assert.equal((await db.query(`select has_function_privilege('${role}','public.bank_scope_operation(text,jsonb)','execute') allowed`)).rows[0].allowed,false);
      assert.equal((await db.query(`select has_table_privilege('${role}','edgar_private.bank_peer_profiles','select') allowed`)).rows[0].allowed,false);
    }
  }finally{await db.close();}
});
