import test from "node:test";
import assert from "node:assert/strict";
import {
  SITE_TOOLS,
  safeInternalPath,
  entityFromRoute,
  companyToolPath,
  activeTool,
  normalizeCikIdentifier,
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
    "/compare/A,B,C,D,E,F,G,H,I,J,K,L,M",
    "/fund/SPY,AAPL",
    "/analysis/%",
    null,
    {},
  ]) {
    assert.equal(safeInternalPath(path), null, String(path));
  }
});

test("About replaces Guide navigation and preserves old bookmarked anchors", () => {
  assert.ok(SITE_TOOLS.some(tool => tool.id === "about" && tool.label === "About" && tool.href === "/about"));
  assert.ok(SITE_TOOLS.every(tool => tool.id !== "help" && tool.href !== "/help"));
  assert.equal(activeTool("/about"), "about");
  assert.equal(safeInternalPath("/help"), "/about");
  assert.equal(safeInternalPath("/help/#sources"), "/about#sources");
  assert.equal(safeInternalPath("/help?from=search#recovery"), "/about?from=search#recovery");
});

test("single-company peer-comparison starting views remain safe saved destinations", () => {
  assert.equal(safeInternalPath("/compare/JPM"), "/compare/JPM");
  assert.equal(
    safeInternalPath("/compare/jpm?basis=ttm&view=peers"),
    "/compare/JPM?basis=ttm&view=peers",
  );
  assert.equal(safeInternalPath("/compare/JPM,"), null);
  assert.equal(safeInternalPath("/compare/JPM,JPM"), null);
  assert.equal(safeInternalPath("/compare/A,B,C,D,E,F,G,H,I,J,K,L,M"), null);
});

test("twelve-company comparisons remain navigable through saved routes without dropping settings", () => {
  const path =
    "/compare/JPM,BAC,WFC,C,GS,MS,USB,PNC,TFC,COF,BK,STT?benchmark=peers&focus=JPM&view=benchmarks";
  assert.equal(safeInternalPath(path), path);
  assert.equal(
    safeInternalPath("/compare/A,B,C,D,E,F"),
    "/compare/A,B,C,D,E,F",
  );
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

test("query-derived issuer context matches page precedence and excludes ambiguous groups", () => {
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
    "company=JPMorgan%20Chase",
  ])
    assert.equal(
      entityFromRoute("/disclosures", new URLSearchParams(query)),
      null,
      query,
    );
});

test("CIK filing routes retain filer identity without creating stock research links", () => {
  assert.equal(normalizeCikIdentifier("1747057"), "0001747057");
  for (const invalid of ["0000000000", "12345678901", "D1", "-1", "1.2", null]) {
    assert.equal(normalizeCikIdentifier(invalid), null);
  }
  assert.deepEqual(entityFromRoute("/filings/1747057", null), {
    ticker: "0001747057", kind: "filer",
  });
  assert.equal(safeInternalPath("/filings/1747057?family=ownership#results"), "/filings/0001747057?family=ownership#results");
  assert.equal(companyToolPath("filings", "1747057"), "/filings/0001747057");
  assert.equal(companyToolPath("disclosures", "1747057"), "/disclosures?tickers=0001747057&mode=companies");
  for (const tool of ["analysis", "risk", "fund", "compare"]) {
    assert.equal(companyToolPath(tool, "0001747057"), null);
    assert.equal(entityFromRoute(`/${tool}/0001747057`, null), null);
    assert.equal(safeInternalPath(`/${tool}/0001747057`), null);
  }
  for (const invalid of ["/filings/0000000000", "/filings/12345678901", "/compare/JPM,0001747057"]) {
    assert.equal(safeInternalPath(invalid), null);
    assert.equal(entityFromRoute(invalid, null), null);
  }
});

test("disclosure CIK context stays explicit even for a listed company", () => {
  for (const key of ["tickers", "focus", "ticker", "cik", "company"]) {
    assert.deepEqual(entityFromRoute("/disclosures", new URLSearchParams(`${key}=19617`)), {
      ticker: "0000019617", kind: "filer",
    });
  }
  assert.equal(entityFromRoute("/risk", new URLSearchParams("ticker=0000019617")), null);
  assert.equal(entityFromRoute("/disclosures", new URLSearchParams("cik=19617&cik=1747057")), null);
  assert.equal(entityFromRoute("/disclosures", new URLSearchParams("tickers=JPM,BAC&cik=1747057")), null);
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
