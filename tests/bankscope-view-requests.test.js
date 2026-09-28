import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBankViewRequests } from '../src/utils/bank/viewRequests.js';
import { watchPeerPreparation } from '../src/utils/bank/peerRefresh.js';
import { buildPeerAnalysis } from '../src/utils/bank/peerModel.js';
import { buildPeerHistory } from '../src/utils/bank/peerHistory.js';
import { parseCallXbrl } from '../src/utils/bank/parser.js';
import { buildExposureReport } from '../src/utils/bank/exposureModel.js';

const period='2026-06-30',hash='a'.repeat(64);
const request={kind:'peers',rssd:451965,period};
const peers=(rssd=451965,date=period)=>({period:date,bank:{rssd},peers:[],benchmarks:[],universeCount:1,eligibleCount:1,snapshot:{id:'snapshot'},status:'small_cohort',ubpr:{status:'ready'}});
const exposure=(sourceHash=hash)=>({rssd:451965,period,periods:[period],missing:[],reports:[{rssd:451965,period,hash:sourceHash,values:{},facts:{}}]});
const history=snapshotId=>({rssd:'451965',period,snapshotId,cohort:['2'],periods:[period],snapshots:[{report_date:period}],metrics:[{points:[{period,sourceAvailable:true,value:null,peerMedian:null}]}]});

test('actual peer, fixed-cohort history and parsed exposure model outputs remain reusable without losing missing metrics',async()=>{
  const profile={rssd:451965,name:'Wells Fargo Bank',assets:100,loanMix:[.5,.2,.2,.1],loanShare:.6,funding:[.8,.2,.05],metrics:{roa:1}};
  const profiles=[profile,...Array.from({length:6},(_,i)=>({...profile,rssd:i+2}))];
  const analysis={...buildPeerAnalysis({snapshot:{id:'snapshot'},profiles},451965),period,ubpr:{status:'ready'}};
  const historical=buildPeerHistory({periods:[period],snapshots:[{report_date:period}],profiles:profiles.map(p=>({...p,period}))},analysis,period);
  const xml=readFileSync(new URL('./fixtures/exposures-451965-2026-06-30.xml',import.meta.url),'utf8');
  const report=buildExposureReport(parseCallXbrl(xml,{rssd:451965,reportDate:period}),{form:'031'});
  const exposures={rssd:451965,period,periods:[period],reports:[report],missing:[]};let calls=0;
  const load=createBankViewRequests({fetchImpl:async url=>{calls++;return Response.json(url.includes('/exposures?')?exposures:url.includes('history=1')?historical:analysis);}});
  for(const options of [request,{...request,kind:'history',snapshotId:'snapshot'},{...request,kind:'exposures',sourceHash:report.hash}]){
    const a=await load(options),b=await load(options);assert.deepEqual(a,b);
  }
  assert.equal(calls,3);
  assert.equal((await load({...request,kind:'history',snapshotId:'snapshot'})).metrics.find(m=>m.key==='cet1').points[0].value,null);
});

test('simultaneous reads and returning to a tab share one request; subscriber cancellation is isolated',async()=>{
  let calls=0,time=0,finish;
  const load=createBankViewRequests({now:()=>time,fetchImpl:async()=>{calls++;return new Promise(resolve=>{finish=()=>resolve(Response.json(peers()));});}});
  const controller=new AbortController(),cancelled=load({...request,signal:controller.signal}),other=load(request);
  controller.abort();await assert.rejects(cancelled,{name:'AbortError'});
  finish();const value=await other;assert.equal(calls,1);
  value.bank.rssd=999;assert.equal((await load(request)).bank.rssd,451965);assert.equal(calls,1);
  time=30001;const next=load(request);finish();await next;assert.equal(calls,2);
});

test('bank, date, source hash and peer snapshot remain separate and unverifiable responses are retried',async()=>{
  let calls=0,body;
  const load=createBankViewRequests({fetchImpl:async url=>{calls++;const q=new URL(url,'https://example.test').searchParams;return Response.json(body||peers(Number(q.get('rssd')),q.get('period')));}});
  await load(request);await load({...request,rssd:2});await load({...request,period:'2026-03-31'});assert.equal(calls,3);
  body=history('one');await load({...request,kind:'history',snapshotId:'one'});
  body=history('two');await load({...request,kind:'history',snapshotId:'two'});assert.equal(calls,5);
  body=history('wrong');await assert.rejects(load({...request,kind:'history',snapshotId:'three'}),/source data refreshed/);
  await assert.rejects(load({...request,kind:'history',snapshotId:'three'}));assert.equal(calls,7);
  body=exposure();await load({...request,kind:'exposures',sourceHash:hash});
  const nextHash='b'.repeat(64);await assert.rejects(load({...request,kind:'exposures',sourceHash:nextHash}),/verified/);
  body=exposure(nextHash);await load({...request,kind:'exposures',sourceHash:nextHash});assert.equal(calls,10);
  body=peers(999);await assert.rejects(load({...request,refresh:true}),/verified/);
  body=peers();await load(request);assert.equal(calls,12);
});

