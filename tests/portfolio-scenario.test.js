import test from "node:test";
import assert from "node:assert/strict";
import { buildPortfolioScenario } from "../src/utils/portfolioScenario.js";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";

const directory = {
  AAPL: { cik: "320193", name: "Apple Inc." },
  MSFT: { cik: "789019", name: "Microsoft Corporation" },
  GOOG: { cik: "1652044", name: "Alphabet Inc." },
  GOOGL: { cik: "1652044", name: "Alphabet Inc." },
};
const resolve = (holdings) =>
  resolvePortfolioRows(createPortfolioRows(holdings), directory);
const weighted = () =>
  resolve([
    { ticker: "AAPL", weight_pct: 60 },
    { ticker: "MSFT", weight_pct: 40 },
  ]);
const settings = { allocation: { basis: "weights", normalize: false } };
const companies = [
  {
    cik: "320193",
    sicDescription: "Electronic Computers",
    status: "ready",
    metrics: { revenue: { value: 100 } },
  },
  {
    cik: "789019",
    sicDescription: "Services-Prepackaged Software",
    status: "failed",
    metrics: {},
  },
];
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("60/40 portfolio, -20% issuer shock, and no remainder change produces -12pp and correct drift", () => {
  const result = buildPortfolioScenario(weighted(), settings, companies, {
    scope: "issuer",
    targetCik: "320193",
    targetShockPct: -20,
    remainderShockPct: 0,
  });
  assert.equal(result.eligible, true);
  close(result.totalReturnPct, -12);
  close(result.targetWeightPct, 60);
  close(result.contributions[0].contributionPct, -12);
  close(result.contributions[0].endingWeightPct, (60 * 0.8) / 0.88);
  close(result.contributions[1].endingWeightPct, 40 / 0.88);
  close(
    result.contributions.reduce((sum, row) => sum + row.driftPct, 0),
    0,
  );
  assert.equal(result.startingValue, null);
  assert.ok(result.contributions.every((row) => row.rowId));
});

