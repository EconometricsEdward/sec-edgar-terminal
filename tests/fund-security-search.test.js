import test from "node:test";
import assert from "node:assert/strict";
import {
  searchFundHoldings,
  searchFundHoldingsCsv,
  securitySearchEvidence,
  securityWeight,
} from "../src/utils/fundSecuritySearch.js";

const position = (patch = {}) => ({
  name: "Apple Inc",
  title: "Common stock",
  tickerSymbol: "AAPL",
  cusip: "037833100",
  isin: "US0378331005",
  value: 100,
  pctOfNav: 10,
  assetCat: "EC",
  invCountry: "US",
  payoffProfile: "Long",
  ...patch,
});
const fund = (ticker, holdings, patch = {}) => ({
  ticker,
  name: `${ticker} Fund`,
  cik: "0000000001",
  seriesId: `S${ticker}`,
  asOf: "2026-03-31",
  filingDate: "2026-05-28",
  accession: "0000000001-26-000001",
  sourceUrl:
    "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.xml",
  holdings,
  ...patch,
});

test("searches complete portfolios and aggregates repeated positions without adding NAV weights across funds", () => {
  const a = fund("AAA", [position(), position({ value: 20, pctOfNav: 2 })]);
  const b = fund("BBB", [position({ value: 50, pctOfNav: 5 })]);
  const result = searchFundHoldings([a, b], { query: "apple common" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].positionCount, 3);
  assert.deepEqual(
    result.rows[0].funds.map((f) => f.pctOfNav),
    [12, 5],
  );
  assert.equal(result.rows[0].pctOfNav, undefined);
  assert.deepEqual(
    result.coverage.map((f) => f.searchedPositions),
    [2, 1],
  );
});

test("a shared ISIN finds linked positions whose name and ticker differ", () => {
  const result = searchFundHoldings(
    [
      fund("AAA", [position()]),
      fund("BBB", [
        position({ name: "APPL ORD", tickerSymbol: null, cusip: null }),
      ]),
    ],
    { query: "AAPL" },
  );
  assert.equal(result.rows[0].fundCount, 2);
  assert.equal(result.rows[0].funds[1].positions[0].textMatched, false);
});

test("names and ticker strings never merge different securities or unidentified positions", () => {
  const result = searchFundHoldings(
    [
      fund("AAA", [
        position(),
        position({ cusip: "037833101", isin: null }),
        position({ cusip: null, isin: null }),
      ]),
    ],
    { query: "Apple" },
  );
  assert.equal(result.rows.length, 3);
  assert.equal(result.unidentifiedPositions, 1);
  assert.equal(
    result.rows.every((row) => row.positionCount === 1),
    true,
  );
});

test("conflicting identifier links are preserved as separate evidence, never silently combined", () => {
  const result = searchFundHoldings(
    [fund("AAA", [position(), position({ cusip: "037833101" })])],
    { query: "Apple" },
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.conflictingPositions, 2);
  assert.equal(
    result.rows.every(
      (row) => row.identityStatus === "conflicting-identifiers",
    ),
    true,
  );
});

test("preserves zero, signed, derivative and unavailable values with honest incomplete totals", () => {
  const result = searchFundHoldings(
    [
      fund("AAA", [
        position(),
        position({
          value: -30,
          pctOfNav: -3,
          payoffProfile: "Short",
          assetCat: "DE",
        }),
        position({ value: 0, pctOfNav: 0 }),
        position({ value: null, pctOfNav: null }),
      ]),
    ],
    { query: "Apple" },
  );
  const group = result.rows[0].funds[0];
  assert.equal(group.value, null);
  assert.equal(group.pctOfNav, null);
  assert.equal(group.knownValue, 70);
  assert.equal(group.knownWeight, 7);
  assert.equal(group.missingWeightCount, 1);
  assert.equal(group.positions.length, 4);
  const evidence = securitySearchEvidence(result.rows[0], result);
  assert.equal(evidence.values[0].value, null);
  assert.equal(
    evidence.values.find((value) => /known weight subtotal/.test(value.label))
      .value,
    7,
  );
});

