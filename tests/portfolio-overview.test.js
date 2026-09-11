import test from "node:test";
import assert from "node:assert/strict";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import { buildPortfolioOverview } from "../src/utils/portfolioOverview.js";

const directory = {
  A: { cik: "1", name: "Alpha" },
  AB: { cik: "1", name: "Alpha" },
  B: { cik: "2", name: "Beta" },
  F: { cik: "3", name: "Fund", kind: "fund" },
};
const metric = (value, unit = "USD") => ({
  value,
  unit,
  classification: "reported",
});
const companies = [
  {
    cik: "1",
    kind: "company",
    status: "ready",
    lens: "corporate",
    sicDescription: "Software",
    metrics: { netIncome: metric(-10), revenueGrowth: metric(8, "%") },
  },
  {
    cik: "2",
    kind: "company",
    status: "ready",
    lens: "corporate",
    metrics: { netIncome: metric(0), revenueGrowth: metric(0, "%") },
  },
  {
    cik: "3",
    kind: "fund",
    status: "ready",
    metrics: { netIncome: metric(30) },
  },
];
function reportFor(positions, basis = "weights", evidence = companies) {
  return buildPortfolioAnalytics(
    resolvePortfolioRows(createPortfolioRows(positions), directory),
    { basis },
    evidence,
  );
}

test("briefing combines share classes, separates funds, and uses original financial coverage weights", () => {
  const report = reportFor([
    { ticker: "A", weight_pct: 20 },
    { ticker: "AB", weight_pct: 30 },
    { ticker: "B", weight_pct: 10 },
    { ticker: "F", weight_pct: 40 },
  ]);
  const before = JSON.stringify(report);
  const view = buildPortfolioOverview(report);
  assert.equal(view.complete, true);
  assert.equal(view.companyCount, 2);
  assert.equal(view.fundCount, 1);
  assert.equal(view.industryCount, 1);
  assert.equal(view.financialCount, 2);
  assert.equal(view.financialWeight, 60);
  assert.equal(view.largestHoldings[0].weightPct, 50);
  assert.equal(view.largestHoldings[0].rowIds.length, 2);
  assert.equal(
    view.mix.reduce((sum, g) => sum + g.value, 0),
    100,
  );
  assert.equal(JSON.stringify(report), before);
});

test("partial and count-only portfolios never imply complete weights or equal allocations", () => {
  for (const basis of ["weights", "none"]) {
    const view = buildPortfolioOverview(
      reportFor(
        [
          { ticker: "A", weight_pct: 60 },
          { ticker: "B" },
          { ticker: "F" },
          { ticker: "MISSING" },
        ],
        basis,
      ),
    );
    assert.equal(view.complete, false);
    assert.equal(view.topFiveWeight, null);
    assert.equal(view.financialWeight, null);
    assert.deepEqual(view.largestHoldings, []);
    assert.equal(view.mixTotal, 2);
    assert.equal(
      view.mix.reduce((sum, g) => sum + g.value, 0),
      2,
    );
  }
});

test("financial pulse counts positive growth and negative income without treating zeros or missing data as matches", () => {
  const view = buildPortfolioOverview(
    reportFor([{ ticker: "A" }, { ticker: "B" }], "none"),
  );
  assert.deepEqual(
    view.pulse.map(({ id, count, measured }) => ({ id, count, measured })),
    [
      { id: "growth", count: 1, measured: 2 },
      { id: "loss", count: 1, measured: 2 },
    ],
  );
  const missing = buildPortfolioOverview(
    reportFor([{ ticker: "A" }, { ticker: "B" }], "none", []),
  );
  assert.deepEqual(missing.pulse, []);
  assert.equal(missing.financialCount, 0);
  assert.equal(missing.missingFinancialCount, 2);
});

test("net-income-only evidence counts as financial evidence even with no tracked ratios", () => {
  const view = buildPortfolioOverview(
    reportFor([{ ticker: "A", weight_pct: 100 }], "weights", [
      { ...companies[0], metrics: { netIncome: metric(0) } },
    ]),
  );
  assert.equal(view.financialCount, 1);
  assert.equal(view.financialWeight, 100);
  assert.equal(view.pulse.length, 1);
  assert.equal(view.pulse[0].count, 0);
  assert.equal(view.pulse[0].measured, 1);
});

test("funds have allocation but no company financial observations", () => {
  const view = buildPortfolioOverview(
    reportFor([{ ticker: "F", weight_pct: 100 }]),
  );
  assert.equal(view.companyCount, 0);
  assert.equal(view.fundCount, 1);
  assert.equal(view.industryCount, 0);
  assert.equal(view.missingFinancialCount, 0);
  assert.deepEqual(view.pulse, []);
  assert.equal(view.mix[0].value, 100);
  const countView = buildPortfolioOverview(
    reportFor([{ ticker: "F" }], "none"),
  );
  assert.equal(countView.mixTotal, 1);
  assert.equal(countView.mix[0].value, 1);
});

test("all mix groups remain explicit, including unknown classifications and funds", () => {
  const report = reportFor([{ ticker: "A", weight_pct: 100 }]);
  report.concentration.industries = [
    "One",
    "Two",
    "Three",
    "Four",
    "Unclassified",
    "Funds (company metrics not applicable)",
  ].map((label, index) => ({ label, weightPct: index < 4 ? 20 : 10 }));
  const view = buildPortfolioOverview(report);
  assert.equal(view.mix.length, 6);
  assert.ok(
    view.mix.some(
      (entry) => entry.label === "Unclassified" && entry.value === 10,
    ),
  );
  assert.ok(
    view.mix.some(
      (entry) =>
        entry.label === "Funds (company metrics not applicable)" &&
        entry.value === 10,
    ),
  );
  assert.ok(!view.mix.some((entry) => entry.label === "Other groups"));
  assert.equal(
    view.mix.reduce((sum, g) => sum + g.value, 0),
    100,
  );
});
