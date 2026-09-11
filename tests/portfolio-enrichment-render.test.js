import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoPortfolio } from "../src/utils/portfolioDemo.js";
import { unpackPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import { buildCatalogReport } from "../src/utils/portfolioEnrichment.js";
const require = createRequire(import.meta.url),
  ts = require("typescript");
function component(file) {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), file),
    localRequire = createRequire(path);
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const testModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name) => {
      if (name.endsWith(".css")) return {};
      if (name.endsWith("download.js")) return { downloadText: () => {} };
      if (
        name.startsWith(".") &&
        existsSync(resolve(dirname(path), `${name}.tsx`))
      )
        return component(resolve(dirname(path), `${name}.tsx`));
      return localRequire(name);
    },
    testModule,
    testModule.exports,
  );
  return testModule.exports;
}
const demo = JSON.parse(
  readFileSync(
    new URL(
      "../public/portfolio/portfolio-demo-100-results.json",
      import.meta.url,
    ),
  ),
);
const doc = createDemoPortfolio(demo),
  companies = unpackPortfolioSnapshot(doc.snapshot).companies;
const report = buildPortfolioAnalytics(doc.rows, doc.allocation, companies, {
  capturedAt: demo.captured_at,
});
test("all five evidence-backed analysis views render actual demo results without invalid values", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioInsightTools.tsx",
  ).default;
  for (const view of [
    "weighted",
    "buffers",
    "overlap",
    "impact",
    "operating",
  ]) {
    const html = renderToStaticMarkup(
      createElement(Component, {
        report,
        companies,
        view,
        onInspect: () => {},
      }),
    );
    assert.match(html, /<table>/);
    assert.doesNotMatch(html, /NaN|Infinity|undefined/);
    assert.match(html, /Export this analysis/);
  }
});
test("expanded screener disclosure controls remain outside native select elements", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioScreener.tsx",
  ).default;
  const html = renderToStaticMarkup(
    createElement(Component, {
      report: buildCatalogReport(report, companies),
      companies,
      onInspectCompany: () => {},
      onDisclosure: () => {},
    }),
  );
  assert.match(html, /Search matching companies/);
  for (const select of html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/g))
    assert.doesNotMatch(select[1], /<(?:p|div|details|button|input)\b/);
});
test("multiple-shock and rebalancing workbenches render usable initial allocations", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioScenarioWorkbench.tsx",
  ).default;
  for (const view of ["mixed", "rebalance"]) {
    const html = renderToStaticMarkup(
      createElement(Component, {
        report,
        rows: doc.rows,
        settings: doc.allocation,
        companies,
        view,
        onInspect: () => {},
      }),
    );
    assert.match(html, /<table>/);
    assert.doesNotMatch(html, /NaN|Infinity|undefined/);
    assert.match(html, /100/);
  }
});
