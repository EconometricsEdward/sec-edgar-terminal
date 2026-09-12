import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUniverseSnapshot, distribution, summarizeScope, UNIVERSE_METRICS, UNIVERSE_VERSION } from '../src/utils/marketUniverse.js';
import { chooseUniversePublication, hasRetiredUniverseFields, isUniverseSnapshot } from '../src/utils/marketUniverseServer.js';
import { GET as v1 } from '../src/app/api/v1/factor-universe/route.js';
import { GET as v2 } from '../src/app/api/v2/factor-universe/route.js';
import { GET as cron } from '../src/app/api/cron/factor-universe/route.js';

const now=new Date('2026-09-10T08:00:00Z');
function company(i=0,change=i-5){
  const prior=Object.fromEntries(UNIVERSE_METRICS.map((metric,index)=>[metric.key,10+index]));
  const current=Object.fromEntries(UNIVERSE_METRICS.map((metric,index)=>[metric.key,prior[metric.key]+change*(1+index*.1)]));
  const accession=`0000000100-26-${String(i).padStart(6,'0')}`;
  const comparison={pointInTime:true,gapDays:365,current:{metrics:current,filed:'2026-07-30',end:'2026-06-30',accession,factorSourceAccessions:[accession]},prior:{metrics:prior,filed:'2025-07-30',end:'2025-06-30',factorSourceAccessions:['0000000100-25-000001']}};
  return {ticker:`T${String(i).padStart(2,'0')}`,name:`Issuer ${i}`,cik:String(100+i),sic:'3674',cohorts:['sector-technology'],researchGroup:{id:'sector-technology'},checkedAt:'2026-09-10T04:00:00Z',factsRetrievedAt:'2026-09-10T03:00:00Z',filingComparisons:{ttm:comparison,annual:comparison}};
}
function atlas(companies=Array.from({length:12},(_,i)=>company(i))){return {generatedAt:'2026-09-10T04:20:00Z',requested:companies.length,companies,groups:[{id:'sector-technology',label:'Technology'}],coverage:{membership_id:'sample-1',duplicate_share_classes:0,grouping:'One primary sector per issuer.'}};}

test('SEC breadth deduplicates issuers, counts zero as neutral, and never imputes missing',()=>{
  const companies=[company(0,-2),company(1,0),company(2,2),company(3,4)];
  companies[3].filingComparisons.ttm.current.metrics.revenueGrowth=null;
  companies.push({...companies[2],ticker:'ZZZ'});
  const result=buildUniverseSnapshot(atlas(companies),{}, {now}),growth=result.scopes.all.breadth[0];
  assert.equal(result.schema_version,UNIVERSE_VERSION);assert.equal(result.rows.length,4);assert.equal(result.universe.share_classes_excluded,1);
  assert.deepEqual([growth.higher,growth.lower,growth.unchanged,growth.missing],[1,1,1,1]);
  assert.equal(growth.higher_pct,100/3);assert.equal(growth.change.median,0);
});

test('magnitude and dispersion use exactly the same paired issuer sample',()=>{
  const result=buildUniverseSnapshot(atlas([company(0),company(1),company(2)]),{}, {now});
  [0,100,101].forEach((prior,index)=>{result.rows[index].metrics.revenueGrowth={prior,current:[99,100,0][index],change:[99,0,-101][index],unavailable_reason:null};});
  const growth=summarizeScope(result.rows).breadth[0];
  assert.equal(growth.change.median,0);assert.equal(growth.current.median-growth.prior.median,-1);assert.equal(growth.paired_iqr_change,growth.current.iqr-growth.prior.iqr);
  assert.equal(distribution([null,NaN,1,2,3,4]).iqr,1.5);
});

test('financial exclusions and simultaneous weakening use explicit complete-case denominators',()=>{
  const companies=[company(0,-2),company(1,-2),company(2,-2),company(3,1)];
  companies[1].sic='6021';companies[2].filingComparisons.ttm.prior.metrics.freeCashFlowMargin=null;
  const snapshot=buildUniverseSnapshot(atlas(companies),{}, {now}),scope=snapshot.scopes.all;
  assert.equal(snapshot.rows[1].metrics.freeCashFlowMargin.unavailable_reason,'ISSUER_TYPE_EXCLUDED');
  assert.equal(scope.breadth.find(metric=>metric.key==='operatingMargin').population_count,3);
  assert.equal(scope.breadth.find(metric=>metric.key==='freeCashFlowMargin').eligible,2);
  assert.deepEqual([scope.simultaneous_weakening.eligible,scope.simultaneous_weakening.count,scope.simultaneous_weakening.missing],[2,1,1]);
});

