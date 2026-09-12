import test from "node:test";
import assert from "node:assert/strict";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import {
  buildConcentrationAnalysis,
  buildConcentrationHeatMap,
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

test("concentration heat map preserves exact complete weights and proportional geometry", () => {
  const report = reportFor([
    { ticker: "A", weight_pct: 60 },
    { ticker: "B", weight_pct: 25 },
    { ticker: "C", weight_pct: 15 },
  ]);
  const result = buildConcentrationHeatMap(report, "issuer");
  assert.equal(result.complete, true);
  assert.equal(result.mappedValue, 100);
  assert.equal(result.denominator, 100);
  assert.equal(result.unmappedValue, 0);
  assert.equal(result.overAllocated, false);
  assert.deepEqual(
    result.tiles.map((tile) => [tile.label, tile.value, tile.areaPct]),
    [
      ["A", 60, 60],
      ["B", 25, 25],
      ["C", 15, 15],
    ],
  );
  for (const tile of result.tiles) {
    assert.ok([tile.x, tile.y, tile.width, tile.height].every(Number.isFinite));
    assert.ok(tile.x >= 0 && tile.y >= 0);
    assert.ok(tile.x + tile.width <= 100 + 1e-9);
    assert.ok(tile.y + tile.height <= 100 + 1e-9);
    close((tile.width * tile.height) / 100, tile.areaPct);
  }
});

test("partial heat map keeps known weights and shows an explicit unmapped remainder", () => {
  const report = reportFor([
    { ticker: "A", weight_pct: 60 },
    { ticker: "B" },
  ]);
  const result = buildConcentrationHeatMap(report, "issuer");
  assert.equal(result.complete, false);
  assert.equal(result.mappedValue, 60);
  assert.equal(result.denominator, 100);
  assert.equal(result.unmappedValue, 40);
  assert.equal(result.unavailableCount, 1);
  assert.equal(result.tiles[0].label, "A");
  assert.equal(result.tiles[0].value, 60);
  assert.equal(result.tiles[0].lowerBound, true);
  assert.equal(result.tiles[1].label, "Allocation not mapped");
  assert.equal(result.tiles[1].placeholder, true);
  assert.equal(result.tiles[1].value, 40);
});

test("over-allocated heat map reports the supplied total without changing tile values", () => {
  const report = reportFor([
    { ticker: "A", weight_pct: 60 },
    { ticker: "B", weight_pct: 60 },
  ]);
  const result = buildConcentrationHeatMap(report, "issuer");
  assert.equal(result.complete, false);
  assert.equal(result.mappedValue, 120);
  assert.equal(result.denominator, 120);
  assert.equal(result.overAllocated, true);
  assert.equal(result.excessPct, 20);
  assert.equal(result.unmappedValue, 0);
  assert.deepEqual(
    result.tiles.map((tile) => tile.value),
    [60, 60],
  );
  assert.deepEqual(
    result.tiles.map((tile) => tile.areaPct),
    [50, 50],
  );
});

test("count heat map counts combined share classes once per issuer", () => {
  const report = reportFor(
    [{ ticker: "A" }, { ticker: "A.B" }, { ticker: "B" }],
    "none",
  );
  const issuerMap = buildConcentrationHeatMap(report, "issuer");
  assert.equal(issuerMap.weighted, false);
  assert.equal(issuerMap.mappedValue, 2);
  assert.deepEqual(
    issuerMap.tiles.map((tile) => [tile.label, tile.value, tile.count]),
    [
      ["A / A.B", 1, 2],
      ["B", 1, 1],
    ],
  );
  const industryMap = buildConcentrationHeatMap(report, "industry");
  assert.equal(industryMap.mappedValue, 2);
  assert.equal(industryMap.tiles[0].label, "Technology");
  assert.equal(industryMap.tiles[0].value, 2);
});

test("issuer heat map retains unresolved supplied exposure as a reviewable tile", () => {
  const report = reportFor([
    { ticker: "A", weight_pct: 60 },
    { ticker: "UNKNOWN", weight_pct: 40 },
  ]);
  const result = buildConcentrationHeatMap(report, "issuer");
  assert.equal(result.mappedValue, 100);
  assert.equal(result.unmappedValue, 0);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.tiles.map((tile) => [tile.label, tile.value, tile.action]),
    [
      ["A", 60, "inspect"],
      ["Unresolved positions", 40, "review"],
    ],
  );
});

test("heat map modes are deterministic, bounded and do not mutate analytics", () => {
  const report = reportFor([
    { ticker: "B", weight_pct: 40 },
    { ticker: "A", weight_pct: 60 },
  ]);
  const before = JSON.stringify(report);
  const first = buildConcentrationHeatMap(report, "sector");
  const second = buildConcentrationHeatMap(report, "sector");
  assert.deepEqual(first, second);
  assert.equal(buildConcentrationHeatMap(report, "invalid").mode, "issuer");
  assert.equal(JSON.stringify(report), before);

  for (let left = 0; left < first.tiles.length; left++) {
    for (let right = left + 1; right < first.tiles.length; right++) {
      const a = first.tiles[left];
      const b = first.tiles[right];
      const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapHeight =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(overlapWidth <= 1e-9 || overlapHeight <= 1e-9);
    }
  }
});
