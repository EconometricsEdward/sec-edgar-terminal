import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createFfiecClient, classifyFfiecError, quotaRetryAt } from '../src/utils/bank/client.js';
import { verifyPanel, latestPeriods, PILOT_BANKS } from '../src/utils/bank/identity.js';
import { decodeFacsimile, parseCallXbrl, pickFact } from '../src/utils/bank/parser.js';
import { BANK_METRICS, normalizeMetrics, validateMetrics } from '../src/utils/bank/metrics.js';
import { createBankStore } from '../src/utils/bank/store.js';
import { ingestBankPilot } from '../src/utils/bank/ingest.js';
import { isBankPreview } from '../src/utils/bank/errors.js';
import { BANK_TRUST, validBankClaims, createBankGateway } from '../supabase/functions/bank-pilot-gateway/handler.js';
const date = '2026-06-30';
const panel = PILOT_BANKS.map((b,i) => ({ Name: b.name, ID_RSSD: 101+i, FilingType: '031', HasFiledForReportingPeriod: true }));
const values = { RCFD2170: 1000000, RCFD2948: 800000, RCFDG105: 200000, RCFD2122: 500000, RCFD5369: 50000, RCFDB528: 450000,
  RIAD4107: 10000, RIAD4073: 4000, RIAD4074: 6000, RCFA8274: 100000, RCFWP859: 90000, RCFA3792: 120000,
  RCFAA223: 500000, RCFAP793: .18, RCFA7206: .2, RCFA7205: .24, RCFA7204: .1 };
function xml(overrides = {}) {
  const all = Object.fromEntries(BANK_METRICS.flatMap(m => m.codes).filter(c => c !== 'RCFAP859').map(c => [c, values[c] ?? 1000]));
  return `<?xml version="1.0"?><xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:cc="http://ffiec.gov/test" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <xbrli:context id="instant"><xbrli:entity><xbrli:identifier scheme="ID_RSSD">101</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>${date}</xbrli:instant></xbrli:period></xbrli:context>
  <xbrli:context id="ytd"><xbrli:entity><xbrli:identifier scheme="ID_RSSD">101</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>${date}</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:unit id="USD"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><xbrli:unit id="pure"><xbrli:measure>xbrli:pure</xbrli:measure></xbrli:unit>
  ${Object.entries({...all,...overrides}).filter(([,v])=>v!==undefined).map(([c,v])=>`<cc:${c} contextRef="${c.startsWith('RIAD')?'ytd':'instant'}" unitRef="${BANK_METRICS.some(m=>m.unit==='percent'&&m.codes.includes(c))?'pure':'USD'}" decimals="-3"${v===null?' xsi:nil="true"':''}>${v??''}</cc:${c}>`).join('')}</xbrli:xbrl>`;
}
const parsed = overrides => parseCallXbrl(xml(overrides), { rssd: 101, reportDate: date });

