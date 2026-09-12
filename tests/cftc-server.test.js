import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFTC_FRESH_MS, CFTC_PUBLIC_RESPONSE_MAX_BYTES, CFTC_RAW_HISTORY_SCHEMA_VERSION, CFTC_REFRESH_CHECKPOINT_VERSION, CFTC_REFRESH_RESUME_MS, assertCftcPublicResponseSize, buildCftcHistoryResponse, buildCftcMarketsSnapshot, cftcHistoryResponseCacheStatus, cftcPublicDateBounds, cftcPublicationStatus, cftcResourceUrl, fetchCftcContractHistory, fetchCftcLatestRows, fetchCftcResource, hasCftcPublicationFailure, isCftcPublicReportDate, isDurableCftcTwin, isPublishedCftcPrimary, loadCftcMarkets, parseCftcRetryAfter, presentCftcResponse, publishPreparedResponse, readCftcCacheStatus, validCftcRefreshCheckpoint, validHistoryResponse, validMarketsResponse, validateRawHistoryEnvelope } from '../src/utils/cftcServer.js';
import { CFTC_FAMILIES, CFTC_LAUNCH_CATALOG } from '../src/utils/cftc.js';
import { createCftcOutboundGate } from '../src/utils/cftcTransport.js';

const fixture=name=>JSON.parse(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8'))[0];
const priorDay=(date,days)=>{const value=new Date(`${date}T00:00:00.000Z`);value.setUTCDate(value.getUTCDate()-days);return value.toISOString().slice(0,10);};
const totalOrder=(family,leading)=>{const seen=new Set(leading.map(([field])=>field));return [...leading,...CFTC_FAMILIES[family].fields.filter(field=>!seen.has(field)).map(field=>[field,'ASC'])].map(([field,direction])=>`${field} ${direction}`).join(',');};
const latestSourceUrl=(family,date)=>cftcResourceUrl(family,{'$select':CFTC_FAMILIES[family].fields.join(','),'$where':`report_date_as_yyyy_mm_dd='${date}T00:00:00.000'`,'$order':totalOrder(family,[['cftc_contract_market_code','ASC'],['cftc_market_code','ASC'],['contract_units','ASC'],['id','ASC']]),'$limit':500,'$offset':0});
const launchSourceUrl=(family,date)=>{const codes=CFTC_LAUNCH_CATALOG.filter(item=>item.family===family).map(item=>`'${item.code}'`).join(',');return cftcResourceUrl(family,{'$select':CFTC_FAMILIES[family].fields.join(','),'$where':`cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd between '${priorDay(date,6*366)}T00:00:00.000' and '${date}T23:59:59.999'`,'$order':totalOrder(family,[['cftc_contract_market_code','ASC'],['report_date_as_yyyy_mm_dd','DESC'],['cftc_market_code','ASC'],['contract_units','ASC'],['id','ASC']]),'$limit':1000,'$offset':0});};
const contractSourceUrl=(family,code,date)=>cftcResourceUrl(family,{'$select':CFTC_FAMILIES[family].fields.join(','),'$where':`cftc_contract_market_code='${code}' AND report_date_as_yyyy_mm_dd<='${date}T23:59:59.999'`,'$order':totalOrder(family,[['report_date_as_yyyy_mm_dd','DESC'],['cftc_market_code','ASC'],['contract_units','ASC'],['id','ASC']]),'$limit':200,'$offset':0});

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
  const fetchImpl=async url=>{const parsed=new URL(url);calls.push(parsed);const offset=Number(parsed.searchParams.get('$offset'));return Response.json(offset===0?Array.from({length:500},(_,index)=>({id:String(index).padStart(4,'0')})):[]);};
  const result=await fetchCftcLatestRows('tff','2026-09-08',{fetchImpl,retries:0});
  assert.equal(result.rows.length,500);assert.equal(calls.length,2);assert.deepEqual(calls.map(url=>url.searchParams.get('$offset')),['0','500']);
  assert.equal(new URL(result.sourceUrl).searchParams.get('$offset'),'0');assert.equal(result.pages,2);
  assert.match(calls[0].searchParams.get('$order'),/cftc_contract_market_code ASC,cftc_market_code ASC,contract_units ASC,id ASC/);
});

test('pagination order remains total when source row IDs tie across a page boundary',async()=>{
  const base=fixture('cftc-tff-gpe5-46if-v1.json');
  const rows=Array.from({length:501},(_,index)=>({...base,id:'shared-id',dealer_positions_long_all:String(index)}));
  const calls=[];
  const result=await fetchCftcLatestRows('tff','2026-09-08',{retries:0,fetchImpl:async url=>{const parsed=new URL(url),offset=Number(parsed.searchParams.get('$offset'));calls.push(parsed);return Response.json(rows.slice(offset,offset+500));}});
  assert.equal(result.rows.length,501);assert.deepEqual(calls.map(url=>url.searchParams.get('$offset')),['0','500']);
  const orderedFields=calls[0].searchParams.get('$order').split(',').map(part=>part.trim().split(/\s+/)[0]);
  assert.equal(orderedFields.length,CFTC_FAMILIES.tff.fields.length);assert.equal(new Set(orderedFields).size,CFTC_FAMILIES.tff.fields.length);
  assert.ok(CFTC_FAMILIES.tff.fields.every(field=>orderedFields.includes(field)));
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
  const provisional=cftcPublicationStatus({status:'ready',report_date:'2026-09-08',retrieved_at:'2026-09-09T12:00:00Z'},{cacheRequired:true,primaryPersisted:true,lastGoodPersisted:null});
  assert.equal(provisional.cache_publication.durable,false);
  const reread=presentCftcResponse(provisional,{savedAt:'2026-09-09T12:00:00Z',now:new Date('2026-09-09T13:00:00Z'),cacheStatus:'prepared'});
  assert.equal(reread.status,'ready');assert.equal(reread.cache_publication.last_good_persisted,null);assert.equal(reread.cache_publication.durable,false);assert.equal(isPublishedCftcPrimary({savedAt:'2026-09-09T12:00:00Z',response:reread}),false);
});

