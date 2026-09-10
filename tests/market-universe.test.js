import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUniverseSnapshot, computeCoMovement, distribution, spearman, summarizeScope, UNIVERSE_METRICS } from '../src/utils/marketUniverse.js';
import { chooseUniversePublication } from '../src/utils/marketUniverseServer.js';
import { GET } from '../src/app/api/v1/factor-universe/route.js';
import { GET as cron } from '../src/app/api/cron/factor-universe/route.js';

const now=new Date('2026-09-10T08:00:00Z');
function company(i=0,change=i-5){
  const prior=Object.fromEntries(UNIVERSE_METRICS.map((m,index)=>[m.key,10+index]));
  const current=Object.fromEntries(UNIVERSE_METRICS.map((m,index)=>[m.key,prior[m.key]+change*(1+index*.1)]));
  const comparison={pointInTime:true,gapDays:365,cutoff:{filed:'2026-07-30',acceptedAt:'2026-07-30T21:30:00Z'},current:{metrics:current,filed:'2026-07-30',end:'2026-06-30',accession:`0000000100-26-${String(i).padStart(6,'0')}`},prior:{metrics:prior,filed:'2025-07-30',end:'2025-06-30'}};
  return {ticker:`T${String(i).padStart(2,'0')}`,name:`Issuer ${i}`,cik:String(100+i),sic:'3674',cohorts:['ai-infrastructure','software-security'],filingComparisons:{ttm:comparison,annual:comparison}};
}
function atlas(companies=Array.from({length:12},(_,i)=>company(i))){return {generatedAt:'2026-09-10T04:20:00Z',requested:companies.length,companies};}
function prices(){
  const dates=[];for(let n=Date.parse('2025-01-02');n<Date.parse('2026-09-10');n+=86400000){const date=new Date(n);if(![0,6].includes(date.getUTCDay()))dates.push(date.toISOString().slice(0,10));}
  const result={};
  for(const ticker of ['SPY','XLK',...Array.from({length:12},(_,i)=>company(i).ticker)]){
    let price=100;const index=Number(ticker.slice(1))||0;
    result[ticker]={provider:'yahoo_finance',priceBasis:'adjusted_close',retrievedAt:'2026-09-10T05:00:00Z',prices:dates.map((date,i)=>{const m=.001+.008*Math.sin(i*.37),sector=.003*Math.cos(i*.29);price*=Math.exp(ticker==='SPY'?m:ticker==='XLK'?1.1*m+sector:(.5+index*.1)*m+.5*sector+.002*Math.sin(i*(.17+index*.01)));return {date,adjustedClose:price};})};
  }return result;
}
test('absolute breadth deduplicates issuers, counts zero as unchanged, and never imputes missing',()=>{
  const companies=[company(0,-2),company(1,0),company(2,2),company(3,4)];companies[3].filingComparisons.ttm.current.metrics.revenueGrowth=null;
  companies.push({...companies[2],ticker:'ZZZ'});
  const result=buildUniverseSnapshot(atlas(companies),{}, {now});const growth=result.scopes.all.breadth[0];
  assert.equal(result.rows.length,4);assert.equal(result.universe.share_classes_excluded,1);
  assert.deepEqual([growth.higher,growth.lower,growth.unchanged,growth.missing],[1,1,1,1]);assert.equal(growth.higher_pct,100/3);assert.equal(growth.change.median,0);
  assert.equal(Object.values(result.scopes).filter(s=>s.id!=='all').reduce((n,s)=>n+s.companies,0),4);
});
test('magnitude is median paired changes and dispersion uses the same issuers',()=>{
  const result=buildUniverseSnapshot(atlas([company(0),company(1),company(2)]),{}, {now});
  const rows=result.rows;[0,100,101].forEach((x,i)=>rows[i].metrics.revenueGrowth={prior:x,current:[99,100,0][i],change:[99,0,-101][i]});
  const growth=summarizeScope(rows).breadth[0];assert.equal(growth.change.median,0);assert.equal(growth.current.median-growth.prior.median,-1);
  assert.equal(growth.paired_iqr_change,growth.current.iqr-growth.prior.iqr);
});
test('financial exclusions and simultaneous declines have explicit complete-case denominators',()=>{
  const companies=[company(0,-2),company(1,-2),company(2,-2),company(3,1)];companies[1].sic='6021';companies[2].filingComparisons.ttm.prior.metrics.freeCashFlowMargin=null;
  const snapshot=buildUniverseSnapshot(atlas(companies),{}, {now}),s=snapshot.scopes.all;
  assert.equal(snapshot.rows[1].metrics.freeCashFlowMargin.change,null);assert.equal(snapshot.rows[1].metrics.freeCashFlowMargin.unavailable_reason,'ISSUER_TYPE_EXCLUDED');
  assert.equal(s.breadth[1].population_count,3);assert.equal(s.breadth[2].eligible,2);
  assert.equal(s.simultaneous_weakening.eligible,2);assert.equal(s.simultaneous_weakening.count,1);assert.equal(s.simultaneous_weakening.missing,1);
});
test('missing comparable prior period does not enter breadth',()=>{
  const c=company();c.filingComparisons.ttm.gapDays=180;
  const s=buildUniverseSnapshot(atlas([c]),{}, {now});assert.equal(s.scopes.all.breadth[0].eligible,0);assert.equal(s.rows[0].metrics.revenueGrowth.current,null);
});
test('price models share their final session, preserve exact intervals, and expose actual start',()=>{
  const source=prices();source.T00.prices.splice(-252,1);
  const result=buildUniverseSnapshot(atlas(),source,{now});
  assert.equal(result.price_through,'2026-09-09');assert.equal(result.scopes.all.exposure.eligible,12);
  assert.equal(result.rows[0].exposure.observations,250);assert.equal(result.rows[0].exposure.through,result.price_through);
  assert.ok(result.rows.every(r=>r.exposure.beta>.4&&r.exposure.beta<1.8));assert.ok(result.rows.every(r=>r.event?.first_session==='2026-07-31'));
  assert.equal(result.scopes.all.map.eligible,result.rows.filter(r=>r.event&&typeof r.metrics.revenueGrowth.change==='number').length);
  assert.ok(result.scopes.all.associations[0].rho!==null);
});
test('unverified, stale, non-Yahoo, future and old-benchmark histories cannot create current exposure',()=>{
  const source=prices();source.T00.priceBasis='provider_close_adjustment_unverified';source.T01.retrievedAt='2026-09-08T05:00:00Z';source.T02.provider='other';
  source.SPY.prices.push({date:'2026-09-10',adjustedClose:99});
  const result=buildUniverseSnapshot(atlas(),source,{now});assert.equal(result.scopes.all.exposure.eligible,9);assert.equal(result.price_through,'2026-09-09');
  source.SPY.prices=source.SPY.prices.filter(p=>p.date<'2026-08-01');assert.equal(buildUniverseSnapshot(atlas(),source,{now}).scopes.all.exposure.eligible,0);
});
test('co-movement compares a fixed complete issuer and valid pair set',()=>{
  const benchmark=Array.from({length:126},(_,i)=>({key:`k${i}`,startDate:`s${i}`,endDate:`e${i}`}));
  const rows=Array.from({length:9},(_,i)=>({ticker:`P${i}`}));const maps=new Map(rows.map((r,j)=>[r.ticker,new Map(benchmark.map((b,i)=>[b.key,j===0&&i<63?0:Math.sin(i*.17+j*.13)*.01]))]));
  const c=computeCoMovement(rows,maps,benchmark);assert.equal(c.available,true);assert.equal(c.issuers,8);assert.equal(c.eligible_tickers.includes('P0'),false);assert.equal(c.current.pairs,28);assert.equal(c.prior.pairs,28);assert.ok(c.rolling.every(p=>p.pairs===28));
  maps.get('P8').delete('k1');assert.equal(computeCoMovement(rows,maps,benchmark).available,false);
});
test('correlation requires sufficient coverage and associations preserve ties and minimum sample',()=>{
  assert.equal(spearman(Array.from({length:11},(_,i)=>[i,i])),null);
  assert.equal(spearman(Array.from({length:12},(_,i)=>[Math.floor(i/2),-Math.floor(i/2)])),-1);
  assert.equal(spearman(Array.from({length:12},()=>[1,2])),null);
  assert.equal(distribution([null,NaN,1,2,3,4]).iqr,1.5);
});
test('a fuller 48-hour snapshot is retained through provider outages without restamping',()=>{
  const previous=buildUniverseSnapshot(atlas(),prices(),{now});previous.generated_at='2026-09-08T08:00:00Z';
  const partial=buildUniverseSnapshot(atlas(),{}, {now});const chosen=chooseUniversePublication(previous,partial,now.getTime());
  assert.equal(chosen.generated_at,previous.generated_at);assert.equal(chosen.status,'stale');assert.equal(chosen.rows[0].exposure.beta,previous.rows[0].exposure.beta);
  previous.generated_at='2026-08-31T08:00:00Z';assert.equal(chooseUniversePublication(previous,partial,now.getTime()).generated_at,partial.generated_at);
});
test('public universe reads fail without a cache and never contact a provider',async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Unexpected network');};
  try{const response=await GET(new Request('https://example.com/api/v1/factor-universe?basis=ttm'));assert.equal(response.status,503);assert.equal(calls,0);assert.equal(response.headers.get('cache-control'),'private, no-store');}finally{globalThis.fetch=original;}
});
test('unknown query keys, invalid basis, duplicate inputs and unauthenticated cron are non-cacheable',async()=>{
  for(const query of ['basis=quarterly','basis=ttm&basis=annual','refresh=true']){const response=await GET(new Request(`https://example.com/api/v1/factor-universe?${query}`));assert.equal(response.status,400);assert.equal(response.headers.get('cache-control'),'private, no-store');}
  const response=await cron(new Request('https://example.com/api/cron/factor-universe'));assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'private, no-store');
});

test('prepared and SEC-only snapshots conform to the published JSON schema',()=>{
  const schema=JSON.parse(readFileSync(new URL('../public/schemas/factor-universe-v1.schema.json',import.meta.url),'utf8'));
  const validate=new Ajv({allErrors:true}).compile(schema);
  for(const result of [buildUniverseSnapshot(atlas(),{}, {now}),buildUniverseSnapshot(atlas(),prices(),{now})])assert.equal(validate(result),true,JSON.stringify(validate.errors));
});
