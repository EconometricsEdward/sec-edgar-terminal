import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisScenario,
  SCENARIO_DEFAULTS,
} from "../src/utils/analysisScenarios.js";
import {
  scenarioBaselineContext,
  scenarioHistoricalCalibration,
  scenarioStarterCases,
  scenarioStarterPatch,
} from "../src/utils/analysisScenarioContext.js";

function fixture(lens = "corporate", count = 8, kind = "annual") {
  const periods = Array.from({ length: count }, (_, i) => ({
    kind,
    fy: 2025 - i,
    fp: kind === "annual" ? "FY" : "Q2",
    label: kind === "annual" ? `FY${2025 - i}` : `Q2 ${2025 - i}`,
    start: `${2025 - i}-${kind === "quarter" ? "04" : "01"}-01`,
    end: `${2025 - i}-${kind === "annual" ? "12-31" : "06-30"}`,
  }));
  const definitions = [
    ["revenue", "Revenue", "income", 1000],
    ["operatingIncome", "Operating income", "income", 100],
    ["totalAssets", "Total assets", "balance", 2000],
    ["stockholdersEquity", "Shareholder equity", "balance", 200],
    ["cash", "Cash", "balance", 300],
    ["deposits", "Deposits", "balance", 1500],
  ];
  return {
    ticker: "TEST",
    lens,
    basis: kind,
    periods,
    asOf: "2026-03-01",
    observedAt: "2026-03-03T10:00:00Z",
    definitions: definitions.map(([key, label, category]) => ({
      key,
      label,
      category,
      format: "currency",
    })),
    metrics: Object.fromEntries(
      definitions.map(([key, label, category, base]) => [
        key,
        periods.map((period, index) => ({
          value: base / (1 + index * 0.1),
          period,
          classification: "reported",
          sources: [
            {
              taxonomy: "us-gaap",
              tag: key,
              label,
              unit: "USD",
              value: base / (1 + index * 0.1),
              start: category === "balance" ? null : period.start,
              end: period.end,
              filed: `${period.fy + 1}-02-01`,
              accession: `0000000001-${String(period.fy + 1).slice(-2)}-000001`,
              documentUrl:
                "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm",
            },
          ],
        })),
      ]),
    ),
  };
}

function changeSource(data, key, index, patch) {
  Object.assign(data.metrics[key][index].sources[0], patch);
}

test("baseline context uses actual selected identity and exact model inputs, including unavailable reasons", () => {
  const data = fixture("banking");
  data.metrics.cash[1].value = null;
  data.metrics.cash[1].reason = "Reported cash was not available.";
  const scenario = buildAnalysisScenario(data, {}, 1);
  const context = scenarioBaselineContext(
    data,
    { asOf: "2020-01-01", period: "1900-12-31" },
    1,
    scenario,
  );
  assert.equal(context.ticker, "TEST");
  assert.equal(context.period.end, "2024-12-31");
  assert.equal(context.cutoff, data.asOf);
  assert.equal(context.observedAt, data.observedAt);
  assert.deepEqual(
    context.inputs.map((input) => input.key),
    scenario.balance.inputs.map((input) => input.key),
  );
  assert.equal(context.ready, context.total - 1);
  const cash = context.inputs.find((input) => input.key === "cash");
  assert.match(cash.reason, /cash was not available/);
  assert.equal(cash.selection.point, data.metrics.cash[1]);
});

test("historical calibration never admits observations beyond an older selected endpoint and uses the same assumptions", () => {
  const data = fixture();
  const settings = {
    scenarioRevenue: -10,
    scenarioMargin: -2,
    scenarioLoss: 2,
  };
  const context = scenarioHistoricalCalibration(data, settings, 1);
  assert.equal(context.checked, 5);
  assert.ok(context.rows.every((row) => row.period.end < data.periods[1].end));
  assert.deepEqual(
    context.rows.map((row) => row.period.fy),
    [2023, 2022, 2021, 2020, 2019],
  );
  for (const row of context.rows) {
    const expected = buildAnalysisScenario(data, settings, row.index);
    assert.equal(
      row.operatingResult.point.value,
      expected.operating.rows.find((r) => r.key === "OperatingIncome").selection
        .point.value,
    );
    assert.equal(
      row.balanceResult.point.value,
      expected.balance.rows.find((r) => r.key === "EquityAssets").selection
        .point.value,
    );
    assert.equal(
      row.operatingIncome.point,
      data.metrics.operatingIncome[row.index],
    );
    for (const source of row.operatingResult.point.sources)
      assert.ok(source.end <= row.period.end);
  }
  assert.match(context.note, /retrospective/);
});