for(const {family,fixtureName,code,group} of [
  {family:'tff',fixtureName:'cftc-tff-gpe5-46if-v1.json',code:'13874A',group:'leveraged-funds'},
  {family:'disaggregated',fixtureName:'cftc-disaggregated-72hh-3qpy-v1.json',code:'067651',group:'managed-money'},
])test(`fresh prepared ${family} raw history publishes a durable ready response`,async()=>{
  const reportDate='2026-09-08',retrievedAt='2026-09-09T12:00:00Z',savedAt='2026-09-09T12:00:01Z',now=new Date('2026-09-10T12:00:00Z');
  const raw=fixture(fixtureName),rawRows=Array.from({length:53},(_,index)=>({...raw,id:`${family}-${index}`,report_date_as_yyyy_mm_dd:`${priorDay(reportDate,index*7)}T00:00:00.000`}));
  const responseCacheStatus=cftcHistoryResponseCacheStatus('prepared');
  assert.equal(responseCacheStatus,'computed-from-prepared-raw');
  const built=buildCftcHistoryResponse({family,code,group,throughDate:reportDate,window:'1y',rawRows,retrievedAt,sourceUrl:launchSourceUrl(family,reportDate),cacheStatus:responseCacheStatus,retrieval:{origin_scope:'launch_selection',scope_rows:rawRows.length,source_rows:rawRows.length,source_pages:1,source_page_size:1000,cap_reached:false,bounded_scope_rows:600,bounded_source_rows:5000}});
  const candidate=presentCftcResponse(cftcPublicationStatus(built,{cacheRequired:true,rawHistoryExpected:1,rawHistoryPersisted:1}),{savedAt,now,cacheStatus:responseCacheStatus,requireCurrent:true});
  assert.equal(candidate.status,'ready');assert.equal(candidate.freshness.source_currency,'current');assert.equal(candidate.cache_publication.last_good_persisted,null);
  const cacheId=`history:${family}:${code}:${group}:${reportDate}:1y`,lastGoodId=`history-last-good:${family}:${code}:${group}:${reportDate}:1y`,writes=[];
  const published=await publishPreparedResponse({cacheId,lastGoodId,response:candidate,savedAt,allowLastGood:true,cacheRequired:true,cacheWrite:async(_namespace,id,value,ttl)=>{writes.push({id,value,ttl});return true;}});
  assert.equal(published.status,'ready');assert.equal(published.cache_publication.durable,true);assert.equal(published.cache_publication.last_good_persisted,true);
  assert.equal(writes.filter(write=>write.id===lastGoodId).length,1,'last-good receives only the complete candidate');
  assert.equal(published.status!=='ready'||published.freshness.source_currency==='aged'||published.freshness.cache_status.startsWith('stale'),false,'the route will emit X-Data-Stale: 0');
  assert.equal(validHistoryResponse(published,family,code,group,reportDate,'1y',now.getTime()),true);
  const oldLastGood={savedAt:'2026-09-01T12:00:00Z',response:{sentinel:'older complete snapshot'}},failedStore=new Map([[lastGoodId,oldLastGood]]);
  const failed=await publishPreparedResponse({cacheId,lastGoodId,response:candidate,savedAt,allowLastGood:true,cacheRequired:true,cacheWrite:async(_namespace,id,value)=>{if(id===lastGoodId)return false;failedStore.set(id,value);return true;}});
  assert.equal(failed.status,'partial');assert.equal(failed.cache_publication.durable,false);assert.equal(failed.cache_publication.last_good_persisted,false);assert.match(failed.refresh_warning,/last-good snapshot/);
  assert.deepEqual(failedStore.get(lastGoodId),oldLastGood,'a rejected last-good write cannot replace the prior fallback');
  assert.equal(failed.status!=='ready'||failed.freshness.source_currency==='aged'||failed.freshness.cache_status.startsWith('stale'),true,'genuine publication failure remains degraded');
});