test("share classes receive the same issuer shock once and are aggregated with all row links", () => {
  const rows = resolve([
    { ticker: "GOOG", weight_pct: 20 },
    { ticker: "GOOGL", weight_pct: 30 },
    { ticker: "MSFT", weight_pct: 50 },
  ]);
  const result = buildPortfolioScenario(rows, settings, companies, {
    scope: "issuer",
    targetCik: "1652044",
    targetShockPct: -20,
    remainderShockPct: -10,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.contributions.length, 2);
  close(result.totalReturnPct, -15);
  const alphabet = result.contributions.find((row) => row.cik === "0001652044");
  close(alphabet.contributionPct, -10);
  close(alphabet.weightPct, 50);
  assert.deepEqual(alphabet.tickers, ["GOOG", "GOOGL"]);
  assert.deepEqual(alphabet.rowIds, [rows[0].id, rows[1].id]);
});

test("all-holdings shock ignores remainder and a total loss has no defined ending weights", () => {
  const result = buildPortfolioScenario(weighted(), settings, companies, {
    scope: "all",
    targetShockPct: -100,
    remainderShockPct: 100,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.totalReturnPct, -100);
  assert.equal(result.targetWeightPct, 100);
  assert.ok(
    result.contributions.every(
      (row) => row.endingWeightPct === null && row.driftPct === null,
    ),
  );
  const upside = buildPortfolioScenario(weighted(), settings, companies, {
    targetShockPct: 100,
  });
  assert.equal(upside.totalReturnPct, 100);
  close(upside.contributions[0].driftPct, 0);
});

test("90% allocations, missing weights, unresolved identity and unreviewed duplicates block totals", () => {
  const lists = [
    [
      { ticker: "AAPL", weight_pct: 50 },
      { ticker: "MSFT", weight_pct: 40 },
    ],
    [{ ticker: "AAPL", weight_pct: 60 }, { ticker: "MSFT" }],
    [
      { ticker: "AAPL", weight_pct: 60 },
      { ticker: "UNKNOWN", weight_pct: 40 },
    ],
    [
      { ticker: "AAPL", weight_pct: 60 },
      { ticker: "AAPL", weight_pct: 40 },
    ],
  ];
  for (const holdings of lists) {
    const result = buildPortfolioScenario(
      resolve(holdings),
      settings,
      companies,
      {},
    );
    assert.equal(result.eligible, false);
    assert.equal(result.totalReturnPct, null);
    assert.equal(result.contributions.length, 0);
    assert.ok(result.allocationErrors.length);
  }
});

test("a very small positive ending value still has defined weights", () => {
  const result = buildPortfolioScenario(weighted(), settings, companies, {
    targetShockPct: -99.99999999999,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.endingWeightsDefined, true);
  close(result.contributions[0].endingWeightPct, 60);
  close(result.contributions[1].endingWeightPct, 40);
});

test("known identity permits a price scenario even without any financial evidence", () => {
  const result = buildPortfolioScenario(weighted(), settings, [], {
    targetShockPct: -10,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.totalReturnPct, -10);
});

test("empty, nonfinite, nonnumeric, null and out-of-bounds shocks are rejected without clamping", () => {
  for (const value of [
    "",
    " ",
    NaN,
    Infinity,
    -Infinity,
    "invalid",
    -101,
    101,
    null,
    true,
  ]) {
    for (const field of ["targetShockPct", "remainderShockPct"]) {
      const result = buildPortfolioScenario(weighted(), settings, companies, {
        [field]: value,
      });
      assert.equal(result.eligible, false, `${field}: ${value}`);
      assert.equal(result.totalReturnPct, null);
      assert.match(result.inputErrors[0], /−100% to \+100%/);
    }
  }
});

test("ticker lists need explicit equal-model opt-in; temporary equal weights do not change inputs", () => {
  const rows = resolve([
    { ticker: "AAPL", notes: "Private annotation", shares: 12 },
    { ticker: "MSFT", notes: "Keep secret" },
  ]);
  const noWeights = { allocation: { basis: "none", normalize: false } };
  const before = JSON.stringify({ rows, noWeights, companies });
  const blocked = buildPortfolioScenario(rows, noWeights, companies, {});
  assert.equal(blocked.eligible, false);
  const result = buildPortfolioScenario(rows, noWeights, companies, {
    equalWeight: true,
    scope: "issuer",
    targetCik: "320193",
    targetShockPct: -20,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.equalWeight, true);
  assert.equal(result.temporaryEqualWeights, true);
  close(result.totalReturnPct, -10);
  assert.match(
    result.assumptions.join(" "),
    /saved portfolio allocations are unchanged/,
  );
  assert.equal(JSON.stringify({ rows, noWeights, companies }), before);
  assert.doesNotMatch(
    JSON.stringify(result),
    /Private annotation|Keep secret|"shares"|"notes"|"marketValue"/,
  );
});

test("equal-weight opt-in cannot bypass unresolved identity or duplicate review", () => {
  for (const holdings of [
    [{ ticker: "UNKNOWN" }],
    [{ ticker: "AAPL" }, { ticker: "AAPL" }],
  ]) {
    const result = buildPortfolioScenario(
      resolve(holdings),
      { basis: "none" },
      companies,
      { equalWeight: true },
    );
    assert.equal(result.eligible, false);
    assert.equal(result.totalReturnPct, null);
  }
});

test("SEC industry targeting uses a disjoint remainder and rejects unknown targets", () => {
  const result = buildPortfolioScenario(weighted(), settings, companies, {
    scope: "industry",
    targetIndustry: "Electronic Computers",
    targetShockPct: -20,
    remainderShockPct: 10,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.totalReturnPct, -8);
  assert.equal(result.targetWeightPct, 60);
  assert.deepEqual(result.industries, [
    "Electronic Computers",
    "Services-Prepackaged Software",
  ]);
  for (const scenario of [
    { scope: "industry", targetIndustry: "Made up" },
    { scope: "issuer", targetCik: "1" },
    { scope: "invalid" },
  ]) {
    assert.equal(
      buildPortfolioScenario(weighted(), settings, companies, scenario)
        .eligible,
      false,
    );
  }
});

test("comparable selected market values enable currency output; other modes never infer value", () => {
  const rows = resolve([
    {
      ticker: "AAPL",
      market_value: 600,
      currency: "USD",
      as_of_date: "2026-09-08",
    },
    {
      ticker: "MSFT",
      market_value: 400,
      currency: "USD",
      as_of_date: "2026-09-08",
    },
  ]);
  const result = buildPortfolioScenario(
    rows,
    { basis: "market_value" },
    companies,
    { targetShockPct: -20 },
  );
  assert.equal(result.eligible, true);
  assert.equal(result.startingValue, 1000);
  assert.equal(result.valueChange, -200);
  assert.equal(result.endingValue, 800);
  assert.equal(result.currency, "USD");
  const equal = buildPortfolioScenario(
    rows,
    { basis: "market_value" },
    companies,
    { equalWeight: true },
  );
  assert.equal(equal.startingValue, null);
  const incompatible = structuredClone(rows);
  incompatible[1].input.currency = "EUR";
  assert.equal(
    buildPortfolioScenario(
      incompatible,
      { basis: "market_value" },
      companies,
      {},
    ).eligible,
    false,
  );
});

test("explicit normalization and saved equal models remain explicit and preserve the source weights", () => {
  const rows = resolve([
    { ticker: "AAPL", weight_pct: 30 },
    { ticker: "MSFT", weight_pct: 20 },
  ]);
  const before = JSON.stringify(rows);
  const result = buildPortfolioScenario(
    rows,
    { basis: "weights", normalize: true },
    companies,
    { scope: "issuer", targetCik: "320193", targetShockPct: -20 },
  );
  assert.equal(result.eligible, true);
  close(result.totalReturnPct, -12);
  assert.match(result.assumptions.join(" "), /normalized/);
  const equal = buildPortfolioScenario(rows, { basis: "equal" }, companies, {});
  assert.equal(equal.eligible, true);
  assert.equal(equal.equalWeight, true);
  assert.equal(equal.temporaryEqualWeights, false);
  assert.equal(JSON.stringify(rows), before);
});
