import test from "node:test";
import assert from "node:assert/strict";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import {
  buildScenarioComparison,
  buildScenarioSensitivity,
  captureScenarioCase,
  scenarioComparisonCsv,
  solvePortfolioLossTarget,
} from "../src/utils/portfolioScenarioTools.js";

const directory = {
  AAPL: { cik: "320193", name: "Apple Inc." },
  MSFT: { cik: "789019", name: "Microsoft Corporation" },
  GOOG: { cik: "1652044", name: "Alphabet Inc." },
  GOOGL: { cik: "1652044", name: "Alphabet Inc." },
};
const resolve = (holdings) =>
  resolvePortfolioRows(createPortfolioRows(holdings), directory);
const rows = () =>
  resolve([
    { ticker: "AAPL", weight_pct: 60 },
    { ticker: "MSFT", weight_pct: 40 },
  ]);
const settings = { allocation: { basis: "weights", normalize: false } };
const companies = [
  { cik: "320193", sicDescription: "Computers" },
  { cik: "789019", sicDescription: "Software" },
];
const assumptions = {
  scope: "issuer",
  targetCik: "320193",
  targetIndustry: "",
  targetShockPct: "-20",
  remainderShockPct: "0",
  equalWeight: false,
};
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("sensitivity grid computes target and remainder contributions using whole-portfolio weights", () => {
  const grid = buildScenarioSensitivity(
    rows(),
    settings,
    companies,
    assumptions,
    10,
  );
  assert.equal(grid.eligible, true);
  assert.equal(grid.targetWeightPct, 60);
  assert.equal(grid.cells.length, 5);
  assert.equal(grid.cells[0].length, 5);
  const cell = grid.cells
    .flat()
    .find(
      (cell) => cell.targetShockPct === -20 && cell.remainderShockPct === 10,
    );
  close(cell.totalReturnPct, -8);
  close(grid.cells[0][0].totalReturnPct, -20);
});

test("all-holdings sensitivity is one dimensional and includes total loss and 100% upside", () => {
  const grid = buildScenarioSensitivity(
    rows(),
    settings,
    companies,
    { ...assumptions, scope: "all" },
    50,
  );
  assert.deepEqual(grid.remainderShocks, [0]);
  assert.equal(grid.cells[0][0].totalReturnPct, -100);
  assert.equal(grid.cells[4][0].totalReturnPct, 100);
});

test("sensitivity axes replace current shock inputs but never bypass target or allocation validation", () => {
  assert.equal(
    buildScenarioSensitivity(
      rows(),
      settings,
      companies,
      { ...assumptions, targetShockPct: "", remainderShockPct: "" },
      25,
    ).eligible,
    true,
  );
  for (const scenario of [
    { ...assumptions, targetCik: "1" },
    { ...assumptions, scope: "industry", targetIndustry: "Missing" },
  ]) {
    assert.equal(
      buildScenarioSensitivity(rows(), settings, companies, scenario, 25)
        .eligible,
      false,
    );
  }
  assert.equal(
    buildScenarioSensitivity(rows(), settings, companies, assumptions, 101)
      .eligible,
    false,
  );
  assert.equal(
    buildScenarioSensitivity(
      resolve([{ ticker: "AAPL", weight_pct: 60 }, { ticker: "MSFT" }]),
      settings,
      companies,
      assumptions,
      10,
    ).cells.length,
    0,
  );
});

test("reverse stress solves the hand-calculated 60/40 loss with a fixed remainder", () => {
  const solved = solvePortfolioLossTarget(
    rows(),
    settings,
    companies,
    { ...assumptions, remainderShockPct: "-5" },
    "14",
  );
  assert.equal(solved.eligible, true);
  close(solved.requiredShockPct, -20);
  close(solved.remainderContributionPct, -2);
  close(solved.scenarioResult.totalReturnPct, -14);
  close(solved.minimumReturnPct, -62);
  close(solved.maximumReturnPct, 58);
});

test("reverse stress recognizes unreachable loss and never silently clamps it", () => {
  const solved = solvePortfolioLossTarget(
    rows(),
    settings,
    companies,
    assumptions,
    70,
  );
  assert.equal(solved.eligible, false);
  assert.equal(solved.requiredShockPct, null);
  assert.equal(solved.minimumReturnPct, -60);
  assert.equal(solved.maximumReturnPct, 60);
  assert.match(solved.errors.join(" "), /cannot be reached/);
});