test('publication ordering protects last-good and final-primary recovery',async()=>{
  const savedAt='2026-09-09T12:00:01Z',cacheId='history:tff:13874A:leveraged-funds:2026-09-08:1y',lastGoodId='history-last-good:tff:13874A:leveraged-funds:2026-09-08:1y';
  const response=cftcPublicationStatus({status:'ready',report_date:'2026-09-08',retrieved_at:'2026-09-09T12:00:00Z',freshness:{source_currency:'current',cache_status:'computed-from-prepared-raw'}},{cacheRequired:true,rawHistoryExpected:1,rawHistoryPersisted:1});
  const oldLastGood={savedAt:'2026-09-01T12:00:00Z',response:{sentinel:'older complete snapshot'}};
  const primaryFailureStore=new Map([[lastGoodId,oldLastGood]]),primaryFailureCalls=[];
  const primaryFailure=await publishPreparedResponse({cacheId,lastGoodId,response,savedAt,allowLastGood:true,cacheRequired:true,cacheWrite:async(_namespace,id,value)=>{primaryFailureCalls.push(id);if(id===cacheId)return false;primaryFailureStore.set(id,value);return true;}});
  assert.equal(primaryFailure.status,'partial');assert.equal(primaryFailure.cache_publication.primary_persisted,false);assert.deepEqual(primaryFailureCalls,[cacheId]);assert.deepEqual(primaryFailureStore.get(lastGoodId),oldLastGood);

  const finalFailureStore=new Map([[lastGoodId,oldLastGood]]),writeCounts=new Map();
  const finalPrimaryFailure=await publishPreparedResponse({cacheId,lastGoodId,response,savedAt,allowLastGood:true,cacheRequired:true,cacheWrite:async(_namespace,id,value)=>{const count=(writeCounts.get(id)||0)+1;writeCounts.set(id,count);if(id===cacheId&&count===2)return false;finalFailureStore.set(id,value);return true;}});
  const provisionalPrimary=finalFailureStore.get(cacheId),completeLastGood=finalFailureStore.get(lastGoodId);
  assert.equal(finalPrimaryFailure.status,'ready');assert.equal(finalPrimaryFailure.cache_publication.durable,true);
  assert.equal(isPublishedCftcPrimary(provisionalPrimary),false,'a provisional primary is never a fast-path hit');
  assert.equal(isDurableCftcTwin(provisionalPrimary,completeLastGood),true,'the complete same-snapshot last-good wins after final-primary failure');

  const intrinsic={savedAt,response:cftcPublicationStatus({status:'partial'},{cacheRequired:true,primaryPersisted:true,lastGoodPersisted:null,rawHistoryExpected:1,rawHistoryPersisted:1})};
  const attempted={savedAt,response:cftcPublicationStatus({status:'ready'},{cacheRequired:true,primaryPersisted:true,lastGoodPersisted:false,rawHistoryExpected:1,rawHistoryPersisted:1})};
  const shortfall={savedAt,response:cftcPublicationStatus({status:'partial'},{cacheRequired:true,primaryPersisted:true,lastGoodPersisted:null,rawHistoryExpected:2,rawHistoryPersisted:1})};
  assert.equal(hasCftcPublicationFailure(intrinsic),false);assert.equal(isPublishedCftcPrimary(intrinsic),true,'intrinsic partials remain cacheable');
  assert.equal(hasCftcPublicationFailure(attempted),true);assert.equal(isPublishedCftcPrimary(attempted),false,'attempted last-good failures are retried');
  assert.equal(hasCftcPublicationFailure(shortfall),true);assert.equal(isPublishedCftcPrimary(shortfall),false,'raw-history shortfalls are retried');

  const intrinsicStore=new Map([[lastGoodId,oldLastGood]]),intrinsicWrites=[];
  const intrinsicPublished=await publishPreparedResponse({cacheId,lastGoodId,response:intrinsic.response,savedAt,allowLastGood:false,cacheRequired:true,cacheWrite:async(_namespace,id,value)=>{intrinsicWrites.push(id);intrinsicStore.set(id,value);return true;}});
  assert.deepEqual(intrinsicWrites,[cacheId]);assert.equal(intrinsicPublished.status,'partial');assert.equal(intrinsicPublished.cache_publication.primary_persisted,true);assert.equal(intrinsicPublished.cache_publication.last_good_persisted,null);
  assert.equal(isPublishedCftcPrimary(intrinsicStore.get(cacheId)),true,'an intrinsic partial is finalized as a cacheable primary');assert.deepEqual(intrinsicStore.get(lastGoodId),oldLastGood);

  const throwingStore=new Map([[lastGoodId,oldLastGood]]);
  const throwingLastGood=await publishPreparedResponse({cacheId,lastGoodId,response,savedAt,allowLastGood:true,cacheRequired:true,cacheWrite:async(_namespace,id,value)=>{if(id===lastGoodId)throw new Error('last-good unavailable');throwingStore.set(id,value);return true;}});
  assert.equal(throwingLastGood.status,'partial');assert.equal(throwingLastGood.cache_publication.last_good_persisted,false);assert.deepEqual(throwingStore.get(lastGoodId),oldLastGood,'a thrown last-good write also preserves the fallback');

  let disabledWrites=0;
  const cacheDisabled=await publishPreparedResponse({cacheId,lastGoodId,response,savedAt,allowLastGood:true,cacheRequired:false,cacheWrite:async()=>{disabledWrites++;throw new Error('must not write');}});
  assert.equal(disabledWrites,0);assert.equal(cacheDisabled.status,'ready');assert.equal(cacheDisabled.cache_publication.cache_required,false);assert.equal(cacheDisabled.cache_publication.durable,false);
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

test('public CFTC dates use a timezone-safe six-calendar-year retention boundary',async()=>{
  const leapDay=new Date('2028-02-29T23:59:59.000Z');
  assert.deepEqual(cftcPublicDateBounds(leapDay),{earliest:'2022-02-28',latest:'2028-02-29'});
  assert.equal(isCftcPublicReportDate('2022-02-28',leapDay),true);
  assert.equal(isCftcPublicReportDate('2022-02-27',leapDay),false);
  assert.equal(isCftcPublicReportDate('2028-03-01',leapDay),false);
  assert.equal(isCftcPublicReportDate('2028-02-29junk',leapDay),false);
  assert.equal(isCftcPublicReportDate("2028-02-29' OR 1=1",leapDay),false);
  await assert.rejects(fetchCftcLatestRows('tff','2026-09-08junk',{fetchImpl:async()=>{throw new Error('must not fetch');}}),error=>error.code==='INVALID_CFTC_REQUEST');
  await assert.rejects(fetchCftcContractHistory('tff','13874A',"2026-09-08' OR 1=1",52,{fetchImpl:async()=>{throw new Error('must not fetch');}}),error=>error.code==='INVALID_CFTC_REQUEST');
  assert.ok(CFTC_FRESH_MS>=26*3600_000);
  assert.equal(CFTC_REFRESH_RESUME_MS,48*3600_000);
});

test('cancellation during retry backoff is normalized to the public 499 contract',async()=>{
  const controller=new AbortController();
  const fetchImpl=async()=>new Response('retry',{status:503,headers:{'retry-after':'1'}});
  const outboundGate=createCftcOutboundGate({sharedEnabled:()=>false,state:{active:false,cooldownUntil:0}});
  setTimeout(()=>controller.abort(new DOMException('cancelled','AbortError')),10);
  await assert.rejects(fetchCftcResource('tff',{'$limit':1},{fetchImpl,retries:1,signal:controller.signal,outboundGate}),error=>error.code==='CFTC_REQUEST_CANCELLED'&&error.status===499);
});

test('pagination rejects oversized, unordered and repeated pages',async()=>{
  const base=fixture('cftc-tff-gpe5-46if-v1.json');
  const row=index=>({...base,id:String(index).padStart(4,'0'),cftc_contract_market_code:String(index).padStart(6,'0')});
  await assert.rejects(fetchCftcLatestRows('tff','2026-09-08',{fetchImpl:async()=>Response.json(Array.from({length:501},(_,index)=>row(index))),retries:0}),error=>error.code==='CFTC_PAGINATION_INVALID');
  await assert.rejects(fetchCftcLatestRows('tff','2026-09-08',{fetchImpl:async()=>Response.json([row(2),row(1)]),retries:0}),error=>error.code==='CFTC_PAGINATION_INVALID');
  const page=Array.from({length:500},()=>row(0));
  await assert.rejects(fetchCftcLatestRows('tff','2026-09-08',{fetchImpl:async()=>Response.json(page),retries:0}),error=>error.code==='CFTC_PAGINATION_DUPLICATE');
});

test('cache-only CFTC status validates each family independently and recomputes report age',async()=>{
  const now=new Date('2026-09-12T12:00:00Z'), savedAt='2026-09-12T10:00:00Z';
  const response=family=>buildCftcMarketsSnapshot({family,reportDate:'2026-09-08',latestRaw:[fixture(family==='tff'?'cftc-tff-gpe5-46if-v1.json':'cftc-disaggregated-72hh-3qpy-v1.json')],historyRaw:[],retrievedAt:savedAt,sourceUrl:latestSourceUrl(family,'2026-09-08'),cacheStatus:'prepared'});
  const values=new Map([
    ['markets:tff:latest',{savedAt,response:response('tff')}],
    ['markets:disaggregated:latest',{savedAt,response:response('disaggregated')}],
  ]);
  const result=await readCftcCacheStatus({now,enabled:()=>true,get:async(_type,id)=>values.get(id)||null});
  assert.equal(result.status,'degraded');assert.deepEqual(result.families.map(item=>item.status),['partial','partial']);assert.ok(result.families.every(item=>item.source_report_age_days===4));
  assert.equal(result.families[0].cache_age_seconds,7200);
});

test('cache-only CFTC status prefers a complete last-good twin over provisional primary metadata',async()=>{
  const family='tff',reportDate='2026-09-08',retrievedAt='2026-09-09T12:00:00Z',savedAt='2026-09-09T12:00:01Z',now=new Date('2026-09-10T12:00:00Z');
  const raw=fixture('cftc-tff-gpe5-46if-v1.json'),codes=CFTC_LAUNCH_CATALOG.filter(item=>item.family===family).map(item=>item.code);
  const latestRaw=codes.map((code,index)=>({...raw,id:`latest-${index}`,cftc_contract_market_code:code}));
  const historyRaw=codes.flatMap((code,codeIndex)=>Array.from({length:261},(_,index)=>({...raw,id:`history-${codeIndex}-${index}`,cftc_contract_market_code:code,report_date_as_yyyy_mm_dd:`${priorDay(reportDate,index*7)}T00:00:00.000`})));
  const response=buildCftcMarketsSnapshot({family,reportDate,latestRaw,historyRaw,retrievedAt,sourceUrl:latestSourceUrl(family,reportDate),historySourceUrl:launchSourceUrl(family,reportDate)});
  const publication={cacheRequired:true,rawHistoryExpected:codes.length,rawHistoryPersisted:codes.length};
  const complete=cftcPublicationStatus(response,{...publication,primaryPersisted:true,lastGoodPersisted:true});
  const provisional=cftcPublicationStatus(response,{...publication,primaryPersisted:false,lastGoodPersisted:null});
  assert.equal(validMarketsResponse(complete,family,now.getTime(),'latest'),true);assert.equal(validMarketsResponse(provisional,family,now.getTime(),'latest'),true);
  const values=new Map([['markets:tff:latest',{savedAt,response:provisional}],['markets-last-good:tff:latest',{savedAt,response:complete}]]);
  const result=await readCftcCacheStatus({now,enabled:()=>true,get:async(_type,id)=>values.get(id)||null});
  assert.deepEqual(result.families[0],{family:'tff',status:'ready',report_date:reportDate,retrieved_at:retrievedAt,cache_age_seconds:86399,source_report_age_days:2,source_currency:'current',cache_source:'last-good'});
});

test('empty or truncated launch history cannot publish a ready market snapshot',()=>{
  const raw=fixture('cftc-tff-gpe5-46if-v1.json'),common={family:'tff',reportDate:'2026-09-08',latestRaw:[raw],retrievedAt:'2026-09-09T12:00:00Z'};
  const empty=buildCftcMarketsSnapshot({...common,historyRaw:[]});
  assert.equal(empty.status,'partial');assert.ok(empty.coverage.missing_launch_history_codes.includes('13874A'));assert.match(empty.refresh_warning,/incomplete/i);
  const truncated=buildCftcMarketsSnapshot({...common,historyRaw:[raw]});
  assert.equal(truncated.status,'partial');assert.ok(truncated.coverage.insufficient_launch_history_codes.includes('13874A'));
  assert.equal(truncated.latest[0].groups['leveraged-funds'].percentile.reason,'insufficient_history');
});

test('latest/history overlap conflicts are quarantined and cannot leak through the history endpoint',async()=>{
  const latest=fixture('cftc-tff-gpe5-46if-v1.json');
  const prior={...latest,id:'prior-row',report_date_as_yyyy_mm_dd:'2026-09-01T00:00:00.000',lev_money_positions_long:'100'};
  const conflicting={...latest,id:'conflicting-history-row',lev_money_positions_long:'180'};
  const snapshot=buildCftcMarketsSnapshot({family:'tff',reportDate:'2026-09-08',latestRaw:[latest],historyRaw:[conflicting,prior],retrievedAt:'2026-09-09T12:00:00Z'});
  const leveraged=snapshot.latest[0].groups['leveraged-funds'];
  assert.equal(leveraged.net,-30,'displayed latest remains authoritative');
  assert.equal(leveraged.oneWeekChange,-20,'change uses displayed latest net (-30), not conflicting history net (+70)');
  assert.equal(snapshot.status,'partial');
  assert.deepEqual(snapshot.quarantine.find(item=>item.reason==='conflicting_latest_history_identity'),{
    reason:'conflicting_latest_history_identity',identity:'tff|futures_only|13874A|2026-09-08',sourceRowIds:[latest.id,conflicting.id],
  });
  await assert.rejects(fetchCftcContractHistory('tff','13874A','2026-09-08',52,{group:'leveraged-funds',expectedSelectedRaw:latest,retries:0,fetchImpl:async()=>Response.json([conflicting,prior])}),error=>error.code==='CFTC_SOURCE_CONFLICT');
});

test('cache validators reject skeletal, cross-key, retired-field and unofficial-source payloads',async()=>{
  const now=Date.parse('2026-09-12T12:00:00Z'),retrievedAt='2026-09-09T12:00:00Z';
  const tffRaw=[fixture('cftc-tff-gpe5-46if-v1.json')];
  const markets=buildCftcMarketsSnapshot({family:'tff',reportDate:'2026-09-08',latestRaw:tffRaw,historyRaw:tffRaw,retrievedAt,sourceUrl:latestSourceUrl('tff','2026-09-08'),historySourceUrl:launchSourceUrl('tff','2026-09-08'),cacheStatus:'prepared'});
  assert.equal(validMarketsResponse(markets,'tff',now,'2026-09-08'),true);
  assert.equal(validMarketsResponse({schema_version:markets.schema_version},'tff',now),false,'skeletal');
  assert.equal(validMarketsResponse({...markets,report_date:'2026-09-01'},'tff',now,'2026-09-08'),false,'cache-key date');
  assert.equal(validMarketsResponse({...markets,price_source:'retired'},'tff',now),false,'retired field');
  assert.equal(validMarketsResponse({...markets,source:{...markets.source,url:'https://example.test/resource/gpe5-46if.json'}},'tff',now),false,'source host');
  assert.equal(validMarketsResponse({...markets,source:{...markets.source,url:`${markets.source.url}&extra=1`}},'tff',now),false,'source query shape');
  const brokenCatalog=structuredClone(markets);delete brokenCatalog.catalog[0].exchange;assert.equal(validMarketsResponse(brokenCatalog,'tff',now),false,'catalog shape');
  const forgedMetadata=structuredClone(markets);forgedMetadata.latest[0].marketName='FORGED MARKET';assert.equal(validMarketsResponse(forgedMetadata,'tff',now),false,'raw normalization metadata binding');
  const forgedGroup=structuredClone(markets);forgedGroup.latest[0].groups['leveraged-funds'].long+=1;forgedGroup.latest[0].groups['leveraged-funds'].net+=1;forgedGroup.latest[0].groups['leveraged-funds'].netPctOi=100*forgedGroup.latest[0].groups['leveraged-funds'].net/forgedGroup.latest[0].openInterest;assert.equal(validMarketsResponse(forgedGroup,'tff',now),false,'raw normalization group binding');
  const missingAnalytics=structuredClone(markets);delete missingAnalytics.latest[0].groups['leveraged-funds'].fourWeekNetPctChange;assert.equal(validMarketsResponse(missingAnalytics,'tff',now),false,'latest analytics required');
  const history=buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:tffRaw,retrievedAt,sourceUrl:contractSourceUrl('tff','13874A','2026-09-08')});
  assert.equal(validHistoryResponse(history,'tff','13874A','leveraged-funds','2026-09-08','1y',now),true);
  const brokenHistory=structuredClone(history);delete brokenHistory.history[0].spreadingStatus;assert.equal(validHistoryResponse(brokenHistory,'tff','13874A','leveraged-funds','2026-09-08','1y',now),false,'history point shape');
  const forgedHistoryRaw=structuredClone(history);forgedHistoryRaw.history[0].raw.lev_money_positions_long='999999';assert.equal(validHistoryResponse(forgedHistoryRaw,'tff','13874A','leveraged-funds','2026-09-08','1y',now),false,'history raw binding');
  const forgedHistoryName=structuredClone(history);forgedHistoryName.history[0].marketName='FORGED HISTORICAL NAME';assert.equal(validHistoryResponse(forgedHistoryName,'tff','13874A','leveraged-funds','2026-09-08','1y',now),false,'history name binding');
  const forgedHistoryId=structuredClone(history);forgedHistoryId.history[0].sourceRowId='forged-row';assert.equal(validHistoryResponse(forgedHistoryId,'tff','13874A','leveraged-funds','2026-09-08','1y',now),false,'history row provenance');
  const missingRaw=structuredClone(history);delete missingRaw.history[0].raw;assert.equal(validHistoryResponse(missingRaw,'tff','13874A','leveraged-funds','2026-09-08','1y',now),false,'history raw required');
  const forgedReason=structuredClone(history);forgedReason.history[0].derivedUnavailable={netPctOi:'open_interest_not_positive'};assert.equal(validHistoryResponse(forgedReason,'tff','13874A','leveraged-funds','2026-09-08','1y',now),false,'derived reason binding');
  const corruptLastGood={savedAt:retrievedAt,response:{...markets,source:{...markets.source,dataset_id:'72hh-3qpy'}}};
  const status=await readCftcCacheStatus({now:new Date(now),enabled:()=>true,get:async(_type,id)=>id==='markets-last-good:tff:latest'?corruptLastGood:null});
  assert.equal(status.status,'unavailable');assert.equal(status.families[0].status,'invalid');
});