test("same-quarter history excludes intervening quarters and retains visible prior-year revenue denominators", () => {
  const data = fixture("corporate", 4, "quarter");
  const intervening = {
    ...data.periods[0],
    fp: "Q1",
    start: "2025-01-01",
    end: "2025-03-31",
  };
  data.periods.splice(1, 0, intervening);
  for (const points of Object.values(data.metrics))
    points.splice(1, 0, { ...points[0], period: intervening, value: 99999 });
  const context = scenarioHistoricalCalibration(data, {}, 0);
  assert.deepEqual(
    context.rows.map((row) => row.index),
    [2, 3, 4],
  );
  assert.ok(context.rows.every((row) => row.period.fp === "Q2"));
  assert.equal(
    context.rows[0].growthDenominator.point,
    data.metrics.revenue[3],
  );
  assert.equal(context.rows[0].revenueGrowth.point.sources.length, 2);
  assert.equal(context.growthCount, 2);
  assert.match(
    context.rows.at(-1).revenueGrowth.point.reason,
    /denominator is missing/,
  );
});

test("missing or ambiguous years remain explicit boundaries, never silently skipped", () => {
  const missing = fixture();
  missing.periods.splice(2, 1);
  for (const points of Object.values(missing.metrics)) points.splice(2, 1);
  const result = scenarioHistoricalCalibration(missing, {}, 0);
  assert.equal(result.checked, 1);
  assert.match(result.boundaryReason, /not skipped/);
  const duplicate = fixture();
  duplicate.periods.push({ ...duplicate.periods[1] });
  for (const points of Object.values(duplicate.metrics)) points.push(points[1]);
  assert.equal(scenarioHistoricalCalibration(duplicate, {}, 0).checked, 0);
});

test("incompatible concepts, actual durations, currencies, and source dates are excluded with per-measure reasons", () => {
  const changes = [
    [{ tag: "DifferentRevenueConcept" }, /concepts differ/],
    [{ start: "2024-06-01" }, /duration|flow window/],
    [{ unit: "EUR" }, /USD/],
    [{ end: "2025-12-31" }, /after|beyond/],
    [{ end: "2024-02-30" }, /invalid/],
    [{ filed: "2026-04-01" }, /cutoff/],
  ];
  for (const [patch, reason] of changes) {
    const data = fixture();
    changeSource(data, "revenue", 1, patch);
    const context = scenarioHistoricalCalibration(data, {}, 0);
    assert.match(context.rows[0].operatingReason, reason);
    assert.equal(context.rows[0].operatingMargin.point.value, null);
    assert.equal(context.rows[0].operatingResult, null);
    assert.equal(context.operatingCount, 4);
    assert.equal(context.balanceCount, 5);
    assert.equal(context.checked, 5);
  }
});

test("growth stays available without operating income, but missing and zero revenue denominators are not invented", () => {
  const data = fixture();
  data.metrics.operatingIncome[1].value = null;
  let context = scenarioHistoricalCalibration(data, {}, 0);
  assert.ok(Number.isFinite(context.rows[0].revenueGrowth.point.value));
  assert.equal(context.rows[0].operatingMargin.point.value, null);
  data.metrics.revenue[2].value = 0;
  context = scenarioHistoricalCalibration(data, {}, 0);
  assert.equal(context.rows[0].growthDenominator.point.value, 0);
  assert.equal(context.rows[0].revenueGrowth.point.value, null);
  assert.match(
    context.rows[0].revenueGrowth.point.reason,
    /positive prior-year/,
  );
});

test("banking history reports feasibility gaps under the exact current funding assumptions", () => {
  const data = fixture("banking");
  const context = scenarioHistoricalCalibration(
    data,
    { scenarioFunding: 50 },
    0,
  );
  assert.equal(context.balanceCount, 5);
  assert.ok(Number.isFinite(context.rows[0].equityRatio.point.value));
  assert.equal(context.rows[0].balanceResult, undefined);
  assert.match(context.rows[0].balanceResultReason, /withdrawal|funding|cash/i);
});

test("starter cases match the selected lens and model and reset every known assumption while preserving unrelated settings", () => {
  const data = fixture();
  const prior = {
    ...Object.fromEntries(
      Object.keys(SCENARIO_DEFAULTS).map((key) => [key, 17]),
    ),
    scenarioModel: "cost",
    units: "millions",
    customWorkspaceField: "preserve",
  };
  const cases = scenarioStarterCases(data, prior);
  assert.ok(cases.some((item) => item.id === "cost-inflation"));
  assert.ok(
    !cases.some(
      (item) => item.id === "margin-pressure" || item.id === "deposit-runoff",
    ),
  );
  for (const item of cases) {
    const patch = scenarioStarterPatch(item.id, data, prior);
    for (const key of Object.keys(SCENARIO_DEFAULTS))
      assert.equal(patch[key], item.overrides[key] ?? SCENARIO_DEFAULTS[key]);
    const merged = { ...prior, ...patch };
    assert.equal(merged.customWorkspaceField, "preserve");
    assert.equal(merged.units, "millions");
    assert.equal(merged.scenarioFunding, 0);
    assert.equal(merged.scenarioMargin, 0);
  }
  assert.ok(
    scenarioStarterCases(fixture("banking")).some(
      (item) => item.id === "deposit-runoff",
    ),
  );
  assert.ok(
    !scenarioStarterCases(fixture("insurance")).some(
      (item) => item.id === "demand-pressure",
    ),
  );
  assert.equal(scenarioStarterPatch("unknown", data), null);
});
