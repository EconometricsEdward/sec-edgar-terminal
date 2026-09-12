import test from 'node:test';
import assert from 'node:assert/strict';
import { filingEligibility, matchesResearchScreen, universeResearchChecks, researchCsvCell } from '../src/utils/marketUniverseChecks.js';
import { computeFundamentalDiagnostics } from '../src/utils/marketFundamentals.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const row = (ticker, change, financial=false) => ({ticker, financial, group:'technology', metrics:{operatingMargin:{current:change===null?null:10+change,prior:10,change},revenueGrowth:{current:change===null?null:10+change,prior:10,change}}});

test('CSV protects formula text and preserves finite signed numbers',()=>{
  assert.equal(researchCsvCell('  =1+1'),'"\'  =1+1"');
  assert.equal(researchCsvCell('\ttext'),'"\'\ttext"');
  assert.equal(researchCsvCell(-2),'-2');
  assert.equal(researchCsvCell(null),'""');
  assert.equal(researchCsvCell('A"B'),'"A""B"');
});

test('missing, paired and excluded partition issuer scope without treating zero as missing',()=>{
  const rows=[row('ZERO',0),row('MISSING',null),row('BANK',1,true)];
  const checks=universeResearchChecks(rows,'operatingMargin');
  assert.deepEqual(checks.eligibility.map(x=>x.tickers),[['ZERO'],['MISSING'],['BANK']]);
  assert.equal(checks.sensitivity[0].neutral,1);
  assert.equal(filingEligibility(rows[2],'revenueGrowth'),'paired');
  assert.equal(filingEligibility({...rows[0],metrics:{operatingMargin:{current:null,prior:2,change:1}}},'operatingMargin'),'missing');
  assert.equal(filingEligibility(row('BAD',Infinity),'operatingMargin'),'missing');
});

test('sensitivity uses the fixed paired sample and matches published diagnostics',()=>{
  const rows=[row('A',.1),row('B',-.5),row('C',1),row('D',-2),row('E',null),row('F',3,true)];
  const before=structuredClone(rows), checks=universeResearchChecks(rows,'operatingMargin');
  for(const sensitivity of checks.sensitivity){
    const breadth=computeFundamentalDiagnostics(rows,sensitivity.threshold).breadth.find(x=>x.key==='operatingMargin');
    assert.equal(sensitivity.eligible,4);
    assert.deepEqual([sensitivity.balance_pct,sensitivity.higher,sensitivity.lower,sensitivity.neutral],[breadth.balance_pct,breadth.higher,breadth.lower,breadth.unchanged]);
  }
  assert.deepEqual(rows,before);
});

test('all eligibility drilldowns reproduce exactly their exported ticker sets',()=>{
  const rows=[row('A',1),row('B',null),row('C',3,true)], checks=universeResearchChecks(rows,'operatingMargin');
  for(const bucket of checks.eligibility) assert.deepEqual(rows.filter(item=>matchesResearchScreen(item,`eligibility:${bucket.id}`,'operatingMargin')).map(item=>item.ticker),bucket.tickers);
  assert.equal(checks.eligibility.reduce((sum,bucket)=>sum+bucket.tickers.length,0),rows.length);
  assert.equal(matchesResearchScreen(rows[0],'all','operatingMargin'),true);
});

test('empty research checks stay explicit and render no invented percentages',()=>{
  const checks=universeResearchChecks([],'operatingMargin');
  assert.ok(checks.sensitivity.every(item=>item.balance_pct===null&&item.eligible===0));
  const require=createRequire(import.meta.url), ts=require('typescript');
  const source=readFileSync(new URL('../src/app/market/MarketResearchChecks.tsx',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const testModule={exports:{}};
  new Function('require','module','exports',compiled)(name=>name.endsWith('.css')?{}:require(name),testModule,testModule.exports);
  const html=renderToStaticMarkup(createElement(testModule.exports.FundamentalResearchChecks,{checks,onScreen:()=>{},onThreshold:()=>{}}));
  assert.match(html,/No comparable pairs are available/);
  assert.match(html,/0 of 0 issuers/);
  assert.doesNotMatch(html,/\b(?:NaN|Infinity|undefined|beta)\b/i);
});
