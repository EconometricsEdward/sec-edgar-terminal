import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisScenario, normalizeScenarioSettings, SCENARIO_DEFAULTS } from "../src/utils/analysisScenarios.js";
import { validateScenarioDrafts } from "../src/utils/analysisScenarioEditing.js";

const annual = { start: "2025-01-01", end: "2025-12-31", kind: "annual" };
function company(period = annual) {
  const fields = [
    ["revenue", 1000, "RevenueFromContractWithCustomerExcludingAssessedTax", "flow"],
    ["operatingIncome", 200, "OperatingIncomeLoss", "flow"],
    ["netIncome", 120, "NetIncomeLoss", "flow"],
    ["operatingCashFlow", 180, "NetCashProvidedByUsedInOperatingActivities", "flow"],
    ["capex", 60, "PaymentsToAcquirePropertyPlantAndEquipment", "flow"],
    ["cash", 100, "CashAndCashEquivalentsAtCarryingValue", "balance"],
    ["totalAssets", 800, "Assets", "balance"],
    ["stockholdersEquity", 300, "StockholdersEquity", "balance"],
    ["shortTermDebt", 50, "DebtCurrent", "balance"],
    ["longTermDebt", 200, "LongTermDebtNoncurrent", "balance"],
  ];
  return {
    lens: "corporate", ticker: "TEST", periods: [period],
    definitions: fields.map(([key]) => ({ key, label: key, format: "currency" })),
    metrics: Object.fromEntries(fields.map(([key, value, tag, basis]) => [key, [{ value, period, classification: "reported", sources: [{ taxonomy: "us-gaap", tag, value, unit: "USD", start: basis === "flow" ? period.start : null, end: period.end, accession: "0000000001-26-000001", documentUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm" }] }]])),
  };
}
const run = (settings = {}, data = company()) => buildAnalysisScenario(data, { scenarioCashMode: "connected", ...settings }, 0).connected;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} should equal ${b}`);
const row = (scenario, key) => scenario.rows.find((item) => item.key === key).selection.point;
function setValue(data, key, value) {
  data.metrics[key][0].value = value;
  data.metrics[key][0].sources[0].value = value;
}

test("connected model is optional and zero changes preserve the reported ending baseline", () => {
  const independent = buildAnalysisScenario(company(), {}, 0);
  assert.equal(independent.connected.enabled, false);
  assert.deepEqual(independent.connected.rows, []);
  const output = run();
  assert.equal(output.reason, null);
  assert.equal(output.periodDays, 365);
  assert.deepEqual(Object.fromEntries(["netIncome", "operatingCashFlow", "capex", "freeCashFlow", "cash", "debt", "assets", "equity", "fundingGap"].map((key) => [key, output.metrics[key]])), { netIncome: 120, operatingCashFlow: 180, capex: 60, freeCashFlow: 120, cash: 100, debt: 250, assets: 800, equity: 300, fundingGap: 0 });
  assert.equal(output.metrics.cashDelta, 0);
  assert.match(output.note, /never added to ending cash again/);
});

test("connected operating, cash and financing deltas reconcile without turning borrowed cash into income", () => {
  const output = run({ scenarioRevenue: -10, scenarioWorkingCapital: 2, scenarioCapexChange: 25, scenarioBorrowing: 8, scenarioDebtRepayment: 10, scenarioBorrowRate: 5 });
  const m = output.metrics;
  close(m.operatingDelta, -20);
  close(m.interest, 4);
  close(m.tax, 0);
  close(m.netIncome, 96);
  close(m.operatingCashFlow, 136);
  close(m.capex, 75);
  close(m.freeCashFlow, 61);
  close(m.cash, 96);
  close(m.debt, 305);
  close(m.assets, 831);
  close(m.equity, 276);
  close(m.assets - 800, m.equity - 300 + m.debt - 250);
  close(m.cashDelta, output.bridge.reduce((sum, item) => sum + item.selection.point.value, 0));
  close(m.noncashAssetDelta, 35);
  assert.ok(row(output, "Cash").sources.some((source) => source.tag === "DebtCurrent"));
  assert.match(row(output, "Cash").note, /tax on positive incremental pretax earnings 25%/);
});

test("tax applies only to positive incremental pretax earnings with no decline benefit", () => {
  const upside = run({ scenarioRevenue: 10, scenarioTaxRate: 25 }).metrics;
  const downside = run({ scenarioRevenue: -10, scenarioTaxRate: 25 }).metrics;
  close(upside.tax, 5);
  close(upside.netIncome, 135);
  close(upside.cash, 115);
  close(downside.tax, 0);
  close(downside.netIncome, 100);
  close(downside.cash, 80);
});

test("new borrowing adds debt and cash equally while capex changes cash and PP&E, not equity", () => {
  const financed = run({ scenarioBorrowing: 10 }).metrics;
  close(financed.cash, 200);
  close(financed.debt, 350);
  close(financed.assets, 900);
  close(financed.equity, 300);
  close(financed.netIncome, 120);
  const invested = run({ scenarioCapexChange: 50 }).metrics;
  close(invested.cash, 70);
  close(invested.assets, 800);
  close(invested.equity, 300);
  close(invested.noncashAssetDelta, 30);
});

test("annual borrowing interest uses the inclusive actual reporting duration, including leap days", () => {
  for (const [period, days] of [[{ start: "2024-01-01", end: "2024-12-31", kind: "annual" }, 366], [{ start: "2025-01-01", end: "2025-03-31", kind: "quarter" }, 90]]) {
    const output = run({ scenarioBorrowing: 10, scenarioBorrowRate: 10 }, company(period));
    assert.equal(output.periodDays, days);
    close(output.metrics.interest, 100 * 0.1 * days / 365);
  }
});

test("missing debt does not become zero and only blocks cash when repayment depends on it", () => {
  const data = company();
  delete data.metrics.shortTermDebt;
  const noRepayment = run({}, data);
  assert.equal(noRepayment.metrics.debt, null);
  assert.equal(noRepayment.metrics.cash, 100);
  const repaying = run({ scenarioDebtRepayment: 10 }, data);
  assert.equal(repaying.metrics.cash, null);
  assert.equal(repaying.metrics.operatingCashFlow, 180);
  assert.match(row(repaying, "Cash").reason, /unavailable|available/);
});

test("missing capex with no capex adjustment preserves known cash changes without fabricating FCF", () => {
  const data = company();
  delete data.metrics.capex;
  const untouched = run({}, data);
  assert.equal(untouched.metrics.cash, 100);
  assert.equal(untouched.metrics.capex, null);
  assert.equal(untouched.metrics.freeCashFlow, null);
  assert.equal(run({ scenarioCapexChange: 10 }, data).metrics.cash, null);
});

test("negative cash exposes an unfunded gap and withholds a feasible funded balance", () => {
  const output = run({ scenarioWorkingCapital: 20 });
  assert.equal(output.metrics.cash, -100);
  assert.equal(output.metrics.fundingGap, 100);
  assert.equal(output.metrics.assets, null);
  assert.equal(output.metrics.equityAssets, null);
  assert.match(row(output, "Assets").reason, /unfunded shortfall/);
  const financed = run({ scenarioWorkingCapital: 20, scenarioBorrowing: 10 });
  assert.equal(financed.metrics.cash, 0);
  assert.equal(financed.metrics.fundingGap, 0);
  assert.equal(financed.metrics.assets, 900);
});

test("accounting scopes, noncash asset capacity and overlapping debt tags are checked", () => {
  const data = company();
  data.metrics.netIncome[0].sources[0].tag = "ProfitLoss";
  const mixed = run({}, data);
  assert.equal(mixed.metrics.equity, null);
  assert.equal(mixed.metrics.equityAssets, null);
  assert.equal(mixed.metrics.cash, 100);
  assert.match(row(mixed, "Equity").reason, /matching parent or consolidated/);
  data.metrics.stockholdersEquity[0].sources[0].tag = "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest";
  assert.equal(run({}, data).metrics.equity, 300);
  data.metrics.longTermDebt[0].sources[0].tag = "LongTermDebt";
  assert.equal(run({ scenarioDebtRepayment: 10 }, data).metrics.cash, null);
  const smallAssets = company();
  setValue(smallAssets, "totalAssets", 200);
  const invalidRelease = run({ scenarioWorkingCapital: -20 }, smallAssets);
  assert.equal(invalidRelease.metrics.cash, null);
  assert.match(row(invalidRelease, "Cash").reason, /exceed reported noncash assets/);
});

test("missing, incompatible and nonfinite source inputs withhold their dependent results", () => {
  for (const mutate of [
    (data) => { data.metrics.cash[0].sources[0].unit = "EUR"; },
    (data) => { data.metrics.cash[0].sources[0].tag = "Cash"; },
    (data) => { data.metrics.cash[0].sources[0].end = "2024-12-31"; },
    (data) => { setValue(data, "cash", NaN); },
    (data) => { setValue(data, "cash", 900); },
  ]) {
    const data = company(); mutate(data);
    assert.equal(run({}, data).metrics.cash, null);
  }
  const differentPeriod = company();
  differentPeriod.metrics.operatingCashFlow[0].period = { ...annual, start: "2025-04-01" };
  const output = run({}, differentPeriod);
  assert.equal(output.metrics.operatingCashFlow, null);
  assert.equal(output.metrics.freeCashFlow, null);
  assert.equal(output.metrics.cash, 100);
});

test("separate loss is excluded, bank models remain independent, and repayment is bounded", () => {
  assert.equal(run({ scenarioLoss: 20 }).metrics.equity, 300);
  assert.ok(run({ scenarioLoss: 20 }).diagnostics.some((item) => item.key === "separateLossExcluded"));
  assert.match(run({}, { ...company(), lens: "banking" }).reason, /operating companies only/);
  const output = run({ scenarioDebtRepayment: 200, scenarioBorrowing: 25 });
  assert.equal(output.metrics.repayment, 250);
  assert.equal(output.metrics.debt, 250);
});

test("stale connected settings fall back to independent bank and insurer balances without corporate earnings", () => {
  for (const lens of ["banking", "insurance"]) {
    const data = { ...company(), lens };
    const independent = buildAnalysisScenario(data, { scenarioLoss: 10 }, 0);
    const stale = buildAnalysisScenario(data, { scenarioCashMode: "connected", scenarioLoss: 10, scenarioRevenue: -20, scenarioBorrowing: 50 }, 0);
    assert.equal(stale.connected.enabled, false);
    assert.match(stale.connected.reason, /independent balance exercise remains active/);
    assert.equal(stale.operating, null);
    assert.deepEqual(stale.connected.rows, []);
    assert.deepEqual(stale.connected.metrics, {});
    assert.deepEqual(stale.balance.rows.map((item) => [item.key, item.selection.point.value]), independent.balance.rows.map((item) => [item.key, item.selection.point.value]));
    assert.equal(stale.balance.rows.find((item) => item.key === "Equity").selection.point.value, 220);
  }
});

test("connected settings normalize safely and strict drafts retain invalid entries as errors", () => {
  assert.equal(SCENARIO_DEFAULTS.scenarioCashMode, "independent");
  assert.equal(normalizeScenarioSettings({ scenarioTaxRate: Infinity }).scenarioTaxRate, 25);
  assert.equal(normalizeScenarioSettings({ scenarioWorkingCapital: -99 }).scenarioWorkingCapital, -50);
  assert.equal(normalizeScenarioSettings({ scenarioCashMode: "forecast" }).scenarioCashMode, "independent");
  assert.equal(validateScenarioDrafts({ scenarioCashMode: "connected", scenarioTaxRate: "30", scenarioWorkingCapital: "-5" }).valid, true);
  assert.equal(validateScenarioDrafts({ scenarioCashMode: "unsupported" }).valid, false);
  assert.equal(validateScenarioDrafts({ scenarioBorrowRate: "31" }).valid, false);
  assert.equal(validateScenarioDrafts({ scenarioDebtRepayment: "" }).valid, false);
});

test("floating point cash and noncash boundaries tolerate only relative arithmetic residuals", () => {
  const data = company();
  setValue(data, "cash", 0.51);
  const boundary = run({ scenarioWorkingCapital: 0.051000000000000004 }, data);
  assert.equal(boundary.metrics.cash, 0);
  assert.equal(boundary.metrics.fundingGap, 0);
  assert.equal(boundary.metrics.assets, 800);
  const realDeficit = run({ scenarioWorkingCapital: 0.05100001 }, data);
  assert.ok(realDeficit.metrics.cash < 0);
  assert.ok(realDeficit.metrics.fundingGap > 0);
  assert.equal(realDeficit.metrics.assets, null);
  setValue(data, "cash", 1e-20);
  const tinyButReal = run({ scenarioWorkingCapital: 2e-21 }, data);
  assert.ok(tinyButReal.metrics.cash < 0);
  assert.ok(tinyButReal.metrics.fundingGap > 0);
  setValue(data, "cash", 799.49);
  const releaseBoundary = run({ scenarioWorkingCapital: -0.051000000000000004 }, data);
  assert.equal(releaseBoundary.metrics.assets, 800);
  close(releaseBoundary.metrics.cash, 800);
});

test("connected cost-model earnings use the same operating result and preserve equity/debt reconciliation", () => {
  const output = run({ scenarioModel: "cost", scenarioRevenue: -10, scenarioVariableCost: 60, scenarioCostChange: 2, scenarioBorrowing: 5 });
  const operation = buildAnalysisScenario(company(), { scenarioModel: "cost", scenarioRevenue: -10, scenarioVariableCost: 60, scenarioCostChange: 2 }, 0).operating;
  close(output.metrics.operatingDelta, operation.delta);
  close(output.metrics.assets - 800, output.metrics.equity - 300 + output.metrics.debt - 250);
});
