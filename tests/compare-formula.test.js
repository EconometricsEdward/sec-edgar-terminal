import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COMPARE_FORMULA,
  normalizeCompareFormula,
  validateCompareFormula,
  compareFormulaMetric,
  compareFormulaOperands,
  computeCompareFormula,
  compareFormulaResults,
  compareFormulaPresets,
  exportCompareFormulaDefinition,
} from "../src/utils/compareFormula.js";

const period = (end = "2025-12-31", start = "2025-01-01", kind = "annual") => ({
  start,
  end,
  kind,
  fp: "FY",
});
const BALANCES = new Set([
  "cash",
  "totalAssets",
  "stockholdersEquity",
  "loans",
  "deposits",
]);
function entry(
  ticker = "A",
  values = { cash: 20, totalAssets: 100 },
  p = period(),
) {
  return {
    ticker,
    index: 0,
    period: p,
    loading: false,
    error: null,
    data: {
      cik: ticker,
      name: `${ticker} Corporation`,
      metrics: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          [
            {
              value,
              period: p,
              classification: "reported",
              sources: [
                {
                  taxonomy: "us-gaap",
                  tag: key,
                  unit: "USD",
                  value,
                  start: BALANCES.has(key) ? null : p.start,
                  end: p.end,
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
    },
  };
}

test("custom cash-to-assets metric retains all inputs, evidence, definition and output units", () => {
  const point = computeCompareFormula(entry(), {
    ...DEFAULT_COMPARE_FORMULA,
    basis: "annual",
  });
  assert.equal(point.value, 20);
  assert.equal(point.classification, "calculated");
  assert.equal(point.sources.length, 2);
  assert.deepEqual(
    point.inputs.map(({ point }) => point.value),
    [20, 100],
  );
  assert.equal(point.calculations.at(-1).unit, "%");
  assert.deepEqual(point.formulaSettings, DEFAULT_COMPARE_FORMULA);
  assert.match(point.formula, /Reported cash \/ Total assets × 100/);
});

test("all four supported operations have explicit monetary or dimensionless units", () => {
  const issuer = entry("A", {
    cash: 20,
    stockholdersEquity: 30,
    totalAssets: 100,
  });
  assert.equal(
    computeCompareFormula(issuer, { formulaScale: "multiple" }).value,
    0.2,
  );
  const subtract = {
    formulaA: "totalAssets",
    formulaB: "cash",
    formulaOp: "subtract",
  };
  assert.equal(computeCompareFormula(issuer, subtract).value, 80);
  assert.equal(compareFormulaMetric(subtract).format, "currency");
  const inputs = {
    formulaA: "stockholdersEquity",
    formulaB: "cash",
    formulaC: "totalAssets",
  };
  assert.equal(
    computeCompareFormula(issuer, { ...inputs, formulaOp: "differenceRatio" })
      .value,
    10,
  );
  assert.equal(
    computeCompareFormula(issuer, { ...inputs, formulaOp: "sumRatio" }).value,
    50,
  );
  assert.equal(compareFormulaOperands({ formulaOp: "sumRatio" }).length, 3);
  assert.equal(compareFormulaOperands({ formulaOp: "divide" }).length, 2);
});

test("zero and negative denominators stay unavailable while zero and negative numerators remain meaningful", () => {
  for (const denominator of [0, -100]) {
    const point = computeCompareFormula(
      entry("A", { cash: 20, totalAssets: denominator }),
    );
    assert.equal(point.value, null);
    assert.match(point.reason, /denominator must be positive/);
  }
  assert.equal(
    computeCompareFormula(entry("A", { cash: 0, totalAssets: 100 })).value,
    0,
  );
  const settings = { formulaA: "netIncome", formulaB: "revenue" };
  assert.equal(
    computeCompareFormula(entry("A", { netIncome: -5, revenue: 100 }), settings)
      .value,
    -5,
  );
  assert.equal(
    computeCompareFormula(entry("A", { cash: 5, totalAssets: 100 }), {
      formulaOp: "subtract",
    }).value,
    -95,
  );
});

test("ratio operands, unrecognized keys and arbitrary operations cannot execute or become monetary inputs", () => {
  for (const formulaA of [
    "roe",
    "cashAssets",
    "constructor",
    "__proto__",
    "cash;globalThis.bad=true",
  ]) {
    const point = computeCompareFormula(entry(), { formulaA });
    assert.equal(point.value, null);
    assert.match(point.reason, /monetary inputs/);
  }
  assert.match(
    validateCompareFormula({ formulaOp: "eval" }),
    /supported arithmetic/,
  );
  assert.equal(globalThis.bad, undefined);
  assert.equal(
    normalizeCompareFormula({ formulaA: "constructor" }).formulaA,
    "cash",
  );
});

test("flows and ending balances cannot silently become an unannualized return or dollar subtraction", () => {
  const issuer = entry("A", { netIncome: 15, totalAssets: 100 });
  for (const formulaOp of [
    "divide",
    "subtract",
    "differenceRatio",
    "sumRatio",
  ]) {
    const point = computeCompareFormula(issuer, {
      formulaA: "netIncome",
      formulaB: "totalAssets",
      formulaOp,
    });
    assert.equal(point.value, null);
    assert.match(point.reason, /averaging and annualization/);
  }
});

test("quarterly same-duration flow ratios need no annualization and reject unsupported source intervals", () => {
  const p = period("2026-03-31", "2026-01-01", "quarter");
  const issuer = entry("A", { netIncome: 5, revenue: 100 }, p);
  const settings = {
    formulaA: "netIncome",
    formulaB: "revenue",
    basis: "quarter",
  };
  assert.equal(computeCompareFormula(issuer, settings).value, 5);
  issuer.data.metrics.netIncome[0].sources[0].start = "2026-02-01";
  const point = computeCompareFormula(issuer, settings);
  assert.equal(point.value, null);
  assert.match(point.reason, /durations do not support/);
});

test("derived quarterly flow retains its YTD source calculations instead of treating them as direct quarter reports", () => {
  const p = period("2025-09-30", "2025-07-01", "quarter");
  const issuer = entry("A", { operatingCashFlow: 30, netIncome: 20 }, p);
  const flow = issuer.data.metrics.operatingCashFlow[0];
  flow.classification = "calculated";
  flow.sources = [
    { ...flow.sources[0], start: "2025-01-01", value: 80 },
    { ...flow.sources[0], start: "2025-01-01", end: "2025-06-30", value: 50 },
  ];
  flow.formula = "Nine months cash flow − six months cash flow";
  flow.calculations = [{ formula: flow.formula, value: 30, unit: "USD" }];
  const result = computeCompareFormula(issuer, {
    formulaA: "operatingCashFlow",
    formulaB: "netIncome",
    formulaScale: "multiple",
    basis: "quarter",
  });
  assert.equal(result.value, 1.5);
  assert.equal(result.sources.length, 3);
  assert.ok(
    result.calculations.some(({ formula }) => formula.includes("Nine months")),
  );
});

test("missing inputs, source evidence, foreign currencies and mismatched selected periods leave reviewable gaps", () => {
  assert.match(
    computeCompareFormula(entry("A", { cash: 20 })).reason,
    /required input is unavailable/,
  );
  const noSource = entry();
  noSource.data.metrics.cash[0].sources = [];
  assert.match(
    computeCompareFormula(noSource).reason,
    /source evidence is missing/,
  );
  const incomplete = entry();
  delete incomplete.data.metrics.cash[0].sources[0].accession;
  assert.match(
    computeCompareFormula(incomplete).reason,
    /missing its value, XBRL concept, or filing accession/,
  );
  const foreign = entry();
  foreign.data.metrics.cash[0].sources[0].unit = "EUR";
  assert.match(computeCompareFormula(foreign).reason, /must use USD/);
  const mismatch = entry();
  mismatch.data.metrics.cash[0].period = period("2024-12-31", "2024-01-01");
  assert.match(computeCompareFormula(mismatch).reason, /does not belong/);
  assert.match(
    computeCompareFormula(entry(), { basis: "quarter" }).reason,
    /reporting basis/,
  );
});

test("source filing cutoff and reported balance endpoints are enforced", () => {
  const cutoff = entry();
  cutoff.period.asOf = "2026-01-15";
  assert.match(computeCompareFormula(cutoff).reason, /filing cutoff/);
  const older = entry();
  older.data.metrics.cash[0].sources[0].end = "2024-12-31";
  assert.match(computeCompareFormula(older).reason, /balance input is not at/);
});

test("derived monetary inputs preserve intermediate formulas and original evidence", () => {
  const issuer = entry("JPM", { netIncome: 20, bankRevenue: 100 });
  issuer.data.metrics.bankRevenue[0].classification = "calculated";
  issuer.data.metrics.bankRevenue[0].formula =
    "Net interest income + noninterest income";
  issuer.data.metrics.bankRevenue[0].sources = [
    {
      ...issuer.data.metrics.bankRevenue[0].sources[0],
      tag: "InterestIncomeExpenseNet",
      value: 70,
    },
    {
      ...issuer.data.metrics.bankRevenue[0].sources[0],
      tag: "NoninterestIncome",
      value: 30,
    },
  ];
  const point = computeCompareFormula(issuer, {
    formulaA: "netIncome",
    formulaB: "bankRevenue",
  });
  assert.equal(point.value, 20);
  assert.equal(point.sources.length, 3);
  assert.ok(
    point.calculations.some(({ formula }) =>
      formula.includes("Net interest income + noninterest income"),
    ),
  );
});

test("medians require two unique issuers with comparable periods and consistent source definitions", () => {
  const a = entry("A"),
    b = entry("B", { cash: 40, totalAssets: 100 });
  assert.equal(compareFormulaResults([a, b]).median, 30);
  assert.equal(compareFormulaResults([a]).median, null);
  const alias = { ...a, ticker: "A2" };
  assert.equal(compareFormulaResults([a, alias]).total, 1);
  const old = entry(
    "B",
    { cash: 40, totalAssets: 100 },
    period("2025-06-30", "2024-07-01"),
  );
  assert.equal(compareFormulaResults([a, old]).median, null);
  b.data.metrics.cash[0].sources[0].tag = "DifferentCashConcept";
  assert.match(
    compareFormulaResults([a, b]).reason,
    /different reported input concepts/,
  );
});

test("loading, failed and unavailable issuers remain visible without entering the median", () => {
  const failed = { ticker: "B", error: "SEC unavailable", index: -1 };
  const loading = { ticker: "C", loading: true, index: -1 };
  const result = compareFormulaResults([entry(), failed, loading]);
  assert.equal(result.total, 3);
  assert.equal(result.count, 1);
  assert.equal(result.cells[1].status, "fetch failed");
  assert.equal(result.cells[2].status, "loading");
  assert.ok(result.cells.slice(1).every(({ point }) => point.value === null));
});

test("presets only appear when selected SEC observations support them and show coverage", () => {
  const issuer = entry("A", {
    cash: 20,
    totalAssets: 100,
    netIncome: -5,
    revenue: 100,
    operatingCashFlow: 30,
  });
  const presets = compareFormulaPresets([
    issuer,
    { ticker: "B", error: "failed", index: -1 },
  ]);
  assert.ok(presets.some(({ id }) => id === "cash-assets"));
  assert.ok(presets.some(({ id }) => id === "net-margin"));
  assert.ok(!presets.some(({ id }) => id === "cash-conversion"));
  assert.ok(!presets.some(({ id }) => id === "bank-net-margin"));
  assert.ok(presets.every(({ count, total }) => count === 1 && total === 2));
  assert.deepEqual(compareFormulaPresets([]), []);
});

test("formula definitions serialize deterministically, preserve labels and reset to safe defaults", () => {
  const settings = {
    formulaA: "netIncome",
    formulaB: "bankRevenue",
    formulaOp: "divide",
    formulaScale: "multiple",
    formulaLabel: "  Bank net income conversion  ",
    basis: "annual",
    asOf: "2026-06-30",
  };
  const normalized = normalizeCompareFormula(settings);
  assert.equal(normalized.formulaLabel, "Bank net income conversion");
  const exported = JSON.parse(exportCompareFormulaDefinition(settings));
  assert.deepEqual(exported.definition, normalized);
  assert.equal(exported.metric.key, "customFormula");
  assert.equal(exported.metric.format, "decimal");
  assert.equal(exported.context.filingCutoff, "2026-06-30");
  assert.deepEqual(
    normalizeCompareFormula({ ...settings, ...DEFAULT_COMPARE_FORMULA }),
    DEFAULT_COMPARE_FORMULA,
  );
  assert.equal(
    normalizeCompareFormula({ formulaLabel: "a".repeat(100) }).formulaLabel
      .length,
    80,
  );
});