test("zero-weight targets cannot be used as a divisor even when the remainder meets the loss", () => {
  const holdings = resolve([
    { ticker: "AAPL", weight_pct: 0 },
    { ticker: "MSFT", weight_pct: 100 },
  ]);
  const solved = solvePortfolioLossTarget(
    holdings,
    settings,
    companies,
    { ...assumptions, remainderShockPct: "-10" },
    10,
  );
  assert.equal(solved.eligible, false);
  assert.equal(solved.requiredShockPct, null);
  assert.match(solved.errors.join(" "), /0% allocation/);
});

test("all-holdings loss target reaches -100% exactly and ignores the inapplicable remainder", () => {
  const solved = solvePortfolioLossTarget(
    rows(),
    settings,
    companies,
    { ...assumptions, scope: "all", remainderShockPct: "" },
    100,
  );
  assert.equal(solved.eligible, true);
  assert.equal(solved.requiredShockPct, -100);
  assert.equal(solved.scenarioResult.totalReturnPct, -100);
  assert.equal(solved.scenarioResult.endingWeightsDefined, false);
});

test("reverse stress retains precise fractional shocks and can require a gain to offset other losses", () => {
  const fractional = solvePortfolioLossTarget(
    rows(),
    settings,
    companies,
    assumptions,
    10,
  );
  close(fractional.requiredShockPct, -100 / 6);
  close(fractional.scenarioResult.totalReturnPct, -10);
  const offset = solvePortfolioLossTarget(
    rows(),
    settings,
    companies,
    { ...assumptions, remainderShockPct: "-50" },
    10,
  );
  close(offset.requiredShockPct, 100 / 6);
  close(offset.scenarioResult.totalReturnPct, -10);
});

test("reverse stress rejects empty, nonfinite and out-of-bounds loss inputs", () => {
  for (const loss of ["", " ", null, true, NaN, Infinity, "invalid", -1, 101]) {
    const solved = solvePortfolioLossTarget(
      rows(),
      settings,
      companies,
      assumptions,
      loss,
    );
    assert.equal(solved.eligible, false, `${loss}`);
    assert.equal(solved.requiredShockPct, null);
  }
  assert.equal(
    solvePortfolioLossTarget(
      rows(),
      settings,
      companies,
      { ...assumptions, remainderShockPct: "" },
      10,
    ).eligible,
    false,
  );
});

test("temporary equal allocation is explicit and all tools leave original holdings untouched", () => {
  const holdings = resolve([
    { ticker: "AAPL", notes: "Private account" },
    { ticker: "MSFT", shares: 13 },
  ]);
  const noWeights = { allocation: { basis: "none" } };
  const before = JSON.stringify({ holdings, noWeights });
  assert.equal(
    solvePortfolioLossTarget(holdings, noWeights, companies, assumptions, 10)
      .eligible,
    false,
  );
  assert.equal(
    buildScenarioSensitivity(holdings, noWeights, companies, assumptions, 10)
      .eligible,
    false,
  );
  const equal = { ...assumptions, equalWeight: true };
  const solved = solvePortfolioLossTarget(
    holdings,
    noWeights,
    companies,
    equal,
    10,
  );
  close(solved.requiredShockPct, -20);
  assert.equal(solved.scenarioResult.temporaryEqualWeights, true);
  assert.equal(
    buildScenarioSensitivity(holdings, noWeights, companies, equal, 10)
      .eligible,
    true,
  );
  assert.equal(JSON.stringify({ holdings, noWeights }), before);
});

test("issuer share classes and industry groups are aggregated in loss targets", () => {
  const holdings = resolve([
    { ticker: "GOOG", weight_pct: 20 },
    { ticker: "GOOGL", weight_pct: 30 },
    { ticker: "MSFT", weight_pct: 50 },
  ]);
  const issuer = solvePortfolioLossTarget(
    holdings,
    settings,
    companies,
    { ...assumptions, targetCik: "1652044" },
    10,
  );
  close(issuer.targetWeightPct, 50);
  close(issuer.requiredShockPct, -20);
  const industry = solvePortfolioLossTarget(
    rows(),
    settings,
    [
      { cik: "320193", sicDescription: "Technology" },
      { cik: "789019", sicDescription: "Technology" },
    ],
    { ...assumptions, scope: "industry", targetIndustry: "Technology" },
    10,
  );
  close(industry.targetWeightPct, 100);
  close(industry.requiredShockPct, -10);
});

