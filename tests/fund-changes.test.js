import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFundChanges,
  fundChangeEvidence,
  fundChangesCsv,
} from "../src/utils/fundChanges.js";

const holding = (patch = {}) => ({
  name: "Example equity",
  cusip: "037833100",
  isin: "US0378331005",
  balance: 10,
  units: "NS",
  value: 100,
  pctOfNav: 10,
  assetCat: "EC",
  payoffProfile: "Long",
  ...patch,
});
const portfolio = (patch = {}) => ({
  ticker: "EXAM",
  name: "Example fund",
  cik: "0000000001",
  seriesId: "S000000001",
  accession: "0000000001-26-000001",
  asOf: "2026-03-31",
  filingDate: "2026-05-29",
  sourceUrl:
    "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/primary_doc.xml",
  form: "NPORT-P",
  complete: true,
  holdings: [holding()],
  ...patch,
});
const next = (patch = {}) =>
  portfolio({
    accession: "0000000001-26-000002",
    asOf: "2026-06-30",
    filingDate: "2026-08-28",
    sourceUrl:
      "https://www.sec.gov/Archives/edgar/data/1/000000000126000002/primary_doc.xml",
    ...patch,
  });

test("fund changes match CUSIP/ISIN aliases and preserve signed values and percentage-point changes", () => {
  const result = buildFundChanges(
    portfolio(),
    next({
      holdings: [
        holding({ cusip: null, value: -30, pctOfNav: -3, balance: 8 }),
      ],
    }),
  );
  assert.equal(result.available, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].deltaValue, -130);
  assert.equal(result.rows[0].deltaWeight, -13);
  assert.equal(result.rows[0].deltaQuantity, -2);
  assert.equal(result.rows[0].status, "changed");
  assert.equal(result.coverage.before.identified, 1);
});

test("fund changes distinguish same-period revisions and reject identical, reversed, or wrong-series reports", () => {
  const amended = buildFundChanges(
    portfolio(),
    next({ asOf: "2026-03-31", form: "NPORT-P/A" }),
  );
  assert.equal(amended.comparisonType, "same-period-revision");
  assert.match(amended.warnings.join(" "), /amendment/);
  assert.equal(buildFundChanges(portfolio(), portfolio()).available, false);
  assert.equal(buildFundChanges(next(), portfolio()).available, false);
  assert.equal(
    buildFundChanges(portfolio(), next({ seriesId: "S000000002" })).available,
    false,
  );
  assert.equal(
    buildFundChanges(portfolio({ seriesId: null }), next({ seriesId: null }))
      .available,
    false,
  );
  assert.equal(
    buildFundChanges(portfolio(), next({ asOf: "2026-99-99" })).available,
    false,
  );
  assert.equal(buildFundChanges(null, next()).available, false);
});

test("fund changes aggregate duplicate lots only within position direction and withhold mixed-unit quantity deltas", () => {
  const result = buildFundChanges(
    portfolio({
      holdings: [holding(), holding({ balance: 5, value: 50, pctOfNav: 5 })],
    }),
    next({
      holdings: [
        holding({ balance: 10, value: 130, pctOfNav: 13 }),
        holding({
          balance: 9,
          value: -20,
          pctOfNav: -2,
          payoffProfile: "Short",
        }),
      ],
    }),
  );
  const long = result.rows.find((row) => row.direction === "long"),
    short = result.rows.find((row) => row.direction === "short");
  assert.equal(long.before.count, 2);
  assert.equal(long.before.value, 150);
  assert.equal(long.deltaQuantity, -5);
  assert.equal(short.status, "added");
  assert.equal(short.after.value, -20);
  assert.equal(short.deltaQuantity, null);
  const mixed = buildFundChanges(
    portfolio({ holdings: [holding(), holding({ units: "PA" })] }),
    next(),
  );
  assert.equal(mixed.rows[0].deltaQuantity, null);
  assert.match(mixed.rows[0].quantityReason, /units/);
});

