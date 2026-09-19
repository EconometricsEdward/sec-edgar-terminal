import test from "node:test";
import assert from "node:assert/strict";
import { researchMetricComparison } from "../src/utils/compareBenchmarks.js";
import { comparisonOverviewScale } from "../src/utils/compareOverview.js";

function company(ticker, value, options = {}) {
  const period = { end: "2026-06-30", start: "2026-04-01", kind: "quarter", ...options.period };
  return {
    ticker, period, index: 0, loading: false, error: null,
    data: { cik: ticker === "A" ? "0000000001" : ticker === "B" ? "0000000002" : "0000000003",
      metrics: { totalAssets: [{ value, period }] } }, ...options,
  };
}

test("overview preserves negative and zero observations while missing values never become bars", () => {
  const comparison = researchMetricComparison([
    company("A", -100), company("B", 0), company("C", null),
  ], "totalAssets", { benchmark: "median" });
  const scale = comparisonOverviewScale(comparison);
  assert.deepEqual([...scale.plottedTickers], ["A", "B"]);
  assert.equal(scale.guide, -50);
  assert.ok(scale.position(-100) < scale.position(-50));
  assert.ok(scale.position(-50) < scale.zero);
  assert.equal(scale.position(0), scale.zero);
  for (const value of [-100, -50, 0]) assert.ok(Number.isFinite(scale.position(value)));
});

test("mixed reporting dates retain observations but suppress benchmark guide", () => {
  const comparison = researchMetricComparison([
    company("A", 100), company("B", 200, { period: { end: "2026-03-31", kind: "quarter", start: "2026-01-01" } }),
  ], "totalAssets", { benchmark: "median" });
  const scale = comparisonOverviewScale(comparison);
  assert.match(comparison.reason, /Reporting dates/);
  assert.equal(scale.guide, null);
  assert.deepEqual([...scale.plottedTickers], ["A", "B"]);
});

test("overview uses the selected eligible issuer reference and never draws retained failed data", () => {
  const comparison = researchMetricComparison([
    company("A", 100), company("B", 200), company("C", 1000, { error: "failed" }),
  ], "totalAssets", { benchmark: "B" });
  const scale = comparisonOverviewScale(comparison);
  assert.equal(comparison.peerMedian, 150);
  assert.equal(scale.guide, 200);
  assert.deepEqual([...scale.plottedTickers], ["A", "B"]);
  assert.equal(scale.high, 200);
});

test("all zero and empty selections have finite chart positions", () => {
  const zeros = comparisonOverviewScale(researchMetricComparison([
    company("A", 0), company("B", 0),
  ], "totalAssets", { benchmark: "median" }));
  assert.equal(zeros.guide, 0);
  assert.equal(zeros.position(0), 50);
  const empty = comparisonOverviewScale(researchMetricComparison([], "totalAssets", { benchmark: "median" }));
  assert.equal(empty.guide, null);
  assert.equal(empty.zero, 50);
  assert.equal(empty.plottedTickers.size, 0);
});
