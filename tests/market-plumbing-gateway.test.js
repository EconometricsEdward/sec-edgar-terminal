import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketGateway, validMarketClaims, TRUST } from '../supabase/functions/market-research-gateway/handler.js';
const claims = () => ({environment:'production',iss:TRUST.issuer,aud:TRUST.audience,owner_id:TRUST.owner,project_id:TRUST.project,sub:'owner:econometricsedwards-projects:project:sec-edgar-terminal:environment:production',iat:Math.floor(Date.now()/1000)-10,exp:Math.floor(Date.now()/1000)+3500});
const req = (body, auth='Bearer header.payload.signature') => new Request('https://gateway.test',{method:'POST',headers:{Authorization:auth},body:JSON.stringify(body)});
test('gateway verifies workload identity before reading credentials or forwarding requests',async()=>{
  let calls=0;
  const gateway=createMarketGateway({verify:async()=>claims(),env:()=>{calls++;throw new Error('secret');}});
  assert.equal((await gateway(req({operation:'read',payload:{}},''))).status,401);assert.equal(calls,0);
  for(const patch of [{environment:'preview'},{project_id:'other'},{owner_id:'other'},{iss:'other'},{aud:'other'},{sub:'other'},{iat:Date.now()/1000+100},{exp:1}]) assert.equal(validMarketClaims({...claims(),...patch}),false);
});
test('gateway forwards only recognized operations and never returns provider secrets',async()=>{
  const calls=[]; const key='private-fixture-key';
  const handler=createMarketGateway({verify:async()=>claims(),env:n=>({SUPABASE_URL:'https://vvkihuduqqnxqahhbphs.supabase.co',SUPABASE_SERVICE_ROLE_KEY:key})[n],fetchImpl:async(url,init)=>{calls.push([url,init]);return Response.json({ok:true});}});
  assert.equal((await handler(req({operation:'sql',payload:{query:'bad'}}))).status,400);assert.equal(calls.length,0);
  const r=await handler(req({operation:'read',payload:{kind:'funding'}}));assert.equal(r.status,200);assert.equal(calls.length,1);assert.doesNotMatch(await r.text(),/private-fixture/);
  assert.equal(calls[0][1].redirect,'error');
});