test("fund changes never infer absence or zero from an incomplete report", () => {
  const result = buildFundChanges(
    portfolio({ complete: false, holdings: [] }),
    next(),
  );
  assert.equal(result.rows[0].status, "unverified");
  assert.equal(result.rows[0].before.value, null);
  assert.equal(result.rows[0].deltaValue, null);
  assert.equal(result.summary.added, 0);
  const complete = buildFundChanges(portfolio({ holdings: [] }), next());
  assert.equal(complete.rows[0].status, "added");
  assert.equal(complete.rows[0].before.value, 0);
  assert.equal(complete.rows[0].before.absentConfirmed, true);
  assert.equal(complete.rows[0].deltaValue, 100);
  assert.match(complete.methodology, /not purchases or sales/);
});

test("fund changes retain unidentified and conflicting IDs as visible unverified observations", () => {
  const result = buildFundChanges(
    portfolio({
      holdings: [
        holding(),
        holding({ name: "Unidentified", cusip: null, isin: null }),
      ],
    }),
    next({ holdings: [holding({ cusip: "594918104" })] }),
  );
  assert.equal(result.rows.length, 3);
  assert.equal(result.summary.unverified, 3);
  assert.equal(result.coverage.before.unidentified, 1);
  assert.equal(result.coverage.before.ambiguous, 1);
  assert.equal(result.coverage.after.ambiguous, 1);
  assert.ok(result.rows.every((row) => row.deltaValue === null));
});

test("fund changes withhold aggregate values when inputs are missing instead of silently summing partial lots", () => {
  const result = buildFundChanges(
    portfolio({
      holdings: [
        holding(),
        holding({ value: null, pctOfNav: null, balance: null }),
      ],
    }),
    next(),
  );
  assert.equal(result.rows[0].before.value, null);
  assert.equal(result.rows[0].before.weight, null);
  assert.equal(result.rows[0].deltaValue, null);
  assert.equal(result.rows[0].deltaWeight, null);
  assert.equal(result.rows[0].deltaQuantity, null);
  assert.equal(result.rows[0].status, "unverified");
  assert.match(result.rows[0].warnings.join(" "), /missing/);
});

test("fund changes keep corporate-action caveats and do not infer derivative or unknown-direction quantities", () => {
  const result = buildFundChanges(
    portfolio(),
    next({ holdings: [holding({ cusip: "594918104", isin: "US5949181045" })] }),
  );
  assert.equal(result.summary.added, 1);
  assert.equal(result.summary.removed, 1);
  assert.match(result.warnings.join(" "), /Corporate actions/);
  const derivative = buildFundChanges(
    portfolio({ holdings: [holding({ assetCat: "DE" })] }),
    next({ holdings: [holding({ assetCat: "DE", balance: 20 })] }),
  );
  assert.equal(derivative.rows[0].deltaQuantity, null);
  assert.match(derivative.rows[0].quantityReason, /Derivative/);
  const unknown = buildFundChanges(
    portfolio({ holdings: [holding({ payoffProfile: null })] }),
    next({ holdings: [holding({ payoffProfile: null, balance: 20 })] }),
  );
  assert.equal(unknown.rows[0].deltaQuantity, null);
});

test("fund changes filter full results without changing comparison coverage and export exact evidence", () => {
  const result = buildFundChanges(
    portfolio({
      holdings: [
        holding(),
        holding({
          name: "=Example other",
          cusip: "594918104",
          isin: "US5949181045",
        }),
      ],
    }),
    next({ holdings: [holding({ value: 120 })] }),
    { scope: "removed", query: "other" },
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.summary.total, 2);
  assert.equal(result.coverage.before.positions, 2);
  const csv = fundChangesCsv(result);
  assert.match(csv, /NAV weight change pp/);
  assert.match(csv, /"'=Example other"/);
  assert.match(csv, /0000000001-26-000001/);
  assert.match(csv, /0000000001-26-000002/);
  assert.match(csv, /not purchases or sales/);
  const evidence = fundChangeEvidence(result, result.rows[0]);
  assert.equal(evidence.kind, "change");
  assert.equal(evidence.sources.length, 2);
  assert.equal(
    evidence.values.find((value) => value.label === "NAV weight change").value,
    -10,
  );
  assert.match(evidence.methodology, /Scope=removed; query=other/);
});

test("fund changes reject non-finite aggregate arithmetic without inventing zero changes", () => {
  const result = buildFundChanges(
    portfolio({
      holdings: [holding({ value: 1.7e308 }), holding({ value: 1.7e308 })],
    }),
    next(),
  );
  assert.equal(result.rows[0].before.value, null);
  assert.equal(result.rows[0].deltaValue, null);
});
