import test from "node:test";
import assert from "node:assert/strict";
import {
  parseHubLocation,
  hubDestination,
} from "../src/utils/researchHubNavigation.js";
test("Hub navigation preserves existing deep links and adds an overview default", () => {
  assert.equal(parseHubLocation("/workspace").view, "overview");
  assert.equal(parseHubLocation("/workspace#research-vault").view, "library");
  assert.deepEqual(
    parseHubLocation(
      "/workspace?view=portfolios&portfolio=portfolio-123&row=row-2",
    ),
    {
      view: "portfolios",
      portfolioId: "portfolio-123",
      rowId: "row-2",
      briefId: "",
      portfolioViewId: "",
    },
  );
  assert.equal(
    parseHubLocation("/workspace?view=briefs&brief=brief-1").briefId,
    "brief-1",
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
    "/workspace?view=briefs&brief=brief-1",
  );
  assert.equal(
    hubDestination("library", {
      portfolioId: "portfolio-1",
      briefId: "brief-1",
    }),
    "/workspace?view=library",
  );
  assert.equal(
    hubDestination("bad", { portfolioId: "<script>" }),
    "/workspace?view=overview",
  );
});