test('FFIEC identities are exact legal bank panel matches, never ticker/parent matches', () => {
  assert.deepEqual(verifyPanel(panel,date).map(b=>b.rssd),[101,102,103]);
  assert.throws(()=>verifyPanel([{...panel[0],Name:'JPMorgan Chase & Co.'},...panel.slice(1)],date),{code:'institution_not_found'});
  assert.throws(()=>verifyPanel([...panel,panel[0]],date),{code:'institution_identity_ambiguous'});
  assert.equal(verifyPanel([{...panel[0],Name:'JPMorgan Chase Bank, N.A.'},...panel.slice(1)],date)[0].rssd,101);
});
test('periods are deduplicated, sorted, not future dated, and limited to four',()=>assert.deepEqual(latestPeriods(['06/30/2026','03/31/2026','12/31/2025','09/30/2025','06/30/2025','09/30/2026'],new Date('2026-09-25')),['2026-06-30','2026-03-31','2025-12-31','2025-09-30']));
test('facsimiles decode byte-array/base64/XML; invalid bodies fail',()=>{
  assert.equal(decodeFacsimile([...Buffer.from(xml())]),xml());
  assert.equal(decodeFacsimile(Buffer.from(xml()).toString('base64')),xml());
  assert.equal(decodeFacsimile({FacsimileFile:[...Buffer.from(xml())]}),xml());
  assert.throws(()=>decodeFacsimile({message:'invalid'}),{code:'parsing_failure'});
});
test('XBRL preserves entity, context, dates, units, raw values and accuracy without rescaling dollars',()=>{
  const m=normalizeMetrics(parsed()); const a=m.find(x=>x.key==='assets');
  assert.equal(a.value,1000000); assert.equal(a.lineage[0].rawValue,'1000000'); assert.equal(a.lineage[0].decimals,'-3');
  assert.equal(m.find(x=>x.key==='cet1_ratio').value,18); assert.equal(m.find(x=>x.key==='net_income').startDate,'2026-01-01');
  assert.equal(validateMetrics(m).passed,true);
});
test('missing/nil differ from zero; missing components never become a sum',()=>{
  const m=normalizeMetrics(parsed({RCFD1403:0,RCFD1406:null,RCFN2200:undefined}));
  assert.equal(m.find(x=>x.key==='nonaccrual').value,0); assert.equal(m.find(x=>x.key==='past_due_30_89').value,null);
  assert.equal(m.find(x=>x.key==='deposits').value,null);
});
test('FFIEC HTM stock encoded in a duration context requires independent schedule reconciliation',()=>{
  const source=xml({RCFDJJ34:950,RCFD1754:1000,RIADJH93:50}).replace('<cc:RCFDJJ34 contextRef="instant"','<cc:RCFDJJ34 contextRef="ytd"');
  const m=normalizeMetrics(parseCallXbrl(source,{rssd:101,reportDate:date})).find(m=>m.key==='securities');
  assert.equal(m.value,2950);assert.equal(m.lineage[0].corroboration.length,2);
  const wrong=source.replace('>50</cc:RIADJH93>','>10000</cc:RIADJH93>');
  assert.equal(normalizeMetrics(parseCallXbrl(wrong,{rssd:101,reportDate:date})).find(m=>m.key==='securities').value,null);
});
test('wrong entity/quarter, unsafe XML, wrong context and conflicting duplicate facts are rejected',()=>{
  assert.throws(()=>parseCallXbrl(xml(),{rssd:999,reportDate:date}),{code:'source_identity_period_mismatch'});
  assert.throws(()=>parseCallXbrl('<!DOCTYPE x>'+xml(),{rssd:101,reportDate:date}),{code:'parsing_failure'});
  assert.equal(pickFact(parsed(),'RIAD4340','instant').value,null);
  const conflict=xml().replace('</xbrli:xbrl>','<cc:RCFD2170 contextRef="instant" unitRef="USD">999</cc:RCFD2170></xbrli:xbrl>');
  assert.equal(pickFact(parseCallXbrl(conflict,{rssd:101,reportDate:date}),'RCFD2170').reason,'conflicting_source_facts');
});
test('capital bases cannot be silently mixed and reconciliation catches ratio scaling errors',()=>{
  assert.equal(normalizeMetrics(parsed({RCFAP859:50000})).find(m=>m.key==='cet1').reason,'ambiguous_capital_column');
  assert.equal(validateMetrics(normalizeMetrics(parsed({RCFAP793:18}))).passed,false);
});
test('saved official three-bank FFIEC excerpts map every pilot metric and reconcile financial totals',async()=>{
  for (const [rssd,assets,securities] of [[852218,4091315000000,808482000000],[480228,2654645000000,835065000000],[451965,1907928000000,442269000000]]) {
    const source=await readFile(new URL(`./fixtures/bank-${rssd}-${date}.xml`,import.meta.url),'utf8');
    const metrics=normalizeMetrics(parseCallXbrl(source,{rssd,reportDate:date}));
    assert.equal(metrics.filter(m=>m.value===null).length,0);assert.equal(metrics.find(m=>m.key==='assets').value,assets);
    assert.equal(metrics.find(m=>m.key==='securities').value,securities);assert.equal(validateMetrics(metrics).passed,true);
  }
});
test('429 and FFIEC 403 quotas are distinct from authentication; Retry-After and reset text respected',()=>{
  const now=Date.parse('2026-09-25T00:00:00Z');
  assert.equal(classifyFfiecError(403,'Out of call volume quota. Quota will be replenished in 00:35:00.',new Headers(),now).retryAt,'2026-09-25T00:35:00.000Z');
  assert.equal(classifyFfiecError(429,'',new Headers({'retry-after':'120'}),now).code,'quota_exhausted');
  assert.equal(classifyFfiecError(400,'Security Token is expired.',new Headers()).code,'authentication_failure');
  assert.equal(quotaRetryAt(new Headers({'retry-after':'Fri, 25 Sep 2026 00:02:00 GMT'}),'',now),'2026-09-25T00:02:00.000Z');
});
test('client serializes requests, retries transient failures, sends official headers, and never follows redirects',async()=>{
  let active=0,maxActive=0,calls=0; const waits=[];
  const client=createFfiecClient({env:{FFIEC_CDR_BASE_URL:'https://ffieccdr.azure-api.us/public',FFIEC_CDR_USER_ID:'fixture-user',FFIEC_CDR_TOKEN:'fixture-token'},
    gate:{reserve:async()=>({allowed:true}),cooldown:async()=>{}},sleep:async ms=>waits.push(ms),fetchImpl:async(url,opts)=>{
      active++;maxActive=Math.max(maxActive,active);assert.equal(opts.headers.Authentication,'Bearer fixture-token');assert.equal(opts.headers.UserID,'fixture-user');assert.equal(opts.redirect,'error');calls++;active--;
      return calls===1?new Response('Unavailable',{status:503}):Response.json(['06/30/2026']);
    }});
  await Promise.all([client.request('RetrieveReportingPeriods'),client.request('RetrieveReportingPeriods')]);
  assert.equal(calls,3);assert.equal(maxActive,1);assert.equal(waits.length,1);
});
test('quota failure publishes cooldown once, never loops or includes upstream error text',async()=>{
  let calls=0,cooldowns=0;
  const client=createFfiecClient({env:{FFIEC_CDR_BASE_URL:'https://ffieccdr.azure-api.us/public',FFIEC_CDR_USER_ID:'fixture-user',FFIEC_CDR_TOKEN:'fixture-token'},
    gate:{reserve:async()=>({allowed:true}),cooldown:async()=>cooldowns++},fetchImpl:async()=>{calls++;return new Response('Out of call volume quota secret',{status:403});}});
  await assert.rejects(client.request('RetrieveReportingPeriods'),e=>e.code==='quota_exhausted'&&!e.message.includes('secret'));
  assert.equal(calls,1);assert.equal(cooldowns,1);
});
test('preview guards deny production and other branches; readers request database only',async()=>{
  assert.equal(isBankPreview({VERCEL_ENV:'production',VERCEL_GIT_COMMIT_REF:'feat/ffiec-bank-pilot'}),false);
  let calls=0;const store=createBankStore({env:{VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'feat/ffiec-bank-pilot'},identity:async()=>'fixture-oidc',fetchImpl:async(url)=>{
    assert.equal(url,'https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/bank-pilot-gateway');calls++;return Response.json({reports:[]});}});
  await store('read');await store('read');assert.equal(calls,2);
});
test('bank gateway accepts only intended preview identity; production identity has no access',async()=>{
  const p={iss:BANK_TRUST.issuer,aud:BANK_TRUST.audience,sub:BANK_TRUST.subject,owner_id:BANK_TRUST.ownerId,project_id:BANK_TRUST.projectId,environment:'preview',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600};
  assert.equal(validBankClaims(p),true);assert.equal(validBankClaims({...p,environment:'production'}),false);
  const handler=createBankGateway({verify:async()=>p,env:()=>undefined});
  assert.equal((await handler(new Request('https://example.test',{method:'POST'}))).status,401);
});
test('exact SQL: atomic publishing, duplicate prevention, nulls, RLS, shared lease and database retrieval',async()=>{
  const db=new PGlite();try{
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema edgar_private; grant usage on schema edgar_private,public to service_role;');
    await db.exec(await readFile(new URL('../supabase/migrations/20260925051054_ffiec_bank_pilot.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20260925052649_ffiec_bank_source_recovery.sql',import.meta.url),'utf8'));
    const op=async(name,p={})=>(await db.query('select public.bank_pilot_operation($1,$2::jsonb) as v',[name,JSON.stringify(p)])).rows[0].v;
    const owner=randomUUID();assert.equal((await op('begin',{owner})).allowed,true);
    assert.equal((await op('begin',{owner:randomUUID()})).allowed,false);
    await op('discovery',{owner,value:{periods:[date]}});
    await assert.rejects(op('discovery',{owner,value:{periods:['2025-03-31']}}),/pilot_periods_frozen/);
    await op('institution',{owner,...verifyPanel(panel,date)[0]});
    const source=parsed({RCFD1406:null}),metrics=normalizeMetrics(source);
    const record={owner,rssd:101,reportDate:date,retrievedAt:new Date().toISOString(),rawXbrl:xml({RCFD1406:null}),sha256:source.sha256,parserVersion:'fixture',validation:validateMetrics(metrics),metadata:{},metrics};
    assert.equal((await op('publish',record)).stored,true);assert.equal((await op('publish',record)).duplicate,true);
    assert.equal((await op('read')).reports.length,1);assert.equal((await op('read')).reports[0].metrics.find(m=>m.key==='past_due_30_89').value,null);
    assert.equal((await op('reserve',{owner,method:'RetrieveReportingPeriods'})).allowed,true);
    assert.equal((await op('reserve',{owner,method:'RetrieveReportingPeriods'})).allowed,false);
    assert.equal((await op('read')).requestCount,1);
    await assert.rejects(op('publish',{...record,reportDate:'2024-06-30'}),/pilot_period_cap/);
    await db.exec('set role anon');await assert.rejects(op('read'),/permission denied/);await db.exec('reset role');
    await op('finish',{owner,result:{status:'done'}});
  }finally{await db.close();}
});
test('complete stored pilot rerun dispatches no FFIEC requests',async()=>{
  let requests=0;const periods=['2026-06-30','2026-03-31','2025-12-31','2025-09-30'];
  const state={discovery:{periods},reports:periods.flatMap(report_date=>panel.map(b=>({report_date,id_rssd:b.ID_RSSD,validation:{passed:true},metrics:[]})))};
  const result=await ingestBankPilot({store:async op=>op==='begin'?{allowed:true}:op==='read'?state:{ok:true},clientFactory:()=>({request:()=>{requests++;throw Error('Unexpected');}})});
  assert.equal(result.skipped,12);assert.equal(requests,0);
});
