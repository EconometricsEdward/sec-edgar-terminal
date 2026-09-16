import assert from 'node:assert/strict';
import test from 'node:test';
import { createThirteenFReviewStore } from '../src/utils/thirteenFReviewStore.js';
import { createGateway, TRUST } from '../supabase/functions/edgar-data-gateway/handler.js';
import { FUND_REVIEW_LIMITS, validFundReviewRpc } from '../supabase/functions/edgar-data-gateway/fundReviewPolicy.js';
const now = Date.now(), cik='0002012383', period='2025-12-31', hash='A'.repeat(64), owner='f1762238-e353-4107-8a1f-fd5a7bcab2de';
const h={key:'000000001|SECURITY|SH',cusip:'000000001',issuer:'Company',classTitle:'COM',putCall:null,quantity:10,quantityType:'SH',valueUsd:100,weightPct:100};
const report={manager:{cik,name:'Fixture'},selectedPeriod:period,observedAt:new Date(now).toISOString(),cache:{checkedAt:new Date(now).toISOString()},
  coverage:{selectedPeriodComplete:true},portfolio:{cik,period,holdings:[h],positionCount:1,totalValueUsd:100,complete:true,filings:[]}};
const claim={id:'fc13bcb5-52c6-473a-91ed-cedef9f915d3',reportHash:hash,generation:'1',owner,cycle:1};
const result={schemaVersion:'edgar.13f-market-connections.v1',status:'unresolved',manager:{cik},selectedPeriod:period,holding:h,observedAt:new Date(now).toISOString()};
const summary={holding:h,status:'unresolved',issuer:null,message:'No verified issuer.',checkedAt:new Date(now).toISOString(),markets:[],checked:false,partial:false,disclosureOnly:false,retryable:false};
const params={p_claim:claim,p_ordinal:1,p_result:result,p_summary:summary,p_retry_seconds:0};
const BASE='https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/edgar-data-gateway';
const request=(name,body)=>new Request(`${BASE}/rest/v1/rpc/${name}`,{method:'POST',headers:{Authorization:'Bearer fixture.identity.token','Content-Type':'application/json'},body:JSON.stringify(body)});
function gateway({response=()=>Response.json(true),...options}={}) {
  const calls=[];
  const environment={SUPABASE_URL:'https://vvkihuduqqnxqahhbphs.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture_private_secret_stays_in_gateway'};
  const handle=createGateway({now:()=>now,env:key=>environment[key],verifyToken:async()=>({iss:TRUST.issuer,aud:TRUST.audience,sub:TRUST.subject,
    owner:TRUST.owner,owner_id:TRUST.ownerId,project:TRUST.project,project_id:TRUST.projectId,environment:'production',iat:Math.floor(now/1000)-10,exp:Math.floor(now/1000)+300}),
    fetchImpl:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return response();},...options});
  return {handle,calls};
}
test('review gateway admits only exact production worker operations and bindings',async()=>{
  const {handle,calls}=gateway();
  for(const [name,body] of [['enqueue',{p_report:report,p_report_hash:hash}],['claim',{p_owner:owner,p_lease_seconds:90}],
    ['work',{p_claim:claim,p_limit:12}],['save',params],['release',{p_claim:claim}],
    ['read',{p_cik:cik,p_period:period,p_report_hash:null,p_limit:50}],['result',{p_cik:cik,p_period:period,p_report_hash:hash,p_key:h.key}]])
    assert.equal((await handle(request(`edgar_fund_review_${name}`,body))).status,200,name);
  assert.equal(calls.length,7);assert.ok(calls.every(c=>c.body.p_namespace==='production'));
  for(const patch of [{p_namespace:'preview'},{p_claim:{...claim,owner:'bad'}},{p_claim:{...claim,reportHash:'invalid'}},{p_ordinal:0},
    {p_retry_seconds:86401},{p_retry_seconds:1},{p_summary:{...summary,other:'unknown'}},{p_result:{...result,holding:{...h,weightPct:10}}},
    {p_summary:{...summary,markets:[{}]}},{p_arbitrary:'sql'}])assert.ok((await handle(request('edgar_fund_review_save',{...params,...patch}))).status>=400);
  assert.equal(calls.length,7);
});
test('review report admission rejects duplicate positions, incomplete manifests and future checks',()=>{
  assert.equal(validFundReviewRpc('edgar_fund_review_enqueue',{p_report:report,p_report_hash:hash},now),true);
  for(const changed of [{...report,portfolio:{...report.portfolio,positionCount:2}},
    {...report,portfolio:{...report.portfolio,holdings:[h,h],positionCount:2}},
    {...report,cache:{checkedAt:new Date(now+120000).toISOString()}},
    {...report,portfolio:{...report.portfolio,cik:'0000000001'}}])
    assert.equal(validFundReviewRpc('edgar_fund_review_enqueue',{p_report:changed,p_report_hash:hash},now),false);
});
test('review operations have isolated transport bounds; generic RPC bounds stay unchanged',async()=>{
  const large={...report,metadata:'x'.repeat(600000)};
  const {handle,calls}=gateway({response:()=>Response.json({large:'x'.repeat(600000)})});
  assert.equal((await handle(request('edgar_fund_review_enqueue',{p_report:large,p_report_hash:hash}))).status,200);
  assert.equal((await handle(request('edgar_store_status',{}))).status,413);
  assert.equal((await handle(request('edgar_fund_review_enqueue',{p_report:{...report,metadata:'x'.repeat(FUND_REVIEW_LIMITS.reportBytes)},p_report_hash:hash}))).status,422);
  assert.equal(calls.length,2);
});
test('gateway sanitizes upstream diagnostics while exposing only fixed capacity and fencing codes',async()=>{
  for(const [error,code,status=400] of [[{code:'54000',message:'fund_review_capacity'},'fund_review_capacity'],
    [{code:'PT409',message:'stale_fund_review_report'},'review_revision_changed',409],
    [{code:'PT409',message:'private diagnostic'},'upstream_failure'],
    [{code:'40001',message:'private diagnostic'},'40001'],[{code:'54000',message:'private secret'},'upstream_failure']]) {
    const {handle}=gateway({response:()=>Response.json(error,{status:400})});
    const response=await handle(request('edgar_fund_review_save',params));
    assert.equal(response.status,status);assert.deepEqual(await response.json(),{code});
  }
});
test('all permanent report revision conflicts return HTTP409 after one upstream call',async()=>{
  const {handle,calls}=gateway({response:()=>Response.json({code:'PT409',message:'stale_fund_review_report',details:'private context'},{status:409})});
  for(const [name,body] of [['enqueue',{p_report:report,p_report_hash:hash}],
    ['read',{p_cik:cik,p_period:period,p_report_hash:hash}],
    ['result',{p_cik:cik,p_period:period,p_report_hash:hash,p_key:h.key}]]) {
    const before=calls.length;
    const response=await handle(request(`edgar_fund_review_${name}`,body));
    assert.equal(response.status,409);assert.deepEqual(await response.json(),{code:'review_revision_changed'});
    assert.equal(calls.length,before+1,'gateway performs one request and never retries a permanent conflict');
  }
});
test('preview workloads cannot invoke review operations',async()=>{
  const {handle,calls}=gateway({verifyToken:async()=>({environment:'preview'})});
  assert.equal((await handle(request('edgar_fund_review_claim',{p_owner:owner,p_lease_seconds:90}))).status,401);assert.equal(calls.length,0);
});
test('adapter fixes destination and strips worker metadata from fenced claim arguments',async()=>{
  const calls=[];
  const store=createThirteenFReviewStore({env:{VERCEL_ENV:'production'},now:()=>now,identityTokenImpl:async()=>'fixture.identity.token',
    fetchImpl:async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return Response.json(true);}});
  assert.equal(await store.save({...claim,report,leaseUntil:new Date(now+90000).toISOString()},{ordinal:1,result,summary}),true);
  assert.deepEqual(calls[0].body.p_claim,claim);assert.equal(calls[0].body.p_namespace,'production');
  assert.equal(calls[0].url,`${BASE}/rest/v1/rpc/edgar_fund_review_save`);assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.cache,'no-store');
});
test('adapter rejects disabled environments, unverified claims, wrong result identity and oversized streams',async()=>{
  const disabled=createThirteenFReviewStore({env:{VERCEL_ENV:'preview'}});
  await assert.rejects(disabled.claim({owner}),{code:'disabled'});
  const create=response=>createThirteenFReviewStore({env:{VERCEL_ENV:'production'},now:()=>now,identityTokenImpl:async()=>'fixture.identity.token',fetchImpl:async()=>response()});
  await assert.rejects(create(()=>Response.json({...claim,cik,period,report,leaseUntil:new Date(now+200000).toISOString()})).claim({owner}),{code:'invalid_claim'});
  await assert.rejects(create(()=>Response.json({...result,manager:{cik:'0000000001'}})).result({cik,period,reportHash:hash,key:h.key}),{code:'invalid_result'});
  await assert.rejects(create(()=>new Response('{}',{headers:{'content-length':String(FUND_REVIEW_LIMITS.rpcBytes+1)}})).release(claim),{code:'response_too_large'});
});
test('adapter aborts stalled identity acquisition and maps capacity and report generation errors',async()=>{
  const store=createThirteenFReviewStore({env:{VERCEL_ENV:'production'},identityTokenImpl:()=>new Promise(()=>{})});
  await assert.rejects(store.claim({owner},{timeoutMs:20}),{code:'timeout'});
  for(const [code,status] of [['fund_review_capacity',429],['40001',409],['review_revision_changed',409]]) {
    const s=createThirteenFReviewStore({env:{VERCEL_ENV:'production'},now:()=>now,identityTokenImpl:async()=>'fixture.identity.token',fetchImpl:async()=>Response.json({code},{status:400})});
    await assert.rejects(s.claim({owner}),{status,code:code==='fund_review_capacity'?'fund_review_capacity':'stale_generation'});
  }
});