test("all missing values remain unavailable, not zero; actual zero remains zero", () => {
  const unavailable = searchFundHoldings([
    fund("AAA", [position({ value: null, pctOfNav: undefined })]),
  ]);
  assert.equal(unavailable.rows[0].funds[0].knownValue, null);
  assert.equal(unavailable.rows[0].funds[0].knownWeight, null);
  const zero = searchFundHoldings([
    fund("AAA", [position({ value: 0, pctOfNav: 0 })]),
  ]);
  assert.equal(zero.rows[0].funds[0].value, 0);
  assert.equal(zero.rows[0].funds[0].pctOfNav, 0);
});

test("uses exact asset and country filters and makes successful no-match coverage explicit", () => {
  const result = searchFundHoldings(
    [
      fund("AAA", [position()]),
      fund("BBB", [position({ invCountry: "CA" })]),
      fund("CCC", []),
    ],
    { query: "037833100", country: "us", asset: "EC" },
  );
  assert.equal(result.rows[0].fundCount, 1);
  assert.deepEqual(
    result.coverage.map((f) => f.status),
    ["matched", "no-match", "no-match"],
  );
  assert.deepEqual(
    result.coverage.map((f) => f.matchedPositions),
    [1, 0, 0],
  );
  assert.deepEqual(result.options.countries, ["CA", "US"]);
});

test("flags different report dates and two tickers sharing one portfolio", () => {
  const result = searchFundHoldings([
    fund("AAA", [position()], { seriesId: "S1" }),
    fund("BBB", [position()], { seriesId: "S1", asOf: "2025-12-31" }),
  ]);
  assert.equal(result.sameDate, false);
  assert.deepEqual(result.sharedSeries, [["AAA", "BBB"]]);
});

test("complete CSV includes all rows beyond page 50, no-match coverage, failed searches and source settings", () => {
  const holdings = Array.from({ length: 65 }, (_, i) =>
    position({
      name: `Security ${i}`,
      cusip: String(i + 100000000),
      isin: null,
    }),
  );
  const result = searchFundHoldings([fund("AAA", holdings), fund("BBB", [])]);
  const csv = searchFundHoldingsCsv({
    ...result,
    errors: [{ ticker: "BAD", message: "Fetch failed" }],
  });
  assert.equal((csv.match(/"position",/g) || []).length, 65);
  assert.match(csv, /"searched_no_match"/);
  assert.match(csv, /"not_searched".*"BAD"/);
  assert.match(csv, /0000000001-26-000001/);
  assert.match(csv, /https:\/\/www.sec.gov\/Archives/);
});

