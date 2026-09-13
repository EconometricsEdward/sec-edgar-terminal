import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisPath,
  normalizeAnalysisSettings,
  readAnalysisSettings,
} from "../src/utils/analysisNotebook.js";
import { normalizeScenarioSettings } from "../src/utils/analysisScenarios.js";

test("CFTC analysis links preserve the research cutoff and independent scenario assumptions", () => {
  const initial = normalizeAnalysisSettings({
    view: "scenarios",
    asOf: "2026-07-01",
    basis: "quarter",
    end: "2026-03-31",
    scenarioRevenue: -12,
    scenarioCostChange: 8,
    scenarioFunding: 20,
  });
  const cftcView = normalizeAnalysisSettings({ ...initial, view: "cftc" });
  const path = analysisPath("XOM", cftcView);
  const restored = readAnalysisSettings(path.slice(path.indexOf("?")));

  assert.equal(restored.view, "cftc");
  assert.equal(restored.asOf, "2026-07-01");
  assert.equal(restored.end, "2026-03-31");
  assert.deepEqual(restored, cftcView);
  assert.deepEqual(
    normalizeScenarioSettings({ ...restored, view: "scenarios" }),
    normalizeScenarioSettings(initial),
  );
});
