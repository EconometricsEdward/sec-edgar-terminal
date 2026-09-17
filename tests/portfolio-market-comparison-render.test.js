import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const path = fileURLToPath(
  new URL(
    "../src/app/workspace/portfolio/PortfolioMarketComparison.tsx",
    import.meta.url,
  ),
);
const require = createRequire(path);
const ts = require("typescript");
const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const testModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  (name) => name.endsWith(".css") ? { default: {} } : require(name),
  testModule,
  testModule.exports,
);
const Component = testModule.exports.default;

const market = {
  key: "disaggregated:085692:managed_money",
  family: "disaggregated",
  contract: "085692",
  group: "managed_money",
  groupLabel: "Managed Money",
  label: "Copper",
  count: 2,
  allocationPct: 0,
  sectorCount: 1,
};
const summary = {
  netPctOi: 0,
  weeklyChangePp: 0,
  priorDate: "2026-09-01",
  reportDate: "2026-09-08",
  range: {
    min: -5,
    max: 5,
    position: 50,
    count: 3,
    start: "2026-08-25",
    end: "2026-09-08",
  },
  observationCount: 3,
  historyStart: "2026-08-25",
  historyEnd: "2026-09-08",
  stale: false,
  incomplete: false,
};

function render(overrides = {}) {
  const html = renderToStaticMarkup(createElement(Component, {
    markets: [market],
    allocationAvailable: true,
    eligibleCompanies: 3,
    basis: "companies",
    selectedKey: market.key,
    onSelect() {},
    summaries: { [market.key]: { status: "ready", summary } },
    loading: false,
    onRetry() {},
    ...overrides,
  }));
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  return html;
}

test("market comparison preserves zero net positioning, weekly change, and allocation", () => {
  const html = render();
  assert.match(html, />0%<\/strong>/);
  assert.match(html, />0 pp<\/span>/);
  assert.match(html, />0% allocation<\/span>/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /role="table"/);
  assert.match(html, /Sep 8, 2026/);
});

test("short observed histories always disclose their actual dates and count", () => {
  const html = render();
  assert.match(html, /3 observations/);
  assert.match(html, /Aug 25, 2026 – Sep 8, 2026/);
  assert.match(html, /not a percentile or a prediction/);
  assert.doesNotMatch(html, />Partial history<\/span>/);
});

test("missing weekly data and a flat range are not displayed as zero changes or a midpoint", () => {
  const html = render({
    summaries: {
      [market.key]: {
        status: "ready",
        summary: {
          ...summary,
          weeklyChangePp: null,
          priorDate: null,
          incomplete: true,
          range: { ...summary.range, min: 0, max: 0, position: null },
        },
      },
    },
  });
  assert.match(html, /Weekly change unavailable/);
  assert.doesNotMatch(html, />0 pp</);
  assert.match(html, /No distinct range location/);
  assert.match(html, />Partial history<\/span>/);
});

test("unweighted portfolios retain holding counts without implying allocation", () => {
  const html = render({ allocationAvailable: false, markets: [{ ...market, allocationPct: 80 }] });
  assert.match(html, /Allocation unavailable/);
  assert.doesNotMatch(html, /80% allocation|80 percent allocation|Linked allocation/);
  assert.match(html, /2 linked holdings/);
});

test("CFTC failures and loading keep the SEC connection selection available", () => {
  const unavailable = render({
    summaries: { [market.key]: { status: "unavailable", summary: null } },
  });
  assert.match(unavailable, /Unavailable/);
  assert.match(unavailable, /Retry CFTC/);
  assert.match(unavailable, /<button[^>]*aria-label="Review Copper, Managed Money: 2 linked holdings/);
  assert.match(unavailable, /aria-pressed="true"/);
  const pending = render({ summaries: {}, loading: true });
  assert.match(pending, /Loading…/);
  assert.doesNotMatch(pending, /Retry CFTC/);
  assert.match(pending, /aria-label="Review Copper/);
});

test("older ready snapshots offer an update action without hiding their available figures", () => {
  const html = render({
    summaries: {
      [market.key]: { status: "ready", summary: { ...summary, stale: true, ageDays: 10 } },
    },
  });
  assert.match(html, /Older snapshot/);
  assert.match(html, /Check updates/);
  assert.match(html, />0%<\/strong>/);
});
