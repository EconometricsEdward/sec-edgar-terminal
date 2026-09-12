import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SUPPLEMENTAL_METRIC_DEFINITIONS,
  augmentPortfolioCompanyMetrics,
  calculateSupplementalMetric,
} from "../src/utils/financialSupplementalMetrics.js";
import { buildAnalysisCompany } from "../src/utils/analysisResearch.js";
import { analysisMetricGuide } from "../src/utils/analysisMetricGuide.js";
import {
  packPortfolioSnapshot,
  unpackPortfolioSnapshot,
} from "../src/utils/portfolioEvidenceCodec.js";
import { portfolioMetricDefinitionFor } from "../src/utils/portfolioMetricCatalog.js";

const annual = {
  kind: "annual",
  start: "2025-01-01",
  end: "2025-12-31",
  fp: "FY",
  fy: 2025,
};
const source = (tag, value, period = annual, instant = false) => ({
  taxonomy: "us-gaap",
  tag,
  unit: "USD",
  value,
  start: instant ? null : period.start,
  end: period.end,
  filed: "2026-02-01",
  accession: "0000000001-26-000001",
  form: "10-K",
  documentUrl:
    "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/annual.htm",
});
const point = (tag, value, instant = false, period = annual) => ({
  value,
  unit: "USD",
  period,
  classification: "reported",
  sources: [source(tag, value, period, instant)],
});
const fixture = () => ({
  cik: "0000000001",
  ticker: "TEST",
  lens: "corporate",
  kind: "company",
  status: "partial",
  retrievedAt: "2026-02-10T00:00:00Z",
  period: annual,
  metrics: {
    currentAssets: point("AssetsCurrent", 140, true),
    currentLiabilities: point("LiabilitiesCurrent", 100, true),
    cash: point("CashAndCashEquivalentsAtCarryingValue", 80, true),
    totalLiabilities: point("Liabilities", 300, true),
    totalAssets: point("Assets", 500, true),
    shortTermDebt: point("DebtCurrent", 20, true),
    longTermDebt: point("LongTermDebtNoncurrent", 40, true),
    stockholdersEquity: point("StockholdersEquity", 200, true),
    revenue: point("Revenues", 200),
    operatingCashFlow: point("NetCashProvidedByUsedInOperatingActivities", 50),
    capex: point("PaymentsToAcquirePropertyPlantAndEquipment", 10),
    rnd: point("ResearchAndDevelopmentExpense", 12),
    operatingIncome: point("OperatingIncomeLoss", 40),
    interestExpense: point("InterestExpense", 5),
    pretaxIncome: point(
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
      30,
    ),
    incomeTax: point("IncomeTaxExpenseBenefit", 6),
  },
});
const calculate = (key, company = fixture()) =>
  calculateSupplementalMetric(
    SUPPLEMENTAL_METRIC_DEFINITIONS.find((def) => def.key === key),
    company.metrics,
    company.period,
    company.lens,
  );

test("supplemental formulas agree with independently specified arithmetic and retain input evidence", () => {
  const original = fixture();
  const enriched = augmentPortfolioCompanyMetrics(original);
  const expected = {
    workingCapital: 40,
    cashRatio: 0.8,
    liabilitiesAssets: 60,
    reportedDebtEquity: 30,
    netReportedDebt: -20,
    operatingCashFlowMargin: 25,
    freeCashFlowMargin: 20,
    capexRevenue: 5,
    researchRevenue: 6,
    operatingInterestCoverage: 8,
    pretaxMargin: 15,
    effectiveTaxRate: 20,
  };
  for (const [key, value] of Object.entries(expected)) {
    const result = enriched.metrics[key];
    assert.equal(result.value, value, key);
    assert.equal(result.classification, "calculated");
    assert.equal(
      result.calculations.filter((entry) => entry.key).length,
      portfolioMetricDefinitionFor(key).inputs.length,
    );
    assert.ok(
      result.sources.every((s) =>
        s.documentUrl.startsWith("https://www.sec.gov/Archives/"),
      ),
    );
    assert.ok(
      result.calculations.every((input) => Number.isFinite(input.value)),
    );
    assert.equal(
      analysisMetricGuide(
        portfolioMetricDefinitionFor(key),
        result,
        "corporate",
      ).known,
      true,
    );
  }
  assert.equal(enriched.metrics.revenue, original.metrics.revenue);
  assert.equal(original.metrics.workingCapital, undefined);
  assert.equal(enriched.status, original.status);
  assert.equal(enriched.retrievedAt, original.retrievedAt);
  assert.deepEqual(augmentPortfolioCompanyMetrics(enriched), enriched);
});

