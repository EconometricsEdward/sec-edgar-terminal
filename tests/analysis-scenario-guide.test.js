import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { entityFromRoute, safeInternalPath } from "../src/utils/siteRoutes.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function compile(path, dependencies = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name in dependencies) return dependencies[name];
    if (name === "react/jsx-runtime") return require(name);
    if (name === "next/link") return function Link({ prefetch: _prefetch, ...props }) { return createElement("a", props); };
    if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
    if (name.endsWith("/siteMetadata")) return compile("../src/utils/siteMetadata.ts");
    if (name.endsWith(".css")) return new Proxy({}, { get: (_target, key) => key === "__esModule" ? false : String(key) });
    throw new Error(`Unexpected data or client dependency in static methodology: ${name}`);
  }, testModule, testModule.exports);
  return testModule.exports;
}

test("scenario methodology is complete initial HTML with canonical article metadata and no financial acquisition", () => {
  const page = compile("../src/app/analysis/scenarios/page.tsx");
  const html = renderToStaticMarkup(page.default());
  assert.equal(page.metadata.alternates.canonical, "https://secedgarterminal.com/analysis/scenarios");
  assert.equal(page.metadata.openGraph.url, page.metadata.alternates.canonical);
  assert.equal(page.metadata.robots, undefined);
  const article = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
  assert.equal(article["@type"], "TechArticle");
  assert.equal(article.url, page.metadata.alternates.canonical);
  assert.equal(article.isAccessibleForFree, true);
  for (const id of ["baseline", "operating", "connected-model", "history", "drivers", "new-filings"]) {
    assert.ok(html.includes(`href="#${id}"`), `navigation exposes ${id}`);
    assert.ok(html.includes(`id="${id}"`), `initial HTML contains ${id}`);
  }
  assert.match(html, /same-period counterfactual, not a forecast/);
  assert.match(html, /hypothetical CFO = reported CFO \+ Δearnings/);
  assert.match(html, /never adds the entire reported CFO to an ending cash balance/);
  assert.match(html, /no assumed tax refund/);
  assert.match(html, /funding shortfall/);
  assert.match(html, /CFTC Commitments of Traders/);
  assert.match(html, /href="\/analysis\/AAPL\?view=scenarios"/);
  assert.match(html, /href="\/analysis\/JPM\?view=scenarios"/);
  assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")|NaN|undefined/);
});

test("scenario methodology is a guide route, never an invented SCENARIOS company", () => {
  assert.equal(entityFromRoute("/analysis/scenarios", new URLSearchParams("ticker=AAPL")), null);
  assert.equal(entityFromRoute("/analysis/scenarios/", null), null);
  assert.equal(safeInternalPath("/analysis/scenarios#connected-model"), "/analysis/scenarios#connected-model");
  assert.deepEqual(entityFromRoute("/analysis/AAPL", null), { ticker: "AAPL", kind: "company" });
});

test("sitemap and machine guidance discover one public guide without indexing scenario assumption variants", async () => {
  const sitemap = compile("../src/app/sitemap.ts", {
    "../utils/fundResearch": { FUND_CATALOG: [] },
    "../utils/fundPublicSelectors.js": { PUBLIC_FUND_MANAGERS: [] },
    "../utils/secCoverageRegistry.js": { loadSecCoverageRegistry: async () => {}, getActiveSecCoverageCompanies: () => [] },
  });
  const entries = await sitemap.default();
  assert.equal(entries.filter(entry => entry.url === "https://secedgarterminal.com/analysis/scenarios").length, 1);
  assert.ok(entries.every(entry => !entry.url.includes("view=scenarios") && !entry.url.includes("scenarioRevenue=")));
  const guidance = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
  assert.match(guidance, /\[Company scenario methodology\]\(https:\/\/secedgarterminal\.com\/analysis\/scenarios\)/);
  assert.match(guidance, /remain noindex interactive selections/);
  assert.match(guidance, /not personal scenario settings or modeled outputs/);
});
