import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSecurityIdentity,
  resolveSecurityGroups,
  securityEligibility,
} from "../src/utils/fundSecurity.js";
import {
  compareFundPortfolios,
  fundComparisonCsv,
} from "../src/utils/fundComparison.js";
const holding = (overrides = {}) => ({
  name: "Security",
  cusip: "123456789",
  isin: "US1234567890",
  pctOfNav: 10,
  payoffProfile: "Long",
  assetCat: "EC",
  ...overrides,
});
const fund = (ticker, holdings, overrides = {}) => ({
  ticker,
  name: ticker,
  cik: "0000000001",
  seriesId: ticker,
  asOf: "2026-06-30",
  filingDate: "2026-08-28",
  accession: "0000000001-26-000001",
  sourceUrl: "https://www.sec.gov/Archives/example.xml",
  holdings,
  ...overrides,
});
test("CUSIP and ISIN aliases connect when only one report contains both identifiers", () => {
  const a = fund("AAA", [holding()]),
    b = fund("BBB", [holding({ cusip: null })]);
  const result = compareFundPortfolios([a, b], { left: "AAA", right: "BBB" });
  assert.equal(result.sharedCount, 1);
  assert.equal(result.overlap, 10);
  assert.deepEqual(result.rows[0].ids, [
    "CUSIP:123456789",
    "ISIN:US1234567890",
  ]);
});
test("conflicting identifier networks are excluded instead of silently merging different securities", () => {
  const portfolios = [
    fund("AAA", [holding()]),
    fund("BBB", [holding({ cusip: "987654321" })]),
  ];
  const resolved = resolveSecurityGroups(portfolios);
  assert.equal(resolved.groups.length, 0);
  assert.equal(resolved.ambiguous.length, 1);
  const result = compareFundPortfolios(portfolios, {
    left: "AAA",
    right: "BBB",
  });
  assert.equal(result.overlap, 0);
  assert.equal(result.coverage[0].excludedPositions, 1);
  assert.equal(result.coverage[1].eligibleWeight, 0);
});
test("comparison covers all rows, aggregates duplicate securities and distinguishes unique eligibility", () => {
  const a = fund("AAA", [
    holding({ pctOfNav: 6 }),
    holding({ pctOfNav: 4 }),
    holding({ cusip: "987654321", isin: null, pctOfNav: 20 }),
  ]);
  const b = fund("BBB", [holding({ pctOfNav: 8 })]);
  const result = compareFundPortfolios([a, b], { left: "AAA", right: "BBB" });
  assert.equal(result.overlap, 8);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].kind, "left");
  assert.equal(result.rows[0].rightWeight, 0);
  assert.equal(result.rows[1].leftPositions, 2);
  assert.equal(result.coverage[0].eligibleWeight, 30);
});
test("unknown direction, derivative fair values and missing NAV weights are excluded with reasons", () => {
  const a = fund("AAA", [
    holding({ payoffProfile: null }),
    holding({ assetCat: "DE" }),
    holding({ pctOfNav: null }),
    holding({ cusip: null, isin: null }),
  ]);
  const result = compareFundPortfolios([a, fund("BBB", [holding()])], {
    left: "AAA",
    right: "BBB",
  });
  assert.equal(result.coverage[0].excludedPositions, 4);
  assert.equal(Object.keys(result.coverage[0].exclusions).length, 4);
  assert.equal(result.rows[0].kind, "right");
  assert.equal(
    securityEligibility(holding({ pctOfNav: Infinity })).eligible,
    false,
  );
});
test("failed selected funds remain unavailable while successful pair results remain available", () => {
  const result = compareFundPortfolios(
    [fund("AAA", [holding()]), fund("BBB", [holding()])],
    { left: "FAIL", right: "BBB" },
  );
  assert.equal(result.available, false);
  assert.equal(result.rows.length, 0);
  assert.equal(result.pairs[0].overlap, 10);
  assert.equal(result.left, null);
});
test("report date mismatches and duplicate share classes remain explicit", () => {
  const a = fund("AAA", [holding()], { seriesId: "S000001" }),
    b = fund("BBB", [holding()], { seriesId: "S000001", asOf: "2026-03-31" });
  const result = compareFundPortfolios([a, b], { left: "AAA", right: "BBB" });
  assert.equal(result.samePeriod, false);
  assert.equal(result.gapDays, 91);
  assert.equal(result.samePortfolio, true);
});
test("filtering changes the table without changing pair overlap and full eligible coverage", () => {
  const a = fund("AAA", [
      holding({ name: "=Dangerous" }),
      holding({ cusip: "987654321", isin: null, name: "Other" }),
    ]),
    b = fund("BBB", [holding()]);
  const result = compareFundPortfolios([a, b], {
    left: "AAA",
    right: "BBB",
    scope: "left",
    query: "Other",
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.overlap, 10);
  assert.equal(result.coverage[0].eligiblePositions, 2);
  const csv = fundComparisonCsv(
    compareFundPortfolios([a, b], { left: "AAA", right: "BBB" }),
  );
  assert.match(csv, /"'=Dangerous"/);
  assert.match(csv, /2026-06-30/);
  assert.match(csv, /0000000001-26-000001/);
  assert.match(csv, /https:\/\/www.sec.gov/);
});
test("missing or malformed identifiers do not match by name or ticker", () => {
  assert.deepEqual(
    normalizeSecurityIdentity(holding({ cusip: "N/A", isin: "UNKNOWN" })).ids,
    [],
  );
  const resolved = resolveSecurityGroups([
    fund("AAA", [holding({ cusip: null, isin: null })]),
    fund("BBB", [holding({ cusip: null, isin: null })]),
  ]);
  assert.equal(resolved.groups.length, 0);
  assert.equal(resolved.unidentified.length, 2);
});
test("a shared trust CIK without identified series does not establish identical portfolios", () => {
  const result = compareFundPortfolios(
    [
      fund("AAA", [holding()], { seriesId: null }),
      fund("BBB", [holding()], { seriesId: null }),
    ],
    { left: "AAA", right: "BBB" },
  );
  assert.equal(result.samePortfolio, false);
  assert.equal(result.pairs[0].samePortfolio, false);
});
test("overflowing duplicate NAV weights withhold comparison results rather than displaying infinity or zero", () => {
  const result = compareFundPortfolios(
    [
      fund("AAA", [holding({ pctOfNav: 1e308 }), holding({ pctOfNav: 1e308 })]),
      fund("BBB", [holding()]),
    ],
    { left: "AAA", right: "BBB" },
  );
  assert.equal(result.available, false);
  assert.equal(result.coverage[0].eligibleWeight, null);
  assert.equal(result.pairs[0].overlap, null);
  assert.equal(result.rows.length, 0);
  assert.match(result.reason, /numeric range/);
});
