import test from "node:test";
import assert from "node:assert/strict";
import {
  companyReview,
  consolidatedWatchlist,
  parseFundShelf,
  toggleFundShelf,
  removeFundFromShelf,
  summarizeWorkspaceFilings,
} from "../src/utils/workspaceReview.js";

test("current Analysis review takes precedence without mixing legacy metric baselines", () => {
  const review = companyReview({
    analysisBaseline: {
      basis: "ytd",
      period: { end: "2026-06-30" },
      asOf: "2026-08-01",
    },
    analysisReviewedAt: "2026-08-02T10:00:00Z",
    baseline: { period: { kind: "annual", end: "2024-12-31" } },
    reviewedAt: "2025-01-01",
  });
  assert.equal(review.kind, "analysis");
  assert.equal(review.basis, "ytd");
  assert.equal(review.reviewedAt, "2026-08-02T10:00:00Z");
  assert.equal(
    companyReview({
      baseline: { period: { kind: "annual" } },
      reviewedAt: "invalid",
    }).reviewedAt,
    "",
  );
});
test("watchlist combines company sources and keeps funds classified separately", () => {
  const rows = consolidatedWatchlist(
    {
      companies: {
        JPM: { ticker: "JPM", saved: true },
        AAPL: { ticker: "AAPL", saved: false },
      },
    },
    { watchlist: ["JPM", "MSFT"] },
    ["VOO"],
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find((r) => r.ticker === "JPM").sources, [
    "Workspace",
    "Market",
  ]);
  assert.equal(rows.find((r) => r.ticker === "VOO").kind, "fund");
});
test("fund shelf uses fresh reads, rejects corruption and never reports a failed write as saved", () => {
  let raw = '["VOO"]';
  const storage = {
    getItem: () => raw,
    setItem: (_, next) => {
      raw = next;
    },
  };
  assert.deepEqual(toggleFundShelf(storage, "SPY"), ["VOO", "SPY"]);
  raw = '["VOO","VTI"]';
  assert.deepEqual(toggleFundShelf(storage, "SPY"), ["VOO", "VTI", "SPY"]);
  assert.throws(
    () =>
      toggleFundShelf(
        {
          ...storage,
          setItem: () => {
            throw Error("quota");
          },
        },
        "IBIT",
      ),
    /quota/,
  );
  assert.throws(() => parseFundShelf('{"oops":[]}'));
  assert.throws(() => parseFundShelf('["<script>"]'));
});
test("filing checks distinguish strictly later filings, same-day uncertainty and unloaded archives", () => {
  const company = {
    ticker: "JPM",
    filings: [
      { form: "10-Q", filingDate: "2026-08-04" },
      { form: "8-K", filingDate: "2026-08-03" },
      { form: "4", filingDate: "2026-08-05" },
    ],
    archives: [{ filingTo: "2026-08-04" }],
  };
  const result = summarizeWorkspaceFilings(company, "2026-08-03");
  assert.equal(result.count, 1);
  assert.equal(result.sameDay, 1);
  assert.equal(result.coverage.completeSinceReview, false);
  assert.equal(result.coverage.archiveOverlap, true);
  assert.equal(summarizeWorkspaceFilings(company).count, null);
  assert.equal(
    summarizeWorkspaceFilings({ ...company, archives: [] }, "2026-08-03")
      .coverage.completeSinceReview,
    true,
  );
  assert.equal(
    summarizeWorkspaceFilings(
      { ...company, archives: [], omittedRecords: 1 },
      "2026-08-03",
    ).coverage.completeSinceReview,
    false,
  );
});

test("unsaving a fund is idempotent when another tab removed it first", () => {
  let raw = '["VOO"]';
  const storage = {
    getItem: () => raw,
    setItem: (_, value) => {
      raw = value;
    },
  };
  assert.deepEqual(removeFundFromShelf(storage, "SPY"), ["VOO"]);
  assert.deepEqual(removeFundFromShelf(storage, "VOO"), []);
  assert.deepEqual(removeFundFromShelf(storage, "VOO"), []);
});
