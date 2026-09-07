import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisScenario } from "../src/utils/analysisScenarios.js";
import { analysisCollectionSettings } from "../src/utils/analysisNotebook.js";
import {
  buildAnalysisSensitivity,
  buildScenarioDriverBridge,
  scenarioSensitivityValues,
} from "../src/utils/analysisScenarioSensitivity.js";

const period = {
  start: "2025-01-01",
  end: "2025-12-31",
  kind: "annual",
  label: "FY2025",
};
function company(lens = "corporate") {
  const values = {
    revenue: 1000,
    operatingIncome: 100,
    totalAssets: 2000,
    stockholdersEquity: 200,
    cash: 300,
    deposits: 1500,
  };
  return {
    ticker: "TEST",
    lens,
    periods: [period],
    definitions: Object.keys(values).map((key) => ({
      key,
      label: key,
      format: "currency",
    })),
    metrics: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        [
          {
            value,
            period,
            classification: "reported",
            sources: [
              {
                tag: key,
                taxonomy: "us-gaap",
                unit: "USD",
                value,
                start: ["revenue", "operatingIncome"].includes(key)
                  ? period.start
                  : null,
                end: period.end,
                filed: "2026-02-01",
                accession: "0000000001-26-000001",
              },
            ],
          },
        ],
      ]),
    ),
  };
}

test("Sensitivity axes clip and deduplicate boundaries while retaining the exact committed assumption", () => {
  assert.deepEqual(
    scenarioSensitivityValues(0, 5, -50, 50),
    [-10, -5, 0, 5, 10],
  );
  assert.deepEqual(scenarioSensitivityValues(-50, 5, -50, 50), [-50, -45, -40]);
  assert.deepEqual(scenarioSensitivityValues(20, 2, 0, 20), [16, 18, 20]);
  assert.deepEqual(
    scenarioSensitivityValues(19.75, 0.25, 0, 20),
    [19.25, 19.5, 19.75, 20],
  );
  assert.deepEqual(scenarioSensitivityValues(0, 0, 0, 20), []);
  assert.deepEqual(scenarioSensitivityValues(NaN, 1, 0, 20), []);
  const precise = 7.123456789012345;
  assert.ok(scenarioSensitivityValues(precise, 5, -50, 50).includes(precise));
});

test("Every margin-grid outcome equals the core model and retains the committed cell and its SEC inputs", () => {
  const data = company();
  const settings = {
    scenarioRevenue: 7.25,
    scenarioMargin: -1.25,
    scenarioLoss: 2,
  };
  const originalData = structuredClone(data),
    originalSettings = structuredClone(settings);
  const grid = buildAnalysisSensitivity(data, settings, 0);
  assert.equal(grid.cells.length, 25);
  assert.equal(grid.cells.filter((cell) => cell.current).length, 1);
  for (const cell of grid.cells) {
    const direct = buildAnalysisScenario(
      data,
      { ...settings, ...cell.patch },
      0,
    ).operating.rows.find((row) => row.key === "OperatingIncome");
    assert.equal(cell.value, direct.selection.point.value);
    assert.equal(cell.reason, null);
    assert.equal(cell.selection.point.sources.length, 2);
    assert.deepEqual(Object.keys(cell.patch).sort(), [
      "scenarioMargin",
      "scenarioRevenue",
    ]);
    assert.match(cell.selection.point.note, /Hypothetical/);
  }
  assert.equal(grid.cells.find((cell) => cell.current).delta, 0);
  assert.deepEqual(data, originalData);
  assert.deepEqual(settings, originalSettings);
});

test("The operating margin outcome uses percentage points and does not apply revenue growth twice", () => {
  const grid = buildAnalysisSensitivity(
    company(),
    { scenarioRevenue: 10, scenarioMargin: 2 },
    0,
    { outcome: "Margin" },
  );
  assert.equal(grid.outcome.format, "percent");
  assert.equal(grid.current.value, 12);
  assert.equal(
    grid.cells.find((cell) => cell.x === 20 && cell.y === 4).value,
    14,
  );
  assert.equal(
    grid.cells.find((cell) => cell.x === 20 && cell.y === 4).delta,
    2,
  );
});

test("A full-precision committed assumption remains the unique selected grid point", () => {
  const settings = {
    scenarioRevenue: 7.123456789012345,
    scenarioMargin: 1.234567890123456,
  };
  const grid = buildAnalysisSensitivity(company(), settings, 0);
  const current = grid.cells.filter((cell) => cell.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].patch.scenarioRevenue, settings.scenarioRevenue);
  assert.equal(current[0].patch.scenarioMargin, settings.scenarioMargin);
  assert.equal(current[0].value, grid.current.value);
});

