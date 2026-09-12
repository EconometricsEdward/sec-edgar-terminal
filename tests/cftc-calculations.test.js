import test from 'node:test';
import assert from 'node:assert/strict';
import { cftcCsv, cftcPercentile, cftcSeries } from '../src/utils/cftc.js';
import { buildCftcHistoryResponse } from '../src/utils/cftcServer.js';
import { readFileSync } from 'node:fs';

function observation(date,netPctOi,net=Math.round(netPctOi*10),overrides={}){
  return {family:'tff',reportBasis:'futures_only',reportDate:date,code:'13874A',venueCode:'CME',marketName:'E-MINI S&P 500 - CME',contractName:'E-MINI S&P 500',exchange:'CME',units:'$50 X INDEX',openInterest:1000,groups:{'leveraged-funds':{id:'leveraged-funds',label:'Leveraged Funds',long:500+net,short:500,spreading:0,net,netPctOi}},reconciliation:{status:'ok'},...overrides};
}
const day=(date,days)=>{const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()-days);return value.toISOString().slice(0,10);};

test('weekly and four-week changes require exact calendar dates and label a separate prior available report',()=>{
  const selected='2026-09-08';
  const rows=[observation(selected,10,100),observation(day(selected,7),7,70),observation(day(selected,28),4,40),observation(day(selected,35),3,30)];
  const series=cftcSeries(rows,'leveraged-funds',selected,52);
  assert.deepEqual([series.selected.oneWeekChange,series.selected.oneWeekNetPctChange,series.selected.fourWeekChange,series.selected.fourWeekNetPctChange],[30,3,60,6]);
  assert.deepEqual([series.selected.previousAvailableDate,series.selected.previousAvailableElapsedDays,series.selected.previousAvailableChange],[day(selected,7),7,30]);
  const missing=cftcSeries(rows.filter(row=>row.reportDate!==day(selected,7)),'leveraged-funds',selected,52);
  assert.equal(missing.selected.oneWeekChange,null);assert.equal(missing.selected.previousAvailableElapsedDays,28);
});

test('percentiles use only prior compatible observations, give ties half weight, and require the full count',()=>{
  assert.deepEqual(cftcPercentile(2,[1,2,3],3),{value:50,reason:null,observations:3,required:3});
  assert.equal(cftcPercentile(2,[1,2],3).reason,'insufficient_history');
  const selected='2026-09-08',rows=[observation(day(selected,-7),999,9999),observation(selected,50,500)];
  for(let index=1;index<=52;index++) rows.push(observation(day(selected,index*7),index<=26?40:60,index));
  const series=cftcSeries(rows,'leveraged-funds',selected,52);
  assert.equal(series.percentile.value,50);assert.equal(series.percentile.observations,52);
  assert.equal(series.points.some(point=>point.reportDate>selected),false);
});

test('historical compatibility follows code, venue and units rather than mutable display names',()=>{
  const selected='2026-09-08', rows=[observation(selected,5),observation(day(selected,7),4,40,{marketName:'OLD PUBLISHED NAME'}),observation(day(selected,14),3,30,{venueCode:'OTHER'}),observation(day(selected,21),2,20,{units:'MICRO'})];
  const series=cftcSeries(rows,'leveraged-funds',selected,52);
  assert.equal(series.points.length,2);assert.equal(series.selected.oneWeekChange,10);
  assert.deepEqual(series.historyRange.compatibility,{code:'13874A',venueCode:'CME',units:'$50 X INDEX'});
});

test('constant histories rank at the midpoint and insufficient long windows offer qualified shorter ranks',()=>{
  const selected='2026-09-08',rows=[observation(selected,5)];
  for(let index=1;index<=52;index++)rows.push(observation(day(selected,index*7),5));
  const series=cftcSeries(rows,'leveraged-funds',selected,260);
  assert.equal(series.percentile.value,null);assert.equal(series.percentile.reason,'insufficient_history');
  assert.equal(series.shorterPercentiles[0].value,50);assert.equal(series.shorterPercentiles[0].observations,52);
});

test('CSV keeps negative numbers numeric, unavailable distinct from zero, and exports formulas and provenance',()=>{
  const raw=JSON.parse(readFileSync(new URL('./fixtures/cftc-tff-gpe5-46if-v1.json',import.meta.url),'utf8'));
  const response=buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:raw,retrievedAt:'2026-09-09T12:00:00Z',sourceUrl:'https://publicreporting.cftc.gov/resource/gpe5-46if.json'});
  const csv=cftcCsv(response);
  assert.match(csv,/net_formula/);assert.match(csv,/reported long|long - short/);assert.match(csv,/publicreporting\.cftc\.gov/);
  assert.match(csv,/,-30,/);assert.doesNotMatch(csv,/,"'-30"/);assert.match(csv,/"Unavailable"/);
});