test('incompatible filing periods remain unavailable and retain source clocks',()=>{
  const issuer=company();issuer.filingComparisons.ttm.gapDays=180;
  const snapshot=buildUniverseSnapshot(atlas([issuer]),{}, {now});
  assert.equal(snapshot.rows[0].metrics.revenueGrowth.current,null);
  assert.equal(snapshot.rows[0].metrics.revenueGrowth.unavailable_reason,'NO_COMPARABLE_PERIOD');
  assert.equal(snapshot.rows[0].sec_checked_at,'2026-09-10T04:00:00Z');
  assert.equal(snapshot.rows[0].facts_retrieved_at,'2026-09-10T03:00:00Z');
});

test('v2 snapshots reject every retired market-data field recursively',()=>{
  const snapshot=buildUniverseSnapshot(atlas(),{}, {now});
  assert.equal(isUniverseSnapshot(snapshot),true);assert.equal(hasRetiredUniverseFields(snapshot),false);
  for(const field of ['price_through','price_sample','price_status','price_source','exposure','event','co_movement','associations','sector_proxy']) assert.equal(hasRetiredUniverseFields({...snapshot,nested:{[field]:1}}),true,field);
});

test('publication retention depends on SEC coverage and never revives an incompatible v1 snapshot',()=>{
  const previous=buildUniverseSnapshot(atlas(),{}, {now});previous.generated_at='2026-09-09T08:00:00Z';
  const partial=buildUniverseSnapshot(atlas(Array.from({length:8},(_,i)=>company(i))),{}, {now});
  const retained=chooseUniversePublication(previous,partial,now.getTime());
  assert.equal(retained.generated_at,previous.generated_at);assert.equal(retained.status,'stale');assert.match(retained.refresh_warning,/SEC filing coverage/);
  const legacy={...previous,schema_version:'edgar.factor-universe.v1',price_through:'2026-09-08'};
  assert.equal(isUniverseSnapshot(legacy),false);
});

test('SEC-only snapshots conform to the published v2 schema',()=>{
  const schema=JSON.parse(readFileSync(new URL('../public/schemas/factor-universe-v2.schema.json',import.meta.url),'utf8'));
  const validate=new Ajv({allErrors:true,unknownFormats:'ignore'}).compile(schema);
  const snapshot=buildUniverseSnapshot(atlas(),{}, {now});
  assert.equal(validate(snapshot),true,JSON.stringify(validate.errors));
  for(const field of ['price_through','price_sample','price_status','price_source','exposure','event','co_movement','associations','sector_proxy']) {
    assert.equal(validate({...snapshot,[field]:1}),false,`root ${field}`);
    assert.equal(validate({...snapshot,universe:{...snapshot.universe,coverage:{sources:[{fund:'test',[field]:1}]}}}),false,`recursive ${field}`);
  }
  assert.equal(validate({...snapshot,links:{...snapshot.links,price_source:'retired'}}),false,'closed links');
  assert.equal(validate({...snapshot,scopes:{...snapshot.scopes,all:{...snapshot.scopes.all,sector_proxy:'XLK'}}}),false,'nested retired fields');
});

test('v1 is 410 with a successor while v2 rejects ambiguous or unsupported queries',async()=>{
  const retired=await v1(new Request('https://example.test/api/v1/factor-universe?basis=ttm'));
  assert.equal(retired.status,410);assert.equal(retired.headers.get('cache-control'),'private, no-store');assert.match(retired.headers.get('link'),/successor-version/);
  for(const query of ['basis=quarterly','basis=ttm&basis=annual','refresh=true']){
    const response=await v2(new Request(`https://example.test/api/v2/factor-universe?${query}`,{headers:{'x-forwarded-for':`192.0.2.${query.length}`}}));
    assert.equal(response.status,400);assert.equal(response.headers.get('cache-control'),'private, no-store');
  }
});

test('fundamental publication cron remains authenticated and non-cacheable',async()=>{
  const response=await cron(new Request('https://example.test/api/cron/factor-universe'));
  assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'private, no-store');
});
