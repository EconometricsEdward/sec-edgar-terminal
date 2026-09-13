import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFTC_REPORT_BASIS, cftcDate, normalizeCftcRow, normalizeCftcRows, parseCftcNumber } from '../src/utils/cftc.js';

const fixture=name=>JSON.parse(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8'))[0];

test('TFF fixture preserves identity, source fields, participant mapping and reconciliation',()=>{
  const raw=fixture('cftc-tff-gpe5-46if-v1.json'), result=normalizeCftcRow(raw,'tff');
  assert.equal(result.ok,true);
  const row=result.value;
  assert.deepEqual([row.family,row.reportBasis,row.code,row.reportDate,row.venueCode],['tff',CFTC_REPORT_BASIS,'13874A','2026-09-08','CME']);
  assert.deepEqual([row.groups['leveraged-funds'].long,row.groups['leveraged-funds'].short,row.groups['leveraged-funds'].net],[80,110,-30]);
  assert.equal(row.groups['non-reportables'].spreadingStatus,'not_applicable');
  assert.equal(row.reconciliation.status,'ok');
  assert.equal(row.raw.lev_money_positions_long,'80');
});

test('Disaggregated fixture honors the official double-underscore swap fields',()=>{
  const raw=fixture('cftc-disaggregated-72hh-3qpy-v1.json'), result=normalizeCftcRow(raw,'disaggregated');
  assert.equal(result.ok,true);
  const swap=result.value.groups['swap-dealers'];
  assert.deepEqual([swap.long,swap.short,swap.spreading,swap.net],[80,90,20,-10]);
  assert.equal(swap.rawFields.short,'swap__positions_short_all');
  assert.equal(result.value.reconciliation.status,'ok');
});

test('strict numbers preserve zero and distinguish absent, blank, suppressed and invalid values',()=>{
  assert.deepEqual(parseCftcNumber('0'),{value:0,reason:null});
  assert.deepEqual(parseCftcNumber('-0.25'),{value:-.25,reason:null});
  assert.deepEqual(parseCftcNumber(null),{value:null,reason:'absent'});
  assert.deepEqual(parseCftcNumber('  '),{value:null,reason:'blank'});
  assert.deepEqual(parseCftcNumber('.'),{value:null,reason:'suppressed'});
  assert.deepEqual(parseCftcNumber('1,000'),{value:null,reason:'nonnumeric'});
  assert.equal(parseCftcNumber(Infinity).reason,'nonfinite');
});

test('codes retain leading zeroes, letters and plus signs while invalid basis/dates are quarantined',()=>{
  const base=fixture('cftc-disaggregated-72hh-3qpy-v1.json');
  for(const code of ['001602','13874A','20974+']) assert.equal(normalizeCftcRow({...base,cftc_contract_market_code:code},'disaggregated').value.code,code);
  assert.equal(normalizeCftcRow({...base,futonly_or_combined:'Combined'},'disaggregated').reason,'not_futures_only');
  assert.equal(normalizeCftcRow({...base,report_date_as_yyyy_mm_dd:'2026-02-30'},'disaggregated').reason,'invalid_report_date');
  assert.equal(normalizeCftcRow({...base,report_date_as_yyyy_mm_dd:'2026-09-08junk'},'disaggregated').reason,'invalid_report_date');
  assert.equal(normalizeCftcRow({...base,report_date_as_yyyy_mm_dd:'2026-09-08T12:00:00.000'},'disaggregated').reason,'invalid_report_date');
  assert.equal(normalizeCftcRow({...base,report_date_as_yyyy_mm_dd:'2026-09-08'},'disaggregated').value.reportDate,'2026-09-08');
  assert.equal(cftcDate('2024-02-29'),'2024-02-29');assert.equal(cftcDate('2026-02-29'),null);
});

test('identical duplicates deduplicate but conflicting identities withhold both observations',()=>{
  const raw=fixture('cftc-tff-gpe5-46if-v1.json');
  let result=normalizeCftcRows([raw,{...raw,id:'duplicate'}],'tff');
  assert.equal(result.rows.length,1);assert.equal(result.quarantine.length,0);
  result=normalizeCftcRows([raw,{...raw,id:'conflict',lev_money_positions_long:'81'}],'tff');
  assert.equal(result.rows.length,0);assert.equal(result.quarantine[0].reason,'conflicting_duplicate_identity');
});

test('negative positions are rejected and unavailable required values retain field reasons',()=>{
  const raw=fixture('cftc-tff-gpe5-46if-v1.json');
  assert.equal(normalizeCftcRow({...raw,dealer_positions_long_all:'-1'},'tff').reason,'negative_position');
  const missing=normalizeCftcRow({...raw,lev_money_positions_long:''},'tff').value;
  assert.equal(missing.groups['leveraged-funds'].long,null);assert.equal(missing.unavailable.lev_money_positions_long,'blank');assert.equal(missing.reconciliation.status,'unavailable');
});

test('verified TFF index and dollar-index codes retain conservative categories when source classifications are blank',()=>{
  const base=fixture('cftc-tff-gpe5-46if-v1.json'), blank={commodity_subgroup_name:'',commodity_group_name:'',commodity_name:'',commodity:''};
  for(const code of ['124603','124608','13874U','209747']) assert.equal(normalizeCftcRow({...base,...blank,cftc_contract_market_code:code},'tff').value.category,'equity-indices',code);
  assert.equal(normalizeCftcRow({...base,...blank,cftc_contract_market_code:'098662'},'tff').value.category,'currencies');
  assert.equal(normalizeCftcRow({...base,...blank,cftc_contract_market_code:'999999'},'tff').value.category,'other','unknown blank classifications remain conservative');
});
