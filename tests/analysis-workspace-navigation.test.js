import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = dirname(fileURLToPath(import.meta.url));
function loadComponent(file, workspace) {
  const path = resolve(root, file);
  const localRequire = createRequire(path);
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name.endsWith(".css")) return {};
    if (name === "next/dynamic") return () => () => null;
    if (name === "next/link") return function Link({ prefetch: _prefetch, ...props }) { return createElement("a", props); };
    if (name.endsWith("/WorkspaceProvider")) return { useWorkspace: () => workspace };
    if (name.endsWith("/CompanySearch")) return function CompanySearch() { return createElement("input", { "aria-label": "Switch company" }); };
    if (name.startsWith(".")) {
      for (const extension of [".tsx", ".ts"]) {
        const candidate = resolve(dirname(path), `${name}${extension}`);
        if (existsSync(candidate)) return loadComponent(candidate, workspace);
      }
    }
    return localRequire(name);
  }, testModule, testModule.exports);
  return testModule.exports.default;
}

test("Analysis opens retired saved views on Overview while retaining saved scenarios and research records", () => {
  const company = {
    notes: "Existing private research",
    evidence: [{ label: "Previously collected source", text: "Keep this record" }],
    analysisRules: [{ id: "old-rule", threshold: 12 }],
    analysisScenarios: [{ id: "saved-case", name: "Revenue case" }],
    analysisViews: [{ name: "Saved quarter review", settings: { view: "notebook", basis: "quarter" }, savedAt: "2026-01-01" }],
  };
  const before = JSON.stringify(company);
  const workspace = {
    ready: true,
    error: "",
    data: { companies: { AAPL: company } },
    update: () => assert.fail("Opening a view must not modify saved research"),
  };
  const Workspace = loadComponent("../src/app/analysis/[ticker]/AnalysisWorkspace.tsx", workspace);
  for (const view of ["notebook", "extended"]) {
    const html = renderToStaticMarkup(createElement(Workspace, {
      urlTicker: "AAPL", preloadedCompanyName: "Apple Inc.", cftcEnabled: true,
      initialSettings: { view, basis: "quarter" },
    }));
    assert.match(html, /aria-pressed="true">Overview/);
    assert.match(html, /value="quarter" selected=""/);
    assert.match(html, /CFTC context/);
    assert.match(html, /Scenarios/);
    assert.match(html, /Saved quarter review/);
    assert.match(html, /aria-label="Saved financial views"/);
    assert.doesNotMatch(html, /Notebook|More research|Personal financial thresholds|Existing private research|Keep this record/);
  }
  assert.equal(JSON.stringify(company), before);
});

test("the home research workflow leads to active Analysis statements and evidence views", () => {
  const ResearchWorkflow = loadComponent("../src/components/site/ResearchWorkflow.tsx");
  const html = renderToStaticMarkup(createElement(ResearchWorkflow));
  assert.match(html, /href="\/analysis\/JPM\?view=statements"/);
  assert.match(html, /href="\/risk\?ticker=JPM"/);
  assert.match(html, /href="\/analysis\/JPM\?view=checks"/);
  assert.match(html, /Verify the financial evidence/);
  assert.doesNotMatch(html, /view=notebook|view=extended|Save notes|Save the review baseline/);
});
