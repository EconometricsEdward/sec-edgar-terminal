import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverLatestCftcDate, fetchCftcLatestRows } from '../src/utils/cftcServer.js';
import { CFTC_FAMILIES, normalizeCftcRows } from '../src/utils/cftc.js';

const live=process.env.CFTC_LIVE_SMOKE==='1';
for(const family of ['tff','disaggregated']) test(`live official ${family} source has a bounded validated latest cohort`,{skip:!live,timeout:30000},async()=>{
  const latest=await discoverLatestCftcDate(family,{retries:1});
  const result=await fetchCftcLatestRows(family,latest.date,{retries:1});
  const normalized=normalizeCftcRows(result.rows,family);
  assert.ok(normalized.rows.length>0);assert.ok(normalized.rows.every(row=>row.reportDate===latest.date&&row.reportBasis==='futures_only'));
  const source=new URL(result.sourceUrl);assert.equal(source.hostname,'publicreporting.cftc.gov');assert.equal(source.pathname,`/resource/${CFTC_FAMILIES[family].datasetId}.json`);assert.equal(source.searchParams.get('$offset'),'0');assert.equal(source.searchParams.get('$limit'),'500');assert.ok(source.searchParams.get('$order'));
  const code=family==='tff'?'13874A':'067651',raw=result.rows.find(row=>row.cftc_contract_market_code===code),row=normalized.rows.find(item=>item.code===code);
  assert.ok(raw&&row,`${code} must remain in the representative live cohort`);assert.equal(row.openInterest,Number(raw.open_interest_all));
  if(family==='tff')assert.equal(row.groups['leveraged-funds'].long,Number(raw.lev_money_positions_long));
  else{assert.equal(row.groups['managed-money'].long,Number(raw.m_money_positions_long_all));assert.equal(row.groups['swap-dealers'].short,Number(raw.swap__positions_short_all));}
});
