import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as cashTools from "../src/utils/portfolioCashEarnings.js";
import * as comparisonTools from "../src/utils/portfolioComparison.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";

function component(path) {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const testModule = {exports:{}};
  new Function("require", "module", "exports", compiled)(name => {
    if(name.endsWith(".css")) return {};
    if(name.endsWith("portfolioCashEarnings.js")) return cashTools;
    if(name.endsWith("portfolioComparison.js")) return comparisonTools;
    if(name.endsWith("download.js")) return {downloadText:()=>{}};
    return require(name);
  }, testModule, testModule.exports);
  return testModule.exports.default;
}

test("cash earnings renders an empty denominator without a fabricated percentage", () => {
  const CashEarnings = component("../src/app/workspace/portfolio/CashEarnings.tsx");
  const report = buildPortfolioAnalytics([], {basis:"none"}, []);
  const html = renderToStaticMarkup(createElement(CashEarnings, {report,companies:[],onInspect:()=>{}}));
  assert.match(html, /No profitable companies have aligned/);
  assert.match(html, /No paired observations/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|0\.0%/);
});

test("comparison renders explicit no-snapshot states and withholds allocation differences", () => {
  const HubComparison = component("../src/app/workspace/HubComparison.tsx");
  const documents = ["A","B"].map(id => ({id,name:id,rows:[],research:{basis:"annual"},allocation:{basis:"none"},snapshot:null}));
  const html = renderToStaticMarkup(createElement(HubComparison, {documents,activeId:"A",onNavigate:()=>{}}));
  assert.match(html, /Not captured/);
  assert.match(html, /Allocation comparison unavailable/);
  assert.match(html, /No matched-period difference is reported/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

async function metricExplorer(initialStateOverrides = {}) {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const source = readFileSync(new URL('../src/app/workspace/portfolio/PortfolioMetricExplorer.tsx',import.meta.url),'utf8');
  const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const paths = [...source.matchAll(/from\s+"(.*?\.js)"/g)].map(m=>m[1]);
  const modules = new Map(await Promise.all(paths.map(async path => [path,await import(new URL(path,new URL('../src/app/workspace/portfolio/PortfolioMetricExplorer.tsx',import.meta.url)))])));
  const module = {exports:{}};
  let hookIndex=0;
  const react=require('react');
  const reactWithState={...react,useState(initial){const index=hookIndex++;return react.useState(Object.hasOwn(initialStateOverrides,index)?initialStateOverrides[index]:initial);}};
  new Function('require','module','exports',compiled)(name=>name==='react'?reactWithState:name.endsWith('.css')?{}:modules.get(name)||require(name),module,module.exports);
  return module.exports.default;
}
const metricIssuer = (n) => ({cik:String(n).padStart(10,'0'),kind:'company',tickers:[`C${n}`],name:`Company ${n}`,industry:'Industrial',rowIds:[`row${n}`]});

test('legacy metric explorer leads with measured options, refresh and compact coverage', async () => {
  const Explorer = await metricExplorer();
  const issuers = [metricIssuer(1),metricIssuer(2)];
  const companies = issuers.map((i,index)=>({...i,status:'ready',lens:'corporate',metrics:{netMargin:{value:index?null:0,unit:'%',classification:index?'unavailable':'reported',period:{kind:'annual',start:'2025-01-01',end:'2025-12-31'}}}}));
  const html = renderToStaticMarkup(createElement(Explorer,{report:{concentration:{issuers}},companies,onInspect:()=>{},onRefresh:()=>{}}));
  assert.match(html,/Update your saved financial capture/);
  assert.match(html,/Refresh financial research/);
  assert.match(html,/Net margin · 1\/2/);
  assert.doesNotMatch(html,/<option[^>]*value="accountsPayable"/);
  assert.match(html,/not in this saved capture/i);
  assert.match(html,/Median 0%/);
  assert.equal((html.match(/aria-label="Compare C/g)||[]).length,1);
  assert.doesNotMatch(html,/Median Unavailable|Instant \/ unknown to unknown/);
});

test('empty metric explorer offers recovery without an empty ranking or fabricated statistics', async () => {
  const Explorer = await metricExplorer();
  const issuers=[metricIssuer(1)];
  const companies=[{...issuers[0],status:'partial',lens:'corporate',metrics:{}}];
  const html=renderToStaticMarkup(createElement(Explorer,{report:{concentration:{issuers}},companies,onInspect:()=>{},onRefresh:()=>{}}));
  assert.match(html,/No comparable observations in this selection/);
  assert.match(html,/No measured values in this scope/);
  assert.match(html,/Clear filters/);
  assert.doesNotMatch(html,/aria-label="Portfolio metric rankings"|Median Unavailable|NaN|Infinity|Show 25 more/);
});

test('an empty metric family cannot retain the prior family ranking', async () => {
  const Explorer=await metricExplorer({0:'roa',1:'workingCapitalInputs'});
  const issuers=[metricIssuer(1)];
  const companies=[{...issuers[0],status:'ready',lens:'banking',metrics:{roa:{value:2,unit:'%',classification:'reported',period:{kind:'annual',start:'2025-01-01',end:'2025-12-31'}}}}];
  const html=renderToStaticMarkup(createElement(Explorer,{report:{concentration:{issuers}},companies,onInspect:()=>{}}));
  assert.match(html,/No measured values in this scope/);
  assert.match(html,/No comparable observations/);
  assert.doesNotMatch(html,/Median 2%|aria-label="Portfolio metric rankings"/);
});
