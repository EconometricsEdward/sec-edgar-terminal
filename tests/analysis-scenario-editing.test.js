import test from "node:test";
import assert from "node:assert/strict";
import {
  validateScenarioDrafts,
  scenarioAssumptionsEqual,
} from "../src/utils/analysisScenarioEditing.js";
import {
  normalizeAnalysisSettings,
  readAnalysisSettings,
  analysisPath,
  analysisCollectionSettings,
} from "../src/utils/analysisNotebook.js";

test("draft validation preserves blanks, partial signs and unsupported values as errors", () => {
  for (const raw of [
    "",
    "-",
    ".",
    "NaN",
    "Infinity",
    "0x10",
    "1e",
    "51",
    "-51",
  ]) {
    const result = validateScenarioDrafts({ scenarioRevenue: raw });
    assert.equal(result.valid, false, raw);
    assert.deepEqual(result.values, {});
    assert.ok(result.errors.scenarioRevenue);
  }
  assert.equal(
    validateScenarioDrafts({ scenarioRevenue: "0" }).values.scenarioRevenue,
    0,
  );
});

test("atomic draft batch validates all fields without rounding precise solver inputs", () => {
  const draft = {
    scenarioModel: "cost",
    scenarioRevenue: "-10",
    scenarioVariableCost: "65",
    scenarioCostChange: "2.5",
    scenarioLoss: "5.2631578947368425",
  };
  const result = validateScenarioDrafts(draft);
  assert.equal(result.valid, true);
  assert.equal(result.values.scenarioLoss, 5.2631578947368425);
  assert.equal(result.values.scenarioModel, "cost");
  assert.equal(
    validateScenarioDrafts({ ...draft, scenarioCashAvailable: "101" }).valid,
    false,
  );
  assert.equal(
    validateScenarioDrafts({ scenarioModel: "unknown" }).valid,
    false,
  );
});

test("complete scenario and canonical goal settings survive share links without private unknown fields", () => {
  const settings = normalizeAnalysisSettings({
    view: "scenarios",
    scenarioTab: "cases",
    scenarioCase: "scenario_123",
    basis: "quarter",
    end: "2025-06-30",
    asOf: "2025-08-31",
    scenarioModel: "cost",
    scenarioRevenue: -12.5,
    scenarioLoss: 5.2631578947368425,
    scenarioVariableCost: 75,
    scenarioCostChange: 4,
    scenarioCashAvailable: 40,
    scenarioReplacementFunding: 8,
    goalMode: "margin",
    goalTargetIncome: "12345000000",
    goalAssumedRevenue: "410000000000",
    goalEquityFloor: "5",
    goalOperatingSolved: true,
    notes: "private text",
    alien: "value",
  });
  const path = analysisPath("AAPL", settings);
  assert.deepEqual(readAnalysisSettings(path.split("?")[1]), settings);
  assert.ok(!path.includes("private"));
  assert.ok(!path.includes("alien"));
  assert.equal(settings.scenarioLoss, 5.2631578947368425);
  assert.ok(
    scenarioAssumptionsEqual(settings, {
      ...settings,
      units: "billions",
      goalEquityFloor: "8",
    }),
  );
});

test("collected scenario evidence retains original settings and actual historical source context", () => {
  const original = normalizeAnalysisSettings({
    view: "scenarios",
    scenarioRevenue: -15,
    scenarioModel: "cost",
    scenarioCostChange: 3,
    asOf: "2025-02-01",
  });
  const item = {
    analysisSettings: original,
    point: {
      period: { kind: "annual", end: "2024-09-28" },
      formula: "Hypothetical: revenue × assumption",
    },
  };
  const result = analysisCollectionSettings(
    item,
    normalizeAnalysisSettings({ scenarioRevenue: 30 }),
  );
  assert.equal(result.scenarioRevenue, -15);
  assert.equal(result.scenarioModel, "cost");
  assert.equal(result.end, "2024-09-28");
  assert.equal(result.asOf, "2025-02-01");
  assert.deepEqual(
    analysisCollectionSettings(
      { point: { period: { kind: "annual", end: "2024-09-28" } } },
      { basis: "quarter", end: "latest", asOf: "" },
    ),
    { basis: "annual", end: "2024-09-28", asOf: "" },
  );
});