test('history cache validation replays changes, ranks and comparison ranges',()=>{
  const selected='2026-09-08',base=fixture('cftc-tff-gpe5-46if-v1.json'),rawRows=[];
  for(let index=0;index<=52;index++)rawRows.push({...base,id:`history-${index}`,report_date_as_yyyy_mm_dd:`${priorDay(selected,index*7)}T00:00:00.000`,lev_money_positions_long:String(80-index)});
  const response=buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:selected,window:'1y',rawRows,retrievedAt:'2026-09-09T12:00:00Z',sourceUrl:contractSourceUrl('tff','13874A',selected)});
  const now=Date.parse('2026-09-12T12:00:00Z');
  assert.equal(validHistoryResponse(response,'tff','13874A','leveraged-funds',selected,'1y',now),true);
  const change=structuredClone(response);change.selected.oneWeekChange+=1;assert.equal(validHistoryResponse(change,'tff','13874A','leveraged-funds',selected,'1y',now),false,'weekly replay');
  const prior=structuredClone(response);prior.selected.previousAvailableDate=priorDay(selected,14);assert.equal(validHistoryResponse(prior,'tff','13874A','leveraged-funds',selected,'1y',now),false,'previous available replay');
  const rank=structuredClone(response);rank.percentile.value=rank.percentile.value===100?99:rank.percentile.value+1;assert.equal(validHistoryResponse(rank,'tff','13874A','leveraged-funds',selected,'1y',now),false,'percentile replay');
  const range=structuredClone(response);range.coverage.earliest=priorDay(selected,51*7);assert.equal(validHistoryResponse(range,'tff','13874A','leveraged-funds',selected,'1y',now),false,'history range replay');
  const query=structuredClone(response);query.source.url=`${query.source.url}&$offset=200`;assert.equal(validHistoryResponse(query,'tff','13874A','leveraged-funds',selected,'1y',now),false,'history source query');
  const retrievalBase={origin_scope:'contract_history',scope_rows:response.history.length,source_rows:response.history.length,source_pages:1,source_page_size:200,cap_reached:false,bounded_scope_rows:600,bounded_source_rows:600};
  for(const retrieval of [{...retrievalBase,scope_rows:601,source_rows:601},{...retrievalBase,source_pages:4},{...retrievalBase,scope_rows:599,source_rows:599,cap_reached:true},{...retrievalBase,origin_scope:'launch_selection',source_page_size:200,bounded_source_rows:5000}])assert.equal(validHistoryResponse({...response,retrieval},'tff','13874A','leveraged-funds',selected,'1y',now),false,'bounded retrieval provenance');
});