test("case capture retains only bounded named assumptions, never derived portfolio data", () => {
  const saved = captureScenarioCase(
    {
      ...assumptions,
      notes: "Private",
      rows: rows(),
      totalReturnPct: -999,
      startingValue: 99999,
    },
    "  Issuer decline  ",
    "case-one",
  );
  assert.equal(saved.name, "Issuer decline");
  assert.equal(saved.scenario.targetCik, "0000320193");
  assert.deepEqual(Object.keys(saved).sort(), ["id", "name", "scenario"]);
  assert.doesNotMatch(
    JSON.stringify(saved),
    /Private|totalReturnPct|startingValue|rows/,
  );
  assert.equal(
    captureScenarioCase(
      { ...assumptions, targetShockPct: "" },
      "Invalid",
      "case",
    ),
    null,
  );
  assert.equal(
    captureScenarioCase(
      { ...assumptions, targetShockPct: -101 },
      "Invalid",
      "case",
    ),
    null,
  );
  assert.equal(captureScenarioCase(assumptions, "", "case"), null);
  assert.equal(
    captureScenarioCase(assumptions, "x".repeat(100), "case").name.length,
    60,
  );
});

test("comparisons recompute retained cases after allocation changes and bound saved case count", () => {
  const saved = captureScenarioCase(assumptions, "Decline", "case-one");
  const initial = buildScenarioComparison(
    rows(),
    settings,
    companies,
    [saved],
    { ...assumptions, scope: "all", targetShockPct: "-10" },
  );
  close(initial[0].result.totalReturnPct, -10);
  close(initial[1].result.totalReturnPct, -12);
  const changed = resolve([
    { ticker: "AAPL", weight_pct: 20 },
    { ticker: "MSFT", weight_pct: 80 },
  ]);
  const updated = buildScenarioComparison(
    changed,
    settings,
    companies,
    [saved],
    assumptions,
  );
  close(updated[1].result.totalReturnPct, -4);
  assert.deepEqual(updated[1].scenario, saved.scenario);
  const limited = buildScenarioComparison(
    rows(),
    settings,
    companies,
    Array.from({ length: 10 }, (_, index) => ({
      ...saved,
      id: `case-${index}`,
    })),
    assumptions,
  );
  assert.equal(limited.length, 5);
  assert.equal(limited[0].name, "Current inputs (unsaved)");
});

test("changed or invalid portfolio inputs make saved results unavailable rather than preserving stale returns", () => {
  const saved = captureScenarioCase(assumptions, "Decline", "case-one");
  const removedTarget = resolve([{ ticker: "MSFT", weight_pct: 100 }]);
  const compared = buildScenarioComparison(
    removedTarget,
    settings,
    companies,
    [saved],
    assumptions,
  );
  assert.equal(compared[1].result.eligible, false);
  assert.equal(compared[1].result.totalReturnPct, null);
  assert.equal(compared[1].result.contributions.length, 0);
});

test("comparison CSV contains each case's allocation basis, source identity and contributions without private holding inputs", () => {
  const holdings = resolve([
    {
      ticker: "AAPL",
      weight_pct: 60,
      notes: "Secret account",
      shares: 123456789,
    },
    { ticker: "MSFT", weight_pct: 40 },
  ]);
  const saved = captureScenarioCase(
    assumptions,
    '=HYPERLINK("bad")',
    "case-one",
  );
  const comparison = buildScenarioComparison(
    holdings,
    settings,
    companies,
    [saved],
    { ...assumptions, scope: "all", targetShockPct: "-10" },
  );
  const csv = scenarioComparisonCsv(comparison);
  assert.match(csv, /Current inputs \(unsaved\)/);
  assert.match(csv, /Starting weight \(%\)/);
  assert.match(csv, /No market-price series/);
  assert.match(csv, /https:\/\/www.sec.gov\/edgar\/browse\/\?CIK=0000320193/);
  assert.match(csv, /Hypothetical price changes only/);
  assert.match(csv, /'=HYPERLINK/);
  assert.doesNotMatch(csv, /Secret account|123456789/);
});

test("unresolved identities, incomplete totals and unreviewed duplicates remain blocked in tools", () => {
  for (const holdings of [
    [
      { ticker: "AAPL", weight_pct: 60 },
      { ticker: "UNKNOWN", weight_pct: 40 },
    ],
    [
      { ticker: "AAPL", weight_pct: 60 },
      { ticker: "MSFT", weight_pct: 30 },
    ],
    [
      { ticker: "AAPL", weight_pct: 60 },
      { ticker: "AAPL", weight_pct: 40 },
    ],
  ]) {
    const input = resolve(holdings);
    assert.equal(
      buildScenarioSensitivity(input, settings, companies, assumptions, 10)
        .eligible,
      false,
    );
    assert.equal(
      solvePortfolioLossTarget(input, settings, companies, assumptions, 10)
        .eligible,
      false,
    );
  }
});
