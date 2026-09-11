import test from "node:test";
import assert from "node:assert/strict";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import {
  buildConcentrationAnalysis,
  buildPortfolioBriefing,
} from "../src/utils/portfolioConcentration.js";

const directory = {
  A: { cik: "1", name: "Alpha" },
  "A.B": { cik: "1", name: "Alpha" },
  B: { cik: "2", name: "Beta" },
  C: { cik: "3", name: "Gamma" },
};
const companies = [1, 2, 3].map((id) => ({
  cik: String(id).padStart(10, "0"),
  name: directory[["A", "B", "C"][id - 1]].name,
  kind: "company",
  lens: "corporate",
  status: "ready",
  sicDescription: id < 3 ? "Technology" : "Manufacturing",
  metrics: {
    netIncome: {
      value: id === 1 ? -10 : 10,
      unit: "USD",
      classification: "reported",
    },
  },
}));
const reportFor = (positions, basis = "weights") =>
  buildPortfolioAnalytics(
    resolvePortfolioRows(createPortfolioRows(positions), directory),
    { basis },
    companies,
  );
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("60/25/15 allocations produce exact cumulative exposure, industry breaches and HHI contributions", () => {
  const report = reportFor([
    { ticker: "A", weight_pct: 60 },
    { ticker: "B", weight_pct: 25 },
    { ticker: "C", weight_pct: 15 },
  ]);
  const result = buildConcentrationAnalysis(report, {
    issuerPct: 25,
    industryPct: 80,
  });
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.curve.map((issuer) => issuer.cumulativeWeightPct),
    [60, 85, 100],
  );
  assert.equal(result.hhi, 4450);
  assert.deepEqual(
    result.curve.map((issuer) => issuer.hhiPoints),
    [3600, 625, 225],
  );
  close(result.curve[0].hhiSharePct, (3600 / 4450) * 100);
  close(
    result.curve.reduce((sum, issuer) => sum + issuer.hhiSharePct, 0),
    100,
  );
  assert.equal(result.halfExposureIssuerCount, 1);
  assert.equal(result.eightyExposureIssuerCount, 2);
  assert.equal(result.breaches.length, 2);
  assert.equal(result.breaches[0].excessPct, 35);
  assert.equal(result.breaches[1].label, "Technology");
  assert.equal(result.breaches[1].excessPct, 5);
  assert.deepEqual(result.breaches[1].rowIds, [
    ...report.concentration.issuers[0].rowIds,
    ...report.concentration.issuers[1].rowIds,
  ]);
});

test("share classes count once in HHI and retain all affected position identities", () => {
  const report = reportFor([
    { ticker: "A", weight_pct: 40 },
    { ticker: "A.B", weight_pct: 20 },
    { ticker: "C", weight_pct: 40 },
  ]);
  const result = buildConcentrationAnalysis(report, {
    issuerPct: 50,
    industryPct: 100,
  });
  assert.equal(result.curve.length, 2);
  assert.equal(result.hhi, 5200);
  assert.equal(result.breaches.length, 1);
  assert.equal(result.breaches[0].knownWeightPct, 60);
  assert.equal(result.breaches[0].rowIds.length, 2);
  assert.deepEqual(result.breaches[0].tickers, ["A", "A.B"]);
});

test("missing weights may establish a breach but never establish within-limit or complete HHI", () => {
  const report = reportFor([{ ticker: "A", weight_pct: 60 }, { ticker: "B" }]);
  const result = buildConcentrationAnalysis(report, {
    issuerPct: 50,
    industryPct: 90,
  });
  assert.equal(result.complete, false);
  assert.equal(result.issuerChecks[0].status, "breached");
  assert.equal(result.issuerChecks[0].lowerBound, true);
  assert.equal(result.issuerChecks[1].status, "not-confirmed");
  assert.equal(result.industryChecks[0].status, "not-confirmed");
  assert.equal(result.cumulativeKnownWeightPct, 60);
  assert.equal(result.unknownIssuerCount, 1);
  assert.equal(result.hhi, null);
  assert.equal(result.halfExposureIssuerCount, null);
  assert.ok(
    result.curve.every(
      (issuer) => issuer.hhiPoints === null && issuer.hhiSharePct === null,
    ),
  );
});

test("all missing allocations have no cumulative values and no implicit zero weights", () => {
  const result = buildConcentrationAnalysis(
    reportFor([{ ticker: "A" }, { ticker: "B" }]),
  );
  assert.equal(result.curve.length, 0);
  assert.equal(result.cumulativeKnownWeightPct, null);
  assert.ok(
    result.issuerChecks.every(
      (issuer) =>
        issuer.knownWeightPct === null && issuer.status === "not-confirmed",
    ),
  );
});

test("120% supplied total is retained and never normalized or promoted to full concentration", () => {
  const result = buildConcentrationAnalysis(
    reportFor([
      { ticker: "A", weight_pct: 60 },
      { ticker: "B", weight_pct: 60 },
    ]),
  );
  assert.equal(result.complete, false);
  assert.equal(result.cumulativeKnownWeightPct, 120);
  assert.deepEqual(
    result.curve.map((issuer) => issuer.weightPct),
    [60, 60],
  );
  assert.equal(result.hhi, null);
  assert.equal(result.eightyExposureIssuerCount, null);
});

