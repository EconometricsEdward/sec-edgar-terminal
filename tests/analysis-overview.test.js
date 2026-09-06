import test from "node:test";
import assert from "node:assert/strict";
import { analysisMovements } from "../src/utils/analysisOverview.js";
import {
  normalizeAnalysisSettings,
  readAnalysisSettings,
  analysisPath,
  analysisValue,
  analysisCollectionSettings,
} from "../src/utils/analysisNotebook.js";
const periods = [
  { kind: "annual", fp: "FY", start: "2025-01-01", end: "2025-12-31" },
  { kind: "annual", fp: "FY", start: "2024-01-01", end: "2024-12-31" },
];
const point = (value, i) => ({
  value,
  period: periods[i],
  sources: [{ start: periods[i].start, end: periods[i].end }],
});
const data = {
  periods,
  definitions: [
    {
      key: "revenue",
      label: "Revenue",
      format: "currency",
      category: "income",
    },
    {
      key: "netIncome",
      label: "Income",
      format: "currency",
      category: "income",
    },
    { key: "eps", label: "EPS", format: "eps", category: "income" },
  ],
  metrics: {
    revenue: [point(150, 0), point(100, 1)],
    netIncome: [point(20, 0), point(-40, 1)],
    eps: [point(10, 0), point(1, 1)],
  },
};
test("Overview ranks like-unit absolute changes including turnarounds and explains exclusions", () => {
  const result = analysisMovements(data, 0);
  assert.deepEqual(
    result.rows.map((r) => r.definition.key),
    ["netIncome", "revenue"],
  );
  assert.equal(result.excluded, 1);
  assert.equal(result.rows[0].change.percent, null);
  assert.equal(
    analysisMovements(data, 0, { movementThreshold: 55 }).rows.length,
    1,
  );
});
test("Percentage ranking excludes nonpositive prior bases and incompatible periods", () => {
  const result = analysisMovements(data, 0, { movementSort: "growth" });
  assert.deepEqual(
    result.rows.map((r) => r.definition.key),
    ["eps", "revenue"],
  );
  const incompatible = structuredClone(data);
  incompatible.metrics.revenue[1].period = {
    ...incompatible.metrics.revenue[1].period,
    kind: "quarter",
  };
  assert.equal(
    analysisMovements(incompatible, 0, { movementSort: "growth" }).rows.length,
    1,
  );
});
test("Analysis lab settings round trip, bound assumptions, and preserve explicit empty sections", () => {
  const settings = normalizeAnalysisSettings({
    view: "scenarios",
    scenarioRevenue: -17.5,
    scenarioMargin: -2,
    scenarioLoss: 2,
    scenarioFunding: 15,
    formulaOp: "subtractRatio",
    formulaC: "totalAssets",
    briefTitle: "Annual credit review",
    briefSections: ["summary", "coverage", "sources"],
    briefMetrics: ["netIncome", "cash"],
    growthMetric: "netIncome",
    movementThreshold: 1500000000,
  });
  assert.deepEqual(
    readAnalysisSettings(analysisPath("JPM", settings).split("?")[1]),
    settings,
  );
  const bad = normalizeAnalysisSettings({
    scenarioRevenue: Infinity,
    scenarioMargin: 300,
    scenarioLoss: -1,
    briefTitle: { bad: true },
    briefSections: ["unknown"],
    briefMetrics: ["netIncome", "netIncome", "<script>"],
  });
  assert.equal(bad.scenarioRevenue, 0);
  assert.equal(bad.scenarioMargin, 20);
  assert.equal(bad.scenarioLoss, 0);
  assert.equal(bad.briefTitle, "");
  assert.deepEqual(bad.briefSections, []);
  assert.deepEqual(bad.briefMetrics, ["netIncome"]);
  assert.deepEqual(readAnalysisSettings("?briefSections=").briefSections, []);
  assert.equal(analysisValue(33.33, "days", "millions"), "33.3 days");
});
test("Collected financial evidence retains its original cutoff and actual point period", () => {
  const settings = { basis: "ttm", end: "latest", asOf: "2026-08-01" };
  const item = { point: { period: { kind: "annual", end: "2023-12-31" } } };
  assert.deepEqual(analysisCollectionSettings(item, settings), {
    basis: "annual",
    end: "2023-12-31",
    asOf: "2026-08-01",
  });
  assert.equal(
    analysisCollectionSettings(
      { ...item, analysisSettings: { asOf: "2024-03-01" } },
      settings,
    ).asOf,
    "2024-03-01",
  );
  assert.equal(
    analysisCollectionSettings(
      { ...item, analysisSettings: { asOf: "" } },
      settings,
    ).asOf,
    "",
  );
  assert.equal(
    analysisCollectionSettings({ ...item, analysisSettings: null }, settings)
      .asOf,
    null,
  );
  assert.equal(
    analysisCollectionSettings(
      { ...item, analysisSettings: { asOf: null } },
      settings,
    ).asOf,
    null,
  );
});
