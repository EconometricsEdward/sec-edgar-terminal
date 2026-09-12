import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as marketsGet, OPTIONS as marketsOptions } from '../src/app/api/v1/cftc/markets/route.js';
import { GET as historyGet, OPTIONS as historyOptions } from '../src/app/api/v1/cftc/history/route.js';
import { GET as statusGet } from '../src/app/api/v1/cftc/status/route.js';
import { GET as cronGet } from '../src/app/api/cron/cftc/route.js';
import { buildCftcHistoryResponse, buildCftcMarketsSnapshot } from '../src/utils/cftcServer.js';

const fixture=name=>JSON.parse(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8'));

test('CFTC routes reject unknown, duplicate, malformed, cross-family and future selections',async()=>{
  const cases=[
    [marketsGet,'https://example.test/api/v1/cftc/markets?url=https://evil.test','UNKNOWN_QUERY_PARAMETER'],
    [marketsGet,'https://example.test/api/api/v1/cftc/markets?family=tff&family=disaggregated','DUPLICATE_QUERY_PARAMETER'],
    [marketsGet,'https://example.test/api/v1/cftc/markets?family=legacy','INVALID_REPORT_FAMILY'],
    [marketsGet,'https://example.test/api/v1/cftc/markets?date=2999-01-01','INVALID_REPORT_DATE'],
    [historyGet,'https://example.test/api/v1/cftc/history?family=tff&contract=13874A&group=managed-money','INVALID_TRADER_GROUP'],
    [historyGet,'https://example.test/api/v1/cftc/history?family=tff&contract=%24where&group=leveraged-funds','INVALID_CONTRACT'],
    [historyGet,'https://example.test/api/v1/cftc/history?family=tff&contract=13874A&group=leveraged-funds&window=10y','INVALID_HISTORY_WINDOW'],
  ];
  for(const [handler,url,code] of cases){const response=await handler(new Request(url,{headers:{'x-forwarded-for':`192.0.2.${code.length}`}}));const body=await response.json();assert.equal(response.status,400,url);assert.equal(body.code,code);assert.equal(response.headers.get('cache-control'),'private, no-store');}
});

test('CFTC route preflights expose read-only CORS and schema discovery headers',async()=>{
  for(const response of [await marketsOptions(),await historyOptions()]){assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),'*');assert.equal(response.headers.get('access-control-allow-methods'),'GET, OPTIONS');}
  const invalid=await marketsGet(new Request('https://example.test/api/v1/c/cftc/markets?family=bad',{headers:{'x-forwarded-for':'192.0.2.90'}}));
  assert.match(invalid.headers.get('access-control-expose-headers'),/Link/);
});

test('market and history builders conform to their published versioned schemas',()=>{
  const marketsSchema=JSON.parse(readFileSync(new URL('../public/schemas/cftc-markets-v1.schema.json',import.meta.url),'utf8'));
  const historySchema=JSON.parse(readFileSync(new URL('../public/schemas/cftc-history-v1.schema.json',import.meta.url),'utf8'));
  const ajv=new Ajv({allErrors:true,unknownFormats:'ignore'});ajv.addSchema(marketsSchema);
  const validateMarkets=ajv.getSchema(marketsSchema.$id),validateHistory=ajv.compile(historySchema);
  const tff=fixture('cftc-tff-gpe5-46if-v1.json');
  const markets=buildCftcMarketsSnapshot({family:'tff',reportDate:'2026-09-08',latestRaw:tff,historyRaw:tff,retrievedAt:'2026-09-09T12:00:00Z'});
  const history=buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:tff,retrievedAt:'2026-09-09T12:00:00Z'});
  assert.equal(validateMarkets(markets),true,JSON.stringify(validateMarkets.errors));assert.equal(validateHistory(history),true,JSON.stringify(validateHistory.errors));
  const missingIdentity=structuredClone(markets);delete missingIdentity.latest[0].identity;assert.equal(validateMarkets(missingIdentity),false);
  const crossFamily=structuredClone(markets);crossFamily.source.dataset_id='72hh-3qpy';assert.equal(validateMarkets(crossFamily),false,'family-specific source');
  const arbitraryGroup=structuredClone(markets);arbitraryGroup.groups[0].id='invented-group';assert.equal(validateMarkets(arbitraryGroup),false,'published group ids');
  const impossibleRank=structuredClone(markets);impossibleRank.latest[0].groups['leveraged-funds'].percentile.value=150;assert.equal(validateMarkets(impossibleRank),false,'bounded percentile');
  const wrongHistoryFamily=structuredClone(history);wrongHistoryFamily.source.dataset_id='72hh-3qpy';assert.equal(validateHistory(wrongHistoryFamily),false,'history family-specific source');
  const wrongWindow=structuredClone(history);wrongWindow.selection.required_prior_reports=260;assert.equal(validateHistory(wrongWindow),false,'window lookback consistency');
  assert.equal(validateHistory({...history,price_source:'retired'}),false);
});

test('independent CFTC status fails closed when its cache is unavailable',async()=>{
  const response=await statusGet();const body=await response.json();
  assert.equal(response.status,503);assert.ok(['disabled','unavailable'].includes(body.status));assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.ok(Number.isFinite(Date.parse(body.checked_at)));assert.deepEqual(body.families,[]);assert.equal(response.headers.get('x-schema-version'),'edgar.cftc-positioning.v1');
});

test('the checkpointed CFTC refresh is independently scheduled and authenticated',async()=>{
  const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
  assert.ok(config.crons.some(item=>item.path==='/api/cron/cftc'&&item.schedule==='30 22 * * *'));
  const prior=process.env.CRON_SECRET;process.env.CRON_SECRET='cftc-test-secret';
  try{const response=await cronGet(new Request('https://example.test/api/cron/cftc'));assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'private, no-store');}
  finally{if(prior==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=prior;}
});
