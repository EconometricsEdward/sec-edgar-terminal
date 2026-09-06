import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFormulaPoint,
  buildFormulaHistory,
  normalizeFormulaSettings,
  FORMULA_DEFAULTS,
} from "../src/utils/analysisFormula.js";
import {
  buildAnalysisScenario,
  normalizeScenarioSettings,
} from "../src/utils/analysisScenarios.js";

const period = {
  start: "2025-01-01",
  end: "2025-12-31",
  kind: "annual",
  label: "FY2025",
};
function data(lens = "corporate") {
  const rows = [
    ["revenue", "Revenue", "income", 1000],
    ["operatingIncome", "Operating income", "income", 100],
    ["netIncome", "Net income", "income", 50],
    ["operatingCashFlow", "Operating cash flow", "cashflow", 80],
    ["capex", "PP&E purchases", "cashflow", 30],
    ["totalAssets", "Total assets", "balance", 2000],
    ["stockholdersEquity", "Shareholder equity", "balance", 200],
    ["totalLiabilities", "Total liabilities", "balance", 1800],
    ["cash", "Cash", "balance", 300],
    ["deposits", "Deposits", "balance", 1500],
  ];
  return {
    ticker: "TEST",
    lens,
    periods: [period],
    definitions: rows.map(([key, label, category]) => ({
      key,
      label,
      category,
      format: "currency",
    })),
    metrics: Object.fromEntries(
      rows.map(([key, label, category, value]) => [
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
                label,
                value,
                unit: "USD",
                start: category === "balance" ? null : period.start,
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
const metric = (scenario, key) =>
  scenario.balance.rows.find((r) => r.key === key).selection.point;

test("Custom formula computes a sourced free-cash-flow margin and preserves explicit zero", () => {
  const company = data();
  const result = buildFormulaPoint(company, FORMULA_DEFAULTS, 0);
  assert.equal(result.point.value, 5);
  assert.equal(result.point.classification, "calculated");
  assert.equal(result.point.sources.length, 3);
  assert.equal(result.definition.format, "percent");
  company.metrics.capex[0].value = 0;
  assert.equal(buildFormulaPoint(company, FORMULA_DEFAULTS, 0).point.value, 8);
  company.metrics.capex[0].value = null;
  assert.equal(
    buildFormulaPoint(company, FORMULA_DEFAULTS, 0).point.value,
    null,
  );
});
test("Custom formula rejects mismatched dates, source currency, and dimensional additions", () => {
  const company = data();
  assert.match(
    buildFormulaPoint(
      company,
      { formulaA: "totalAssets", formulaB: "netIncome", formulaOp: "add" },
      0,
    ).point.reason,
    /measurement basis/,
  );
  company.metrics.capex[0].period = { ...period, end: "2024-12-31" };
  assert.match(
    buildFormulaPoint(company, FORMULA_DEFAULTS, 0).point.reason,
    /reporting period/,
  );
  company.metrics.capex[0].period = period;
  company.metrics.capex[0].sources[0].unit = "EUR";
  assert.match(
    buildFormulaPoint(company, FORMULA_DEFAULTS, 0).point.reason,
    /USD/,
  );
});
test("Custom ratios reject zero and negative denominators and never annualize a flow", () => {
  const company = data();
  const settings = {
    formulaA: "netIncome",
    formulaB: "totalAssets",
    formulaOp: "ratio",
    formulaScale: "multiple",
  };
  const result = buildFormulaPoint(company, settings, 0);
  assert.equal(result.point.value, 0.025);
  assert.match(result.point.note, /period flow divided by ending balance/);
  assert.match(result.point.note, /without annualization/);
  for (const value of [0, -100]) {
    company.metrics.totalAssets[0].value = value;
    assert.match(
      buildFormulaPoint(company, settings, 0).point.reason,
      /positive denominator/,
    );
  }
});
test("Formula history retains unavailable periods and intermediate source calculations", () => {
  const company = data();
  company.periods.push({ ...period, start: "2024-01-01", end: "2024-12-31" });
  company.metrics.operatingCashFlow[0].formula =
    "Reported CFO adjusted for reported split";
  const history = buildFormulaHistory(company, FORMULA_DEFAULTS);
  assert.equal(history.length, 2);
  assert.equal(history[1].point.value, null);
  assert.equal(
    history[0].point.calculations[0].formula,
    "Reported CFO adjusted for reported split",
  );
});
test("Formula inputs are bounded keys and whitelisted operators, never executable expressions", () => {
  const settings = normalizeFormulaSettings({
    formulaA: "revenue);throw Error()",
    formulaOp: "eval",
    formulaScale: "code",
    formulaB: "totalAssets",
  });
  assert.equal(settings.formulaA, FORMULA_DEFAULTS.formulaA);
  assert.equal(settings.formulaOp, "subtractRatio");
  assert.equal(settings.formulaScale, "percent");
  assert.equal(settings.formulaB, "totalAssets");
  assert.deepEqual(
    normalizeScenarioSettings({
      scenarioRevenue: "Infinity",
      scenarioMargin: -90,
      scenarioLoss: 90,
      scenarioFunding: 12.345,
    }),
    {
      scenarioRevenue: 0,
      scenarioMargin: -20,
      scenarioLoss: 20,
      scenarioFunding: 12.35,
    },
  );
});
test("Corporate operating sensitivity keeps percentage changes distinct from margin percentage points", () => {
  const result = buildAnalysisScenario(
    data(),
    { scenarioRevenue: -10, scenarioMargin: -2 },
    0,
  );
  const rows = result.operating.rows;
  assert.equal(rows[0].selection.point.value, 900);
  assert.equal(rows[1].selection.point.value, 8);
  assert.equal(rows[2].selection.point.value, 72);
  assert.equal(metric(result, "Assets").value, 2000);
  assert.equal(metric(result, "Equity").value, 200);
  assert.match(rows[2].selection.definition.label, /Hypothetical/);
  assert.match(rows[2].selection.point.formula, /Hypothetical/);
  assert.match(rows[2].selection.point.note, /separate balance exercise/);
});
test("Bank sensitivity charges incremental losses to equity and funds withdrawals solely from cash", () => {
  const result = buildAnalysisScenario(
    data("banking"),
    { scenarioLoss: 2, scenarioFunding: 10 },
    0,
  );
  assert.equal(result.operating, null);
  assert.equal(result.balance.loss, 40);
  assert.equal(result.balance.withdrawal, 150);
  assert.equal(metric(result, "Assets").value, 1810);
  assert.equal(metric(result, "Equity").value, 160);
  assert.equal(metric(result, "Cash").value, 150);
  assert.equal(metric(result, "Deposits").value, 1350);
  assert.equal(metric(result, "EquityAssets").value, (160 / 1810) * 100);
  assert.equal(metric(result, "EquityAssets").sources.length, 4);
});
test("Bank sensitivity withholds ending balances if the assumed cash payment cannot be funded", () => {
  const result = buildAnalysisScenario(
    data("banking"),
    { scenarioFunding: 30 },
    0,
  );
  assert.equal(result.balance.fundingGap, 150);
  assert.match(result.balance.reason, /exceeds reported cash/);
  assert.equal(result.balance.rows.length, 0);
  const boundary = buildAnalysisScenario(
    data("banking"),
    { scenarioFunding: 20 },
    0,
  );
  assert.equal(metric(boundary, "Cash").value, 0);
});
test("Balance sensitivity retains negative hypothetical equity and leaves unavailable inputs missing", () => {
  const company = data();
  assert.equal(
    metric(buildAnalysisScenario(company, { scenarioLoss: 20 }, 0), "Equity")
      .value,
    -200,
  );
  company.metrics.stockholdersEquity[0].value = null;
  const result = buildAnalysisScenario(company, {}, 0);
  assert.equal(result.balance.rows.length, 0);
  assert.equal(result.balance.loss, null);
  assert.match(result.balance.reason, /unavailable/);
});
test("Insurance sensitivity uses its reported balance sheet without inventing a revenue denominator", () => {
  const company = data("insurance");
  delete company.metrics.revenue;
  delete company.metrics.deposits;
  const result = buildAnalysisScenario(
    company,
    { scenarioLoss: 1, scenarioFunding: 50 },
    0,
  );
  assert.equal(result.operating, null);
  assert.equal(result.balance.withdrawal, 0);
  assert.equal(metric(result, "Assets").value, 1980);
  assert.equal(metric(result, "Equity").value, 180);
  assert.match(metric(result, "Equity").note, /not a regulatory capital/);
});
test("Scenario rejects source dates after the selected report and does not mutate reported data", () => {
  const company = data();
  const before = JSON.stringify(company);
  buildAnalysisScenario(company, { scenarioLoss: 10, scenarioMargin: -5 }, 0);
  assert.equal(JSON.stringify(company), before);
  company.metrics.totalAssets[0].sources[0].end = "2026-12-31";
  assert.match(
    buildAnalysisScenario(company, {}, 0).balance.reason,
    /source date/,
  );
});

test("Lab operands distinguish opening balances from ending balances and scenarios require ending balances", () => {
  const company = data("banking");
  company.metrics.cash[0].sources[0].end = "2024-12-31";
  const formula = buildFormulaPoint(
    company,
    { formulaA: "cash", formulaB: "deposits", formulaOp: "add" },
    0,
  );
  assert.equal(formula.inputs[0].basis, "opening balance");
  assert.match(formula.point.reason, /measurement basis/);
  assert.match(
    buildAnalysisScenario(company, {}, 0).balance.reason,
    /ending balances/,
  );
  const ratio = buildFormulaPoint(
    company,
    { formulaA: "netIncome", formulaB: "cash", formulaOp: "ratio" },
    0,
  );
  assert.equal(ratio.point.value, (50 / 300) * 100);
  assert.match(ratio.point.note, /opening balance/);
});

test("Labs reject a mislabeled direct flow duration while preserving legitimate derived quarterly inputs", () => {
  const company = data();
  company.metrics.capex[0].sources[0].start = "2025-10-01";
  assert.match(
    buildFormulaPoint(company, FORMULA_DEFAULTS, 0).point.reason,
    /source duration/,
  );
  company.metrics.operatingIncome[0].sources[0].start = "2025-10-01";
  assert.match(
    buildAnalysisScenario(company, {}, 0).operating.reason,
    /source duration/,
  );
  const quarter = data();
  quarter.periods[0] = { ...period, kind: "quarter", start: "2025-10-01" };
  for (const points of Object.values(quarter.metrics)) {
    points[0].period = quarter.periods[0];
    if (points[0].sources[0].start) points[0].sources[0].start = "2025-10-01";
  }
  const capex = quarter.metrics.capex[0];
  capex.classification = "calculated";
  capex.formula = "Annual purchases − prior YTD purchases";
  capex.sources = [
    { ...capex.sources[0], value: 130, start: "2025-01-01" },
    {
      ...capex.sources[0],
      value: 100,
      start: "2025-01-01",
      end: "2025-09-30",
      accession: "0000000001-25-000001",
    },
  ];
  assert.equal(buildFormulaPoint(quarter, FORMULA_DEFAULTS, 0).point.value, 5);
  assert.equal(
    buildFormulaPoint(quarter, FORMULA_DEFAULTS, 0).point.sources.length,
    4,
  );
});

test("Lab calculations reject arbitrary old balance dates", () => {
  const company = data();
  company.metrics.totalAssets[0].sources[0].end = "2024-06-30";
  assert.match(
    buildFormulaPoint(
      company,
      { formulaA: "netIncome", formulaB: "totalAssets", formulaOp: "ratio" },
      0,
    ).point.reason,
    /opening date/,
  );
});
