import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPeerHistory,peerChange,previousPeerPeriod,formatBasisPoints } from '../src/utils/bank/peerHistory.js';
import { createPeerService } from '../src/utils/bank/peerService.js';
import { createPeerApi } from '../src/utils/bank/peerApi.js';
import { createScopeGateway,TRUST } from '../supabase/functions/bankscope-gateway/handler.js';

const periods=['2025-09-30','2025-12-31','2026-03-31','2026-06-30'],period=periods.at(-1);
const analysis={bank:{rssd:1},snapshot:{id:'snapshot'},peers:[2,3,4,5,6,7].map(rssd=>({rssd}))};
function source(){return {periods,snapshots:periods.map(report_date=>({report_date})),profiles:periods.flatMap((date,i)=>[
  {period:date,rssd:1,cblr:false,metrics:{roa:i+1,cet1:9+i,chargeoffs:-.001}},
  ...analysis.peers.map(({rssd})=>({period:date,rssd,cblr:false,metrics:{roa:rssd+i,cet1:10+i}})),
  {period:date,rssd:999,cblr:false,metrics:{roa:100000,cet1:100000}},
])};}
const metric=(h,key='roa')=>h.metrics.find(m=>m.key===key);
test('history follows exactly the selected cohort, excludes the bank, and preserves ratio units',()=>{
  const h=buildPeerHistory(source(),analysis,period);
  assert.deepEqual(h.cohort,['2','3','4','5','6','7']);assert.equal(h.metrics.length,24);
  assert.deepEqual(metric(h).points.map(p=>[p.value,p.peerMedian,p.peerCount]),[[1,4.5,6],[2,5.5,6],[3,6.5,6],[4,7.5,6]]);
  assert.equal(peerChange(metric(h).points,'2026-03-31'),100);
  assert.equal(peerChange(metric(h).points,'2025-09-30'),300);
  assert.equal(peerChange(metric(h).points,'2026-03-31','peerMedian'),100);
  assert.equal(metric(h).basis,'Annualized year-to-date net income / average assets.');
});
test('historical selection never includes future dates; one-period windows have no prior change',()=>{
  const h=buildPeerHistory(source(),analysis,'2025-09-30');
  assert.deepEqual(h.periods,['2025-09-30']);assert.equal(h.snapshots.length,1);
  assert.equal(peerChange(metric(h).points,previousPeerPeriod('2025-09-30')),null);
  assert.equal(previousPeerPeriod('2026-03-31'),'2025-12-31');
  assert.equal(previousPeerPeriod('2026-12-31'),'2026-09-30');
});
test('missing snapshots and missing bank records are gaps, and prior-quarter changes cannot skip gaps',()=>{
  const s=source();s.snapshots=s.snapshots.filter(p=>p.report_date!=='2025-12-31');
  s.profiles=s.profiles.filter(p=>!(p.rssd===1&&p.period==='2026-03-31'));
  const points=metric(buildPeerHistory(s,analysis,period)).points;
  assert.deepEqual(points.map(p=>p.value),[1,null,null,4]);
  assert.equal(points[1].sourceAvailable,false);assert.equal(points[2].peerCount,6);
  assert.equal(peerChange(points,'2026-03-31'),null);assert.equal(peerChange(points,'2025-09-30'),300);
  // A missing catalog quarter is represented as a gap too, rather than joined across.
  s.periods=['2025-09-30',period];s.snapshots=s.snapshots.filter(p=>s.periods.includes(p.report_date));
  assert.deepEqual(buildPeerHistory(s,analysis,period).periods,periods);
});
test('historical capital eligibility uses each date’s framework and medians require five actual observations',()=>{
  const s=source();
  s.profiles.find(p=>p.rssd===1&&p.period==='2025-12-31').cblr=true;
  s.profiles.find(p=>p.rssd===1&&p.period==='2026-03-31').cblr=null;
  for(const p of s.profiles)if(p.period===period&&[2,3].includes(p.rssd)){p.cblr=true;p.metrics.cet1=0;}
  const points=metric(buildPeerHistory(s,analysis,period),'cet1').points;
  assert.deepEqual(points.map(p=>p.value),[9,null,null,12]);assert.equal(points[1].notRequired,true);
  assert.equal(points[2].notRequired,false);assert.equal(points.at(-1).peerCount,4);assert.equal(points.at(-1).peerMedian,null);
  assert.equal(points[0].peerMedian,10);assert.equal(peerChange(points,'2026-03-31'),null);
});
test('basis-point formatting preserves signs, true zeros and sub-basis-point moves without growth division',()=>{
  assert.equal(formatBasisPoints(0),'0 bp');assert.equal(formatBasisPoints(-.125),'−0.13 bp');
  assert.equal(formatBasisPoints(.0012),'+0.0012 bp');assert.equal(formatBasisPoints(null),'Unavailable');
  const points=[{period:'2026-03-31',value:0},{period,value:-.001}];
  assert.equal(peerChange(points,'2026-03-31'),-.1);
  assert.equal(formatBasisPoints(peerChange([{period:'old',value:1.2},{period,value:1.21}],'old')),'+1 bp');
});
test('history shares the universe read, retrieves at most 31 fixed identities, and is independent of UBPR',async()=>{
  const calls=[],profile={rssd:1,assets:100,loanMix:[.5,.2,.2,.1],loanShare:.6,funding:[.8,.2,.05],metrics:{roa:1}};
  const service=createPeerService({store:async(op,p)=>{
    calls.push([op,p]);
    if(op==='peer_universe')return {snapshot:{id:'pinned'},profiles:[profile,...Array.from({length:40},(_,i)=>({...profile,rssd:i+2}))]};
    if(op==='peer_history')return source();
    return {};
  }});
  const [current,h]=await Promise.all([service(1,period),service.history(1,period)]);
  assert.equal(calls.filter(c=>c[0]==='peer_universe').length,1);assert.equal(calls.filter(c=>c[0]==='ubpr_read').length,1);
  const payload=calls.find(c=>c[0]==='peer_history')[1];
  assert.equal(payload.snapshotId,'pinned');assert.equal(payload.peers.length,30);
  assert.deepEqual(payload.peers,current.peers.map(p=>p.rssd));assert.equal(h.cohort.length,30);
  const failed=createPeerService({store:async(op)=>{if(op==='peer_history')throw Error('unavailable');return op==='peer_universe'?{snapshot:{id:'pinned'},profiles:[profile]}:{};}});
  await assert.rejects(()=>failed.history(1,period));assert.equal((await failed(1,period)).bank.rssd,1);
});
test('history API rejects arbitrary peers and malformed flags, shares throttling, and sanitizes failures',async()=>{
  let calls=0,allowed=true;
  const GET=createPeerApi({rateLimit:async()=>({allowed,retryAfter:1}),history:async()=>{calls++;return {period};},analyze:()=>assert.fail('wrong operation')});
  const request=s=>new Request(`https://example.test/api/banks/peers?rssd=1&period=${period}${s}`);
  for(const suffix of ['&history=0','&history=true','&history=1&history=1','&history=1&peers=2'])assert.equal((await GET(request(suffix))).status,400);
  assert.equal(calls,0);assert.deepEqual(await (await GET(request('&history=1'))).json(),{period});
  allowed=false;assert.equal((await GET(request('&history=1'))).status,429);assert.equal(calls,1);
  const failure=createPeerApi({rateLimit:async()=>({allowed:true}),history:async()=>{throw Error('database secret');}});
  const response=await failure(request('&history=1'));assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/secret/);
});
test('history gateway retains signed deployment authentication before forwarding the read',async()=>{
  const claims={iss:TRUST.issuer,aud:TRUST.audience,owner_id:TRUST.ownerId,project_id:TRUST.projectId,environment:'production',
    sub:'owner:econometricsedwards-projects:project:sec-edgar-terminal:environment:production',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600};
  let forwarded;
  const handler=createScopeGateway({verify:async()=>claims,env:key=>key==='SUPABASE_URL'?'https://vvkihuduqqnxqahhbphs.supabase.co':'test-key',
    fetchImpl:async(_url,init)=>{forwarded=JSON.parse(init.body);return Response.json({periods});}});
  const body=JSON.stringify({operation:'peer_history',payload:{rssd:1,period,peers:[2],snapshotId:'pinned'}});
  assert.equal((await handler(new Request('https://example.test',{method:'POST',body}))).status,401);assert.equal(forwarded,undefined);
  assert.equal((await handler(new Request('https://example.test',{method:'POST',body,headers:{authorization:'Bearer '+ 'a'.repeat(30)}}))).status,200);
  assert.equal(forwarded.p_operation,'peer_history');assert.deepEqual(forwarded.p_payload.peers,[2]);
});