test('fresh CFTC responses enforce UTF-8 and per-source-field publication bounds',()=>{
  const raw=fixture('cftc-tff-gpe5-46if-v1.json');
  assert.throws(()=>buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:[{...raw,market_and_exchange_names:'💥'.repeat(1100)}],retrievedAt:'2026-09-09T12:00:00Z'}),error=>error.code==='CFTC_RESPONSE_TOO_LARGE');
  assert.throws(()=>assertCftcPublicResponseSize({payload:'💥'.repeat(Math.ceil(CFTC_PUBLIC_RESPONSE_MAX_BYTES/4))}),error=>error.code==='CFTC_RESPONSE_TOO_LARGE');
});

test('prepared-only historical market reads cannot amplify into source history crawls',async()=>{
  let upstreamCalls=0;
  await assert.rejects(loadCftcMarkets({family:'tff',reportDate:'2026-09-08',preparedOnly:true,fetchImpl:async()=>{upstreamCalls++;return Response.json([]);}}),error=>error.code==='CFTC_REPORT_NOT_PREPARED'&&error.status===404);
  assert.equal(upstreamCalls,0);
});

test('prepared-only explicit-date reads reject a provisional latest primary and use its durable twin',async()=>{
  const family='tff',nowMs=Date.now(),reportDate=new Date(nowMs-86400_000).toISOString().slice(0,10);
  const retrievedAt=new Date(nowMs-2000).toISOString(),savedAt=new Date(nowMs-1000).toISOString();
  const raw=fixture('cftc-tff-gpe5-46if-v1.json'),codes=CFTC_LAUNCH_CATALOG.filter(item=>item.family===family).map(item=>item.code);
  const latestRaw=codes.map((code,index)=>({...raw,id:`latest-${index}`,cftc_contract_market_code:code,report_date_as_yyyy_mm_dd:`${reportDate}T00:00:00.000`}));
  const historyRaw=codes.flatMap((code,codeIndex)=>Array.from({length:261},(_,index)=>({...raw,id:`history-${codeIndex}-${index}`,cftc_contract_market_code:code,report_date_as_yyyy_mm_dd:`${priorDay(reportDate,index*7)}T00:00:00.000`})));
  const response=buildCftcMarketsSnapshot({family,reportDate,latestRaw,historyRaw,retrievedAt,sourceUrl:latestSourceUrl(family,reportDate),historySourceUrl:launchSourceUrl(family,reportDate)});
  const publication={cacheRequired:true,rawHistoryExpected:codes.length,rawHistoryPersisted:codes.length};
  const provisional={savedAt,response:cftcPublicationStatus(response,{...publication,primaryPersisted:false,lastGoodPersisted:null})};
  const complete={savedAt,response:cftcPublicationStatus(response,{...publication,primaryPersisted:true,lastGoodPersisted:true})};
  assert.equal(validMarketsResponse(provisional.response,family,nowMs,reportDate),true);
  assert.equal(validMarketsResponse(complete.response,family,nowMs,reportDate),true);
  const values=new Map([[`markets:${family}:latest`,provisional],[`markets-last-good:${family}:latest`,complete]]),reads=[];
  let upstreamCalls=0;
  const result=await loadCftcMarkets({family,reportDate,preparedOnly:true,cacheGet:async(_namespace,id)=>{reads.push(id);return values.get(id)||null;},fetchImpl:async()=>{upstreamCalls++;return Response.json([]);}});
  assert.equal(result.status,'ready');assert.equal(result.cache_publication.durable,true);assert.equal(result.cache_publication.last_good_persisted,true);
  assert.ok(reads.includes(`markets:${family}:latest`));assert.ok(reads.includes(`markets-last-good:${family}:latest`));assert.equal(upstreamCalls,0);
});

