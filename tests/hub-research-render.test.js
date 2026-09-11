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
