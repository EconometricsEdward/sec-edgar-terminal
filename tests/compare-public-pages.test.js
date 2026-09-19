import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as publicMetadata from "../src/utils/comparePublicMetadata.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function fixture() {
  const clientProps = [];
  function compile(path) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const testModule = { exports: {} };
    new Function("require", "module", "exports", compiled)(name => {
      if (name === "react/jsx-runtime") return require(name);
      if (name === "next/navigation") return { notFound: () => { throw new Error("NOT_FOUND"); } };
      if (name.endsWith("/siteMetadata")) return { buildPageMetadata: value => ({
        ...value, alternates: { canonical: `https://secedgarterminal.com${value.path}` },
      }) };
      if (name.endsWith("/comparePublicMetadata.js")) return publicMetadata;
      if (name.endsWith("/CompareGuide")) return compile("../src/app/compare/CompareGuide.tsx");
      if (name.endsWith("/CompareClient")) return function CompareClient(props) {
        clientProps.push(props); return createElement("div", { "data-peer-workspace": props.initialTickers.join(",") });
      };
      if (name.endsWith(".css")) return new Proxy({}, { get: (_target, key) => key === "__esModule" ? false : String(key) });
      throw new Error(`Unexpected request or page dependency: ${name}`);
    }, testModule, testModule.exports);
    return testModule.exports;
  }
  return { compile, clientProps };
}

test("comparison routes preserve peer order and normalize case without dropping invalid peers", () => {
  assert.deepEqual(publicMetadata.comparePageSelection(" msft,aapl,MSFT ").tickers, ["MSFT", "AAPL"]);
  assert.equal(publicMetadata.comparePageSelection(" msft,aapl ").path, "/compare/MSFT,AAPL");
  for (const raw of ["", "AAPL,", "JPM,,BAC", "AAPL/<script>", "AAPL;MSFT", "JPM,0001747057", "AAPL,%2f", "A,B,C,D,E,F,G,H,I,J,K,L,M"]) {
    assert.equal(publicMetadata.comparePageSelection(raw), null, raw);
  }
  assert.equal(publicMetadata.comparePageSelection("F,V,BRK.B,BRK-B").path, "/compare/F,V,BRK.B,BRK-B");
});

test("only featured default comparisons are indexed; custom views retain clean self-canonicals", async () => {
  const { comparePageSelection, comparePageMetadata, FEATURED_COMPARE_GROUPS } = publicMetadata;
  for (const group of FEATURED_COMPARE_GROUPS) {
    const selection = comparePageSelection(group.tickers);
    assert.equal(comparePageMetadata(selection).index, true);
    for (const query of [{ basis: "quarter" }, { asOf: "2025-12-31" }, { view: "notebook" }, { view: ["table", "map"] }]) {
      const metadata = comparePageMetadata(selection, query);
      assert.equal(metadata.index, false);
      assert.equal(metadata.path, `/compare/${group.tickers}`);
    }
  }
  for (const tickers of ["AAPL,MSFT", "XYZNOTKNOWN", "F,V"]) {
    const metadata = comparePageMetadata(comparePageSelection(tickers));
    assert.equal(metadata.index, false);
    assert.equal(metadata.path, `/compare/${tickers}`);
    assert.doesNotMatch(metadata.description, /10 (?:years|fiscal years)/);
  }
});

test("metadata and the initial workspace require no SEC or storage request", async () => {
  const f = fixture();
  const page = f.compile("../src/app/compare/[tickers]/page.tsx");
  const props = { params: Promise.resolve({ tickers: "msft,aapl" }), searchParams: Promise.resolve({ basis: "quarter" }) };
  const metadata = await page.generateMetadata(props);
  assert.equal(metadata.alternates.canonical, "https://secedgarterminal.com/compare/MSFT,AAPL");
  assert.equal(metadata.robots.index, false);
  assert.equal(metadata.robots.follow, true);
  assert.match(metadata.title, /MSFT vs AAPL/);
  renderToStaticMarkup(await page.default(props));
  assert.deepEqual(f.clientProps[0], { initialTickers: ["MSFT", "AAPL"], preloadedCompanies: [] });
});

test("invalid routes are unavailable rather than silently changing a comparison", async () => {
  const page = fixture().compile("../src/app/compare/[tickers]/page.tsx");
  const props = { params: Promise.resolve({ tickers: "AAPL,INVALID!" }), searchParams: Promise.resolve({}) };
  await assert.rejects(() => page.default(props), /NOT_FOUND/);
  assert.equal((await page.generateMetadata(props)).robots.index, false);
});

test("comparison guide renders native disclosure and ordinary links without JavaScript or financial acquisition", () => {
  const Guide = fixture().compile("../src/app/compare/CompareGuide.tsx").default;
  const html = renderToStaticMarkup(createElement(Guide, { tickers: ["JPM", "BAC"] }));
  assert.match(html, /<details[^>]*><summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen[= >]/);
  assert.match(html, /unavailable figure is a coverage gap, not zero/);
  for (const ticker of ["JPM", "BAC"]) {
    assert.ok(html.includes(`href="/analysis/${ticker}"`));
    assert.ok(html.includes(`href="/filings/${ticker}"`));
  }
  for (const group of publicMetadata.FEATURED_COMPARE_GROUPS) {
    assert.ok(html.includes(`href="/compare/${group.tickers}"`));
  }
  assert.doesNotMatch(html, /notebook|collection/i);
});
