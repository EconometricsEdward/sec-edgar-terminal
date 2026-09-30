import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPeerService } from '../src/utils/bank/peerService.js';
import { createPeerApi } from '../src/utils/bank/peerApi.js';
import { createBankViewRequests } from '../src/utils/bank/viewRequests.js';
import { isBankReferenceResult } from '../src/utils/bank/referenceResult.js';
import { parseUbprXbrl } from '../src/utils/bank/ubpr.js';

const rssd=451965,period='2026-06-30',hash='a'.repeat(64);
const parsed=parseUbprXbrl(readFileSync(new URL('./fixtures/ubpr-451965-2026-06-30.xml',import.meta.url),'utf8'),{rssd,period});
const reference=()=>({rssd,period,ubpr:{status:'ready',report:{id_rssd:rssd,report_date:period,source_sha256:hash,retrieved_at:'2026-09-28T03:00:00Z',data:structuredClone(parsed)}}});
const request={kind:'reference',rssd,period};

test('optional UBPR reads touch only the selected reference and never reload the peer universe',async()=>{
  const calls=[];
  const service=createPeerService({store:async(op,payload)=>{
    calls.push([op,payload]);
    if(op==='peer_universe')return {snapshot:{id:'selected'},profiles:[]};
    if(op==='ubpr_read')return reference().ubpr;
    assert.fail(op);
  }});
  await service(rssd,period);
  assert.deepEqual(calls.map(([op])=>op),['peer_universe']);
  assert.equal((await service.reference(rssd,period)).ubpr.report.source_sha256,hash);
  await service.reference(rssd,period);
  assert.deepEqual(calls.map(([op])=>op),['peer_universe','ubpr_read','ubpr_read']);
  assert.deepEqual(calls[1][1],{rssd,period});
});

test('unavailable references do not break current-quarter peer analysis and shared-cache expiry caps process reuse',async()=>{
  let time=0,reads=0;
  const service=createPeerService({now:()=>time,loadUniverse:async()=>{
    reads++;return {snapshot:{id:'selected'},profiles:[],cacheExpiresAt:time+1000};
  },store:async()=>{throw Error('optional source is down');}});
  await service(rssd,period);
  await assert.rejects(service.reference(rssd,period));
  await service(rssd,period);assert.equal(reads,1);
  time=1001;await service(rssd,period);assert.equal(reads,2);
});

test('reference endpoint excludes mixed modes, validates source identity and never publicly caches pending results',async()=>{
  let body=reference(),calls=0;
  const GET=createPeerApi({rateLimit:async()=>({allowed:true}),analyze:()=>assert.fail('matching should not run'),history:()=>assert.fail('history should not run'),reference:async()=>{calls++;return body;}});
  const url=`https://example.test/api/banks/peers?rssd=${rssd}&period=${period}`;
  for(const suffix of ['&reference=0','&reference=1&history=1','&reference=1&reference=1'])assert.equal((await GET(new Request(url+suffix))).status,400);
  assert.equal(calls,0);
  let response=await GET(new Request(url+'&reference=1'));
  assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control'),/public/);
  assert.deepEqual(await response.json(),body);
  body={rssd,period,ubpr:{status:'running',report:null}};
  // An explicit refresh rechecks a changed source instead of the short ready-result cache.
  response=await GET(new Request(url+'&reference=1',{cache:'no-cache'}));
  assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control'),/no-store/);
  body=reference();body.ubpr.report.id_rssd=2;
  response=await GET(new Request(url+'&reference=1'));
  assert.equal(response.status,503);assert.match(await response.text(),/Peer benchmarks remain available/);
});

test('reference response rejects mismatched reports, raw XML, unsafe metrics and incorrect envelopes',()=>{
  assert.equal(isBankReferenceResult(reference(),rssd,period),true);
  for(const mutate of [
    body=>body.rssd=2,
    body=>body.period='2026-03-31',
    body=>body.ubpr.report.report_date='2026-03-31',
    body=>body.ubpr.report.source_sha256='invalid',
    body=>body.ubpr.report.raw_xbrl='private source XML',
    body=>body.ubpr.report.data.rssd=2,
    body=>body.ubpr.report.data.metrics[0].value=Infinity,
    body=>body.ubpr.report.data.metrics[0].unit='USD',
    body=>body.ubpr.status='unexpected',
  ]){
    const body=reference();mutate(body);assert.equal(isBankReferenceResult(body,rssd,period),false);
  }
});

test('browser reference reads coalesce, preserve identities, retry failures and use only the lightweight endpoint',async()=>{
  let body=reference(),calls=0;const urls=[];
  const load=createBankViewRequests({fetchImpl:async url=>{calls++;urls.push(url);return body?Response.json(body):Response.json({}, {status:503});}});
  const values=await Promise.all(Array.from({length:20},()=>load(request)));
  assert.equal(calls,1);assert.equal(values[0].ubpr.report.data.metrics[0].value,parsed.metrics[0].value);
  assert.ok(urls.every(url=>url.endsWith('reference=1')&&!url.includes('history=')));
  body=null;await assert.rejects(load({...request,refresh:true}),/Peer benchmarks remain available/);
  body=reference();body.ubpr.report.data.period='2026-03-31';await assert.rejects(load(request),/verified/);
  body=reference();await load(request);await load(request);assert.equal(calls,4);
  body={rssd,period,ubpr:{status:'retry',report:null}};
  await load({...request,refresh:true});await load(request);assert.equal(calls,6);
});
