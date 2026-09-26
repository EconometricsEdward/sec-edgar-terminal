import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCallXbrl } from '../src/utils/bank/parser.js';
import { buildExposureReport } from '../src/utils/bank/exposureModel.js';
import { CREDIT_SEGMENTS, exposureChange, exposureRatio, priorExposurePeriod } from '../src/utils/bank/exposureDefinitions.js';
import { createExposureService } from '../src/utils/bank/exposureService.js';
import { createExposureApi } from '../src/utils/bank/exposureApi.js';
import { bankHref, bankPageOptions } from '../src/utils/bank/viewModel.js';

const date = '2026-06-30';
const fixture = rssd => readFileSync(new URL(`./fixtures/exposures-${rssd}-${date}.xml`, import.meta.url), 'utf8');
const parsed = (rssd=451965) => parseCallXbrl(fixture(rssd), {rssd,reportDate:date});
const model = (rssd,form) => buildExposureReport(parsed(rssd),{form});

test('031 domestic loan mix reconciles, with explicit consolidated C&I performance',()=>{
  const r=model(451965,'031'),v=r.values;
  assert.equal(v.loan_total.value,951133000000);
  assert.equal(v.loan_construction.value,12464000000);
  assert.equal(v.loan_cre.value,109159000000);
  assert.equal(v.loan_residential.value,233400000000);
  assert.equal(v.loan_commercial.value,186741000000);
  assert.equal(v.loan_consumer.value,121199000000);
  assert.equal(v.loan_other.value,288170000000);
  assert.equal(CREDIT_SEGMENTS.reduce((sum,s)=>sum+v[`loan_${s.key}`].value,0),v.loan_total.value);
  assert.equal(v.cre_nonaccrual.value,2802000000);
  assert.equal(v.commercial_nonaccrual.value,1100000000);
  assert.equal(v.cre_nonaccrual.scope,'Domestic offices');
  assert.equal(v.commercial_nonaccrual.scope,'Consolidated bank · all offices');
  assert.ok(v.loan_commercial.codes.every(c=>c.startsWith('RCON')));
  assert.ok(v.commercial_nonaccrual.codes.every(c=>c.startsWith('RCFD')));
});

test('041 and 051 use domestic C&I totals and preserve reported zeros',()=>{
  const v=model(2758613,'041').values;
  assert.equal(v.loan_cre.value,1068026000);
  assert.equal(v.loan_commercial.value,1062982000);
  assert.equal(v.commercial_nonaccrual.value,32573000);
  assert.equal(v.fhlb_total.value,239500000);
  assert.equal(v.htm_gap.value,-14169000);
  assert.equal(v.afs_gap.value,-25231000);
  const community=model(493741,'051').values;
  assert.equal(community.loan_cre.value,139874000);
  assert.equal(community.loan_commercial.value,31311000);
  assert.equal(community.commercial_nonaccrual.value,0);
  assert.equal(community.fhlb_total.value,0);
  assert.equal(community.uninsured.value,null);
  assert.equal(community.foreign_deposits,undefined);
  assert.equal(community.htm_gap.value,-4000);
  assert.equal(community.afs_gap.value,-12117000);
});

test('funding categories reconcile without counting brokered, uninsured or FHLB memoranda twice',()=>{
  for(const [rssd,form]of[[451965,'031'],[2758613,'041'],[493741,'051']]){
    const v=model(rssd,form).values;
    assert.ok(Math.abs(['transaction','mmda','savings','time_small','time_large'].reduce((s,k)=>s+v[k].value,0)-v.deposits.value)<=5000);
    assert.ok(Math.abs([0,1,2,3].reduce((s,i)=>s+v[`time_maturity_${i}`].value,0)-v.time_small.value-v.time_large.value)<=5000);
    assert.equal(v.fhlb_total.codes.length,4);
    assert.ok(!v.fhlb_total.codes.some(c=>c.endsWith('2651')||c.endsWith('F059')));
  }
});

test('the narrowly reconciled HK14 context exception cannot admit an unverified duration balance',()=>{
  const p=parsed(),r=buildExposureReport(p,{form:'031'});
  assert.equal(r.facts.RCONHK14.value,519000000);
  assert.match(r.facts.RCONHK14.contextNote,/reconciled/);
  p.facts.RCONHK14[0].value+=100000;
  assert.equal(buildExposureReport(p,{form:'031'}).values.time_maturity_2.value,null);
  delete p.facts.RCONJ474;
  assert.equal(buildExposureReport(p,{form:'031'}).facts.RCONHK14.value,null);
});

test('security differences are signed, cost is gross RC-B, and maturity bases remain separate',()=>{
  const v=model(451965,'031').values;
  assert.equal(v.htm_cost.value,198666000000);
  assert.equal(v.htm_fair.value,166165000000);
  assert.equal(v.htm_gap.value,-32501000000);
  assert.equal(v.afs_gap.value,-2999000000);
  assert.deepEqual(v.htm_cost.codes,['RCFD1754']);
  assert.deepEqual(v.securities_other_0.codes,['RCFDA549']);
  assert.deepEqual(v.securities_pass_0.codes,['RCFDA555']);
  assert.deepEqual(v.mbs_life_short.codes,['RCFDA561']);
});

