import test from 'node:test';
import assert from 'node:assert/strict';
import { runBankWorker } from '../src/utils/bank/worker.js';
import { refreshPeerUniverse } from '../src/utils/bank/peerWorker.js';
import { PEER_MODEL_VERSION } from '../src/utils/bank/peerSource.js';

const period='2026-06-30';
const stamp=Date.parse('2026-09-28T03:40:00Z');
const iso=new Date(stamp).toISOString();
const maintenance={periods:[period],catalog:{checkedAt:iso},directoryPeriods:[{report_date:period,checked_at:iso}]};

test('user-triggered preparation uses four idle gateway calls and still checks both fenced queues',async()=>{
  const calls=[];
  const result=await runBankWorker({now:()=>stamp,clientFactory:()=>assert.fail('idle work must not contact FFIEC'),store:async(op,payload)=>{
    calls.push([op,payload]);
    if(op==='begin')return {allowed:true};
    if(op==='status')assert.fail('preparation must not read unused maintenance state');
    return null;
  }});
  assert.equal(result.status,'ready');
  assert.deepEqual(calls.map(([op])=>op),['begin','claim','ubpr_claim','finish']);
  const owner=calls[0][1].owner;
  assert.ok(owner);
  assert.ok(calls.every(([,payload])=>payload.owner===owner),'Both queues and cleanup retain the same lease owner');
});

test('idle scheduled maintenance preserves its fresh directory, peer check, and both queue checks',async()=>{
  const calls=[];
  await runBankWorker({maintain:true,now:()=>stamp,clientFactory:()=>assert.fail('fresh maintenance must not contact FFIEC'),store:async op=>{
    calls.push(op);
    if(op==='begin')return {allowed:true};
    if(op==='status')return maintenance;
    if(op==='peer_status')return {snapshots:[{report_date:period,model_version:PEER_MODEL_VERSION,completed_at:iso}]};
    return null;
  }});
  assert.deepEqual(calls,['begin','status','claim','peer_status','ubpr_claim','finish']);
});

test('peer refresh reserves gateway and finish budgets before any backend call',async()=>{
  let calls=0;
  const options={periods:[period],now:()=>stamp,store:async()=>{calls++;return {snapshots:[{report_date:period,model_version:PEER_MODEL_VERSION,completed_at:iso}]};}};
  await assert.rejects(()=>refreshPeerUniverse({...options,deadline:stamp+49999}),{code:'worker_deadline'});
  assert.equal(calls,0);
  assert.equal(await refreshPeerUniverse({...options,deadline:stamp+50000}),0);
  assert.equal(calls,1,'Exactly enough time allows the fresh-snapshot check');
});

test('peer source download needs its longer timeout plus finish reserve',async()=>{
  const calls=[];
  const options={periods:[period],now:()=>stamp,store:async()=>({snapshots:[]}),
    fetchUniverse:async()=>{calls.push('fetch');return {period,rows:Array.from({length:1000},()=>({profile:{},raw:{}}))};},owned:async op=>calls.push(op)};
  await assert.rejects(()=>refreshPeerUniverse({...options,deadline:stamp+59999}),{code:'worker_deadline'});
  assert.deepEqual(calls,[]);
  assert.equal(await refreshPeerUniverse({...options,deadline:stamp+60000}),1000);
  assert.deepEqual(calls,['fetch','peer_start','peer_batch','peer_batch','peer_complete']);
});

test('peer refresh stops between operations and never publishes incomplete or overdue work',async()=>{
  for(const exhaustedAt of ['fetch','peer_start','first_batch','last_batch']){
    let clock=stamp,batches=0;
    const calls=[];
    const exhaust=()=>{clock=stamp+130001;};
    await assert.rejects(()=>refreshPeerUniverse({periods:[period],now:()=>clock,deadline:stamp+180000,
      store:async()=>({snapshots:[]}),fetchUniverse:async()=>{
        calls.push('fetch');if(exhaustedAt==='fetch')exhaust();
        return {period,rows:Array.from({length:1001},()=>({profile:{},raw:{}}))};
      },owned:async(op,payload)=>{
        calls.push(op);
        assert.notEqual(op,'peer_complete','No incomplete/overdue snapshot can become visible');
        if(op==='peer_start'&&exhaustedAt==='peer_start')exhaust();
        if(op==='peer_batch'){
          assert.ok(payload.rows.length<=500);
          batches++;
          if((batches===1&&exhaustedAt==='first_batch')||(batches===3&&exhaustedAt==='last_batch'))exhaust();
        }
      }}),{code:'worker_deadline'});
    const expected={fetch:['fetch'],peer_start:['fetch','peer_start'],first_batch:['fetch','peer_start','peer_batch'],
      last_batch:['fetch','peer_start','peer_batch','peer_batch','peer_batch']}[exhaustedAt];
    assert.deepEqual(calls,expected,exhaustedAt);
  }
});

test('worker passes its original deadline to peer refresh and immediately releases the lease on deferral',async()=>{
  let clock=stamp;
  const calls=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>assert.fail('Insufficient peer time must not start a source download');
  try{
    const result=await runBankWorker({maintain:true,now:()=>clock,store:async(op,payload)=>{
      calls.push([op,payload]);
      if(op==='begin')return {allowed:true};
      if(op==='status')return maintenance;
      if(op==='claim'){clock=stamp+100000;return null;}
      if(op==='peer_status'){clock=stamp+120001;return {snapshots:[]};}
      return null;
    }});
    assert.equal(result.status,'more_available');
    assert.equal(result.peerError,undefined,'A normal time-budget deferral is not a source failure');
    assert.deepEqual(calls.map(([op])=>op),['begin','status','claim','peer_status','finish']);
    assert.equal(calls.at(-1)[1].owner,calls[0][1].owner);
    assert.equal(calls.at(-1)[1].code,null);
  }finally{globalThis.fetch=originalFetch;}
});
