import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFTC_RAW_HISTORY_SCHEMA_VERSION, CFTC_REFRESH_CHECKPOINT_VERSION, cftcPublicationStatus, fetchCftcContractHistory, fetchCftcLatestRows, fetchCftcResource, loadCftcMarkets, parseCftcRetryAfter, presentCftcResponse, readCftcCacheStatus, validCftcRefreshCheckpoint, validateRawHistoryEnvelope } from '../src/utils/cftcServer.js';
import { CFTC_FAMILIES } from '../src/utils/cftc.js';

const fixture=name=>JSON.parse(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8'))[0];

test('official resource requests are allowlisted, bounded, tokenless-capable, and retry once after Retry-After',async()=>{
  const urls=[];let attempt=0;
  const fetchImpl=async(url,options)=>{urls.push({url:String(url),options});attempt++;return attempt===1?new Response('slow',{status:429,headers:{'retry-after':'0'}}):Response.json([fixture('cftc-tff-gpe5-46if-v1.json')]);};
  const result=await fetchCftcResource('tff',{'$limit':1,'$order':'report_date_as_yyyy_mm_dd DESC'},{fetchImpl,retries:1});
  assert.equal(result.rows.length,1);assert.equal(urls.length,2);
  const request=new URL(urls[1].url);assert.equal(request.hostname,'publicreporting.cftc.gov');assert.equal(request.pathname,'/resource/gpe5-46if.json');assert.equal(request.searchParams.get('$limit'),'1');
  assert.equal(urls[1].options.cache,'no-store');assert.equal(parseCftcRetryAfter('120'),60000);
});

test('latest-row pagination continues after an exact full page with deterministic offsets',async()=>{
  const calls=[];
  const fetchImpl=async url=>{const parsed=new URL(url);calls.push(parsed);const offset=Number(parsed.searchParams.get('$offset'));return Response.json(offset===0?Array.from({length:500},(_,index)=>({id:String(index)})):[]);};
  const result=await fetchCftcLatestRows('tff','2026-09-08',{fetchImpl,retries:0});
  assert.equal(result.rows.length,500);assert.equal(calls.length,2);assert.deepEqual(calls.map(url=>url.searchParams.get('$offset')),['0','500']);
  assert.equal(new URL(result.sourceUrl).searchParams.get('$offset'),'0');assert.equal(result.pages,2);
  assert.match(calls[0].searchParams.get('$order'),/cftc_contract_market_code ASC,cftc_market_code ASC,contract_units ASC,id ASC/);
});

test('caller cancellation is reported distinctly and cannot become a successful shared request',async()=>{
  const controller=new AbortController();controller.abort(new DOMException('cancelled','AbortError'));
  const fetchImpl=async(_url,{signal})=>{if(signal.aborted)throw signal.reason;return Response.json([]);};
  await assert.rejects(fetchCftcResource('tff',{'$limit':1},{fetchImpl,retries:0,signal:controller.signal}),error=>error.code==='CFTC_REQUEST_CANCELLED');
});

test('the internal source deadline remains a distinct retryable 504 contract',async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;throw new DOMException('deadline','TimeoutError');};
  await assert.rejects(fetchCftcResource('tff',{'$limit':1},{fetchImpl,retries:1}),error=>error.code==='CFTC_TIMEOUT'&&error.status===504);
  assert.equal(calls,2);
});

