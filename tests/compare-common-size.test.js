import test from "node:test";
import assert from "node:assert/strict";
import {
  commonSizeCell,
  commonSizeDenominator,
  commonSizeMetrics,
} from "../src/utils/compareCommonSize.js";

const period = { start: "2025-01-01", end: "2025-12-31", kind: "annual" };
const point = (value, tag, instant = false) => ({
  value,
  period,
  classification: "reported",
  sources: [
    {
      taxonomy: "us-gaap",
      tag,
      unit: "USD",
      ...(instant ? {} : { start: period.start }),
      end: period.end,
      accession: "0000000001-26-000001",
      documentUrl: "https://www.sec.gov/Archives/edgar/data/1/2025.htm",
    },
  ],
});
const entry = (lens = "corporate") => ({
  ticker: "TEST",
  index: 0,
  period,
  data: {
    name: "Test",
    cik: "1",
    lens,
    metrics: {
      totalAssets: [point(1000, "Assets", true)],
      stockholdersEquity: [point(200, "StockholdersEquity", true)],
      cash: [point(50, "CashAndCashEquivalentsAtCarryingValue", true)],
      revenue: [point(100, "Revenues")],
      netIncome: [point(10, "NetIncomeLoss")],
      operatingIncome: [point(20, "OperatingIncomeLoss")],
      netInterestIncome: [point(60, "InterestIncomeExpenseNet")],
      noninterestIncome: [point(40, "NoninterestIncome")],
      bankRevenue: [
        {
          value: 100,
          period,
          classification: "calculated",
          formula: "Net interest income + noninterest income",
          sources: [
            ...point(60, "InterestIncomeExpenseNet").sources,
            ...point(40, "NoninterestIncome").sources,
          ],
        },
      ],
    },
  },
});

test("balance common size uses same endpoint assets and retains numerator plus denominator sources", () => {
  const result = commonSizeCell(entry(), "stockholdersEquity");
  assert.equal(result.value, 20);
  assert.equal(result.calculatedPoint.classification, "calculated");
  assert.equal(result.calculatedPoint.sources.length, 2);
  assert.equal(result.point.value, 200);
  assert.equal(result.denominatorPoint.value, 1000);
  assert.match(result.calculatedPoint.formula, /Equity \/ Total assets/);
});

test("corporate income uses revenue and permits negative earnings", () => {
  const company = entry();
  company.data.metrics.netIncome[0].value = -10;
  const result = commonSizeCell(company, "netIncome", "income");
  assert.equal(result.value, -10);
  assert.equal(result.denominator.key, "revenue");
  assert.equal(commonSizeCell(company, "revenue", "income").value, 100);
});

test("bank income uses both before-provision interest and noninterest inputs", () => {
  const result = commonSizeCell(entry("banking"), "netIncome", "income");
  assert.equal(result.value, 10);
  assert.equal(result.denominator.key, "bankRevenue");
  assert.deepEqual(
    result.calculatedPoint.sources.map((source) => source.tag),
    ["NetIncomeLoss", "InterestIncomeExpenseNet", "NoninterestIncome"],
  );
  assert.ok(
    result.calculatedPoint.calculations.some((calculation) =>
      calculation.formula.includes("Net interest income +"),
    ),
  );
});

test("insurance income denominator remains unavailable rather than summing incomplete categories", () => {
  const company = entry("insurance");
  assert.equal(commonSizeDenominator(company, "income").key, null);
  const result = commonSizeCell(company, "netIncome", "income");
  assert.equal(result.value, null);
  assert.match(result.reason, /not substituted/);
  assert.equal(
    commonSizeCell(company, "stockholdersEquity", "balance").value,
    20,
  );
});

test("common-size metric lists exclude ratios, cash flows and inapplicable banking lines", () => {
  assert.deepEqual(
    commonSizeMetrics([entry()], "balance").map((metric) => metric.key),
    ["totalAssets", "stockholdersEquity", "cash"],
  );
  assert.ok(
    commonSizeMetrics([entry("banking")], "income").some(
      (metric) => metric.key === "bankRevenue",
    ),
  );
  for (const key of ["roe", "operatingCashFlow", "netIncome"]) {
    assert.equal(commonSizeCell(entry(), key, "balance").value, null);
    assert.match(
      commonSizeCell(entry(), key, "balance").reason,
      /Ratios and cash-flow/,
    );
  }
});

test("zero or negative denominators do not produce normalized percentages", () => {
  for (const value of [0, -100]) {
    const company = entry();
    company.data.metrics.revenue[0].value = value;
    const result = commonSizeCell(company, "netIncome", "income");
    assert.equal(result.value, null);
    assert.match(result.reason, /must be positive/);
  }
});

test("mismatched durations, currencies and balance endpoints remain explicit coverage gaps", () => {
  const duration = entry();
  duration.data.metrics.revenue[0].sources[0].start = "2025-10-01";
  assert.match(
    commonSizeCell(duration, "netIncome", "income").reason,
    /durations/,
  );
  const currency = entry();
  currency.data.metrics.totalAssets[0].sources[0].unit = "EUR";
  assert.match(commonSizeCell(currency, "cash", "balance").reason, /USD/);
  const stale = entry();
  stale.data.metrics.cash[0].sources[0].end = "2024-12-31";
  assert.match(commonSizeCell(stale, "cash", "balance").reason, /endpoint/);
});

test("common-size output never treats a ratio as an unscaled monetary input", () => {
  const company = entry();
  company.data.metrics.operatingMargin = [point(20, "OperatingIncomeLoss")];
  assert.equal(
    commonSizeCell(company, "operatingMargin", "income").value,
    null,
  );
  const banks = entry("banking");
  assert.equal(commonSizeCell(banks, "revenue", "income").value, null);
  assert.match(
    commonSizeCell(banks, "revenue", "income").reason,
    /not applicable/,
  );
});