test("CSV escapes spreadsheet formulas in reported names and search settings", () => {
  const result = searchFundHoldings(
    [fund("AAA", [position({ name: '=HYPERLINK("bad")' })])],
    { query: "=HYPERLINK" },
  );
  assert.match(searchFundHoldingsCsv(result), /'=HYPERLINK/);
});

test("fund summaries cover all securities beyond page 50 and export the same totals", () => {
  const holdings = Array.from({ length: 65 }, (_, i) =>
    position({
      cusip: String(i + 100000000),
      isin: null,
      pctOfNav: 0.1,
      value: 100,
    }),
  );
  const result = searchFundHoldings([
    fund("AAA", holdings),
    fund("BBB", [position({ pctOfNav: 2, value: 200 })]),
  ]);
  assert.equal(result.exposureByFund[0].positionCount, 65);
  assert.ok(Math.abs(result.exposureByFund[0].pctOfNav - 6.5) < 1e-10);
  assert.equal(result.exposureByFund[0].value, 6500);
  assert.equal(result.exposureByFund[1].pctOfNav, 2);
  assert.equal(result.pctOfNav, undefined);
  const paged = { ...result, rows: result.rows.slice(0, 50) };
  assert.equal(paged.exposureByFund[0].value, 6500);
  const csv = searchFundHoldingsCsv(result);
  assert.equal((csv.match(/"fund_summary",/g) || []).length, 2);
  assert.equal((csv.match(/"asset_summary",/g) || []).length, 2);
  assert.equal((csv.match(/"position",/g) || []).length, 66);
});

test("stock, bond and derivative summaries stay separate with missing subtotals preserved", () => {
  const result = searchFundHoldings(
    [
      fund("AAA", [
        position({ value: 100, pctOfNav: 10 }),
        position({
          cusip: "037833AL4",
          isin: null,
          assetCat: "DBT",
          value: 40,
          pctOfNav: 4,
        }),
        position({
          cusip: null,
          isin: null,
          assetCat: "DE",
          value: -5,
          pctOfNav: -0.5,
          payoffProfile: "Short",
        }),
        position({
          cusip: null,
          isin: null,
          assetCat: "DBT",
          value: null,
          pctOfNav: null,
        }),
        position({
          cusip: null,
          isin: null,
          assetCat: null,
          value: 0,
          pctOfNav: 0,
        }),
      ]),
    ],
    { query: "Apple" },
  );
  const summary = result.exposureByFund[0];
  assert.equal(summary.value, null);
  assert.equal(summary.knownValue, 135);
  assert.equal(summary.pctOfNav, null);
  assert.equal(summary.knownWeight, 13.5);
  assert.equal(summary.missingWeightCount, 1);
  assert.equal(summary.stockPositionCount, 1);
  assert.equal(summary.derivativeCount, 1);
  assert.equal(summary.categories.find((c) => c.asset === "EC").pctOfNav, 10);
  assert.equal(
    summary.categories.find((c) => c.asset === "DBT").pctOfNav,
    null,
  );
  assert.ok(summary.categories.some((c) => c.asset === "UNKNOWN"));
  const stocks = searchFundHoldings(
    [fund("AAA", [position(), position({ assetCat: "DBT" })])],
    { query: "Apple", asset: "EC" },
  );
  assert.equal(stocks.exposureByFund[0].positionCount, 1);
});

test("no match stays distinct from a reported zero and failed funds never enter summaries", () => {
  const result = searchFundHoldings(
    [fund("AAA", [position({ pctOfNav: 0, value: 0 })]), fund("BBB", [])],
    { query: "Apple" },
  );
  assert.equal(result.exposureByFund[0].pctOfNav, 0);
  assert.equal(result.exposureByFund[0].status, "matched");
  assert.equal(result.exposureByFund[1].pctOfNav, null);
  assert.equal(result.exposureByFund[1].status, "no-match");
  const csv = searchFundHoldingsCsv({
    ...result,
    errors: [{ ticker: "BAD", message: "Unavailable" }],
  });
  assert.match(csv, /"not_searched".*"BAD"/);
  assert.doesNotMatch(csv, /"fund_summary".*"BAD"/);
});

test("APPL remains a literal broad search and explicit Apple stocks excludes debt and Applied names", () => {
  const holdings = [
    position({ tickerSymbol: null }),
    position({
      name: "Applied Materials",
      cusip: "038222105",
      isin: null,
      tickerSymbol: "AMAT",
    }),
    position({
      assetCat: "DBT",
      cusip: "037833AL4",
      isin: null,
      tickerSymbol: null,
    }),
  ];
  assert.equal(
    searchFundHoldings([fund("AAA", holdings)], { query: "APPL" }).totalGroups,
    3,
  );
  assert.equal(
    searchFundHoldings([fund("AAA", holdings)], { query: "AAPL" }).totalGroups,
    0,
  );
  const explicit = searchFundHoldings([fund("AAA", holdings)], {
    query: "Apple",
    asset: "EC",
  });
  assert.equal(explicit.totalGroups, 1);
  assert.equal(explicit.exposureByFund[0].stockPositionCount, 1);
});

test("small signed weights stay visibly nonzero while true zero and missing values remain distinct", () => {
  assert.equal(securityWeight(0.004), "<0.01%");
  assert.equal(securityWeight(-0.004), "−<0.01%");
  assert.equal(securityWeight(0), "0.00%");
  assert.equal(securityWeight(-0), "0.00%");
  assert.equal(securityWeight(null), "Unavailable");
  assert.equal(securityWeight(NaN), "Unavailable");
  assert.equal(securityWeight(4.52), "4.52%");
});
