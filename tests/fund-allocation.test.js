import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFundAllocation,
  equalFundAllocations,
  fundAllocationCsv,
  validateFundAllocations,
} from "../src/utils/fundAllocation.js";
const holding = (weight, extra = {}) => ({
  name: "Security A",
  cusip: "123456789",
  isin: null,
  pctOfNav: weight,
  payoffProfile: "Long",
  assetCat: "EC",
  ...extra,
});
const portfolio = (ticker, holdings = [], extra = {}) => ({
  ticker,
  status: "ready",
  cik: "0000000001",
  seriesId: `S${ticker}`,
  accession: "0000000001-26-000001",
  asOf: "2026-06-30",
  filingDate: "2026-08-28",
  sourceUrl:
    "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/primary_doc.xml",
  name: `${ticker} fund`,
  holdings,
  ...extra,
});
const close = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-10,
    `${actual} should equal ${expected}`,
  );
test("allocation input preserves invalid blanks and rejects negative, missing, unknown, and oversized weights", () => {
  for (const weights of [
    { AAA: "", BBB: "100" },
    { AAA: "-1", BBB: "101" },
    { AAA: "100" },
    { AAA: "50", BBB: "50", CCC: "0" },
    { AAA: "1e2", BBB: "0" },
    { AAA: Infinity, BBB: 0 },
    { AAA: "0x64", BBB: "0" },
  ])
    assert.equal(validateFundAllocations(["AAA", "BBB"], weights).valid, false);
  assert.equal(
    validateFundAllocations(["AAA", "BBB"], {
      AAA: "99.99999999",
      BBB: "0.00000001",
    }).valid,
    true,
  );
  assert.equal(
    validateFundAllocations(["AAA", "BBB"], { AAA: "0", BBB: "100" }).valid,
    true,
  );
  assert.equal(
    validateFundAllocations(["AAA", "BBB"], { AAA: "40", BBB: "40" }).sum,
    80,
  );
  assert.equal(
    validateFundAllocations(["AAA", "AAA"], { AAA: "100" }).valid,
    false,
  );
});
test("equal allocations total exactly 100 without normalizing user choices", () => {
  assert.deepEqual(equalFundAllocations(["AAA", "BBB", "CCC"]), {
    AAA: "33.333333",
    BBB: "33.333333",
    CCC: "33.333334",
  });
  assert.equal(
    validateFundAllocations(
      ["AAA", "BBB", "CCC"],
      equalFundAllocations(["AAA", "BBB", "CCC"]),
    ).valid,
    true,
  );
  const result = buildFundAllocation([], {
    tickers: ["AAA", "BBB"],
    weights: { AAA: 40, BBB: 40 },
  });
  assert.equal(result.ready, false);
  assert.equal(result.validation.sum, 80);
});
test("aggregates every duplicate position and retains full precision and original NAV denominators", () => {
  const result = buildFundAllocation(
    [
      portfolio("AAA", [holding(6), holding(4)]),
      portfolio("BBB", [holding(8)]),
    ],
    { weights: { AAA: "60", BBB: "40" } },
  );
  assert.equal(result.rows.length, 1);
  close(result.rows[0].weight, 9.2);
  close(result.rows[0].contributions[0].contribution, 6);
  close(result.rows[0].contributions[1].contribution, 3.2);
  assert.equal(result.rows[0].contributions[0].positionCount, 2);
  close(result.coverage.eligibleWeight, 9.2);
  assert.equal(result.coverage.duplicatedSecurityCount, 1);
  const precise = buildFundAllocation(
    [
      portfolio("AAA", [holding(12.345678901)]),
      portfolio("BBB", [holding(23.456789012)]),
    ],
    { weights: { AAA: "33.333333333", BBB: "66.666666667" } },
  );
  close(
    precise.rows[0].weight,
    12.345678901 * 0.33333333333 + 23.456789012 * 0.66666666667,
  );
});
test("zero allocation funds do not block math or contaminate identifier matching", () => {
  const result = buildFundAllocation(
    [
      portfolio("AAA", [holding(10, { isin: "US1234567890" })]),
      portfolio("BBB", [
        holding(20, { cusip: "987654321", isin: "US1234567890" }),
      ]),
    ],
    {
      tickers: ["AAA", "BBB", "CCC"],
      weights: { AAA: "100", BBB: "0", CCC: "0" },
      errors: [{ ticker: "CCC", message: "No report" }],
    },
  );
  assert.equal(result.partial, false);
  assert.equal(result.rows[0].weight, 10);
  assert.equal(result.coverage.reviewedFundCount, 1);
  assert.equal(result.funds[2].zeroAllocation, true);
  assert.equal(result.funds[2].error, null);
});
test("partial and failed coverage remain missing rather than redistributing the allocation", () => {
  const result = buildFundAllocation([portfolio("AAA", [holding(10)])], {
    tickers: ["AAA", "BBB"],
    weights: { AAA: 60, BBB: 40 },
    errors: [{ ticker: "BBB", message: "SEC request failed" }],
  });
  assert.equal(result.partial, true);
  assert.equal(result.rows[0].weight, 6);
  assert.equal(result.coverage.reviewedAllocation, 60);
  assert.equal(result.coverage.unavailableAllocation, 40);
  assert.equal(result.funds[1].error, "SEC request failed");
  const unavailable = buildFundAllocation([], {
    tickers: ["AAA"],
    weights: { AAA: 100 },
  });
  assert.equal(unavailable.coverage.eligibleWeight, null);
  assert.equal(unavailable.coverage.top10Weight, null);
});
test("exclusions separate unknown NAV weights, derivatives, shorts, missing IDs and nonpositive weights", () => {
  const result = buildFundAllocation(
    [
      portfolio("AAA", [
        holding(10),
        holding(5, { assetCat: "DE" }),
        holding(3, { payoffProfile: "Short" }),
        holding(null),
        holding(4, { cusip: null }),
        holding(-2),
        holding(0),
      ]),
    ],
    { weights: { AAA: 100 } },
  );
  assert.equal(result.rows[0].weight, 10);
  assert.equal(result.coverage.excludedPositiveWeight, 12);
  assert.equal(result.coverage.nonpositiveWeight, -2);
  assert.equal(result.coverage.unknownWeightCount, 1);
  assert.equal(result.funds[0].excludedCount, 6);
  assert.equal(result.coverage.unidentifiedCount, 1);
});
test("CUSIP and ISIN aliases match when linked and conflicting alias groups remain excluded", () => {
  const result = buildFundAllocation(
    [
      portfolio("AAA", [holding(10, { isin: "US1234567890" })]),
      portfolio("BBB", [holding(20, { cusip: null, isin: "US1234567890" })]),
    ],
    { weights: { AAA: 50, BBB: 50 } },
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].weight, 15);
  const conflict = buildFundAllocation(
    [
      portfolio("AAA", [holding(10, { isin: "US1234567890" })]),
      portfolio("BBB", [
        holding(20, { cusip: "987654321", isin: "US1234567890" }),
      ]),
    ],
    { weights: { AAA: 50, BBB: 50 } },
  );
  assert.equal(conflict.rows.length, 0);
  assert.equal(conflict.coverage.ambiguousCount, 2);
  assert.equal(conflict.coverage.excludedPositiveWeight, 15);
});
test("same series share classes are combined but not counted as distinct portfolios", () => {
  const same = buildFundAllocation(
    [
      portfolio("AAA", [holding(10)], { seriesId: "S0001" }),
      portfolio("BBB", [holding(20)], {
        seriesId: "S0001",
        asOf: "2026-03-31",
      }),
    ],
    { weights: { AAA: 50, BBB: 50 } },
  );
  assert.equal(same.rows[0].weight, 15);
  assert.equal(same.rows[0].fundCount, 2);
  assert.equal(same.rows[0].portfolioCount, 1);
  assert.equal(same.coverage.duplicatedSecurityCount, 0);
  assert.deepEqual(same.samePortfolioGroups, [["AAA", "BBB"]]);
  assert.equal(same.mixedDates, true);
  const separate = buildFundAllocation(
    [portfolio("AAA", [holding(10)]), portfolio("BBB", [holding(20)])],
    { weights: { AAA: 50, BBB: 50 } },
  );
  assert.equal(separate.mixedDates, false);
  assert.equal(separate.rows[0].portfolioCount, 2);
});
test("more than 100 holdings and gross NAV weights over 100 are retained without rescaling", () => {
  const positions = Array.from({ length: 125 }, (_, i) =>
    holding(1, { cusip: String(100000000 + i), name: `Position ${i}` }),
  );
  const result = buildFundAllocation([portfolio("AAA", positions)], {
    weights: { AAA: 100 },
  });
  assert.equal(result.rows.length, 125);
  assert.equal(result.coverage.eligibleWeight, 125);
  assert.equal(result.coverage.top10Weight, 10);
  assert.match(result.notes.join(" "), /not cash/);
});
test("CSV preserves full contributions and sources, with formula-safe names", () => {
  const result = buildFundAllocation(
    [portfolio("AAA", [holding(1.23456789, { name: '=HYPERLINK("bad")' })])],
    { weights: { AAA: 100 } },
  );
  const csv = fundAllocationCsv(result);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /1\.23456789/);
  assert.match(csv, /0000000001-26-000001/);
  assert.match(csv, /2026-06-30/);
  assert.match(csv, /https:\/\/www.sec.gov\/Archives/);
});
test("unrepresentable reported sums are unavailable rather than zero", () => {
  const result = buildFundAllocation(
    [portfolio("AAA", [holding(Number.MAX_VALUE), holding(Number.MAX_VALUE)])],
    { weights: { AAA: 100 } },
  );
  assert.equal(result.rows[0].weight, null);
  assert.equal(result.coverage.eligibleWeight, null);
  assert.equal(result.coverage.top10Weight, null);
});
