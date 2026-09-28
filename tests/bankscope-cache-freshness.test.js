import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankApi } from '../src/utils/bank/api.js';
import { createPeerApi } from '../src/utils/bank/peerApi.js';
import { createExposureApi } from '../src/utils/bank/exposureApi.js';
import { createBankViewRequests } from '../src/utils/bank/viewRequests.js';

const period='2026-06-30',rssd=451965;
const rateLimit=async()=>({allowed:true});
const freshness={checkedAt:'2026-09-28T00:00:00.000Z',stale:true};
test('saved reports, peers and exposures cannot have their stale lifetime extended by the CDN',async()=>{
  const routes=[
    [createBankApi({rateLimit,store:async()=>({jobs:[],publicReadCache:freshness})}).GET,`/api/banks?rssds=${rssd}`],
    [createPeerApi({rateLimit,analyze:async()=>({publicPeerCache:freshness})}),`/api/banks/peers?rssd=${rssd}&period=${period}`],
    [createExposureApi({rateLimit,analyze:async()=>({missing:[],publicReadCache:freshness})}),`/api/banks/exposures?rssd=${rssd}&period=${period}`],
  ];
  for(const [get,path] of routes){
    const response=await get(new Request(`https://example.test${path}`));
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.ok(Object.values(await response.json()).some(value=>value?.checkedAt===freshness.checkedAt));
  }
});
test('returning to a stale peer view rechecks the server rather than renewing browser reuse',async()=>{
  let calls=0,stale=true;
  const load=createBankViewRequests({fetchImpl:async()=>{
    calls++;
    return Response.json({rssd,period,bank:{rssd},peers:[],benchmarks:[],universeCount:1,eligibleCount:1,
      snapshot:{id:'published'},status:'small_cohort',publicPeerCache:{...freshness,stale}});
  }});
  const request={kind:'peers',rssd,period};
  await load(request);await load(request);assert.equal(calls,2);
  stale=false;
  await load(request);await load(request);assert.equal(calls,3);
});