test('source currency is independent of retrieval age and old latest reports cannot appear ready',async()=>{
  const now=new Date('2026-09-12T12:00:00Z'),savedAt='2026-09-12T11:00:00Z',config=CFTC_FAMILIES.tff;
  const response={schema_version:'edgar.cftc-positioning.v1',calculation_version:'cftc-positioning-1.0.0',report_family:'tff',report_basis:'futures_only',report_date:'2026-08-01',retrieved_at:savedAt,status:'ready',cache_publication:{cache_required:true,primary_persisted:true,last_good_persisted:true,raw_history_expected:0,raw_history_persisted:0,durable:true},source:{agency:'U.S. Commodity Futures Trading Commission',dataset_id:config.datasetId,report_family:config.label,report_basis:'futures_only',url:config.sourceUrl,history_url:null,documentation:config.documentationUrl},groups:config.groups.map(({id,label})=>({id,label})),catalog:[{family:'tff',code:'X',reportDate:'2026-08-01'}],latest:[],coverage:{catalog_rows:1}};
  const presented=presentCftcResponse(response,{savedAt,now,cacheStatus:'prepared',requireCurrent:true});
  assert.equal(presented.status,'stale');assert.equal(presented.freshness.source_currency,'aged');assert.equal(presented.freshness.source_currency_max_days,14);assert.match(presented.refresh_warning,/42 days old/);
  const partial=presentCftcResponse({...response,status:'partial'},{savedAt,now,cacheStatus:'prepared',requireCurrent:true});assert.equal(partial.status,'partial');assert.match(partial.refresh_warning,/42 days old/);
});

