import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisScenario } from "../src/utils/analysisScenarios.js";
import { normalizeAnalysisSettings } from "../src/utils/analysisNotebook.js";
import { createScenarioCase, updateScenarioCases } from "../src/utils/analysisScenarioCases.js";
import { buildScenarioRebase } from "../src/utils/analysisScenarioRebase.js";

const annual = (year) => ({ start: `${year}-01-01`, end: `${year}-12-31`, kind: "annual", fp: "FY", label: `FY${year}` });
const tags = { revenue: "Revenues", operatingIncome: "OperatingIncomeLoss", netIncome: "NetIncomeLoss", operatingCashFlow: "NetCashProvidedByUsedInOperatingActivities", capex: "PaymentsToAcquirePropertyPlantAndEquipment", totalAssets: "Assets", stockholdersEquity: "StockholdersEquity", cash: "CashAndCashEquivalentsAtCarryingValue", shortTermDebt: "LongTermDebtCurrent", longTermDebt: "LongTermDebtNoncurrent" };
function company(period = annual(2025), changes = {}) {
  const amounts = { revenue: 1000, operatingIncome: 100, netIncome: 75, operatingCashFlow: 120, capex: 30, totalAssets: 2000, stockholdersEquity: 600, cash: 300, shortTermDebt: 100, longTermDebt: 400, ...changes };
  const filed = `${Number(period.end.slice(0, 4)) + 1}-02-01`;
  return {
    ticker: "TEST", name: "Test company", cik: "1", lens: "corporate", version: "analysis-test-v1", basis: period.kind, asOf: "", observedAt: `${filed}T12:00:00.000Z`, periods: [period],
    definitions: Object.keys(amounts).map((key) => ({ key, label: key, format: "currency" })),
    metrics: Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, [{ value, period, classification: "reported", sources: [{ tag: tags[key], taxonomy: "us-gaap", unit: "USD", value, start: ["revenue", "operatingIncome", "netIncome", "operatingCashFlow", "capex"].includes(key) ? period.start : null, end: period.end, filed, accession: `0000000001-${period.end.slice(2, 4)}-000001` }] }]])),
  };
}
function save(data = company(), input = {}) {
  const settings = normalizeAnalysisSettings({ view: "scenarios", basis: data.basis, scenarioRevenue: -10, ...input });
  return createScenarioCase({ data, settings, index: 0, scenario: buildAnalysisScenario(data, settings, 0), name: "Original reference", id: "original", now: "2026-04-01T12:00:00.000Z" });
}
const compare = (reference, data = company(), input = {}) => {
  const settings = normalizeAnalysisSettings({ ...reference.settings, basis: data.basis, ...input });
  return buildScenarioRebase({ reference, data, settings, index: 0 });
};
const find = (result, key = "operating:OperatingIncome") => result.rows.find((row) => row.key === key);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("Data-first attribution reconciles and preserves the original evidence and assumptions", () => {
  const reference = save();
  const frozen = structuredClone(reference);
  const data = company(annual(2026), { revenue: 1200, operatingIncome: 180 });
  const result = compare(reference, data, { scenarioRevenue: -20 });
  assert.equal(result.compatible, true);
  assert.equal(result.status, "Later comparable reporting period");
  const row = find(result);
  near(row.original, 90); near(row.rebased, 162); near(row.current, 144);
  near(row.dataChange, 72); near(row.assumptionChange, -18); near(row.totalChange, 54);
  near(row.dataChange + row.assumptionChange, row.totalChange);
  assert.equal(row.originalSelection.analysisSettings.end, "2025-12-31");
  assert.equal(row.originalSelection.analysisSettings.scenarioRevenue, -10);
  assert.equal(row.rebasedSelection.analysisSettings.end, "2026-12-31");
  assert.equal(row.rebasedSelection.analysisSettings.scenarioRevenue, -10);
  assert.equal(row.currentSelection.analysisSettings.scenarioRevenue, -20);
  row.originalSelection.point.sources[0].value = -123;
  assert.deepEqual(reference, frozen);
  const updated = createScenarioCase({ data, settings: result.rebasedSettings, index: 0, scenario: result.rebasedScenario, name: "Updated reference", id: "updated" });
  const write = updateScenarioCases([reference], { type: "add", id: updated.id, entry: updated });
  assert.equal(write.ok, true);
  assert.equal(write.cases.length, 2);
  assert.deepEqual(write.cases[0], frozen);
  assert.equal(write.cases[1].settings.scenarioRevenue, -10);
});

test("Unchanged inputs are explicit; changed assumptions alone have zero data effect", () => {
  const reference = save();
  const result = compare(reference, company(), { scenarioRevenue: 10 });
  assert.equal(result.status, "Reported inputs unchanged");
  near(find(result).dataChange, 0);
  near(find(result).assumptionChange, 20);
});

