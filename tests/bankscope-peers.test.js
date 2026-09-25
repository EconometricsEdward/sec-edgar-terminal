import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { normalizePeerRecord,fetchPeerUniverse } from '../src/utils/bank/peerSource.js';
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
    const start={owner,snapshotId,period,count:1000,url:'https://api.fdic.gov/banks/financials?test',sha256:'a'.repeat(64),sourceIndex:'v1',modelVersion:'v1'};
    await assert.rejects(()=>op('peer_start',{...start,owner:randomUUID()}));await op('peer_start',start);
    const rows=banks.map(b=>({raw:raw(b.rssd),profile:normalizePeerRecord(raw(b.rssd),period)}));
    await op('peer_batch',{owner,snapshotId,rows:rows.slice(0,500)});
    assert.equal((await op('peer_universe',{period})).profiles.length,0);
    await assert.rejects(()=>op('peer_complete',{owner,snapshotId}));
    await assert.rejects(()=>op('peer_batch',{owner,snapshotId,rows:[{raw:raw(501),profile:{...rows[500].profile,rssd:9999}}]}));
    await op('peer_batch',{owner,snapshotId,rows:rows.slice(500)});await op('peer_complete',{owner,snapshotId});
    const universe=await op('peer_universe',{period});assert.equal(universe.profiles.length,1000);assert.equal(universe.profiles[0].name,'BANK 1');
    assert.equal('raw_source' in universe.profiles[0],false);assert.equal('owner' in universe.snapshot,false);
    assert.equal((await op('reserve',{owner,method:'RetrieveUBPRXBRLFacsimile'})).allowed,true);
    assert.equal((await op('reserve',{owner,method:'RetrieveFacsimile'})).allowed,false);
    const job=await op('ubpr_claim',{owner});assert.equal(job.id_rssd,101);
    await op('ubpr_save',{owner,rssd:101,period,rawXbrl:'<xbrl/>',sha256:'b'.repeat(64),retrievedAt:new Date().toISOString(),data:{stage:'source_retained'},complete:true});
    assert.equal((await op('ubpr_read',{rssd:101,period})).status,'ready');
    assert.equal(await op('ubpr_source',{rssd:101,period,hash:'c'.repeat(64)}),null);
    await op('finish',{owner});
    for(const role of ['anon','authenticated']){
      assert.equal((await db.query(`select has_function_privilege('${role}','public.bank_scope_operation(text,jsonb)','execute') allowed`)).rows[0].allowed,false);
      assert.equal((await db.query(`select has_table_privilege('${role}','edgar_private.bank_peer_profiles','select') allowed`)).rows[0].allowed,false);
    }
  }finally{await db.close();}
});