test('the loader applies one end-to-end budget rather than restarting a deadline per source phase',async()=>{
  const fetchImpl=async(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  await assert.rejects(loadCftcMarkets({family:'tff',fetchImpl,deadlineMs:25}),error=>error.code==='CFTC_TIMEOUT'&&error.status===504);
});

test('cache publication failures remain distinct from successful official-source computation',()=>{
  const source={status:'ready'};
  const failed=cftcPublicationStatus(source,{cacheRequired:true,primaryPersisted:false,lastGoodPersisted:false,rawHistoryExpected:2,rawHistoryPersisted:1});
  assert.equal(failed.status,'partial');assert.equal(failed.cache_publication.durable,false);assert.match(failed.refresh_warning,/durable cache publication was incomplete/);
  const durable=cftcPublicationStatus(source,{cacheRequired:true,primaryPersisted:true,lastGoodPersisted:true,rawHistoryExpected:2,rawHistoryPersisted:2});
  assert.equal(durable.status,'ready');assert.equal(durable.cache_publication.durable,true);
  const missingLastGood=cftcPublicationStatus(source,{cacheRequired:true,primaryPersisted:true,lastGoodPersisted:false,rawHistoryExpected:1,rawHistoryPersisted:1});
  assert.equal(missingLastGood.status,'partial');assert.equal(missingLastGood.cache_publication.durable,false);assert.match(missingLastGood.refresh_warning,/last-good snapshot/);
});

test('refresh checkpoints are versioned, bounded to known families, and cannot forge completion',()=>{
  const now=Date.parse('2026-09-12T12:00:00Z');
  const base={schema_version:CFTC_REFRESH_CHECKPOINT_VERSION,started_at:'2026-09-12T11:00:00Z',updated_at:'2026-09-12T11:30:00Z',complete:false,families:{tff:{family:'tff',status:'ready',report_date:'2026-09-08',catalog_rows:100,cache_durable:true}}};
  assert.equal(validCftcRefreshCheckpoint(base,now),true);
  assert.equal(validCftcRefreshCheckpoint({...base,complete:true},now),false);
  assert.equal(validCftcRefreshCheckpoint({...base,families:{invented:{status:'ready',report_date:'2026-09-08',catalog_rows:1,cache_durable:true}}},now),false);
  const both={...base,families:{...base.families,disaggregated:{family:'disaggregated',status:'ready',report_date:'2026-09-08',catalog_rows:100,cache_durable:true}}};
  assert.equal(validCftcRefreshCheckpoint({...both,complete:true,completed_at:'2026-09-12T11:20:00Z'},now),true);
});

test('cancellation during retry backoff is normalized to the public 499 contract',async()=>{
  const controller=new AbortController();
  const fetchImpl=async()=>new Response('retry',{status:503,headers:{'retry-after':'1'}});
  setTimeout(()=>controller.abort(new DOMException('cancelled','AbortError')),10);
  await assert.rejects(fetchCftcResource('tff',{'$limit':1},{fetchImpl,retries:1,signal:controller.signal}),error=>error.code==='CFTC_REQUEST_CANCELLED'&&error.status===499);
});

test('cache-only CFTC status validates each family independently and recomputes report age',async()=>{
  const now=new Date('2026-09-12T12:00:00Z'), savedAt='2026-09-12T10:00:00Z';
  const response=(family,report_date,status='ready')=>{const config=CFTC_FAMILIES[family];return {schema_version:'edgar.cftc-positioning.v1',calculation_version:'cftc-positioning-1.0.0',report_family:family,report_basis:'futures_only',report_date,retrieved_at:savedAt,status,source:{agency:'U.S. Commodity Futures Trading Commission',dataset_id:config.datasetId,report_family:config.label,report_basis:'futures_only',url:config.sourceUrl,history_url:null,documentation:config.documentationUrl},groups:config.groups.map(({id,label})=>({id,label})),catalog:[{family,code:'X',reportDate:report_date}],latest:[],coverage:{catalog_rows:1}};};
  const values=new Map([
    ['markets:tff:latest',{savedAt,response:response('tff','2026-09-08')}],
    ['markets:disaggregated:latest',{savedAt,response:response('disaggregated','2026-09-08','partial')}],
  ]);
  const result=await readCftcCacheStatus({now,enabled:()=>true,get:async(_type,id)=>values.get(id)||null});
  assert.equal(result.status,'degraded');assert.deepEqual(result.families.map(item=>item.status),['ready','partial']);assert.ok(result.families.every(item=>item.source_report_age_days===4));
  assert.equal(result.families[0].cache_age_seconds,7200);
});

test('source currency is independent of retrieval age and old latest reports cannot appear ready',async()=>{
  const now=new Date('2026-09-12T12:00:00Z'),savedAt='2026-09-12T11:00:00Z',config=CFTC_FAMILIES.tff;
  const response={schema_version:'edgar.cftc-positioning.v1',calculation_version:'cftc-positioning-1.0.0',report_family:'tff',report_basis:'futures_only',report_date:'2026-08-01',retrieved_at:savedAt,status:'ready',source:{agency:'U.S. Commodity Futures Trading Commission',dataset_id:config.datasetId,report_family:config.label,report_basis:'futures_only',url:config.sourceUrl,history_url:null,documentation:config.documentationUrl},groups:config.groups.map(({id,label})=>({id,label})),catalog:[{family:'tff',code:'X',reportDate:'2026-08-01'}],latest:[],coverage:{catalog_rows:1}};
  const presented=presentCftcResponse(response,{savedAt,now,cacheStatus:'prepared',requireCurrent:true});
  assert.equal(presented.status,'stale');assert.equal(presented.freshness.source_currency,'aged');assert.equal(presented.freshness.source_currency_max_days,14);assert.match(presented.refresh_warning,/42 days old/);
  const partial=presentCftcResponse({...response,status:'partial'},{savedAt,now,cacheStatus:'prepared',requireCurrent:true});assert.equal(partial.status,'partial');assert.match(partial.refresh_warning,/42 days old/);
});

test('raw history envelopes bind family, contract, date, official query, age and compatible history',()=>{
  const selected='2026-09-08',base=fixture('cftc-tff-gpe5-46if-v1.json'),rows=[];
  for(let index=0;index<=52;index++){const date=new Date(`${selected}T00:00:00Z`);date.setUTCDate(date.getUTCDate()-index*7);rows.push({...base,id:`row-${index}`,report_date_as_yyyy_mm_dd:`${date.toISOString().slice(0,10)}T00:00:00.000`});}
  const url=new URL(CFTC_FAMILIES.tff.sourceUrl);url.searchParams.set('$where',`cftc_contract_market_code='13874A' AND report_date_as_yyyy_mm_dd<='${selected}T23:59:59.999'`);url.searchParams.set('$offset','0');
  const envelope={schema_version:CFTC_RAW_HISTORY_SCHEMA_VERSION,family:'tff',report_basis:'futures_only',code:'13874A',through_date:selected,savedAt:'2026-09-09T12:00:00Z',retrievedAt:'2026-09-09T12:00:00Z',sourceUrl:url.toString(),pages:1,capReached:false,sourceExhausted:true,rows};
  assert.equal(validateRawHistoryEnvelope(envelope,{family:'tff',code:'13874A',throughDate:selected,count:52,now:new Date('2026-09-10T00:00:00Z')}),true);
  assert.equal(validateRawHistoryEnvelope({...envelope,family:'disaggregated'},{family:'tff',code:'13874A',throughDate:selected,count:52,now:new Date('2026-09-10T00:00:00Z')}),false);
  assert.equal(validateRawHistoryEnvelope({...envelope,sourceUrl:'https://example.com/resource/gpe5-46if.json'},{family:'tff',code:'13874A',throughDate:selected,count:52,now:new Date('2026-09-10T00:00:00Z')}),false);
  const suppressed=rows.map((row,index)=>index>35?{...row,dealer_positions_long_all:''}:row);
  assert.equal(validateRawHistoryEnvelope({...envelope,sourceExhausted:false,rows:suppressed},{family:'tff',code:'13874A',throughDate:selected,count:52,group:'dealer',now:new Date('2026-09-10T00:00:00Z')}),false);
});

test('bounded contract history uses the selected date and canonical first-page provenance',async()=>{
  const raw=fixture('cftc-tff-gpe5-46if-v1.json'),calls=[];
  const fetchImpl=async url=>{calls.push(new URL(url));return Response.json([{...raw,report_date_as_yyyy_mm_dd:'2026-08-25T00:00:00.000'}]);};
  const result=await fetchCftcContractHistory('tff','13874A','2026-08-25',52,{fetchImpl,retries:0});
  assert.match(calls[0].searchParams.get('$where'),/2026-08-25T23:59:59\.999/);assert.equal(new URL(result.sourceUrl).searchParams.get('$offset'),'0');assert.equal(result.retrievedAt.length>0,true);
});

test('history pagination continues until the selected group has enough valid prior metrics',async()=>{
  const raw=fixture('cftc-tff-gpe5-46if-v1.json'),selected='2026-08-25',calls=[];
  const row=index=>{const date=new Date(`${selected}T00:00:00Z`);date.setUTCDate(date.getUTCDate()-index*7);return {...raw,id:`row-${index}`,report_date_as_yyyy_mm_dd:`${date.toISOString().slice(0,10)}T00:00:00.000`,...(index>40&&index<200?{dealer_positions_long_all:''}:{})};};
  const fetchImpl=async url=>{const parsed=new URL(url),offset=Number(parsed.searchParams.get('$offset'));calls.push(offset);return Response.json(offset===0?Array.from({length:200},(_,index)=>row(index)):Array.from({length:20},(_,index)=>row(200+index)));};
  const result=await fetchCftcContractHistory('tff','13874A',selected,52,{group:'dealer',fetchImpl,retries:0});
  assert.deepEqual(calls,[0,200]);assert.equal(result.pages,2);assert.equal(result.capReached,false);assert.equal(result.sourceExhausted,true);
});

test('cache status rejects future, wrong-family and expired snapshots without reaching CFTC',async()=>{
  let calls=0;
  const bad={savedAt:'2026-09-12T10:00:00Z',response:{schema_version:'edgar.cftc-positioning.v1',report_family:'disaggregated',report_date:'2026-09-15',retrieved_at:'2026-09-12T10:00:00Z',status:'ready',catalog:[{}]}};
  const result=await readCftcCacheStatus({now:new Date('2026-09-12T12:00:00Z'),enabled:()=>true,get:async()=>{calls++;return bad;}});
  assert.equal(result.status,'unavailable');assert.ok(result.families.every(item=>item.status==='invalid'));assert.equal(calls,4);
  const disabled=await readCftcCacheStatus({enabled:()=>false,get:async()=>{throw new Error('must not read');}});assert.equal(disabled.status,'disabled');
});
