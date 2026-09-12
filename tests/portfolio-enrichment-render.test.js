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
test("full-catalog peer currency differences retain currency units and compact display", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioFinancialTools.tsx",
  ).default;
  const catalog = buildCatalogReport(report, companies);
  const html = renderToStaticMarkup(
    createElement(Component, {
      report: {
        ...catalog,
        metrics: catalog.metrics.filter((metric) => metric.id === "revenue"),
      },
      view: "peers",
      onInspectCompany: () => {},
    }),
  );
  assert.match(html, /B USD/);
  assert.doesNotMatch(html, /[0-9,] x|percentage points/);
});

test("briefing renders all sector links and dated classification coverage", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioBriefing.tsx",
  ).default;
  const html = renderToStaticMarkup(
    createElement(Component, {
      report,
      onNavigate: () => {},
      onInspectCompany: () => {},
      onExploreGroup: () => {},
    }),
  );
  assert.match(html, /100 of 100 companies covered/);
  assert.match(html, /Fund-reported sectors/);
  assert.match(html, /2026-09-08/);
  assert.match(html, /aria-label="Explore Information Technology"/);
  assert.match(html, /aria-label="Explore Real Estate"/);
  assert.equal((html.match(/aria-label="Explore /g) || []).length, 11);
  assert.doesNotMatch(html, /Other groups|NaN|Infinity|undefined/);
});

test("metric rankings expose measured sector peers and a bounded first page", () => {
  const Component = component(
    "../src/app/workspace/portfolio/PortfolioMetricExplorer.tsx",
  ).default;
  const html = renderToStaticMarkup(
    createElement(Component, {
      report,
      companies,
      onInspect: () => {},
    }),
  );
  assert.match(html, /Information Technology/);
  assert.match(html, /Real Estate/);
  assert.match(html, /Financial ratios/);
  assert.doesNotMatch(html, /Business model|All business models/);
  assert.match(html, /Find a company in this ranking/);
  assert.match(html, /Page 1 of 4/);
  assert.equal((html.match(/aria-label="Compare /g) || []).length, 25);
  assert.match(
    html,
    /<th scope="col">Compare<\/th><th scope="col">Company<\/th>/,
  );
});

test("metric explanations retain negative values, complete periods and validated SEC evidence", () => {
  const Component = component(
    "../src/app/workspace/portfolio/MetricEvidenceDialog.tsx",
  ).default;
  const html = renderToStaticMarkup(
    createElement(Component, {
      inspector: {
        issuer: {
          ticker: "TEST",
          name: "Test Company",
          lens: "corporate",
          cik: "1234",
          company: { retrievedAt: "2026-09-11T12:00:00Z" },
        },
        key: "netMargin",
        point: {
          value: -5,
          unit: "%",
          classification: "calculated",
          formula: "Net income / revenue × 100",
          period: { kind: "annual", start: "2025-01-01", end: "2025-12-31" },
          sources: [
            {
              documentUrl: "https://www.sec.gov/Archives/edgar/data/1234/annual.htm",
              tag: "NetIncomeLoss",
            },
            { documentUrl: "javascript:alert(1)", tag: "Unsafe source" },
          ],
        },
      },
      onClose: () => {},
    }),
  );
  assert.match(html, /-5%/);
  assert.match(html, /2025-01-01 to 2025-12-31/);
  assert.match(html, /2026-09-11T12:00:00Z/);
  assert.match(
    html,
    /href="https:\/\/www.sec.gov\/Archives\/edgar\/data\/1234\/annual.htm"/,
  );
  assert.doesNotMatch(html, /javascript:|Unsafe source|\bissuer\b/i);
});