test("Inspecting a neighboring cell preserves its exact assumptions and provenance when collected", () => {
  const data = { ...company(), basis: "annual", asOf: "2026-03-01" };
  const settings = {
    view: "scenarios",
    scenarioTab: "sensitivity",
    units: "millions",
    basis: "quarter",
    asOf: "2026-09-01",
    scenarioRevenue: 7.123456789012345,
    scenarioMargin: 1.234567890123456,
    scenarioVariableCost: 72.12345678901234,
    scenarioCashAvailable: 63.23456789012345,
  };
  const original = structuredClone(settings);
  const grid = buildAnalysisSensitivity(data, settings, 0);
  const neighbor = grid.cells.find(
    (cell) =>
      !cell.current &&
      cell.x !== settings.scenarioRevenue &&
      cell.y !== settings.scenarioMargin,
  );
  const inspected = neighbor.selection.analysisSettings;
  assert.equal(inspected.scenarioRevenue, neighbor.x);
  assert.equal(inspected.scenarioMargin, neighbor.y);
  assert.equal(inspected.scenarioVariableCost, settings.scenarioVariableCost);
  assert.equal(inspected.scenarioCashAvailable, settings.scenarioCashAvailable);
  assert.equal(inspected.units, "millions");
  assert.equal(inspected.view, "scenarios");
  assert.equal(inspected.basis, "annual");
  assert.equal(inspected.end, period.end);
  assert.equal(inspected.asOf, data.asOf);
  const collected = analysisCollectionSettings(neighbor.selection, settings);
  assert.equal(collected.scenarioRevenue, neighbor.x);
  assert.equal(collected.scenarioMargin, neighbor.y);
  assert.equal(collected.asOf, data.asOf);
  assert.equal(
    buildAnalysisScenario(data, collected, 0).operating.rows.find(
      (row) => row.key === "OperatingIncome",
    ).selection.point.value,
    neighbor.value,
  );
  assert.equal(
    grid.current.selection.analysisSettings.scenarioRevenue,
    settings.scenarioRevenue,
  );
  assert.equal(
    grid.current.selection.analysisSettings.scenarioMargin,
    settings.scenarioMargin,
  );
  assert.deepEqual(settings, original);
});

test("Cell provenance falls back to the selected filing cutoff when the dataset has no cutoff", () => {
  const grid = buildAnalysisSensitivity(company(), { asOf: "2026-04-01" }, 0);
  assert.ok(
    grid.cells.every(
      (cell) => cell.selection.analysisSettings.asOf === "2026-04-01",
    ),
  );
});

test("Cost-grid axes vary revenue and costs while preserving the cost split and inactive margin assumption", () => {
  const settings = {
    scenarioModel: "cost",
    scenarioVariableCost: 75,
    scenarioCostChange: 5,
    scenarioMargin: 19,
    scenarioRevenue: 10,
  };
  const grid = buildAnalysisSensitivity(company(), settings, 0);
  assert.equal(grid.y.key, "scenarioCostChange");
  assert.equal(grid.settings.scenarioVariableCost, 75);
  assert.equal(grid.settings.scenarioMargin, 19);
  for (const cell of grid.cells) {
    const growth = cell.x / 100,
      costChange = cell.y / 100;
    assert.equal(
      cell.value,
      1000 * (1 + growth) - (225 + 675 * (1 + growth)) * (1 + costChange),
    );
    assert.deepEqual(Object.keys(cell.patch).sort(), [
      "scenarioCostChange",
      "scenarioRevenue",
    ]);
  }
});

test("Bank-grid funding failures are unavailable, while an exactly exhausted cash balance remains explicit zero", () => {
  const settings = { scenarioLoss: 2, scenarioFunding: 20 };
  const grid = buildAnalysisSensitivity(company("banking"), settings, 0, {
    outcome: "Cash",
    yStep: 10,
  });
  assert.equal(grid.current.value, 0);
  assert.equal(grid.y.key, "scenarioFunding");
  assert.ok(grid.invalidCount > 0);
  assert.ok(
    grid.cells.some((cell) => cell.value === 0 && cell.reason === null),
  );
  assert.ok(
    grid.cells
      .filter((cell) => cell.y > 20)
      .every(
        (cell) =>
          cell.value === null &&
          cell.selection === null &&
          /exceeds reported cash/.test(cell.reason),
      ),
  );
  assert.equal(grid.minimum, 0);
  assert.ok(grid.maximum > 0);
});

test("Bank-grid cells keep available-cash and replacement-funding assumptions fixed", () => {
  const settings = {
    scenarioLoss: 2,
    scenarioFunding: 10,
    scenarioCashAvailable: 25,
    scenarioReplacementFunding: 5,
  };
  const data = company("banking");
  const grid = buildAnalysisSensitivity(data, settings, 0);
  for (const cell of grid.cells) {
    const direct = buildAnalysisScenario(
      data,
      { ...settings, ...cell.patch },
      0,
    ).balance;
    assert.deepEqual(Object.keys(cell.patch).sort(), [
      "scenarioFunding",
      "scenarioLoss",
    ]);
    assert.equal(cell.reason, direct.reason);
    assert.equal(
      cell.value,
      direct.reason
        ? null
        : direct.rows.find((row) => row.key === "EquityAssets").selection.point
            .value,
    );
    if (cell.selection)
      assert.match(
        cell.selection.point.note,
        /usable cash = 25%.*Replacement funding = 5%/,
      );
  }
});