test('prepared read endpoints admit latest only for snapshots and progress',async()=>{
  const {handle,calls}=gateway();
  for(const operation of ['snapshot','progress']) {
    assert.equal((await handle(request(`edgar_fund_review_${operation}`,{p_cik:cik,p_period:null}))).status,200);
    assert.equal((await handle(request(`edgar_fund_review_${operation}`,{p_cik:cik,p_period:period}))).status,200);
    assert.equal((await handle(request(`edgar_fund_review_${operation}`,{p_cik:cik,p_period:null,p_query:'arbitrary'}))).status,422);
  }
  assert.equal((await handle(request('edgar_fund_review_read',{p_cik:cik,p_period:null}))).status,422);
  assert.equal(calls.length,4);
});
test('cached batches and ordinal cursors retain exact worker fences and limits',async()=>{
  const {handle,calls}=gateway(), entry={ordinal:1,result,summary,retrySeconds:0};
  assert.equal((await handle(request('edgar_fund_review_work',{p_claim:claim,p_limit:100,p_after_ordinal:400}))).status,200);
  assert.equal((await handle(request('edgar_fund_review_work',{p_claim:claim,p_limit:101,p_after_ordinal:0}))).status,422);
  assert.equal((await handle(request('edgar_fund_review_work',{p_claim:claim,p_limit:100,p_after_ordinal:20001}))).status,422);
  assert.equal((await handle(request('edgar_fund_review_save_batch',{p_claim:claim,p_results:[entry]}))).status,200);
  for(const entries of [[],[entry,entry],Array(51).fill(entry),[{...entry,arbitrary:true}],[{...entry,retrySeconds:undefined}],
    [{...entry,result:{...result,holding:{...h,valueUsd:999}}}]])
    assert.equal((await handle(request('edgar_fund_review_save_batch',{p_claim:claim,p_results:entries}))).status,422);
  assert.equal(calls.length,2);
});
test('lightweight citation links must match the summary issuer and filing accession',()=>{
  const source={url:'https://www.sec.gov/Archives/edgar/data/1/000000000125000001/report.htm',accession:'0000000001-25-000001',form:'10-K',filed:'2025-12-30',reportDate:'2025-09-30'};
  const linked={...summary,issuer:{cik:'0000000001'},sources:[source]};
  assert.equal(validFundReviewRpc('edgar_fund_review_save',{...params,p_summary:linked},now),true);
  for(const sources of [[{...source,url:source.url.replace('/data/1/','/data/2/')}],[{...source,url:`${source.url}?key=secret`}],
    [{...source,url:'https://attacker.example/report.htm'}],Array(4).fill(source),[{...source,reportDate:'2025-12-31'}]])
    assert.equal(validFundReviewRpc('edgar_fund_review_save',{...params,p_summary:{...linked,sources}},now),false);
});
test('adapter returns bounded prepared snapshots and tiny progress with string versions',async()=>{
  const calls=[],job={cik,period,reportHash:hash},publishedAt=new Date(now).toISOString();
  const store=createThirteenFReviewStore({env:{VERCEL_ENV:'production'},now:()=>now,rpc:async(name,body)=>{
    calls.push({name,body});
    if(name==='edgar_fund_review_save_batch')return true;
    if(name==='edgar_fund_review_work')return [];
    if(name==='edgar_fund_review_snapshot')return {job,report:{cik,period},coverage:{},markets:[],rows:[],page:{},publicationVersion:'2',publishedAt};
    return {job,publicationVersion:'2',publishedAt};
  }});
  assert.equal((await store.snapshot({cik,period:null})).publicationVersion,'2');
  assert.deepEqual(Object.keys(await store.progress({cik})).sort(),['job','publicationVersion','publishedAt']);
  assert.equal(await store.saveBatch(claim,{results:[{ordinal:1,result,summary,retrySeconds:0}]}),true);
  assert.deepEqual(await store.work(claim,{limit:100,afterOrdinal:500}),[]);
  assert.equal(calls[0].body.p_period,null);assert.equal(calls[1].body.p_period,null);assert.equal(calls[3].body.p_after_ordinal,500);
});
