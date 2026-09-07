import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAnalysisRule,
  validateAnalysisRules,
} from "../src/utils/analysisRules.js";
const periods = [2025, 2024].map((y) => ({
  kind: "annual",
  fp: "FY",
  start: `${y}-01-01`,
  end: `${y}-12-31`,
  label: `FY${y}`,
}));
const fixture = (format = "currency") => ({
  periods,
  definitions: [{ key: "netIncome", label: "Net income", format }],
  metrics: {
    netIncome: periods.map((period, i) => ({
      period,
      value: i ? 100 : 80,
      classification: "reported",
      sources: [
        {
          tag: "NetIncomeLoss",
          unit: "USD",
          value: i ? 100 : 80,
          start: period.start,
          end: period.end,
          filed: `${2026 - i}-02-01`,
          accession: `filing-${i}`,
        },
      ],
    })),
  },
});
const rule = (overrides = {}) => ({
  id: "one",
  label: "Review earnings",
  metric: "netIncome",
  format: "currency",
  basis: "annual",
  mode: "below",
  baseline: "year",
  threshold: 90,
  updatedAt: "2026-09-07T12:00:00Z",
  ...overrides,
});
const settings = { basis: "annual", asOf: "" };

test("Personal checks keep zero, equality and missing data distinct", () => {
  const data = fixture();
  assert.equal(
    evaluateAnalysisRule(data, settings, 0, rule()).status,
    "matched",
  );
  assert.equal(
    evaluateAnalysisRule(data, settings, 0, rule({ threshold: 80 })).status,
    "clear",
  );
  data.metrics.netIncome[0].value = 0;
  assert.equal(
    evaluateAnalysisRule(data, settings, 0, rule()).status,
    "matched",
  );
  data.metrics.netIncome[0].value = null;
  assert.equal(
    evaluateAnalysisRule(data, settings, 0, rule()).status,
    "unavailable",
  );
});
test("Personal change checks calculate signed absolute change and preserve both inputs", () => {
  const result = evaluateAnalysisRule(
    fixture(),
    settings,
    0,
    rule({ mode: "changeBelow", threshold: -10 }),
  );
  assert.equal(result.measuredValue, -20);
  assert.equal(result.status, "matched");
  assert.equal(result.selection.point.sources.length, 2);
  assert.match(result.selection.definition.key, /^threshold:/);
  assert.equal(result.selection.analysisSettings.end, "2025-12-31");
});
test("Percentage metric thresholds use percentage point changes without percentage growth", () => {
  const result = evaluateAnalysisRule(
    fixture("percent"),
    settings,
    0,
    rule({ format: "percent", mode: "changeBelow", threshold: -10 }),
  );
  assert.equal(result.format, "percentagePoints");
  assert.equal(result.measuredValue, -20);
});
test("Rule evaluations withhold mismatched basis, format, cutoff, missing source and flow duration", () => {
  assert.equal(
    evaluateAnalysisRule(fixture(), { basis: "quarter" }, 0, rule()).status,
    "unavailable",
  );
  assert.equal(
    evaluateAnalysisRule(fixture("eps"), settings, 0, rule()).status,
    "unavailable",
  );
  assert.equal(
    evaluateAnalysisRule(
      fixture(),
      { ...settings, asOf: "2026-01-01" },
      0,
      rule(),
    ).status,
    "unavailable",
  );
  const data = fixture();
  data.metrics.netIncome[0].sources = [];
  assert.equal(
    evaluateAnalysisRule(data, settings, 0, rule()).status,
    "unavailable",
  );
  const mismatch = fixture();
  mismatch.metrics.netIncome[0].sources[0].start = "2025-07-01";
  assert.equal(
    evaluateAnalysisRule(mismatch, settings, 0, rule()).status,
    "unavailable",
  );
});
test("Rule validation rejects corrupt thresholds and duplicate identifiers", () => {
  assert.deepEqual(validateAnalysisRules([rule()]), [rule()]);
  for (const bad of [
    rule({ threshold: Infinity }),
    rule({ threshold: "90" }),
    rule({ basis: "monthly" }),
    rule({ mode: "hacked" }),
    rule({ metric: "a:b" }),
  ])
    assert.throws(() => validateAnalysisRules([bad]));
  assert.throws(() => validateAnalysisRules([rule(), rule()]));
});

test("Direct per-share evidence must match the selected source duration", () => {
  const data = fixture("eps");
  data.metrics.netIncome[0].sources[0].start = "2025-07-01";
  assert.equal(
    evaluateAnalysisRule(data, settings, 0, rule({ format: "eps" })).status,
    "unavailable",
  );
});
test("Threshold conclusions cannot silently transfer to another period in the inspector", () => {
  const result = evaluateAnalysisRule(fixture(), settings, 0, rule());
  assert.equal(result.selection.definition.key, "threshold:netIncome");
  assert.equal(result.selection.analysisSettings.end, "2025-12-31");
});
