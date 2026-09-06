import test from "node:test";
import assert from "node:assert/strict";
import {
  SITE_TOOLS,
  safeInternalPath,
  entityFromRoute,
  companyToolPath,
  activeTool,
} from "../src/utils/siteRoutes.js";

test("saved routes preserve research settings and canonical company symbols", () => {
  assert.equal(
    safeInternalPath("/analysis/jpm?basis=ytd&view=drivers#capital"),
    "/analysis/JPM?basis=ytd&view=drivers#capital",
  );
  assert.equal(
    safeInternalPath("/compare/BRK-B,JPM?basis=ttm"),
    "/compare/BRK-B,JPM?basis=ttm",
  );
  assert.equal(
    safeInternalPath("/disclosures?query=liquidity%20AND%20waiver&tickers=JPM"),
    "/disclosures?query=liquidity%20AND%20waiver&tickers=JPM",
  );
  for (const tool of SITE_TOOLS)
    assert.equal(safeInternalPath(tool.href), tool.href);
});

test("saved routes reject script, external, encoded-separator and invalid research destinations", () => {
  for (const path of [
    "javascript:alert(1)",
    "https://example.org",
    "//example.org",
    "/\\example.org",
    "/analysis/JPM\n",
    "/api/health",
    "/analysis/JPM/other",
    "/analysis/%2f%2fevil.test",
    "/analysis/%252fJPM",
    "/analysis/../about",
    "/analysis/%2e%2e/about",
    "/compare/JPM,JPM",
    "/compare/A,B,C,D,E,F",
    "/fund/SPY,AAPL",
    "/analysis/%",
    null,
    {},
  ]) {
    assert.equal(safeInternalPath(path), null, String(path));
  }
});

test("single-company peer-comparison starting views remain safe saved destinations", () => {
  assert.equal(safeInternalPath("/compare/JPM"), "/compare/JPM");
  assert.equal(
    safeInternalPath("/compare/jpm?basis=ttm&view=peers"),
    "/compare/JPM?basis=ttm&view=peers",
  );
  assert.equal(safeInternalPath("/compare/JPM,"), null);
  assert.equal(safeInternalPath("/compare/JPM,JPM"), null);
  assert.equal(safeInternalPath("/compare/A,B,C,D,E,F"), null);
});

test("company identity follows the exact route and never picks a peer or a stale entity", () => {
  assert.deepEqual(
    entityFromRoute("/analysis/jpm", new URLSearchParams("ticker=AMJB")),
    { ticker: "JPM", kind: "company" },
  );
  assert.deepEqual(entityFromRoute("/filings/BRK-B", null), {
    ticker: "BRK-B",
    kind: "company",
  });
  assert.deepEqual(entityFromRoute("/fund/SPY", null), {
    ticker: "SPY",
    kind: "fund",
  });
  for (const path of [
    "/compare/JPM,BAC",
    "/analysis",
    "/",
    "/workspace",
    "/analysis/JPM/BAC",
    "/filings/JPM,BAC",
  ])
    assert.equal(entityFromRoute(path, null), null);
});

test("query-derived issuer context matches page precedence and excludes groups and CIKs", () => {
  assert.deepEqual(
    entityFromRoute("/risk", new URLSearchParams("ticker=JPM&symbol=BAC")),
    { ticker: "JPM", kind: "company" },
  );
  assert.deepEqual(
    entityFromRoute("/risk", new URLSearchParams("symbol=brk-b")),
    { ticker: "BRK-B", kind: "company" },
  );
  assert.deepEqual(
    entityFromRoute(
      "/disclosures",
      new URLSearchParams("tickers=JPM&focus=BAC"),
    ),
    { ticker: "JPM", kind: "company" },
  );
  for (const query of [
    "tickers=JPM,BAC",
    "tickers=JPM%20BAC",
    "tickers=JPM&tickers=BAC",
    "cik=0000019617",
    "company=0000019617",
    "company=JPMorgan%20Chase",
  ])
    assert.equal(
      entityFromRoute("/disclosures", new URLSearchParams(query)),
      null,
      query,
    );
});

test("company tool links retain the requested ticker and do not manufacture peer groups", () => {
  assert.equal(companyToolPath("analysis", "jpm"), "/analysis/JPM");
  assert.equal(companyToolPath("risk", "JPM"), "/risk?ticker=JPM");
  assert.equal(
    companyToolPath("disclosures", "JPM"),
    "/disclosures?tickers=JPM&mode=companies",
  );
  assert.equal(companyToolPath("compare", "JPM"), null);
  assert.equal(companyToolPath("analysis", "JPM,BAC"), null);
  assert.equal(activeTool("/filings/JPM"), "filings");
  assert.equal(activeTool("/analysis-other"), null);
});