test('missing, nil, conflicting, negative, wrong-unit and wrong-context facts cannot become valid amounts',()=>{
  for(const mutate of [
    p=>delete p.facts.RCONF160,
    p=>{p.facts.RCONF160[0].value=null;p.facts.RCONF160[0].nil=true;},
    p=>p.facts.RCONF160.push({...p.facts.RCONF160[0],value:1,rawValue:'1'}),
    p=>{p.facts.RCONF160[0].value=-1;},
    p=>{p.facts.RCONF160[0].unit='xbrli:pure';},
    p=>{p.facts.RCONF160[0].context={...p.facts.RCONF160[0].context,instant:false,start:'2026-01-01'};},
    p=>{p.facts.RCONF160[0].context={...p.facts.RCONF160[0].context,dimensional:true};},
  ]){const p=parsed();mutate(p);const v=buildExposureReport(p,{form:'031'}).values;assert.equal(v.loan_cre.value,null);assert.equal(v.loan_other.value,null);}
  const p=parsed();p.facts.RCON2122[0].value=100;
  assert.equal(buildExposureReport(p,{form:'031'}).values.loan_other.reason,'portfolio_components_exceed_total');
  assert.throws(()=>buildExposureReport(parsed(),{form:'041'}),/form mismatch/);
});

test('period changes require the adjacent quarter and a positive base; links preserve the exposure lens',()=>{
  assert.equal(priorExposurePeriod('2026-03-31'),'2025-12-31');
  assert.equal(priorExposurePeriod(date),'2026-03-31');
  assert.equal(exposureChange(110,100),10.000000000000009);
  for(const v of [null,0,-5])assert.equal(exposureChange(10,v),null);
  assert.equal(exposureRatio(null,100),null);
  const options=bankPageOptions('451965',{view:'exposures',exposure:'funding',segment:'consumer',period:date});
  const url=new URL(bankHref('451965',options),'https://example.com');
  assert.equal(url.searchParams.get('exposure'),'funding');
  assert.equal(url.searchParams.get('segment'),'consumer');
  assert.equal(bankPageOptions('1',{view:'exposures',exposure:'bad',segment:'bad'}).segment,'cre');
  assert.equal(bankPageOptions('1',{view:'exposures',exposure:'bad'}).exposure,'credit');
  assert.ok(!bankHref('1',{...options,view:'compare'}).includes('exposure='));
});

function serviceFixture(){
  const raw=fixture(451965),p=parsed();
  const metadata={id_rssd:451965,report_date:date,form_type:'031',source_sha256:p.sha256,validation:{passed:true}};
  const source={rssd:451965,reportDate:date,sha256:p.sha256,rawXbrl:raw,validation:{passed:true}};
  return {metadata,source};
}
test('read-only enrichment pins hashes, coalesces sources, refreshes metadata and retries expired entries',async()=>{
  const {metadata,source}=serviceFixture();let time=0,reads=0,sources=0;
  const service=createExposureService({now:()=>time,store:async(op,p)=>{
    if(op==='read'){reads++;assert.deepEqual(p,{rssds:[451965]});return{periods:[date],reports:[metadata]};}
    assert.equal(op,'source');assert.equal(p.hash,metadata.source_sha256);sources++;return source;
  }});
  const [a,b]=await Promise.all([service(451965,date),service(451965,date)]);
  assert.equal(a.reports[0].values.htm_gap.value,-32501000000);assert.equal(b.reports.length,1);assert.equal(sources,1);assert.equal(reads,2);
  time=300001;await service(451965,date);assert.equal(sources,2);
});
test('source identity, validation and byte hash failures fail current reports and are never cached',async()=>{
  for(const patch of [{rssd:493741},{reportDate:'2026-03-31'},{validation:{passed:false}},{sha256:'f'.repeat(64)},{rawXbrl:fixture(451965)+'\n'}]){
    const {metadata,source}=serviceFixture();let sources=0;
    const service=createExposureService({store:async op=>op==='read'?{periods:[date],reports:[metadata]}:(sources++,{...source,...patch})});
    await assert.rejects(service(451965,date));await assert.rejects(service(451965,date));assert.equal(sources,2);
  }
});
test('unsupported or unvalidated selected periods never fall back; partial history remains a gap',async()=>{
  const {metadata,source}=serviceFixture();let sourceReads=0;
  const service=createExposureService({store:async op=>op==='read'?{periods:[date,'2026-03-31'],reports:[metadata]}:(sourceReads++,source)});
  assert.equal((await service(451965,'2026-09-30')).unavailable,'period_outside_available_history');
  assert.equal((await service(451965,'2026-03-31')).unavailable,'validated_report_unavailable');
  assert.equal(sourceReads,0);
  const result=await service(451965,date);assert.deepEqual(result.missing,['2026-03-31']);assert.equal(result.reports.length,1);
});
test('API validates quarter/RSSD, rate limits, sanitizes failures and avoids caching partial history',async()=>{
  const rateLimit=async()=>({allowed:true});let calls=0;
  const get=createExposureApi({rateLimit,analyze:async()=>{calls++;return {reports:[],missing:['2026-03-31']};}});
  for(const query of ['rssd=0&period='+date,'rssd=1&period=2026-06-29','rssd=1&period='+date+'&period='+date,'rssd=1&period='+date+'&secret=x'])assert.equal((await get(new Request('https://example.com/api/banks/exposures?'+query))).status,400);
  assert.equal(calls,0);
  const request=new Request('https://example.com/api/banks/exposures?rssd=451965&period='+date);
  assert.match((await get(request)).headers.get('Cache-Control'),/no-store/);
  const bad=createExposureApi({rateLimit,analyze:async()=>{throw Error('private database detail');}});
  const response=await bad(request);assert.equal(response.status,503);assert.ok(!(await response.text()).includes('private database'));
  const limited=createExposureApi({rateLimit:async()=>({allowed:false,retryAfter:60,limit:60,remaining:0,reset:Date.now()+60000}),analyze:async()=>assert.fail('should not analyze')});
  assert.equal((await limited(request)).status,429);
});