test("Missing inputs are never colorable zeros and the grid preserves per-cell unavailability", () => {
  const data = company();
  data.metrics.revenue[0].value = null;
  const grid = buildAnalysisSensitivity(data, {}, 0);
  assert.equal(grid.invalidCount, grid.cells.length);
  assert.equal(grid.minimum, null);
  assert.equal(grid.maximum, null);
  assert.equal(grid.current.value, null);
  assert.ok(
    grid.cells.every(
      (cell) => cell.value === null && cell.delta === null && cell.reason,
    ),
  );
});

test("An unavailable current result does not hide valid neighboring combinations or invent comparison deltas", () => {
  const grid = buildAnalysisSensitivity(
    company("banking"),
    { scenarioFunding: 25 },
    0,
  );
  assert.equal(grid.current.value, null);
  assert.ok(grid.cells.some((cell) => Number.isFinite(cell.value)));
  assert.ok(grid.cells.every((cell) => cell.delta === null));
});

test("A missing bank funding input gives a specific cash-outcome reason even when asset-loss arithmetic remains available", () => {
  const data = company("banking");
  data.metrics.cash[0].value = null;
  const grid = buildAnalysisSensitivity(data, {}, 0, { outcome: "Cash" });
  assert.equal(grid.current.value, null);
  assert.match(grid.current.reason, /unavailable/);
  assert.equal(grid.invalidCount, grid.cells.length);
});

test("Nonbank balance sensitivity uses the single loss driver and preserves negative equity as arithmetic", () => {
  for (const lens of ["insurance", "corporate"]) {
    const grid = buildAnalysisSensitivity(
      company(lens),
      { scenarioLoss: 15 },
      0,
      { exercise: "balance" },
    );
    assert.equal(grid.y, undefined);
    assert.equal(grid.cells.length, 5);
    assert.ok(grid.current.value < 0);
    assert.ok(grid.cells.every((cell) => cell.reason === null));
    assert.deepEqual(Object.keys(grid.cells[0].patch), ["scenarioLoss"]);
  }
});

test("Unsupported matrix options fall back to meaningful model outcomes and bounded intervals", () => {
  const grid = buildAnalysisSensitivity(
    company(),
    { scenarioRevenue: 50, scenarioMargin: 20 },
    0,
    { outcome: "InventedMetric", xStep: -100, yStep: Infinity },
  );
  assert.equal(grid.outcome.key, "OperatingIncome");
  assert.equal(grid.x.step, 5);
  assert.equal(grid.y.step, 2);
  assert.equal(grid.cells.length, 9);
  assert.equal(grid.clipped, true);
  assert.equal(grid.cells.filter((cell) => cell.current).length, 1);
});

test("Revenue/margin and cost bridges reconcile isolated effects across negative, zero and positive assumptions", () => {
  for (const scenarioModel of ["margin", "cost"]) {
    for (const scenarioRevenue of [-50, -13.75, 0, 17.25, 50]) {
      for (const change of [-20, -3.1, 0, 5.2, 20]) {
        const scenario = buildAnalysisScenario(
          company(),
          {
            scenarioModel,
            scenarioRevenue,
            scenarioMargin: change,
            scenarioCostChange: change,
            scenarioVariableCost: 73.25,
          },
          0,
        );
        const bridge = buildScenarioDriverBridge(scenario);
        assert.equal(bridge.reason, null);
        assert.equal(bridge.rows.length, 5);
        assert.equal(bridge.reconciled, true);
        assert.ok(
          Math.abs(bridge.final - bridge.reconstructed) <= bridge.tolerance,
        );
        assert.equal(bridge.rows[0].value, 100);
        assert.equal(bridge.rows[0].selection.point.classification, "reported");
        assert.equal(
          bridge.rows.at(-1).value,
          scenario.operating.rows.find((row) => row.key === "OperatingIncome")
            .selection.point.value,
        );
        assert.ok(
          bridge.rows
            .filter((row) => row.kind === "effect")
            .every((row) => row.selection.point.sources.length === 2),
        );
      }
    }
  }
});

test("A corrupted bridge is explicitly flagged and missing operating inputs withhold attribution", () => {
  const scenario = buildAnalysisScenario(
    company(),
    { scenarioRevenue: 10, scenarioMargin: 2 },
    0,
  );
  scenario.operating.bridge[0].selection.point.value += 1;
  const bridge = buildScenarioDriverBridge(scenario);
  assert.equal(bridge.reconciled, false);
  assert.ok(Math.abs(bridge.residual) > bridge.tolerance);
  const data = company();
  data.metrics.operatingIncome[0].value = null;
  const unavailable = buildScenarioDriverBridge(
    buildAnalysisScenario(data, {}, 0),
  );
  assert.match(unavailable.reason, /unavailable/);
  assert.deepEqual(unavailable.rows, []);
});