test("negative and zero numerators remain valid; nonpositive ratio denominators do not", () => {
  const c = fixture();
  c.metrics.operatingIncome = point("OperatingIncomeLoss", -10);
  c.metrics.incomeTax = point("IncomeTaxExpenseBenefit", -3);
  c.metrics.capex = point("PaymentsToAcquirePropertyPlantAndEquipment", 0);
  c.metrics.operatingCashFlow = point(
    "NetCashProvidedByUsedInOperatingActivities",
    -20,
  );
  c.metrics.currentAssets = point("AssetsCurrent", 0, true);
  assert.equal(calculate("operatingInterestCoverage", c).value, -2);
  assert.equal(calculate("effectiveTaxRate", c).value, -10);
  assert.equal(calculate("capexRevenue", c).value, 0);
  assert.equal(calculate("freeCashFlowMargin", c).value, -10);
  assert.equal(calculate("workingCapital", c).value, -100);
  for (const denominator of [0, -5]) {
    c.metrics.revenue = point("Revenues", denominator);
    c.metrics.pretaxIncome = point(
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
      denominator,
    );
    c.metrics.interestExpense = point("InterestExpense", denominator);
    c.metrics.stockholdersEquity = point(
      "StockholdersEquity",
      denominator,
      true,
    );
    for (const key of [
      "pretaxMargin",
      "freeCashFlowMargin",
      "effectiveTaxRate",
      "operatingInterestCoverage",
      "reportedDebtEquity",
    ])
      assert.equal(calculate(key, c).value, null, key);
  }
});

test("supplemental ratios reject missing components, wrong currencies and untraceable values", () => {
  const changes = [
    (c) => {
      delete c.metrics.capex;
    },
    (c) => {
      c.metrics.capex.value = null;
    },
    (c) => {
      c.metrics.capex.sources = [];
    },
    (c) => {
      c.metrics.capex.unit = "EUR";
    },
    (c) => {
      c.metrics.capex.sources[0].unit = "EUR";
    },
    (c) => {
      c.metrics.capex.sources[0].value = null;
    },
  ];
  for (const change of changes) {
    const c = fixture();
    change(c);
    assert.equal(calculate("freeCashFlowMargin", c).value, null);
  }
  const missingDebt = fixture();
  delete missingDebt.metrics.shortTermDebt;
  assert.equal(calculate("netReportedDebt", missingDebt).value, null);
  assert.equal(calculate("reportedDebtEquity", missingDebt).value, null);
});

test("actual source windows and balance dates must support the requested period", () => {
  const incorrectAnnual = fixture();
  incorrectAnnual.metrics.operatingCashFlow.sources[0].start = "2025-02-01";
  assert.equal(
    calculate("operatingCashFlowMargin", incorrectAnnual).value,
    null,
  );
  const staleCash = fixture();
  staleCash.metrics.cash.sources[0].end = "2025-09-30";
  assert.equal(calculate("cashRatio", staleCash).value, null);
  const wrongPoint = fixture();
  wrongPoint.metrics.revenue.period = { ...annual, kind: "ytd" };
  assert.equal(calculate("pretaxMargin", wrongPoint).value, null);
  const wrongType = fixture();
  wrongType.metrics.currentAssets.sources[0].start = annual.start;
  assert.equal(calculate("workingCapital", wrongType).value, null);
  const futureFiled = fixture();
  futureFiled.period = { ...annual, asOf: "2026-01-01" };
  futureFiled.metrics.revenue.period = futureFiled.period;
  futureFiled.metrics.operatingCashFlow.period = futureFiled.period;
  assert.equal(calculate("operatingCashFlowMargin", futureFiled).value, null);
});

test("quarterly cash flow derived from cumulative facts is compared to quarterly revenue without annualizing", () => {
  const quarter = {
    kind: "quarter",
    fp: "Q2",
    start: "2025-04-01",
    end: "2025-06-30",
  };
  const current = { start: "2025-01-01", end: "2025-06-30" };
  const prior = { start: "2025-01-01", end: "2025-03-31" };
  const c = {
    ...fixture(),
    period: quarter,
    metrics: {
      revenue: point("Revenues", 100, false, quarter),
      operatingCashFlow: {
        value: 30,
        unit: "USD",
        period: quarter,
        classification: "calculated",
        formula: "Current cumulative value − prior cumulative value",
        sources: [
          source("NetCashProvidedByUsedInOperatingActivities", 45, current),
          source("NetCashProvidedByUsedInOperatingActivities", 15, prior),
        ],
      },
    },
  };
  const result = calculate("operatingCashFlowMargin", c);
  assert.equal(result.value, 30);
  assert.equal(result.sources.length, 3);
  assert.equal(result.period.start, quarter.start);
  assert.equal(
    result.calculations.find((entry) => entry.key === "operatingCashFlow")
      .value,
    30,
  );
  assert.match(
    result.calculations.find((entry) => entry.key === "operatingCashFlow")
      .formula,
    /cumulative/,
  );
  c.metrics.operatingCashFlow.sources[1].end = "2025-02-28";
  assert.equal(calculate("operatingCashFlowMargin", c).value, null);
});