test('pending preparation, missing exposure history and failed requests never become reusable results',async()=>{
  let calls=0,body={rssd:451965,period,ubpr:{report:null,status:'retry'}};
  const load=createBankViewRequests({fetchImpl:async()=>{calls++;return body===null?Response.json({error:'unavailable'},{status:503}):Response.json(body);}});
  await load({...request,kind:'reference'});await load({...request,kind:'reference'});assert.equal(calls,2);
  body={...exposure(),missing:['2026-03-31']};const exposureRequest={...request,kind:'exposures',sourceHash:hash};
  await load(exposureRequest);await load(exposureRequest);assert.equal(calls,4);
  body=null;await assert.rejects(load(request));await assert.rejects(load(request));assert.equal(calls,6);
  body=peers();await load(request);await load(request);assert.equal(calls,7);
  await load({...request,refresh:true});assert.equal(calls,8);
});

test('entry count, result bytes, and concurrent transports are bounded',async()=>{
  let calls=0;
  const load=createBankViewRequests({maxEntries:2,fetchImpl:async url=>{calls++;return Response.json(peers(Number(new URL(url,'https://example.test').searchParams.get('rssd'))));}});
  await load({...request,rssd:1});await load({...request,rssd:2});await load({...request,rssd:3});await load({...request,rssd:1});assert.equal(calls,4);
  const small=createBankViewRequests({maxEntryBytes:20,fetchImpl:async()=>{calls++;return Response.json(peers());}});
  await small(request);await small(request);assert.equal(calls,6);
  const payloadBytes=new TextEncoder().encode(JSON.stringify(peers(1))).byteLength;
  const budget=createBankViewRequests({maxBytes:payloadBytes+10,fetchImpl:async url=>{calls++;return Response.json(peers(Number(new URL(url,'https://example.test').searchParams.get('rssd'))));}});
  await Promise.all([budget({...request,rssd:1}),budget({...request,rssd:2})]);
  await budget({...request,rssd:1});assert.equal(calls,9);
  const finish=[];
  const limited=createBankViewRequests({maxInFlight:2,fetchImpl:async()=>new Promise(resolve=>finish.push(()=>resolve(Response.json(peers()))))});
  const a=limited(request),b=limited({...request,period:'2026-03-31'});
  await assert.rejects(limited({...request,rssd:3}),/Several bank views/);
  finish.forEach(resolve=>resolve());await a;await assert.rejects(b,/verified/);
});

function controls(){
  let id=0;const timers=new Map(),listeners=new Set();
  const documentImpl={visibilityState:'visible',addEventListener:(_event,callback)=>listeners.add(callback),removeEventListener:(_event,callback)=>listeners.delete(callback)};
  return {documentImpl,setTimer:fn=>{timers.set(++id,fn);return id;},clearTimer:id=>timers.delete(id),count:()=>timers.size,
    tick:async()=>{const [id,fn]=timers.entries().next().value||[];if(fn){timers.delete(id);await fn();}},
    visibility:value=>{documentImpl.visibilityState=value;listeners.forEach(fn=>fn());},listeners:()=>listeners.size};
}
test('UBPR updates stop in hidden tabs, finish at the bounded budget, and resume only by explicit restart',async()=>{
  const clock=controls();let calls=0,pause='';
  const options={...clock,maxAttempts:2,load:async()=>{calls++;return {...peers(),ubpr:{status:'running'}};},onData:()=>{},onPause:value=>{pause=value;}};
  const stop=watchPeerPreparation(options);
  clock.visibility('hidden');await clock.tick();assert.equal(calls,0);assert.equal(clock.count(),0);
  clock.visibility('visible');await clock.tick();assert.equal(calls,1);await clock.tick();assert.equal(calls,2);
  assert.match(pause,/paused/);assert.equal(clock.count(),0);clock.visibility('visible');assert.equal(clock.count(),0);
  stop();assert.equal(clock.listeners(),0);
  const restart=watchPeerPreparation(options);await clock.tick();assert.equal(calls,3);restart();
});
test('one failed UBPR update pauses polling; completed results and closed drawers also stop requests',async()=>{
  const clock=controls();let calls=0,paused=0;
  const stop=watchPeerPreparation({...clock,load:async()=>{calls++;throw Error('503');},onData:()=>assert.fail(),onPause:()=>{paused++;}});
  await clock.tick();await clock.tick();assert.equal(calls,1);assert.equal(paused,1);assert.equal(clock.count(),0);stop();
  const ready=watchPeerPreparation({...clock,load:async()=>{calls++;return peers();},onData:()=>{},onPause:()=>assert.fail()});
  await clock.tick();assert.equal(calls,2);assert.equal(clock.count(),0);ready();
  const closed=watchPeerPreparation({...clock,load:async()=>assert.fail(),onData:()=>{},onPause:()=>{}});closed();await clock.tick();assert.equal(clock.count(),0);
});
