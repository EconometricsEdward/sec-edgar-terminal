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
  const unavailablePrior=observation(day(selected,7),0,0);
  unavailablePrior.groups['leveraged-funds']={...unavailablePrior.groups['leveraged-funds'],long:null,net:null,netPctOi:null};
  const compatible=cftcSeries([observation(selected,10,100),unavailablePrior,observation(day(selected,14),6,60)],'leveraged-funds',selected,52);
  assert.deepEqual([compatible.selected.previousAvailableDate,compatible.selected.previousAvailableElapsedDays,compatible.selected.previousAvailableChange],[day(selected,14),14,40]);
});

test('percentiles use only prior compatible observations, give ties half weight, and require the full count',()=>{
  assert.deepEqual(cftcPercentile(2,[1,2,3],3),{value:50,reason:null,observations:3,required:3});
  assert.equal(cftcPercentile(2,[1,2],3).reason,'insufficient_history');
  const selected='2026-09-08',rows=[observation(day(selected,-7),999,9999),observation(selected,50,500)];
  for(let index=1;index<=52;index++) rows.push(observation(day(selected,index*7),index<=26?40:60,index));
  const series=cftcSeries(rows,'leveraged-funds',selected,52);
  assert.equal(series.percentile.value,50);assert.equal(series.percentile.observations,52);
  assert.deepEqual(series.percentile.comparisonRange,{observations:52,earliest:day(selected,52*7),latest:day(selected,7)});
  assert.equal(series.points.some(point=>point.reportDate>selected),false);
});

test('percentile comparison provenance skips invalid gaps and excludes the selected report',()=>{
  const selected='2026-09-08',rows=[observation(selected,50,500)];
  for(let index=1;index<=55;index++){
    const row=observation(day(selected,index*7),index,index);
    if([10,20,30].includes(index)) row.groups['leveraged-funds'].netPctOi=null;
    rows.push(row);
  }
  const series=cftcSeries(rows,'leveraged-funds',selected,52);
  assert.equal(series.percentile.observations,52);
  assert.deepEqual(series.percentile.comparisonRange,{observations:52,earliest:day(selected,55*7),latest:day(selected,7)});
  assert.notEqual(series.percentile.comparisonRange.latest,selected);
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

test('CSV keeps negative numbers numeric, distinguishes spreading states, and exports formulas and provenance',()=>{
  const raw=JSON.parse(readFileSync(new URL('./fixtures/cftc-tff-gpe5-46if-v1.json',import.meta.url),'utf8'));
  const response=buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:raw,retrievedAt:'2026-09-09T12:00:00Z',sourceUrl:'https://publicreporting.cftc.gov/resource/gpe5-46if.json'});
  const csv=cftcCsv(response);
  assert.match(csv,/net_formula/);assert.match(csv,/percentile_comparison_start/);assert.match(csv,/percentile_reason/);assert.match(csv,/history_window/);assert.match(csv,/required_prior_reports/);assert.match(csv,/response_status/);assert.match(csv,/retrieval_origin_scope/);assert.match(csv,/retrieval_scope_rows/);assert.match(csv,/retrieval_source_rows/);assert.match(csv,/retrieval_source_pages/);assert.match(csv,/retrieval_source_page_size/);assert.match(csv,/retrieval_cap_reached/);assert.match(csv,/retrieval_bounded_source_rows/);assert.match(csv,/required_values_unavailable/);assert.match(csv,/quarantine/);assert.match(csv,/source_row_id/);assert.match(csv,/raw_long_field/);assert.match(csv,/long_unavailable_reason/);assert.match(csv,/one_week_percentage_point_change_formula/);assert.match(csv,/four_week_percentage_point_change_formula/);assert.match(csv,/each observation uses its own open interest/);assert.match(csv,/reported long|long - short/);assert.match(csv,/publicreporting\.cftc\.gov/);
  assert.match(csv,/,-30,/);assert.doesNotMatch(csv,/,"'-30"/);assert.match(csv,/"Unavailable"/);
  const notApplicable=cftcCsv(buildCftcHistoryResponse({family:'tff',code:'13874A',group:'non-reportables',throughDate:'2026-09-08',window:'1y',rawRows:raw,retrievedAt:'2026-09-09T12:00:00Z'}));
  assert.match(notApplicable,/"Not applicable","not_applicable"/);
  const unavailable=cftcCsv(buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:raw.map(row=>({...row,lev_money_positions_spread:''})),retrievedAt:'2026-09-09T12:00:00Z'}));
  assert.match(unavailable,/"Unavailable","unavailable"/);assert.match(unavailable,/\[""lev_money_positions_spread""\]/,'required-value gap metadata');
  const reportedZero=cftcCsv(buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:raw.map(row=>({...row,lev_money_positions_spread:'0'})),retrievedAt:'2026-09-09T12:00:00Z'}));
  assert.match(reportedZero,/,0,"reported",/);
  const zeroOi=buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:raw.map(row=>({...row,open_interest_all:'0'})),retrievedAt:'2026-09-09T12:00:00Z'});
  assert.equal(zeroOi.history[0].netPctOi,null);assert.equal(zeroOi.history[0].derivedUnavailable.netPctOi,'open_interest_not_positive');assert.match(cftcCsv(zeroOi),/"open_interest_not_positive"/);
  const unsafe=cftcCsv(buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:raw.map(row=>({...row,id:'=2+3',lev_money_positions_long:'=1+1'})),retrievedAt:'2026-09-09T12:00:00Z'}));
  assert.match(unsafe,/"'=2\+3"/);assert.match(unsafe,/"'=1\+1"/);assert.match(unsafe,/"nonnumeric"/);assert.doesNotMatch(unsafe,/,"=2\+3"/);assert.doesNotMatch(unsafe,/,"=1\+1"/);
  const capped=buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:raw,retrievedAt:'2026-09-09T12:00:00Z',retrieval:{origin_scope:'contract_history',scope_rows:600,source_rows:600,source_pages:3,source_page_size:200,cap_reached:true,bounded_scope_rows:600,bounded_source_rows:600}});
  const cappedCsv=cftcCsv({...capped,refresh_warning:'=review partial coverage'});
  assert.match(cappedCsv,/"1y",52/);assert.match(cappedCsv,/"partial","'=review partial coverage","contract_history",600,600,3,200,"true",600,600/);assert.match(cappedCsv,/"insufficient_history"/);
  const reconciled=cftcCsv(buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:raw.map(row=>({...row,open_interest_all:'999'})),retrievedAt:'2026-09-09T12:00:00Z'}));
  assert.match(reconciled,/open_interest_reconciliation_mismatch/,'quarantine metadata');
  const prior={...raw[0],id:'old-name-row',report_date_as_yyyy_mm_dd:'2026-09-01T00:00:00.000',market_and_exchange_names:'OLD MARKET - OLD EXCHANGE',contract_market_name:'OLD CONTRACT'};
  const renamed=buildCftcHistoryResponse({family:'tff',code:'13874A',group:'leveraged-funds',throughDate:'2026-09-08',window:'1y',rawRows:[raw[0],prior],retrievedAt:'2026-09-09T12:00:00Z'});
  assert.deepEqual([renamed.history[0].marketName,renamed.history[0].contractName,renamed.history[0].exchange],['OLD MARKET - OLD EXCHANGE','OLD CONTRACT','OLD EXCHANGE']);
  assert.match(cftcCsv(renamed),/"OLD MARKET - OLD EXCHANGE","OLD CONTRACT","OLD EXCHANGE"/);
});
