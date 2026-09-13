import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverLatestCftcDate, fetchCftcContractHistory, fetchCftcLatestRows } from '../src/utils/cftcServer.js';
import { CFTC_FAMILIES, normalizeCftcRows } from '../src/utils/cftc.js';

const live=process.env.CFTC_LIVE_SMOKE==='1';
for(const family of ['tff','disaggregated']) test(`live official ${family} source has bounded validated latest and paginated history cohorts`,{skip:!live,timeout:60000},async()=>{
  const latest=await discoverLatestCftcDate(family,{retries:1});
  const result=await fetchCftcLatestRows(family,latest.date,{retries:1});
  const normalized=normalizeCftcRows(result.rows,family);
  assert.ok(normalized.rows.length>0);assert.ok(normalized.rows.every(row=>row.reportDate===latest.date&&row.reportBasis==='futures_only'));
  const source=new URL(result.sourceUrl);assert.equal(source.hostname,'publicreporting.cftc.gov');assert.equal(source.pathname,`/resource/${CFTC_FAMILIES[family].datasetId}.json`);assert.equal(source.searchParams.get('$offset'),'0');assert.equal(source.searchParams.get('$limit'),'500');assert.ok(source.searchParams.get('$order'));
  const code=family==='tff'?'13874A':'067651',raw=result.rows.find(row=>row.cftc_contract_market_code===code),row=normalized.rows.find(item=>item.code===code);
  assert.ok(raw&&row,`${code} must remain in the representative live cohort`);assert.equal(row.openInterest,Number(raw.open_interest_all));
  if(family==='tff'){
    assert.equal(row.groups['leveraged-funds'].long,Number(raw.lev_money_positions_long));
    for(const [verifiedCode,category] of [['124603','equity-indices'],['124608','equity-indices'],['13874U','equity-indices'],['209747','equity-indices'],['098662','currencies']]){
      const verified=normalized.rows.find(item=>item.code===verifiedCode);
      assert.ok(verified,`${verifiedCode} must remain in the TFF live catalog`);assert.equal(verified.category,category);
    }
  }
  else{assert.equal(row.groups['managed-money'].long,Number(raw.m_money_positions_long_all));assert.equal(row.groups['swap-dealers'].short,Number(raw.swap__positions_short_all));}

  const group=family==='tff'?'leveraged-funds':'managed-money';
  const history=await fetchCftcContractHistory(family,code,latest.date,260,{group,retries:1});
  const historySource=new URL(history.sourceUrl),historyRows=normalizeCftcRows(history.rows,family).rows;
  assert.ok(history.pages>=2,'the five-year source check must exercise bounded pagination');
  assert.ok(history.rows.length>200&&history.rows.length<=600);
  assert.equal(historySource.searchParams.get('$limit'),'200');assert.equal(historySource.searchParams.get('$offset'),'0');
  assert.match(historySource.searchParams.get('$where'),new RegExp(`cftc_contract_market_code='${code}'`));
  assert.ok(historySource.searchParams.get('$order'));
  assert.ok(historyRows.some(item=>item.reportDate===latest.date));
  assert.ok(historyRows.every(item=>item.code===code&&item.reportDate<=latest.date));
});
