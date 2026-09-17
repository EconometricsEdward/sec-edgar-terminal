import test from "node:test";
import assert from "node:assert/strict";
import { buildScenarioCalibration } from "../src/utils/analysisScenarioCalibration.js";
import { buildScenarioDriverRanking } from "../src/utils/analysisScenarioDriverRanking.js";

function company(lens = "corporate", kind = "annual") {
  const periods = Array.from({ length: 8 }, (_, i) => ({ kind, fy: 2025 - i, fp: kind === "annual" ? "FY" : "Q2", start: `${2025 - i}-${kind === "annual" ? "01" : "04"}-01`, end: `${2025 - i}-${kind === "annual" ? "12-31" : "06-30"}` }));
  const values = { revenue: [1000, 900, 800, 700, 600, 500, 400, 300], operatingIncome: [300, 225, 160, 154, 108, 50, 20, 0], totalAssets: Array(8).fill(2000), stockholdersEquity: Array(8).fill(200), cash: Array(8).fill(300), deposits: Array(8).fill(1500) };
  return { ticker: "TEST", lens, basis: kind, asOf: "2026-03-01", periods,
    definitions: Object.keys(values).map((key) => ({ key, label: key, format: "currency", category: ["revenue", "operatingIncome"].includes(key) ? "income" : "balance" })),
    metrics: Object.fromEntries(Object.entries(values).map(([key, series]) => [key, series.map((value, i) => ({ value, period: periods[i], classification: "reported", sources: [{ taxonomy: "us-gaap", tag: key, unit: "USD", value, start: ["revenue", "operatingIncome"].includes(key) ? periods[i].start : null, end: periods[i].end, filed: `${periods[i].fy + 1}-02-01`, accession: `0000000001-${String(periods[i].fy + 1).slice(-2)}-000001` }] }))])),
  };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("calibration summarizes observed revenue and margin changes, not margin levels or hypothetical edits", () => {
  const data = company();
  const result = buildScenarioCalibration(data, { scenarioRevenue: -50, scenarioMargin: -20 }, 0);
  assert.equal(result.revenue.count, 5);
  near(result.revenue.min, 12.5); near(result.revenue.max, 25); near(result.revenue.median, 100 / 6);
  assert.equal(result.margin.count, 4);
  assert.deepEqual(result.margin.observations.map((row) => row.value), [5, -2, 4, 8]);
  assert.equal(result.margin.min, -2); assert.equal(result.margin.max, 8); assert.equal(result.margin.median, 4.5);
  assert.equal(result.margin.unit, "pp");
  assert.ok(result.margin.observations.every((row) => row.period.end < data.periods[0].end));
  assert.equal(result.margin.observations[0].selection.point.sources.length, 4);
  assert.deepEqual(result, buildScenarioCalibration(data, { scenarioRevenue: 50, scenarioMargin: 20 }, 0));
});

test("calibration keeps same-season dates and excludes later observations under an older selected baseline", () => {
  const data = company("corporate", "quarter");
  const result = buildScenarioCalibration(data, {}, 2);
  assert.ok(result.revenue.observations.every((row) => row.period.fp === "Q2" && row.period.end < "2023-06-30"));
  assert.equal(result.revenue.observations[0].before.end, "2021-06-30");
  assert.equal(result.margin.observations[0].before.end, "2021-06-30");
});

test("calibration retains reasons for unavailable, incompatible and post-cutoff evidence", () => {
  const data = company();
  data.metrics.operatingIncome[2].value = null;
  data.metrics.revenue[4].sources[0].tag = "DifferentRevenue";
  data.metrics.revenue[5].sources[0].filed = "2026-05-01";
  const result = buildScenarioCalibration(data, {}, 0);
  assert.equal(result.margin.observations[0].value, null);
  assert.equal(result.margin.observations[1].value, null);
  assert.match(result.revenue.observations[3].reason, /concepts differ/);
  assert.match(result.revenue.observations[4].reason, /cutoff/);
  assert.ok(result.margin.omitted > 0);
});

test("calibration never bridges missing fiscal years or treats no history as zero", () => {
  const data = company();
  data.periods.splice(2, 1);
  for (const series of Object.values(data.metrics)) series.splice(2, 1);
  const result = buildScenarioCalibration(data, {}, 0);
  assert.equal(result.revenue.count, 0); assert.equal(result.margin.count, 0);
  assert.equal(result.margin.median, null);
  assert.match(result.margin.reason, /not skipped/);
  assert.equal(buildScenarioCalibration(company("banking"), {}, 0).margin, null);
});

test("driver endpoints rank changes around the committed margin model with their explicit tested ranges", () => {
  const result = buildScenarioDriverRanking(company(), { scenarioRevenue: -10, scenarioMargin: -2 }, 0);
  near(result.current.value, 252);
  const margin = result.drivers.find((row) => row.key === "scenarioMargin");
  assert.equal(margin.low, -4); assert.equal(margin.high, 0);
  near(margin.lower.delta, -18); near(margin.upper.delta, 18);
  const revenue = result.drivers.find((row) => row.key === "scenarioRevenue");
  near(revenue.lower.delta, -14); near(revenue.upper.delta, 14);
  assert.equal(result.drivers[0].key, "scenarioMargin");
  assert.equal(margin.lower.selection.analysisSettings.scenarioRevenue, -10);
  assert.equal(margin.lower.selection.analysisSettings.scenarioMargin, -4);
  assert.match(result.note, /not additive/);
});

test("cost model ranks variable share and cost changes while excluding the inactive margin knob", () => {
  const result = buildScenarioDriverRanking(company(), { scenarioModel: "cost", scenarioRevenue: -10, scenarioMargin: 20 }, 0);
  assert.deepEqual(new Set(result.drivers.map((row) => row.key)), new Set(["scenarioRevenue", "scenarioVariableCost", "scenarioCostChange"]));
  const share = result.drivers.find((row) => row.key === "scenarioVariableCost");
  near(share.lower.delta, -7); near(share.upper.delta, 7);
  const noVolumeChange = buildScenarioDriverRanking(company(), { scenarioModel: "cost" }, 0);
  assert.equal(noVolumeChange.drivers.find((row) => row.key === "scenarioVariableCost").magnitude, 0);
});

test("bank driver exploration includes usable cash and replacement borrowing, preserving infeasible funding reasons", () => {
  const result = buildScenarioDriverRanking(company("banking"), { scenarioFunding: 20 }, 0, { outcome: "Cash" });
  const cash = result.drivers.find((row) => row.key === "scenarioCashAvailable");
  assert.equal(cash.low, 90); assert.equal(cash.high, 100);
  assert.equal(cash.lower.value, null); assert.equal(cash.magnitude, null);
  assert.match(cash.lower.reason, /usable reported cash/);
  const borrowing = result.drivers.find((row) => row.key === "scenarioReplacementFunding");
  near(borrowing.upper.delta, 75); near(borrowing.lower.delta, 0);
  assert.ok(result.drivers.some((row) => row.key === "scenarioFunding"));
});

test("editable shock ranges change ranking, retain bounds, and reject invalid ranges instead of inventing zero effects", () => {
  const data = company();
  const result = buildScenarioDriverRanking(data, {}, 0, { ranges: { scenarioRevenue: { low: -50, high: 50 } } });
  assert.equal(result.drivers[0].key, "scenarioRevenue");
  near(result.drivers[0].magnitude, 150);
  for (const range of [{ low: -51, high: 10 }, { low: 0, high: 0 }, { low: NaN, high: 10 }, { low: 5, high: 10 }]) {
    const invalid = buildScenarioDriverRanking(data, {}, 0, { ranges: { scenarioRevenue: range } }).drivers.find((row) => row.key === "scenarioRevenue");
    assert.equal(invalid.magnitude, null); assert.equal(invalid.lower.value, null);
    assert.match(invalid.rangeReason, /distinct low and high/);
  }
  const boundary = buildScenarioDriverRanking(data, { scenarioRevenue: -50 }, 0).drivers.find((row) => row.key === "scenarioRevenue");
  assert.equal(boundary.low, -50); assert.equal(boundary.high, -45);
});

test("unavailable committed outcome never creates ranked deltas from alternative endpoints", () => {
  const data = company();
  data.metrics.operatingIncome[0].value = null;
  const result = buildScenarioDriverRanking(data, {}, 0);
  assert.equal(result.current.value, null);
  assert.ok(result.drivers.every((row) => row.magnitude === null && row.lower.delta === null && row.upper.delta === null));
});

function connectedCompany() {
  const data = company();
  const period = data.periods[0];
  data.metrics.cash[0].sources[0].tag = "CashAndCashEquivalentsAtCarryingValue";
  data.metrics.stockholdersEquity[0].sources[0].tag = "StockholdersEquity";
  const fields = [
    ["netIncome", 200, "NetIncomeLoss", true],
    ["operatingCashFlow", 240, "NetCashProvidedByUsedInOperatingActivities", true],
    ["capex", 60, "PaymentsToAcquirePropertyPlantAndEquipment", true],
    ["shortTermDebt", 50, "DebtCurrent", false],
    ["longTermDebt", 200, "LongTermDebtNoncurrent", false],
  ];
  for (const [key, value, tag, flow] of fields) {
    data.definitions.push({ key, label: key, format: "currency" });
    data.metrics[key] = [{ value, period, classification: "reported", sources: [{ taxonomy: "us-gaap", tag, value, unit: "USD", start: flow ? period.start : null, end: period.end, filed: "2026-02-01", accession: "0000000001-26-000001" }] }];
  }
  return data;
}

test("connected ranking carries operating changes into cash and tests tax, working capital, investment, and financing", () => {
  const data = connectedCompany();
  const result = buildScenarioDriverRanking(data, { scenarioCashMode: "connected", scenarioRevenue: 10, scenarioLoss: 10 }, 0, { exercise: "connected", outcome: "Cash" });
  near(result.current.value, 322.5);
  const get = (key) => result.drivers.find((row) => row.key === key);
  assert.equal(get("scenarioLoss"), undefined);
  near(get("scenarioTaxRate").lower.delta, 1.5);
  near(get("scenarioTaxRate").upper.delta, -1.5);
  near(get("scenarioWorkingCapital").lower.delta, 50);
  near(get("scenarioWorkingCapital").upper.delta, -50);
  near(get("scenarioCapexChange").lower.delta, 6);
  near(get("scenarioCapexChange").upper.delta, -6);
  near(get("scenarioBorrowing").upper.delta, 50);
  near(get("scenarioDebtRepayment").upper.delta, -12.5);
  assert.equal(get("scenarioBorrowRate").magnitude, 0);
  assert.equal(get("scenarioBorrowing").upper.selection.analysisSettings.scenarioCashMode, "connected");
});

test("connected driver ranking preserves partial availability and never ranks unsupported debt as zero", () => {
  const data = connectedCompany();
  delete data.metrics.longTermDebt;
  const cash = buildScenarioDriverRanking(data, { scenarioCashMode: "connected" }, 0, { exercise: "connected", outcome: "Cash" });
  near(cash.current.value, 300);
  assert.equal(cash.drivers.find((row) => row.key === "scenarioDebtRepayment").upper.value, null);
  assert.ok(cash.drivers.find((row) => row.key === "scenarioBorrowing").magnitude > 0);
  const debt = buildScenarioDriverRanking(data, { scenarioCashMode: "connected" }, 0, { exercise: "connected", outcome: "Debt" });
  assert.equal(debt.current.value, null);
  assert.ok(debt.drivers.every((row) => row.magnitude === null));
});