test('raw history envelopes bind family, contract, date, official query, age and compatible history',()=>{
  const selected='2026-09-08',base=fixture('cftc-tff-gpe5-46if-v1.json'),rows=[];
  for(let index=0;index<=52;index++){const date=new Date(`${selected}T00:00:00Z`);date.setUTCDate(date.getUTCDate()-index*7);rows.push({...base,id:`row-${index}`,report_date_as_yyyy_mm_dd:`${date.toISOString().slice(0,10)}T00:00:00.000`});}
  const envelope={schema_version:CFTC_RAW_HISTORY_SCHEMA_VERSION,family:'tff',report_basis:'futures_only',code:'13874A',through_date:selected,savedAt:'2026-09-09T12:00:00Z',retrievedAt:'2026-09-09T12:00:00Z',sourceUrl:contractSourceUrl('tff','13874A',selected),pages:1,capReached:false,sourceExhausted:true,originScope:'contract_history',sourceRows:rows.length,sourcePageSize:200,sourceRowLimit:600,rows};
  assert.equal(validateRawHistoryEnvelope(envelope,{family:'tff',code:'13874A',throughDate:selected,count:52,now:new Date('2026-09-10T00:00:00Z')}),true);
  assert.equal(validateRawHistoryEnvelope({...envelope,family:'disaggregated'},{family:'tff',code:'13874A',throughDate:selected,count:52,now:new Date('2026-09-10T00:00:00Z')}),false);
  assert.equal(validateRawHistoryEnvelope({...envelope,sourceUrl:'https://example.com/resource/gpe5-46if.json'},{family:'tff',code:'13874A',throughDate:selected,count:52,now:new Date('2026-09-10T00:00:00Z')}),false);
  assert.equal(validateRawHistoryEnvelope({...envelope,sourceUrl:`${envelope.sourceUrl}&extra=1`},{family:'tff',code:'13874A',throughDate:selected,count:52,now:new Date('2026-09-10T00:00:00Z')}),false);
  const suppressed=rows.map((row,index)=>index>35?{...row,dealer_positions_long_all:''}:row);
  assert.equal(validateRawHistoryEnvelope({...envelope,sourceExhausted:false,rows:suppressed},{family:'tff',code:'13874A',throughDate:selected,count:52,group:'dealer',now:new Date('2026-09-10T00:00:00Z')}),false);
});

