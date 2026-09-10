import test from 'node:test';
import assert from 'node:assert/strict';
import { betaReading, filingEligibility, matchesResearchScreen, universeResearchChecks, researchCsvCell } from '../src/utils/marketUniverseChecks.js';
import { computeFundamentalDiagnostics } from '../src/utils/marketFundamentals.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const row = (ticker, change, financial=false) => ({ticker, financial, group:'technology', metrics:{operatingMargin:{current:change===null?null:10+change,prior:10,change},revenueGrowth:{current:change===null?null:10+change,prior:10,change}}});
const exposure = (lo,hi,beta=(lo+hi)/2) => ({beta,beta_interval:[lo,hi]});

test('CSV escapes user search formulas even after whitespace and preserves numeric signs',()=>{
  assert.equal(researchCsvCell('  =1+1'),'"\'  =1+1"');
  assert.equal(researchCsvCell('\ttext'),'"\'\ttext"');
  assert.equal(researchCsvCell(-2),'"-2"');
  assert.equal(researchCsvCell(null),'""');
  assert.equal(researchCsvCell('A"B'),'"A""B"');
});

test('interval groups partition boundaries without labeling inverse slopes defensive',()=>{
  for(const [lo,hi,expected] of [[1.1,2,'above_one'],[.1,.9,'below_one'],[-2,-.1,'inverse'],[-1,0,'includes_zero'],[0,2,'includes_zero'],[.5,1,'includes_one'],[1,2,'includes_one'],[-1,2,'includes_zero']]) assert.equal(betaReading(exposure(lo,hi)),expected);
});
test('unavailable intervals never produce a directional conclusion',()=>{
  for(const value of [null,{},exposure(2,1),exposure(0,1,2),exposure(-Infinity,1),{beta:1,beta_interval:[0,1,2]},{beta:null,beta_interval:[0,1]}]) assert.equal(betaReading(value),'unavailable');
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
test('sensitivity matches the published diagnostic calculation and retains one denominator',()=>{
  const rows=[row('A',.1),row('B',-.5),row('C',1),row('D',-2),row('E',null),row('F',3,true)];
  const before=structuredClone(rows);
  const checks=universeResearchChecks(rows,'operatingMargin');
  for(const s of checks.sensitivity){
    const b=computeFundamentalDiagnostics(rows,s.threshold).breadth.find(x=>x.key==='operatingMargin');
    assert.equal(s.eligible,4);
    assert.equal(s.balance_pct,b.balance_pct);
    assert.equal(s.higher,b.higher);
    assert.equal(s.lower,b.lower);
    assert.equal(s.neutral,b.unchanged);
  }
  assert.deepEqual(rows,before);
});
test('empty scope exports null balances, not invented neutral evidence',()=>{
  const checks=universeResearchChecks([],'operatingMargin');
  assert.ok(checks.sensitivity.every(x=>x.balance_pct===null&&x.eligible===0));
  assert.equal(checks.population,0);
  assert.doesNotThrow(()=>JSON.stringify(checks));
});
test('all audit count drilldowns return exactly their exported ticker sets',()=>{
  const rows=[{...row('A',1),exposure:exposure(1.1,2)},row('B',null),row('C',3,true)];
  const checks=universeResearchChecks(rows,'operatingMargin');
  for(const [prefix,buckets] of [['beta',checks.beta],['eligibility',checks.eligibility]]){
    for(const bucket of buckets) assert.deepEqual(rows.filter(r=>matchesResearchScreen(r,`${prefix}:${bucket.id}`,'operatingMargin')).map(r=>r.ticker),bucket.tickers);
    assert.equal(buckets.reduce((sum,b)=>sum+b.tickers.length,0),rows.length);
  }
  assert.equal(matchesResearchScreen(rows[0],'all','operatingMargin'),true);
});

test('audit panels render unavailable states and real counts without invented percentages',()=>{
  const require=createRequire(import.meta.url);
  const ts=require('typescript');
  const source=readFileSync(new URL('../src/app/market/MarketResearchChecks.tsx',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',compiled)(name=>name.endsWith('.css')?{}:require(name),module,module.exports);
  const props={checks:universeResearchChecks([],'operatingMargin'),onScreen:()=>{},onThreshold:()=>{}};
  const html=renderToStaticMarkup(createElement(module.exports.FundamentalResearchChecks,props));
  assert.match(html,/No comparable pairs are available/);
  assert.match(html,/0 of 0 issuers/);
  assert.doesNotMatch(html,/NaN|Infinity|undefined/);
  props.checks=universeResearchChecks([{...row('A',2),exposure:exposure(1.1,2)},row('B',null)],'operatingMargin');
  const populated=renderToStaticMarkup(createElement(module.exports.FundamentalResearchChecks,props));
  assert.match(populated,/Higher changes outnumber lower changes at every tested band/);
  const beta=renderToStaticMarkup(createElement(module.exports.BetaResearchChecks,props));
  assert.match(beta,/50.0%/);
  assert.match(beta,/not ranges for tomorrow/);
  assert.doesNotMatch(beta,/NaN|Infinity|undefined/);
});
