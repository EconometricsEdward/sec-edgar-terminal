import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCatalogReport,
  weightedFundamentals,
  financingBuffers,
  conditionOverlap,
  evidenceImpact,
  operatingSensitivity,
  rebalanceAllocation,
  analyzeRevisions,
  mixedPriceScenario,
  analysisRowsCsv,
} from "../src/utils/portfolioEnrichment.js";
import {
  buildPortfolioScreen,
  portfolioScreenCsv,
} from "../src/utils/portfolioScreening.js";
import {
  buildMetricRelationship,
  buildPeerBenchmarks,
} from "../src/utils/portfolioFinancialTools.js";
import { createDemoPortfolio } from "../src/utils/portfolioDemo.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import { buildPortfolioScenario } from "../src/utils/portfolioScenario.js";
import { unpackPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
import { parsePortfolioCsv } from "../src/utils/portfolioFiles.js";
const period = { kind: "annual", start: "2025-01-01", end: "2025-12-31" };
const cik = (n) => String(n).padStart(10, "0");
const point = (value, unit = "USD", extra = {}) => ({
  value,
  unit,
  classification: "reported",
  period,
  sources: [{ url: "https://www.sec.gov/Archives/edgar/data/1/test.htm" }],
  ...extra,
});
const company = (n, metrics, extra = {}) => ({
  cik: cik(n),
  ticker: `C${n}`,
  name: `Company ${n}`,
  status: "ready",
  lens: "corporate",
  retrievedAt: "2026-09-01T00:00:00Z",
  metrics,
  ...extra,
});
function fixture(companies, weights = [60, 40]) {
  return {
    weighted: true,
    capturedAt: "2026-09-11T00:00:00Z",
    unresolvedCount: 0,
    concentration: {
      complete:
        weights.every(Number.isFinite) &&
        Math.abs(weights.reduce((a, b) => a + b, 0) - 100) < 1e-6,
      knownWeightPct: weights
        .filter(Number.isFinite)
        .reduce((a, b) => a + b, 0),
      issuers: companies.map((c, i) => ({
        cik: c.cik,
        kind: "company",
        name: c.name,
        tickers: [c.ticker],
        rowIds: [`r${i}`],
        industry: "Technology",
        weightPct: weights[i] ?? null,
        weightComplete: Number.isFinite(weights[i]),
      })),
    },
    metrics: [],
  };
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} ≠ ${b}`);
test("catalog unlocks statement measures while excluding absent, wrong-unit, wrong-lens and unknown-period options", () => {
  const companies = [
    company(1, {
      revenue: point(100),
      cash: point(0),
      operatingIncome: point(20),
      inventory: point(5, "shares"),
      shortTermDebt: point(null),
      netMargin: point(20, "%"),
    }),
    company(2, {
      revenue: point(200),
      cash: point(10),
      netMargin: point(12, "%", {
        period: { kind: "ttm", start: "2025-01-02", end: "2025-12-31" },
      }),
    }),
  ];
  const report = buildCatalogReport(fixture(companies), companies);
  assert.ok(report.metrics.some((m) => m.id === "revenue"));
  assert.equal(
    report.metrics.find((m) => m.id === "cash").observations[0].value,
    0,
  );
  assert.ok(
    !report.metrics.some((m) => ["inventory", "shortTermDebt"].includes(m.id)),
  );
  assert.equal(
    buildPeerBenchmarks(report, { metricId: "revenue" }).measuredCount,
    2,
  );
  const relation = buildMetricRelationship(report, {
    xMetricId: "revenue",
    yMetricId: "netMargin",
    matchingPeriodOnly: true,
  });
  assert.equal(relation.points.length, 1);
  assert.equal(relation.dateExcludedCount, 1);
});
test("catalog screens enforce full periods, explain failed rules and export aligned columns", () => {
  const companies = [
    company(1, { revenue: point(100), operatingIncome: point(20) }),
    company(2, { revenue: point(200), operatingIncome: point(-5) }),
    company(3, {
      revenue: point(300),
      operatingIncome: point(30, "USD", {
        period: { ...period, start: "2025-04-01" },
      }),
    }),
  ];
  const report = buildCatalogReport(
    fixture(companies, [40, 30, 30]),
    companies,
  );
  const screen = buildPortfolioScreen(
    report,
    companies,
    [
      { metricId: "revenue", min: "0", max: "" },
      { metricId: "operatingIncome", min: "0", max: "" },
    ],
    { matchingPeriodOnly: true },
  );
  assert.equal(screen.matches.length, 1);
  assert.equal(screen.mismatched.length, 1);
  assert.equal(screen.outside.length, 1);
  assert.ok(screen.outside[0].failures[0]);
  assert.equal(screen.measuredCount, 2);
  const csv = parsePortfolioCsv(portfolioScreenCsv(screen));
  assert.ok(csv.records.every((row) => row.length === csv.headers.length));
  assert.ok(csv.headers.includes("revenue_full_period"));
  assert.match(csv.records[0].join(","), /annual\|2025-01-01\|2025-12-31/);
});
test("weighted ratio summaries use explicit coverage and isolate exact cohorts", () => {
  const companies = [
    company(1, { netMargin: point(10, "%") }),
    company(2, { netMargin: point(30, "%") }),
    company(3, {
      netMargin: point(90, "%", { period: { ...period, start: "2024-12-31" } }),
    }),
  ];
  const result = weightedFundamentals(
    fixture(companies, [60, 30, 10]),
    companies,
    "netMargin",
  );
  close(result.weightedMean, 50 / 3);
  assert.equal(result.equalMean, 20);
  assert.equal(result.weightedMedian, 10);
  assert.equal(result.coveredWeightPct, 90);
  assert.equal(result.excludedCount, 1);
});
test("unknown weights and zero allocations never create fabricated weighted observations", () => {
  const companies = [
    company(1, { netMargin: point(10, "%") }),
    company(2, { netMargin: point(30, "%") }),
  ];
  const result = weightedFundamentals(
    fixture(companies, [60, null]),
    companies,
    "netMargin",
  );
  assert.equal(result.partial, true);
  assert.equal(result.weightedCompanyCount, 1);
  assert.equal(result.weightedMean, 10);
  assert.equal(result.equalMean, 20);
  const none = weightedFundamentals(
    fixture(companies, [null, null]),
    companies,
    "netMargin",
  );
  assert.equal(none.coveredWeightPct, null);
  assert.equal(none.weightedMean, null);
  const zero = weightedFundamentals(
    fixture(companies, [0, 0]),
    companies,
    "netMargin",
  );
  assert.equal(zero.coveredWeightPct, 0);
  assert.equal(zero.weightedMean, null);
});
test("financing buffers preserve net cash, negative income and skip zero divisors", () => {
  const companies = [
    company(1, {
      debt: point(0),
      cash: point(30),
      operatingIncome: point(-10),
      interestExpense: point(2),
    }),
    company(2, {
      debt: point(50),
      cash: point(20),
      operatingIncome: point(10),
      interestExpense: point(0),
    }),
  ];
  const buffers = financingBuffers(fixture(companies), companies);
  assert.equal(buffers.find((m) => m.id === "netDebt").rows[0].value, -30);
  assert.equal(buffers.find((m) => m.id === "cashDebt").rows.length, 1);
  assert.equal(buffers.find((m) => m.id === "cashDebt").rows[0].value, 40);
  assert.equal(buffers.find((m) => m.id === "interestCover").rows[0].value, -5);
});
test("overlap excludes unmeasured companies and reports all-unknown allocation as unknown", () => {
  const companies = [
    company(1, {
      revenueGrowth: point(-1, "%"),
      operatingCashFlow: point(-10),
    }),
    company(2, {
      revenueGrowth: point(-2, "%"),
      operatingCashFlow: point(null),
    }),
  ];
  const result = conditionOverlap(fixture(companies, [null, null]), companies);
  assert.equal(result.measuredCount, 1);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.knownWeightPct, null);
  assert.equal(result.partial, true);
  assert.equal(
    conditionOverlap(fixture(companies), companies, []).rows.length,
    0,
  );
});
test("evidence importance preserves allocation and distinguishes retrieval age from period date", () => {
  const companies = [
    company(1, { netMargin: point(10, "%"), cash: point(5) }),
    company(
      2,
      { netMargin: point(null), cash: point(20) },
      { retrievedAt: "2026-09-10T00:00:00Z" },
    ),
  ];
  const report = fixture(companies, [20, 80]);
  const result = evidenceImpact(report, companies, ["netMargin"], 7);
  assert.equal(result.measures[0].coveredWeightPct, 20);
  assert.equal(result.measures[0].missingWeightPct, 80);
  assert.equal(result.rows[0].cik, cik(2));
  assert.equal(result.rows[1].captureAgeDays, 10);
  const unknown = evidenceImpact(fixture(companies, [20, null]), companies, [
    "netMargin",
  ]);
  assert.equal(unknown.measures[0].missingWeightPct, null);
});
test("operating-cost model has exact fixed and variable cost limits", () => {
  const companies = [
      company(1, { revenue: point(100), operatingIncome: point(20) }),
    ],
    report = fixture(companies, [100]);
  const mixed = operatingSensitivity(report, companies, -10, 50);
  assert.equal(mixed.rows[0].modeledRevenue, 90);
  assert.equal(mixed.rows[0].modeledCosts, 76);
  assert.equal(mixed.rows[0].modeledIncome, 14);
  close(mixed.rows[0].modeledMarginPct, (100 * 14) / 90);
  assert.equal(
    operatingSensitivity(report, companies, -10, 0).rows[0].modeledIncome,
    10,
  );
  assert.equal(
    operatingSensitivity(report, companies, -10, 100).rows[0].modeledIncome,
    18,
  );
  assert.equal(
    operatingSensitivity(report, companies, -50, 0).enteringLossCount,
    1,
  );
  assert.ok(operatingSensitivity(report, companies, "", 50).error);
  assert.ok(operatingSensitivity(report, companies, -100, 50).error);
});
test("operating model rejects incompatible periods, nonpositive revenue, and noncorporate inputs", () => {
  const companies = [
    company(1, {
      revenue: point(100),
      operatingIncome: point(20, "USD", { period: { ...period, kind: "ttm" } }),
    }),
    company(2, { revenue: point(0), operatingIncome: point(-10) }),
    company(
      3,
      { revenue: point(100), operatingIncome: point(20) },
      { lens: "banking" },
    ),
  ];
  assert.equal(
    operatingSensitivity(fixture(companies, [40, 30, 30]), companies).rows
      .length,
    0,
  );
});
const scenarioBase = () => ({
  eligible: true,
  allocationErrors: [],
  issuers: [
    {
      cik: cik(1),
      rowId: "r1",
      name: "A",
      tickers: ["A"],
      industry: "Tech",
      weightPct: 60,
    },
    {
      cik: cik(2),
      rowId: "r2",
      name: "B",
      tickers: ["B"],
      industry: "Tech",
      weightPct: 40,
    },
  ],
  industries: ["Tech"],
});
test("mixed shocks apply company > industry > remainder exactly once", () => {
  const result = mixedPriceScenario(
    scenarioBase(),
    [
      { scope: "industry", target: "Tech", shockPct: -10 },
      { scope: "company", target: cik(1), shockPct: -20 },
    ],
    5,
  );
  close(result.totalReturnPct, -16);
  assert.equal(
    result.contributions.find((row) => row.cik === cik(1)).assumption,
    "Company override",
  );
  close(
    result.contributions.reduce((total, row) => total + row.endingWeightPct, 0),
    100,
  );
});
test("invalid or duplicate custom assumptions block scenario output", () => {
  for (const overrides of [
    [{ scope: "company", target: "outsider", shockPct: 0 }],
    [{ scope: "industry", target: "Tech", shockPct: -101 }],
    [
      { scope: "company", target: cik(1), shockPct: 0 },
      { scope: "company", target: cik(1), shockPct: 10 },
    ],
  ])
    assert.equal(mixedPriceScenario(scenarioBase(), overrides).eligible, false);
  assert.equal(
    mixedPriceScenario({
      ...scenarioBase(),
      allocationErrors: ["Invalid allocation"],
    }).eligible,
    false,
  );
  assert.equal(mixedPriceScenario(scenarioBase(), [], "").eligible, false);
});
test("rebalancing computes turnover, concentration and scenario effects without normalizing", () => {
  const scenario = mixedPriceScenario(
    scenarioBase(),
    [{ scope: "company", target: cik(1), shockPct: -20 }],
    0,
  );
  const result = rebalanceAllocation(scenario, { [cik(1)]: 50, [cik(2)]: 50 });
  assert.equal(result.valid, true);
  close(result.turnoverPct, 10);
  assert.equal(result.startingHhi, 5200);
  assert.equal(result.targetHhi, 5000);
  assert.equal(result.startingShockPct, -12);
  assert.equal(result.targetShockPct, -10);
  const after = rebalanceAllocation(
    scenario,
    { [cik(1)]: 60, [cik(2)]: 40 },
    true,
  );
  close(after.turnoverPct, 60 - (60 * 0.8) / 0.88);
  assert.equal(
    rebalanceAllocation(scenario, { [cik(1)]: 50, [cik(2)]: 40 }).valid,
    false,
  );
  assert.equal(rebalanceAllocation(scenario, { [cik(1)]: 100 }).valid, false);
});
test("total modeled loss never fabricates ending weights or post-loss trades", () => {
  const scenario = mixedPriceScenario(scenarioBase(), [], -100);
  assert.equal(scenario.endingWeightsDefined, false);
  assert.ok(
    scenario.contributions.every((row) => row.endingWeightPct === null),
  );
  assert.equal(
    rebalanceAllocation(scenario, { [cik(1)]: 50, [cik(2)]: 50 }, true).valid,
    false,
  );
});
test("revision materiality never compares unlike units or relabels revisions as growth", () => {
  const changes = [
    {
      cik: "1",
      ticker: "A",
      kind: "revision",
      unit: "%",
      beforeValue: 10,
      afterValue: 12,
    },
    {
      cik: "2",
      ticker: "B",
      kind: "revision",
      unit: "USD",
      beforeValue: 100,
      afterValue: 90,
    },
    { cik: "3", ticker: "C", kind: "period" },
  ];
  const result = analyzeRevisions(changes, {
    unit: "percentage points",
    minimum: 1,
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].delta, 2);
  assert.ok(analyzeRevisions(changes, { minimum: 1 }).error);
  assert.equal(analyzeRevisions(changes).rows[2].delta, null);
  assert.equal(
    analyzeRevisions(changes, { unit: "USD", minimum: 11 }).rows.length,
    0,
  );
  const csv = parsePortfolioCsv(
    analysisRowsCsv(result.rows, { unit: "percentage points" }),
  );
  assert.ok(csv.records.every((row) => row.length === csv.headers.length));
});
test("all ten additions have usable demo data and preserve the fixed hypothetical allocation", () => {
  const demo = JSON.parse(
    readFileSync(
      new URL(
        "../public/portfolio/portfolio-demo-100-results.json",
        import.meta.url,
      ),
    ),
  );
  const doc = createDemoPortfolio(demo);
  const snapshot = unpackPortfolioSnapshot(doc.snapshot);
  const companies = snapshot.companies;
  const report = buildPortfolioAnalytics(doc.rows, doc.allocation, companies, {
    capturedAt: demo.captured_at,
  });
  const catalog = buildCatalogReport(report, companies);
  assert.ok(catalog.metrics.length > 40);
  assert.ok(
    weightedFundamentals(report, companies, "netMargin").rows.length > 10,
  );
  assert.equal(financingBuffers(report, companies).length, 3);
  assert.ok(operatingSensitivity(report, companies).rows.length > 50);
  assert.equal(conditionOverlap(report, companies).measuredCount > 0, true);
  assert.ok(
    evidenceImpact(report, companies, ["netMargin", "debt"]).measures.length >
      0,
  );
  const base = buildPortfolioScenario(doc.rows, doc.allocation, companies, {
    targetShockPct: 0,
  });
  assert.equal(base.eligible, true);
  const mixed = mixedPriceScenario(base, [], -10);
  close(mixed.totalReturnPct, -10);
  const targets = Object.fromEntries(
    mixed.contributions.map((row) => [row.cik, 1]),
  );
  assert.equal(rebalanceAllocation(mixed, targets).valid, true);
});
test("mixed monetary outputs follow effective shocks instead of the neutral allocation base", () => {
  const result = mixedPriceScenario(
    {
      ...scenarioBase(),
      startingValue: 1000,
      valueChange: 0,
      endingValue: 1000,
    },
    [],
    -100,
  );
  assert.equal(result.valueChange, -1000);
  assert.equal(result.endingValue, 0);
  assert.equal(result.targetShockPct, null);
});
