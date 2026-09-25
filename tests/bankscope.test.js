import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { normalizeBankPanel,bankSelection } from '../src/utils/bank/catalog.js';
import { parseCallXbrl } from '../src/utils/bank/parser.js';
import { bankMetricDefinitions,normalizeBankReport } from '../src/utils/bank/normalization.js';
import { createBankApi } from '../src/utils/bank/api.js';
import { runBankWorker } from '../src/utils/bank/worker.js';
import { TRUST,validScopeClaims,createScopeGateway } from '../supabase/functions/bankscope-gateway/handler.js';
const date='2026-06-30';
const rows=[{ID_RSSD:101,Name:'FIRST TEST BANK',FilingType:51,City:'INDIANAPOLIS',State:'IN',FDICCertNumber:333,HasFiledForReportingPeriod:true},
  {ID_RSSD:102,Name:'FIRST TEST BANK',FilingType:'041',City:'COLUMBUS',State:'OH',HasFiledForReportingPeriod:true}];
function fixture(form='051',cblr=false){
  const amounts={assets:1000000000,liabilities:800000000,equity:200000000,loans:500000000,loans_hfi:450000000,loans_hfs:50000000,
    interest_income:10000000,interest_expense:4000000,net_interest_income:6000000,cet1:90000000,tier1:100000000,total_capital:120000000,rwa:500000000,
    cet1_ratio:.18,tier1_ratio:.20,total_capital_ratio:.24,leverage_ratio:.1};
  const facts=new Map();for(const def of bankMetricDefinitions(form)){if(def.notApplicable)continue;for(const code of def.codes){
    if(cblr&&['rwa','total_capital','cet1_ratio','tier1_ratio','total_capital_ratio'].includes(def.key))continue;
    facts.set(code,{value:amounts[def.key]??1000,period:def.period,unit:def.unit==='USD'?'USD':'pure'});
  }}
  facts.set('RCOALE74',{value:cblr?1:0,period:'instant',unit:'pure'});
  return `<xbrl xmlns:c="https://example.test" xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink">
  <link:schemaRef xlink:href="https://www.cdr.ffiec.gov/xbrl/call/report${form}/${date}/concepts.xsd"/>
  <context id="i"><entity><identifier scheme="ID_RSSD">101</identifier></entity><period><instant>${date}</instant></period></context>
  <context id="y"><entity><identifier scheme="ID_RSSD">101</identifier></entity><period><startDate>2026-01-01</startDate><endDate>${date}</endDate></period></context>
  <unit id="USD"><measure>iso4217:USD</measure></unit><unit id="pure"><measure>xbrli:pure</measure></unit>
  ${[...facts].map(([code,f])=>`<c:${code} contextRef="${f.period==='ytd'?'y':'i'}" unitRef="${f.unit}">${f.value}</c:${code}>`).join('')}</xbrl>`;
}
test('directory supports all Call Report forms without merging equal bank names or guessing identifiers',()=>{
  const banks=normalizeBankPanel(rows,date,[{ID_RSSD:101,DateTime:'8/1/2026 1:00 PM'}]);
  assert.deepEqual(banks.map(x=>x.form),['051','041']);assert.equal(banks[0].submission,'8/1/2026 1:00 PM');
  assert.equal(banks[0].rssd,101);assert.equal(banks[1].city,'COLUMBUS');
  assert.throws(()=>normalizeBankPanel([...rows,rows[0]],date),{code:'institution_identity_ambiguous'});
  assert.throws(()=>bankSelection('101,102,103,104,105'),{code:'invalid_selection'});
});
test('041/051 use domestic-only balance-sheet codes, RCOA capital, and no invented foreign deposits',()=>{
  for(const form of ['041','051']){
    const result=normalizeBankReport(parseCallXbrl(fixture(form),{rssd:101,reportDate:date}),{form});
    assert.equal(result.validation.passed,true);assert.equal(result.metrics.find(m=>m.key==='assets').value,1e9);
    assert.deepEqual(result.metrics.find(m=>m.key==='deposits').codes,['RCON2200']);
    assert.equal(result.metrics.find(m=>m.key==='foreign_deposits').status,'not_applicable');
    assert.equal(result.metrics.find(m=>m.key==='tier1_ratio').value,20);
    assert.throws(()=>normalizeBankReport(parseCallXbrl(fixture(form),{rssd:101,reportDate:date}),{form:'031'}),{code:'source_form_mismatch'});
  }
});
test('CBLR reporting preserves the election and leverage ratio while risk-based capital omissions remain null',()=>{
  const result=normalizeBankReport(parseCallXbrl(fixture('051',true),{rssd:101,reportDate:date}),{form:'051'});
  assert.equal(result.capitalFramework,'CBLR');assert.equal(result.validation.passed,true);
  for(const k of ['rwa','total_capital','cet1_ratio','tier1_ratio','total_capital_ratio']){
    const m=result.metrics.find(x=>x.key===k);assert.equal(m.value,null);assert.equal(m.reason,'not_required_under_cblr');assert.equal(m.frameworkLineage[0].value,1);
  }
  assert.equal(result.metrics.find(m=>m.key==='leverage_ratio').value,10);
});
test('existing official 031 fixtures retain validated financial values under the expanded mapping',async()=>{
  for(const rssd of [852218,480228,451965]){
    const xml=await readFile(new URL(`./fixtures/bank-${rssd}-${date}.xml`,import.meta.url),'utf8');
    const x=normalizeBankReport(parseCallXbrl(xml,{rssd,reportDate:date}),{form:'031'});
    assert.equal(x.validation.passed,true);assert.equal(x.metrics.filter(m=>m.value!==null).length,35);
  }
});
test('public reads never schedule ingestion; only bounded same-origin POST enqueues server-verified identities',async()=>{
  const calls=[];let scheduled=0;
  const api=createBankApi({env:{CRON_SECRET:'test-only'},rateLimit:async()=>({allowed:true}),schedule:()=>scheduled++,store:async(op,p)=>{calls.push([op,p]);return op==='request'?{accepted:true,queued:4}:{banks:[],jobs:[]};}});
  assert.equal((await api.GET(new Request('https://example.test/api/banks?q=test'))).status,200);
  assert.equal((await api.GET(new Request('https://example.test/api/banks?rssds=101,102'))).status,200);assert.equal(scheduled,0);
  const post=(body,headers={})=>api.POST(new Request('https://example.test/api/banks',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)}));
  assert.equal((await post({rssd:101},{origin:'https://evil.test'})).status,403);
  assert.equal((await post({rssd:101,url:'https://evil.test'})).status,400);
  assert.equal((await post({rssd:101})).status,202);assert.equal(scheduled,1);
  assert.match(calls.at(-1)[1].clientHash,/^[a-f0-9]{64}$/);assert.deepEqual(calls.map(c=>c[0]),['search','read','request']);
});
test('gateway pins production/preview identities and never forwards unauthenticated operations',async()=>{
  const p={iss:TRUST.issuer,aud:TRUST.audience,owner_id:TRUST.ownerId,project_id:TRUST.projectId,environment:'production',
    sub:'owner:econometricsedwards-projects:project:sec-edgar-terminal:environment:production',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600};
  assert.equal(validScopeClaims(p),true);assert.equal(validScopeClaims({...p,project_id:'another-project'}),false);
  assert.equal(validScopeClaims({...p,environment:'preview'}),false);
  let calls=0;const handler=createScopeGateway({verify:async()=>p,env:()=>null,fetchImpl:async()=>{calls++;}});
  assert.equal((await handler(new Request('https://example.test',{method:'POST'}))).status,401);assert.equal(calls,0);
});
test('expanded SQL supports discovery, search, durable admission, fenced work, source reprocessing and immutable versions',async()=>{
  const db=new PGlite();try{
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema edgar_private;grant usage on schema edgar_private,public to service_role;');
    for(const file of ['20260925051054_ffiec_bank_pilot.sql','20260925052649_ffiec_bank_source_recovery.sql','20260925063357_bankscope_directory_queue.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
    const op=async(name,p={})=>(await db.query('select public.bank_scope_operation($1,$2::jsonb) as x',[name,JSON.stringify(p)])).rows[0].x;
    const owner=randomUUID();assert.equal((await op('begin',{owner})).allowed,true);
    await op('periods',{owner,periods:[date]});await op('catalog',{owner,period:date,banks:normalizeBankPanel(rows,date)});
    assert.equal((await op('search',{query:'first test'})).banks.length,2);assert.equal((await op('search',{query:'333'})).banks[0].id_rssd,101);
    assert.equal((await op('request',{rssd:999,clientHash:'a'.repeat(64)})).code,'institution_not_found');
    assert.equal((await op('request',{rssd:101,clientHash:'a'.repeat(64)})).queued,1);
    assert.equal((await op('request',{rssd:101,clientHash:'a'.repeat(64)})).queued,0);
    assert.equal((await op('begin',{owner:randomUUID()})).code,'ingestion_running');
    const job=await op('claim',{owner});assert.equal(job.form,'051');
    const raw=fixture(),parsed=parseCallXbrl(raw,{rssd:101,reportDate:date}),normalized=normalizeBankReport(parsed,{form:'051'});
    const payload={owner,jobId:job.id,rssd:101,reportDate:date,form:'051',submissionDate:null,retrievedAt:new Date().toISOString(),
      rawXbrl:raw,sha256:parsed.sha256,parserVersion:'test',metrics:[],validation:{passed:false},metadata:{}};
    await op('publish',payload);assert.equal((await op('source',{rssd:101,period:date,submission:null})).rawXbrl,raw);
    await assert.rejects(()=>op('publish',{...payload,metrics:[{...normalized.metrics[0],rssd:102}]}));
    await op('publish',{...payload,metrics:normalized.metrics,validation:normalized.validation});
    const read=await op('read',{rssds:[101]});assert.equal(read.reports[0].metrics.length,35);assert.equal(read.jobs[0].status,'ready');
    assert.equal('lineage' in read.reports[0].metrics[0],false);
    assert.equal((await op('lineage',{rssd:101,period:date,hash:parsed.sha256,metric:'assets'})).value,1e9);
    assert.equal((await op('reserve',{owner,method:'RetrieveFacsimile'})).allowed,true);
    assert.equal((await op('reserve',{owner,method:'RetrieveFacsimile'})).allowed,false);
    await db.exec("update edgar_private.bank_pilot_control set hour_requests=600,next_request_at='-infinity';");
    assert.equal((await op('reserve',{owner,method:'RetrieveFacsimile'})).code,'hourly_budget');
    await op('finish',{owner,result:{stored:1}});assert.equal((await op('status')).reportCount,1);
    assert.equal((await db.query("select has_function_privilege('anon','public.bank_scope_operation(text,jsonb)','EXECUTE') as allowed")).rows[0].allowed,false);
    const owner2=randomUUID();await op('begin',{owner:owner2});
    await op('catalog',{owner:owner2,period:date,banks:normalizeBankPanel(rows,date,[{ID_RSSD:101,DateTime:'9/1/2026 1:00 PM'}])});
    assert.equal((await op('read',{rssds:[101]})).jobs[0].status,'queued');
    await assert.rejects(()=>db.query("select public.bank_pilot_operation('begin','{}')"));
  }finally{await db.close();}
});
test('worker reprocesses retained sources and does not call FFIEC for an idle queue',async()=>{
  let upstream=0;const operations=[];
  const result=await runBankWorker({clientFactory:()=>{upstream++;throw Error('not needed');},store:async(op,p)=>{
    operations.push(op);if(op==='begin')return {allowed:true};if(op==='status')return {periods:[date]};if(op==='claim')return null;
  }});
  assert.equal(result.status,'ready');assert.equal(upstream,0);assert.deepEqual(operations,['begin','status','claim','finish']);
});