test('prepared launch history retains actual global source pagination provenance',async()=>{
  const row=fixture('cftc-tff-gpe5-46if-v1.json'),selected='2026-09-08';
  const envelope={schema_version:CFTC_RAW_HISTORY_SCHEMA_VERSION,family:'tff',report_basis:'futures_only',code:'13874A',through_date:selected,savedAt:new Date().toISOString(),retrievedAt:new Date().toISOString(),sourceUrl:launchSourceUrl('tff',selected),pages:5,capReached:false,sourceExhausted:true,originScope:'launch_selection',sourceRows:4052,sourcePageSize:1000,sourceRowLimit:5000,rows:[row]};
  let upstreamCalls=0;
  const result=await fetchCftcContractHistory('tff','13874A',selected,52,{expectedSelectedRaw:row,cacheGet:async()=>envelope,fetchImpl:async()=>{upstreamCalls++;return Response.json([]);}});
  assert.equal(upstreamCalls,0);assert.deepEqual({originScope:result.originScope,pages:result.pages,sourceRows:result.sourceRows,sourcePageSize:result.sourcePageSize,sourceRowLimit:result.sourceRowLimit,scopeRows:result.rows.length},{originScope:'launch_selection',pages:5,sourceRows:4052,sourcePageSize:1000,sourceRowLimit:5000,scopeRows:1});
  const response=buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:selected,window:'1y',rawRows:result.rows,retrievedAt:'2026-09-09T12:00:00Z',sourceUrl:result.sourceUrl,retrieval:{origin_scope:result.originScope,scope_rows:result.rows.length,source_rows:result.sourceRows,source_pages:result.pages,source_page_size:result.sourcePageSize,cap_reached:false,bounded_scope_rows:600,bounded_source_rows:result.sourceRowLimit}});
  assert.equal(validHistoryResponse(response,'tff','13874A','leveraged-funds',selected,'1y',Date.parse('2026-09-12T12:00:00Z')),true);
});

test('a conflicting prepared history is bypassed and force refresh never reads it',async()=>{
  const expected=fixture('cftc-tff-gpe5-46if-v1.json'),selected='2026-09-08';
  const conflicting={...expected,id:'cached-conflict',lev_money_positions_long:'180'};
  const envelope={schema_version:CFTC_RAW_HISTORY_SCHEMA_VERSION,family:'tff',report_basis:'futures_only',code:'13874A',through_date:selected,savedAt:new Date().toISOString(),retrievedAt:new Date().toISOString(),sourceUrl:launchSourceUrl('tff',selected),pages:1,capReached:false,sourceExhausted:true,originScope:'launch_selection',sourceRows:1,sourcePageSize:1000,sourceRowLimit:5000,rows:[conflicting]};
  let upstreamCalls=0;
  const refreshed=await fetchCftcContractHistory('tff','13874A',selected,52,{expectedSelectedRaw:expected,cacheGet:async()=>envelope,retries:0,fetchImpl:async()=>{upstreamCalls++;return Response.json([expected]);}});
  assert.equal(upstreamCalls,1);assert.equal(refreshed.cacheStatus,'computed');assert.equal(refreshed.rows[0].lev_money_positions_long,'80');
  let cacheReads=0;
  await fetchCftcContractHistory('tff','13874A',selected,52,{bypassPrepared:true,expectedSelectedRaw:expected,cacheGet:async()=>{cacheReads++;throw new Error('cache must be bypassed');},retries:0,fetchImpl:async()=>Response.json([expected])});
  assert.equal(cacheReads,0);
});

test('an expected latest observation cannot be omitted from prepared or newly cached history',async()=>{
  const expected=fixture('cftc-tff-gpe5-46if-v1.json'),selected='2026-09-08';
  const prior={...expected,id:'prior-only',report_date_as_yyyy_mm_dd:'2026-09-01T00:00:00.000'};
  const envelope={schema_version:CFTC_RAW_HISTORY_SCHEMA_VERSION,family:'tff',report_basis:'futures_only',code:'13874A',through_date:selected,savedAt:new Date().toISOString(),retrievedAt:new Date().toISOString(),sourceUrl:launchSourceUrl('tff',selected),pages:1,capReached:false,sourceExhausted:true,originScope:'launch_selection',sourceRows:1,sourcePageSize:1000,sourceRowLimit:5000,rows:[prior]};
  let upstreamCalls=0,cacheWrites=0;
  await assert.rejects(fetchCftcContractHistory('tff','13874A',selected,52,{expectedSelectedRaw:expected,cacheGet:async()=>envelope,cacheEnabled:()=>true,cacheSet:async()=>{cacheWrites++;return true;},retries:0,fetchImpl:async()=>{upstreamCalls++;return Response.json([prior]);}}),error=>error.code==='CFTC_SOURCE_INCOMPLETE'&&error.status===502);
  assert.equal(upstreamCalls,1,'missing prepared selection becomes a bounded source refresh');assert.equal(cacheWrites,0,'incomplete fresh history is rejected before publication');
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