test("YTD and TTM margins use matching durations, with all four TTM quarters supported", () => {
  const ytd = { kind: "ytd", fp: "Q3", start: "2025-01-01", end: "2025-09-30" };
  const c = {
    ...fixture(),
    period: ytd,
    metrics: {
      revenue: point("Revenues", 300, false, ytd),
      operatingCashFlow: point(
        "NetCashProvidedByUsedInOperatingActivities",
        60,
        false,
        ytd,
      ),
    },
  };
  assert.equal(calculate("operatingCashFlowMargin", c).value, 20);
  const ttm = { ...annual, kind: "ttm" };
  c.period = ttm;
  c.metrics.revenue = point("Revenues", 400, false, ttm);
  c.metrics.operatingCashFlow = {
    value: 80,
    unit: "USD",
    period: ttm,
    classification: "calculated",
    formula: "Sum of four consecutive standalone quarters",
    sources: [
      ["2025-01-01", "2025-03-31"],
      ["2025-04-01", "2025-06-30"],
      ["2025-07-01", "2025-09-30"],
      ["2025-10-01", "2025-12-31"],
    ].map(([start, end]) =>
      source("NetCashProvidedByUsedInOperatingActivities", 20, { start, end }),
    ),
  };
  assert.equal(calculate("operatingCashFlowMargin", c).value, 20);
  c.metrics.operatingCashFlow.sources.pop();
  assert.equal(calculate("operatingCashFlowMargin", c).value, null);
});

test("accounting scope prevents restricted-cash substitution, overlapping debt and inappropriate bank measures", () => {
  for (const tag of [
    "Cash",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    "CashAndDueFromBanks",
  ]) {
    const c = fixture();
    c.metrics.cash.sources[0].tag = tag;
    assert.equal(calculate("cashRatio", c).value, null);
    assert.equal(calculate("netReportedDebt", c).value, null);
  }
  for (const tag of ["LongTermDebt", "LongTermDebtCurrent", "DebtCurrent"]) {
    const c = fixture();
    c.metrics.longTermDebt.sources[0].tag = tag;
    assert.equal(calculate("reportedDebtEquity", c).value, null);
  }
  const bank = { ...fixture(), lens: "banking" };
  assert.equal(
    calculate("operatingCashFlowMargin", bank).classification,
    "not_applicable",
  );
  assert.equal(calculate("cashRatio", bank).classification, "not_applicable");
  assert.equal(calculate("effectiveTaxRate", bank).value, 20);
  assert.equal(calculate("liabilitiesAssets", bank).value, 60);
});

test("Analysis and Portfolio captures calculate identical supplemental values from identical facts", () => {
  const captured = fixture();
  const facts = Object.fromEntries(
    Object.values(captured.metrics).map((p) => {
      const s = p.sources[0];
      return [
        s.tag,
        {
          units: {
            USD: [
              {
                val: s.value,
                ...(s.start ? { start: s.start } : {}),
                end: s.end,
                fy: 2025,
                fp: "FY",
                form: "10-K",
                filed: s.filed,
                accn: s.accession,
              },
            ],
          },
        },
      ];
    }),
  );
  const analysis = buildAnalysisCompany({
    ticker: "TEST",
    cik: "0000000001",
    companyName: "Test",
    sic: 3571,
    facts: { "us-gaap": facts },
    filings: [],
  });
  const portfolio = augmentPortfolioCompanyMetrics(captured);
  for (const definition of SUPPLEMENTAL_METRIC_DEFINITIONS) {
    assert.equal(
      analysis.metrics[definition.key][0].value,
      portfolio.metrics[definition.key].value,
      definition.key,
    );
    assert.equal(
      analysis.definitions.find((def) => def.key === definition.key).formula,
      definition.formula,
    );
  }
});

test("the existing annual demo gains source-supported measures without changing capture metadata", () => {
  const demo = JSON.parse(
    fs.readFileSync(
      new URL(
        "../public/portfolio/portfolio-demo-100-results.json",
        import.meta.url,
      ),
    ),
  );
  const original = unpackPortfolioSnapshot(demo.snapshot).companies;
  const companies = original.map(augmentPortfolioCompanyMetrics);
  for (const definition of SUPPLEMENTAL_METRIC_DEFINITIONS)
    assert.ok(
      companies.some((c) =>
        Number.isFinite(c.metrics?.[definition.key]?.value),
      ),
      definition.key,
    );
  assert.deepEqual(
    companies.map((c) => [c.cik, c.retrievedAt, c.status, c.period]),
    original.map((c) => [c.cik, c.retrievedAt, c.status, c.period]),
  );
  const apple = companies.find((c) => c.ticker === "AAPL");
  assert.equal(
    apple.metrics.workingCapital.value,
    apple.metrics.currentAssets.value - apple.metrics.currentLiabilities.value,
  );
  assert.equal(
    apple.metrics.freeCashFlowMargin.value,
    ((apple.metrics.operatingCashFlow.value - apple.metrics.capex.value) /
      apple.metrics.revenue.value) *
      100,
  );
  const snapshot = { ...unpackPortfolioSnapshot(demo.snapshot), companies };
  const packed = packPortfolioSnapshot(snapshot);
  assert.ok(
    Buffer.byteLength(JSON.stringify(packed)) < 3.75 * 1024 * 1024,
    "Evidence pooling must leave room for portfolio rows within the unchanged 4 MiB storage budget",
  );
  assert.deepEqual(
    unpackPortfolioSnapshot(packed),
    snapshot,
    "Every formula, input value, source and period survives the compact export",
  );
});
