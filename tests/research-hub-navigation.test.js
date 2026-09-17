import test from "node:test";
import assert from "node:assert/strict";
import {
  HUB_VIEWS,
  parseHubLocation,
  hubDestination,
  normalizePortfolioDestination,
} from "../src/utils/researchHubNavigation.js";
test("Hub navigation preserves existing deep links and adds an overview default", () => {
  assert.equal(parseHubLocation("/workspace").view, "overview");
  assert.equal(parseHubLocation("/workspace#research-vault").view, "overview");
  assert.deepEqual(
    parseHubLocation(
      "/workspace?view=portfolios&portfolio=portfolio-123&row=row-2",
    ),
    {
      view: "portfolios",
      portfolioId: "portfolio-123",
      rowId: "row-2",
      portfolioViewId: "",
      portfolioTab: "",
      analyticsArea: "",
      holdingsMode: "",
    },
  );
  assert.equal(
    parseHubLocation("/workspace?view=briefs&brief=brief-1").view,
    "overview",
  );
});

test("portfolio analytics routes preserve a valid tab without leaking scenario inputs", () => {
  const url = hubDestination("portfolios", {
    portfolioId: "portfolio-1",
    portfolioTab: "analytics",
    shock: -30,
  });
  assert.equal(
    url,
    "/workspace?view=portfolios&portfolio=portfolio-1&portfolioTab=analytics",
  );
  assert.equal(parseHubLocation(url).portfolioTab, "analytics");
  assert.equal(
    parseHubLocation("/workspace?portfolioTab=unexpected").portfolioTab,
    "",
  );
  assert.equal(
    hubDestination("library", { portfolioTab: "analytics" }),
    "/workspace?view=overview",
  );
});
test("Hub routes include only valid local identifiers, never draft or allocation data", () => {
  assert.equal(
    hubDestination("briefs", {
      briefId: "brief-1",
      question: "private",
      notes: "secret",
      weight: 80,
    }),
    "/workspace?view=overview",
  );
  assert.equal(
    hubDestination("library", {
      portfolioId: "portfolio-1",
      briefId: "brief-1",
    }),
    "/workspace?view=overview",
  );
  assert.equal(
    hubDestination("bad", { portfolioId: "<script>" }),
    "/workspace?view=overview",
  );
});

test("analysis areas round-trip safely and ignore private inputs", () => {
  const url = hubDestination("portfolios", {
    portfolioId: "p-1",
    portfolioTab: "analytics",
    analyticsArea: "financial",
    shock: -25,
    notes: "private",
  });
  assert.equal(parseHubLocation(url).analyticsArea, "financial");
  assert.ok(!url.includes("private") && !url.includes("shock"));
  assert.equal(
    parseHubLocation("/workspace?analyticsArea=unexpected").analyticsArea,
    "",
  );
  assert.equal(
    hubDestination("library", { analyticsArea: "scenario" }),
    "/workspace?view=overview",
  );
});


test("Hub offers exactly two sections and retired bookmarks cannot reopen removed screens", () => {
  assert.deepEqual(HUB_VIEWS, [["overview", "Overview"], ["portfolios", "Portfolio research"]]);
  for (const view of ["inbox", "briefs", "watchlist", "library"]) {
    const legacy = parseHubLocation(`/workspace?view=${view}&brief=old-brief`);
    assert.equal(legacy.view, "overview");
    assert.equal("briefId" in legacy, false);
    assert.equal(hubDestination(view, { briefId: "old-brief" }), "/workspace?view=overview");
    assert.equal(parseHubLocation(`/workspace?view=${view}&portfolio=p-1`).view, "portfolios");
  }
});


test("five-page destinations preserve each selected portfolio view", () => {
  for (const destination of [
    { portfolioTab: "analytics", analyticsArea: "overview" },
    { portfolioTab: "research", holdingsMode: "all" },
    { portfolioTab: "analytics", analyticsArea: "financial" },
    { portfolioTab: "analytics", analyticsArea: "concentration" },
    { portfolioTab: "changes" },
  ]) {
    const route = parseHubLocation(hubDestination("portfolios", { portfolioId: "p-1", ...destination }));
    assert.equal(route.view, "portfolios");
    assert.equal(route.portfolioId, "p-1");
    for (const [key, value] of Object.entries(destination)) assert.equal(route[key], value);
  }
});

test("retired analytics bookmarks open the relevant consolidated page", () => {
  const cases = [
    ["metrics", { portfolioTab: "analytics", analyticsArea: "financial", holdingsMode: "" }],
    ["screener", { portfolioTab: "research", analyticsArea: "", holdingsMode: "screen" }],
    ["scenario", { portfolioTab: "analytics", analyticsArea: "overview", holdingsMode: "" }],
  ];
  for (const [legacy, expected] of cases) {
    assert.deepEqual(normalizePortfolioDestination({ portfolioTab: "analytics", analyticsArea: legacy }), expected);
    const parsed = parseHubLocation(`/workspace?view=portfolios&portfolioTab=analytics&analyticsArea=${legacy}`);
    for (const [key, value] of Object.entries(expected)) assert.equal(parsed[key], value);
    assert.equal(hubDestination("portfolios", { portfolioTab: "analytics", analyticsArea: legacy }),
      hubDestination("portfolios", expected));
  }
});

test("explicit nonanalytics pages take precedence over retired analytic parameters", () => {
  const route = normalizePortfolioDestination({ portfolioTab: "changes", analyticsArea: "screener", holdingsMode: "screen" });
  assert.deepEqual(route, { portfolioTab: "changes", analyticsArea: "", holdingsMode: "" });
  assert.deepEqual(normalizePortfolioDestination({ portfolioTab: "research", holdingsMode: "invalid" }),
    { portfolioTab: "research", analyticsArea: "", holdingsMode: "" });
});

test("holdings screens and evidence utilities remain addressable without serializing criteria", () => {
  const url = hubDestination("portfolios", { portfolioTab: "research", holdingsMode: "screen", criteria: "private" });
  assert.equal(url, "/workspace?view=portfolios&portfolioTab=research&holdingsMode=screen");
  assert.equal(parseHubLocation(url).holdingsMode, "screen");
  assert.equal(parseHubLocation(hubDestination("portfolios", { portfolioTab: "analytics", analyticsArea: "coverage" })).analyticsArea, "coverage");
});
