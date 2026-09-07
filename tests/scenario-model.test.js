import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisScenario,
  normalizeScenarioSettings,
  SCENARIO_DEFAULTS,
  SCENARIO_LIMITS,
} from "../src/utils/analysisScenarios.js";
import { labInput } from "../src/utils/analysisFormula.js";

const period = {
  start: "2025-01-01",
  end: "2025-12-31",
  kind: "annual",
  label: "FY2025",
};
function company(lens = "corporate", overrides = {}) {
  const values = {
    revenue: 1000,
    operatingIncome: 100,
    totalAssets: 2000,
    stockholdersEquity: 200,
    cash: 300,
    deposits: 1500,
    ...overrides,
  };
  return {
    ticker: "TEST",
    lens,
    asOf: "2026-03-01",
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
                taxonomy: "us-gaap",
                tag: key,
                value,
                unit: "USD",
                start: ["revenue", "operatingIncome"].includes(key)
                  ? period.start
                  : null,
                end: period.end,
                filed: "2026-02-01",
                accession: "0000000001-26-000001",
                documentUrl:
                  "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm",
              },
            ],
          },
        ],
      ]),
    ),
  };
}
const row = (group, key) =>
  group.rows.find((item) => item.key === key)?.selection.point;
const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} != ${expected}`,
  );

test("Scenario normalization bounds settings without losing target precision or treating blank as an explicit zero", () => {
  assert.deepEqual(normalizeScenarioSettings(null), SCENARIO_DEFAULTS);
  const precise = 100 / 19;
  const settings = normalizeScenarioSettings({
    scenarioLoss: precise,
    scenarioModel: "cost",
    scenarioCashAvailable: "",
    scenarioVariableCost: 1000,
    scenarioCostChange: -90,
    scenarioReplacementFunding: 99,
  });
  assert.equal(settings.scenarioLoss, precise);
  assert.equal(settings.scenarioModel, "cost");
  assert.equal(settings.scenarioCashAvailable, 100);
  assert.equal(settings.scenarioVariableCost, 100);
  assert.equal(settings.scenarioCostChange, -50);
  assert.equal(settings.scenarioReplacementFunding, 50);
  assert.equal(
    normalizeScenarioSettings({ scenarioCashAvailable: 0 })
      .scenarioCashAvailable,
    0,
  );
  assert.deepEqual(SCENARIO_LIMITS.scenarioReplacementFunding, [0, 50]);
});

test("The margin bridge reconciles revenue, margin and interaction effects with source evidence", () => {
  const result = buildAnalysisScenario(
    company(),
    { scenarioRevenue: -10, scenarioMargin: -2 },
    0,
  ).operating;
  assert.equal(result.reason, null);
  assert.equal(row(result, "OperatingIncome").value, 72);
  assert.deepEqual(
    result.bridge.map((item) => item.selection.point.value),
    [-10, -20, 2],
  );
  assert.equal(
    result.bridge.reduce((sum, item) => sum + item.selection.point.value, 0),
    result.delta,
  );
  for (const item of result.bridge) {
    assert.equal(item.baseline, 0);
    assert.equal(item.selection.point.sources.length, 2);
    assert.match(item.selection.point.note, /Revenue change = -10%/);
    assert.match(item.selection.point.note, /not a forecast/);
  }
  assert.doesNotMatch(row(result, "Revenue").formula, /% \/ 100/);
});

test("The cost model reconciles volume first and inflation second without using the margin slider", () => {
  const input = {
    scenarioModel: "cost",
    scenarioRevenue: 10,
    scenarioVariableCost: 60,
    scenarioCostChange: 5,
    scenarioMargin: 20,
  };
  const result = buildAnalysisScenario(company(), input, 0).operating;
  assert.equal(result.reason, null);
  assert.equal(result.costs.baseline, 900);
  assert.equal(result.costs.variable, 540);
  assert.equal(result.costs.fixed, 360);
  close(result.costs.hypothetical, 1001.7);
  close(row(result, "OperatingIncome").value, 98.3);
  close(row(result, "Margin").value, (98.3 / 1100) * 100);
  close(row(result, "OperatingCosts").value, 1001.7);
  const effects = result.bridge.map((item) => item.selection.point.value);
  close(effects[0], 100);
  close(effects[1], -54);
  close(effects[2], -47.7);
  close(
    effects.reduce((sum, value) => sum + value, 0),
    result.delta,
  );
  assert.match(result.bridgeMethod, /then apply/);
  assert.match(
    row(result, "OperatingIncome").note,
    /not reported cost behavior/,
  );
});

test("Zero and fully variable cost assumptions behave distinctly, while loss baselines remain usable", () => {
  const fixed = buildAnalysisScenario(
    company(),
    { scenarioModel: "cost", scenarioRevenue: 10, scenarioVariableCost: 0 },
    0,
  ).operating;
  assert.equal(row(fixed, "OperatingIncome").value, 200);
  const variable = buildAnalysisScenario(
    company(),
    { scenarioModel: "cost", scenarioRevenue: 10, scenarioVariableCost: 100 },
    0,
  ).operating;
  close(row(variable, "OperatingIncome").value, 110);
  const loss = buildAnalysisScenario(
    company("corporate", { operatingIncome: -50 }),
    { scenarioModel: "cost", scenarioRevenue: -10 },
    0,
  ).operating;
  assert.equal(loss.reason, null);
  assert.ok(row(loss, "OperatingIncome").value < 0);
  assert.ok(loss.diagnostics.some((item) => item.key === "operatingLoss"));
  const impossible = buildAnalysisScenario(
    company("corporate", { operatingIncome: 1200 }),
    { scenarioModel: "cost" },
    0,
  ).operating;
  assert.match(impossible.reason, /nonnegative implied/);
  assert.deepEqual(impossible.rows, []);
});

test("Explicit usable-cash and replacement-borrowing assumptions reconcile assets, debt, deposits and protected cash", () => {
  const result = buildAnalysisScenario(
    company("banking"),
    {
      scenarioLoss: 2,
      scenarioFunding: 30,
      scenarioCashAvailable: 50,
      scenarioReplacementFunding: 20,
    },
    0,
  ).balance;
  assert.equal(result.reason, null);
  assert.equal(result.usableCash, 150);
  assert.equal(result.borrowing, 300);
  assert.equal(result.withdrawal, 450);
  assert.equal(result.fundingGap, 0);
  assert.equal(row(result, "Assets").value, 1810);
  assert.equal(row(result, "Equity").value, 160);
  assert.equal(row(result, "Cash").value, 150);
  assert.equal(row(result, "Deposits").value, 1050);
  assert.equal(row(result, "ReplacementFunding").value, 300);
  assert.equal(
    row(result, "Assets").value - row(result, "Equity").value,
    1800 + 300 - 450,
  );
  assert.equal(row(result, "ReplacementFunding").sources[0].tag, "deposits");
  assert.match(row(result, "Assets").note, /interest expense, collateral/);
  assert.deepEqual(result.capacity, {
    cashFundedWithdrawalPct: 10,
    zeroEquityLossPct: 10,
    noncashLossPct: 85,
  });
});

test("A funding shortfall remains explicit, while exact funded boundaries retain reserved cash", () => {
  const data = company("banking");
  const unfunded = buildAnalysisScenario(
    data,
    { scenarioFunding: 30, scenarioCashAvailable: 50 },
    0,
  ).balance;
  assert.equal(unfunded.fundingGap, 300);
  assert.match(unfunded.reason, /usable reported cash/);
  assert.equal(unfunded.rows.length, 0);
  const cashOnly = buildAnalysisScenario(
    data,
    { scenarioFunding: 10, scenarioCashAvailable: 50 },
    0,
  ).balance;
  assert.equal(cashOnly.reason, null);
  assert.equal(row(cashOnly, "Cash").value, 150);
  const borrowedOnly = buildAnalysisScenario(
    data,
    {
      scenarioFunding: 10,
      scenarioCashAvailable: 0,
      scenarioReplacementFunding: 10,
    },
    0,
  ).balance;
  assert.equal(borrowedOnly.reason, null);
  assert.equal(row(borrowedOnly, "Cash").value, 300);
});

test("Unknown funding inputs do not erase a separately valid zero-funding asset-loss exercise", () => {
  const data = company("banking");
  delete data.metrics.cash;
  delete data.metrics.deposits;
  const result = buildAnalysisScenario(data, { scenarioLoss: 5 }, 0).balance;
  assert.equal(result.reason, null);
  assert.equal(result.funding.available, false);
  assert.match(result.funding.reason, /unavailable/);
  assert.equal(row(result, "Assets").value, 1900);
  assert.equal(row(result, "Equity").value, 100);
  assert.equal(result.nextCash, null);
  assert.equal(result.capacity.noncashLossPct, null);
  assert.equal(result.capacity.cashFundedWithdrawalPct, null);
  assert.equal(row(result, "Cash"), undefined);
  assert.equal(row(result, "Assets").sources.length, 2);
  assert.match(
    row(result, "Assets").note,
    /missing balances are not assumed to be zero/,
  );
  assert.notEqual(
    buildAnalysisScenario(data, { scenarioFunding: 1 }, 0).balance.reason,
    null,
  );
});

test("Noncash losses respect known noncash assets for every lens and reject contradictory cash scope", () => {
  for (const lens of ["corporate", "banking", "insurance"]) {
    const data = company(lens, {
      totalAssets: 100,
      stockholdersEquity: 10,
      cash: 95,
      deposits: 90,
    });
    const result = buildAnalysisScenario(data, { scenarioLoss: 10 }, 0).balance;
    assert.match(result.reason, /exceeds reported noncash/);
    assert.equal(result.capacity.noncashLossPct, 5);
    const boundary = buildAnalysisScenario(
      data,
      { scenarioLoss: 5 },
      0,
    ).balance;
    assert.equal(boundary.reason, null);
    assert.equal(row(boundary, "Assets").value, 95);
  }
  assert.match(
    buildAnalysisScenario(company("banking", { cash: 2100 }), {}, 0).balance
      .reason,
    /cannot exceed total assets/,
  );
});

test("Large finite arithmetic avoids intermediate overflow; unsupported results expose a reason", () => {
  const large = company("corporate", {
    revenue: 1e308,
    operatingIncome: 1e308,
    totalAssets: 1e308,
    stockholdersEquity: 1e307,
    cash: 1e307,
  });
  const result = buildAnalysisScenario(
    large,
    { scenarioRevenue: 50, scenarioLoss: 20 },
    0,
  );
  assert.equal(result.operating.reason, null);
  assert.equal(row(result.operating, "OperatingIncome").value, 1.5e308);
  assert.equal(result.balance.reason, null);
  close(result.balance.loss, 2e307);
  const overflow = buildAnalysisScenario(
    company("corporate", { revenue: 1.7e308, operatingIncome: 1.7e308 }),
    { scenarioRevenue: 50 },
    0,
  ).operating;
  assert.match(overflow.reason, /numerical range/);
  assert.deepEqual(overflow.rows, []);
  assert.deepEqual(overflow.bridge, []);
});

test("Full-precision reverse-loss settings reproduce the chosen equity-ratio target", () => {
  const assetLoss = (200 - 0.05 * 2000) / (1 - 0.05);
  const result = buildAnalysisScenario(
    company(),
    { scenarioLoss: (assetLoss / 2000) * 100 },
    0,
  );
  close(row(result.balance, "EquityAssets").value, 5, 1e-12);
});

test("Inputs reject nonfinite raw evidence and invalid/reversed dates even on calculated flows", () => {
  for (const invalid of [null, undefined, Infinity, "1000"]) {
    const data = company();
    data.metrics.revenue[0].sources[0].value = invalid;
    assert.match(labInput(data, "revenue", 0).reason, /finite numeric value/);
  }
  for (const sourceDate of ["bad", "2025-02-30", "2026-01-01"]) {
    const data = company();
    const point = data.metrics.revenue[0];
    point.classification = "calculated";
    point.formula = "Annual less prior YTD";
    point.sources[0].start = sourceDate;
    assert.match(labInput(data, "revenue", 0).reason, /source date/);
  }
  for (const sourceDate of ["", "bad", "2025-02-30", "2024-12-31"]) {
    const data = company();
    const point = data.metrics.revenue[0];
    point.classification = "calculated";
    point.formula = "Annual less prior YTD";
    point.sources[0].end = sourceDate;
    assert.match(labInput(data, "revenue", 0).reason, /source date/);
  }
  const reversed = company();
  reversed.periods = [{ ...period, start: "2026-01-01" }];
  reversed.metrics.revenue[0].period = reversed.periods[0];
  assert.match(
    labInput(reversed, "revenue", 0).reason,
    /reporting period.*reversed/,
  );
});

test("Legitimate derived reporting windows retain their evidence and scenario builders never mutate sources or settings", () => {
  const data = company();
  const quarter = { ...period, kind: "quarter", start: "2025-10-01" };
  data.periods = [quarter];
  for (const [key, points] of Object.entries(data.metrics)) {
    points[0].period = quarter;
    if (["revenue", "operatingIncome"].includes(key)) {
      points[0].classification = "calculated";
      points[0].formula = "Annual less prior YTD";
      points[0].sources.push({
        ...points[0].sources[0],
        value: 50,
        end: "2025-09-30",
        accession: "0000000001-25-000001",
      });
    }
  }
  const before = structuredClone(data);
  const input = Object.freeze({ scenarioModel: "cost", scenarioRevenue: 10 });
  const result = buildAnalysisScenario(data, input, 0);
  assert.equal(result.operating.reason, null);
  assert.equal(row(result.operating, "OperatingIncome").sources.length, 4);
  assert.ok(row(result.operating, "OperatingIncome").calculations.length >= 2);
  assert.deepEqual(data, before);
});
