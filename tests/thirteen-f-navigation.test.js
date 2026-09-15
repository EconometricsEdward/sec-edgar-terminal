import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createContext, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { entityFromRoute, managerHoldingsPath, safeInternalPath } from "../src/utils/siteRoutes.js";
import { hasThirteenFHoldings, secFilerResearchPath, mergeFilerSuggestions } from "../src/utils/secFilerSearch.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const TickerContext = createContext(null);
const manager = { cik: "0001747057", name: "D1 Capital Partners L.P.", formTypes: ["13F-HR"] };

function renderContext(file, path) {
  const url = new URL(file, import.meta.url);
  const route = new URL(path, "https://secedgarterminal.com");
  const localRequire = createRequire(url);
  const compiled = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name.endsWith(".css")) return {};
    if (name.includes("contexts/TickerContext")) return { TickerContext };
    if (name === "next/navigation") return {
      usePathname: () => route.pathname,
      useSearchParams: () => route.searchParams,
    };
    if (name === "next/link") return {
      __esModule: true,
      default: ({ children, prefetch: _prefetch, ...props }) => createElement("a", props, children),
    };
    return localRequire(name);
  }, testModule, testModule.exports);
  return renderToStaticMarkup(createElement(TickerContext.Provider, { value: {
    ticker: "AAPL",
    tickerMap: {
      AAPL: { ticker: "AAPL", name: "Apple Inc.", isFund: false },
      SPY: { ticker: "SPY", name: "SPDR S&P 500 ETF Trust", isFund: true },
      "0001747057": { ticker: "0001747057", name: "Incorrect stale fund", isFund: true },
    },
  } }, createElement(testModule.exports.default)));
}

test("only verified holdings reports route SEC filer suggestions into Funds", () => {
  for (const form of ["13F-HR", "13F-HR/A"]) {
    const record = { ...manager, formTypes: [form] };
    assert.equal(hasThirteenFHoldings(record), true);
    assert.equal(secFilerResearchPath(record), "/fund?view=13f&managerCik=0001747057");
    const [suggestion] = mergeFilerSuggestions([], [record]);
    assert.equal(suggestion.type, "filer");
    assert.equal(suggestion.isFund, undefined);
    assert.equal(suggestion.path, secFilerResearchPath(record));
  }
  for (const formTypes of [[], ["13F-NT"], ["13F-NT/A"], ["13F"], ["NPORT-P"], ["10-K"]]) {
    const record = { ...manager, formTypes };
    assert.equal(hasThirteenFHoldings(record), false);
    assert.equal(secFilerResearchPath(record), "/filings/0001747057");
  }
  assert.equal(secFilerResearchPath({ ...manager, cik: "AAPL" }), null);
});

test("manager destinations validate the CIK and preserve supported report settings", () => {
  const path = managerHoldingsPath("1747057", { period: "2026-06-30", view: "changes" });
  assert.equal(path, "/fund?view=13f&managerCik=0001747057&managerPeriod=2026-06-30&managerView=changes");
  assert.equal(safeInternalPath(path), path);
  assert.equal(managerHoldingsPath("1747057", { period: "2026-02-31", view: "http://other" }),
    "/fund?view=13f&managerCik=0001747057");
  assert.equal(managerHoldingsPath("1747057", { period: "2026-08-14", view: "holdings" }),
    "/fund?view=13f&managerCik=0001747057&managerView=holdings");
  for (const cik of ["0", "0000000000", "10000000000", "../AAPL", "SPY", null]) {
    assert.equal(managerHoldingsPath(cik), null);
  }
});

test("portfolio history deep links retain the manager and selected quarter in navigation", () => {
  const path = managerHoldingsPath("1747057", { period: "2026-06-30", view: "history" });
  assert.equal(path, "/fund?view=13f&managerCik=0001747057&managerPeriod=2026-06-30&managerView=history");
  const route = new URL(path, "https://secedgarterminal.com");
  assert.deepEqual(entityFromRoute(route.pathname, route.searchParams), { kind: "filer", ticker: manager.cik, fundPath: path });
  const html = renderContext("../src/components/NavTabs.tsx", path);
  assert.match(html, /href="\/fund\?view=13f&amp;managerCik=0001747057&amp;managerPeriod=2026-06-30&amp;managerView=history"/);
  assert.match(html, /href="\/filings\/0001747057"/);
});

test("the explicit 13F query establishes CIK context without becoming a ticker fund", () => {
  const query = "view=13f&managerCik=1747057&managerPeriod=2026-06-30&managerView=holdings";
  assert.deepEqual(entityFromRoute("/fund", new URLSearchParams(query)), {
    kind: "filer",
    ticker: manager.cik,
    fundPath: "/fund?view=13f&managerCik=0001747057&managerPeriod=2026-06-30&managerView=holdings",
  });
  for (const invalid of ["managerCik=1747057", "view=13f", "view=13f&managerCik=0",
    "view=13f&view=funds&managerCik=1747057", "view=13f&managerCik=1747057&managerCik=1",
    "view=13f&managerCik=SPY"]) {
    assert.equal(entityFromRoute("/fund", new URLSearchParams(invalid)), null, invalid);
  }
  assert.deepEqual(entityFromRoute("/fund/SPY", new URLSearchParams("view=13f&managerCik=1747057")),
    { ticker: "SPY", kind: "fund" });
});

test("13F manager context retains the selected period in Funds and opens evidence with its CIK", () => {
  const html = renderContext("../src/components/site/CompanyContext.tsx",
    "/fund?view=13f&managerCik=0001747057&managerPeriod=2026-06-30&managerView=changes");
  assert.match(html, /13F manager research/);
  assert.match(html, /CIK 0001747057/);
  assert.match(html, /href="\/fund\?view=13f&amp;managerCik=0001747057&amp;managerPeriod=2026-06-30&amp;managerView=changes"/);
  assert.match(html, /href="\/filings\/0001747057"/);
  assert.match(html, /href="\/disclosures\?tickers=0001747057&amp;mode=companies"/);
  assert.doesNotMatch(html, /Incorrect stale fund|Apple|href="\/(?:analysis|risk|fund\/)/);
});

test("primary navigation keeps manager research separate from company and N-PORT research", () => {
  const html = renderContext("../src/components/NavTabs.tsx", "/fund?view=13f&managerCik=0001747057");
  assert.match(html, /href="\/fund\?view=13f&amp;managerCik=0001747057"/);
  assert.match(html, /href="\/filings\/0001747057"/);
  assert.match(html, /href="\/disclosures\?tickers=0001747057&amp;mode=companies"/);
  for (const tool of ["analysis", "risk"]) assert.match(html, new RegExp(`href="/${tool}"`));
  assert.doesNotMatch(html, /href="\/(?:analysis|risk|fund\/)[^"]*0001747057/);
  const fundHtml = renderContext("../src/components/NavTabs.tsx", "/fund/SPY");
  assert.match(fundHtml, /href="\/fund\/SPY"/);
  assert.doesNotMatch(fundHtml, /managerCik=/);
});
