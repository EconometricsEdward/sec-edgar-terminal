import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { authorizeSecCoverageSchedule } from '../src/utils/secCoverageScheduleAuth.js';
import { createDataStore } from '../src/utils/dataStore.js';

const endpoint = 'https://secedgarterminal.com/api/cron/sec-coverage';
const timestamp = Math.floor(Date.parse('2026-09-13T12:00:00.000Z')/1000);
const nonce = '38621c4e-3538-4fbb-83c4-c6fb10799020';
const signature = createHmac('sha256','fixture-never-a-real-credential').update(`edgar-sec-coverage-v2\nGET\n/api/cron/sec-coverage\n${timestamp}\n${nonce}`).digest('hex');
const headers = { 'x-edgar-schedule-timestamp':String(timestamp), 'x-edgar-schedule-nonce':nonce, 'x-edgar-schedule-signature':signature };
function request({ url=endpoint, method='GET', patch={} }={}) { return new Request(url,{method,headers:{...headers,...patch}}); }
function fixture(extra={}) {
  const rates=[],verifications=[];
  return { rates,verifications,options:{env:{VERCEL_ENV:'production'},now:()=>timestamp*1000,
    rateLimit:async options=>{rates.push(options);return {allowed:true};},
    verify:async value=>{verifications.push(value);return true;},...extra} };
}

test('scheduler passes only validated signed fields after shared pre-auth rate checks', async()=>{
  const f=fixture();
  assert.equal(await authorizeSecCoverageSchedule(request(),f.options),true);
  assert.deepEqual(f.verifications,[{timestamp,nonce,signature}]);
  assert.equal(f.rates.length,2); assert.equal(f.rates[0].max,60); assert.equal(f.rates[1].max,20);
  assert.equal(f.rates[0].windowMs,60000);
});

test('signed credentials cannot authorize another host, path, method, query, or preview', async()=>{
  for(const options of [{url:`${endpoint}?shard=1`},{url:'https://example.com/api/cron/sec-coverage'},
    {url:'https://secedgarterminal.com/api/cron/prewarm'},{method:'POST'}]) {
    const f=fixture(); assert.equal(await authorizeSecCoverageSchedule(request(options),f.options),false);
    assert.equal(f.rates.length,0); assert.equal(f.verifications.length,0);
  }
  const f=fixture({env:{VERCEL_ENV:'preview'}});
  assert.equal(await authorizeSecCoverageSchedule(request(),f.options),false);
  assert.equal(f.verifications.length,0);
});

test('malformed, expired and future headers are refused before Redis or database work', async()=>{
  const invalid = [ {'x-edgar-schedule-timestamp':String(timestamp-301)}, {'x-edgar-schedule-timestamp':String(timestamp+31)},
    {'x-edgar-schedule-timestamp':`0${timestamp}`},{'x-edgar-schedule-timestamp':'NaN'}, {'x-edgar-schedule-nonce':'invalid'},
    {'x-edgar-schedule-nonce':nonce.toUpperCase()}, {'x-edgar-schedule-signature':'f'.repeat(65)}, {'x-edgar-schedule-signature':''} ];
  for(const patch of invalid) {
    const f=fixture(); assert.equal(await authorizeSecCoverageSchedule(request({patch}),f.options),false);
    assert.equal(f.rates.length,0); assert.equal(f.verifications.length,0);
  }
});

test('rate limits, refused signatures, malformed verifier results and verification errors fail closed',async()=>{
  for(const extra of [{rateLimit:async()=>({allowed:false})},{rateLimit:async()=>{throw new Error('Private diagnostic');}},
    {verify:async()=>false},{verify:async()=>({valid:true})},{verify:async()=>{throw new Error('Private diagnostic');}}]) {
    const f=fixture(extra);assert.equal(await authorizeSecCoverageSchedule(request(),f.options),false);
    if(extra.rateLimit)assert.equal(f.verifications.length,0);
  }
});

test('existing cron credential permits bounded operator route queries without consuming a signed nonce',async()=>{
  const secret='fixture-production-cron-credential';
  const f=fixture({env:{VERCEL_ENV:'production',CRON_SECRET:secret}});
  assert.equal(await authorizeSecCoverageSchedule(request({url:`${endpoint}?shard=1`,patch:{authorization:`Bearer ${secret}`}}),f.options),true);
  assert.equal(f.rates.length,0); assert.equal(f.verifications.length,0);
  assert.equal(await authorizeSecCoverageSchedule(new Request(endpoint,{headers:{authorization:`Bearer ${'a'.repeat(64)}`}}),f.options),false);
});

test('the datastore verification wrapper exposes only a boolean and narrow fields',async()=>{
  const calls=[];
  const store=createDataStore({env:{SUPABASE_URL:'http://127.0.0.1:54321',SUPABASE_SECRET_KEY:'sb_secret_fixture',EDGAR_DATASTORE_NAMESPACE:'fixture'},
    fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json(true);} });
  assert.equal(await store.verifyCoverageScheduleSignature({timestamp,nonce,signature}),true);
  assert.match(calls[0].url,/edgar_authorize_coverage_schedule$/);
  assert.deepEqual(calls[0].body,{p_namespace:'fixture',p_timestamp:timestamp,p_nonce:nonce,p_signature:signature});
  await assert.rejects(store.verifyCoverageScheduleSignature({timestamp,nonce:'invalid',signature}),{code:'invalid_schedule_signature'});
  assert.equal(calls.length,1);
});