test("count mode ignores any residual weights and cannot classify concentration breaches", () => {
  const report = reportFor([{ ticker: "A" }, { ticker: "B" }], "none");
  report.concentration.issuers[0].weightPct = 99;
  report.concentration.complete = true;
  const result = buildConcentrationAnalysis(report);
  assert.equal(result.complete, false);
  assert.equal(result.hhi, null);
  assert.equal(result.curve.length, 0);
  assert.equal(result.breaches.length, 0);
  assert.ok(
    result.issuerChecks.every(
      (issuer) =>
        issuer.status === "unweighted" && issuer.knownWeightPct === null,
    ),
  );
});

test("a weight exactly at its limit is allowed while a positive weight exceeds a zero limit", () => {
  const report = reportFor([
    { ticker: "A", weight_pct: 50 },
    { ticker: "B", weight_pct: 50 },
  ]);
  assert.ok(
    buildConcentrationAnalysis(report, {
      issuerPct: 50,
      industryPct: 100,
    }).issuerChecks.every((entry) => entry.status === "within-limit"),
  );
  assert.equal(
    buildConcentrationAnalysis(report, {
      issuerPct: 0,
      industryPct: 100,
    }).issuerChecks.filter((entry) => entry.status === "breached").length,
    2,
  );
});

test("invalid and blank limits are rejected rather than converted into zero or an all-clear", () => {
  const report = reportFor([{ ticker: "A", weight_pct: 100 }]);
  for (const value of [
    "",
    " ",
    "invalid",
    NaN,
    Infinity,
    -1,
    101,
    null,
    [],
    true,
  ]) {
    const result = buildConcentrationAnalysis(report, {
      issuerPct: value,
      industryPct: 100,
    });
    assert.equal(result.limits.issuerPct, null);
    assert.equal(result.errors.length, 1);
    assert.equal(result.issuerChecks[0].status, "invalid-limit");
  }
  assert.equal(
    buildConcentrationAnalysis(report, {
      issuerPct: "12.5",
      industryPct: "100",
    }).limits.issuerPct,
    12.5,
  );
});

test("unresolved position weights are checked in their own group and do not become known issuer exposure", () => {
  const report = reportFor([
    { ticker: "A", weight_pct: 60 },
    { ticker: "UNKNOWN", weight_pct: 40 },
  ]);
  const result = buildConcentrationAnalysis(report, {
    issuerPct: 80,
    industryPct: 30,
  });
  assert.equal(result.unresolvedCount, 1);
  assert.equal(result.cumulativeKnownWeightPct, 60);
  assert.equal(result.issuerChecks[0].status, "not-confirmed");
  assert.equal(
    result.industryChecks.find(
      (entry) => entry.label === "Unresolved positions",
    ).knownWeightPct,
    40,
  );
  assert.equal(
    result.industryChecks.find(
      (entry) => entry.label === "Unresolved positions",
    ).rowIds.length,
    1,
  );
  assert.equal(result.hhi, null);
});

test("briefing is useful in count mode, deduplicates missing share classes, and keeps financial denominators", () => {
  const report = reportFor(
    [{ ticker: "A" }, { ticker: "A.B" }, { ticker: "B" }],
    "none",
  );
  const cards = buildPortfolioBriefing(report);
  assert.equal(
    cards.find((card) => card.id === "allocation").value,
    "2 holdings",
  );
  assert.equal(
    cards.find((card) => card.id === "coverage").value,
    "2 companies",
  );
  assert.equal(
    cards.find((card) => card.id === "industry").value,
    "2 holdings",
  );
  assert.match(
    cards.find((card) => card.id === "industry").text,
    /holding count, not a portfolio weight/,
  );
  assert.equal(
    cards.find((card) => card.id === "condition").value,
    "1 of 2 measured",
  );
  assert.equal(cards.find((card) => card.id === "condition").area, "financial");
});

test("briefing does not invent a favorable financial conclusion from an empty or unmeasured screen", () => {
  const report = reportFor([{ ticker: "A" }], "none");
  report.conditions = [{ matchedCount: 0, measuredCount: 0, missingCount: 1 }];
  assert.equal(
    buildPortfolioBriefing(report).find((card) => card.id === "condition"),
    undefined,
  );
  report.unresolvedCount = 2;
  assert.equal(buildPortfolioBriefing(report)[0].id, "identity");
});

test("concentration and briefing do not reorder or mutate the report or research limits", () => {
  const report = reportFor([
    { ticker: "B", weight_pct: 40 },
    { ticker: "A", weight_pct: 60 },
  ]);
  const limits = { issuerPct: "25", industryPct: "70" };
  const before = JSON.stringify({ report, limits });
  buildConcentrationAnalysis(report, limits);
  buildPortfolioBriefing(report);
  assert.equal(JSON.stringify({ report, limits }), before);
});