test("Connected cash attribution separates changed cash inputs from working-capital assumptions", () => {
  const reference = save(company(), { scenarioCashMode: "connected", scenarioWorkingCapital: 2 });
  const data = company(annual(2026), { revenue: 1200, operatingIncome: 180, cash: 400 });
  const result = compare(reference, data, { scenarioWorkingCapital: 3 });
  const cash = find(result, "connected:Cash");
  assert.equal(cash.dataReason, null);
  assert.equal(cash.assumptionReason, null);
  near(cash.original, 270); near(cash.rebased, 358); near(cash.current, 346);
  near(cash.dataChange, 88); near(cash.assumptionChange, -12); near(cash.totalChange, 76);
  assert.ok(!result.rows.some((row) => row.key.startsWith("balance:")));
});

test("Company, accounting, data-version, period and chronology boundaries withhold attribution", () => {
  const reference = save();
  for (const patch of [{ ticker: "OTHER" }, { cik: "2" }, { lens: "banking" }, { version: "v2" }]) {
    assert.equal(compare(reference, { ...company(), ...patch }).compatible, false);
  }
  assert.equal(compare(reference, company(annual(2024))).compatible, false);
  const shortPeriod = { start: "2026-07-01", end: "2026-12-31", kind: "annual" };
  assert.match(compare(reference, company(shortPeriod)).reason, /durations/);
  const cutoff = compare(reference, { ...company(), asOf: "2026-01-01" });
  assert.match(cutoff.reason, /cutoff excludes/);
});

test("52/53-week annual windows remain comparable while different quarter seasons do not", () => {
  const oldPeriod = { start: "2024-12-29", end: "2025-12-27", kind: "annual", fp: "FY" };
  const nextPeriod = { start: "2025-12-28", end: "2027-01-02", kind: "annual", fp: "FY" };
  assert.equal(compare(save(company(oldPeriod)), company(nextPeriod)).compatible, true);
  const quarter = { start: "2025-01-01", end: "2025-03-31", kind: "quarter", fp: "Q1" };
  const reference = save(company(quarter));
  const q2 = { start: "2026-04-01", end: "2026-06-30", kind: "quarter", fp: "Q2" };
  assert.match(compare(reference, company(q2)).reason, /same point in the fiscal year/);
  const q1 = { start: "2026-01-01", end: "2026-03-31", kind: "quarter", fp: "Q1" };
  assert.equal(compare(reference, company(q1)).compatible, true);
});

test("Missing or changed concepts, unit, scope and filing dates are never zero-filled", () => {
  const reference = save();
  for (const patch of [{ tag: "RevenueFromContractWithCustomerExcludingAssessedTax" }, { scope: "subsidiary" }]) {
    const data = company(annual(2026));
    Object.assign(data.metrics.revenue[0].sources[0], patch);
    const row = find(compare(reference, data));
    assert.equal(row.dataChange, null);
    assert.match(row.dataReason, /concepts, units, or accounting scope changed/);
  }
  for (const patch of [{ unit: "EUR" }, { filed: "not-a-date" }]) {
    const data = company(annual(2026));
    Object.assign(data.metrics.revenue[0].sources[0], patch);
    const row = find(compare(reference, data));
    assert.equal(row.dataChange, null);
    assert.equal(row.totalChange, null);
  }
  const unavailable = company(annual(2026));
  unavailable.metrics.operatingIncome[0].value = null;
  assert.equal(find(compare(reference, unavailable)).dataChange, null);
  const afterCutoff = company(annual(2026));
  afterCutoff.asOf = "2027-01-15";
  assert.match(find(compare(reference, afterCutoff)).dataReason, /filing cutoff/);
});

test("Model changes preserve data attribution but withhold the assumption effect", () => {
  const reference = save();
  const result = compare(reference, company(annual(2026), { operatingIncome: 200 }), { scenarioModel: "cost" });
  assert.equal(result.modelChanged, true);
  near(find(result).dataChange, 90);
  assert.equal(find(result).assumptionChange, null);
  assert.equal(find(result).totalChange, null);
  assert.match(find(result).assumptionReason, /model changed/);
});

test("Identical reported inputs with a changed calculation cannot masquerade as a data effect", () => {
  const reference = save();
  reference.snapshot.operating.rows.find((row) => row.key === "OperatingIncome").selection.point.value += 5;
  const result = compare(reference);
  assert.equal(find(result).dataChange, null);
  assert.match(find(result).dataReason, /same reported inputs.*different result/);
  const formulaChanged = save();
  formulaChanged.snapshot.operating.rows.find((row) => row.key === "OperatingIncome").selection.point.formula = "Old calculation formula";
  assert.match(find(compare(formulaChanged)).dataReason, /calculation method changed/);
});

test("Malformed retained evidence is rejected without changing stored records", () => {
  const reference = save();
  reference.context.period.end = "invalid";
  const before = structuredClone(reference);
  assert.equal(compare(reference).compatible, false);
  assert.deepEqual(reference, before);
});
