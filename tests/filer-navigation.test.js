import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createContext, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const TickerContext = createContext(null);

function component(file, pathname) {
  const url = new URL(file, import.meta.url);
  const localRequire = createRequire(url);
  const compiled = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name.endsWith(".css")) return {};
    if (name.includes("contexts/TickerContext")) return { TickerContext };
    if (name === "next/navigation") return {
      usePathname: () => pathname,
      useSearchParams: () => new URLSearchParams(),
    };
    if (name === "next/link") return {
      __esModule: true,
      default: ({ children, prefetch: _prefetch, ...props }) => createElement("a", props, children),
    };
    return localRequire(name);
  }, testModule, testModule.exports);
  return testModule.exports.default;
}

function render(file, pathname) {
  const Component = component(file, pathname);
  return renderToStaticMarkup(createElement(TickerContext.Provider, { value: {
    ticker: "AAPL",
    company: { name: "Apple Inc.", cik: "0000320193" },
    tickerMap: {
      AAPL: { ticker: "AAPL", name: "Apple Inc.", isFund: false },
      // Even a stale/corrupt directory entry cannot turn an explicit CIK into a stock or fund.
      "0001747057": { ticker: "0001747057", name: "Wrong saved fund", isFund: true },
    },
  } }, createElement(Component)));
}

test("filer context shows a CIK and only evidence research links", () => {
  const html = render("../src/components/site/CompanyContext.tsx", "/filings/0001747057");
  assert.match(html, /SEC filer research/);
  assert.match(html, /CIK 0001747057/);
  assert.match(html, /href="\/filings\/0001747057"/);
  assert.match(html, /href="\/disclosures\?tickers=0001747057&amp;mode=companies"/);
  assert.doesNotMatch(html, /href="\/(analysis|risk|fund)/);
  assert.doesNotMatch(html, /Apple|Wrong saved fund/);
});

test("primary navigation preserves CIK only in supported filer tools", () => {
  const html = render("../src/components/NavTabs.tsx", "/filings/0001747057");
  assert.match(html, /href="\/filings\/0001747057"/);
  assert.match(html, /href="\/disclosures\?tickers=0001747057&amp;mode=companies"/);
  for (const tool of ["analysis", "risk", "fund"]) assert.match(html, new RegExp(`href="/${tool}"`));
  assert.doesNotMatch(html, /href="\/(analysis|risk|fund)[^\"]*0001747057/);
});

test("listed stock context continues to retain its research links", () => {
  const html = render("../src/components/site/CompanyContext.tsx", "/filings/AAPL");
  assert.match(html, /Apple Inc/);
  assert.match(html, /Company research/);
  assert.match(html, /href="\/analysis\/AAPL"/);
  assert.match(html, /href="\/risk\?ticker=AAPL"/);
  assert.doesNotMatch(html, /SEC filer research/);
});
